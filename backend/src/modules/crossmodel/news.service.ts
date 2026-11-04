/**
 * News Headlines Service
 *
 * Handles background pre-fetching of news for each user at 6am, 12pm, 4pm, 9pm
 * in their local timezone. Headlines are stored in Redis so GET /news returns
 * instantly (<1ms) instead of waiting for a live web-search + format pipeline.
 *
 * Models (2026-07-12, Paul's policy — background tasks use NO OpenAI):
 *   - Grounding: BrightData MCP `search_engine` (parallel SERP queries, every
 *     query freshness-constrained with Google's after: operator — 2026-08-31)
 *   - Formatting: utilityChat — DeepSeek V4 Flash primary, Qwen 3.6 27B fallback
 *
 * Briefing quality (2026-08-31 overhaul, after a live briefing showed two
 * month-stale dated roundup titles side-by-side):
 *   - SERP grounding is freshness-constrained (after: operator) and free-text
 *     interests are split into individual seed queries (not one comma-mega-query)
 *   - The prompt bans dated roundups/hub titles and stale stories outright
 *   - A DETERMINISTIC gate (filterBriefingQuality) drops aggregator hub titles,
 *     headlines embedding dates older than 2 days, and exact/near duplicates —
 *     applied at write time, at read time (self-healing), and to the fallback
 *   - Per-user seen-history rotation (Redis 48h): briefings prefer stories the
 *     user was never served; served stories only backfill to the healthy minimum
 *
 * Architecture:
 *   - Scheduler runs every 15 minutes
 *   - For each active user, checks if current time ≈ a target hour in their timezone
 *   - Pre-fetches and caches in Redis with 24-hour TTL (refreshed 4x/day at target hours)
 *   - GET /news reads from Redis first → only falls back to live fetch on first-ever login
 *
 * Fallback provenance (ticket 4888d891, "news homepage is stale"): the shared
 * outage key (`news:headlines:fallback`) holds ANOTHER user's briefing and is
 * served ONLY when our own fetch failed. `fetchNewsHeadlines` reports that
 * distinction through an optional `NewsFetchOutcome`, and the 24-hour TTL is
 * reserved for OUR OWN briefing. Fallback-served content gets the short thin
 * TTL, always arms the per-user failure backoff, and never enters seen-history
 * — otherwise a failed fetch silently pins stale outage news under the user
 * until the next target hour. Replay: news-fallback-pinning.4888d891.test.ts.
 */

import { createHash } from 'crypto';
import redisClient from '../../config/redis';
import prisma from '../../config/database';
import logger from '../../utils/logger';
// Log taxonomy (utils/log-level.ts, 2026-10-18). Log-signal family a800a12d
// (tickets 0de27d1b / d1be4f9e / b4bfd09a / 359c3a35, 2026-11-01): the news
// formatter ladder's DESIGNED outcomes were emitted at untagged `warn`, so the
// hourly log-signal sweep read each designed recovery as an internal fault and
// re-filed it every ISO week. `logHandled` logs at info, which the warn+
// PrismaErrorTransport never persists — the fingerprint stops reaching
// app_error_logs while the durable escalation (the fetch circuit breaker at
// recordFetchFailure → one deduped outage ticket, fe661565) is untouched.
import { logHandled, logExternal } from '../../utils/log-level';
import { recordLoopMetric, LOOP_METRIC_KINDS } from './platform/loop-metrics.service';
import { utilityChat, isUtilityLLMAvailable, utilityLLMHealthSnapshot, utilityChainUnconfigured } from '../../utils/utility-llm';
import { searchWithBrightData } from './mcp-search';
// Self-host setup hardening (2026-10-20): the news briefing is a scheduled live
// search — a NON-production instance with no search backend skips the tick
// (one info line per process) instead of tripping the fetch breaker and filing
// a "pipeline outage" ticket every window. Production is never "missing".
import { webSearchMissingOnInstance } from './platform/instance-setup';
let _loggedNewsUnconfigured = false;
// Edge/self-host formatter hardening (2026-10-26, the digby.example.com outage):
// the 2026-10-20 gate covered the no-SEARCH corner, but a gateway-only
// self-host (all models via custom endpoints; no DEEPSEEK_API_KEY /
// DASHSCOPE_API_KEY and no 'utility' seat override or custom fallback) has
// the MIRROR gap: search is configured, yet fetchNewsHeadlines bails at
// isUtilityLLMAvailable() on EVERY pass — the per-user 5-min backoff + fetch
// breaker arm, and the home card renders the dishonest "temporarily
// unavailable — we'll retry automatically" forever (retrying can never
// succeed: the missing piece is configuration, not a transient outage).
// The shared structural gate (utility-llm.utilityChainUnconfigured) skips the
// scheduler tick here and answers `unconfigured:true` (terminal, no poll
// loop) in the GET /news controller, with honest copy naming the fix.
let _newsUtilityUnconfiguredLogged = false;

// ── Redis Keys ────────────────────────────────────────────────────────────────
const NEWS_CACHE_KEY = (userId: string) => `user:news:${userId}`;
const NEWS_SCHEDULED_KEY = (userId: string) => `user:news:scheduled:${userId}`;
const NEWS_FETCHING_KEY = (userId: string) => `user:news:fetching:${userId}`;
const NEWS_BACKOFF_KEY = (userId: string) => `user:news:backoff:${userId}`;
const NEWS_FALLBACK_KEY = 'news:headlines:fallback';
const NEWS_FALLBACK_WRITE_LOCK_KEY = 'news:headlines:fallback:write_lock';
const NEWS_CACHE_TTL = 24 * 60 * 60;      // 24 hours — ensures cache never expires between target-hour refreshes (longest gap 9pm→6am = 9h)
const NEWS_SCHEDULED_TTL = 3 * 60 * 60;   // 3 hours — prevents double-fetch within same window
// 2026-07-12: raised 120s → 480s for the BrightData+utilityChat pipeline, then
// review-verified against the honest worst case. The TTL is BOTH crash-safety
// AND the live cross-instance dedup window (if a fetch outlives it, another
// instance can start a duplicate), so the pipeline is bounded to fit inside it:
// SERP queries run with NEWS_SERP_TIMEOUT_MS (30s ×3 retries + backoff ≈ 96s,
// parallel) + primary utilityChat ≤120s (DeepSeek 60s + DashScope 60s) +
// reformat ≤120s ≈ 336s per pass, and the prefetch-level retry is SKIPPED when
// the first pass already used >120s (NEWS_RETRY_DEADLINE_MS) — worst case
// ~120s + 3s + 336s ≈ 459s < 480s.
const NEWS_FETCHING_TTL = 480;             // 8 minutes — lock to prevent duplicate fetches
const NEWS_FALLBACK_TTL = 2 * 60 * 60;    // 2 hours — fallback cache TTL

// 2026-07-03: The fallback key was rewritten on EVERY user's successful fetch. With
// BATCH_SIZE=3 parallel fetches across many users each refresh window, that's dozens
// of redundant Redis writes to the same global key within seconds (last-write-wins —
// the extra writes buy nothing). Throttle to at most one fallback write per minute;
// the fallback is best-effort "any recent headlines", so skipping the in-between
// writes is safe.
// 2026-07-04: Throttle moved from a process-local timestamp to a Redis SET NX lock so
// it dedupes ACROSS instances. Blue-green deploys run 2-3 app instances at once, each
// with its own process; a process-local counter gave every instance its own 60s window,
// so all instances could still stampede the same global key during a rolling deploy.
// SET NX EX 60 gives a single cluster-wide 60s throttle window.
const NEWS_FALLBACK_WRITE_THROTTLE_SECONDS = 60;

// 2026-07-06: Cross-instance scheduler-tick lock. Blue-green runs 2-3 app instances,
// each with its own 15-min timer + boot ticks (initial 60s, retry 180s). Per-user
// fetches are already deduped by a SET NX lock, but every instance still redundantly
// scans the active-user + user-memory tables and runs the TTL pipeline on each tick.
// A cluster-wide NX lock lets a single instance own each tick. The lock is released in
// finally on completion; the TTL is only a crash-safety cap (shorter than the 15-min
// interval so a died-mid-tick process never blocks the next scheduled tick).
const SCHEDULER_TICK_LOCK_KEY = 'news:scheduler:tick-lock';
// 14 min crash-safety cap: must be >= the worst-case tick duration yet < the
// 15-min scheduler interval, so a crashed tick's lock always clears before the
// next tick fires. The finally block del()s it on clean completion.
// 2026-07-12: per-fetch time is now hard-bounded (~336-459s pathological,
// <60s typical — see NEWS_FETCHING_TTL note), so a BATCH_SIZE=3 batch fits the
// old 60s-per-prefetch envelope in normal operation. A many-batch tick during a
// sustained provider degradation can still exceed 14 min — the per-user NX
// fetch locks then dedupe the overlapping next tick, and the fetch breaker
// short-circuits doomed pipelines, so overlap degrades to wasted scans rather
// than duplicate fetch storms.
const SCHEDULER_TICK_LOCK_TTL = 14 * 60;

// ── Briefing quality gate ─────────────────────────────────────────────────────
// 2026-07-12: A sparse web-search day produced a briefing whose ONLY item was
// almanac trivia ("AP says July 11, 2026 is the 192nd day of the year" — the
// model rewrote AP's "Today in History" page as a headline). Any non-empty
// array previously counted as a fully successful fetch, so that one junk item
// was cached as the user's entire Daily Briefing for 24h, reset the fetch
// circuit breaker, and was written to the GLOBAL fallback key where it could
// poison every user's outage fallback. Two-part gate:
//   1. filterJunkHeadlines() drops obvious non-news almanac output.
//   2. A fetch only counts as healthy with >= MIN_HEALTHY_HEADLINES usable
//      items (the prompt demands exactly 20); thin results are treated as
//      failures — served from fallback when possible and cached only briefly.
export const MIN_HEALTHY_HEADLINES = 5;
const NEWS_THIN_CACHE_TTL = 30 * 60; // 30 min — thin briefings expire fast so the next scheduler tick (phase 1: TTL < 2h) replaces them

/**
 * News formatter ladder telemetry (log-signal family a800a12d, 2026-11-01).
 *
 * The ladder's designed outcomes used to be untagged `warn` rows, so the hourly
 * log-signal sweep fingered each one as a recurring internal fault and re-filed
 * a ticket every ISO week (tickets 0de27d1b / d1be4f9e / b4bfd09a / 359c3a35,
 * 36-44 rows per 24 h at filing). Re-taxonomizing them (utils/log-level.ts)
 * must NOT make the class unmeasurable, so every demoted site records ONE row
 * here instead: the acceptance-metric probe `loop_metric_count` can read it,
 * and so can an operator reading GET /admin/loop-metrics.
 *
 * This is NOT the news outage alarm and deliberately does not replace it: a
 * sustained outage still escalates through the fetch circuit breaker
 * (recordFetchFailure → ONE deduped mishap ticket, fe661565). Never throws —
 * recordLoopMetric is fire-and-forget by contract.
 */
function recordNewsLadderMetric(phase: string, outcome: string): void {
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.NEWS_FORMATTER_LADDER,
      value: 1,
      meta: { phase, outcome, source: 'news' },
    });
  } catch { /* telemetry must never break a fetch */ }
}

// 2026-07-12 review: per-user failure backoff. Without it, a below-minimum
// prefetch outcome re-arms immediately: the frontend polls GET /news every 6s
// while pending, the controller fire-and-forgets a new prefetch on every
// cache-miss/thin hit, and the fetching lock is released in finally — so on a
// bad day one polling user relaunches the full search+format pipeline
// back-to-back indefinitely. After any below-minimum outcome the user sits out
// 5 minutes; the scheduler's 15-min phase-1 tick still repairs the cache.
const NEWS_BACKOFF_TTL = 5 * 60;

async function setNewsBackoff(userId: string): Promise<void> {
  try {
    await redisClient.setEx(NEWS_BACKOFF_KEY(userId), NEWS_BACKOFF_TTL, '1');
  } catch { /* non-critical */ }
}

/**
 * Read-side of the per-user failure backoff (mirrors isQuestionsFailureBackoff
 * in suggested-questions.service.ts). True while the last prefetch for this
 * user ended below the minimum and the 5-min sit-out is still armed — the
 * GET /news controller surfaces this as `degraded: true` so the home news card
 * can show an honest unavailable state instead of polling "every few seconds"
 * indefinitely (ticket d86cf931, 2026-08-29 ~6h outage).
 */
export async function isNewsFailureBackoff(userId: string): Promise<boolean> {
  try {
    return !!(await redisClient.get(NEWS_BACKOFF_KEY(userId)));
  } catch {
    return false; // Redis hiccup — don't degrade the card on a read error
  }
}

// 2026-07-12 review pass: each pattern verified against real-headline false
// positives (quote-led commemorations, New Year's news, December deadline
// coverage, possessive/hyphenated "year's"/"year-long" phrasing) — see the
// false-positive guards in news.service.test.ts before loosening any of these.
const JUNK_HEADLINE_PATTERNS: RegExp[] = [
  // "the 192nd day of the year" — the lookahead spares genuine possessive/
  // hyphenated phrasing ("2nd day of the year's worst flooding", "100th day
  // of the year-long war").
  /\b\d{1,3}(?:st|nd|rd|th)\s+day\s+of\s+the\s+year(?!['’-])\b/i,
  // "192nd day of 2026" — ordinal must be >= 32 so genuine New Year's news
  // ("1st day of 2026") survives; January almanac slips past this one but the
  // other patterns + the MIN gate bound the damage.
  /\b(?:3[2-9]|[4-9]\d|[1-3]\d{2})(?:st|nd|rd|th)\s+day\s+of\s+\d{4}\b/i,
  /\btoday in history\b/i,
  // "On This Day: July 11" / "on this day in 1804/in history" — but NOT
  // commemoration quotes ("on this day of remembrance…").
  /\bon this day\s*(?::|in\s+(?:\d{4}|history))/i,
  // "173 days left in the year" almanac countdowns — number >= 32 spares
  // December deadline news ("10 days left in the year, Congress races…").
  /\b(?:3[2-9]|[4-9]\d|[1-3]\d{2})\s+days?\s+(?:left|remain(?:ing)?)\s+in\s+(?:the\s+)?year\b/i,
];

export function isJunkHeadline(headline: string): boolean {
  return JUNK_HEADLINE_PATTERNS.some(p => p.test(headline));
}

/** Drop items with no usable headline text or almanac-trivia headlines. */
export function filterJunkHeadlines<T extends { headline?: unknown }>(items: T[]): T[] {
  return items.filter(
    item =>
      typeof item?.headline === 'string' &&
      item.headline.trim().length > 0 &&
      !isJunkHeadline(item.headline)
  );
}

// ── Aggregator / roundup hub titles (2026-08-31) ──────────────────────────────
// Live-briefing audit (Paul's homepage, 2026-08-31): the utility model parrots
// SERP page TITLES as stories — "Top U.S. & World Headlines — August 28, 2026"
// sat next to the same hub's July 31 edition in one briefing. A dated index of
// links is never a story; a daily briefing must never surface one.
const AGGREGATOR_HEADLINE_PATTERNS: RegExp[] = [
  // "Top U.S. & World Headlines — …", "Top 10 Headlines Today", "Top headlines this morning"
  // (any-char span, not [^.!?] — abbreviation dots like "U.S." must not break the match)
  /^\s*["'“”]?top\b[\s\S]{0,60}?\bheadlines?\b/i,
  // "Morning/Evening/Daily … Headlines/Digest/Roundup/Briefing/Recap"
  /\b(morning|evening|nightly|daily|weekly|weekend)\b[\s\S]{0,40}?\b(headlines?|roundup|digest|briefing|recap|wrap-?up)\b/i,
  // "news roundup", "daily digest", "week in review", "news in brief"
  /\b(news\s+(roundup|digest|recap)|week\s+in\s+review|news\s+in\s+brief)\b/i,
];

export function isAggregatorHeadline(headline: string): boolean {
  return AGGREGATOR_HEADLINE_PATTERNS.some(p => p.test(headline));
}

// ── Explicit-date staleness gate (2026-08-31) ─────────────────────────────────
// SERP results are full of dated SEO pages ("… — July 31, 2026") that rank for
// the query's keywords weeks after publication; the model parrots those titles,
// so a fresh briefing carried month-old "news". A daily briefing has no business
// surfacing a headline that EMBEDS a date older than NEWS_MAX_STORY_AGE_DAYS —
// genuine fresh stories almost never carry a full explicit date in the title.
export const NEWS_MAX_STORY_AGE_DAYS = 2;
const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const MONTH_NAME_RE =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
// "July 31, 2026" / "July 31" / "Sept 2nd" — US month-first style only; numeric
// dates are deliberately not matched (too many false positives: versions, scores).
const HEADLINE_DATE_RE = new RegExp(
  `\\b(${MONTH_NAME_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s*(\\d{4})?\\b`,
  'i'
);

/**
 * Parse an explicit month-name date embedded in a headline. Yearless dates are
 * resolved to the nearest occurrence around `now` (a "December 28" headline read
 * on January 2 is 5 days old, not 360 days in the future).
 */
export function extractHeadlineDate(headline: string, now: Date = new Date()): Date | null {
  const m = HEADLINE_DATE_RE.exec(headline);
  if (!m) return null;
  const month = MONTH_INDEX[m[1].toLowerCase().replace(/\.$/, '')];
  const day = parseInt(m[2], 10);
  if (month === undefined || day < 1 || day > 31) return null;
  let year = m[3] ? parseInt(m[3], 10) : now.getFullYear();
  if (!m[3] && new Date(year, month, day).getTime() - now.getTime() > 30 * 24 * 60 * 60 * 1000) {
    year -= 1; // yearless date far in the future is almost certainly last year's
  }
  return new Date(year, month, day);
}

/** True when a headline embeds an explicit date older than the briefing's freshness window. */
export function isStaleHeadline(headline: string, now: Date = new Date()): boolean {
  const storyDate = extractHeadlineDate(headline, now);
  if (!storyDate) return false;
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ageDays = Math.floor((nowDay.getTime() - storyDate.getTime()) / (24 * 60 * 60 * 1000));
  return ageDays > NEWS_MAX_STORY_AGE_DAYS;
}

// ── Per-item publication-label gate (ticket 94b93132, 2026-10-27) ─────────────
// "Today's news" briefings served month/years-old stories whose age was
// INVISIBLE: the formatter schema dropped the SERP date labels entirely
// (extractSerpOrganicForPrompt renders them, but the output contract was only
// {headline,summary,category,chatPrompt}) and the frontend injection block
// carried no date — a 2021 Oak Bay wastewater story rode into an agent's
// context as "today's news" and burned turns re-verifying dates. Two layers:
//   1. The formatter prompt now carries a `published` field (the SERP date/age
//      label verbatim) and fetchNewsHeadlines normalizes it onto every item.
//   2. THIS deterministic gate: a parseable label older than
//      NEWS_MAX_PUBLISHED_AGE_DAYS drops the item at write time AND at read
//      time (getNewsFromCache / getNewsFallbackCache run filterBriefingQuality,
//      so cached briefings predating the field self-heal) — same pattern as
//      isStaleHeadline. Unparseable labels PASS the gate; the frontend shows
//      them verbatim, so nothing ever claims a freshness it cannot show.
// 72h window (ticket suggestion 48–72h): the SERP queries already bias fresh
// with after:-36h, and a same-week story is legitimately news context — the
// gate only removes the recycled-years-old class.
export const NEWS_MAX_PUBLISHED_AGE_DAYS = 3;

const USELESS_PUBLISHED_LABEL_RE = /^(unknown|n\/?a|none|null|unsure|unclear|not available|no date)$/i;

/**
 * Coerce the formatter's `published` output to a clean display label: trimmed,
 * whitespace-collapsed, length-capped. Useless non-dates ("unknown", "n/a")
 * become '' — the item then displays WITHOUT a date instead of a fake one.
 * Freshness words ("today", "yesterday", "3 hours ago") are kept: they are
 * parseable and honest.
 */
export function normalizePublishedLabel(raw: unknown): string {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!s) return '';
  if (USELESS_PUBLISHED_LABEL_RE.test(s)) return '';
  return s;
}

// "3 hours ago" / "2 days ago" / "5 weeks ago" — BrightData/Google age labels.
const RELATIVE_AGE_RE = /^(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago$/i;
const DAY_FIRST_DATE_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME_RE})\\.?(?:,)?\\s*(\\d{4})?\\b`,
  'i'
);
const RELATIVE_MS_PER_UNIT: Record<string, number> = {
  minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000,
  day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000,
};

/**
 * Parse a `published` label to an absolute Date when it is unambiguous:
 * relative ages ("3 hours ago"), freshness words ("today", "yesterday"),
 * US month-first dates ("Oct 28, 2021", reusing the headline parser's yearless
 * rollover), day-first European dates ("28 Oct 2021"), ISO dates ("2021-10-28")
 * and a bare year ("2021" → Jan 1, conservative for staleness). Ambiguous
 * numeric slash dates (10/28 — day/month order unknown) return null on purpose:
 * the label still displays verbatim, it just cannot gate.
 */
export function parsePublishedLabel(label: string, now: Date = new Date()): Date | null {
  if (!label) return null;
  const dayStart = (offsetDays: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays);
  if (/^today$/i.test(label)) return dayStart(0);
  if (/^yesterday$/i.test(label)) return dayStart(1);
  if (/^(now|right now|just now|this (morning|afternoon|evening))$/i.test(label)) return dayStart(0);
  const rel = RELATIVE_AGE_RE.exec(label);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const ms = RELATIVE_MS_PER_UNIT[rel[2].toLowerCase().replace(/s$/, '')];
    if (!ms || !Number.isFinite(n) || n <= 0) return null;
    return new Date(now.getTime() - n * ms);
  }
  const usDate = extractHeadlineDate(label, now);
  if (usDate) return usDate;
  const dayFirst = DAY_FIRST_DATE_RE.exec(label);
  if (dayFirst) {
    const day = parseInt(dayFirst[1], 10);
    const month = MONTH_INDEX[dayFirst[2].toLowerCase().replace(/\.$/, '')];
    if (month === undefined || day < 1 || day > 31) return null;
    let year = dayFirst[3] ? parseInt(dayFirst[3], 10) : now.getFullYear();
    if (!dayFirst[3] && new Date(year, month, day).getTime() - now.getTime() > 30 * 24 * 60 * 60 * 1000) {
      year -= 1; // yearless date far in the future is almost certainly last year's
    }
    return new Date(year, month, day);
  }
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(label);
  if (iso) {
    return new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
  }
  const bareYear = /^(20\d{2})$/.exec(label);
  if (bareYear) return new Date(parseInt(bareYear[1], 10), 0, 1);
  return null;
}

/** True when a `published` label parses to a date older than NEWS_MAX_PUBLISHED_AGE_DAYS. */
export function isStalePublishedLabel(label: string, now: Date = new Date()): boolean {
  const publishedAt = parsePublishedLabel(label, now);
  if (!publishedAt) return false;
  // Calendar-day granularity, mirroring isStaleHeadline: a label at most
  // NEWS_MAX_PUBLISHED_AGE_DAYS calendar days back passes (an absolute date
  // parsed to midnight reads its full-day age once floored).
  const ageDays = Math.floor((now.getTime() - publishedAt.getTime()) / (24 * 60 * 60 * 1000));
  return ageDays > NEWS_MAX_PUBLISHED_AGE_DAYS;
}

// ── Duplicate / near-duplicate suppression (2026-08-31) ───────────────────────
// The prompt asks for unique stories; the model cannot be trusted (two editions
// of the same dated roundup sat side-by-side in one live briefing). Gate: exact
// dupes after normalization, then token-Jaccard near-dupes (same story reworded).
// First occurrence wins — the prompt's section ordering is preserved.
const NEAR_DUP_JACCARD = 0.7;

/** Lowercased, date-stripped, punctuation-stripped form used for dedup + seen-history. */
export function normalizeHeadlineKey(headline: string): string {
  return headline
    .toLowerCase()
    .replace(new RegExp(`\\b(?:${MONTH_NAME_RE})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,)?\\s*\\d{0,4}`, 'gi'), ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headlineTokens(headline: string): Set<string> {
  return new Set(normalizeHeadlineKey(headline).split(' ').filter(t => t.length > 2));
}

export function dedupeHeadlines<T extends { headline?: unknown }>(items: T[]): T[] {
  const kept: T[] = [];
  const seenExact = new Set<string>();
  const keptTokens: Set<string>[] = [];
  for (const item of items) {
    const headline = typeof item?.headline === 'string' ? item.headline : '';
    const key = normalizeHeadlineKey(headline);
    if (!key || seenExact.has(key)) continue;
    const tokens = headlineTokens(headline);
    let isNearDup = false;
    if (tokens.size > 0) {
      for (const prev of keptTokens) {
        let intersection = 0;
        for (const t of tokens) if (prev.has(t)) intersection++;
        const union = tokens.size + prev.size - intersection;
        if (union > 0 && intersection / union >= NEAR_DUP_JACCARD) {
          isNearDup = true;
          break;
        }
      }
    }
    if (isNearDup) continue;
    seenExact.add(key);
    keptTokens.push(tokens);
    kept.push(item);
  }
  return kept;
}

/**
 * Full deterministic briefing quality gate (2026-08-31): almanac junk + aggregator
 * hub titles + explicit-date staleness + duplicate suppression. Applied at write
 * time (fetch), at read time (self-heals briefings cached before the gate
 * existed), and to the global fallback before serving.
 * Ticket 94b93132 (2026-10-27): items whose `published` label parses to a date
 * older than NEWS_MAX_PUBLISHED_AGE_DAYS are dropped too — briefings cached
 * before the field existed carry no label (undefined) and pass, so old caches
 * only lose the items whose HEADLINE still embeds a stale date.
 */
export function filterBriefingQuality<T extends { headline?: unknown; published?: unknown }>(items: T[], now: Date = new Date()): T[] {
  return dedupeHeadlines(
    filterJunkHeadlines(items).filter(
      item =>
        !isAggregatorHeadline(item.headline as string) &&
        !isStaleHeadline(item.headline as string, now) &&
        !isStalePublishedLabel(normalizePublishedLabel(item.published), now)
    )
  );
}

// ── Tolerant JSON repair (#89) ────────────────────────────────────────────────
// Deterministic fixes for the most common LLM JSON defects, applied ONLY after
// every strict parse has failed — valid JSON is never touched, and the repaired
// text is still strict-parsed afterwards, so unrepairable content falls through
// exactly as before. Prod telemetry (~39 warns/48h) shows the strict strategies
// dying on these shapes and forcing the slow (and itself flaky) LLM-reformat
// leg: trailing commas, single-quoted strings, unquoted keys, JSON5-style
// comments, and zero-width chars. In rare mixed-content cases a repair can
// cosmetically alter string content (and the zero-width strip also drops
// ZWJ/ZWNJ joiners, altering emoji/Indic shaping) — an accepted trade versus
// serving a stale fallback cache.

/** Remove // and block comments while respecting string literals (URLs!). */
function stripJsonCommentsAware(input: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charAt(i);
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < input.length) { out += input.charAt(++i); continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '/' && input.charAt(i + 1) === '/') {
      while (i < input.length && input.charAt(i) !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && input.charAt(i + 1) === '*') {
      i += 2;
      while (i < input.length && !(input.charAt(i) === '*' && input.charAt(i + 1) === '/')) i++;
      i++; // land on the closing '/'
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Best-effort repair of common LLM JSON defects. Order matters: zero-width +
 * comments first (they can contain quote chars), then single→double quote
 * conversion (escape-aware; \' is normalized to ' because JSON has no \'
 * escape), then unquoted keys, then trailing commas.
 */
function repairCommonLlmJsonDefects(raw: string): string {
  let s = raw.replace(/[​-‍﻿]/g, ''); // zero-width chars + BOM
  s = stripJsonCommentsAware(s);
  s = s.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) =>
    '"' + inner.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"'
  );
  s = s.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s;
}

// ── Target hours for news refresh (local time) ───────────────────────────────
const TARGET_HOURS = [6, 12, 16, 21]; // 6am, 12pm, 4pm, 9pm
const WINDOW_MINUTES = 20;            // Fetch if within the first 20 min of a target hour

// ── Concurrency control ───────────────────────────────────────────────────────
const BATCH_SIZE = 3;    // Parallel news fetches (search + format) per batch
const BATCH_DELAY = 3000; // ms between batches (avoids rate limiting)

// ── In-memory fetch tracking (instant, no Redis round-trip) ───────────────────
// Used by the controller to instantly check if a fetch is already running for a
// user, so it can return pending=true without even hitting Redis.
const _inFlightFetches = new Set<string>();

/** Synchronous check: is a news fetch already in progress for this user? */
export function isNewsFetchInProgress(userId: string): boolean {
  return _inFlightFetches.has(userId);
}

// ── Get cached headlines from Redis ──────────────────────────────────────────
export async function getNewsFromCache(userId: string): Promise<any[] | null> {
  try {
    const raw = await redisClient.get(NEWS_CACHE_KEY(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Quality-filter at read time too: self-heals briefings cached before the
    // write-side gate existed — an all-junk cache (e.g. a lone almanac
    // headline, or only stale dated roundups) reads as a miss so the
    // controller triggers a fresh fetch.
    const usable = filterBriefingQuality(parsed);
    return usable.length > 0 ? usable : null;
  } catch {
    return null;
  }
}

// ── Store headlines in Redis ──────────────────────────────────────────────────
export async function setNewsCache(
  userId: string,
  headlines: any[],
  ttlSeconds: number = NEWS_CACHE_TTL
): Promise<void> {
  try {
    await redisClient.setEx(NEWS_CACHE_KEY(userId), ttlSeconds, JSON.stringify(headlines));
  } catch (err: any) {
    logger.warn(`news.service: failed to set cache for ${userId}: ${err.message}`, { source: 'news', userId });
  }
}

// ── Check if a fetch is already in progress for a user ────────────────────────
export async function isNewsFetching(userId: string): Promise<boolean> {
  try {
    const val = await redisClient.get(NEWS_FETCHING_KEY(userId));
    return val === '1';
  } catch {
    return false;
  }
}

// ── Inferred news topics (ticket 6c037cc6) ────────────────────────────────────
// Raw chat titles made terrible topic seeds: an owner running fleet-supervisor
// coding chats got a homepage full of management news because the literal
// titles ("Fleet Supervisor", "Coding Session …") were injected straight into
// the SERP queries. Instead of echoing titles, a utility LLM REASONS over the
// user's memory facts + recent chat titles and outputs 3-5 concrete news
// topics the user would genuinely read about — explicitly excluding
// work-tooling/ops jargon. Cached in Redis for ~6h so the inference runs a few
// times a day, not per prefetch; ANY failure (LLM down, prose output, thin
// result) falls back to the raw title list — exactly the old behavior.
const NEWS_TOPICS_CACHE_KEY = (userId: string) => `user:news:topics:${userId}`;
const NEWS_TOPICS_CACHE_TTL = 6 * 60 * 60; // 6h
const NEWS_TOPICS_MIN = 3;
const NEWS_TOPICS_MAX = 5;

export async function inferNewsTopics(
  userId: string,
  facts: Record<string, string>,
  recentTitles: string[],
): Promise<string[]> {
  // Nothing to reason over — skip the LLM entirely (also keeps signal-less
  // users on the generic trending queries with zero added latency).
  const factLines = Object.entries(facts || {})
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `${k}: ${String(v)}`.slice(0, 200))
    .slice(0, 30);
  if (factLines.length === 0 && recentTitles.length === 0) return recentTitles;

  try {
    const cached = await redisClient.get(NEWS_TOPICS_CACHE_KEY(userId));
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((t: any) => typeof t === 'string' && t.trim())) {
        return parsed;
      }
    }
  } catch { /* cache miss on Redis error */ }

  if (!isUtilityLLMAvailable()) return recentTitles;

  const prompt = `You infer what NEWS a person would genuinely want to read, from signals about them.

[USER MEMORY FACTS]
${factLines.length ? factLines.join('\n') : '(none)'}

[RECENT CHAT TITLES]
${recentTitles.length ? recentTitles.slice(0, 10).map(t => `- ${String(t).slice(0, 120)}`).join('\n') : '(none)'}

Reason about who this person is, then output ${NEWS_TOPICS_MIN}-${NEWS_TOPICS_MAX} CONCRETE news topics they would care about as a READER (e.g. "AI model releases", "New York Knicks", "Vancouver housing market").
RULES:
- Do NOT echo keywords: chat titles are often work tooling/ops chatter (session names, bug tickets, infra jargon) — infer the underlying interest behind them, never seed news from the tool or project jargon itself.
- Each topic 2-6 words, concrete enough to be a news search query.
- Output ONLY a raw JSON array of strings. Start with [ and end with ].`;

  try {
    const content = await utilityChat(
      [
        { role: 'system', content: NEWS_JSON_INSTRUCTIONS },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 1000, temperature: 0.3, timeout: 30000, contentOnly: true }
    );
    if (!content) return recentTitles;

    // Same fence-strip + bracket-extraction parse idiom as fetchNewsHeadlines.
    let arr: any = null;
    const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
    try { arr = JSON.parse(cleaned); } catch {
      const start = cleaned.indexOf('[');
      const end = cleaned.lastIndexOf(']');
      if (start !== -1 && end > start) {
        try { arr = JSON.parse(cleaned.substring(start, end + 1)); } catch { /* fall through */ }
      }
    }
    const topics = Array.isArray(arr)
      ? arr
          .filter((t: any) => typeof t === 'string' && t.trim().length > 0)
          .map((t: string) => t.trim().slice(0, 80))
          .slice(0, NEWS_TOPICS_MAX)
      : [];
    if (topics.length < NEWS_TOPICS_MIN) {
      logger.info(`news.service: topic inference produced only ${topics.length} usable topic(s) for userId=${userId} — falling back to raw chat titles`);
      return recentTitles;
    }
    try { await redisClient.setEx(NEWS_TOPICS_CACHE_KEY(userId), NEWS_TOPICS_CACHE_TTL, JSON.stringify(topics)); } catch { /* non-critical */ }
    logger.info(`news.service: inferred ${topics.length} news topics for userId=${userId}`);
    return topics;
  } catch (err: any) {
    logger.warn(`news.service: topic inference failed for userId=${userId}: ${err?.message} — falling back to raw chat titles`, { source: 'news', userId });
    return recentTitles;
  }
}

// ── Per-user seen-history rotation (2026-08-31) ───────────────────────────────
// SOTA personalized-news behavior: a briefing should not repeat stories the user
// was already served. Without it the same items recurred briefing-after-briefing
// (4 refreshes/day × the same morning SERPs). The fetch result is partitioned
// into unseen items (always preferred) and already-served items (backfill only,
// so the panel never degrades on a genuinely slow news day).
const NEWS_SEEN_KEY = (userId: string) => `user:news:seen:${userId}`;
const NEWS_SEEN_TTL = 48 * 60 * 60; // 48h — spans 8 refresh windows
const NEWS_SEEN_MAX = 80;           // cap — ~4 briefings' worth of 20 items

async function getSeenHeadlineKeys(userId: string): Promise<Set<string>> {
  try {
    const raw = await redisClient.get(NEWS_SEEN_KEY(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((k: any) => typeof k === 'string') : []);
  } catch {
    return new Set(); // Redis hiccup — rotation is best-effort, never block a fetch
  }
}

/** Partition into unseen vs already-served by normalized headline key; both preserve original order. */
export function partitionBySeen<T extends { headline?: unknown }>(
  items: T[],
  seenKeys: Set<string>
): { unseen: T[]; seen: T[] } {
  const unseen: T[] = [];
  const seen: T[] = [];
  for (const item of items) {
    const key = normalizeHeadlineKey(typeof item?.headline === 'string' ? item.headline : '');
    (key && seenKeys.has(key) ? seen : unseen).push(item);
  }
  return { unseen, seen };
}

async function recordShownHeadlines(userId: string, shown: any[], existingSeen: Set<string>): Promise<void> {
  try {
    const shownKeys = shown
      .map(h => normalizeHeadlineKey(String(h?.headline || '')))
      .filter(Boolean);
    if (shownKeys.length === 0) return;
    // Merge: keep previously-seen keys not re-shown (still inside their
    // suppression window), append the newly shown ones, cap at the most recent.
    const shownSet = new Set(shownKeys);
    const merged = [...[...existingSeen].filter(k => !shownSet.has(k)), ...shownKeys].slice(-NEWS_SEEN_MAX);
    await redisClient.setEx(NEWS_SEEN_KEY(userId), NEWS_SEEN_TTL, JSON.stringify(merged));
  } catch { /* non-critical — worst case a story repeats tomorrow */ }
}

// ── Pre-fetch news for a specific user ────────────────────────────────────────
export async function prefetchNewsForUser(userId: string): Promise<any[]> {
  // ── Failure backoff: a below-minimum attempt in the last 5 min means another
  // immediate attempt is almost certainly doomed too — don't let the frontend's
  // 6s pending-poll relaunch the pipeline back-to-back (2026-07-12 review).
  try {
    if (await redisClient.get(NEWS_BACKOFF_KEY(userId))) {
      logger.info(`news.service: prefetch for userId=${userId} skipped — in failure backoff`);
      return [];
    }
  } catch { /* Redis error — proceed */ }

  // ── Deduplication: skip if another fetch is already in progress ──
  // 2026-07-02: The previous get()-then-setEx() was a non-atomic check-then-set:
  // during rolling blue-green deploys, 2-3 instances fire their startup scheduler
  // tick within ~60-90s of each other and could ALL pass the get() before any wrote
  // the lock → 3× duplicate OpenAI news calls per user. Use an atomic SET NX EX so
  // exactly one instance acquires the lock; the losers bail out immediately.
  try {
    const acquired = await redisClient.set(NEWS_FETCHING_KEY(userId), '1', { NX: true, EX: NEWS_FETCHING_TTL });
    if (acquired !== 'OK') {
      logger.info(`news.service: skipping prefetch for userId=${userId} — already in progress (Redis lock)`);
      return [];
    }
  } catch { /* Redis error — proceed anyway (in-memory lock still guards single instance) */ }

  // In-memory lock guards against duplicate fetches within this instance
  _inFlightFetches.add(userId);

  try {
    // Load user memory for personalization
    const memory = await prisma.userMemory.findUnique({ where: { userId } });
    const facts = (memory?.facts as Record<string, string>) || {};
    const location    = facts.location    || '';
    const interests   = facts.interests   || '';
    const occupation  = facts.occupation  || '';

    // Recent chat titles for topic signals (archived chats excluded — the
    // personalization signal follows the visible fleet; ghost chats excluded
    // (owner 2026-10-22) — a private chat's title never feeds the cloud).
    const recentChats = await prisma.crossModelChat.findMany({
      where: { userId, archivedAt: null, ghostMode: false },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { title: true },
    });
    const recentTitles = recentChats
      .map(c => c.title)
      .filter((t): t is string => !!t && t !== 'New Chat');

    // Inference step (ticket 6c037cc6): reasoned reader topics, not raw title
    // echoes. Redis-cached ~6h; falls back to the raw title list on any failure.
    const recentTopics = await inferNewsTopics(userId, facts, recentTitles);

    const fetchStartedAt = Date.now();
    // Provenance (ticket 4888d891): a FAILED fetch returns the shared outage
    // fallback (ANOTHER user's briefing). Its item count is meaningless as a
    // success signal — blaming `headlines.length` alone pinned that content
    // under THIS user with the full 24h TTL and armed no backoff, so the home
    // card sat on stale outage news until the next target hour.
    const firstOutcome: NewsFetchOutcome = { source: 'none' };
    let headlines = await fetchNewsHeadlines(location, interests, occupation, recentTopics, firstOutcome);
    let fromFallback = firstOutcome.source === 'fallback';
    // A fallback-served result must never be counted toward the healthy minimum.
    let ownHeadlineCount = fromFallback ? 0 : headlines.length;

    // 2026-06-09: Retry at the prefetchNewsForUser level when fetchNewsHeadlines returns 0
    // headlines (e.g. OpenAI returned prose instead of JSON, or a transient 502/503).
    // Previously, a failed prefetch meant the user saw stale news for up to 15 minutes
    // until the next scheduler tick. This single retry with a 3s delay catches the
    // majority of transient failures without adding significant latency.
    // 2026-07-12: Retry on ANY below-minimum result, not just 0 — a degenerate 1-item
    // briefing is just as broken for the user as an empty one.
    // Deadline guard: a slow first pass means the retry would outlive the 480s
    // fetch lock and admit cross-instance duplicate fetches — skip it and let
    // the backoff + next scheduler tick handle the repair.
    const retryFitsLock = Date.now() - fetchStartedAt <= NEWS_RETRY_DEADLINE_MS;
    if (ownHeadlineCount < MIN_HEALTHY_HEADLINES && !retryFitsLock) {
      logger.warn(`news.service: skipping prefetch retry for userId=${userId} — first pass used ${Math.round((Date.now() - fetchStartedAt) / 1000)}s of the fetch lock`, { source: 'news', userId });
    }
    if (ownHeadlineCount < MIN_HEALTHY_HEADLINES && retryFitsLock) {
      // Log-signal family a800a12d (ticket 0de27d1b, 2026-11-01): the designed
      // SINGLE retry announcing itself is an EXPECTED outcome, not an internal
      // fault — it was emitted at untagged warn, so the hourly sweep read one
      // row per user per fetch window as a recurring failure class (44 rows /
      // 4 boot episodes at filing) and re-filed it every ISO week. Message text
      // is UNCHANGED (greps + the sweep's messagePattern keep matching); the
      // durable escalation for a sustained outage is untouched: a below-minimum
      // outcome arms NEWS_BACKOFF_KEY below and a whole-fetch failure reaches
      // recordFetchFailure → the fetch circuit breaker → ONE deduped outage
      // ticket (fe661565). Counted on news_formatter_ladder so the class stays
      // measurable without living in app_error_logs.
      logHandled(`news.service: prefetch returned only ${ownHeadlineCount} own headlines for userId=${userId}${fromFallback ? ' (served outage fallback)' : ''} — retrying once after 3s`, { source: 'news', userId });
      recordNewsLadderMetric('prefetch_retry', fromFallback ? 'fallback' : 'thin');
      await new Promise(r => setTimeout(r, 3000));
      // Guarded so a throwing retry can never discard the initial thin result
      // (2026-07-12 review: the outer catch would have returned [] and cached
      // nothing, blanking a panel the initial attempt could have filled).
      try {
        const retryOutcome: NewsFetchOutcome = { source: 'none' };
        const retried = await fetchNewsHeadlines(location, interests, occupation, recentTopics, retryOutcome);
        // A retry that ALSO failed is fallback content again — it must not be
        // treated as an improvement over the first fallback just for being
        // longer (ticket 4888d891).
        if (retryOutcome.source === 'fetch') {
          if (retried.length > ownHeadlineCount) {
            headlines = retried;
            ownHeadlineCount = retried.length;
            fromFallback = false; // we now hold OUR OWN briefing
          }
        } else if (retried.length > 0 && retryOutcome.source === 'fallback') {
          logger.info(`news.service: prefetch retry also served the outage fallback for userId=${userId} — keeping it as degraded content only`, { source: 'news', userId });
          if (!fromFallback || retried.length > headlines.length) headlines = retried;
          fromFallback = true;
        }
      } catch (retryErr: any) {
        logger.warn(`news.service: prefetch retry threw for userId=${userId}: ${retryErr.message} — keeping initial ${headlines.length} headline(s)`, { source: 'news', userId });
      }
    }

    // ── Outage-fallback content is NEVER pinned as this user's briefing ──────
    // Ticket 4888d891: the fallback holds ANOTHER user's briefing, served only
    // because our own fetch failed. Caching it under this user with the 24h TTL
    // (and arming no backoff) is what made the home card sit stale: the item
    // count looked healthy, so the thin/failure lanes never ran and nothing
    // retried until the next target hour. Serve it as a clearly-degraded
    // stopgap with the SHORT thin TTL and arm the failure backoff so the next
    // scheduler tick repairs it. Also never let it consume seen-history (that
    // would suppress another user's stories from OUR next genuine briefing).
    if (fromFallback) {
      if (headlines.length > 0) {
        const existing = await getNewsFromCache(userId);
        if (existing && existing.length >= headlines.length) {
          logger.info(`news.service: keeping existing ${existing.length}-headline cache for userId=${userId} (fallback served ${headlines.length})`, { source: 'news', userId });
          headlines = existing;
        } else {
          await setNewsCache(userId, headlines, NEWS_THIN_CACHE_TTL);
          logger.warn(`news.service: served outage fallback (${headlines.length} headline(s)) as a SHORT-TTL degraded briefing for userId=${userId} — not pinned for 24h`, { source: 'news', userId });
        }
      } else {
        logger.warn(`news.service: fetch failed and no fallback headlines are available for userId=${userId}`, { source: 'news', userId });
      }
      await setNewsBackoff(userId);
      return headlines;
    }

    // Seen-history rotation (2026-08-31): prefer stories never served to this
    // user; already-served stories backfill only to reach the healthy minimum,
    // so a slow news day can't degrade the panel.
    const seenKeys = await getSeenHeadlineKeys(userId);
    if (headlines.length > 0) {
      const { unseen, seen } = partitionBySeen(headlines, seenKeys);
      if (unseen.length >= MIN_HEALTHY_HEADLINES) {
        if (seen.length > 0) {
          logger.info(`news.service: rotated out ${seen.length} already-served headline(s) for userId=${userId}`);
          headlines = unseen;
        }
      } else if (unseen.length > 0 && seen.length > 0) {
        headlines = [...unseen, ...seen]; // fresh first, served items as backfill
      }
      await recordShownHeadlines(userId, headlines, seenKeys);
    }

    if (headlines.length >= MIN_HEALTHY_HEADLINES) {
      await setNewsCache(userId, headlines);
      logger.info(`news.service: pre-fetched ${headlines.length} headlines for userId=${userId}`);
    } else if (headlines.length > 0) {
      // Thin briefing even after retry: show it (better than a blank panel) but
      // expire it quickly — the 30-min TTL is under the scheduler's 2h
      // proactive-refresh threshold, so the next 15-min tick refetches. Never
      // downgrade: keep an existing cache that already has as many usable items
      // (2026-07-12 review — the controller's repair kick fires while a larger
      // thin cache is still live).
      const existing = await getNewsFromCache(userId);
      if (existing && existing.length >= headlines.length) {
        logger.info(`news.service: keeping existing ${existing.length}-headline cache for userId=${userId} (new fetch was thinner: ${headlines.length})`);
        headlines = existing;
      } else {
        await setNewsCache(userId, headlines, NEWS_THIN_CACHE_TTL);
        logger.warn(`news.service: cached THIN briefing (${headlines.length} headlines) for userId=${userId} with short TTL`, { source: 'news', userId });
      }
      await setNewsBackoff(userId);
    } else {
      logger.warn(`news.service: prefetch returned 0 headlines for userId=${userId} after retry — search or utility LLM may have failed`, { source: 'news', userId });
      await setNewsBackoff(userId);
    }

    return headlines;
  } catch (err: any) {
    logger.error(`news.service: prefetch failed for userId=${userId}: ${err.message}`);
    return [];
  } finally {
    // Always clear both locks when done (success or failure)
    _inFlightFetches.delete(userId);
    try { await redisClient.del(NEWS_FETCHING_KEY(userId)); } catch { /* non-critical */ }
  }
}

// ── Get local hour for a timezone string ─────────────────────────────────────
function getLocalHour(timezone: string): number {
  try {
    const hourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(new Date());
    const h = parseInt(hourStr, 10);
    return isNaN(h) ? new Date().getUTCHours() : h;
  } catch {
    return new Date().getUTCHours();
  }
}

function getLocalMinute(timezone: string): number {
  try {
    const minStr = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      minute: 'numeric',
    }).format(new Date());
    const m = parseInt(minStr, 10);
    return isNaN(m) ? new Date().getUTCMinutes() : m;
  } catch {
    return new Date().getUTCMinutes();
  }
}

// ── Scheduler circuit breaker ─────────────────────────────────────────────────
// 2026-05-28: Added circuit breaker to prevent cascading failures when OpenAI
// is slow/unavailable. If 3+ consecutive scheduler ticks fail for ALL users,
// skip prefetches for 30 minutes (2 tick cycles) to avoid queueing up failures
// that block the event loop and waste OpenAI quota.
// 2026-06-18: Raised threshold from 3 to 8 consecutive all-fail ticks to reduce
// false positives from transient provider errors (Jun 14 and 16 production incidents
// where the circuit breaker tripped on brief maintenance windows).
const SCHEDULER_CB_THRESHOLD = 8;           // consecutive all-fail ticks to trigger
// 2026-06-10: Reduced from 30 minutes to 5 minutes. Production logs show daily 6am
// Fireworks 404/502/503 errors that resolve within ~30s, but the 30-minute cooldown
// meant users got stale news for 30 minutes after a brief provider hiccup.
// 5 minutes (1/3 of a tick cycle) is enough to let transient errors clear without
// leaving users with stale news for half an hour.
const SCHEDULER_CB_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes (was 30 min)
let _schedulerFailCount = 0;
let _schedulerCBOpenUntil = 0;

function isSchedulerCircuitOpen(): boolean {
  if (_schedulerCBOpenUntil === 0) return false;
  if (Date.now() >= _schedulerCBOpenUntil) {
    _schedulerCBOpenUntil = 0;
    _schedulerFailCount = 0;
    logger.info('news.service: scheduler circuit breaker CLOSED — resuming prefetches');
    return false;
  }
  return true;
}

// ── Background Scheduler ──────────────────────────────────────────────────────
export function startNewsScheduler(): void {
  logger.info('news.service: starting background news scheduler (runs every 15 min)');

  // 2026-06-08: Exponential backoff with jitter for initial scheduler ticks.
  // Production logs show daily 6am model 404 errors (DeepSeek, GLM, Kimi all
  // returning 'Model not found') at ~6:17am UTC — exactly when the 10s startup
  // tick fires. This coincides with Fireworks AI's cold-start/maintenance window.
  // Fix: delay the first tick to 60s + jitter (0-30s) to let model pools warm up,
  // then retry at 180s + jitter if first tick failed. A single consolidated
  // warning replaces per-model error floods in the logs.
  const INITIAL_DELAY_MS = 60_000;       // 60s — gives model pools time to warm
  const RETRY_DELAY_MS   = 180_000;      // 180s — longer backoff for retry
  const jitter = () => Math.floor(Math.random() * 30_000); // 0-30s jitter

  setTimeout(() => runSchedulerTick().catch((err) => {
    logger.warn(`news.service: initial scheduler tick failed (will retry in ~${Math.round(RETRY_DELAY_MS / 1000)}s): ${err.message}`, { source: 'news' });
  }), INITIAL_DELAY_MS + jitter());

  // Retry tick with longer backoff — catches users whose first-run prefetch
  // failed (e.g., Fireworks cold-start, OpenAI rate limit, Redis not ready).
  setTimeout(() => runSchedulerTick().catch((err) => {
    logger.warn(`news.service: retry scheduler tick failed: ${err.message}`, { source: 'news' });
  }), RETRY_DELAY_MS + jitter());

  // Then every 15 minutes
  const interval = setInterval(() => {
    runSchedulerTick().catch(err => {
      logger.error('news.service: scheduler tick error:', err.message);
    });
  }, 15 * 60 * 1000);

  // Don't prevent Node from exiting
  interval.unref();
}

async function runSchedulerTick(): Promise<void> {
  if (webSearchMissingOnInstance()) {
    if (!_loggedNewsUnconfigured) {
      _loggedNewsUnconfigured = true;
      logger.info('news.service: web search is not configured on this instance — the news scheduler is idle (set BRIGHTDATA_API_TOKEN or the MCP gateway; Account → Admin → Setup)');
    }
    return;
  }
  // Edge hardening: an instance with a structurally-missing formatter (see
  // utilityChainUnconfigured) can never build a briefing — skip the tick
  // exactly like the no-search gate instead of letting every 15-min tick
  // re-arm the fetch breaker.
  // CAPABILITY-keyed, not instance-kind-keyed (review F1, 2026-10-27): the
  // gate below is NOT conjunct-guarded on !prod — an Edge deployed without
  // DIGBY_INSTANCE reads as 'prod' and the tick must still skip (the
  // reported digby.example.com box may be exactly that shape). Prod-safe on its
  // own: production's env keys make utilityChainUnconfigured() false before
  // any config read, and a read error fail-opens to false.
  if (await utilityChainUnconfigured()) {
    if (!_newsUtilityUnconfiguredLogged) {
      _newsUtilityUnconfiguredLogged = true;
      logger.info('news.service: no utility-LLM formatter is configured on this instance (no DEEPSEEK_API_KEY / DASHSCOPE_API_KEY and no Utility seat assignment) — the news scheduler is idle (assign the Utility seat in Account → Admin → Endpoints → Model roles, or set DEEPSEEK_API_KEY / DASHSCOPE_API_KEY)');
    }
    return;
  }
  // Circuit breaker: skip this tick if OpenAI has been consistently failing
  if (isSchedulerCircuitOpen()) {
    logger.info('news.service: scheduler circuit breaker OPEN — skipping this tick');
    return;
  }

  const tickStart = Date.now();

  // Cross-instance dedup: only one app instance runs each tick (see lock note above).
  let tickLockAcquired = false;
  try {
    tickLockAcquired = (await redisClient.set(SCHEDULER_TICK_LOCK_KEY, '1', { NX: true, EX: SCHEDULER_TICK_LOCK_TTL })) === 'OK';
  } catch {
    tickLockAcquired = true; // Redis unreachable — don't let a lock failure suppress the tick
  }
  if (!tickLockAcquired) {
    logger.info('news.service: another instance already owns this scheduler tick — skipping');
    return;
  }

  try {
  // Get all users active in the last 7 days
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const activeUsers = await prisma.user.findMany({
    where: { updatedAt: { gte: since }, isActive: true },
    select: { id: true },
    take: 500, // hard cap — should be plenty for current scale
  });

  if (activeUsers.length === 0) return;

  // Load timezones for all active users from UserMemory
  const memoryRecords = await prisma.userMemory.findMany({
    where: { userId: { in: activeUsers.map(u => u.id) } },
    select: { userId: true, facts: true },
  });
  const timezoneMap = new Map<string, string>();
  for (const mem of memoryRecords) {
    const facts = (mem.facts as Record<string, string>) || {};
    if (facts.timezone) timezoneMap.set(mem.userId, facts.timezone);
  }

  // ── Phase 1: Ensure every active user has SOME cached news ──────────────
  // This catches users whose cache expired between target hours, or after a
  // deploy/restart where Redis was cleared. Also proactively refreshes caches
  // with less than 2 hours remaining TTL so they never actually expire while
  // a user might be using the app. Without this, users see "Your news is being
  // prepared" loading state until the next target hour window.
  //
  // Performance: batch TTL checks using Redis pipeline instead of O(n) sequential
  // round-trips. With 500 users, this reduces from 500 sequential Redis calls to
  // a single pipelined request (~1-2ms total instead of ~50-100ms).
  const PROACTIVE_REFRESH_THRESHOLD = 2 * 60 * 60; // refresh if < 2h TTL remaining
  const usersWithoutCache: string[] = [];
  try {
    const pipeline = redisClient.multi();
    for (const user of activeUsers) {
      pipeline.ttl(NEWS_CACHE_KEY(user.id));
    }
    const ttlResults = await pipeline.exec();
    for (let i = 0; i < activeUsers.length; i++) {
      const ttl = ttlResults[i] as number | null;
      if (ttl === null || ttl === undefined) continue; // pipeline error for this key
      // ttl = -2 means key doesn't exist, -1 means no expiry, >= 0 means seconds remaining
      if (ttl === -2 || (ttl >= 0 && ttl < PROACTIVE_REFRESH_THRESHOLD)) {
        usersWithoutCache.push(activeUsers[i].id);
      }
    }
  } catch {
    // Redis pipeline error — fall back to sequential checks (rare)
    for (const user of activeUsers) {
      try {
        const ttl = await redisClient.ttl(NEWS_CACHE_KEY(user.id));
        if (ttl === -2 || (ttl >= 0 && ttl < PROACTIVE_REFRESH_THRESHOLD)) {
          usersWithoutCache.push(user.id);
        }
      } catch { /* skip */ }
    }
  }

  if (usersWithoutCache.length > 0) {
    logger.info(`news.service: scheduler — ${usersWithoutCache.length} active users need news refresh (missing or expiring soon), pre-fetching now`);
    for (let i = 0; i < usersWithoutCache.length; i += BATCH_SIZE) {
      const batch = usersWithoutCache.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(userId => prefetchNewsForUser(userId)));
      if (i + BATCH_SIZE < usersWithoutCache.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
      }
    }
  }

  // ── Phase 2: Target-hour refresh (existing logic) ───────────────────────
  // Determine which users are due for a news refresh at their local target hour
  const usersToRefresh: string[] = [];

  for (const user of activeUsers) {
    // Skip users we just pre-fetched in Phase 1
    if (usersWithoutCache.includes(user.id)) continue;

    const timezone = timezoneMap.get(user.id) || 'UTC';
    const localHour   = getLocalHour(timezone);
    const localMinute = getLocalMinute(timezone);

    // Is this a target hour within the first WINDOW_MINUTES minutes?
    const isTargetTime = TARGET_HOURS.includes(localHour) && localMinute < WINDOW_MINUTES;
    if (!isTargetTime) continue;

    // Has this user already been scheduled in this window?
    try {
      const alreadyScheduled = await redisClient.get(NEWS_SCHEDULED_KEY(user.id));
      if (alreadyScheduled) continue;
    } catch {
      // Redis error — skip this user
      continue;
    }

    usersToRefresh.push(user.id);
  }

  if (usersToRefresh.length > 0) {
    logger.info(`news.service: scheduler tick — refreshing news for ${usersToRefresh.length} users (target hour)`);

    // Mark them as scheduled BEFORE fetching (prevents duplicate runs if tick overlaps)
    for (const userId of usersToRefresh) {
      try {
        await redisClient.setEx(NEWS_SCHEDULED_KEY(userId), NEWS_SCHEDULED_TTL, '1');
      } catch { /* non-critical */ }
    }

    // Process in batches to avoid overloading OpenAI
    for (let i = 0; i < usersToRefresh.length; i += BATCH_SIZE) {
      const batch = usersToRefresh.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(userId => prefetchNewsForUser(userId)));

      // Delay between batches (skip delay after last batch)
      if (i + BATCH_SIZE < usersToRefresh.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
      }
    }
  }

  const totalRefreshed = usersWithoutCache.length + usersToRefresh.length;
  if (totalRefreshed > 0) {
    // 2026-05-28: Circuit breaker tracking — check if ALL prefetches in this
    // tick returned 0 headlines (indicating OpenAI is down/failing for everyone).
    // We check a sample of caches to determine if any succeeded.
    let anySuccess = false;
    for (const uid of [...usersWithoutCache.slice(0, 3), ...usersToRefresh.slice(0, 3)]) {
      try {
        const cached = await redisClient.get(NEWS_CACHE_KEY(uid));
        if (cached) { anySuccess = true; break; }
      } catch { /* skip */ }
    }

    if (anySuccess) {
      _schedulerFailCount = 0; // Reset on any success
    } else {
      _schedulerFailCount++;
      if (_schedulerFailCount >= SCHEDULER_CB_THRESHOLD) {
        _schedulerCBOpenUntil = Date.now() + SCHEDULER_CB_COOLDOWN_MS;
        logger.warn(`news.service: scheduler circuit breaker OPEN — ${_schedulerFailCount} consecutive all-fail ticks, pausing for ${SCHEDULER_CB_COOLDOWN_MS / 60000} min`, { source: 'news' });
      }
    }

    const elapsed = Date.now() - tickStart;
    logger.info(`news.service: scheduler tick complete — refreshed ${totalRefreshed} users in ${elapsed}ms`);
  }
  } finally {
    // Release the tick lock so the next scheduled tick (this or another instance) can run.
    try { await redisClient.del(SCHEDULER_TICK_LOCK_KEY); } catch { /* TTL will expire it */ }
  }
}

/**
 * Durable cron (Phase 3): ONE news sweep — the unit the worker's DB cron
 * claims and fires (every 15 min). The Redis-NX tick lock inside stays: it
 * protects the deploy overlap where old-color web (in-process scheduler) and
 * the new worker coexist for a few minutes.
 */
export async function runNewsSweepOnce(): Promise<void> {
  return runSchedulerTick();
}

// ── Fetch-level circuit breaker ────────────────────────────────────────────────
// 2026-06-27: The scheduler CB above guards the *tick* loop, but a single
// fetchNewsHeadlines() call still runs the full 45s primary + up to 35s LLM-reformat
// pipeline before giving up — even during the daily ~6am UTC provider maintenance
// window when every attempt is doomed. Production logs show the "could not extract
// JSON array" warning 10+ times/day (Jun 20-26), each preceded by ~80s of wasted
// latency that blocks the prefetch batch. This breaker short-circuits to the fallback
// cache after consecutive whole-fetch failures (4 since 2026-06-28), skipping the doomed provider calls
// until the window clears (cooldown ladder — 3 min at the first open, escalating
// while the outage persists; see FETCH_CB_COOLDOWN_STEPS_MS), then probes again on
// the next call.
// 2026-06-28: Raised 2 → 4. With BATCH_SIZE=3 parallel prefetches, a threshold of 2
// meant two unlucky failures inside a SINGLE batch (e.g. two users' fetches both
// hitting a transient provider blip) tripped the GLOBAL breaker and starved every
// other user of fresh news for the full cooldown. The breaker should fire on a
// *sustained* outage, not normal provider variance within one concurrent batch — 4
// requires the failure to persist across more than a single BATCH_SIZE=3 window.
const FETCH_CB_THRESHOLD = 4;                 // consecutive whole-fetch failures to trip
// 2026-10-12 (ticket 1105650b): the flat 3-min cooldown re-armed a full doomed
// SERP + formatter pipeline every 3 minutes through a SUSTAINED outage — during
// the post-breach key-rotation window (2026-10-12 05:26–07:35Z, BOTH utility-LLM
// legs answering HTTP 401 on dead keys) this breaker opened 10 times in ~7h,
// each cycle re-paying the BrightData SERP queries + utility-LLM calls for a
// formatter that provably could not answer. Escalate the cooldown per
// consecutive open without an intervening healthy fetch — 3 → 10 → 30 min
// (mirrors UTILITY_OVERRIDE_BACKOFF_STEPS_MS, FO firing 47). The FIRST open
// keeps the historical 3-min "typical maintenance window" behavior, so a
// transient blip still recovers just as fast; only persistence escalates. The
// ladder resets on the first healthy fetch (recordFetchSuccess).
const FETCH_CB_COOLDOWN_STEPS_MS = [3 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];
let _fetchCBOpenRung = 0;                     // consecutive opens with no healthy fetch between them
// 2026-06-29: A pure count is fooled by concurrency. With BATCH_SIZE=3, three parallel
// prefetches start at ~the same instant and can all fail within one ~45s window, so the
// "consecutive failure" count jumps by 3 from a SINGLE transient blip — one more failure
// then trips the global breaker and starves every user of fresh news for the cooldown.
// Require the failure streak to also SPAN a minimum wall-clock duration before tripping:
// a single concurrent batch resolves well within this window, so only a genuinely
// *sustained* outage (failures persisting across more than one batch's lifetime) trips it.
const FETCH_CB_MIN_SPAN_MS = 60 * 1000;       // streak must persist ≥60s (longer than one BATCH_SIZE=3 window)
let _fetchFailStreak = 0;
let _fetchFailStreakStartedAt = 0;            // timestamp of the first failure in the current streak
let _fetchCBOpenUntil = 0;
let _fetchLastFailReason = '';                // pipeline stage of the most recent whole-fetch failure (fe661565)

function isFetchCircuitOpen(): boolean {
  if (_fetchCBOpenUntil === 0) return false;
  if (Date.now() >= _fetchCBOpenUntil) {
    _fetchCBOpenUntil = 0;
    _fetchFailStreak = 0;
    _fetchFailStreakStartedAt = 0;
    logger.info('news.service: fetch circuit breaker CLOSED — probing the fetch pipeline again');
    return false;
  }
  return true;
}

/**
 * The success half of the fetch breaker — and, since ticket ebc81863, the
 * OBSERVABLE half.
 *
 * Before: a healthy fetch silently zeroed the streak. That made the two
 * diagnoses of a breaker that never tripped server the IDENTICAL log store:
 *   "the trip predicate genuinely never saw 4 failures in 60s" (healthy), and
 *   "the pipeline was degraded-but-alive — an occasional success kept
 *   resetting the streak" (the class that never pages, because only the OPEN
 *   path files a ticket).
 * The natural-expiry close in isFetchCircuitOpen() already logs CLOSED; this
 * was the asymmetric, silent side.
 *
 * Now: when (and only when) a NON-ZERO streak is being discarded, emit ONE
 * line naming the discarded streak + span, plus ONE loop_metrics row
 * (news_fetch_breaker_reset) so `loop_metric_count` can read the class without
 * log access. A healthy pipeline (streak 0) stays silent — this is a reset
 * event, not a per-fetch counter.
 *
 * NO behaviour change: the stream/cooldown/ticket state resets exactly as
 * before, and the emit is wrapped so telemetry can never break a fetch.
 *
 * logHandled (info, logClass:'handled') on purpose — a reset is an EXPECTED,
 * handled outcome (log taxonomy, utils/log-level.ts): it must not become a
 * warn row the hourly log-signal sweep fingers as an internal fault (the
 * a800a12d family's lesson).
 */
function recordFetchSuccess(): void {
  // Capture the discarded streak BEFORE clearing it.
  const discardedStreak = _fetchFailStreak;
  const discardedSpanMs = discardedStreak > 0 && _fetchFailStreakStartedAt > 0
    ? Math.max(0, Date.now() - _fetchFailStreakStartedAt)
    : 0;

  _fetchFailStreak = 0;
  _fetchFailStreakStartedAt = 0;
  _fetchCBOpenUntil = 0;
  _fetchLastFailReason = '';
  _fetchCBOpenRung = 0; // a healthy fetch — any future outage starts the cooldown ladder over

  // Streak 0 = the ordinary healthy path (and also the post-CLOSED probe: the
  // natural-expiry close already zeroed the streak AND logged CLOSED, so there
  // is nothing silently discarded and no second line to add). Stay silent —
  // no per-fetch log spam; the reset is evidence only when a streak existed.
  if (discardedStreak === 0) return;

  const spanSec = Math.round(discardedSpanMs / 1000);
  try {
    logHandled(
      `news.service: fetch breaker streak reset by a healthy fetch (was ${discardedStreak} failure${discardedStreak === 1 ? '' : 's'} over ${spanSec}s) — degraded-but-alive pipeline, not a trip`,
      { source: 'news' },
    );
  } catch { /* telemetry must never break a fetch */ }
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.NEWS_FETCH_BREAKER_RESET,
      value: discardedStreak,
      unit: 'failures',
      meta: { streak: discardedStreak, spanMs: discardedSpanMs, source: 'news' },
    });
  } catch { /* telemetry must never break a fetch */ }
}

/** Exported for the fe661565 breaker-ticket replay test (module-internal otherwise). */
export function recordFetchFailure(reason?: string): void {
  const now = Date.now();
  if (_fetchFailStreak === 0) _fetchFailStreakStartedAt = now;
  _fetchFailStreak++;
  if (reason) _fetchLastFailReason = reason;
  const streakSpanMs = now - _fetchFailStreakStartedAt;
  if (
    _fetchFailStreak >= FETCH_CB_THRESHOLD &&
    streakSpanMs >= FETCH_CB_MIN_SPAN_MS &&
    _fetchCBOpenUntil === 0
  ) {
    // 1105650b: escalate the cooldown per consecutive open (3 → 10 → 30 min,
    // capped). Every re-open without an intervening healthy fetch means the
    // previous cooldown's probe re-ran the FULL paid SERP + formatter pipeline
    // and failed again — the outage is sustained, not a transient window.
    const cooldownMs = FETCH_CB_COOLDOWN_STEPS_MS[Math.min(_fetchCBOpenRung, FETCH_CB_COOLDOWN_STEPS_MS.length - 1)];
    _fetchCBOpenRung++;
    _fetchCBOpenUntil = now + cooldownMs;
    const rungDisplay = Math.min(_fetchCBOpenRung, FETCH_CB_COOLDOWN_STEPS_MS.length);
    logger.warn(`news.service: fetch circuit breaker OPEN (rung ${rungDisplay}${_fetchCBOpenRung > rungDisplay ? `, consecutive open #${_fetchCBOpenRung}` : ''}) — ${_fetchFailStreak} fetch failures over ${Math.round(streakSpanMs / 1000)}s, serving fallback cache for ${cooldownMs / 60000} min`, { source: 'news' });
    // Ticket fe661565: this breaker opening IS the user-visible outage (the
    // news card degrades for every user for the full cooldown) — yet nothing
    // filed a ticket for it: the utility-LLM outage alarm only counts dual-LLM
    // TOTAL failures, and a formatter answer of "[]" counts as LLM success.
    // File ONE deduped mishap ticket (stable title → repeats bump occurrences).
    // 1105650b: thread the utility-LLM health snapshot into the ticket too —
    // the 2026-10-12 incident's lastReason was a bare "llm_empty" while the
    // actual cause (BOTH provider legs 401 on dead rotated keys) lived only in
    // app_error_logs; the snapshot puts the provider-leg state on the ticket
    // itself so triage does not need log access to see a provider outage.
    // Best-effort: a throwing snapshot must NEVER break the breaker trip or the
    // ticket (pinned in news-fetch-breaker.1105650b.test.ts).
    const lastReason = _fetchLastFailReason || 'unknown';
    let utilityHealth: { summary: string; detail: any };
    try {
      utilityHealth = utilityLLMHealthSnapshot();
    } catch {
      utilityHealth = { summary: 'unavailable (snapshot threw — non-fatal)', detail: { snapshotError: true } };
    }
    void import('./feedback/feedback.service')
      .then((m) => m.fileFeedbackTicket({
        userId: null,
        type: 'mishap',
        title: 'News pipeline outage auto-detected: fetch circuit breaker open (sustained headline-fetch failures)',
        description: [
          'The news headline fetch circuit breaker just OPENED — every user news card serves the degraded/fallback state for the full cooldown window. Filed automatically by news.service (fe661565: until now this failure mode surfaced to no one).',
          '',
          `Failure streak: ${_fetchFailStreak} whole-fetch failures spanning ${Math.round(streakSpanMs / 1000)}s (threshold ${FETCH_CB_THRESHOLD} over >=${FETCH_CB_MIN_SPAN_MS / 1000}s). Cooldown: ${cooldownMs / 60000} min (open #${_fetchCBOpenRung}, rung ${rungDisplay} of ${FETCH_CB_COOLDOWN_STEPS_MS.length} — escalates while the outage persists, reset by a healthy fetch). Host pid ${process.pid}.`,
          `Last failure stage: ${lastReason}.`,
          '',
          `Utility-LLM health at trip time (1105650b — the formatter legs): ${utilityHealth.summary}`,
          '',
          'History: the 2026-09-11 outage was the formatter model answering the escape-hatch "[]" for hours while SERP fetches were healthy — the brd_json payload leads with metadata/navigation/base64 chrome and the 5000-char per-block cap severed the organic results. A repeat of this ticket means whole-fetch failures are sustained again (dedup bumps occurrences).',
        ].join('\n'),
        priority: 3,
        area: 'crossmodel',
        context: { class: 'news_fetch_breaker', streak: _fetchFailStreak, spanMs: streakSpanMs, lastReason, cooldownMs, cooldownRung: _fetchCBOpenRung, utilityLLM: utilityHealth.detail, filedAt: new Date().toISOString() },
      }))
      .catch(() => { /* ticket filing is best-effort — the breaker + degraded card stand regardless */ });
  }
}

/** Record a whole-fetch failure (tripping the breaker if needed) and return the fallback cache. */
async function recordFetchFailureAndFallback(reason?: string): Promise<any[]> {
  recordFetchFailure(reason);
  return await getNewsFallbackCache();
}

/**
 * Read-side of the fetch circuit breaker for the GET /news controller: true
 * while a sustained provider outage has the breaker open (≥4 whole-fetch
 * failures spanning ≥60s; cooldown starts at 3 min and escalates while the
 * outage persists — see FETCH_CB_COOLDOWN_STEPS_MS). Surfaced as `degraded:
 * true` so the home news card switches to its honest unavailable state
 * (ticket d86cf931).
 * Uses the same isFetchCircuitOpen() check fetchNewsHeadlines() makes — a
 * naturally-expired cooldown closes on read exactly as it would on the next
 * fetch.
 */
export function isNewsFetchCircuitOpen(): boolean {
  return isFetchCircuitOpen();
}

/** TEST-ONLY: reset the module-level fetch-breaker state so unit tests stay order-independent. */
export function __resetNewsFetchBreakerForTests(): void {
  _fetchFailStreak = 0;
  _fetchFailStreakStartedAt = 0;
  _fetchCBOpenUntil = 0;
  _fetchLastFailReason = '';
  _fetchCBOpenRung = 0;
}

// ── LLM-reformat leg gate ─────────────────────────────────────────────────────
// 2026-08-05 nightly self-audit: prod telemetry shows the Strategy-5 LLM-reformat
// leg succeeding ~5/935 times in 48h (~0.5%), while every attempt costs a 30–60s
// utilityChat call on the same provider pool whose failures forced the fallback
// in the first place. After REFORMAT_FAIL_GATE consecutive failures the leg is
// skipped for REFORMAT_GATE_COOLDOWN_MS; the first event after the cooldown
// probes again (half-open) — a success resets the streak, a failure re-gates.
// Gated events degrade straight to the fallback cache, which is where ~99.5% of
// them ended up anyway — minus the provider timeouts.
const REFORMAT_FAIL_GATE = 8;
const REFORMAT_GATE_COOLDOWN_MS = 30 * 60 * 1000;
// Deliberately no min-span guard (unlike the fetch breaker's FETCH_CB_MIN_SPAN_MS):
// with a ~0.5% historical success rate, rapid tripping on a burst of 8 failures is
// fine — the blast radius is a few skipped near-futile calls during a 30-min window.
let _reformatFailStreak = 0;
let _reformatGatedUntil = 0;

function recordReformatOutcome(success: boolean): void {
  if (success) {
    _reformatFailStreak = 0;
    _reformatGatedUntil = 0;
    return;
  }
  _reformatFailStreak++;
  if (_reformatFailStreak >= REFORMAT_FAIL_GATE && Date.now() >= _reformatGatedUntil) {
    _reformatGatedUntil = Date.now() + REFORMAT_GATE_COOLDOWN_MS;
    logger.warn(`news.service: LLM reformat leg GATED after ${_reformatFailStreak} consecutive failures — skipping it for ${REFORMAT_GATE_COOLDOWN_MS / 60000} min`, { source: 'news' });
  }
}

/** TEST-ONLY: reset the module-level reformat-gate state so unit tests stay order-independent. */
export function __resetNewsReformatGateForTests(): void {
  _reformatFailStreak = 0;
  _reformatGatedUntil = 0;
}

// ── Core News Fetcher (shared between scheduler and on-demand) ────────────────
// 2026-07-12 (Paul): background tasks must run on DeepSeek V4 Flash or Qwen 3.6
// only — NO OpenAI. The old gpt-5.4-mini + built-in web_search call is replaced
// with the codebase's standard open-source pattern: BrightData MCP SERP queries
// for live grounding (parallel, bounded), then utilityChat (DeepSeek V4 Flash
// primary → Qwen 3.6 27B DashScope fallback) formats the results into the
// 20-headline JSON briefing. Everything downstream (extraction strategies, junk
// filter, MIN gate, circuit breaker, fallback cache) is unchanged.
const NEWS_JSON_INSTRUCTIONS = 'You are a JSON API. You ONLY output valid JSON arrays. Never output prose, explanations, or markdown. If you cannot complete the task, output an empty array: []';

// Per-attempt SERP budget for background news fetches. Normal BrightData SERP
// latency is ~20s; 30s ×3 internal retries + backoff ≈ 96s worst per query,
// which keeps the whole fetch inside NEWS_FETCHING_TTL (see sizing note above).
const NEWS_SERP_TIMEOUT_MS = 30_000;
// Skip the prefetch-level retry when the first pass already burned this much of
// the fetch lock — the retry would outlive the dedup window.
const NEWS_RETRY_DEADLINE_MS = 120_000;
// The global fallback key is every user's outage briefing — only near-complete
// results may overwrite it. A 5-14 item briefing is healthy enough to cache for
// the ONE user it was fetched for, but must not replace a fuller fallback (a
// truncation-repaired 6-8 item set silently degrading everyone was a confirmed
// review finding).
const NEWS_FALLBACK_MIN_HEADLINES = 15;
// Shared SERP cache: the generic queries ("top US news headlines today …") are
// byte-identical for every user in a refresh window; without a cache each of
// 500 users pays for their own copy (~4k redundant paid SERP calls/day).
// 2026-07-13: Key on a fixed-length SHA-256 digest instead of base64url(query).
// base64url grows unbounded with the query length (a long personalized topic
// query produced a multi-KB Redis key — wasteful to store/transmit and slower to
// look up). A 16-byte (32 hex char) SHA-256 prefix is collision-safe for this
// cache's key space and keeps every key a constant, compact size.
const NEWS_SERP_CACHE_KEY = (query: string) =>
  `news:serp:${createHash('sha256').update(query).digest('hex').slice(0, 32)}`;
const NEWS_SERP_CACHE_TTL = 15 * 60;

/** SERP with a cluster-shared 15-min cache. Personalized queries hit too (keyed by full query) — harmless, they just dedupe repeat fetches for the same user/topic. */
async function searchNewsSerpCached(query: string): Promise<string> {
  const key = NEWS_SERP_CACHE_KEY(query);
  try {
    const hit = await redisClient.get(key);
    if (hit) return hit;
  } catch { /* cache miss on Redis error */ }
  const result = await searchWithBrightData(query, 'google', undefined, NEWS_SERP_TIMEOUT_MS);
  if (result) {
    try { await redisClient.setEx(key, NEWS_SERP_CACHE_TTL, result); } catch { /* non-critical */ }
  }
  return result;
}

/**
 * Ticket fe661565 (2026-09-11): BrightData's brd_json SERP payload opens with
 * ~2-5k chars of chrome — {"general","input","navigation":[…]} plus embedded
 * base64 images — and the 5000-char per-block cap severed the payload BEFORE
 * the organic results: the formatter model saw metadata chrome, correctly
 * judged "no usable stories", and answered the escape-hatch [] for HOURS
 * (counted as LLM "success", so no alarm fired). Extract the organic/news
 * results deterministically and render compact lines the model can use; on
 * any parse surprise return the raw text unchanged (status quo ante — never
 * make the prompt worse than before).
 */
export function extractSerpOrganicForPrompt(raw: string): string {
  const jsonStart = raw.indexOf('{');
  if (jsonStart < 0) return raw;
  let parsed: any;
  try { parsed = JSON.parse(raw.slice(jsonStart)); } catch { return raw; }
  const organic: any[] = Array.isArray(parsed?.organic) ? parsed.organic : [];
  const newsItems: any[] = Array.isArray(parsed?.news) ? parsed.news : [];
  if (organic.length === 0 && newsItems.length === 0) return raw;
  const lines: string[] = [];
  const pushItem = (item: any) => {
    const title = String(item?.title || '').trim();
    if (!title) return;
    const link = String(item?.link || item?.url || '');
    let domain = '';
    try { domain = new URL(link).hostname.replace(/^www\./, ''); } catch { /* no usable domain */ }
    const date = String(item?.date || item?.age || '').trim();
    const snippet = String(item?.description || item?.snippet || '').trim().replace(/\s+/g, ' ').slice(0, 300);
    lines.push(`- ${title}${domain ? ` (${domain})` : ''}${date ? ` — ${date}` : ''}${snippet ? `\n  ${snippet}` : ''}`);
  };
  for (const item of newsItems.slice(0, 8)) pushItem(item);
  for (const item of organic.slice(0, 12)) pushItem(item);
  if (lines.length === 0) return raw;
  return lines.join('\n').slice(0, 4500);
}

/**
 * Provenance of a fetchNewsHeadlines() result — ticket 4888d891.
 *
 * The shared outage fallback (`news:headlines:fallback`) holds ANOTHER user's
 * briefing, served only because OUR fetch failed. Its item count says nothing
 * about whether WE succeeded, so a caller that gates on `headlines.length`
 * alone cannot tell a genuine briefing from outage content — the caller
 * therefore has to be told which one it got.
 *
 *   'fetch'    — the formatter produced this briefing; safe to cache as ours
 *   'fallback' — our fetch FAILED and we served the shared outage fallback
 *   'none'     — nothing could be produced (no LLM, no SERP, no fallback)
 *
 * Optional so every existing caller/test keeps its `any[]` contract.
 */
export interface NewsFetchOutcome {
  source: 'fetch' | 'fallback' | 'none';
}

export async function fetchNewsHeadlines(
  location: string,
  interests: string,
  occupation: string,
  recentTopics: string[],
  outcome?: NewsFetchOutcome
): Promise<any[]> {
  if (outcome) outcome.source = 'none';
  if (!isUtilityLLMAvailable()) {
    logger.error('news.service: no utility LLM configured (DEEPSEEK_API_KEY / DASHSCOPE_API_KEY not set)');
    return [];
  }

  // During a sustained provider outage, skip the doomed search+format pipeline
  // entirely and serve the last good headlines immediately.
  if (isFetchCircuitOpen()) {
    logger.info('news.service: fetch circuit breaker OPEN — serving fallback cache without fetching');
    if (outcome) outcome.source = 'fallback';
    return await getNewsFallbackCache();
  }

  // Every whole-fetch failure ends by serving the shared outage fallback —
  // tag the provenance so the caller never mistakes it for OUR briefing.
  const failToFallback = async (reason?: string): Promise<any[]> => {
    if (outcome) outcome.source = 'fallback';
    return recordFetchFailureAndFallback(reason);
  };

  const now = new Date();
  const today = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const shortDate = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const ctx = [
    location   ? `User location: ${location}`   : '',
    interests  ? `User interests: ${interests}`  : '',
    occupation ? `User occupation: ${occupation}` : '',
    recentTopics.length > 0 ? `Recent topics: ${recentTopics.slice(0, 6).join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const locReq = location
    ? `- 1-2 headlines: LOCAL news relevant to "${location}" (category: "local")`
    : '- 1-2 headlines: notable WORLD news (category: "local")';

  const intReq = interests || recentTopics.length > 0
    ? `- Interest headlines MUST genuinely relate to: ${[interests, ...recentTopics.slice(0, 3)].filter(Boolean).join(', ')} — if the search results contain nothing relevant to these, return FEWER interest stories rather than padding with unrelated trending news`
    : '- For interest headlines, use trending tech, science, or culture stories';

  // ── Step 1: live grounding — parallel BrightData SERP queries (bounded at 5) ──
  // Utility models have no built-in web search, so freshness comes from injecting
  // SERP results. Each query maps to a briefing section: US, local/world, interests.
  // 2026-08-31: every query carries Google's after: freshness operator. SERP
  // indexes are full of dated SEO roundup pages ("Top U.S. & World Headlines —
  // July 31, 2026") that match the "today" keywords for weeks; the model parrots
  // those page titles as stories (confirmed on Paul's live briefing). after:
  // cuts stale results at the source; the prompt rules + deterministic gates
  // below handle what slips through.
  const afterDate = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const queries: string[] = [
    `top US news headlines today ${shortDate} after:${afterDate}`,
    location ? `${location} local news today after:${afterDate}` : `world news headlines today ${shortDate} after:${afterDate}`,
  ];
  // 2026-08-31: split free-text interests ("AI, hockey, real estate") into
  // INDIVIDUAL seed queries — one comma-joined mega-query matches nothing well
  // and pushes the model to pad the "For you" section with generic trending.
  const interestSeeds = [
    ...String(interests || '').split(/[,;•|/]+/).map(s => s.trim()).filter(s => s.length > 1),
    ...recentTopics.map(s => String(s || '').trim()).filter(Boolean),
  ].filter((s, i, arr) => arr.findIndex(x => x.toLowerCase() === s.toLowerCase()) === i);
  for (const seed of interestSeeds.slice(0, 3)) {
    queries.push(`${seed.substring(0, 80)} news today after:${afterDate}`);
  }
  if (interestSeeds.length === 0 && String(occupation || '').trim()) {
    // Occupation is a weaker reader signal than declared interests — use it
    // only when nothing better exists.
    queries.push(`${occupation.substring(0, 60)} industry news today after:${afterDate}`);
  } else if (interestSeeds.length === 0) {
    // No interest signals: the "interest" section still needs material beyond
    // the two US/world SERPs, or the model faces count pressure to invent.
    queries.push(`trending technology science and culture news today ${shortDate} after:${afterDate}`);
  }

  const settled = await Promise.allSettled(queries.map(q => searchNewsSerpCached(q)));
  const searchBlocks: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      // fe661565: extract organic results from the brd_json chrome FIRST — the
      // raw payload's first ~5k chars are metadata/navigation/base64, so capping
      // raw text starved the formatter of actual stories (→ "[]" for hours).
      // Cap after extraction so 5 queries stay within the utility model's context.
      searchBlocks.push(`--- Search ${i + 1}: "${queries[i]}" ---\n${extractSerpOrganicForPrompt(r.value).substring(0, 5000)}`);
    }
  });

  if (searchBlocks.length === 0) {
    logger.warn('news.service: all BrightData news searches returned empty — trying fallback cache', { source: 'news' });
    return await failToFallback('search_empty: all SERP calls returned empty');
  }
  const searchContext = searchBlocks.join('\n\n');

  const prompt = `Today is ${today}.

${ctx || 'No specific user context available.'}

Below are LIVE web search results fetched moments ago. Using ONLY stories found in these results, produce UP TO 20 news headlines — as many DISTINCT real stories as the results genuinely support.

OUTPUT FORMAT — CRITICAL:
You MUST respond with ONLY a raw JSON array. No prose, no explanation, no markdown, no code fences.
Your entire response must start with [ and end with ].
Each element: {"headline":"...","summary":"1-2 sentence summary","category":"local"|"us"|"interest","chatPrompt":"Natural question to learn more","published":"the story's publication date or age EXACTLY as the matching search result labels it (e.g. \"3 hours ago\", \"Oct 28, 2021\", \"2 days ago\") — omit the field or use \"\" ONLY if no result shows a date for the story. NEVER guess or invent a date."}

CONTENT RULES:
${locReq}
- Aim for 5-6 TOP US news headlines (category: "us")
- Aim for 8-12 headlines tailored to user interests/topics (category: "interest")
${intReq}
- FRESHNESS IS CRITICAL: today is ${today}. The search results below contain OLD pages — dated roundups and SEO pages from days or weeks ago that merely rank for today's keywords. Use ONLY stories that are genuinely from the last ~48 hours; if a result's story is clearly older, ignore it.
- PUBLISHED DATES: every search result below is labeled with its publication date or age (e.g. "— 3 hours ago"). Copy that label into "published" VERBATIM for the story you take it from — it is shown to the reader next to the headline. A result with NO date label gets "published": "". Never fabricate, estimate, or reformat a date.
- Each headline must be ONE specific story (a concrete subject and event). NEVER output aggregator, roundup, or hub page titles such as "Top U.S. & World Headlines — <date>", "Morning Digest", or "News roundup" — those are page titles, not stories.
- Base every headline on a real story present in the search results below — NEVER invent or pad. If the results only contain 12 distinct real stories, return 12. Fewer real stories always beat padded ones.
- NEVER output almanac or calendar trivia (e.g. "Nth day of the year", "today in history") — real news stories only
- chatPrompt: a natural conversational question about the story
- Summaries: 1-2 sentences max
- Each headline must be UNIQUE — no duplicate stories, no near-duplicates of the same story reworded

[LIVE SEARCH RESULTS]
${searchContext}

REMEMBER: Your ENTIRE response must be a valid JSON array. Start with [ and end with ]. Nothing else.`;

  // ── Step 2: format via the utility stack (DeepSeek V4 Flash → Qwen fallback) ──
  // utilityChat handles its own retries + provider fallback and returns '' on
  // total failure (it never throws). contentOnly so DeepSeek's reasoning tokens
  // can never be mistaken for the JSON payload. maxTokens 8000: DeepSeek counts
  // reasoning_content AGAINST max_tokens before emitting content, and a 20-item
  // JSON is ~2-2.6k tokens on its own — 4000 risked mid-array truncation that
  // reads as a parse failure (confirmed review finding).
  const content = await utilityChat(
    [
      { role: 'system', content: NEWS_JSON_INSTRUCTIONS },
      { role: 'user', content: prompt },
    ],
    { maxTokens: 8000, temperature: 0.2, timeout: 60000, contentOnly: true, retryNotFound: true }
  );

  if (!content) {
    logger.warn('news.service: utility LLM returned empty content for news formatting', { source: 'news' });
    return await failToFallback('llm_empty: formatter returned empty content');
  }

  logger.info(`news.service: response length=${content.length} preview="${content.substring(0, 80)}"`);

  try {
    let arr: any[] = [];

    // Strategy 1: direct parse after stripping code fences
    const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
    try { arr = JSON.parse(cleaned); } catch { /* try next */ }

    // Strategy 2: find first '[' and last ']' — most reliable bracket extraction
    // (moved before regex to avoid the lazy/greedy regex matching partial arrays)
    if (!Array.isArray(arr) || arr.length === 0) {
      const start = content.indexOf('[');
      const end   = content.lastIndexOf(']');
      if (start !== -1 && end > start) {
        try { arr = JSON.parse(content.substring(start, end + 1)); } catch { /* try next */ }
      }
    }

    // Strategy 3: regex extract — balanced bracket search for first complete JSON array
    if (!Array.isArray(arr) || arr.length === 0) {
      const match = content.match(/\[[\s\S]*\]/);
      if (match) { try { arr = JSON.parse(match[0]); } catch { /* try next */ } }
    }

    // Strategy 4: deterministic tolerant repair (#89) — fix the common LLM JSON
    // defects (trailing commas, single-quoted strings, unquoted keys, JSON5
    // comments, zero-width chars) on the bracket span and strict-parse again.
    // Runs BEFORE the slow LLM-reformat leg: prod telemetry (~39 warns/48h)
    // shows strict parses dying on exactly these shapes, and the reformat leg
    // depends on the same utility providers that periodically time out.
    if (!Array.isArray(arr) || arr.length === 0) {
      const tStart = content.indexOf('[');
      const tEnd   = content.lastIndexOf(']');
      const span = tStart !== -1 && tEnd > tStart ? content.substring(tStart, tEnd + 1) : cleaned;
      try {
        const repaired = JSON.parse(repairCommonLlmJsonDefects(span));
        if (Array.isArray(repaired) && repaired.length > 0) {
          arr = repaired;
          logger.info(`news.service: tolerant-repair strategy succeeded (${arr.length} items)`);
        }
      } catch { /* try next */ }
    }

    // Strategy 5: LLM reformat — a second utility call. If the first response has
    // JSON-ish fragments, extract/repair them; otherwise regenerate from the SAME
    // live search context. The regenerate is deliberately PERTURBED (different
    // framing + temperature 0.7) — a byte-identical replay at temp 0.2 mostly
    // reproduces the same failure (confirmed review finding).
    // Skipped entirely while the reformat gate is open (see recordReformatOutcome).
    let reformatGatedThisEvent = false;
    if (!Array.isArray(arr) || arr.length === 0) {
      if (Date.now() < _reformatGatedUntil) {
        reformatGatedThisEvent = true;
        logger.info(`news.service: LLM reformat leg gated after ${_reformatFailStreak} consecutive failures — skipping straight to the fallback cache`);
      } else {
        // Log-signal family a800a12d (ticket d1be4f9e, 2026-11-01): the
        // designed reformat leg announcing itself before it runs is ladder
        // PROGRESS, not a fault — 17 of 18 live events recovered on this same
        // leg, and the one that did NOT escalate lands on the line-1741 warn
        // below (which stays a warn: total extraction failure really is a
        // degraded state). At untagged warn the sweep read every recovery as a
        // recurring failure class (42 rows / 3 hours at filing). Message text
        // UNCHANGED (greps + the sweep's messagePattern keep matching); the
        // reformat health streak/gate (recordReformatOutcome) is untouched.
        logHandled('news.service: first 4 JSON extraction strategies failed — trying LLM reformat', { source: 'news' });
        recordNewsLadderMetric('llm_reformat', 'attempted');
        try {
          const hasJsonLikeContent = content.includes('"headline"') || content.includes('"summary"');
          // Repair path feeds a larger slice than the old 4000 chars — a truncated
          // 20-item payload is ~12-16k chars and clipping it to 4k silently shrank
          // repaired briefings to the first 6-8 items (confirmed review finding).
          const reformatPrompt = hasJsonLikeContent
            ? `The following text contains news headlines but has invalid JSON formatting (it may be truncated mid-array — drop any incomplete trailing object). Extract and reformat into a VALID JSON array. Each object: {"headline":"...","summary":"1-2 sentences","category":"local"|"us"|"interest","chatPrompt":"natural question"}. Return ONLY the raw JSON array — no markdown, no code fences, no explanation. Start with [ and end with ].\n\nText:\n${content.substring(0, 16000)}`
            : `Your previous attempt returned prose instead of JSON. Try again, differently.\n\nFrom the live web search results below, output a JSON array of real news stories (up to 20). Each element: {"headline":"...","summary":"1-2 sentences","category":"local"|"us"|"interest","chatPrompt":"natural question"}. ONLY the raw JSON array — start with [ and end with ]. Never invent stories; fewer real ones beat padded ones.\n\n[LIVE SEARCH RESULTS]\n${searchContext}`;
          const reformatText = await utilityChat(
            [
              { role: 'system', content: NEWS_JSON_INSTRUCTIONS },
              { role: 'user', content: reformatPrompt },
            ],
            { maxTokens: 8000, temperature: hasJsonLikeContent ? 0.2 : 0.7, timeout: hasJsonLikeContent ? 30000 : 60000, contentOnly: true }
          );
          if (reformatText) {
            const reformatCleaned = reformatText.replace(/```json\n?|\n?```/g, '').trim();
            // Try direct parse first, then bracket extraction
            try { arr = JSON.parse(reformatCleaned); } catch {
              const rStart = reformatCleaned.indexOf('[');
              const rEnd = reformatCleaned.lastIndexOf(']');
              if (rStart !== -1 && rEnd > rStart) {
                const rSpan = reformatCleaned.substring(rStart, rEnd + 1);
                try { arr = JSON.parse(rSpan); } catch {
                  // one tolerant-repair attempt before declaring the reformat wasted
                  try { arr = JSON.parse(repairCommonLlmJsonDefects(rSpan)); } catch { /* final fail */ }
                }
              }
            }
            if (Array.isArray(arr) && arr.length > 0) {
              logger.info(`news.service: LLM reformat strategy succeeded (${arr.length} items)`);
            } else {
              // 2026-08-05: this path was silent — the dominant prod failure mode
              // (~99.5% of attempts), invisible until telemetry aggregation.
              logger.info('news.service: LLM reformat returned content that did not parse to a usable JSON array');
            }
          } else {
            logger.info('news.service: LLM reformat returned empty content');
          }
        } catch (reformatErr: any) {
          logger.warn(`news.service: LLM reformat strategy failed: ${reformatErr.message?.substring(0, 80)}`, { source: 'news' });
        }
        recordReformatOutcome(Array.isArray(arr) && arr.length > 0);
      }
    }

    if (!Array.isArray(arr) || arr.length === 0) {
      // Log-signal family a800a12d (tickets b4bfd09a + 359c3a35, 2026-11-01).
      // This is a DEGRADED DEPENDENCY, not an internal fault: the utility
      // formatter leg returned content with no extractable JSON array (the
      // gated wording is the reformat leg's own designed disable, not a second
      // failure). It stays WARN for operator visibility but carries the
      // logClass:'external' tag, which isNonFaultLogRow honours — at untagged
      // warn the hourly sweep read 36 and 28 rows as recurring internal faults
      // and re-filed them every ISO week, forever. Message text is UNCHANGED
      // (greps + the sweep's messagePattern keep matching).
      //
      // SCOPE NOTE (updated 2026-11-01, tickets 359c3a35 + b4bfd09a): the tag
      // stops the SWEEP *and* — since the fix below — the acceptance METRIC.
      // While `app_error_log_count` counted by level+source+message only, every
      // row the sweep had just adjudicated external still counted against this
      // class's own `<= 2 / 24 h` bar, so the post-deploy verifier reopened the
      // ticket every window forever (`<= 2` was unreachable while a DESIGNED
      // external class emitted at all). The probe now takes
      // params.excludeLogClass (feedback/ticket-metric.ts) and the auto-filer
      // default sets it to 'external', making the sweep's drop set and the
      // metric's counted set the same set. Detection is NOT weakened by that:
      // the count is subtractive (total − rows tagged external), so an UNTAGGED
      // warn row and any logClass:'fault' row still count, and the validator
      // refuses any class other than 'external' | 'handled' — a tag can never
      // talk a genuine internal fault out of its own acceptance test. If this
      // row ever needs to count toward a bar again, remove the logExternal tag:
      // the metric follows the tag, it does not override it. The durable
      // escalation is untouched and is the real alarm: failToFallback ->
      // recordFetchFailure -> the fetch circuit breaker -> ONE deduped outage
      // ticket (fe661565). Counted on news_formatter_ladder so the class stays
      // measurable on its own.
      logExternal(`news.service: could not extract JSON array from content (${reformatGatedThisEvent ? '4 strategies failed + LLM reformat gated' : 'all 5 strategies failed'}) — trying fallback cache`, { source: 'news' });
      recordNewsLadderMetric('extract_failed', reformatGatedThisEvent ? 'reformat_gated' : 'all_failed');
      return await failToFallback('extract_failed: no JSON array extractable from formatter output');
    }

    const result = filterBriefingQuality(
      arr
        .filter((h: any) => h.headline && h.summary && h.chatPrompt)
        .map((h: any) => ({
          headline:   String(h.headline).slice(0, 200),
          summary:    String(h.summary).slice(0, 300),
          category:   ['local', 'us', 'interest'].includes(h.category) ? h.category : 'interest',
          chatPrompt: String(h.chatPrompt).slice(0, 300),
          // Ticket 94b93132: the publication label rides through verbatim
          // (useless non-dates collapse to '' — the item displays undated
          // rather than claiming a freshness it cannot show). Items whose
          // label parses to a stale date are dropped by the gate below.
          published:  normalizePublishedLabel(h.published),
        }))
    ).slice(0, 20);

    logger.info(`news.service: parsed ${result.length} usable headlines`);

    // Everything parsed was junk (almanac trivia) or missing required fields.
    if (result.length === 0) {
      logger.warn('news.service: all parsed headlines were filtered as junk/invalid — trying fallback cache', { source: 'news' });
      return await failToFallback('all_junk: parsed headlines filtered as junk/invalid');
    }

    // Degenerate briefing: the model answered, but with too few usable items
    // (e.g. a lone almanac blurb on a sparse search day). Do NOT reset the
    // breaker or write the global fallback. 2026-07-12 review refinements:
    //  - Return the user's OWN thin personalized items rather than swapping in
    //    the global fallback — that key holds ANOTHER user's briefing (their
    //    local + interest headlines) and would get cached under this user for
    //    a full 24h. The fallback remains reserved for total failures (zero
    //    usable items), where anything beats a blank panel.
    //  - Don't count this toward the global outage breaker either: a thin
    //    result is a per-user quality signal (sparse interests/location), not
    //    a provider outage — with BATCH_SIZE=3 parallel prefetches, a couple
    //    of thin users could otherwise trip the breaker and freeze the stale
    //    fallback into every healthy user's 24h briefing. The per-user
    //    failure backoff in prefetchNewsForUser bounds repeat attempts.
    if (result.length < MIN_HEALTHY_HEADLINES) {
      logger.warn(`news.service: fetch produced only ${result.length} usable headline(s) (< ${MIN_HEALTHY_HEADLINES}) — degenerate fetch, returning thin result`, { source: 'news' });
      if (outcome) outcome.source = 'fetch';
      return result;
    }

    // 2026-06-18: On every successful extraction, write to the fallback cache so
    // future extraction failures can return something useful rather than an empty array.
    // 2026-07-12: gated at NEWS_FALLBACK_MIN_HEADLINES — a healthy-but-partial
    // briefing (e.g. truncation-repaired) may serve ITS user but must not
    // overwrite everyone's outage fallback with a shrunken set.
    if (result.length > 0) {
      recordFetchSuccess(); // healthy fetch — reset/close the fetch breaker
      // Cross-instance throttle: only the first fetcher to acquire the NX lock within
      // any 60s window writes the fallback key. SET NX succeeds (returns 'OK') for the
      // winner and returns null for everyone else in the window — cluster-wide, so a
      // rolling blue-green deploy's 2-3 instances no longer all stampede the same key.
      let lockAcquired = false;
      try {
        lockAcquired = result.length >= NEWS_FALLBACK_MIN_HEADLINES &&
          (await redisClient.set(NEWS_FALLBACK_WRITE_LOCK_KEY, '1', {
            NX: true,
            EX: NEWS_FALLBACK_WRITE_THROTTLE_SECONDS,
          })) === 'OK';
      } catch { /* Redis down — skip the throttled write, non-critical */ }
      if (lockAcquired) {
        try {
          await redisClient.setEx(NEWS_FALLBACK_KEY, NEWS_FALLBACK_TTL, JSON.stringify(result));
        } catch (fbErr: any) {
          // Write failed — release the lock so the next fetch can retry immediately.
          try { await redisClient.del(NEWS_FALLBACK_WRITE_LOCK_KEY); } catch { /* ignore */ }
          logger.warn(`news.service: failed to write fallback cache: ${fbErr.message}`, { source: 'news' });
        }
      }
    }

    // Provenance (ticket 4888d891): this is OUR OWN briefing — the caller may
    // cache it under the user with the full TTL.
    if (outcome) outcome.source = 'fetch';
    return result;
  } catch (parseErr: any) {
    logger.warn(`news.service: JSON parse failed: ${parseErr.message?.substring(0, 80)}`, { source: 'news' });
    return await failToFallback('parse_throw: extraction threw');
  }
}

/**
 * Retrieve the most recently cached headlines from the fallback Redis key.
 * Returns an empty array if no fallback is available or Redis fails.
 * Used when all 4 extraction strategies fail to prevent a complete news blackout.
 */
async function getNewsFallbackCache(): Promise<any[]> {
  try {
    const raw = await redisClient.get(NEWS_FALLBACK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Quality-filter here too: a fallback written before the write-side gate
    // existed may hold almanac trivia or stale dated roundups — never
    // re-circulate them.
    const usable = Array.isArray(parsed) ? filterBriefingQuality(parsed) : [];
    if (usable.length > 0) {
      logger.info(`news.service: returning ${usable.length} headlines from fallback cache`);
      return usable;
    }
    return [];
  } catch (err: any) {
    logger.warn(`news.service: fallback cache read failed: ${err.message}`, { source: 'news' });
    return [];
  }
}
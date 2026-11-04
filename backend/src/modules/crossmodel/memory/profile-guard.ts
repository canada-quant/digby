/**
 * Profile-extraction guard — the 2026-10-20 profile parse_error bursts (admin error logs:
 * `memory-audit: extraction parse_error (profile) for <userId> after ~7000 ms: { "summary": "…`
 * — 31 rows 2026-10-06 22:00–23:59Z, 34 rows 2026-10-12 00:00Z, 23 rows in ~2 min 2026-10-20 11:24Z
 * for ONE user, each ~7 s = the utility model spending the whole 1800-token output budget).
 *
 * Two defects in the profile leg of the memory pipeline (langgraph/memory.graph.ts
 * extractUserContextNode), one guard each:
 *
 *  1. BOUNDS — the leg re-emits the WHOLE {summary, preferences, currentFocus, recentTopics,
 *     communicationStyle} object every call, and nothing bounded those fields ("summary (1 line)"
 *     was a hint). The profile accreted until the echo outgrew the budget — 512 → 900 → 1800 were
 *     each a rung of the same treadmill. Once the cut lands inside the FIRST field the f171 salvage
 *     has nothing complete to keep, nothing is saved, and a profile that is never saved never
 *     shrinks: every later call for that user fails the same way. PROFILE_FIELD_CAPS bound each
 *     field; the model is SHOWN a clamped profile and told the limits, and what is saved is clamped,
 *     so the echo always fits the budget (≈1,700 chars of content ≪ 1800 tokens) and a stored
 *     profile that already outgrew it heals on its next extraction.
 *  2. THROTTLE — the profile is per USER but the pipeline's debounce is per CHAT (a chat's first
 *     three turns always run), so N fresh chats for one user re-ran the same profile re-emission N
 *     times at once (23 for the shared test account). claimProfileExtraction allows one profile call
 *     per user in flight, then a cooldown (a longer backoff after a failure); explicit rejections
 *     bypass it; the turn's flat facts still run. In-process on purpose: the profile leg runs only on
 *     human turns in the web backends, so the bound is one call per process per window (A + B, plus
 *     a blue/green overlap) with no Redis-outage semantics on a background path.
 *
 * Kill switches (release): PROFILE_FIELD_CAPS_DISABLED=1 (the unbounded profile and the old prompt),
 * PROFILE_EXTRACT_THROTTLE_DISABLED=1 (one profile call per eligible turn).
 *
 * Leaf: type imports only.
 */
import type { UserContextState } from '../langgraph/types';
import type { MemoryExtractionOutcome } from './memory-audit';

// ── 1. bounds ──────────────────────────────────────────────────────────────────

/** Per-field character caps. Content total ≈ 1,700 chars ≈ 450 output tokens of English (≤ ~1,700 worst case). */
export const PROFILE_FIELD_CAPS = {
  summary: 300,
  preferences: 500,
  currentFocus: 200,
  communicationStyle: 300,
  /** recentTopics: at most this many items … */
  topics: 5,
  /** … each at most this long. */
  topic: 80,
} as const;

export function profileFieldCapsEnabled(): boolean {
  return process.env.PROFILE_FIELD_CAPS_DISABLED !== '1';
}

/**
 * Cut `text` to at most `cap` chars: at the last sentence end when one sits in the final 40 %,
 * else at the last word boundary with a '…'. Text within the cap is returned untouched.
 */
export function clampProfileText(text: unknown, cap: number): string {
  if (typeof text !== 'string') return '';
  if (text.length <= cap) return text;
  const room = cap - 1; // leaves space for the '…'
  const head = text.slice(0, room);
  const floor = Math.floor(room * 0.6);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '));
  if (sentenceEnd >= floor) return head.slice(0, sentenceEnd + 1).trimEnd();
  const space = head.lastIndexOf(' ');
  return `${(space >= floor ? head.slice(0, space) : head).trimEnd()}…`;
}

/**
 * The profile within PROFILE_FIELD_CAPS — only the five rendered fields survive (an extra key the
 * model invented would be echoed back every call) — plus the names of the fields that were cut.
 */
export function clampUserContextState(state: UserContextState): { profile: UserContextState; clampedFields: string[] } {
  const clampedFields: string[] = [];
  const field = (name: keyof typeof PROFILE_FIELD_CAPS & keyof UserContextState, value: unknown): string => {
    const out = clampProfileText(value, PROFILE_FIELD_CAPS[name]);
    if (typeof value === 'string' && out !== value) clampedFields.push(name);
    return out;
  };
  const topicsIn = Array.isArray(state?.recentTopics) ? state.recentTopics.filter((t): t is string => typeof t === 'string') : [];
  const recentTopics = topicsIn.slice(0, PROFILE_FIELD_CAPS.topics).map((t) => clampProfileText(t, PROFILE_FIELD_CAPS.topic));
  if (topicsIn.length > recentTopics.length || recentTopics.some((t, i) => t !== topicsIn[i])) clampedFields.push('recentTopics');
  return {
    profile: {
      summary: field('summary', state?.summary),
      preferences: field('preferences', state?.preferences),
      currentFocus: field('currentFocus', state?.currentFocus),
      recentTopics,
      communicationStyle: field('communicationStyle', state?.communicationStyle),
    },
    clampedFields,
  };
}

/** The prompt's field line under the caps — the numbers come from PROFILE_FIELD_CAPS so they never drift. */
export function boundedProfileFieldsInstruction(): string {
  const c = PROFILE_FIELD_CAPS;
  return `Fields: summary (ONE sentence, at most ${c.summary} characters), preferences (at most ${c.preferences} characters), currentFocus (at most ${c.currentFocus} characters), recentTopics (array, at most ${c.topics} short phrases), communicationStyle (at most ${c.communicationStyle} characters)
Keep every field within its limit: REWRITE each field as one compact whole — merge the new information in and drop the least durable detail. Never append to a field until it outgrows its limit.`;
}

// ── 2. per-user throttle ─────────────────────────────────────────────────────────

/** After a profile call that parsed (changed / noop): no other for this user for this long. */
export const PROFILE_EXTRACT_COOLDOWN_MS = 60_000;
/** After a failed one (parse_error / empty / llm_error): back off this long — never a call per turn on a doomed input. */
export const PROFILE_EXTRACT_FAILURE_BACKOFF_MS = 15 * 60_000;
/** A claim that is never settled (a crash mid-call) frees itself after this long. */
export const PROFILE_EXTRACT_IN_FLIGHT_MAX_MS = 3 * 60_000;
const THROTTLE_MAX_USERS = 10_000;

interface ThrottleEntry { until: number; skipped: number }
const throttle = new Map<string, ThrottleEntry>();

export function profileExtractThrottleEnabled(): boolean {
  return process.env.PROFILE_EXTRACT_THROTTLE_DISABLED !== '1';
}

export type ProfileExtractClaim =
  | { run: true; /** turns this throttle skipped for the user since its previous run */ skippedSinceLast: number }
  | { run: false; retryInMs: number };

/**
 * Claim the user's profile extraction for this turn. `bypass` (an explicit rejection) always runs.
 * A refused claim counts the skip; the next run reports it. Never throws.
 */
export function claimProfileExtraction(userId: string, opts: { bypass?: boolean } = {}): ProfileExtractClaim {
  if (!profileExtractThrottleEnabled()) return { run: true, skippedSinceLast: 0 };
  const now = Date.now();
  const entry = throttle.get(userId);
  if (entry && entry.until > now && !opts.bypass) {
    entry.skipped += 1;
    return { run: false, retryInMs: entry.until - now };
  }
  if (!entry && throttle.size >= THROTTLE_MAX_USERS) pruneThrottle(now);
  throttle.set(userId, { until: now + PROFILE_EXTRACT_IN_FLIGHT_MAX_MS, skipped: 0 });
  return { run: true, skippedSinceLast: entry?.skipped ?? 0 };
}

/** Close the claim: a cooldown after a parsed answer, the backoff after a failure. Never throws. */
export function settleProfileExtraction(userId: string, outcome: MemoryExtractionOutcome): void {
  if (!profileExtractThrottleEnabled()) return;
  const ok = outcome === 'changed' || outcome === 'noop';
  const skipped = throttle.get(userId)?.skipped ?? 0; // skips counted while the call was in flight
  throttle.set(userId, { until: Date.now() + (ok ? PROFILE_EXTRACT_COOLDOWN_MS : PROFILE_EXTRACT_FAILURE_BACKOFF_MS), skipped });
}

function pruneThrottle(now: number): void {
  for (const [userId, e] of throttle) if (e.until <= now) throttle.delete(userId);
  // Still full of live entries: drop the oldest-inserted (Map iteration order).
  for (const userId of throttle.keys()) {
    if (throttle.size < THROTTLE_MAX_USERS) break;
    throttle.delete(userId);
  }
}

/** Tests: forget every claim. */
export function resetProfileExtractionThrottle(): void {
  throttle.clear();
}

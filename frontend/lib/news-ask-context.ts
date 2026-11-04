/**
 * News → chat "ask about this story" context builders (ticket 94b93132, 2026-10-27).
 *
 * The home news card's "Ask Digby about this" flow composes a hidden context
 * block under the user's question. It previously read:
 *
 *     Context from today's news:
 *     "<headline>" — <summary>
 *
 * with NO publication date — so a years-old resurfaced story (the ticket's
 * Oak Bay wastewater example: a 2021 Times Colonist piece) rode into the
 * agent's context labeled as TODAY'S news, and the agent burned turns
 * re-verifying dates. Every downstream answer built on an undated "today's
 * news" block is suspect.
 *
 * The backend now carries a verbatim publication label per item (`published`,
 * copied from the search result the story came from; '' when no result showed
 * a date — items whose label parses to a stale date are dropped backend-side,
 * so anything that survives is fresh or honestly undated). This module renders
 * that label next to every item and swaps the block header for an honest one
 * whenever NO item in the block carries a date:
 *   - fresh/undated mix → "Context from the news (publication dates shown):"
 *   - nothing dated     → "Context from the news (dates not shown by the sources):"
 *
 * Parsers here are DELIBERATELY shallow display heuristics (relative ages and
 * the two common date orders) — the backend owns the authoritative
 * staleness gate; this only decides whether a label is renderable, and an
 * unparseable label still renders VERBATIM rather than being hidden.
 */

export interface NewsItemLike {
  headline: string;
  summary: string;
  /** Publication label as produced by the news pipeline (may be '' or undefined
   * on briefings cached before the field existed). */
  published?: string;
}

/** Freshness words the SERP layer emits instead of dates. */
const TODAY_RE = /^(today|now|right now|just now|this (morning|afternoon|evening))$/i;
const YESTERDAY_RE = /^yesterday$/i;
/** "3 hours ago" / "2 days ago" / "5 weeks ago" — and the useless non-dates. */
const RELATIVE_AGE_RE = /^(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago$/i;
const USELESS_LABEL_RE = /^(unknown|n\/?a|none|null|unsure|unclear|not available|no date)$/i;
/** US month-first ("Oct 28, 2021") and day-first European ("28 Oct 2021"). */
const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const MONTH_FIRST_DATE_RE = new RegExp(
  `\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s*(\\d{4})?\\b`,
  'i'
);
const DAY_FIRST_DATE_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?(?:,)?\\s*(\\d{4})?\\b`,
  'i'
);
const ISO_DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/;
const BARE_YEAR_RE = /^(20\d{2})$/;

const RELATIVE_UNIT_MS: Record<string, number> = {
  minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000,
  day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000,
};

/** Cleaned display label: '' when the item effectively has no publication label. */
export function displayPublishedLabel(published?: string): string {
  const s = String(published ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!s || USELESS_LABEL_RE.test(s)) return '';
  return s;
}

/**
 * Rough age of a rendered label in days, when it parses to an absolute moment.
 * Display heuristic only (the backend gate owns staleness): relative ages and
 * freshness words resolve against `now`; US month-first / day-first / ISO dates
 * resolve to calendar days; ambiguous numeric forms (10/28) return null on
 * purpose — the label still renders, it just cannot age.
 */
export function publishedLabelAgeDays(label: string, now: Date = new Date()): number | null {
  const dayStart = (offsetDays: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays);
  if (TODAY_RE.test(label)) return 0;
  if (YESTERDAY_RE.test(label)) return 1;
  const rel = RELATIVE_AGE_RE.exec(label);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const ms = RELATIVE_UNIT_MS[rel[2].toLowerCase().replace(/s$/, '')];
    if (!ms || !Number.isFinite(n) || n <= 0) return null;
    return (n * ms) / 86_400_000;
  }
  const mf = MONTH_FIRST_DATE_RE.exec(label);
  if (mf) {
    const month = MONTH_INDEX[mf[1].toLowerCase().replace(/\.$/, '')];
    const day = parseInt(mf[2], 10);
    if (month === undefined || day < 1 || day > 31) return null;
    let year = mf[3] ? parseInt(mf[3], 10) : now.getFullYear();
    if (!mf[3] && new Date(year, month, day).getTime() - now.getTime() > 30 * 86_400_000) {
      year -= 1; // yearless date far in the future is almost certainly last year's
    }
    return (dayStart(0).getTime() - new Date(year, month, day).getTime()) / 86_400_000;
  }
  const df = DAY_FIRST_DATE_RE.exec(label);
  if (df) {
    const day = parseInt(df[1], 10);
    const month = MONTH_INDEX[df[2].toLowerCase().replace(/\.$/, '')];
    if (month === undefined || day < 1 || day > 31) return null;
    let year = df[3] ? parseInt(df[3], 10) : now.getFullYear();
    if (!df[3] && new Date(year, month, day).getTime() - now.getTime() > 30 * 86_400_000) {
      year -= 1;
    }
    return (dayStart(0).getTime() - new Date(year, month, day).getTime()) / 86_400_000;
  }
  const iso = ISO_DATE_RE.exec(label);
  if (iso) {
    return (dayStart(0).getTime() - new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10)).getTime()) / 86_400_000;
  }
  const year = BARE_YEAR_RE.exec(label);
  if (year) {
    return (dayStart(0).getTime() - new Date(parseInt(year[1], 10), 0, 1).getTime()) / 86_400_000;
  }
  return null;
}

/** True when the label is renderable text that will AGE (used for the header's honesty wording). */
export function publishedLabelIsDated(label: string): boolean {
  if (!label) return false;
  return publishedLabelAgeDays(label) !== null;
}

/**
 * The context block appended under a user's question when they ask about a news
 * story. Per-item dates render when the pipeline produced them (verbatim — the
 * label is exactly what the source showed, never a reformat); the header
 * downgrades from the old dishonest "today's news" to dated/undated wording.
 */
export function buildNewsAskContext(question: string, item: NewsItemLike): string {
  const label = displayPublishedLabel(item.published);
  const dated = label ? ` (published ${label})` : '';
  const header = label
    ? 'Context from the news (publication dates shown):'
    : 'Context from the news (dates not shown by the sources):';
  return `${question}\n\n${header}\n"${item.headline}"${dated} — ${item.summary}`;
}

/**
 * localizeUtcTimes — owner 2026-09-14: "make sure fleet supervisor hourly
 * updates are in the users local timezone or converted in the ui to the users
 * local time according to their location/browser".
 *
 * Row timestamps were already browser-local (lib/format-message-time.ts). The
 * gap was the CLOCKS INSIDE machine-authored text: supervisors write on the
 * harness clock — "WAKE — 03:43Z", "Live snapshot as of 14:41Z", "(harness
 * clock 13:44:05Z)", "at 14:41 UTC", and ISO stamps like
 * "2026-09-14T14:41:21Z" in wake envelopes and verification footers. This
 * rewrites every such token to the viewer's local time at render time, in the
 * viewer's own zone (Intl default = the browser's zone), so two owners in two
 * cities each read their own clock. Presentation-only: the persisted text is
 * untouched, and code fences / inline code are never rewritten.
 *
 * Rules:
 *  - ISO stamps (date + time + Z or ±hh:mm) → "10:41 AM" today, else
 *    "Sep 14, 10:41 AM" (year added when it differs) — the same shape as
 *    formatMessageTime so the two never disagree on a screen.
 *  - Bare zoned clocks ("14:41Z", "14:41:05Z", "14:41 UTC") → "10:41 AM"; the
 *    calendar day is taken from `anchor` (the row's createdAt when the caller
 *    has it; otherwise now). When the local result lands on a different local
 *    day than the anchor (a "23:30Z" read in Tokyo) the short date is added.
 *  - Clocks WITHOUT a zone ("14:41") are left alone — they may already be
 *    local or may be quoted from somewhere else; guessing would be worse.
 *  - Impossible clocks (25:00Z, 12:75Z) are left alone.
 */

export interface LocalizeUtcTimesOptions {
  /** The row's timestamp (ISO or Date) — supplies the calendar day for bare clocks. Default: `now`. */
  anchor?: string | Date | null;
  /** Injectable "today" (tests). Default: new Date(). */
  now?: Date;
  /** Injectable locale / zone (tests). Default: the browser's. */
  locale?: string;
  timeZone?: string;
}

// Code fences and inline code are opaque — never rewrite a clock inside them.
const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

// 2026-09-14T14:41:21Z · 2026-09-14T14:41Z · 2026-09-14T14:41:21.123+00:00
const ISO_STAMP_RE = /\b(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})\b/g;

// 14:41Z · 14:41:05Z · 14:41 UTC · 3:43Z — a zoned wall clock with no date.
// The lookbehind keeps "2026-09-14T14:41Z" (already handled) and "1:14:41Z"
// tails from double-matching; \b after the zone keeps "UTC+2" and "Zoom" out.
const ZONED_CLOCK_RE = /(?<![\d:.])(\d{1,2}):(\d{2})(?::(\d{2}))?\s?(?:Z|UTC)\b/g;

function sameLocalDay(a: Date, b: Date, timeZone?: string): boolean {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(a) === f.format(b);
}

function localClock(d: Date, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
}

function localShortDate(d: Date, now: Date, locale?: string, timeZone?: string): string {
  const sameYear = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(d)
    === new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(now);
  return new Intl.DateTimeFormat(locale, { timeZone, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}

/** formatMessageTime's shape, with an injectable now/locale/zone. */
export function formatLocalStamp(d: Date, opts?: LocalizeUtcTimesOptions): string {
  const now = opts?.now ?? new Date();
  const time = localClock(d, opts?.locale, opts?.timeZone);
  if (sameLocalDay(d, now, opts?.timeZone)) return time;
  return `${localShortDate(d, now, opts?.locale, opts?.timeZone)}, ${time}`;
}

function anchorDate(opts?: LocalizeUtcTimesOptions): Date {
  const a = opts?.anchor;
  if (a instanceof Date && !isNaN(a.getTime())) return a;
  if (typeof a === 'string' && a) {
    const d = new Date(a);
    if (!isNaN(d.getTime())) return d;
  }
  return opts?.now ?? new Date();
}

function rewriteSegment(seg: string, opts?: LocalizeUtcTimesOptions): string {
  const now = opts?.now ?? new Date();
  let out = seg.replace(ISO_STAMP_RE, (m) => {
    const d = new Date(m);
    return isNaN(d.getTime()) ? m : formatLocalStamp(d, { ...opts, now });
  });
  const anchor = anchorDate(opts);
  out = out.replace(ZONED_CLOCK_RE, (m, hh: string, mm: string, ss?: string) => {
    const h = Number(hh); const mi = Number(mm); const s = ss ? Number(ss) : 0;
    if (h > 23 || mi > 59 || s > 59) return m;
    const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate(), h, mi, s));
    const time = localClock(d, opts?.locale, opts?.timeZone);
    // A bare clock read on another local day than its anchor gets the date
    // so "23:30Z" does not silently become "tomorrow morning" in Tokyo.
    return sameLocalDay(d, anchor, opts?.timeZone) ? time : `${localShortDate(d, now, opts?.locale, opts?.timeZone)}, ${time}`;
  });
  return out;
}

/** True when the text carries at least one zoned clock or ISO stamp this helper would rewrite. */
export function hasUtcClock(text: string): boolean {
  if (!text) return false;
  // The module regexes are /g (for replace): reset lastIndex before every
  // .test() or a positive result makes the next call a false negative.
  return text.split(CODE_SEGMENT_RE).some((seg, i) => {
    if (i % 2 !== 0) return false;
    ISO_STAMP_RE.lastIndex = 0; ZONED_CLOCK_RE.lastIndex = 0;
    const hit = ISO_STAMP_RE.test(seg) || ZONED_CLOCK_RE.test(seg);
    ISO_STAMP_RE.lastIndex = 0; ZONED_CLOCK_RE.lastIndex = 0;
    return hit;
  });
}

/** Rewrite every UTC clock / ISO stamp outside code to the viewer's local time. Pure; total; never throws. */
export function localizeUtcTimes(text: string, opts?: LocalizeUtcTimesOptions): string {
  if (!text || typeof text !== 'string') return text ?? '';
  try {
    const parts = text.split(CODE_SEGMENT_RE);
    // split with a capturing group alternates prose (even) / code (odd).
    return parts.map((p, i) => (i % 2 === 1 ? p : rewriteSegment(p, opts))).join('');
  } catch {
    return text;
  }
}

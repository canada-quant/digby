/**
 * Home "Today" card — the APPLE ↔ GOOGLE merge (2026-11-06).
 *
 * The card used to be Google-only by construction, so an owner whose real
 * calendar is Apple Calendar saw "Connect your calendar" and never an event.
 * Now both sources land in one list, and the two problems that creates are
 * solved here rather than in the controller:
 *
 *  1. NORMALISATION. Apple events arrive as EventKit's own shape (ISO
 *     `startDate`/`endDate`, `allDay`, an event `id`, a calendar title); the
 *     card renders Google's parsed shape (`startRaw`/`endRaw`/`startEpoch`/
 *     `endEpoch`/`startTime`/`endTime`/`title`/`location`/`account`/
 *     `aiPrompts`). `appleEventsForCard` converts Apple's into that SAME shape
 *     so ONE renderer serves both — the alternative (a second card) would
 *     have meant two calendar stories in one product.
 *
 *  2. DEDUPE. The same meeting is usually on both calendars. Showing it twice
 *     is bad; silently DELETING a distinct event is worse — so the rule is
 *     deliberately narrow: collapse only when the normalised titles match AND
 *     the start instants agree within DEDUPE_START_TOLERANCE_MS. An all-day
 *     event never collapses into a timed one (different `allDay` flag ⇒
 *     different key), and when a pair DOES collapse the APPLE copy is kept
 *     because it carries the user's own calendar name as its source label.
 *
 * Everything here is pure — no agent, no prisma, no clock beyond the `now`
 * argument — so the merge and the normalisation are unit-testable without a
 * Mac.
 */

import type { AppleCalendarEvent } from './apple-calendar';

/** How close two start instants must be to count as the same occurrence.
 *  Google's parser derives its epoch from a human-formatted string, so a
 *  little slack is required; a real duplicate is exact, a distinct back-to-back
 *  meeting is ≥ its own duration away. */
export const DEDUPE_START_TOLERANCE_MS = 60_000;

/** The display shape the existing card renders (a superset of the Google
 *  parser's CalendarEventParsed, plus `source`). Optional fields keep the
 *  Google side byte-compatible. */
export interface HomeCalendarEvent {
  title: string;
  startTime: string;
  endTime: string;
  startRaw: string;
  endRaw: string;
  startEpoch: number;
  endEpoch: number;
  location?: string;
  description?: string;
  account?: string;
  aiPrompts: string[];
  /** Which calendar this row came from — the card labels Apple rows with the
   *  source Mac so a user can tell the two apart. */
  source: 'google' | 'apple';
  /** Apple rows only: the EventKit event identifier + its calendar's title. */
  eventId?: string;
  allDay?: boolean;
}

/** "9:00 AM" from an epoch — the card's short-time column. */
function shortTimeFromEpoch(ms: number, tz: string): string {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleTimeString('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
}

/** The full human date string the card shows under the time ("Mon, Nov 6,
 *  2026, 9:00 AM PST") — mirrors the Google parser's startRaw. */
function rawFromEpoch(ms: number, tz: string): string {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleString('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Prompt chips for an Apple event — the same three affordances the Google
 *  parser generates, so the card's actions work on either source. */
function applePrompts(title: string, when: string, location?: string, isPast = false): string[] {
  const t = title || 'this event';
  if (isPast) return [`What happened at ${t}?`, 'Summarize my day', 'What did I decide?'];
  const out = [`What do I need to prepare for ${t}${when ? ` at ${when}` : ''}?`];
  if (location) out.push(`Directions and notes for ${location}`);
  out.push('What else is on my calendar today?');
  return out;
}

/** Convert Apple/EventKit events into the card's display rows, filtered to the
 *  user's LOCAL DAY. `dayStartMs`/`dayEndMs` default to "today in tz". */
export function appleEventsForCard(
  events: AppleCalendarEvent[],
  tz: string,
  now: number = Date.now(),
  dayStartMs?: number,
  dayEndMs?: number,
): HomeCalendarEvent[] {
  const { start, end } = dayStartMs != null && dayEndMs != null
    ? { start: dayStartMs, end: dayEndMs }
    : localDayWindow(tz, now);

  const rows: HomeCalendarEvent[] = [];
  for (const e of events) {
    const startMs = e.startDate ? Date.parse(e.startDate) : NaN;
    if (!Number.isFinite(startMs)) continue;
    const endMs = e.endDate ? Date.parse(e.endDate) : startMs + 60 * 60 * 1000;
    // Local-day filter. An event that STARTED before today but is still running
    // (an overnight block) belongs on today's card; an event wholly inside the
    // window belongs too; anything else does not.
    const overlaps = endMs > start && startMs < end;
    if (!overlaps) continue;
    const isPast = endMs < now;
    const startTime = e.allDay ? 'All day' : shortTimeFromEpoch(startMs, tz);
    rows.push({
      title: e.title || '(untitled)',
      startTime,
      endTime: e.allDay ? '' : shortTimeFromEpoch(endMs, tz),
      startRaw: e.allDay ? rawFromEpoch(startMs, tz).replace(/,?\s*\d{1,2}:\d{2}\s*(AM|PM)/i, '') : rawFromEpoch(startMs, tz),
      endRaw: e.allDay ? '' : rawFromEpoch(endMs, tz),
      startEpoch: startMs,
      endEpoch: endMs,
      ...(e.location ? { location: e.location } : {}),
      ...(e.notes ? { description: e.notes } : {}),
      ...(e.calendar ? { account: e.calendar } : {}),
      aiPrompts: applePrompts(e.title || '', e.allDay ? '' : startTime, e.location || undefined, isPast),
      source: 'apple',
      eventId: e.id,
      ...(e.allDay ? { allDay: true } : {}),
    });
  }
  return rows.sort((a, b) => a.startEpoch - b.startEpoch);
}

/** [start,end) of the user's local day in tz, as epoch ms. Same technique the
 *  controller already uses for the Google window (offset from a UTC-vs-tz
 *  formatting comparison, which is DST-correct). */
export function localDayWindow(tz: string, now: number = Date.now()): { start: number; end: number } {
  const d = new Date(now);
  let localDateStr: string;
  let offsetMs: number;
  try {
    localDateStr = d.toLocaleDateString('en-CA', { timeZone: tz });
    const parse = (s: string) => {
      const m = s.match(/(\d+)\/(\d+)\/(\d+),?\s*(\d+):(\d+):(\d+)/);
      if (!m) return 0;
      return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4] === 24 ? 0 : +m[4], +m[5], +m[6]);
    };
    const utcParts = d.toLocaleString('en-US', { timeZone: 'UTC', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const tzParts = d.toLocaleString('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    offsetMs = parse(utcParts) - parse(tzParts);
  } catch {
    // Unknown tz: fall back to UTC so the card still renders (never throws).
    localDateStr = d.toISOString().slice(0, 10);
    offsetMs = 0;
  }
  const start = new Date(`${localDateStr}T00:00:00Z`).getTime() + offsetMs;
  const end = new Date(`${localDateStr}T23:59:59Z`).getTime() + offsetMs;
  return { start, end };
}

/** Title normalisation for the dedupe key: same words, same meeting. */
function normTitle(t: string | null | undefined): string {
  return String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Merge Apple rows into the Google list, collapsing only genuine duplicates.
 *
 * Apple rows are the PREFERRED copy of a duplicate (they carry the calendar
 * name as the source label and an EventKit id), so a matched Google row is
 * dropped and the Apple row stays. Order is by start instant.
 *
 * Exported for the dedupe tests — the tolerance and the all-day rule are the
 * parts that must not drift.
 */
export function mergeAppleAndGoogleEvents(
  apple: HomeCalendarEvent[] | any[],
  google: HomeCalendarEvent[] | any[],
): HomeCalendarEvent[] {
  const appleRows = (apple || []).map((r) => ({ ...r, source: 'apple' as const })) as HomeCalendarEvent[];
  const googleRows = (google || []).map((r) => ({ ...r, source: 'google' as const })) as HomeCalendarEvent[];

  const kept: HomeCalendarEvent[] = [...appleRows];
  for (const g of googleRows) {
    const gKey = normTitle(g.title);
    const gStart = Number(g.startEpoch);
    const duplicate = kept.some((a) => {
      if (normTitle(a.title) !== gKey) return false;
      // An all-day row and a timed row are NOT the same thing even with the
      // same title — collapsing them would hide a real timed slot.
      if (Boolean(a.allDay) !== Boolean(g.allDay)) return false;
      const aStart = Number(a.startEpoch);
      if (!Number.isFinite(aStart) || !Number.isFinite(gStart)) return false;
      return Math.abs(aStart - gStart) <= DEDUPE_START_TOLERANCE_MS;
    });
    if (!duplicate) kept.push(g);
  }
  return kept.sort((x, y) => (Number(x.startEpoch) || 0) - (Number(y.startEpoch) || 0));
}
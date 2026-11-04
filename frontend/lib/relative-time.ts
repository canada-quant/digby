/**
 * The ONE relative-time module (UI overhaul Phase 4).
 *
 * Before P4 four separate systems rendered "how long ago": the management
 * tabs' compact `relativeTime`, ChatFilesSection's `relativeDate` wrapper,
 * and two direct date-fns `formatDistanceToNow` call sites — plus ~10 raw
 * `toLocaleDateString()` calls for absolute item dates. Everything funnels
 * through here now; new surfaces must import from this module instead of
 * hand-rolling age math.
 *
 * Formats:
 *   - relativeTime()     — compact "3m ago" / "in 5m" / "just now"; absolute
 *                          date past ~30 days. Sidebars, tables, dense rows.
 *   - relativeTimeLong() — long form "3 minutes ago" (date-fns). Prose-adjacent
 *                          stamps (activity feeds, digest freshness, file rows).
 *   - absoluteDate()     — locale absolute date for fixed stamps (created /
 *                          connected / expires dates on old items).
 *
 * (Clock-of-day message stamps are a different format and live in
 * lib/format-message-time.ts.)
 */

import { formatDistanceToNow } from 'date-fns';

/**
 * Compact relative time — handles future dates ("in 5m") for schedule
 * nextRunAt. Falls back to an absolute locale date past ~30 days.
 * `nowMs` is injectable for deterministic tests; production callers omit it.
 */
export function relativeTime(dateStr: string | null | undefined, nowMs: number = Date.now()): string {
  if (!dateStr) return '—';
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = then - nowMs; // positive = future
  const abs = Math.abs(diff);
  const mins = Math.floor(abs / 60000);
  // Sub-minute must keep its direction: a schedule firing in 30s labelled
  // "just now" reads as "it already ran".
  if (mins < 1) return diff >= 0 ? 'in <1 min' : 'just now';
  let core: string;
  if (mins < 60) core = `${mins}m`;
  else {
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) core = `${hrs}h`;
    else {
      const days = Math.floor(hrs / 24);
      if (days < 30) core = `${days}d`;
      else return new Date(then).toLocaleDateString();
    }
  }
  return diff >= 0 ? `in ${core}` : `${core} ago`;
}

/**
 * Long-form relative time — "3 minutes ago" / "about 1 hour ago" (date-fns,
 * always suffixed). Returns '' for missing/unparseable input and falls back
 * to an absolute locale date if date-fns throws, so callers can render the
 * result directly without their own guards.
 */
export function relativeTimeLong(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return d.toLocaleDateString();
  }
}

/** Absolute-date styles actually used by the app's item stamps. */
export type AbsoluteDateStyle =
  /** Locale default — e.g. "9/7/2026" (en-US). */
  | 'numeric'
  /** "Sep 7, 2026" — file/canvas modified dates. */
  | 'medium'
  /** "Sep 7" — dense admin rows where the year is noise. */
  | 'monthDay';

const ABSOLUTE_DATE_OPTIONS: Record<Exclude<AbsoluteDateStyle, 'numeric'>, Intl.DateTimeFormatOptions> = {
  medium: { month: 'short', day: 'numeric', year: 'numeric' },
  monthDay: { month: 'short', day: 'numeric' },
};

/**
 * Absolute locale date for fixed stamps (created/connected/expires on old
 * items). Returns '' for missing/unparseable input so callers never render
 * "Invalid Date".
 */
export function absoluteDate(iso: string | null | undefined, style: AbsoluteDateStyle = 'numeric'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (style === 'numeric') return d.toLocaleDateString();
  return d.toLocaleDateString(undefined, ABSOLUTE_DATE_OPTIONS[style]);
}

/**
 * delta_material state — the "last run one-line outcome" field (E5, 2026-09-25).
 *
 * The eval doc prescribed this field for the delta-materiality gate; the
 * 2026-09-24 site passed only {schedule_prompt, watched_change}. The line is
 * HARNESS-derived from the lane's PREVIOUS delta-gated firing's labelled
 * outcome row (decision-outcome-labels.ts: note class + mutating / evidence
 * tool counts) plus the schedule row's own last status — never lane prose.
 * Pure leaf (no imports) so it is testable without the schedule service's
 * dependency graph; schedule.service.ts does the lookup and the kill switch.
 */

export interface PrevDeltaOutcomeRow { createdAt: Date; meta: unknown }

/** Human "n min/h/d ago" relative to `now`; 'never' for a missing date. */
export function relativeAgo(d: Date | null | undefined, now: Date): string {
  if (!d) return 'never';
  const min = Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 60_000));
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
}

/** One line, ≤ 300 chars, from the previous labelled delta_material outcome row (or its absence). Pure. */
export function formatDeltaLastRunOutcome(
  prev: PrevDeltaOutcomeRow | null,
  s: { lastStatus?: string | null; lastFiredAt?: Date | null },
  now: Date,
): string {
  const status = `schedule lastStatus=${s.lastStatus ?? 'none'}, lastFiredAt=${relativeAgo(s.lastFiredAt, now)}`;
  const m = (prev?.meta && typeof prev.meta === 'object' ? prev.meta : null) as { actual?: unknown; note?: unknown } | null;
  if (!prev || !m) return `no prior labelled delta-gated firing (${status})`.slice(0, 300);
  const actual = m.actual === true ? 'material (the run did real work)' : m.actual === false ? 'NOT material (the run only noted it)' : 'outcome unknown';
  const note = typeof m.note === 'string' && m.note ? ` — ${m.note}` : '';
  return `previous delta-gated firing ${relativeAgo(prev.createdAt, now)}: ${actual}${note} (${status})`.slice(0, 300);
}

/**
 * Terminal-hook loop marker (ticket 54a172ac, 2026-09-20). CanLaw run
 * c510c56f (kimi-k3, schedule-fired) looped for ~35 min — todo_create ×64
 * ("noop1"…"noop64" junk todos under a live goal) + update_plan ×137
 * near-identical rewrites — and its run_completed event read like any other:
 * the project supervisor only found the loop by reading the live transcript
 * mid-flight. buildLoopMarker appends a machine-readable [LOOP-MARKER] line
 * to the run's terminal hook summary whenever a watched tool's per-run call
 * volume crosses LOOP_MARKER_FLAG, so supervisors can triage repetition loops
 * without opening transcripts (the ticket's proposal (c)).
 *
 * Marker ≠ enforcement: containment lives in agent.ts (loopVolumeCap, the
 * near-identical repeat leg, the derail breaker); this line only makes a
 * looped run VISIBLE after the fact.
 */
import { RECEIPT_TOOLS } from './run-receipts';

/** Per-run call count at which a watched tool flags the loop marker. */
export const LOOP_MARKER_FLAG = 25;

/**
 * Watched tools: the consequential receipt set (a run creating/updating 25+
 * records, sending 25+ messages, or staging 25+ schedules is never doing
 * ordinary work) plus update_plan (the incident's churn shape — 137
 * near-identical rewrites). run_command is deliberately OUT: build/probe
 * iteration legitimately exceeds the flag on healthy runs and would
 * false-positive the marker constantly.
 */
const MARKER_WATCH: ReadonlySet<string> = new Set(
  [...RECEIPT_TOOLS].filter((n) => n !== 'run_command').concat(['update_plan']),
);

/**
 * Build the loop-marker suffix for a run's terminal hook summary ('' when no
 * watched tool crossed the flag). journalParts are the run's journaled parts
 * (tool_call entries carry the tool name).
 */
export function buildLoopMarker(
  journalParts: ReadonlyArray<{ type: string; name?: string | null }>,
): string {
  const counts = new Map<string, number>();
  for (const p of journalParts) {
    if (p?.type === 'tool_call' && p.name && MARKER_WATCH.has(p.name)) {
      counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    }
  }
  const flagged = [...counts.entries()]
    .filter(([, n]) => n >= LOOP_MARKER_FLAG)
    .sort((a, b) => b[1] - a[1]);
  if (!flagged.length) return '';
  return ` [LOOP-MARKER — possible repetition loop] per-run tool-call volume ≥${LOOP_MARKER_FLAG}: ${flagged.map(([t, n]) => `${t}×${n}`).join(', ')}. Loop containment may have fired mid-run (guard_strike seams tool_volume_break / tool_repeat_break / tool_derail_break); inspect the transcript before trusting this run's summary.`;
}

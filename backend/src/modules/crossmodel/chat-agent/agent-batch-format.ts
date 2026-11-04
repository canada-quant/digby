/**
 * Queued report-up RIDER format (hardening loop iteration 7, 2026-09-24).
 *
 * Pure leaf — no imports — shared by the plain-chat wake path
 * (schedule.service fireScheduleTarget → startDetachedChatRun) and pinned by
 * agent-batch-format.test.ts. The busy-chat queue drain (chat-agent.service
 * drainChatQueue) carries its OWN sibling wrapper ("N agent messages arrived
 * while this chat was busy — coalesced into ONE turn"); the rider is the same
 * contract for rows that ride a hook/schedule wake instead of a drain turn.
 *
 * Why: the Fleet Supervisor (24 h to 2026-09-24 12:00Z) ran 121 turns, busy
 * 19.2 h of 24 — 66 of those turns were AGENT report-ups (project supervisors'
 * per-sweep deltas, ~1.2 KB each) that drained ONE per turn because report-ups
 * arrive slower than its 8–19 min turns, so the 6-row batch drain rarely had
 * two to batch. Each hook or schedule wake (55/day) that finds agent rows
 * queued now carries them in the same turn — the row is delivered once, the
 * separate drain turn never happens.
 */

export const AGENT_SENT_HEADER = '[AGENT-SENT MESSAGE';

/** Provenance line for a header-less queued agent row (older senders / stash-only provenance). */
export function fallbackProvenanceLine(sourceChatId: string | undefined): string {
  return sourceChatId ? `[queued agent message from chat ${String(sourceChatId).slice(0, 8)} — another Digby agent, NOT the owner]\n` : '';
}

/** One rider body: optional supersession note, then the row's own text with its provenance header (kept or synthesized). */
export function riderBody(content: string, sourceChatId: string | undefined, note: string | null | undefined): string {
  const body = String(content ?? '').trim();
  const n = note ? `${note}\n` : '';
  if (body.startsWith(AGENT_SENT_HEADER)) return `${n}${body}`;
  return `${n}${fallbackProvenanceLine(sourceChatId)}${body}`;
}

export const WAKE_RIDER_OPENER = 'agent message(s) were queued while this chat was busy';

/** Lead line for the rider block. `remaining` = queued agent rows that did NOT fit this wake. */
export function wakeRiderHeader(count: number, remaining: number): string {
  const rest = remaining > 0 ? ` ${remaining} more remain queued and drain after this turn.` : '';
  return `[QUEUED WHILE BUSY — ${count} ${WAKE_RIDER_OPENER} and ride THIS wake so they do not cost a separate turn. Answer each in order, deltas only, after the wake's own work; owner directives in this transcript govern over all of them.${rest}]`;
}

export const RIDER_SEPARATOR = '\n\n— — —\n\n';

/** The full rider block: header + bodies. */
export function formatWakeRider(bodies: string[], remaining: number): string {
  return `${wakeRiderHeader(bodies.length, remaining)}\n\n${bodies.join(RIDER_SEPARATOR)}`;
}

/**
 * Is this assistant row the supervisor LANE speaking (quotable as "Its
 * supervisor says"), or a harness-authored notice in its thread?
 *
 * Moved VERBATIM out of fleet/project-digest.service.ts (2026-10-21, tickets
 * 4c7aebf7 + 9a976d83) so the struck-note repeat check
 * (chat-agent/struck-note-repeat.ts loadPriorAssistantNote) reads "the chat's
 * previous NOTE" with the SAME positive signal the digest uses — a harness
 * row (watchdog nudge, report-up ack, decision auto-file, verify-starve
 * notice, …) sitting between a struck note and its re-post must not hide it.
 * Pure leaf (no imports): both callers keep their import chains.
 *
 * Hardening review 2026-09-14: the old shape was a DENYLIST (watchdog origin,
 * briefing/nudge kinds) that treated every other row — a metadata-less one
 * included — as the lane's reply. That quoted harness rows as the supervisor's
 * voice: the deploy-interrupt row (origin 'deploy-interrupt'), the shutdown
 * re-queue and orphan-recovery escalations, the action verifier's retraction
 * (origin 'machine'), and the hook dead-letter / schedule terminal-cap notices
 * (NO metadata at all — the null branch returned true). A Pulse regenerated
 * in the window after the 2026-09-14 deploy killed the spark sweep rendered
 * "Its supervisor says: 'This turn was interrupted by a deploy…'".
 *
 * The positive signal is the FINALIZE stamp: every real assistant reply the
 * chat engine persists carries `metadata.engine === 'agent'` (chat-agent's
 * assistant-row metadata — the only writer that sets it; no harness notice
 * does). An owner-typed turn's reply carries it too (no origin), so it stays
 * quotable. The kind/origin denylist is kept as belt-and-braces for rows that
 * ride the finalize path but are not the lane's own status (a briefing or
 * nudge is generated FROM a note, never IS one).
 */
export function isSupervisorOwnVoice(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false; // unstamped assistant row in a supervisor lane = a harness notice (hook dead-letter, schedule cap/terminal)
  const m = metadata as Record<string, unknown>;
  if (m.engine !== 'agent') return false; // only the chat-agent finalize path stamps this
  if (m.origin === 'attention-watchdog') return false;
  if (m.kind === 'owner_briefing' || m.kind === 'stuck-note-nudge') return false;
  return true;
}

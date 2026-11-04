/**
 * Error-toast dedupe (ticket 05303f58, BUG 2) — CodeSessionView's SSE 'error'
 * handler toasted `Agent error: …` on EVERY error frame, so a terminal error
 * (e.g. a workspace re-provision failure whose git stderr starts "Cloning
 * into…") re-toasted N times each time the stream replayed on a reconnect.
 *
 * The signature identifies the EVENT, not just its text: prefer the event seq
 * (data.seq, else the SSE frame's lastEventId — the backend writes frames as
 * `id: runId:seq`, stable across replays of the same persisted event), and
 * always fold in the message so two DIFFERENT errors that merely share a
 * sticky lastEventId (id-less frames keep the previous id) still both toast.
 */

/**
 * Signature for one SSE error frame — stable across replays of the same
 * persisted event, distinct for two different events (a retried run that
 * fails again gets a new seq, so its toast is NOT suppressed).
 */
export function errorToastSignature(
  data: { seq?: number | string; message?: unknown } | undefined,
  lastEventId?: string,
): string {
  const seq = data?.seq ?? (lastEventId || '');
  return `${seq}|${String(data?.message ?? '')}`;
}

/**
 * First-sight predicate: returns true (and remembers `sig`) the first time a
 * signature is seen, false on every exact repeat. The `seen` set lives in a
 * component ref, so a signature dedupes for the component's lifetime.
 */
export function shouldToastError(seen: Set<string>, sig: string): boolean {
  if (seen.has(sig)) return false;
  seen.add(sig);
  return true;
}

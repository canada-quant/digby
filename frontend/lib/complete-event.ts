/**
 * The coding run's terminal `complete` SSE event (backend coding/complete-event-payload.ts).
 *
 * audit 2026-10-06 T8-7 (crosscutting X3): when a run's transcript `parts` exceed the server's
 * COMPLETE_EVENT_PARTS_MAX_BYTES (default 256 KB) the event omits them and says `partsOmitted: true`
 * — the final row is already persisted, so the client loads it through the REST transcript read
 * (CodeSessionView reloadSession, the same path its attach branch uses) instead of appending a
 * parts-less bubble. A payload without the flag (small runs, an older server, the server kill
 * switch COMPLETE_EVENT_PARTS_OMIT_DISABLED=1) keeps today's in-place append.
 */
export function completePartsOmitted(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { partsOmitted?: unknown }).partsOmitted === true;
}

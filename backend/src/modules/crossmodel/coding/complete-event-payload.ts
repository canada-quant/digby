/**
 * The coding run's terminal `complete` SSE event payload (run-executor finalize).
 *
 * audit 2026-10-06 T8-7 (crosscutting X3, litellm F9): one long run's transcript
 * was stored ~4× — streamed events 4.16 MB + the `complete` event 3.59 MB (its
 * whole `parts`, kept in agent_events and in the live-run ring) + the
 * coding_messages row + the crossmodel_messages mirror; the final SSE frame
 * itself was 3.6 MB. The final row is persisted BEFORE `complete` is emitted, so
 * when `parts` exceeds COMPLETE_EVENT_PARTS_MAX_BYTES (default 256 KB) the event
 * carries `partsOmitted: true` (+ `partsBytes`, + `messageId` when known) and NO
 * `parts`; the web client (CodeSessionView) then loads the final message through
 * the existing REST transcript read (reloadSession), exactly as its attach path
 * already does. A small run's payload is unchanged, and so is any run whose final
 * persist FAILED (the REST read would serve a stale row — the parts must ride the
 * event then). COMPLETE_EVENT_PARTS_OMIT_DISABLED=1 restores today's payload
 * byte-for-byte. Consumers traced at the change: CodeSessionView (the only reader
 * of `complete.parts`), plain-session's normalizer (chat-agent events only —
 * coding completes pass through), SupervisorChatTab (refetches the thread),
 * the instances page (refetches), mobile (ignores parts), the backend (no reader
 * of `complete.parts`; agent_events + the live ring store whatever is pushed).
 *
 * Pure leaf — no imports.
 */

export const COMPLETE_EVENT_PARTS_MAX_BYTES_DEFAULT = 256 * 1024;

export function completeEventPartsOmitDisabled(): boolean {
  return process.env.COMPLETE_EVENT_PARTS_OMIT_DISABLED === '1';
}

/** The size threshold above which `parts` is omitted (env COMPLETE_EVENT_PARTS_MAX_BYTES, positive integer bytes). */
export function completeEventPartsMaxBytes(): number {
  const n = Number(process.env.COMPLETE_EVENT_PARTS_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : COMPLETE_EVENT_PARTS_MAX_BYTES_DEFAULT;
}

export interface CompleteEventInput {
  finalText: string;
  parts: unknown[];
  stopped: boolean;
  origin: string;
  triggerKind: string;
  /** The persisted final row's id (coding_messages id == its crossmodel_messages mirror id). */
  messageId?: string | null;
  /** True only when the final transcript row was written successfully this finalize. */
  finalPersisted: boolean;
}

export interface CompleteEventResult {
  payload: Record<string, unknown>;
  omitted: boolean;
  /** UTF-8 size of the serialized parts (null when not measured — kill switch / unpersisted / unserializable). */
  partsBytes: number | null;
}

/** Build the `complete` payload. Never throws (any doubt ⇒ today's full payload). Pure. */
export function buildCompleteEventPayload(input: CompleteEventInput): CompleteEventResult {
  // Today's payload, key order included.
  const full = { finalText: input.finalText, parts: input.parts, stopped: input.stopped, origin: input.origin, triggerKind: input.triggerKind };
  if (completeEventPartsOmitDisabled() || !input.finalPersisted) return { payload: full, omitted: false, partsBytes: null };
  let partsBytes: number;
  try {
    partsBytes = Buffer.byteLength(JSON.stringify(input.parts ?? []), 'utf8');
  } catch {
    return { payload: full, omitted: false, partsBytes: null };
  }
  if (partsBytes <= completeEventPartsMaxBytes()) return { payload: full, omitted: false, partsBytes };
  return {
    payload: {
      finalText: input.finalText,
      partsOmitted: true,
      partsBytes,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      stopped: input.stopped,
      origin: input.origin,
      triggerKind: input.triggerKind,
    },
    omitted: true,
    partsBytes,
  };
}

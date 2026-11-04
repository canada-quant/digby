/**
 * Server-side text-delta coalescer (0c158104, link 3): the agent emits one
 * 'text'/'reasoning' event PER PROVIDER CHUNK, which the durable event tap
 * then persists as one agent_events row per chunk — a 30k-token run = ~30k
 * rows, and every re-attach/stream replay re-fetches and re-frames all of
 * them (the "plays back my whole history" owner report). This buffers deltas
 * for a short window and flushes them as ONE event, preserving EXACT ordering
 * against non-delta events (flush-before-any-other-event at the call site)
 * and exact content (concatenation is lossless — the transcript accumulation
 * path in run-executor stays per-delta and is untouched).
 *
 * The 200ms window is below human streaming perception (deltas still paint
 * smoothly) and collapses ~50-200 chunks/sec into ~5 frames/sec.
 */

// Review 2026-09-13 issue 10: subagent deltas are coalesced too (they were 89%
// of agent_events inserts) — same delta shape, delimited per worker by the
// non-delta subagent_start / subagent:tool_call / subagent_end events.
export type DeltaKind = 'text' | 'reasoning' | 'subagent:text' | 'subagent:reasoning';

export interface DeltaCoalescer {
  /** Buffer one delta; the first buffered delta arms the window timer. */
  push(kind: DeltaKind, delta: string): void;
  /**
   * Emit any buffered deltas NOW (synchronously). MUST be called before any
   * non-delta event (ordering) and at run close (nothing left buffered).
   */
  flush(): void;
}

/** Time-batching window — 200ms per the 0c158104 investigation. */
export const DELTA_COALESCE_MS = 200;

export function createDeltaCoalescer(
  emit: (kind: DeltaKind, delta: string) => void,
  windowMs: number = DELTA_COALESCE_MS,
): DeltaCoalescer {
  // ONE buffer of ONE kind at a time (2026-08-28): the original design held
  // text and reasoning in separate buffers and flushed text-then-reasoning —
  // when the model interleaves thinking mid-sentence (kimi-k3 does), a window
  // containing both kinds re-ordered them and the transcript stitched wrong
  // (owner screenshot: "…step 5. Ver" | thought | "ifier watching…"). A kind
  // switch now flushes the pending buffer first, so emit order == arrival
  // order, always.
  let kind: DeltaKind | null = null;
  let buf = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (kind !== null && buf) { const k = kind; const b = buf; kind = null; buf = ''; emit(k, b); }
    else { kind = null; buf = ''; }
  };

  return {
    push(k, delta) {
      if (!delta) return;
      if (kind !== null && kind !== k) flush(); // kind switch → preserve arrival order
      kind = k;
      buf += delta;
      if (!timer) {
        timer = setTimeout(flush, windowMs);
        // A pending paint must never hold the worker process open.
        (timer as unknown as { unref?: () => void }).unref?.();
      }
    },
    flush,
  };
}

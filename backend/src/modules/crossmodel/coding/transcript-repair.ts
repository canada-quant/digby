/**
 * Transcript repair — normalize assistant tool_calls turns so every id is
 * answered CONTIGUOUSLY before any non-tool message.
 *
 * WHY (24h watch, 2026-09-08): providers hard-reject a conversation where an
 * assistant `tool_calls` turn is not immediately followed by a tool message
 * per id ("Invalid request: … tool_call_ids did not have response messages").
 * Two real shapes produced it in prod:
 *   1. the first derail-breaker pushed its harness notice INSIDE the dispatch
 *      loop, interleaving a user message between a batch's tool results
 *      (fixed at the source the same day — but live runs checkpointed the
 *      poisoned array, and a poisoned checkpoint 400s on EVERY subsequent
 *      model call until repaired);
 *   2. any future seam that ends a batch early (cancellation, crash) leaves
 *      trailing ids unanswered.
 *
 * The repair is a pure rebuild: for each assistant turn with tool_calls, its
 * matching tool messages (wherever they drifted before the next assistant
 * turn) are pulled up contiguously in id order; ids with no result anywhere
 * get a synthesized "[interrupted]" result; displaced non-tool messages keep
 * their relative order after the results. Untouched transcripts are returned
 * AS-IS (same reference) so callers can detect whether a repair happened.
 */

type Msg = {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
  tool_calls?: Array<{ id?: unknown } | null | undefined> | unknown;
  [k: string]: unknown;
};

export const INTERRUPTED_TOOL_RESULT =
  '[interrupted — this tool call never executed (the run was cut off before its result landed). Re-issue the call if the information is still needed.]';

/** True when some assistant tool_calls turn is not contiguously answered. */
export function transcriptNeedsRepair(messages: ReadonlyArray<unknown>): boolean {
  const msgs = messages as Msg[];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    const pending = new Set(
      (m.tool_calls as Array<{ id?: unknown }>).map(tc => tc?.id).filter((id): id is string => typeof id === 'string'),
    );
    let j = i + 1;
    while (j < msgs.length && msgs[j]?.role === 'tool' && pending.has(String(msgs[j]?.tool_call_id))) {
      pending.delete(String(msgs[j]?.tool_call_id));
      j++;
    }
    if (pending.size > 0) return true;
  }
  return false;
}

/**
 * Rebuild the transcript with every tool_calls turn contiguously answered.
 * Returns the ORIGINAL array (same reference) when nothing needed fixing.
 */
export function repairToolCallTranscript(messages: ReadonlyArray<unknown>): unknown[] {
  if (!transcriptNeedsRepair(messages)) return messages as unknown[];

  const msgs = messages as Msg[];
  const out: Msg[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) {
      out.push(m);
      i++;
      continue;
    }
    out.push(m);
    const ids = (m.tool_calls as Array<{ id?: unknown }>)
      .map(tc => tc?.id)
      .filter((id): id is string => typeof id === 'string');
    const idSet = new Set(ids);

    // The turn's "window" runs until the next assistant message: results for
    // this turn can only legally live there, however scrambled.
    let end = i + 1;
    while (end < msgs.length && msgs[end]?.role !== 'assistant') end++;

    const window = msgs.slice(i + 1, end);
    const resultsById = new Map<string, Msg>();
    const rest: Msg[] = [];
    for (const w of window) {
      const tid = w?.role === 'tool' ? String(w?.tool_call_id ?? '') : '';
      if (tid && idSet.has(tid) && !resultsById.has(tid)) resultsById.set(tid, w);
      else rest.push(w);
    }

    // Results in tool_calls order; missing ids get the synthesized result.
    for (const id of ids) {
      out.push(
        resultsById.get(id)
          ?? ({ role: 'tool', tool_call_id: id, content: INTERRUPTED_TOOL_RESULT } as Msg),
      );
    }
    // Displaced non-tool messages (harness notices, plan reminders…) keep
    // their relative order AFTER the fully-answered batch.
    out.push(...rest);
    i = end;
  }
  return out;
}

/**
 * interleaveSteers (owner report 2026-09-09 — "when the model finishes a run
 * the queued messages don't appear in chronological order").
 *
 * A coding run is persisted as ONE assistant row that spans the whole run
 * (created at run start by persistPartial, createdAt never restamped — it is
 * the paging cursor). Messages the user sends WHILE it runs are steers: each is
 * persisted at send time as a user row and folded into the run at its next
 * step. Live, the view shows the steer bubble at the bottom as it lands. After
 * the run, a plain createdAt sort puts the assistant row (run START) BEFORE
 * every steer sent during it — so the final answer renders above the very
 * questions it answered (the screenshot: three user bubbles stacked under the
 * completed answer).
 *
 * Fix, render-side and pure: the assistant row's parts are wall-clock stamped
 * (`ts`, backend push time, 2026-08+). For every steer whose createdAt falls
 * inside the run's span (assistant createdAt .. last part ts), the assistant
 * row is SPLIT at that instant into segments — parts before the steer, the
 * steer bubble, parts after — so the transcript reads exactly as it happened
 * live: work → your message → the agent folding it in → … → final answer.
 *
 * Contracts:
 *   - Input order is the server's (createdAt asc, id). Output preserves the
 *     relative order of everything it does not split.
 *   - Only USER rows following the assistant row and created before its last
 *     part ts are steers; a user row after the span is the next turn and stays
 *     put. Assistant rows without ts-stamped parts (pre-2026-08) are never
 *     split — legacy history renders as before.
 *   - Segments keep the row's fields; the LAST segment keeps the ORIGINAL id
 *     (it carries the final text — anything keyed by message id stays
 *     attached to the answer); earlier segments get `<id>::s<k>` ids and an
 *     empty `content` (they render parts only). Each segment's createdAt is
 *     its first part's ts so per-row timestamps stay truthful.
 *   - Parts without ts ride with the segment being built (they never move
 *     relative to their stamped neighbours).
 *   - Identity-preserving when nothing splits (no re-render churn).
 */

export interface InterleavablePart { ts?: string }
export interface InterleavableMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  parts?: InterleavablePart[];
}

/** Marker so renderers can tell a split-off segment from a real row. */
export const STEER_SEGMENT_ID_RE = /::s\d+$/;

function lastPartTs(parts: InterleavablePart[] | undefined): string | null {
  let max: string | null = null;
  for (const p of parts || []) if (p.ts && (!max || p.ts > max)) max = p.ts;
  return max;
}

export function interleaveSteers<T extends InterleavableMessage>(messages: T[]): T[] {
  let changed = false;
  const out: T[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.parts?.length) { out.push(m); i++; continue; }
    const end = lastPartTs(m.parts);
    if (!end) { out.push(m); i++; continue; }
    // Steers: the following user rows created before the run's last part.
    const steers: T[] = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'user' && messages[j].createdAt > m.createdAt && messages[j].createdAt < end) {
      steers.push(messages[j]); j++;
    }
    if (!steers.length) { out.push(m); i++; continue; }
    changed = true;
    // Split the parts at each steer's send time.
    let remaining = m.parts.slice();
    let seg = 0;
    for (const s of steers) {
      const before: InterleavablePart[] = [];
      let k = 0;
      // Parts stamped at/before the steer — plus unstamped parts riding along
      // with their stamped predecessors — go before the bubble.
      while (k < remaining.length && (!remaining[k].ts || remaining[k].ts! <= s.createdAt)) { before.push(remaining[k]); k++; }
      // Trailing UNSTAMPED parts that ran past the last qualifying stamped part
      // stay with the later segment (they belong to whatever follows).
      while (before.length && !before[before.length - 1].ts) { k--; before.pop(); }
      remaining = remaining.slice(k);
      if (before.length) {
        seg++;
        out.push({ ...m, id: `${m.id}::s${seg}`, content: '', parts: before, createdAt: before[0].ts || m.createdAt } as T);
      }
      out.push(s);
    }
    // The final segment keeps the original id (and the final text).
    out.push({ ...m, parts: remaining, createdAt: remaining[0]?.ts && remaining[0].ts > m.createdAt ? remaining[0].ts : m.createdAt } as T);
    i = j;
  }
  return changed ? out : messages;
}

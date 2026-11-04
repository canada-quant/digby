/**
 * Live-view mirror of backend/src/modules/crossmodel/coding/transcript-parts.ts
 * (owner transcript 2026-09-08): what a `draft_discarded` / `guard_marker`
 * stream event does to the parts array must match the executor's persisted
 * partial byte-for-byte, or the transcript reads one way live and another
 * after reload. IMMUTABLE variants (React state): new arrays/objects, inputs
 * untouched.
 */
import type { MessagePart } from './api/coding';
import type { TaskEventPayload } from './task-card';

/**
 * Retract the last `chars` characters of streamed TEXT from the tail: walks
 * back over trailing text parts (skipping reasoning parts — the model
 * interleaves thinking mid-answer) until the budget is spent or a non-prose
 * part (tool card, subagent, image, a harness marker) is hit. Text parts
 * emptied by the trim are dropped.
 */
export function trimTrailingTextParts(parts: MessagePart[], chars: number): MessagePart[] {
  let remaining = Math.max(0, Math.floor(Number(chars) || 0));
  if (remaining === 0) return parts;
  const next = parts.slice();
  for (let i = next.length - 1; i >= 0 && remaining > 0; i--) {
    const p = next[i];
    if (p.type === 'reasoning') continue;
    if (p.type !== 'text' || p.marker) break;
    const text = typeof p.text === 'string' ? p.text : '';
    const take = Math.min(remaining, text.length);
    remaining -= take;
    const rest = text.slice(0, text.length - take);
    if (rest.length) { next[i] = { ...p, text: rest }; break; }
    next.splice(i, 1);
  }
  return next;
}

/**
 * Append a harness guard marker as its OWN text part and, when `struckPrev`,
 * flag the most recent non-marker text part as a struck (rejected, never
 * submitted) draft. `stamp` decorates the new marker part (uid/ts).
 */
export function appendGuardMarkerParts(
  parts: MessagePart[],
  text: string,
  struckPrev: boolean,
  stamp: (p: MessagePart) => MessagePart = (p) => p,
): MessagePart[] {
  const next = parts.slice();
  if (struckPrev) {
    // The rejected TURN may span several text parts when reasoning interleaved
    // (kimi-k3 streams T/R/T…): strike every text part of the trailing prose
    // run, stopping at the first non-prose part or an earlier marker/struck
    // part (mirrors the backend helper).
    for (let i = next.length - 1; i >= 0; i--) {
      const p = next[i];
      if (p.type === 'reasoning') continue;
      if (p.type !== 'text' || p.marker || p.struck) break;
      next[i] = { ...p, struck: true };
    }
  }
  next.push(stamp({ type: 'text', text, marker: 'guard' }));
  return next;
}

/**
 * Inline task card (cohesive chat, 2026-09-28) — immutable mirror of the
 * backend's `upsertTaskPart` (coding/transcript-parts.ts): a `task` SSE event
 * REPLACES the part that already carries its taskId where it sits (ONE card
 * per task — never a second card per update) or appends a new task part at
 * the tail. `stamp` decorates a NEW part (uid/ts); a replaced part keeps its
 * uid so the card never remounts on an update. A payload without a string
 * taskId returns the same array.
 */
export function upsertTaskPartParts(
  parts: MessagePart[],
  task: TaskEventPayload,
  stamp: (p: MessagePart) => MessagePart = (p) => p,
): MessagePart[] {
  if (!task || typeof task.taskId !== 'string' || !task.taskId) return parts;
  const i = parts.findIndex(p => p.type === 'task' && !!p.task && p.task.taskId === task.taskId);
  const next = parts.slice();
  if (i >= 0) { next[i] = { ...next[i], task }; return next; }
  next.push(stamp({ type: 'task', task }));
  return next;
}

/**
 * Transcript-part helpers shared by the executor's mid-run `partial`
 * accumulator (run-executor.ts) and mirrored 1:1 in the frontend
 * (frontend/lib/transcript-parts.ts) for the live view — the two must agree
 * byte-for-byte on what a `draft_discarded` / `guard_marker` stream event does
 * to the parts array, or the owner sees one transcript live and another after
 * reload (owner transcript 2026-09-08, session a8976e11 firing-87: two
 * zero-tool fabricated audits read as ordinary prose in the live view).
 *
 * Pure functions over the minimal part shape; no imports.
 */

export interface TranscriptPartLike {
  type: string;
  text?: string;
  marker?: 'guard';
  struck?: boolean;
  [k: string]: unknown;
}

/**
 * Retract the last `chars` characters of streamed TEXT from the tail of
 * `parts`, IN PLACE: walks back over trailing text parts (skipping reasoning
 * parts — the model interleaves thinking mid-answer) until the budget is
 * spent or a non-prose part (tool call/result, subagent, image, a harness
 * marker) is hit — everything before such a boundary predates the discarded
 * turn. Text parts emptied by the trim are removed. Returns the number of
 * characters actually removed (≤ chars).
 */
export function trimTrailingText<T extends TranscriptPartLike>(parts: T[], chars: number): number {
  let remaining = Math.max(0, Math.floor(Number(chars) || 0));
  let removed = 0;
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.type === 'reasoning') continue;
    if (p.type !== 'text' || p.marker) break;
    const text = typeof p.text === 'string' ? p.text : '';
    const take = Math.min(remaining, text.length);
    remaining -= take;
    removed += take;
    const rest = text.slice(0, text.length - take);
    if (rest.length) { p.text = rest; break; }
    parts.splice(i, 1);
  }
  return removed;
}

/**
 * Append a harness guard marker as its OWN text part (never coalesced with
 * streamed text) and, when `struckPrev`, flag the most recent non-marker text
 * part as a struck (rejected, never submitted) draft. In place.
 */
export function appendGuardMarker<T extends TranscriptPartLike>(parts: T[], text: string, struckPrev: boolean): void {
  if (struckPrev) {
    // The rejected TURN may span several text parts when reasoning interleaved
    // mid-answer (kimi-k3 streams T/R/T…): strike every text part of the
    // trailing prose run, stopping at the first non-prose part or an earlier
    // marker/struck part (2026-09-08 audit — the first cut struck only the
    // last fragment).
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.type === 'reasoning') continue;
      if (p.type !== 'text' || p.marker || p.struck) break;
      p.struck = true;
    }
  }
  parts.push({ type: 'text', text, marker: 'guard' } as unknown as T);
}

/** True for a text part that carries the model's answer prose (not a harness marker, not a struck draft). */
export function isDeliveredTextPart(p: TranscriptPartLike | null | undefined): boolean {
  return !!p && p.type === 'text' && !p.marker && !p.struck;
}

// ── Inline task card (cohesive chat, 2026-09-28 — chat-agent/task-events.ts) ──

/** The part type that carries ONE task card's latest state on an assistant row. */
export const TASK_PART_TYPE = 'task';

/** True for a transcript part that carries a task card (a `task` object with a taskId). */
export function isTaskPart(p: TranscriptPartLike | null | undefined): boolean {
  return !!p && p.type === TASK_PART_TYPE && !!p.task && typeof p.task === 'object' && typeof (p.task as any).taskId === 'string';
}

/**
 * Upsert a task card into `parts` IN PLACE, keyed on `task.taskId`: the part
 * that already carries this task is REPLACED where it sits (ONE card per task
 * — never a second card per update), otherwise a new task part is appended at
 * the tail. Mirrored immutably in frontend/lib/transcript-parts.ts
 * (`upsertTaskPartParts`) so the live view and the persisted row agree on
 * what a `task` event does to the parts array. Returns the index the card
 * now occupies. A payload without a string taskId is ignored (returns -1).
 */
export function upsertTaskPart<T extends TranscriptPartLike>(parts: T[], task: { taskId: string }): number {
  if (!task || typeof task.taskId !== 'string' || !task.taskId) return -1;
  const i = parts.findIndex(p => isTaskPart(p) && (p.task as any).taskId === task.taskId);
  const part = { type: TASK_PART_TYPE, task } as unknown as T;
  if (i >= 0) { parts[i] = part; return i; }
  parts.push(part);
  return parts.length - 1;
}

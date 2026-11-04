/**
 * Inline canvas cards (Digby Frontier redesign, 2026-10-06): which assistant
 * answer produced which canvas. Canvases are saved during a run and the
 * answer row persists at its end, so a canvas belongs to the FIRST assistant
 * row created at or after it (within a bounded window — a file someone made
 * by hand long before the next answer is never pinned to it). Pure.
 */
export interface AttachableMessage { id: string; role: string; createdAt?: string | null }
export interface AttachableCanvas { id: string; createdAt?: string | null }

/** Anything older than this before the next answer is not that answer's file. */
export const CANVAS_ATTACH_WINDOW_MS = 30 * 60 * 1000;
/** Clock skew allowance between the canvas save and the answer row stamp. */
const SKEW_MS = 5_000;

export function attachCanvasesToMessages<C extends AttachableCanvas>(
  messages: readonly AttachableMessage[],
  canvases: readonly C[],
): Map<string, C[]> {
  const out = new Map<string, C[]>();
  const answers = messages
    .filter((m) => m.role === 'assistant' && m.createdAt && Number.isFinite(Date.parse(m.createdAt)))
    .map((m) => ({ id: m.id, t: Date.parse(m.createdAt as string) }))
    .sort((a, b) => a.t - b.t);
  for (const c of canvases) {
    if (!c.createdAt) continue;
    const ct = Date.parse(c.createdAt);
    if (!Number.isFinite(ct)) continue;
    const hit = answers.find((a) => a.t >= ct - SKEW_MS);
    if (!hit || hit.t - ct > CANVAS_ATTACH_WINDOW_MS) continue;
    const list = out.get(hit.id) ?? [];
    list.push(c);
    out.set(hit.id, list);
  }
  return out;
}

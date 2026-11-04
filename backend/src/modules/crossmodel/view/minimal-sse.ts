/**
 * Minimal view — the SSE seam (2026-10-16, see view-mode.ts / minimal-view.ts). One wrapper around an SSE
 * response filters every `data:` frame written through it, so the chat stream, the chat re-attach, the
 * cross-instance mirror attach and the post-run mirror replay all honour the viewer's mode without each
 * writer knowing about it. Comment frames (`: hb`) and non-JSON payloads pass through untouched.
 */

import { minimalEvent } from './minimal-view';
import type { ViewMode } from './view-mode';

/** Filter one written chunk (one or more SSE frames). null ⇒ nothing left to write. */
export function filterSseChunk(chunk: string): string | null {
  if (!chunk.includes('data: ')) return chunk;
  const frames = chunk.split('\n\n');
  const out: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame) { out.push(frame); continue; }
    const lines = frame.split('\n');
    const di = lines.findIndex(l => l.startsWith('data: '));
    if (di < 0) { out.push(frame); continue; }
    let parsed: any;
    try { parsed = JSON.parse(lines[di].slice(6)); } catch { out.push(frame); continue; }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') { out.push(frame); continue; }
    const kept = minimalEvent(parsed.type, parsed.data);
    if (!kept) continue;
    lines[di] = `data: ${JSON.stringify({ ...parsed, type: kept.type, data: kept.data })}`;
    out.push(lines.join('\n'));
  }
  const joined = out.join('\n\n');
  return joined.replace(/\n/g, '').length ? joined : null;
}

/**
 * Wrap an SSE response for one viewer. 'full' returns the same object (byte-for-byte today); 'minimal'
 * returns a proxy whose write() filters frames — every other property / method is the original's.
 */
export function wrapSseResponse<T extends object>(res: T, mode: ViewMode): T {
  if (mode !== 'minimal') return res;
  return new Proxy(res, {
    get(target, prop) {
      if (prop === 'write') {
        return (chunk: unknown, ...rest: unknown[]) => {
          if (typeof chunk !== 'string') return (target as any).write(chunk, ...rest);
          const out = filterSseChunk(chunk);
          if (out === null) return true;
          return (target as any).write(out, ...rest);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  });
}

import { describe, it, expect } from 'vitest';
import { isChunkLoadError, shouldReloadForChunkError, CHUNK_RELOAD_KEY, CHUNK_RELOAD_MIN_GAP_MS } from './chunk-reload';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m }; };

describe('chunk-reload — deploy-skew self-heal (2026-09-14)', () => {
  it('recognises the chunk-load error class and nothing else', () => {
    expect(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkLoadError(new Error('Loading chunk 1kdrjgaaa8mqc failed. (missing: https://digby.ai/_next/static/chunks/1kdrjgaaa8mqc.js)'))).toBe(true);
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: https://digby.ai/_next/static/chunks/app/page.js'))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError('string')).toBe(false);
  });

  it('reloads ONCE: the first chunk error reloads and stamps the clock, a second within the gap shows the boundary, after the gap it reloads again', () => {
    const s = mem();
    const err = Object.assign(new Error('Loading chunk abc failed'), { name: 'ChunkLoadError' });
    expect(shouldReloadForChunkError(err, s, 1_000_000)).toBe(true);
    expect(s.getItem(CHUNK_RELOAD_KEY)).toBe('1000000');
    expect(shouldReloadForChunkError(err, s, 1_000_000 + 5_000)).toBe(false);
    expect(shouldReloadForChunkError(err, s, 1_000_000 + CHUNK_RELOAD_MIN_GAP_MS + 1)).toBe(true);
  });

  it('never reloads for an ordinary error; tolerates missing or throwing storage', () => {
    expect(shouldReloadForChunkError(new Error('boom'), mem(), 5)).toBe(false);
    expect(shouldReloadForChunkError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }), null, 5)).toBe(true);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(shouldReloadForChunkError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }), throwing, 5)).toBe(false);
  });
});

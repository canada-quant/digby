/**
 * Chunk-load self-heal (2026-09-14). The blue-green deploy lands on box A
 * before box B, and the ALB alternates between them for a few minutes — a
 * page whose HTML came from the new box asks the old box for a chunk it does
 * not have (or vice-versa) and the app-root error boundary shows "Something
 * went wrong" for what is really a stale bundle. Such an error is fixed by
 * exactly one reload, so the boundary reloads ONCE (guarded by
 * sessionStorage so a genuinely broken bundle cannot loop) instead of making
 * the user click.
 */

export const CHUNK_RELOAD_KEY = 'digby:chunk-reload-at';
/** Two reloads closer together than this are treated as a loop — the second one shows the boundary instead. */
export const CHUNK_RELOAD_MIN_GAP_MS = 60_000;

const CHUNK_ERROR_RE = /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|Failed to load chunk|Unable to preload CSS|Loading CSS chunk/i;

/** True for the error class a deploy skew produces (a missing or mismatched Next.js chunk). */
export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: unknown; message?: unknown };
  return (typeof e.name === 'string' && e.name === 'ChunkLoadError')
    || (typeof e.message === 'string' && CHUNK_ERROR_RE.test(e.message));
}

export interface ReloadStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

/**
 * Decide whether the boundary should reload for this error now. Records the
 * attempt when it says yes. Pure over the injected storage + clock.
 */
export function shouldReloadForChunkError(err: unknown, storage: ReloadStorage | null | undefined, now: number = Date.now()): boolean {
  if (!isChunkLoadError(err)) return false;
  if (!storage) return true; // no storage (private mode) — one reload is still the better bet
  try {
    const last = Number(storage.getItem(CHUNK_RELOAD_KEY) ?? 0);
    if (Number.isFinite(last) && last > 0 && now - last < CHUNK_RELOAD_MIN_GAP_MS) return false;
    storage.setItem(CHUNK_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

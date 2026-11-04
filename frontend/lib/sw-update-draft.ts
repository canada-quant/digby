/**
 * Service-worker-update draft preservation (UI overhaul P5).
 *
 * UpdateNotification force-reloads the page when a new service worker version
 * lands. Before P5 that reload silently DISCARDED whatever the user had typed
 * into a chat composer. Now, just before reloading, UpdateNotification
 * dispatches SW_RELOAD_EVENT on window; every mounted ChatComposerTextarea
 * listens and stashes its non-empty draft into sessionStorage keyed by the
 * page path, and the next composer to mount on that path restores it
 * (one-shot, freshness-bounded so an orphaned stash from a reload that never
 * happened can't resurface much later).
 *
 * Pure helpers take the storage explicitly (node-environment vitest — the
 * use-resizable.ts convention).
 */

/** Dispatched on window by UpdateNotification right before location.reload(). */
export const SW_RELOAD_EVENT = 'digby:sw-reload';

const KEY_PREFIX = 'digby.composer.swdraft:';

/** A stash older than this never restores — the reload it was written for is long gone. */
export const DRAFT_RESTORE_WINDOW_MS = 60_000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Stash a composer draft for the given page path. Empty/whitespace drafts are not stashed. */
export function stashDraft(path: string, text: string, storage: StorageLike, now = Date.now()): void {
  if (!text.trim()) return;
  try {
    storage.setItem(KEY_PREFIX + path, JSON.stringify({ text, ts: now }));
  } catch {
    /* storage full/unavailable — the draft is lost on reload, as before P5 */
  }
}

/**
 * Take (read + remove) the stashed draft for a page path. Returns null when
 * there is none, it is malformed, or it is older than DRAFT_RESTORE_WINDOW_MS.
 * Always one-shot: the key is removed even when the stash is rejected.
 */
export function takeStashedDraft(path: string, storage: StorageLike, now = Date.now()): string | null {
  try {
    const raw = storage.getItem(KEY_PREFIX + path);
    if (!raw) return null;
    storage.removeItem(KEY_PREFIX + path);
    const parsed = JSON.parse(raw) as { text?: unknown; ts?: unknown };
    if (typeof parsed.text !== 'string' || !parsed.text.trim()) return null;
    const ts = typeof parsed.ts === 'number' ? parsed.ts : 0;
    if (now - ts > DRAFT_RESTORE_WINDOW_MS) return null;
    return parsed.text;
  } catch {
    return null;
  }
}

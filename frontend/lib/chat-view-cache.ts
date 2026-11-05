/**
 * Retained sidebar chat list (ticket b5734922 — owner report 2026-11-04: "every
 * navigation away from chats and back causes a long wait; why are chats not
 * cached?").
 *
 * WHY THIS EXISTS: `/account`, `/files` and `/management` are sibling routes
 * under the same segment layout, so navigating to any of them and back
 * UNMOUNTS `app/crossmodel/page.tsx` and everything it renders. React state
 * dies with the unmount, so on return the rail re-fetches from zero and paints
 * "Loading chats…" skeletons until `listChats` settles — `sidebarHydrated` is
 * a one-shot gate that only flips once chats, folders and running all settle.
 * Module scope is the one thing that survives a client-side navigation, which
 * is exactly why the coding transcript has kept a module-level snapshot since
 * 2026-08-31 (CodeSessionView's `sessionSnapshots`).
 *
 * SCOPE NOTE: the transcript half of that same owner report was fixed
 * separately and already on main (`a870164d9`, PR #2485 — plain chats paint
 * their transcript from a snapshot on re-open, `lib/plain-transcript-snapshot
 * .ts`). This module is deliberately the OTHER half — the sidebar list, which
 * #2485 did not touch — so the two do not overlap.
 *
 * The contract is stale-while-revalidate:
 *
 *   read()  → render the retained rows INSTANTLY (no skeleton, no empty state)
 *   the caller's normal fetch still runs on every mount and REPLACES the
 *   retained rows when it lands — the server is the single source of truth.
 *
 * CORRECTNESS — "never show a chat the server no longer has":
 * a retained entry is only ever a FIRST PAINT. `fetchChatList` keeps its
 * existing `setChats(chatsArr)` wholesale replace, and `patchRetainedChat`
 * keeps the retained page in step with every local row change (delete,
 * archive, rename), so a chat removed or changed elsewhere reconciles within
 * one round trip. A retained entry can delay the truth by that round trip; it
 * can never overwrite it.
 *
 * DELIBERATELY MEMORY-ONLY (no localStorage): a persisted store would outlive
 * a full page load, i.e. it would survive a DEPLOY. Serving pre-deploy chat
 * rows into a post-deploy bundle is the version-skew class that produces
 * genuinely stale rows (and makes a "row that no longer exists" bug reachable).
 * A module Map dies with the document, so the worst case is bounded by one
 * navigation. The guest store (guest-sessions.ts) is the only chat data that
 * warrants surviving a reload, because a guest transcript has NO server copy to
 * revalidate against.
 *
 * The clock and the TTL are injected/exported so the behaviour is unit
 * testable in the node-environment suite (the provision-queue.ts /
 * sw-update-draft.ts convention).
 */

/** Chat-list first paint. Shorter than the transcript's: the rail is the
 *  navigation surface, and a stale rail mis-orders the user's own recents. */
export const CHAT_LIST_CACHE_TTL_MS = 10 * 60 * 1000;

/** The sidebar only ever needs the first page — same bound as the fetch. */
export const CHAT_LIST_CACHE_MAX = 1;

export interface CacheEntry<T> {
  /** The retained value. */
  value: T;
  /** Epoch ms the entry was written (for callers that want to show an age). */
  at: number;
}

export interface RetainedCache<T> {
  /** Retained value for `key`, or null when absent/expired (expired ⇒ dropped). */
  read(key: string, now?: number): CacheEntry<T> | null;
  /** Retain `value` for `key` (re-inserts at the tail = most-recently-used). */
  write(key: string, value: T, now?: number): void;
  /** Drop one key — called from every delete path so a dead chat can't re-render. */
  purge(key: string): void;
  /** Drop everything (logout / account switch must not leak another user's rows). */
  clear(): void;
  /** Retained entry count. */
  size(): number;
}

export interface RetainedCacheOptions {
  ttlMs: number;
  max: number;
  /** Injected clock (tests); defaults to Date.now. */
  now?: () => number;
}

/**
 * Build a TTL + LRU retained cache. Pure module state, no I/O, no storage —
 * the entire contract is {@link RetainedCache}.
 */
export function createRetainedCache<T>(opts: RetainedCacheOptions): RetainedCache<T> {
  const { ttlMs, max } = opts;
  const clock = opts.now ?? (() => Date.now());
  const store = new Map<string, CacheEntry<T>>();

  const isExpired = (entry: CacheEntry<T>, now: number): boolean =>
    // A negative/absent timestamp reads as expired rather than valid-forever:
    // a corrupted entry must never be presented as fresh.
    !Number.isFinite(entry.at) || now - entry.at > ttlMs;

  return {
    read(key, now = clock()) {
      if (!key) return null;
      const entry = store.get(key);
      if (!entry) return null;
      if (isExpired(entry, now)) {
        store.delete(key);
        return null;
      }
      // Touch: re-insert at the tail so the LRU eviction below retires the
      // genuinely oldest visit, not the oldest write.
      store.delete(key);
      store.set(key, entry);
      return entry;
    },

    write(key, value, now = clock()) {
      if (!key) return;
      store.delete(key);
      store.set(key, { value, at: now });
      while (store.size > Math.max(1, max)) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },

    purge(key) {
      if (!key) return;
      store.delete(key);
    },

    clear() {
      store.clear();
    },

    size() {
      return store.size;
    },
  };
}

/**
 * Plain-chat transcript snapshot (ticket ce78ab80, owner report 2026-11-04:
 * "how come everytime i navigate away from chats and then back i have to wait
 * so long for chats to load? arent they in cache or anything ?").
 *
 * WHY: the CODING path has had a module-level transcript snapshot since
 * 2026-08-31 (CodeSessionView `readSessionSnapshot`) — a remount renders the
 * cached transcript instantly and revalidates in the background, so no
 * "Opening session" spinner, no waiting on the round trip. The PLAIN path
 * never got one: its load effect zeroes the transcript (`setMessages([])`) and
 * then waits on a blocking `getChat(chatId, { messageLimit: 50 })`, so every
 * re-open of a plain chat is an empty screen plus a full round trip — and the
 * backend handler behind that GET is not cheap (access + chat + transcript
 * page + attachment batch + author batch + pending queue + capability +
 * view-mode). Switching from a coding session to a plain chat therefore made
 * the ONE surface with a cache the exception, not the rule.
 *
 * This module holds the store (pure + bounded, unit-tested) so the view keeps
 * only the wiring. Semantics are deliberately identical to the coding
 * snapshot's, so the two paths cannot drift:
 *
 *  · MEMORY-ONLY. A module-level Map dies with the page; nothing is written to
 *    localStorage/sessionStorage, so a reload never resurrects a transcript
 *    (the 2026-10-27 stale-delete report — a deleted chat re-opened from a
 *    cached transcript — is answered by `purge` plus this lifetime rule).
 *  · BOUNDED. Both a TTL and an entry cap; the entry cap evicts
 *    least-recently-written first, so browsing many chats keeps the few you
 *    actually return to.
 *  · A HIT IS A HINT, NEVER THE RECORD. The caller always revalidates
 *    (revalidate-in-background); the fetch stays authoritative and replaces
 *    the painted rows when it lands.
 */

/** How long a painted snapshot stays fresh enough to skip the cold open. */
export const PLAIN_SNAPSHOT_TTL_MS = 15 * 60 * 1000;

/** How many plain chats keep a snapshot (LRU by write). Plain chats are the
 *  common case, so this is a little wider than the coding cache's 5. */
export const PLAIN_SNAPSHOT_MAX = 8;

/** The four things the plain view must paint before its transcript GET lands. */
export interface PlainSnapshotPayload<T> {
  messages: T[];
  paging: { hasMore: boolean; cursor: string | null };
  /** Server-listed queued rows live in their own partition (ticket c0b2b0c8) —
   *  without these the queued bubbles vanish on the instant paint. */
  pendingIds: string[];
  /** Supervisor chats localize timestamps and fold machine rows differently. */
  supervisorChat: boolean;
}

export interface PlainSnapshot<T> extends PlainSnapshotPayload<T> {
  /** Epoch ms the snapshot was written (TTL anchor). */
  at: number;
}

export interface SnapshotStore<T> {
  /** The snapshot for `chatId`, or null when absent or past its TTL (an
   *  expired entry is dropped on read, so a stale row can never linger). */
  read(chatId: string): PlainSnapshot<T> | null;
  /** Store (or refresh) `chatId`. Re-inserts at the tail, so the entry cap
   *  evicts the least-recently-WRITTEN chat, not the least-recently-opened. */
  write(chatId: string, payload: PlainSnapshotPayload<T>): void;
  /** Drop one chat (delete/archive/terminal 404 — the stale-view rule). */
  drop(chatId: string): void;
  /** Live entry count (tests + diagnostics). */
  size(): number;
}

/**
 * Build a bounded, TTL'd snapshot store. `now` is injectable so the TTL and
 * eviction rules are unit-testable without fake timers.
 */
export function createSnapshotStore<T>(
  opts: { ttlMs?: number; max?: number; now?: () => number } = {},
): SnapshotStore<T> {
  const ttlMs = opts.ttlMs ?? PLAIN_SNAPSHOT_TTL_MS;
  const max = opts.max ?? PLAIN_SNAPSHOT_MAX;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, PlainSnapshot<T>>();

  return {
    read(chatId: string): PlainSnapshot<T> | null {
      const snap = entries.get(chatId);
      if (!snap) return null;
      if (now() - snap.at > ttlMs) {
        entries.delete(chatId);
        return null;
      }
      return snap;
    },

    write(chatId: string, payload: PlainSnapshotPayload<T>): void {
      // Delete-then-set re-inserts at the tail: Map preserves insertion order,
      // so the first key is always the least-recently-written one.
      entries.delete(chatId);
      entries.set(chatId, { ...payload, at: now() });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },

    drop(chatId: string): void {
      entries.delete(chatId);
    },

    size(): number {
      return entries.size;
    },
  };
}
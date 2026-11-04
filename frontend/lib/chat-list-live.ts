/**
 * Sidebar live refresh (ticket d6b2eef5, 2026-09-28) — pure helpers.
 *
 * WHY: the sidebar's chat list was fetched on mount only, so a session a
 * supervisor spawned (or a rename / re-parent / folder move made elsewhere)
 * never appeared until a reload. The page now polls
 * `GET /chats/changes?since=<watermark>` (the rows updated at/after the newest
 * updatedAt it has seen — the same lineage-completed row shape as the list)
 * on the cadence the running-sessions reconcile already uses, and kicks an
 * immediate delta when that reconcile reports a running id the sidebar does
 * not know. These helpers hold the merge and the watermark; the React wiring
 * lives in app/crossmodel/page.tsx.
 *
 * (The server's SIDEBAR_CHANGES_FEED_DISABLED kill switch was deleted in build 2026-10-08 S-2.)
 */

/** Poll cadence: fast while a coding spinner is visible (a spawn is imminent), slow when idle. */
export const CHAT_LIST_LIVE_ACTIVE_MS = 15_000;
export const CHAT_LIST_LIVE_IDLE_MS = 60_000;
/** Rows per delta page (the server caps at 50). */
export const CHAT_LIST_LIVE_LIMIT = 50;

export interface LiveChatRow {
  id: string;
  updatedAt?: string | null;
  /** The list rows carry `messages: []` for backward compat — never let it clobber a loaded transcript. */
  messages?: unknown[];
}

/** The newest `updatedAt` among `rows`, or `floor` when none is newer (ISO strings compare lexically). */
export function newestUpdatedAt(rows: ReadonlyArray<LiveChatRow>, floor: string | null = null): string | null {
  let best = floor;
  for (const r of rows) {
    const t = typeof r.updatedAt === 'string' ? r.updatedAt : null;
    if (t && (!best || t > best)) best = t;
  }
  return best;
}

export interface MergeResult<T> {
  rows: T[];
  /** false ⇒ `rows` is the SAME array as `prev` (no re-render). */
  changed: boolean;
  added: string[];
  updated: string[];
}

const shallowDiffers = (prev: Record<string, unknown>, next: Record<string, unknown>): boolean => {
  for (const k of Object.keys(next)) {
    if (k === 'messages') continue;
    const a = prev[k];
    const b = next[k];
    if (a === b) continue;
    if (a instanceof Date || b instanceof Date) { if (String(a) !== String(b)) return true; continue; }
    if (typeof a === 'object' && typeof b === 'object' && a && b) { if (JSON.stringify(a) !== JSON.stringify(b)) return true; continue; }
    return true;
  }
  return false;
};

/**
 * Upsert `incoming` (newest first, as the server orders it) into `prev`:
 *   · a known id refreshes in place (fields overwrite; the local `messages`
 *     transcript is kept — the delta rows carry an empty one) and keeps its
 *     position, so a list the user is reading never jumps under them;
 *   · an unknown id is prepended, preserving the incoming order.
 * Returns the SAME array when nothing changed.
 */
export function mergeChatRows<T extends LiveChatRow>(prev: ReadonlyArray<T>, incoming: ReadonlyArray<T>): MergeResult<T> {
  if (incoming.length === 0) return { rows: prev as T[], changed: false, added: [], updated: [] };
  const byId = new Map(prev.map((r, i) => [r.id, i]));
  const next = [...prev];
  const added: string[] = [];
  const updated: string[] = [];
  const fresh: T[] = [];
  for (const row of incoming) {
    if (!row || typeof row.id !== 'string') continue;
    const idx = byId.get(row.id);
    if (idx === undefined) {
      if (!fresh.some((f) => f.id === row.id)) { fresh.push(row); added.push(row.id); }
      continue;
    }
    const cur = next[idx];
    if (!shallowDiffers(cur as Record<string, unknown>, row as Record<string, unknown>)) continue;
    next[idx] = { ...cur, ...row, messages: cur.messages ?? row.messages ?? [] };
    updated.push(row.id);
  }
  if (added.length === 0 && updated.length === 0) return { rows: prev as T[], changed: false, added, updated };
  return { rows: [...fresh, ...next], changed: true, added, updated };
}

/**
 * Running ids the sidebar has no row for — a spawned session that is already
 * running is the strongest "something is missing" signal; the caller kicks an
 * immediate delta for them (once per id — `kicked` is the caller's memo).
 */
export function unknownRunningIds(running: Iterable<string>, known: ReadonlySet<string>, kicked: Set<string>): string[] {
  const out: string[] = [];
  for (const id of running) {
    if (known.has(id) || kicked.has(id)) continue;
    kicked.add(id);
    out.push(id);
  }
  return out;
}

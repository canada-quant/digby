/**
 * Files-tab ordering + last-modified labels (owner 2026-09-17: "show last
 * modified/created date and sort most recently changed files to the top").
 *
 * Pure helpers so the tree component stays a renderer. Folders always lead
 * (the tree is navigated top-down); within each group:
 *   - 'recent' (default): newest mtime first; rows without an mtime (a
 *     tracked file gone from disk, an old snapshot) sink to the bottom; ties
 *     break by name.
 *   - 'name': plain codepoint order (identical everywhere — localeCompare
 *     drifts with the host's ICU build).
 */

export type WorktreeSortMode = 'recent' | 'name';

export const WORKTREE_SORT_STORAGE_KEY = 'digby.worktreeSort.v1';
export const DEFAULT_WORKTREE_SORT: WorktreeSortMode = 'recent';

export function isWorktreeSortMode(v: unknown): v is WorktreeSortMode {
  return v === 'recent' || v === 'name';
}

interface SortableEntry {
  name: string;
  type: 'file' | 'dir';
  mtime?: number;
}

const byName = (a: SortableEntry, b: SortableEntry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function sortWorktreeEntries<T extends SortableEntry>(entries: readonly T[], mode: WorktreeSortMode): T[] {
  const out = [...entries];
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    if (mode === 'recent') {
      const am = typeof a.mtime === 'number' ? a.mtime : -Infinity;
      const bm = typeof b.mtime === 'number' ? b.mtime : -Infinity;
      if (am !== bm) return bm - am; // newest first; missing sinks
    }
    return byName(a, b);
  });
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Compact relative label for a row: "just now", "5m ago", "3h ago", "2d ago",
 * then a short date ("Sep 12", or "Sep 12, 2025" across a year boundary).
 * Never a future tense — a clock ahead of the server reads as "just now".
 */
export function formatRelativeTime(mtime: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - mtime);
  const sec = Math.round(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const d = new Date(mtime);
  const n = new Date(now);
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === n.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

/** Full local timestamp for tooltips. */
export function formatFullTime(mtime: number): string {
  try {
    return new Date(mtime).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return new Date(mtime).toISOString();
  }
}

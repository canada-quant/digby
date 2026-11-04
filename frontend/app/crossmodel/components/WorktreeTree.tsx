'use client';

/**
 * WorktreeTree — lazy, read-only file tree of a coding session's worktree
 * (feedback ticket 999e3dbe, Phase 1). Sits in the WorkspacePanel Files
 * section's "Worktree" sub-tab (CodingFilesTabs) for coding sessions.
 *
 * Data: GET /chats/:chatId/worktree/tree returns ONE directory level per call,
 * so expanding a folder fetches just that level. Fetched levels are cached in
 * component state (a refresh button + the show-ignored toggle invalidate);
 * loads are single-flight per directory and a generation counter discards
 * responses that land after a chat switch / toggle / refresh (stale guard).
 *
 * Phase-1 scope: READ-ONLY. Clicking a file delegates to `onOpenFile` (the
 * host opens it in the canvas panel as a read-only preview); there is no diff
 * view, no edit-in-place, no mutations. Rendering is a plain recursive list —
 * the backend caps a level at 5000 entries, so no virtualization (the repo
 * does not use @tanstack/react-virtual anywhere else).
 *
 * Error surfaces (honest states, never a crash):
 *   - root 404  → empty state ("No worktree yet") — the worktree is
 *                 provisioned on the first run and reaped some time after
 *                 the last one, so this is normal, not an error.
 *   - root other failure → LoadErrorState with Retry.
 *   - child-level failure → an inline error row under the folder with Retry.
 *   - 'D'-badged rows (tracked but deleted from disk) are non-clickable.
 *
 * a11y: APG tree roles (tree / treeitem / group, aria-level, aria-expanded on
 * dirs, aria-selected on the file currently open in the canvas).
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadErrorState } from '@/components/ui/load-error-state';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  ArrowDownAZ,
  Clock,
  FileText,
  Folder,
  FolderOpen,
  FolderGit2,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { getWorktreeTree, type WorktreeTreeEntry } from '@/lib/api/crossmodel';
import {
  DEFAULT_WORKTREE_SORT,
  WORKTREE_SORT_STORAGE_KEY,
  formatFullTime,
  formatRelativeTime,
  isWorktreeSortMode,
  sortWorktreeEntries,
  type WorktreeSortMode,
} from '@/lib/worktree-sort';

/** The persisted sort choice (per browser); the default is "recent first"
 *  (owner 2026-09-17). Storage can be absent or throw — fall back quietly. */
function readStoredSort(): WorktreeSortMode {
  try {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(WORKTREE_SORT_STORAGE_KEY) : null;
    return isWorktreeSortMode(v) ? v : DEFAULT_WORKTREE_SORT;
  } catch {
    return DEFAULT_WORKTREE_SORT;
  }
}

/** Canvas-item id prefix for worktree previews (CanvasPanel + CodeSessionView
    key read-only handling off the readOnly flag; this prefix keys identity). */
export const WORKTREE_CANVAS_PREFIX = 'worktree:';

/** Git status badge metadata — dark-capable class sets, mirroring canvas-meta
    TYPE_COLORS. '?' is git's untracked marker. */
const STATUS_META: Record<string, { label: string; className: string }> = {
  M: { label: 'Modified', className: 'text-warn-ink bg-warn/10 border-warn/40' },
  A: { label: 'Added', className: 'text-success bg-success-soft border-success-border' },
  D: { label: 'Deleted', className: 'text-destructive bg-destructive/10 border-destructive/40' },
  '?': { label: 'Untracked', className: 'text-ink-2 bg-hover dark:bg-hover/20 border-line' },
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

type DirStatus = 'loading' | 'error' | 'ready';

interface DirState {
  status: DirStatus;
  entries: WorktreeTreeEntry[];
  truncated: boolean;
  /** HTTP status of the failure (404 at the root = the no-worktree empty state). */
  statusCode?: number;
}

export interface WorktreeTreeProps {
  /** Coding-session chat id (the worktree is chatId-keyed server-side). */
  chatId: string;
  /** Worktree-relative path of the file currently open in the canvas, if any
      (drives aria-selected + the row highlight). */
  activePath?: string | null;
  /** A file row was activated — the host opens the read-only canvas preview. */
  onOpenFile: (path: string) => void;
  className?: string;
}

function WorktreeTree({ chatId, activePath, onOpenFile, className }: WorktreeTreeProps) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Record<string, true>>({});
  const [showIgnored, setShowIgnored] = useState(false);
  // Sort (owner 2026-09-17): most-recently-changed first by default, A–Z on
  // toggle; the choice persists per browser. Client-side over each fetched
  // level — the server keeps its stable dirs-first-by-name order.
  const [sortMode, setSortMode] = useState<WorktreeSortMode>(readStoredSort);
  const toggleSort = useCallback(() => {
    setSortMode(prev => {
      const next: WorktreeSortMode = prev === 'recent' ? 'name' : 'recent';
      try { window.localStorage.setItem(WORKTREE_SORT_STORAGE_KEY, next); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);
  // One clock per render for the relative labels ("3m ago") — a re-render on
  // any state change refreshes them; a slightly stale label is fine.
  const now = Date.now();
  // expandedRef mirrors `expanded` so the reload path (effect/refresh/toggle)
  // can re-prime open dirs without depending on state identity.
  const expandedRef = useRef<Record<string, true>>({});
  // Stale guard: bumped by every invalidation (chat switch, show-ignored
  // toggle, manual refresh); a fetch that started under an older generation
  // discards its result instead of writing foreign rows into the new tree.
  const generationRef = useRef(0);
  // Single-flight per directory path — a double-click or StrictMode re-run
  // never doubles a level fetch.
  const inFlightRef = useRef<Set<string>>(new Set());
  const lastChatRef = useRef<string | null>(null);

  const setExpandedBoth = useCallback((next: Record<string, true>) => {
    expandedRef.current = next;
    setExpanded(next);
  }, []);

  const loadDir = useCallback(async (rel: string) => {
    if (!chatId || inFlightRef.current.has(rel)) return;
    const gen = generationRef.current;
    inFlightRef.current.add(rel);
    setDirs(prev => ({
      ...prev,
      [rel]: { status: 'loading', entries: prev[rel]?.entries ?? [], truncated: false },
    }));
    try {
      const res = await getWorktreeTree(chatId, rel, showIgnored);
      if (generationRef.current !== gen) return; // stale — a newer tree owns state
      setDirs(prev => ({
        ...prev,
        [rel]: { status: 'ready', entries: res.entries || [], truncated: !!res.truncated },
      }));
    } catch (e: any) {
      if (generationRef.current !== gen) return;
      setDirs(prev => ({
        ...prev,
        [rel]: { status: 'error', entries: [], truncated: false, statusCode: e?.response?.status },
      }));
    } finally {
      inFlightRef.current.delete(rel);
    }
  }, [chatId, showIgnored]);

  /** Invalidate every cached level, then re-prime the root + all open dirs. */
  const reloadAll = useCallback(() => {
    generationRef.current += 1;
    inFlightRef.current.clear();
    setDirs({});
    if (!chatId) return;
    void loadDir('');
    for (const p of Object.keys(expandedRef.current)) {
      if (p) void loadDir(p);
    }
  }, [chatId, loadDir]);

  // Chat switch / show-ignored flip: full invalidation. A chat switch also
  // collapses the tree (paths are chat-scoped); the toggle keeps expansion.
  useEffect(() => {
    if (lastChatRef.current !== chatId) {
      lastChatRef.current = chatId;
      setExpandedBoth({});
    }
    reloadAll();
  }, [chatId, showIgnored, reloadAll, setExpandedBoth]);

  const toggleDir = useCallback((rel: string) => {
    if (expandedRef.current[rel]) {
      const next = { ...expandedRef.current };
      delete next[rel];
      setExpandedBoth(next);
    } else {
      setExpandedBoth({ ...expandedRef.current, [rel]: true });
      // First expand (or re-expand after an error) fetches the level; a
      // cached ready level renders instantly.
      const d = dirs[rel];
      if (!d || d.status === 'error') void loadDir(rel);
    }
  }, [dirs, loadDir, setExpandedBoth]);

  const root = dirs[''];

  // ── Row renderers ──────────────────────────────────────────────────────────

  const renderStatusBadge = (status: string) => {
    const meta = STATUS_META[status];
    if (!meta) return null;
    return (
      <Badge
        variant="outline"
        title={meta.label}
        className={cn('text-[10px] size-4 p-0 justify-center font-mono flex-shrink-0', meta.className)}
      >
        {status}
      </Badge>
    );
  };

  const renderEntry = (entry: WorktreeTreeEntry, depth: number) => {
    const indent = 8 + depth * 14; // 14px per tree level
    if (entry.type === 'dir') {
      const isOpen = !!expanded[entry.path];
      const d = dirs[entry.path];
      const loading = isOpen && d?.status === 'loading';
      return (
        <li key={`d:${entry.path}`} role="treeitem" aria-expanded={isOpen} aria-level={depth + 1} aria-selected={false}>
          <button
            type="button"
            onClick={() => toggleDir(entry.path)}
            title={entry.path}
            className="w-full flex items-center gap-1.5 py-1 pr-2 rounded-sm text-left hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            style={{ paddingLeft: indent }}
          >
            {loading ? (
              <Loader2 className="size-3.5 flex-shrink-0 animate-spin text-muted-foreground" />
            ) : isOpen ? (
              <ChevronDown className="size-3.5 flex-shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 flex-shrink-0 text-muted-foreground" />
            )}
            {isOpen ? (
              <FolderOpen className="size-4 flex-shrink-0 text-warn-ink" />
            ) : (
              <Folder className="size-4 flex-shrink-0 text-warn-ink" />
            )}
            <span className="flex-1 min-w-0 truncate text-sm text-foreground">{entry.name}</span>
            {typeof entry.mtime === 'number' && (
              <span
                className="flex-shrink-0 text-[10px] text-muted-foreground/60 tabular-nums"
                title={`Last changed ${formatFullTime(entry.mtime)}`}
                data-worktree-mtime={entry.mtime}
              >
                {formatRelativeTime(entry.mtime, now)}
              </span>
            )}
            {entry.status && renderStatusBadge(entry.status)}
          </button>
          {isOpen && (
            <ul role="group">
              {renderDirContents(entry.path, depth + 1)}
            </ul>
          )}
        </li>
      );
    }
    // File row. A 'D' badge means tracked-but-deleted-from-disk — there is no
    // content to view, so the row is inert (never a guaranteed-failing click).
    const deleted = entry.status === 'D';
    const isActive = activePath === entry.path;
    return (
      <li key={`f:${entry.path}`} role="treeitem" aria-level={depth + 1} aria-selected={isActive}>
        <button
          type="button"
          onClick={() => !deleted && onOpenFile(entry.path)}
          disabled={deleted}
          title={deleted ? `${entry.path} — deleted from disk` : typeof entry.mtime === 'number' ? `${entry.path} — last changed ${formatFullTime(entry.mtime)}` : entry.path}
          aria-current={isActive ? 'true' : undefined}
          className={cn(
            'w-full flex items-center gap-1.5 py-1 pr-2 rounded-sm text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            deleted ? 'opacity-50 cursor-default' : 'hover:bg-muted/50',
            isActive && 'bg-muted',
          )}
          style={{ paddingLeft: indent + 14 /* no chevron — align with dir labels */ }}
        >
          <FileText className="size-4 flex-shrink-0 text-ink-3" />
          <span className={cn('flex-1 min-w-0 truncate text-sm text-foreground', deleted && 'line-through')}>
            {entry.name}
          </span>
          {typeof entry.size === 'number' && !deleted && (
            <span className="flex-shrink-0 text-[10px] text-muted-foreground/70">{formatSize(entry.size)}</span>
          )}
          {typeof entry.mtime === 'number' && !deleted && (
            <span
              className="flex-shrink-0 text-[10px] text-muted-foreground/60 tabular-nums"
              data-worktree-mtime={entry.mtime}
            >
              {formatRelativeTime(entry.mtime, now)}
            </span>
          )}
          {entry.status && renderStatusBadge(entry.status)}
        </button>
      </li>
    );
  };

  /** The children of one expanded directory: entries, or its loading/error/
      empty/truncated rows. */
  const renderDirContents = (rel: string, depth: number) => {
    const d = dirs[rel];
    if (!d || d.status === 'loading') {
      return (
        <li role="treeitem" aria-level={depth + 1} aria-selected={false}>
          <div className="flex items-center gap-1.5 py-1 pr-2 text-xs text-muted-foreground" style={{ paddingLeft: 8 + depth * 14 + 14 }}>
            <Loader2 className="size-3 animate-spin" /> Loading…
          </div>
        </li>
      );
    }
    if (d.status === 'error') {
      return (
        <li role="treeitem" aria-level={depth + 1} aria-selected={false}>
          <div className="flex items-center gap-1.5 py-1 pr-2 text-xs text-destructive" style={{ paddingLeft: 8 + depth * 14 + 14 }}>
            <span className="flex-1 min-w-0 truncate">Couldn&apos;t load this folder.</span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void loadDir(rel)}>
              Retry
            </Button>
          </div>
        </li>
      );
    }
    return (
      <>
        {d.entries.length === 0 && (
          <li role="treeitem" aria-level={depth + 1} aria-selected={false}>
            <div className="py-1 pr-2 text-xs text-muted-foreground/70 italic" style={{ paddingLeft: 8 + depth * 14 + 14 }}>
              (empty)
            </div>
          </li>
        )}
        {sortWorktreeEntries(d.entries, sortMode).map(e => renderEntry(e, depth))}
        {d.truncated && (
          <li role="treeitem" aria-level={depth + 1} aria-selected={false}>
            <div className="py-1 pr-2 text-[10px] text-muted-foreground/70" style={{ paddingLeft: 8 + depth * 14 + 14 }}>
              Showing the first 5,000 entries — this folder has more.
            </div>
          </li>
        )}
      </>
    );
  };

  // ── Panel states ───────────────────────────────────────────────────────────

  let body: React.ReactNode;
  if (!root || root.status === 'loading') {
    body = (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  } else if (root.status === 'error' && root.statusCode === 404) {
    // No worktree on disk: provisioned at the first run, reaped later — a
    // normal state for a not-yet-run or reaped session, not an error.
    body = (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <FolderGit2 className="size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No worktree yet.</p>
        <p className="text-xs text-muted-foreground/70">
          The session&apos;s working folder appears here once a run has started — browse it and open files read-only.
        </p>
      </div>
    );
  } else if (root.status === 'error') {
    body = <LoadErrorState message="Couldn&apos;t load the worktree." onRetry={reloadAll} />;
  } else {
    body = (
      <ul role="tree" aria-label="Worktree files" className="py-1">
        {renderDirContents('', 0)}
      </ul>
    );
  }

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      {/* Header: show-ignored toggle + manual refresh (the tree is a cache —
          the agent keeps writing files as it works). */}
      <div className="flex items-center gap-1 px-3 py-2 border-b bg-card/60 flex-shrink-0">
        <FolderGit2 className="size-4 text-muted-foreground flex-shrink-0" />
        <span className="text-xs font-semibold text-foreground">Worktree</span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={toggleSort}
            title={sortMode === 'recent' ? 'Sorted by last change — click for A–Z' : 'Sorted A–Z — click for most recent first'}
            aria-label={sortMode === 'recent' ? 'Sort files A to Z' : 'Sort files by most recent change'}
            data-worktree-sort={sortMode}
          >
            {sortMode === 'recent' ? <Clock className="size-3.5" /> : <ArrowDownAZ className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn('size-7', showIgnored && 'text-foreground bg-muted')}
            onClick={() => setShowIgnored(v => !v)}
            title={showIgnored ? 'Hide gitignored files' : 'Show gitignored files'}
            aria-label={showIgnored ? 'Hide gitignored files' : 'Show gitignored files'}
            aria-pressed={showIgnored}
          >
            {showIgnored ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={reloadAll}
            title="Refresh the file tree"
            aria-label="Refresh the file tree"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">{body}</div>
    </div>
  );
}

// Memoized like the sibling sections (parents re-render on composer keystrokes).
export default memo(WorktreeTree);

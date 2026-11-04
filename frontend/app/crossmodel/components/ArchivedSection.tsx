'use client';

/**
 * Archived — the sidebar's browse + restore view for archived chats & folders
 * (owner 2026-09-08: "archive projects and bring them back. same with chats so
 * we dont permanently delete things just reduce clutter").
 *
 * Collapsed by default at the bottom of the sidebar (below Connected
 * instances, above the bottom links) — archive is a de-clutter feature, so its
 * own entry point must not add clutter. Contents load lazily on first expand
 * and refetch when `refreshToken` bumps (the parent increments it after an
 * archive action so an open section stays honest).
 *
 * Rows are individually-STAMPED items only: chats archived one by one, and
 * archived folder roots. Chats/subfolders riding inside an archived folder are
 * restored WITH it (the backend stamps only the root — restore is lossless),
 * so they never list here one by one.
 *
 * Conventions: plain useState collapse (P4 bans the Radix collapsible),
 * LoadErrorState over Empty on failed fetches (never an empty state over an
 * error), Empty for the honest nothing-archived case, always-visible Restore
 * buttons (no hover-reveal — nothing for the P2 touch pin to catch).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveRestore, ChevronDown, ChevronRight, Folder, Loader2, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { crossModelApi, projectsApi, CrossModelChat, Project } from '@/lib/api/crossmodel';
import { Empty, EmptyHeader, EmptyDescription } from '@/components/ui/empty';
import { LoadErrorState } from '@/components/ui/load-error-state';

interface ArchivedSectionProps {
  /** Bumps after every archive action in the parent — an OPEN section refetches. */
  refreshToken: number;
  /** A chat was restored — the parent re-syncs its sidebar chat list. */
  onRestoredChat: () => void;
  /** A folder was restored — the parent re-syncs the folder tree (its chats ride along). */
  onRestoredProject: () => void;
}

export function ArchivedSection({ refreshToken, onRestoredChat, onRestoredProject }: ArchivedSectionProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [chats, setChats] = useState<CrossModelChat[]>([]);
  const [folders, setFolders] = useState<Project[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // Stale-response guard (the ConnectedInstancesSection fetch-generation idiom):
  // only the newest in-flight load may write state.
  const fetchGen = useRef(0);

  const load = useCallback(async () => {
    const gen = ++fetchGen.current;
    setLoading(true);
    try {
      const [chatsResult, foldersResult] = await Promise.all([
        crossModelApi.listArchivedChats({ page: 1, limit: 50 }),
        projectsApi.listArchived(),
      ]);
      if (gen !== fetchGen.current) return;
      setChats(Array.isArray(chatsResult?.chats) ? chatsResult.chats : []);
      setFolders(Array.isArray(foldersResult?.owned) ? foldersResult.owned : []);
      setLoadError(false);
    } catch {
      if (gen !== fetchGen.current) return;
      setLoadError(true);
    } finally {
      if (gen === fetchGen.current) setLoading(false);
    }
  }, []);

  // Lazy: fetch on expand, and refetch while open when the parent archives
  // something new (refreshToken bump). A collapsed section costs nothing.
  useEffect(() => {
    if (!collapsed) void load();
  }, [collapsed, refreshToken, load]);

  const restoreChat = async (chatId: string) => {
    setRestoringId(chatId);
    try {
      await crossModelApi.restoreChat(chatId);
      setChats(prev => prev.filter(c => c.id !== chatId));
      onRestoredChat();
      toast.success('Chat restored');
    } catch {
      toast.error('Failed to restore chat');
    } finally {
      setRestoringId(null);
    }
  };

  const restoreFolder = async (projectId: string) => {
    setRestoringId(projectId);
    try {
      await projectsApi.restore(projectId);
      setFolders(prev => prev.filter(p => p.id !== projectId));
      onRestoredProject();
      toast.success('Folder restored');
    } catch {
      toast.error('Failed to restore folder');
    } finally {
      setRestoringId(null);
    }
  };

  const empty = !loading && !loadError && chats.length === 0 && folders.length === 0;

  return (
    <div>
      {/* Header row — mirrors the sidebar's section labels (Digby Frontier:
          sentence-case 12px ink-3, no uppercase tracking). */}
      <div className="flex items-center justify-between gap-1 px-2.5 pt-4 pb-1.5">
        <button
          onClick={() => setCollapsed(c => !c)}
          aria-expanded={!collapsed}
          className="flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink-2 transition-colors"
        >
          {collapsed ? <ChevronRight className="size-3 opacity-70" /> : <ChevronDown className="size-3 opacity-70" />}
          Archived
        </button>
      </div>

      {!collapsed && (
        <div className="space-y-0.5">
          {loading && (
            <div className="flex justify-center py-3"><Loader2 className="size-3.5 animate-spin text-muted-foreground" /></div>
          )}
          {!loading && loadError && (
            <LoadErrorState className="py-2" message="Couldn't load archived items." onRetry={() => void load()} />
          )}
          {empty && (
            <Empty className="py-3 px-3 gap-2 border-none">
              <EmptyHeader>
                <EmptyDescription className="text-xs">
                  Nothing archived. Archive chats or folders to tidy the sidebar without deleting anything.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {/* Archived folders first (restoring one brings its chats back too). */}
          {!loading && !loadError && folders.map((folder) => (
            <div key={folder.id} className="group flex min-h-[34px] items-center gap-1.5 rounded-[9px] px-2.5 text-ink-2 hover:bg-hover hover:text-ink transition-colors duration-150">
              <Folder className="size-3.5 text-muted-foreground flex-shrink-0" />
              <span className="flex-1 truncate text-xs text-muted-foreground" title={folder.name}>
                {folder.emoji ? `${folder.emoji} ` : ''}{folder.name}
              </span>
              <button
                onClick={() => void restoreFolder(folder.id)}
                disabled={restoringId === folder.id}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 flex-shrink-0"
                title="Restore this folder (its chats and subfolders come back with it)"
              >
                {restoringId === folder.id
                  ? <Loader2 className="size-3 animate-spin" />
                  : <ArchiveRestore className="size-3" />}
                Restore
              </button>
            </div>
          ))}

          {!loading && !loadError && chats.map((chat) => (
            <div key={chat.id} className="group flex min-h-[34px] items-center gap-1.5 rounded-[9px] px-2.5 text-ink-2 hover:bg-hover hover:text-ink transition-colors duration-150">
              <MessageSquare className="size-3.5 text-muted-foreground flex-shrink-0" />
              <span className="flex-1 truncate text-xs text-muted-foreground" title={chat.title}>{chat.title}</span>
              <button
                onClick={() => void restoreChat(chat.id)}
                disabled={restoringId === chat.id}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 flex-shrink-0"
                title="Restore this chat — it reappears where it was"
              >
                {restoringId === chat.id
                  ? <Loader2 className="size-3 animate-spin" />
                  : <ArchiveRestore className="size-3" />}
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

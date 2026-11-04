'use client';

/**
 * CodingFilesTabs — the coding-session WorkspacePanel "Files" section, split
 * into two clearly labeled sub-tabs (feedback ticket 999e3dbe, Phase 1):
 *
 *   Files    — the pre-existing content, UNCHANGED (per-chat uploads +
 *              agent-created documents above the chat's canvas file browser).
 *   Worktree — the session's on-disk worktree as a lazy read-only file tree.
 *
 * Default sub-tab is "Files". Both panes stay MOUNTED (the inactive one is
 * display:none) so the tree's fetched-directory cache and the files list's
 * loaded state survive a sub-tab hop — the same preserve-state idiom the
 * section already used to hide the uploads list while a canvas is open.
 *
 * Plain (non-coding) chats never mount this — their Files section keeps its
 * single-pane chrome with no tab strip.
 *
 * A file click in the tree is delegated to `onOpenWorktreeFile`; when it
 * resolves true (the host opened the read-only canvas preview — including the
 * inline too-large/binary notice) the strip hops back to "Files" so the
 * viewer is visible. A false resolution (transient load failure, already
 * toasted by the host) leaves the user on the tree.
 */

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { FolderGit2, Paperclip } from 'lucide-react';
import WorktreeTree from './WorktreeTree';

type SubTab = 'files' | 'worktree';

export interface CodingFilesTabsProps {
  chatId: string;
  /** The pre-existing Files pane (ChatFilesSection + CanvasPanel stack). */
  filesNode: ReactNode;
  /** Opens a worktree file read-only in the canvas panel; resolves true when
      a preview (or inline notice) was actually opened. */
  onOpenWorktreeFile: (path: string) => Promise<boolean>;
  /** Worktree-relative path currently open in the canvas (row highlight). */
  activeWorktreePath?: string | null;
}

export default function CodingFilesTabs({ chatId, filesNode, onOpenWorktreeFile, activeWorktreePath }: CodingFilesTabsProps) {
  const [tab, setTab] = useState<SubTab>('files');

  const openFile = async (path: string) => {
    if (await onOpenWorktreeFile(path)) setTab('files');
  };

  const tabBtn = (id: SubTab, label: string, icon: ReactNode) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
        tab === id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div role="tablist" aria-label="Files views" className="flex items-center gap-1 px-2 pt-2 pb-1.5 border-b bg-card/60 flex-shrink-0">
        {tabBtn('files', 'Files', <Paperclip className="size-3.5" />)}
        {tabBtn('worktree', 'Worktree', <FolderGit2 className="size-3.5" />)}
      </div>
      {/* Both panes mounted; the inactive one hides (state preserved). */}
      <div role="tabpanel" aria-label="Files" className={cn('flex-1 min-h-0 flex flex-col', tab !== 'files' && 'hidden')}>
        {filesNode}
      </div>
      <div role="tabpanel" aria-label="Worktree" className={cn('flex-1 min-h-0 flex flex-col', tab !== 'worktree' && 'hidden')}>
        <WorktreeTree chatId={chatId} activePath={activeWorktreePath} onOpenFile={p => void openFile(p)} />
      </div>
    </div>
  );
}

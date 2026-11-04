'use client';

/**
 * A `#worktree:<path>` markdown link (lib/worktree-links.ts) rendered as a
 * button that opens the file in the coding session's Files tab. Without an
 * opener in context (plain chats, shared pages) the path renders as plain
 * monospace text — the link is never a dead anchor and never navigates.
 */

import { useContext } from 'react';
import { WorktreeOpenContext } from '@/lib/worktree-open-context';

export function WorktreeFileLink({ path, children }: { path: string; children?: React.ReactNode }) {
  const open = useContext(WorktreeOpenContext);
  if (!open) {
    return <span className="font-mono text-[0.92em] break-all">{children ?? path}</span>;
  }
  return (
    <button
      type="button"
      data-worktree-path={path}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void open(path); }}
      title={`Open ${path} in the Files tab`}
      className="inline font-mono text-[0.92em] text-primary underline decoration-dotted underline-offset-4 hover:opacity-80 transition-opacity break-all text-left align-baseline p-0 m-0 bg-transparent border-0 cursor-pointer"
    >
      {children ?? path}
    </button>
  );
}

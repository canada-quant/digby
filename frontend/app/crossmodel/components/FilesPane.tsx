'use client';
/**
 * FilesPane — the ONE "Files" section body (plain chats + coding sessions).
 *
 * History: 2026-09-23 folded the separate Artifacts tab into Files as a second
 * list under the uploads; 2026-10-07 (owner: "not artifacts it should just all
 * be files") removed that second list — the chat's documents (canvases) are
 * rows in the ONE files list (ChatFilesSection `docs`). This pane now only
 * swaps between that list and the document editor: while a document is OPEN
 * the list hides (display:none keeps its state) and the editor gets the full
 * panel height. A chatless session (no chat-keyed list) shows the document
 * panel alone — its own list is titled "Files". Pure layout: both parts
 * arrive as nodes.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface FilesPaneProps {
  /** The files list (uploads + generated files + documents) — omitted for chatless sessions. */
  filesNode?: ReactNode;
  /** The document editor (or, chatless, the document list + editor). */
  docNode: ReactNode;
  /** True while a document is open in the editor. */
  docOpen?: boolean;
}

export function FilesPane({ filesNode, docNode, docOpen = false }: FilesPaneProps) {
  if (!filesNode) {
    return <div className="flex flex-col h-full min-h-0" data-testid="files-pane">{docNode}</div>;
  }
  return (
    <div className="flex flex-col h-full min-h-0" data-testid="files-pane">
      <div className={cn('flex-1 min-h-0', docOpen && 'hidden')} data-testid="files-part">
        {filesNode}
      </div>
      {docOpen ? <div className="flex-1 min-h-0" data-testid="doc-part">{docNode}</div> : null}
    </div>
  );
}

export default FilesPane;

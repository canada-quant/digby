'use client';

/**
 * Sidebar drag-and-drop primitives (P2 folder tree).
 *
 * Pattern mirrors components/ui/kanban.tsx: plain @dnd-kit/core
 * useDraggable/useDroppable wrappers. Two draggable kinds — chats and folders —
 * and two drop targets: folder rows (nest into) and the root zone (move to top
 * level / ungrouped). Rows are only droppable themselves (never their expanded
 * children), so droppables don't nest and pointerWithin resolves unambiguously.
 */
import {
  useDraggable,
  useDroppable,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
} from '@dnd-kit/core';
import * as React from 'react';
import { cn } from '@/lib/utils';

/** Droppable id for the "move to top level / ungrouped" zone. */
export const SIDEBAR_ROOT_DROP_ID = 'sidebar-root';

export type SidebarDragItem =
  | { kind: 'chat'; chatId: string; title: string }
  | { kind: 'folder'; folderId: string; name: string };

/** pointerWithin for precise row targeting, rectIntersection as keyboard fallback. */
export const sidebarCollisionDetection: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : rectIntersection(args);
};

interface BaseProps extends React.HTMLAttributes<HTMLDivElement> {
  disabled?: boolean;
  children: React.ReactNode;
}

/** Folder row: draggable (re-parent) AND droppable (drop chats/folders into it). */
export function FolderRowDnd({
  folderId,
  name,
  disabled,
  className,
  children,
  ...rest
}: BaseProps & { folderId: string; name: string }) {
  const dragData: SidebarDragItem = { kind: 'folder', folderId, name };
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: `folder:${folderId}`, data: dragData, disabled });
  const { isOver, setNodeRef: setDropRef, active } = useDroppable({
    id: `folder-drop:${folderId}`,
    data: dragData,
    disabled,
  });

  const activeData = active?.data?.current as SidebarDragItem | undefined;
  // Don't highlight the row being dragged over itself.
  const highlight =
    isOver && !!activeData && !(activeData.kind === 'folder' && activeData.folderId === folderId);

  return (
    <div
      ref={(el) => {
        setDragRef(el);
        setDropRef(el);
      }}
      {...attributes}
      {...listeners}
      {...rest}
      className={cn(
        className,
        isDragging && 'opacity-40',
        highlight && 'bg-active ring-1 ring-line-2'
      )}
    >
      {children}
    </div>
  );
}

/** Chat row: draggable only (drop targets are folder rows + the root zone). */
export function ChatRowDnd({
  chatId,
  title,
  disabled,
  className,
  children,
  ...rest
}: BaseProps & { chatId: string; title: string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useDraggable({ id: `chat:${chatId}`, data: { kind: 'chat', chatId, title } as SidebarDragItem, disabled });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      {...rest}
      className={cn(className, isDragging && 'opacity-40')}
    >
      {children}
    </div>
  );
}

/**
 * Drop zone rendered (only while dragging) at the bottom of the Folders
 * section: folders dropped here move to the top level, chats become ungrouped.
 */
export function RootDropZone({ label }: { label: string }) {
  const { isOver, setNodeRef } = useDroppable({ id: SIDEBAR_ROOT_DROP_ID, data: { kind: 'root' } });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'mt-1 rounded-md border border-dashed px-2 py-2 text-center text-[11px] transition-colors',
        isOver
          ? 'border-line-2 bg-active text-ink'
          : 'border-muted-foreground/40 text-muted-foreground'
      )}
    >
      {label}
    </div>
  );
}

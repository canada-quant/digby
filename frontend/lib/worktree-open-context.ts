/**
 * The session view's "open this worktree file in the Files tab" callback,
 * published to every markdown renderer beneath it (owner 2026-09-17 — chat
 * text interlinks the files it names). Null outside a coding session: the
 * renderer then shows a bare path as plain monospace text, never a dead link.
 */

import { createContext } from 'react';

export type WorktreeOpenFile = (path: string) => void | boolean | Promise<boolean | void>;

export const WorktreeOpenContext = createContext<WorktreeOpenFile | null>(null);

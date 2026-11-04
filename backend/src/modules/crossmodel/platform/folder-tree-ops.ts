/**
 * Folder tree (P2 platform unification) — SHARED subtree-rewrite ops.
 *
 * The depth-shift + path-prefix-swap discipline moveFolder introduced,
 * factored out so EVERY folder-tree mutation keeps the materialized
 * `path`/`depth` invariants truthful (a row's depth = its ancestor count; its
 * path = '/rootId/.../id'). The folder DELETE paths (platform.service
 * deleteProject AND coding-data.service deleteCodingProjectData) run the
 * rewrite BEFORE the delete, so the parentId FK's ON DELETE SET NULL never
 * fires on rows we care about — children leave the deleted subtree as
 * truthful roots (parentId null, depth 0, path '/'+id) or fully re-anchored
 * under reparentTo, never orphaned with a stale depth/path routed through a
 * deleted id.
 *
 * Lives in its own leaf module (prisma only) because platform.service and
 * coding-data.service already import each other's siblings — a helper on
 * either one would close an import cycle.
 */

import prisma from '../../../config/database';
import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/error-handler';
import { MAX_FOLDER_DEPTH } from './folder-inheritance';

export interface FolderRef { id: string; path?: string | null; depth?: number | null }

interface ChildRow { id: string; path: string; depth: number }

/** Prisma client or an interactive-transaction handle. */
type Tx = typeof prisma | Prisma.TransactionClient;

/**
 * Re-anchor ONE subtree root (a folder and all its descendants) at
 * newParent/newDepth/newPath — the moveFolder rewrite pattern:
 *   1. shift descendant depths by the delta FIRST (matched on the OLD path
 *      prefix — after the path swaps the updateMany would match zero rows);
 *   2. prefix-swap every descendant's path;
 *   3. repoint the subtree root itself (parentId/depth/path).
 * `descendants` must be the rows under the child's old path (rooted order).
 */
export async function rewriteSubtreeRoot(
  tx: Tx,
  child: ChildRow,
  descendants: ChildRow[],
  newParentId: string | null,
  newPath: string,
  newDepth: number,
): Promise<void> {
  const childOldPath = child.path || `/${child.id}`;
  const delta = newDepth - child.depth;
  if (delta !== 0 && descendants.length) {
    await tx.crossModelProject.updateMany({
      where: { path: { startsWith: `${childOldPath}/` } },
      data: { depth: { increment: delta } },
    });
  }
  for (const d of descendants) {
    await tx.crossModelProject.update({
      where: { id: d.id },
      data: { path: newPath + d.path.slice(childOldPath.length) },
    });
  }
  await tx.crossModelProject.update({
    where: { id: child.id },
    data: { parentId: newParentId, depth: newDepth, path: newPath },
  });
}

/**
 * Relocate every DIRECT child of a folder about to be deleted (with each
 * child's whole subtree) — CALL BEFORE the delete:
 *   - reparent null  → each child becomes a truthful ROOT (parentId null,
 *     depth 0, path '/'+id) and its descendants shift to match;
 *   - reparent set   → the children move under that folder (move semantics;
 *     depth-cap checked per child subtree BEFORE any write).
 * Returns the number of direct children relocated. Idempotent shape: with no
 * children it is a no-op.
 */
export async function relocateFolderChildren(
  tx: Tx,
  opts: { folder: FolderRef; reparent: (FolderRef & { depth: number }) | null },
): Promise<number> {
  const { folder, reparent } = opts;
  const folderPath = folder.path || `/${folder.id}`;
  const children: ChildRow[] = await tx.crossModelProject.findMany({
    where: { parentId: folder.id },
    select: { id: true, path: true, depth: true },
  });
  if (!children.length) return 0;
  const subtree: ChildRow[] = await tx.crossModelProject.findMany({
    where: { path: { startsWith: `${folderPath}/` } },
    orderBy: { depth: 'asc' },
    select: { id: true, path: true, depth: true },
  });

  if (reparent) {
    // Depth-cap check per child subtree under the reparent target — BEFORE any write.
    for (const child of children) {
      const childPath = child.path || `/${child.id}`;
      const descendants = subtree.filter((d) => d.path.startsWith(`${childPath}/`));
      const height = descendants.length
        ? Math.max(...descendants.map((d) => d.depth)) - child.depth
        : 0;
      if (reparent.depth + 1 + height > MAX_FOLDER_DEPTH) {
        throw new AppError(400, `Reparenting would exceed the folder depth limit (max depth ${MAX_FOLDER_DEPTH})`);
      }
    }
  }

  for (const child of children) {
    const childOldPath = child.path || `/${child.id}`;
    const descendants = subtree.filter((d) => d.path.startsWith(`${childOldPath}/`));
    const newPath = reparent ? `${reparent.path || `/${reparent.id}`}/${child.id}` : `/${child.id}`;
    const newDepth = reparent ? reparent.depth + 1 : 0;
    await rewriteSubtreeRoot(tx, child, descendants, reparent?.id ?? null, newPath, newDepth);
  }
  return children.length;
}

/**
 * Archive scope (owner 2026-09-08 archive/restore): the shared "which projects
 * are hidden by archival?" resolution used by the default chat/folder lists and
 * search. Archiving a folder stamps ONLY that row (crossmodel_projects.archivedAt)
 * — its chats and descendant folders ride along IMPLICITLY, so restore is a
 * single stamp-clear and loses nothing. That makes hiding a two-step read:
 *   1. the caller-visible ARCHIVED folders (owned by the user, plus any of the
 *      explicitly passed project ids — e.g. member projects whose owner archived
 *      them; archive is project state, so members see it too), then
 *   2. their whole subtrees via the materialized `path` prefix (the same O(1)
 *      subtree idiom moveFolder/deleteProject use).
 * Fast path: no archived folders (the overwhelmingly common case) costs one
 * partial-index probe and returns without the subtree query.
 */
import prisma from '../../config/database';

/**
 * Project ids whose contents are hidden from DEFAULT lists by archival:
 * every archived folder visible to the user + every descendant of one.
 * `extraProjectIds` widens the archived-root probe beyond owned folders
 * (callers pass their member-project ids so shared archived folders hide too).
 * Direct-id loads must NOT use this — archive is not tombstoning.
 */
export async function getArchiveHiddenProjectIds(
  userId: string,
  extraProjectIds: string[] = [],
): Promise<string[]> {
  const archivedRoots = await prisma.crossModelProject.findMany({
    where: {
      archivedAt: { not: null },
      OR: [{ userId }, ...(extraProjectIds.length ? [{ id: { in: extraProjectIds } }] : [])],
    },
    select: { id: true, path: true },
  });
  if (archivedRoots.length === 0) return [];

  // Subtrees: `path` is the materialized "/rootId/.../id", so descendants are
  // exactly the rows whose path extends an archived root's path.
  const descendants = await prisma.crossModelProject.findMany({
    where: { OR: archivedRoots.map((r) => ({ path: { startsWith: `${r.path || `/${r.id}`}/` } })) },
    select: { id: true },
  });

  return [...new Set([...archivedRoots.map((r) => r.id), ...descendants.map((d) => d.id)])];
}

/**
 * Prisma where-fragment hiding chats that are archived themselves OR live in a
 * hidden (archived / under-archived) project. AND-composable with any existing
 * where clause; the explicit `projectId: null` arm keeps unfiled chats visible
 * (SQL `NOT IN` would silently drop NULL projectIds).
 */
export function chatArchiveExclusion(hiddenProjectIds: string[]): Record<string, unknown> {
  return {
    archivedAt: null,
    ...(hiddenProjectIds.length
      ? { AND: [{ OR: [{ projectId: null }, { projectId: { notIn: hiddenProjectIds } }] }] }
      : {}),
  };
}

/**
 * MEMORY ACCESS GATES (owner 2026-09-14: "make sure per user gates so one user
 * can never access memory or knowledge about another user or another user's
 * projects").
 *
 * Every memory read — the unified digby_memory store, the project knowledge
 * base (project_chunks), the code index, learnings, decisions — is scoped by
 * PROJECT ID. These helpers decide which project scopes a caller may read:
 *
 *   - OWNED: crossmodel_projects.userId === userId;
 *   - MEMBER: a project_members row for the user on the project OR on any
 *     ANCESTOR folder (P2 folder-tree inheritance — access flows down);
 *   - a scope the user can neither own nor reach through membership is
 *     DROPPED from the query, never widened, never errored into a fallback.
 *
 * Cross-project blending ("owned-project blend") is deliberately narrower
 * than access: it spans only projects the caller OWNS — never member-shared
 * projects (a teammate's other work is not the caller's memory), never another
 * user's projects. Session ('session'/'chat' scope = a chat id) and 'user'
 * scopes are the caller's own by construction; callers pass their own ids.
 *
 * Pure prisma + logger (no platform import chain) so both runners can import it.
 * Fail CLOSED: a lookup error yields no authorized scopes.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';

const MAX_ANCESTOR_DEPTH = 12;

interface ProjectRow { id: string; userId: string; parentId: string | null }

/**
 * Load the candidate projects plus their whole ancestor chains (one query per
 * level, bounded). Returns id → row for every folder touched.
 */
async function loadWithAncestors(projectIds: string[]): Promise<Map<string, ProjectRow>> {
  const byId = new Map<string, ProjectRow>();
  let frontier = [...new Set(projectIds.filter((x) => typeof x === 'string' && x.length > 0))];
  for (let depth = 0; frontier.length && depth < MAX_ANCESTOR_DEPTH; depth++) {
    const rows = (await prisma.crossModelProject.findMany({
      where: { id: { in: frontier } },
      select: { id: true, userId: true, parentId: true },
    })) as ProjectRow[];
    const next: string[] = [];
    for (const r of rows) {
      byId.set(r.id, r);
      if (r.parentId && !byId.has(r.parentId)) next.push(r.parentId);
    }
    frontier = [...new Set(next)];
  }
  return byId;
}

/** Ancestor chain (self first) for a project, from a loaded map; stops at the map's edge. */
function chainOf(id: string, byId: Map<string, ProjectRow>): string[] {
  const out: string[] = [];
  let cur: string | null = id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur) && out.length <= MAX_ANCESTOR_DEPTH) {
    seen.add(cur);
    out.push(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return out;
}

/**
 * The subset of `projectIds` the user may READ memory for (owned, or a member
 * of the project or any ancestor folder). Order preserved; unknown ids dropped.
 * Fail closed on error.
 */
export async function authorizedProjectScopeIds(userId: string, projectIds: string[]): Promise<string[]> {
  if (!userId || !projectIds?.length) return [];
  try {
    const byId = await loadWithAncestors(projectIds);
    const allIds = [...byId.keys()];
    const memberRows = allIds.length
      ? await prisma.projectMember.findMany({ where: { userId, projectId: { in: allIds } }, select: { projectId: true } })
      : [];
    const memberOf = new Set(memberRows.map((m) => m.projectId));
    const out: string[] = [];
    for (const id of projectIds) {
      if (!byId.has(id)) continue; // unknown / deleted — never a scope
      const chain = chainOf(id, byId);
      const ok = chain.some((cid) => byId.get(cid)?.userId === userId || memberOf.has(cid));
      if (ok && !out.includes(id)) out.push(id);
    }
    return out;
  } catch (err: any) {
    logger.warn(`memory-access: authorization lookup failed for user ${String(userId).slice(0, 8)} — no scopes granted: ${err?.message ?? err}`);
    return [];
  }
}

/** True when the user may read memory for ONE project (owner or inherited member). */
export async function canReadProjectMemory(userId: string, projectId: string): Promise<boolean> {
  const ok = await authorizedProjectScopeIds(userId, [projectId]);
  return ok.length === 1;
}

/**
 * True when the user OWNS every one of `projectIds` (EOD review 2026-09-14):
 * cross-project blending pulls the CALLER's other owned projects into a
 * project's context — so it may only happen when the caller owns the project
 * being read. A MEMBER reading a shared project must never have their private
 * projects blended into a context the owner and other members also read.
 * Fail closed.
 */
export async function ownsAllProjects(userId: string, projectIds: string[]): Promise<boolean> {
  if (!userId || !projectIds?.length) return false;
  try {
    const ids = [...new Set(projectIds.filter((x) => typeof x === 'string' && x.length > 0))];
    const owned = await prisma.crossModelProject.count({ where: { id: { in: ids }, userId } });
    return owned === ids.length;
  } catch (err: any) {
    logger.warn(`memory-access: ownership lookup failed for user ${String(userId).slice(0, 8)} — no blend: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Projects the user OWNS (never member-shared) — the only set cross-project
 * blending may span. Optional exclusion for the current project. Fail closed.
 */
export async function ownedProjectIds(userId: string, opts?: { exclude?: string[]; limit?: number; excludeUserSpace?: boolean }): Promise<string[]> {
  if (!userId) return [];
  try {
    const rows = await prisma.crossModelProject.findMany({
      where: { userId, ...(opts?.exclude?.length ? { id: { notIn: opts.exclude } } : {}), ...(opts?.excludeUserSpace ? { isUserSpace: false } : {}) },
      select: { id: true },
      take: Math.min(500, Math.max(1, opts?.limit ?? 200)),
    });
    return rows.map((r) => r.id);
  } catch (err: any) {
    logger.warn(`memory-access: owned-project lookup failed for user ${String(userId).slice(0, 8)}: ${err?.message ?? err}`);
    return [];
  }
}

/**
 * KPI register READERS (tt-rd audit 2026-09-27, kpi-honesty-loops) — the DB
 * half of kpi-of-record.ts (a leaf). Every reader fails toward "no KPI"
 * (empty array) and never throws: the surfaces that consume it (the
 * [SUPERVISOR STATE] annotation, the supervisor reply footer) are
 * observe-only and must never break a wake or a reply.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { readPremises } from './premise-register';
import { kpiPremiseOf, type KpiView } from './kpi-of-record';

const SOURCE = 'kpi-register';
export const KPI_REGISTER_MAX_PROJECTS = 40;

/** Every kpi: premise on an active/blocked goal of the given projects. */
export async function loadProjectKpis(projectIds: string[]): Promise<KpiView[]> {
  const ids = [...new Set(projectIds.filter(Boolean))].slice(0, KPI_REGISTER_MAX_PROJECTS);
  if (!ids.length) return [];
  try {
    const goals = (await (prisma.projectGoal as any).findMany({
      where: { projectId: { in: ids }, status: { in: ['active', 'blocked'] } },
      select: { id: true, projectId: true, title: true, premises: true },
      orderBy: { createdAt: 'asc' },
    })) as Array<{ id: string; projectId: string; title: string; premises: unknown }>;
    const out: KpiView[] = [];
    for (const g of goals) {
      const kpi = kpiPremiseOf(readPremises(g.premises));
      if (kpi) out.push({ ...kpi, goalId: g.id, projectId: g.projectId, goalTitle: String(g.title ?? '') });
    }
    return out;
  } catch (err: any) {
    logger.warn(`${SOURCE}: KPI read failed (no KPI surfaces this turn): ${err?.message ?? err}`, { source: SOURCE });
    return [];
  }
}

/**
 * The KPIs a supervisor chat can be held to: a PROJECT supervisor's own
 * project; the FLEET supervisor's every opted-in project of the owner.
 */
export async function loadKpisForSupervisorChat(input: { projectId?: string | null; userId?: string | null; fleet?: boolean }): Promise<KpiView[]> {
  try {
    if (input.projectId) return await loadProjectKpis([input.projectId]);
    if (input.fleet && input.userId) {
      const projects = (await prisma.crossModelProject.findMany({
        where: { userId: input.userId, archivedAt: null, projectSupervisorEnabled: true },
        select: { id: true },
        take: KPI_REGISTER_MAX_PROJECTS,
      })) as Array<{ id: string }>;
      return await loadProjectKpis(projects.map((p) => p.id));
    }
    return [];
  } catch (err: any) {
    logger.warn(`${SOURCE}: supervisor KPI read failed: ${err?.message ?? err}`, { source: SOURCE });
    return [];
  }
}

/**
 * Ticket abca56ce: EVERY kpi: premise on the owner's non-archived projects —
 * the push-guard's read. The supervisor-scoped readers above deliberately
 * narrow by seat (a project supervisor sees its own project); the re-
 * announcement guard cannot know which seat is pushing, so it anchors on the
 * whole owner register: any KPI whose of-record state a push re-announces is
 * refused, whoever is announcing. Fails toward [] (never blocks a push).
 */
export async function loadKpisForOwner(userId: string): Promise<KpiView[]> {
  if (!userId) return [];
  try {
    const projects = (await prisma.crossModelProject.findMany({
      where: { userId, archivedAt: null },
      select: { id: true },
      take: KPI_REGISTER_MAX_PROJECTS,
    })) as Array<{ id: string }>;
    return await loadProjectKpis(projects.map((p) => p.id));
  } catch (err: any) {
    logger.warn(`${SOURCE}: owner KPI read failed (no KPI guard this push): ${err?.message ?? err}`, { source: SOURCE });
    return [];
  }
}

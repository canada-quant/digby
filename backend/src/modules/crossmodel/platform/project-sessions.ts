/**
 * Sessions view rows (SESSION_TITLES_TOPOLOGY design §A "Sessions view"):
 * ONE read — `GET /projects/:id/sessions` — returning, per chat in the
 * project, the title halves, the pin, a status (running | scheduled | idle |
 * archived), the last mutating receipt age, today's spend and the charter, all
 * computed from the same goal→lane index the topology pre-check reads
 * (platform/session-topology buildLaneIndex) plus the day's `run_spend` rows.
 * Archived rows are hidden unless asked for. Fail-open: a leg that times out
 * leaves its column null and `partial:true` on the envelope.
 */

import prisma from '../../../config/database';
import { LOOP_METRIC_KINDS } from './loop-metrics.service';
import { buildLaneIndex, type LaneIndexRow } from './session-topology';
import { splitSessionTitle } from './session-titles';

export type SessionRowStatus = 'running' | 'scheduled' | 'idle' | 'archived';

export interface SessionRow {
  chatId: string;
  title: string;
  goalHalf: string;
  stepHalf: string | null;
  pinned: boolean;
  status: SessionRowStatus;
  lastReceiptAgeSec: number | null;
  spendTodayUsd: number | null;
  goalId: string | null;
  goalTitle: string | null;
  todoCounts: { open: number };
  runs14d: number;
  enabledSchedules: number;
  isSupervisor: boolean;
  hasWorkspaceState: boolean;
  updatedAt: string;
  archivedAt: string | null;
}

export const SESSIONS_MAX_ARCHIVED = 200;

/** Pure: the status of a lane row. */
export function sessionStatusFor(l: Pick<LaneIndexRow, 'running' | 'enabledSchedules'>, archived: boolean): SessionRowStatus {
  if (archived) return 'archived';
  if (l.running) return 'running';
  if (l.enabledSchedules > 0) return 'scheduled';
  return 'idle';
}

/** UTC midnight of `now`. Pure. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function listProjectSessions(projectId: string, userId: string, opts: { includeArchived?: boolean; now?: Date } = {}): Promise<{ sessions: SessionRow[]; partial: boolean }> {
  const now = opts.now ?? new Date();
  const index = await buildLaneIndex(projectId, userId, { now });
  const ids = index.lanes.map((l) => l.laneId);
  let partial = index.partial;
  const [chatRows, spendRows] = await Promise.all([
    ids.length ? prisma.crossModelChat.findMany({ where: { id: { in: ids } }, select: { id: true, titlePinned: true, updatedAt: true, archivedAt: true } }).catch(() => null) : Promise.resolve([]),
    ids.length ? prisma.loopMetric.groupBy({ by: ['sessionId'], where: { kind: LOOP_METRIC_KINDS.RUN_SPEND, sessionId: { in: ids }, createdAt: { gte: startOfUtcDay(now) } }, _sum: { value: true } } as any).catch(() => null) : Promise.resolve([]),
  ]);
  if (chatRows == null || spendRows == null) partial = true;
  const chatBy = new Map<string, any>((chatRows ?? []).map((c: any) => [c.id, c]));
  const spendBy = new Map<string, number>((spendRows ?? []).map((r: any) => [String(r.sessionId), Number(r._sum?.value ?? 0)]));
  const sessions: SessionRow[] = index.lanes.map((l) => {
    const c = chatBy.get(l.laneId);
    const halves = splitSessionTitle(l.title);
    return {
      chatId: l.laneId, title: l.title, goalHalf: halves.goal, stepHalf: halves.step, pinned: c?.titlePinned === true,
      status: sessionStatusFor(l, false), lastReceiptAgeSec: l.lastMutatingReceiptAgeSec,
      spendTodayUsd: spendRows == null ? null : Number((spendBy.get(l.laneId) ?? 0).toFixed(4)),
      goalId: l.charterGoalId, goalTitle: l.charterGoalId ? index.goalTitles[l.charterGoalId] ?? null : null,
      todoCounts: { open: l.charterTodoIds.length }, runs14d: l.runs14d, enabledSchedules: l.enabledSchedules,
      isSupervisor: l.isSupervisor, hasWorkspaceState: !!l.worktreeBranch,
      updatedAt: c?.updatedAt ? new Date(c.updatedAt).toISOString() : now.toISOString(), archivedAt: null,
    };
  });
  if (opts.includeArchived) {
    const archived = await prisma.crossModelChat.findMany({
      where: { projectId, userId, archivedAt: { not: null } },
      select: { id: true, title: true, titlePinned: true, updatedAt: true, archivedAt: true, charterGoalId: true, isSupervisor: true, isProjectSupervisor: true },
      orderBy: { archivedAt: 'desc' }, take: SESSIONS_MAX_ARCHIVED,
    }).catch(() => null);
    if (archived == null) partial = true;
    for (const a of archived ?? []) {
      const halves = splitSessionTitle(a.title);
      sessions.push({
        chatId: a.id, title: a.title, goalHalf: halves.goal, stepHalf: halves.step ?? 'archived', pinned: a.titlePinned === true, status: 'archived',
        lastReceiptAgeSec: null, spendTodayUsd: null, goalId: a.charterGoalId ?? null, goalTitle: null, todoCounts: { open: 0 }, runs14d: 0, enabledSchedules: 0,
        isSupervisor: a.isSupervisor || a.isProjectSupervisor, hasWorkspaceState: false, updatedAt: new Date(a.updatedAt).toISOString(), archivedAt: a.archivedAt ? new Date(a.archivedAt).toISOString() : null,
      });
    }
  }
  const order: Record<SessionRowStatus, number> = { running: 0, scheduled: 1, idle: 2, archived: 3 };
  sessions.sort((a, b) => order[a.status] - order[b.status] || (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
  return { sessions, partial };
}

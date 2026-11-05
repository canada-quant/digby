/**
 * TD-1 audit pass (Cluster 5, 2026-11-03) — the second half of the TD-1 gate.
 *
 * WHY THIS EXISTS: the enforcement switch (TODO_ASSIGNEE_REQUIRED_ENFORCE) must
 * not be flipped while the board still carries rows the OLD code created
 * unassigned. Flipping first would leave those rows invisible to the fix and
 * would refuse the next legitimate create for a board that is already dirty.
 * So the gate is two-part, in this order:
 *
 *   1. this pass measures the existing population (observe-only, never mutates)
 *   2. once the population is understood, enforcement is flipped
 *
 * It scans `projectTodo` rows that are `in_progress` with NO `assigneeChatId` —
 * an in-progress row nobody owns is the exact defect TD-1 names: work the board
 * says is being done, with no lane that can ever fire `todo_done` for it.
 *
 * It deliberately does NOT backfill. A backfill would have to invent an owner,
 * and inventing an owner is the failure mode that made the reconciliation leave
 * seven cluster todos unassigned in the first place — the comment on TD-1 in
 * docs/FRAMEWORK_BACKLOG.md records that decision. What it records per row is
 * whether the row is `backfillable` (a single obvious candidate lane exists),
 * so a human/owner pass can decide, instead of the cron guessing.
 *
 * FAIL-SOFT like its session-topology sibling: the whole body is wrapped, it
 * returns a ≤200-char summary for cron_jobs.lastStatus, and it never throws
 * into the worker.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from './loop-metrics.service';
import { todoAssigneeAuditDisabled } from './todo-assignee-policy';

export const TODO_ASSIGNEE_AUDIT_JOB_ID = 'todo-assignee-audit';
export const TODO_ASSIGNEE_AUDIT_INTERVAL_SEC = 6 * 3600;
/** Cap the rows one pass records — the audit is a sample-driven trend, and a
 *  runaway board must never turn a 6-hourly cron into an unbounded write. */
export const TODO_ASSIGNEE_AUDIT_MAX_ROWS = 200;
/** A row younger than this is not yet evidence: a create whose auto-assign is
 *  still in flight (or a row a lane is about to claim) must not be counted as
 *  an orphan. */
export const TODO_ASSIGNEE_AUDIT_MIN_AGE_MS = 6 * 3600_000;

type AuditRow = {
  id: string;
  goalId: string;
  projectId: string;
  createdAt?: Date | string | null;
  goal?: { id?: string; status?: string } | null;
};

/**
 * One pass. Returns the ≤200-char summary stored in cron_jobs.lastStatus.
 * Never throws.
 */
export async function runTodoAssigneeAuditOnce(now: Date = new Date()): Promise<string> {
  if (todoAssigneeAuditDisabled()) return 'todo-assignee-audit: disabled';
  try {
    const cutoff = new Date(now.getTime() - TODO_ASSIGNEE_AUDIT_MIN_AGE_MS);
    const rows: AuditRow[] = await (prisma as any).projectTodo?.findMany?.({
      where: {
        status: 'in_progress',
        assigneeChatId: null,
        createdAt: { lt: cutoff },
      },
      select: { id: true, goalId: true, projectId: true, createdAt: true, goal: { select: { id: true, status: true } } },
      orderBy: { createdAt: 'asc' },
      take: TODO_ASSIGNEE_AUDIT_MAX_ROWS,
    }) ?? [];

    if (!rows.length) return 'todo-assignee-audit: 0 unassigned in_progress row(s)';

    // How many candidate lanes does each project carry? A project with exactly
    // ONE recent coding lane is backfillable mechanically; zero or several is a
    // judgement call and is reported as such, never guessed.
    const laneCounts = new Map<string, number>();
    for (const projectId of [...new Set(rows.map((r) => r.projectId).filter(Boolean))]) {
      try {
        const lanes = await (prisma as any).crossModelChat?.count?.({
          where: { projectId, codeCapable: true },
        });
        laneCounts.set(projectId, Number(lanes) || 0);
      } catch { laneCounts.set(projectId, 0); }
    }

    let live = 0;
    for (const row of rows) {
      const created = row.createdAt ? new Date(row.createdAt).getTime() : NaN;
      const ageH = Number.isFinite(created) ? Math.max(0, Math.round((now.getTime() - created) / 3600_000)) : null;
      // A row under a done/archived goal is a stale-board artefact, not live
      // work — counted but labelled, so the number that must reach zero is the
      // honest one (the exact distinction the goal-reopen seam already draws).
      const goalStatus = String(row.goal?.status ?? '');
      if (goalStatus !== 'done' && goalStatus !== 'archived') live++;
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.TODO_ASSIGNEE_AUDIT,
        meta: {
          todoId: row.id,
          goalId: row.goalId,
          projectId: row.projectId,
          ageH,
          goalStatus: goalStatus || 'unknown',
          laneCount: laneCounts.get(row.projectId) ?? 0,
          backfillable: (laneCounts.get(row.projectId) ?? 0) === 1,
        },
      });
    }

    return `todo-assignee-audit: ${rows.length} unassigned in_progress row(s), ${live} live (observe-only)`.slice(0, 200);
  } catch (err: any) {
    logger.warn(`todo-assignee-audit failed (non-fatal): ${err?.message ?? err}`);
    return 'todo-assignee-audit: failed (non-fatal)';
  }
}
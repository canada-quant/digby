/**
 * Admin read path of the SHADOW delegation ledger + tool-intent journal
 * (build 2026-10-08 D; architecture.md items B + C). Read-only — nothing here
 * writes a task or an intent.
 *
 *   GET /api/crossmodel/admin/delegation-tasks
 *       ?kind=session|message_ask|ticket|background_worker|schedule_firing|continuation
 *       ?state=submitted|working|input_required|completed|failed|canceled|open  ?stale=1
 *       ?chatId=<parent or child chat id>  ?hours=72  ?limit=50
 *     → { summary (7 d by kind × state, open, stale, duplicate keys), tasks (compact),
 *         toolIntents (24 h journal summary), lastReconcile, lastIntentDaily }
 *   GET /api/crossmodel/admin/delegation-tasks/:id  (full id or a unique ≥ 8-char prefix)
 *     → { task } with its lifecycle events + artifact refs
 *
 * Admin only — the same posture as /admin/job-health and /admin/loop-metrics.
 */

import { Request, Response } from 'express';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { isAdminViewer } from '../view/view-mode';
import { LOOP_METRIC_KINDS } from './loop-metrics.service';
import {
  getDelegationTask, isTerminalDelegationState, listDelegationTasks, summarizeDelegationTasks,
} from './delegation-tasks';
import { summarizeToolIntents } from '../coding/tool-intents';

function isAdmin(req: Request): boolean {
  const u = (req as any).user;
  // ONE admin predicate (view/view-mode.ts): the owner e-mail counts on production only (2026-10-20).
  return isAdminViewer(u);
}

const iso = (d: unknown): string | null => (d ? new Date(d as any).toISOString() : null);

/** The compact list row (the detail endpoint adds events + artifacts). */
export function compactDelegationTask(t: any, now = Date.now()): Record<string, unknown> {
  const stale = !isTerminalDelegationState(t?.state) && !!t?.staleAfter && new Date(t.staleAfter).getTime() < now;
  return {
    id: t.id,
    kind: t.kind,
    source: t.source,
    state: t.state,
    stale,
    parentChatId: t.parentChatId ?? null,
    childChatId: t.childChatId ?? null,
    childRef: t.childRef ?? null,
    projectId: t.projectId ?? null,
    brief: typeof t.brief === 'string' ? t.brief.slice(0, 200) : null,
    origin: t.origin ?? null,
    duplicateOfId: t.duplicateOfId ?? null,
    artifactCount: Array.isArray(t.artifacts) ? t.artifacts.length : 0,
    eventCount: Array.isArray(t.events) ? t.events.length : 0,
    resultRef: t.resultRef ?? null,
    reason: t.reason ?? null,
    createdAt: iso(t.createdAt),
    lastEventAt: iso(t.lastEventAt),
    completedAt: iso(t.completedAt),
  };
}

async function lastMetricRow(kind: string, phase?: string): Promise<{ at: string; value: number | null; meta: unknown } | null> {
  try {
    const rows = await prisma.loopMetric.findMany({
      where: { kind },
      orderBy: { createdAt: 'desc' },
      take: phase ? 20 : 1,
      select: { createdAt: true, value: true, meta: true },
    });
    const row = phase ? rows.find((r) => (r.meta as any)?.phase === phase) : rows[0];
    return row ? { at: row.createdAt.toISOString(), value: row.value ?? null, meta: row.meta } : null;
  } catch {
    return null;
  }
}

export async function getAdminDelegationTasks(req: Request, res: Response) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const q = req.query as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const [summary, tasks, toolIntents, lastReconcile, lastIntentDaily] = await Promise.all([
      summarizeDelegationTasks(168),
      listDelegationTasks({
        kind: str(q.kind), state: str(q.state), chatId: str(q.chatId),
        hours: Number(q.hours) || undefined, limit: Number(q.limit) || undefined, staleOnly: q.stale === '1' || q.stale === 'true',
      }),
      summarizeToolIntents(24),
      lastMetricRow(LOOP_METRIC_KINDS.DELEGATION_TASK_RECONCILE),
      lastMetricRow(LOOP_METRIC_KINDS.TOOL_INTENT, 'daily'),
    ]);
    const now = Date.now();
    return res.json({ success: true, data: { summary, tasks: tasks.map((t) => compactDelegationTask(t, now)), toolIntents, lastReconcile, lastIntentDaily } });
  } catch (err: any) {
    logger.error('getAdminDelegationTasks error:', err?.message);
    return res.status(500).json({ error: 'Failed to read delegation tasks' });
  }
}

export async function getAdminDelegationTask(req: Request, res: Response) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const t = await getDelegationTask(String(req.params.id ?? ''));
    if (!t) return res.status(404).json({ error: 'Delegation task not found' });
    return res.json({
      success: true,
      data: {
        task: {
          ...compactDelegationTask(t),
          brief: t.brief ?? null,
          parentRunId: t.parentRunId ?? null,
          idempotencyKey: t.idempotencyKey ?? null,
          staleAfter: iso(t.staleAfter),
          events: Array.isArray(t.events) ? t.events : [],
          artifacts: Array.isArray(t.artifacts) ? t.artifacts : [],
        },
      },
    });
  } catch (err: any) {
    logger.error('getAdminDelegationTask error:', err?.message);
    return res.status(500).json({ error: 'Failed to read the delegation task' });
  }
}

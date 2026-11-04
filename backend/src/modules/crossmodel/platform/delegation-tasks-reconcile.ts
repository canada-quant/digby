/**
 * Nightly reconcile of the SHADOW delegation ledger + tool-intent journal
 * (build 2026-10-08 D-1 / D-2; architecture.md items B + C, stage 1).
 *
 * The ledger (platform/delegation-tasks.ts) is written from event seams; this
 * job MEASURES it against each kind's own source of truth and never edits a
 * task (a reconcile that wrote states would make agreement trivially 100 %):
 *   session · message_ask · schedule_firing  the child chat's first agent_runs
 *                       row that was still running at / started after the
 *                       task's creation (coding chats), else the first
 *                       assistant row after it (plain chats — completed only);
 *   ticket              the ticket row: closed ⇒ completed; dispatched to a
 *                       different lane ⇒ canceled (superseded); "Auto
 *                       re-dispatch stopped" ⇒ failed;
 *   background_worker   the pool's own delegate_background metric rows;
 *   continuation        the task card mirrored on the chat's assistant rows.
 * The readout row (loop_metrics delegation_task_reconcile) carries the stage-1
 * bar — agreementPct ≥ 99 over tasks whose truth or row is terminal, and
 * missingParent = 0 — plus missingRows (ok start_coding_session receipts with
 * no session task: the write seams' coverage) and stale (open past
 * staleAfter). A second row (tool_intent phase daily) summarizes the
 * journal: states, orphaned pendings (> 1 h), would-reconcile verdicts, keys
 * executed twice (the act bar: 0) and — since the DL-2 act (2026-10-11) —
 * actSkips, the calls answered from an earlier attempt instead of re-run.
 *
 * Retention (bounded deletes): tool_intents older than 30 days, terminal
 * delegation_tasks older than 90 days. Runs as the worker cron
 * `delegation-reconcile` (DB-only — any worker may claim it). Kill switch:
 * DELEGATION_TASKS_DISABLED=1 skips the ledger half; TOOL_INTENT_JOURNAL_DISABLED=1
 * the journal half. Never throws; returns the ≤ 200-char pass summary.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from './loop-metrics.service';
import {
  delegationTasksDisabled, fromBackgroundPhase, fromRunStatus, fromTaskCardStatus, fromTicketStatus,
  isTerminalDelegationState, PARENT_REQUIRED_KINDS, type DelegationState,
} from './delegation-tasks';
import { toolIntentJournalDisabled } from '../coding/tool-intents';

export const DELEGATION_RECONCILE_JOB_ID = 'delegation-reconcile';
export const DELEGATION_RECONCILE_INTERVAL_SEC = 86_400;

const WINDOW_MS = 48 * 3_600_000;
/** Tasks younger than this are still settling — not judged yet. */
const SETTLE_MS = 30 * 60_000;
const MAX_TASKS = 1_000;
const INTENT_RETENTION_MS = 30 * 86_400_000;
const TASK_RETENTION_MS = 90 * 86_400_000;
const ORPHAN_PENDING_MS = 3_600_000;

const db = (): any => (prisma as any).delegationTask;
const intents = (): any => (prisma as any).toolIntent;

export interface ReconcileTask {
  id: string; kind: string; state: string; createdAt: Date;
  parentChatId: string | null; childChatId: string | null; childRef: string | null;
}

export interface ReconcileTally {
  checked: number;
  agree: number;
  mismatch: number;
  missedTerminal: number;
  falseTerminal: number;
  openBoth: number;
  byKind: Record<string, { checked: number; agree: number; disagree: number }>;
  samples: Array<{ id: string; kind: string; row: string; truth: string | null }>;
}

/** Pure: fold (row state, truth state) pairs into the agreement tally. Truth null = still open / unknown. */
export function tallyAgreement(pairs: Array<{ task: ReconcileTask; truth: DelegationState | null }>): ReconcileTally {
  const t: ReconcileTally = { checked: 0, agree: 0, mismatch: 0, missedTerminal: 0, falseTerminal: 0, openBoth: 0, byKind: {}, samples: [] };
  for (const { task, truth } of pairs) {
    t.checked++;
    const k = (t.byKind[task.kind] ??= { checked: 0, agree: 0, disagree: 0 });
    k.checked++;
    const rowTerminal = isTerminalDelegationState(task.state);
    const truthTerminal = isTerminalDelegationState(truth);
    let disagree = false;
    if (rowTerminal && truthTerminal) {
      if (task.state === truth) { t.agree++; k.agree++; } else { t.mismatch++; disagree = true; }
    } else if (truthTerminal) { t.missedTerminal++; disagree = true; }
    else if (rowTerminal) { t.falseTerminal++; disagree = true; }
    else t.openBoth++;
    if (disagree) {
      k.disagree++;
      if (t.samples.length < 10) t.samples.push({ id: task.id.slice(0, 8), kind: task.kind, row: task.state, truth });
    }
  }
  return t;
}

/** Pure: agreement over every pair where the row or the truth is terminal (100 when there is nothing to judge). */
export function agreementPct(t: ReconcileTally): number {
  const judged = t.agree + t.mismatch + t.missedTerminal + t.falseTerminal;
  return judged ? Math.round((t.agree / judged) * 10_000) / 100 : 100;
}

/**
 * Pure: the truth for a run-bound task from its child chat's runs (oldest
 * first): the first run still running at the task's creation or created after
 * it. No such run ⇒ null (open).
 */
export function runBoundTruth(taskCreatedAt: Date, runs: Array<{ status: string; createdAt: Date; finishedAt: Date | null }>): DelegationState | null {
  const tc = new Date(taskCreatedAt).getTime();
  const sorted = [...runs].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const run = sorted.find((r) => (r.finishedAt == null || new Date(r.finishedAt).getTime() >= tc) && new Date(r.createdAt).getTime() <= tc + 12 * 3_600_000);
  if (!run) return null;
  const s = fromRunStatus(run.status);
  return s && isTerminalDelegationState(s) ? s : null;
}

/** Pure: a ticket task's truth from its ticket row. */
export function ticketTruth(task: ReconcileTask, ticket: { status: string; adminNote: string | null; context: unknown } | null | undefined): DelegationState | null {
  if (!ticket) return null;
  const closed = fromTicketStatus(ticket.status);
  const ctx = ticket.context && typeof ticket.context === 'object' ? ticket.context as Record<string, unknown> : {};
  const lane = typeof ctx.dispatchedTo === 'string' ? ctx.dispatchedTo : '';
  if (task.childChatId && lane && lane !== task.childChatId) return 'canceled';
  if (closed) return closed;
  if (/^Auto re-dispatch stopped/.test(String(ticket.adminNote ?? ''))) return 'failed';
  return null;
}

async function deriveTruths(tasks: ReconcileTask[], now: Date): Promise<Map<string, DelegationState | null>> {
  const out = new Map<string, DelegationState | null>();
  const since = new Date(now.getTime() - WINDOW_MS - 12 * 3_600_000);

  // Run-bound kinds — the child chat's runs (coding) or assistant rows (plain chats).
  const runBound = tasks.filter((t) => (t.kind === 'session' || t.kind === 'message_ask' || t.kind === 'schedule_firing') && t.childChatId);
  const childIds = [...new Set(runBound.map((t) => t.childChatId as string))];
  if (childIds.length) {
    const runs: Array<{ sessionId: string; status: string; createdAt: Date; finishedAt: Date | null }> = await prisma.agentRun.findMany({
      where: { sessionId: { in: childIds }, createdAt: { gte: since } },
      select: { sessionId: true, status: true, createdAt: true, finishedAt: true },
      take: 5_000,
    });
    const runsBy = new Map<string, typeof runs>();
    for (const r of runs) (runsBy.get(r.sessionId) ?? runsBy.set(r.sessionId, []).get(r.sessionId)!).push(r);
    const plainIds = childIds.filter((id) => !runsBy.has(id));
    const answers: Array<{ chatId: string; createdAt: Date }> = plainIds.length
      ? await prisma.crossModelMessage.findMany({
        where: { chatId: { in: plainIds }, role: 'assistant', createdAt: { gte: since } },
        select: { chatId: true, createdAt: true },
        take: 5_000,
      })
      : [];
    for (const t of runBound) {
      const chatRuns = runsBy.get(t.childChatId as string);
      if (chatRuns) { out.set(t.id, runBoundTruth(t.createdAt, chatRuns)); continue; }
      const tc = new Date(t.createdAt).getTime();
      out.set(t.id, answers.some((a) => a.chatId === t.childChatId && new Date(a.createdAt).getTime() >= tc) ? 'completed' : null);
    }
  }

  // Tickets — the ticket row.
  const ticketTasks = tasks.filter((t) => t.kind === 'ticket' && t.childRef);
  if (ticketTasks.length) {
    const rows: Array<{ id: string; status: string; adminNote: string | null; context: unknown }> = await prisma.userFeatureRequest.findMany({
      where: { id: { in: [...new Set(ticketTasks.map((t) => t.childRef as string))] } },
      select: { id: true, status: true, adminNote: true, context: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const t of ticketTasks) out.set(t.id, ticketTruth(t, byId.get(t.childRef as string)));
  }

  // Background workers — the pool's own phase rows.
  const bgTasks = tasks.filter((t) => t.kind === 'background_worker' && t.parentChatId && t.childRef);
  if (bgTasks.length) {
    const rows: Array<{ sessionId: string | null; meta: any; createdAt: Date }> = await prisma.loopMetric.findMany({
      where: { kind: LOOP_METRIC_KINDS.DELEGATE_BACKGROUND, createdAt: { gte: since }, sessionId: { in: [...new Set(bgTasks.map((t) => t.parentChatId as string))] } },
      select: { sessionId: true, meta: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 5_000,
    });
    for (const t of bgTasks) {
      let truth: DelegationState | null = null;
      for (const r of rows) {
        const m = r.meta && typeof r.meta === 'object' ? r.meta : {};
        const hit = r.sessionId === t.parentChatId && (m.workerId === t.childRef || (Array.isArray(m.workerIds) && m.workerIds.includes(t.childRef)));
        if (!hit) continue;
        const s = fromBackgroundPhase(m.phase);
        if (s && isTerminalDelegationState(s) && !truth) truth = s;
      }
      out.set(t.id, truth);
    }
  }

  // Continuations — the task card on the chat's assistant rows.
  const contTasks = tasks.filter((t) => t.kind === 'continuation' && t.parentChatId && t.childRef);
  if (contTasks.length) {
    const rows: Array<{ chatId: string; metadata: any }> = await prisma.crossModelMessage.findMany({
      where: { chatId: { in: [...new Set(contTasks.map((t) => t.parentChatId as string))] }, role: 'assistant', createdAt: { gte: since } },
      select: { chatId: true, metadata: true },
      take: 5_000,
    });
    for (const t of contTasks) {
      const card = rows.map((r) => (r.metadata && typeof r.metadata === 'object' ? r.metadata.task : null))
        .find((c) => c && typeof c === 'object' && c.taskId === t.childRef);
      const s = card ? fromTaskCardStatus(card.status) : null;
      out.set(t.id, s && isTerminalDelegationState(s) ? s : null);
    }
  }
  return out;
}

async function reconcileLedger(now: Date): Promise<{ summary: string; meta: Record<string, unknown> }> {
  const from = new Date(now.getTime() - WINDOW_MS);
  const to = new Date(now.getTime() - SETTLE_MS);
  const tasks: ReconcileTask[] = await db().findMany({
    where: { createdAt: { gte: from, lte: to } },
    select: { id: true, kind: true, state: true, createdAt: true, parentChatId: true, childChatId: true, childRef: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_TASKS,
  });
  const truths = await deriveTruths(tasks, now);
  const tally = tallyAgreement(tasks.map((task) => ({ task, truth: truths.get(task.id) ?? null })));
  const pct = agreementPct(tally);
  const missingParent = tasks.filter((t) => (PARENT_REQUIRED_KINDS as readonly string[]).includes(t.kind) && !t.parentChatId).length;
  // Write-seam coverage: ok spawn receipts in the window with no session task.
  const spawnReceipts: Array<{ ids: any }> = await prisma.runToolReceipt.findMany({
    where: { tool: 'start_coding_session', ok: true, createdAt: { gte: from, lte: to } },
    select: { ids: true },
    take: 2_000,
  });
  const spawnedIds = [...new Set(spawnReceipts.map((r) => (r.ids && typeof r.ids === 'object' ? String(r.ids.sessionId ?? '') : '')).filter(Boolean))];
  let missingRows = 0;
  if (spawnedIds.length) {
    const have: Array<{ childChatId: string | null }> = await db().findMany({ where: { kind: 'session', childChatId: { in: spawnedIds } }, select: { childChatId: true } });
    const haveSet = new Set(have.map((h) => h.childChatId));
    missingRows = spawnedIds.filter((id) => !haveSet.has(id)).length;
  }
  const stale: number = await db().count({ where: { state: { in: ['submitted', 'working', 'input_required'] }, staleAfter: { lt: now } } });
  const pruned = await db().deleteMany({ where: { state: { in: ['completed', 'failed', 'canceled'] }, createdAt: { lt: new Date(now.getTime() - TASK_RETENTION_MS) } } }).catch(() => ({ count: 0 }));
  const meta = {
    windowHours: WINDOW_MS / 3_600_000, checked: tally.checked, agree: tally.agree, mismatch: tally.mismatch,
    missedTerminal: tally.missedTerminal, falseTerminal: tally.falseTerminal, openBoth: tally.openBoth,
    agreementPct: pct, missingParent, missingRows, spawnReceipts: spawnedIds.length, stale,
    pruned: Number(pruned?.count ?? 0), byKind: tally.byKind, samples: tally.samples,
  };
  recordLoopMetric({ kind: LOOP_METRIC_KINDS.DELEGATION_TASK_RECONCILE, value: pct, unit: 'pct', meta });
  return { summary: `ledger ${tally.checked} checked, ${pct}% agree, missingParent ${missingParent}, missingRows ${missingRows}, stale ${stale}`, meta };
}

async function summarizeJournal(now: Date): Promise<{ summary: string; meta: Record<string, unknown> }> {
  const since = new Date(now.getTime() - 86_400_000);
  const states: Array<{ state: string; _count: { _all: number } }> = await intents().groupBy({ by: ['state'], where: { createdAt: { gte: since } }, _count: { _all: true } });
  const verdicts: Array<{ wouldReconcile: string | null; _count: { _all: number } }> = await intents().groupBy({
    by: ['wouldReconcile'], where: { createdAt: { gte: since }, wouldReconcile: { not: null } }, _count: { _all: true },
  });
  const twice: Array<{ idemKey: string }> = await intents().groupBy({
    by: ['idemKey'], where: { createdAt: { gte: since }, state: 'applied' }, _count: { _all: true }, having: { idemKey: { _count: { gt: 1 } } },
  });
  const orphanPending: number = await intents().count({ where: { state: 'pending', createdAt: { gte: since, lt: new Date(now.getTime() - ORPHAN_PENDING_MS) } } });
  // build 2026-10-11 DL-2: calls the act step answered from an earlier attempt (replayed / withheld with a twin) — the
  // population the weekly "0 false skips" sample is drawn from (loop_metrics tool_intent phase act carries each one).
  const actSkips: number = await intents().count({ where: { createdAt: { gte: since }, state: { in: ['replayed', 'withheld'] }, priorIntentId: { not: null } } }).catch(() => 0);
  const pruned = await intents().deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - INTENT_RETENTION_MS) } } }).catch(() => ({ count: 0 }));
  const byState = Object.fromEntries(states.map((s) => [s.state, Number(s._count?._all ?? 0)]));
  const byVerdict = Object.fromEntries(verdicts.map((v) => [String(v.wouldReconcile), Number(v._count?._all ?? 0)]));
  const total = Object.values(byState).reduce((a, b) => a + Number(b), 0);
  const meta = { phase: 'daily', total, byState, byVerdict, executedTwiceKeys: twice.length, orphanPending, actSkips, pruned: Number(pruned?.count ?? 0) };
  recordLoopMetric({ kind: LOOP_METRIC_KINDS.TOOL_INTENT, value: twice.length, unit: 'keys', meta });
  return { summary: `intents ${total}, executed twice ${twice.length}, orphan pending ${orphanPending}`, meta };
}

export async function runDelegationReconcileOnce(now: Date = new Date()): Promise<string> {
  const parts: string[] = [];
  if (!delegationTasksDisabled()) {
    try { parts.push((await reconcileLedger(now)).summary); } catch (err: any) {
      logger.warn(`delegation-reconcile: ledger pass failed (non-fatal): ${err?.message ?? err}`);
      parts.push('ledger error');
    }
  } else parts.push('ledger off');
  if (!toolIntentJournalDisabled()) {
    try { parts.push((await summarizeJournal(now)).summary); } catch (err: any) {
      logger.warn(`delegation-reconcile: journal pass failed (non-fatal): ${err?.message ?? err}`);
      parts.push('journal error');
    }
  } else parts.push('journal off');
  const summary = parts.join('; ').slice(0, 200);
  logger.info(`delegation-reconcile: ${summary}`);
  return summary;
}

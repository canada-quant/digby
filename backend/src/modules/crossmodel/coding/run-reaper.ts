/**
 * agent-run-reaper (durable cron Phase 3) — the continuous, worker-owned
 * version of the boot-time housekeeping, plus retention GC. Fires every 5 min
 * from the cron loop; every rule is best-effort (logged, never thrown — one
 * bad rule must not take the others down with it).
 *
 *   (a) Sessions stuck status='running' with NO claimable agent_runs row
 *       (queued/interrupted/running) and no Redis session lock → 'ready'.
 *       This is exactly sweepOrphanedRunningSessions (the Phase-2 boot sweep),
 *       now running continuously instead of once per web boot.
 *   (b) 'interrupted' agent_runs older than 7 days → 'failed' ('resume window
 *       expired'). A run nobody resumed for a week will never be resumed;
 *       failing it drops the (large) checkpoint and lets rule (a) heal the
 *       session on the same pass.
 *   (c) GC: delete agent_events whose run reached a terminal state > 30 days
 *       ago (the SSE replay window is long past). 5k-row statements so one
 *       never locks the table unboundedly; a pass loops over them until 50k
 *       rows or 20s (review 2026-09-13 issue 10 — one batch per pass could not
 *       keep up with 2-3M inserts/day), and a backlog drains over passes.
 *   (d) GC: delete run_tool_receipts older than 30 days, batched like (c).
 *       createdAt-only, NOT run-joined: runId is a SOFT ref by design —
 *       chat-run receipts carry the turn's telemetry id (chat-<uuid>, ticket
 *       e225aad8), not an agent_runs id — a join to agent_runs could never
 *       GC those. The [chatId, createdAt] index covers the range scan; 30 days
 *       far exceeds every consumer's window (the verifier reads ≤24h back).
 *   (e) SUB-SESSION reap (2026-09-02): a CHILD coding session (its chat has
 *       parentChatId set — it was spawned by another chat) idle > 7 days —
 *       no runs, no messages, no enabled schedules — flips to status
 *       'archived' (the same reversible state archive_chat sets; unarchive
 *       restores 'ready'). Children are fire-and-forget by nature: the parent
 *       harvested the result via its auto hook long ago, and forgotten
 *       satellites otherwise pile up forever. Parents and hand-made sessions
 *       are NEVER touched by this rule.
 *   (f) GC: loop_metrics retention sweep (sweepLoopMetrics — batched,
 *       best-effort inside the service, 30-day window).
 *   (i) worktree-snapshot Redis hygiene (loop #14): re-fit oversized
 *       cm:wt-snap:* payloads to the byte ceiling + clamp TTL to 7 d, once
 *       per 6 h fleet-wide (sweepSnapshotHygiene).
 *   (g) GC: hook_events TERMINAL rows older than 30 days (hardening review
 *       2026-09-14): every in-project completion writes a project-hook row
 *       (plus fleet/child rows), and delivered/failed/skipped rows were never
 *       removed — only the FK cascade on hook deletion, and supervisor hooks
 *       are pause-never-delete. Same shape as (d): ordered 5k id batch →
 *       deleteMany by id, one batch per pass, backlog drains over passes (the
 *       first run against the existing backlog is never one multi-million-row
 *       DELETE — the lock/WAL class the 2026-09-13 agent_events fix removed).
 *       Selection rides the existing (status, createdAt) index. NEVER touches
 *       pending/delivering rows — the hooks sweep's horizon owns those, and
 *       30 d ≫ its 15-min preempt-redelivery lookback. 30 d is also the action
 *       verifier's own hook_events trace window, so no consumer reads further
 *       back than what survives.
 */

import { Prisma } from '@prisma/client';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { killSwitchOn } from '../../../utils/kill-switch';
import { sweepOrphanedRunningSessions } from './coding-data.service';
import { sweepLoopMetrics } from '../platform/loop-metrics.service';

export const RESUME_WINDOW_MS = 7 * 24 * 3600 * 1000;
export const EVENT_GC_AGE_MS = 30 * 24 * 3600 * 1000;
/** Sessions stuck at status='provisioning' longer than this heal to 'ready' —
 *  must comfortably exceed the 8-min installDependencies cap in provisionWorktree. */
export const PROVISIONING_GRACE_MS = 20 * 60 * 1000;
export const EVENT_GC_BATCH = 5_000;
/**
 * Review 2026-09-13 issue 10: rule (c) used to delete ONE 5k batch per ~5-10
 * min pass (~0.7M rows/day) against 2-3M agent_events inserts/day — GC could
 * never catch up (1.6M rows already eligible; agent_events 18 GB of a 22 GB RDS
 * volume with no storage autoscaling). A pass now loops over 5k batches until
 * it has deleted EVENT_GC_PASS_MAX_ROWS or spent EVENT_GC_PASS_BUDGET_MS,
 * whichever first. Each statement stays small (5k ids — no long table lock);
 * the loop just runs more of them while there is backlog, and a short batch
 * (< 5k) means the backlog is drained for this pass.
 */
export const EVENT_GC_PASS_MAX_ROWS = 50_000;
export const EVENT_GC_PASS_BUDGET_MS = 20_000;
export const RECEIPT_GC_AGE_MS = 30 * 24 * 3600 * 1000;
export const RECEIPT_GC_BATCH = 5_000;
/** Rule (g): hook_events terminal-row retention (= the verifier's trace window). */
export const HOOK_EVENT_GC_AGE_MS = 30 * 24 * 3600 * 1000;
export const HOOK_EVENT_GC_BATCH = 5_000;
/**
 * Rule (g): the ONLY statuses GC may select. `pending` and `delivering` are
 * live delivery state owned by the hooks sweep (its horizon fails them into
 * 'failed:horizon', which then ages out here) — never purge them.
 */
export const HOOK_EVENT_GC_TERMINAL_STATUSES: readonly string[] = [
  'delivered', 'failed', 'failed:horizon', 'failed:source_gone', 'failed:target_gone', 'skipped:hook_disabled',
  // Ticket 9df506cc F2 (2026-09-20): the retired-target skip status (ticket
  // 57154856) is TERMINAL exactly like skipped:hook_disabled — left out of
  // this list those rows were never GC-eligible and accumulated forever.
  'skipped:target_retired',
];
/** Rule (e): how long a CHILD session must be fully idle before it is archived. */
export const CHILD_IDLE_REAP_MS = 7 * 24 * 3600 * 1000;
/** Rule (e): candidates examined per pass — a backlog drains over passes. */
export const CHILD_REAP_SCAN_CAP = 200;
/**
 * Rule (h) — FINISHED child archive (autonomy loop #12, 2026-09-20). Rule (e)
 * waits 7 idle days and then flips only the coding_sessions satellite; the
 * chat itself was never stamped archived, so the sidebar and every
 * list_chats kept showing finished one-shot sub-sessions for a week and the
 * supervisor spawned a new near-identically titled verifier each time (six
 * "Spark Lane … Banked Branch … Verification" chats in three days). A child
 * whose plan board is COMPLETE, that holds no enabled schedule, has no live
 * run and has not run for FINISHED_CHILD_ARCHIVE_IDLE_MS is finished work,
 * not a lane — archive it properly (chat archivedAt + satellite) through the
 * same archiveChat the owner's UI uses. Top-level lanes and supervisors are never
 * touched here (parentChatId null / archiveChat refuses supervisors).
 */
export const FINISHED_CHILD_ARCHIVE_IDLE_MS = 6 * 3600 * 1000;
export const FINISHED_CHILD_SCAN_CAP = 100;

/**
 * REAPER CANDIDATE ROTATION (lane lifecycle C4, 2026-10-21). Rules (e) and (h)
 * read a capped candidate page; rule (e) had no orderBy and rule (h) read the
 * OLDEST satellites first, so once a cap's worth of children were permanently
 * ineligible (schedule-armed, plan-less, failed last run) the same page came
 * back every pass and newer finished children were never examined. Now both
 * pages skip what can never pass (an archived chat, a chat with an enabled
 * schedule) at the query and walk the candidates by id from a per-rule cursor:
 * a full page moves the cursor to its last id, a short page resets it, so every
 * candidate is visited within ceil(N / cap) passes. The per-candidate
 * re-verification is unchanged. Kill switch REAPER_CANDIDATE_ROTATION_DISABLED=1
 * restores the previous queries byte-for-byte.
 */
export function reaperCandidateRotationDisabled(): boolean {
  return killSwitchOn(process.env.REAPER_CANDIDATE_ROTATION_DISABLED);
}
let childReapCursor: string | null = null;
let finishedChildCursor: string | null = null;
/** Test hook: both rotation cursors back to the start. */
export function __resetReaperCursorsForTests(): void { childReapCursor = null; finishedChildCursor = null; __resetReaperAuditMemoForTests(); }
/** The next cursor after a page: its last id when it filled the cap, else back to the start. Pure. */
function nextReaperCursor(page: Array<{ id: string }>, cap: number): string | null {
  return page.length >= cap && page.length ? page[page.length - 1].id : null;
}

/**
 * Third review (2026-10-22): ONE cascade budget per reaper pass, shared by the
 * rule (e) and rule (h) archives — archiveChat's machine cascade otherwise got
 * a fresh ARCHIVE_CASCADE_MACHINE_MAX_TOTAL (50) children per archived child.
 */
export const REAPER_CASCADE_MAX_PER_PASS = 25;

/**
 * Third review (2026-10-22): rules (e) and (h) honour the lane-family-facts
 * RESTORE MARKER — "a restored lane is the owner's from then on". A finished
 * sub-session the owner restored (to read its result) used to be re-archived
 * by rule (h) six hours later, and by rule (e) seven days later. One batched
 * marker read per rule per pass (readRestoredChats); a failed read keeps every
 * candidate of that rule this pass. Nothing is read while every marker reader
 * switch is off (no marker is written then).
 */
async function restoredAmong(ids: string[]): Promise<Set<string> | null> {
  const { readRestoredChats } = await import('../platform/lane-family-facts');
  return readRestoredChats(ids);
}

/**
 * "Did this chat write a transcript row since `cutoff`" — the row lives in
 * `crossmodel_messages`, the only transcript table since MERGE-1 completed, so a
 * chat with a fresh row is seen as ACTIVE rather than quiet and reaped while it
 * is still in use.
 */
async function recentTranscriptProbe(chatId: string, cutoff: Date): Promise<{ id: string } | null> {
  return await prisma.crossModelMessage.findFirst({ where: { chatId, createdAt: { gte: cutoff } }, select: { id: true } });
}

/**
 * Fourth review (2026-10-22): the restore AUDIT (archiveChat's chat.restore /
 * chat.archive Activity rows — lane-family-facts readRestoreAuditChats, the
 * reader the ticket drain and lane-retire use) for the candidates that passed
 * EVERY other check — a restore made before the marker shipped has an audit row
 * and no marker, and the C4 candidate rotation now reaches children the old
 * capped oldest-first query never visited. One batched read per rule per pass
 * over a handful of ids; null = the read failed (the caller keeps them all).
 * Nothing is read while every marker reader switch is off (the pre-wave reaper).
 */
async function restoredByAuditAmong(ids: string[], cache?: Map<string, boolean>): Promise<Set<string> | null> {
  if (!ids.length) return new Set();
  const { readRestoreAuditChats, laneRestoreMarkerReadersOff } = await import('../platform/lane-family-facts');
  if (laneRestoreMarkerReadersOff()) return new Set();
  // Fifth review (2026-10-22): a child the audit KEPT stays a candidate pass
  // after pass (it is never archived), and each read is a scan of its owner's
  // audit trail — so a restored verdict is remembered for
  // REAPER_AUDIT_MEMO_MS (in-process; a restored chat stays restored until
  // someone archives it, and an archived chat is no candidate). Only the
  // ids the memo lacks are read; a failed read keeps them all (null).
  const now = Date.now();
  const out = new Set<string>();
  const want: string[] = [];
  for (const id of ids) {
    const until = auditRestoredUntil.get(id);
    if (until !== undefined && until > now) { out.add(id); continue; }
    if (until !== undefined) auditRestoredUntil.delete(id);
    want.push(id);
  }
  if (!want.length) return out;
  const read = await readRestoreAuditChats(want, new Date(now), cache);
  if (!read) return null;
  for (const id of read) {
    out.add(id);
    auditRestoredUntil.delete(id);
    auditRestoredUntil.set(id, now + REAPER_AUDIT_MEMO_MS);
  }
  while (auditRestoredUntil.size > REAPER_AUDIT_MEMO_MAX) auditRestoredUntil.delete(auditRestoredUntil.keys().next().value as string);
  return out;
}
/** Fifth review (2026-10-22): how long the reaper trusts a restore-audit "restored" verdict (in-process memo). */
export const REAPER_AUDIT_MEMO_MS = 6 * 3600_000;
const REAPER_AUDIT_MEMO_MAX = 5000;
const auditRestoredUntil = new Map<string, number>();
/** Tests only: forget the reaper's restore-audit memo. */
export function __resetReaperAuditMemoForTests(): void { auditRestoredUntil.clear(); }

/**
 * Archive a child chat PROPERLY — crossmodel_chats.archivedAt + the coding
 * satellite — through platform.service archiveChat (its own guards: never a
 * supervisor, never with a live run or an enabled schedule). Returns true when
 * the chat is archived after the call. Never throws. Third review (2026-10-22):
 * `cascade` (passed only while the archive cascade is on) hands archiveChat the
 * pass-wide cascade budget and the rule's own idle bar for each child.
 */
async function archiveChildProperly(chatId: string, userId: string, reason: string, meta: Record<string, unknown>, cascade?: { budget: { remaining: number }; idleMs: number; restoreAuditCache?: Map<string, boolean> }): Promise<boolean> {
  try {
    const platform: any = await import('../platform/platform.service');
    if (typeof platform?.archiveChat !== 'function') {
      // Older partial builds: at least park the satellite (rule (e)'s historical behaviour).
      await prisma.chatCodingState.update({ where: { id: chatId }, data: { status: 'archived' } });
      return true;
    }
    await platform.archiveChat({ userId, chatId, archived: true, ...(cascade ? { cascadeBudget: cascade.budget, cascadeIdleMs: cascade.idleMs, ...(cascade.restoreAuditCache ? { restoreAuditCache: cascade.restoreAuditCache } : {}) } : {}) });
    logger.info(`agent-run reaper: archived child session ${chatId} (${reason})`);
    void import('../platform/loop-metrics.service')
      .then((m) => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.CHILD_SESSION_ARCHIVED, sessionId: chatId, meta: { reason, ...meta } }))
      .catch(() => {});
    return true;
  } catch (err: any) {
    logger.warn(`agent-run reaper: child archive for ${chatId} (${reason}) failed (non-fatal): ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Rule (c), index-friendly (audit 2026-10-06 T8-8). The legacy select —
 * `agent_events JOIN agent_runs … WHERE r.status IN (terminal) AND
 * r.finishedAt < cutoff ORDER BY e.id LIMIT 5000` — ran 43 s in prod against a
 * 19 M-row table: the ORDER BY over a join forces a PK walk with a run probe
 * per event (or a hash join + sort) before LIMIT can stop it. This walk reads
 * PK ranges instead: each batch is `SELECT id, runId, createdAt … WHERE id >
 * cursor ORDER BY id LIMIT n` (a pure primary-key range scan), the batch's
 * distinct runs are checked by primary key, and only events of terminal runs
 * finished before the cutoff are deleted. An event is written before its run
 * finishes, so a qualifying event is always older than the cutoff: the walk
 * stops at the first batch that reaches events created at/after it (ids grow
 * with time) — with the agent_events retention job keeping the old head
 * trimmed, a steady-state pass is ONE small range read. Bounded by the same
 * EVENT_GC_PASS_MAX_ROWS (rows scanned) / EVENT_GC_PASS_BUDGET_MS.
 * EVENT_GC_PK_RANGE_DISABLED=1 restores the join select.
 */
export function eventGcPkRangeDisabled(): boolean {
  return process.env.EVENT_GC_PK_RANGE_DISABLED === '1';
}

const EVENT_GC_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

export async function gcTerminalRunEventsByPkRange(cutoff: Date, passStart: number = Date.now()): Promise<{ deleted: number; batches: number; scanned: number; more: boolean }> {
  let cursor = BigInt(0);
  let deleted = 0;
  let batches = 0;
  let scanned = 0;
  let more = false;
  while (scanned < EVENT_GC_PASS_MAX_ROWS && Date.now() - passStart < EVENT_GC_PASS_BUDGET_MS) {
    const rows = await prisma.$queryRaw<Array<{ id: bigint; runId: string; createdAt: Date }>>`
      SELECT e."id", e."runId", e."createdAt" FROM "agent_events" e
      WHERE e."id" > ${cursor}
      ORDER BY e."id"
      LIMIT ${EVENT_GC_BATCH}`;
    if (!rows.length) { more = false; break; }
    batches++;
    scanned += rows.length;
    cursor = rows[rows.length - 1].id;
    const old = rows.filter((r) => new Date(r.createdAt).getTime() < cutoff.getTime());
    if (old.length) {
      const runIds = [...new Set(old.map((r) => r.runId))];
      const eligible = new Set((await prisma.agentRun.findMany({
        where: { id: { in: runIds }, status: { in: EVENT_GC_TERMINAL_STATUSES }, finishedAt: { lt: cutoff } },
        select: { id: true },
      })).map((r: { id: string }) => r.id));
      const ids = old.filter((r) => eligible.has(r.runId)).map((r) => r.id);
      if (ids.length) {
        const del = await prisma.agentEvent.deleteMany({ where: { id: { in: ids } } });
        deleted += del.count;
      }
    }
    // The walk reached events created at/after the cutoff — nothing past here can qualify.
    if (old.length < rows.length) { more = false; break; }
    more = rows.length === EVENT_GC_BATCH;
    if (!more) break;
  }
  return { deleted, batches, scanned, more };
}

export async function runAgentRunReaper(): Promise<void> {
  // (b) FIRST: expiring an ancient interrupted run removes the claimable row
  // that would otherwise make rule (a) skip its session — same-pass healing.
  try {
    const cutoff = new Date(Date.now() - RESUME_WINDOW_MS);
    const expired = await prisma.agentRun.updateMany({
      where: { status: 'interrupted', updatedAt: { lt: cutoff } },
      data: {
        status: 'failed',
        error: 'resume window expired',
        finishedAt: new Date(),
        checkpoint: Prisma.DbNull, // dead weight once resumability is gone (full transcript)
        leaseExpiresAt: null,
        workerId: null,
      },
    });
    if (expired.count) {
      logger.info(`agent-run reaper: expired ${expired.count} interrupted run(s) past the 7d resume window → failed`);
    }
  } catch (err: any) {
    logger.warn(`agent-run reaper: resume-window expiry failed (non-fatal): ${err.message}`);
  }

  // (a) orphaned running sessions → ready (no claimable row, no Redis lock).
  try {
    const healed = await sweepOrphanedRunningSessions();
    if (healed) logger.info(`agent-run reaper: healed ${healed} orphaned running session(s) → ready`);
  } catch (err: any) {
    logger.warn(`agent-run reaper: orphan sweep failed (non-fatal): ${err.message}`);
  }

  // (a2) stuck provisioning sessions → ready (2026-08-27). provisionWorktree is
  // an unawaited promise in the web process with no durable in-flight marker —
  // a deploy/crash between session creation and the status:'ready' write leaves
  // the row at 'provisioning' FOREVER: run-state's queue gate (status:'ready')
  // makes it absorbing (no run can ever start, every send 409s "busy"), no
  // other reaper covers it, and ticket-dispatch counts it against lane
  // batch-session capacity permanently (found: a row stuck 4 days silently ate
  // 1 of 3 slots). Grace window comfortably exceeds the 8-min dep-install cap;
  // flipping to 'ready' is safe because ensureRunnable re-provisions the
  // worktree idempotently on the next run start.
  try {
    const graceCutoff = new Date(Date.now() - PROVISIONING_GRACE_MS);
    const stuck = await prisma.chatCodingState.updateMany({
      where: { status: 'provisioning', updatedAt: { lt: graceCutoff } },
      // errorMessage: null — ticket 911b6c45: a heal flip out of a stuck state
      // must not leave the stuck state's error text behind (provisioning rows
      // can carry one only via ensureProvisioned's error path, which writes
      // status:'error' — belt and braces for any legacy row).
      data: { status: 'ready', errorMessage: null },
    });
    if (stuck.count) {
      logger.info(`agent-run reaper: healed ${stuck.count} session(s) stuck in provisioning past ${Math.round(PROVISIONING_GRACE_MS / 60000)}m → ready`);
    }
  } catch (err: any) {
    logger.warn(`agent-run reaper: provisioning sweep failed (non-fatal): ${err.message}`);
  }

  // Ticket 911b6c45 backfill: clear errorMessage on every NON-error row that
  // still carries one. Rows landed here through the pre-fix heal/claim/orphan
  // paths (status:'ready' written WITHOUT errorMessage:null) — the read paths
  // now mask them, but the column should be truthful, and any raw DB reader
  // (admin dashboards, the fleet digest) sees the stale text until healed.
  // Idempotent: every pass updates only rows still holding a message, so once
  // the backlog is drained it's a no-op counting zero.
  try {
    const staleErrors = await prisma.chatCodingState.updateMany({
      where: { errorMessage: { not: null }, status: { not: 'error' } },
      data: { errorMessage: null },
    });
    if (staleErrors.count) {
      logger.info(`agent-run reaper: cleared stale errorMessage on ${staleErrors.count} non-error session(s) (ticket 911b6c45)`);
    }
  } catch (err: any) {
    logger.warn(`agent-run reaper: stale-errorMessage sweep failed (non-fatal): ${err.message}`);
  }

  // (c) event GC — terminal runs whose finishedAt is > 30 days ago. Review
  // 2026-09-13 issue 10: time-bounded loop of 5k batches (≤ EVENT_GC_PASS_MAX_ROWS
  // rows / ≤ EVENT_GC_PASS_BUDGET_MS per pass) instead of a single 5k batch, so
  // GC keeps pace with 2-3M inserts/day. A batch failure ends the pass (logged,
  // never thrown); rows already deleted this pass stay deleted.
  try {
    const cutoff = new Date(Date.now() - EVENT_GC_AGE_MS);
    const passStart = Date.now();
    let deleted = 0;
    let batches = 0;
    let more = false;
    if (!eventGcPkRangeDisabled()) {
      // audit 2026-10-06 T8-8: index-friendly PK-range walk (see gcTerminalRunEventsByPkRange).
      const r = await gcTerminalRunEventsByPkRange(cutoff, passStart);
      deleted = r.deleted; batches = r.batches; more = r.more;
    } else {
      while (deleted < EVENT_GC_PASS_MAX_ROWS && Date.now() - passStart < EVENT_GC_PASS_BUDGET_MS) {
        const ids = await prisma.$queryRaw<{ id: bigint }[]>`
          SELECT e."id" FROM "agent_events" e
          JOIN "agent_runs" r ON r."id" = e."runId"
          WHERE r."status" IN ('completed', 'failed', 'cancelled')
            AND r."finishedAt" < ${cutoff}
          ORDER BY e."id"
          LIMIT ${EVENT_GC_BATCH}`;
        if (!ids.length) { more = false; break; }
        const del = await prisma.agentEvent.deleteMany({ where: { id: { in: ids.map(r => r.id) } } });
        deleted += del.count;
        batches++;
        // A short batch means the eligible set is drained for this pass; a full
        // one means there may be more — the loop head decides whether to go on.
        more = ids.length === EVENT_GC_BATCH;
        if (!more) break;
      }
    }
    if (deleted) {
      const elapsedMs = Date.now() - passStart;
      logger.info(`agent-run reaper: GC deleted ${deleted} agent_events in ${batches} batch(es) / ${elapsedMs}ms (terminal runs > 30d old${more ? ', more next pass' : ''})`);
    }
  } catch (err: any) {
    logger.warn(`agent-run reaper: event GC failed (non-fatal): ${err.message}`);
  }

  // (d) receipts GC — run_tool_receipts rows older than 30 days, ≤ 5k per pass.
  try {
    const cutoff = new Date(Date.now() - RECEIPT_GC_AGE_MS);
    const ids = await prisma.runToolReceipt.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: RECEIPT_GC_BATCH,
    });
    if (ids.length) {
      const del = await prisma.runToolReceipt.deleteMany({ where: { id: { in: ids.map((r) => r.id) } } });
      logger.info(`agent-run reaper: GC deleted ${del.count} run_tool_receipts (> 30d old${ids.length === RECEIPT_GC_BATCH ? ', more next pass' : ''})`);
    }
  } catch (err: any) {
    logger.warn(`agent-run reaper: receipts GC failed (non-fatal): ${err.message}`);
  }

  // (g) hook_events GC — TERMINAL rows older than 30 days, ≤ 5k per pass
  // (hardening review 2026-09-14). Observe/record only: one info line per pass
  // with the count; a failure is logged and skips nothing else. The status
  // allowlist is the safety property — pending/delivering rows are live
  // delivery state and are never selected.
  try {
    const cutoff = new Date(Date.now() - HOOK_EVENT_GC_AGE_MS);
    const ids = await prisma.hookEvent.findMany({
      where: { status: { in: [...HOOK_EVENT_GC_TERMINAL_STATUSES] }, createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: HOOK_EVENT_GC_BATCH,
    });
    if (ids.length) {
      const del = await prisma.hookEvent.deleteMany({ where: { id: { in: ids.map((r) => r.id) } } });
      logger.info(`agent-run reaper: GC deleted ${del.count} hook_events (terminal, > 30d old${ids.length === HOOK_EVENT_GC_BATCH ? ', more next pass' : ''})`);
    }
  } catch (err: any) {
    logger.warn(`agent-run reaper: hook_events GC failed (non-fatal): ${err.message}`);
  }

  // Third review (2026-10-22): the pass-wide cascade budget rules (e) and (h)
  // share — handed to archiveChat only while the archive cascade is on (the
  // call is the pre-cascade one byte-for-byte under ARCHIVE_CASCADE_DISABLED=1).
  let cascade: { remaining: number } | null = null;
  try {
    const { archiveCascadeDisabled } = await import('../platform/lane-family-facts');
    cascade = archiveCascadeDisabled() ? null : { remaining: REAPER_CASCADE_MAX_PER_PASS };
  } catch { cascade = null; }
  // Fifth review (2026-10-22): ONE restore-audit memo per pass, shared by rules
  // (e) / (h) and every cascade they start (a chat's audit trail is read once
  // per pass, never once per rule / per child).
  const passAuditCache = new Map<string, boolean>();

  // (e) SUB-SESSION reap — idle children (> 7d, no runs/messages/schedules) →
  // 'archived'. Cheap pre-filter on the satellite + chat updatedAt (both bump
  // on any activity), then a per-candidate re-verification against the real
  // activity tables — the pre-filter alone could archive a session whose only
  // recent activity lives in agent_runs/coding_messages without bumping the
  // rows the filter sees, and vice versa a stale-looking satellite must never
  // shadow an ACTIVE run. Bounded (CHILD_REAP_SCAN_CAP) and best-effort.
  try {
    const cutoff = new Date(Date.now() - CHILD_IDLE_REAP_MS);
    const rotate = !reaperCandidateRotationDisabled();
    const candidates: Array<{ id: string; userId: string }> = rotate
      ? await prisma.chatCodingState.findMany({
        where: {
          status: { in: ['ready', 'error'] }, // never running/provisioning; never re-archive
          updatedAt: { lt: cutoff },
          ...(childReapCursor ? { id: { gt: childReapCursor } } : {}),
          // C4: rows that can never pass (archived chat, enabled schedule) never take a page slot.
          chat: { is: { parentChatId: { not: null }, updatedAt: { lt: cutoff }, archivedAt: null, chatSchedules: { none: { enabled: true } } } },
        },
        select: { id: true, userId: true },
        orderBy: { id: 'asc' },
        take: CHILD_REAP_SCAN_CAP,
      })
      : await prisma.chatCodingState.findMany({
        where: {
          status: { in: ['ready', 'error'] }, // never running/provisioning; never re-archive
          updatedAt: { lt: cutoff },
          chat: { is: { parentChatId: { not: null }, updatedAt: { lt: cutoff } } },
        },
        select: { id: true, userId: true },
        take: CHILD_REAP_SCAN_CAP,
      });
    if (rotate) childReapCursor = nextReaperCursor(candidates, CHILD_REAP_SCAN_CAP);
    let archived = 0;
    // Third review (2026-10-22): a child the owner restored stays; a failed marker read keeps them all.
    const restored = candidates.length ? await restoredAmong(candidates.map((c) => c.id)) : new Set<string>();
    const ready: Array<{ id: string; userId: string }> = [];
    for (const c of candidates as Array<{ id: string; userId: string }>) {
      if (!restored || restored.has(c.id)) continue;
      const [recentRun, activeRun, recentMsg, enabledSchedules] = await Promise.all([
        prisma.agentRun.findFirst({ where: { sessionId: c.id, createdAt: { gte: cutoff } }, select: { id: true } }),
        prisma.agentRun.findFirst({ where: { sessionId: c.id, status: { in: ['queued', 'running', 'interrupted'] } }, select: { id: true } }),
        // MERGE-1 slice 1: the "did this chat write a transcript row recently" probe must
        // read the table the read-switch serves; a mirror-only chat has no coding_messages
        // rows, so the old probe always said "quiet" and reaped a live chat.
        recentTranscriptProbe(c.id, cutoff),
        prisma.chatSchedule.count({ where: { sessionId: c.id, enabled: true } }),
      ]);
      if (recentRun || activeRun || recentMsg || enabledSchedules > 0) continue;
      ready.push(c);
    }
    // Fourth review (2026-10-22): a restore the marker never recorded (the audit) keeps the child; a failed read keeps them all.
    const audited = await restoredByAuditAmong(ready.map((c) => c.id), passAuditCache);
    for (const c of ready) {
      if (!audited || audited.has(c.id)) continue;
      // Loop #12: archive PROPERLY (chat archivedAt + satellite) — the old
      // satellite-only flip left the chat visible in the sidebar and every
      // list_chats for good (idle-chat-archiver.ts admits the gap).
      const ok = await archiveChildProperly(c.id, c.userId, 'idle_7d', { idleDays: Math.round(CHILD_IDLE_REAP_MS / 86_400_000) }, cascade ? { budget: cascade, idleMs: CHILD_IDLE_REAP_MS, restoreAuditCache: passAuditCache } : undefined);
      if (ok) archived++;
    }
    if (archived) {
      logger.info(`agent-run reaper: archived ${archived} idle child session(s) this pass`);
    }
  } catch (err: any) {
    logger.warn(`agent-run reaper: child-session reap failed (non-fatal): ${err.message}`);
  }

  // (h) FINISHED-CHILD archive (autonomy loop #12): a spawned child whose plan
  // board is complete, with no enabled schedule, no live run and no run for
  // FINISHED_CHILD_ARCHIVE_IDLE_MS, is archived properly. Candidates come from
  // the satellite (ready/error, parent set, chat not yet archived); each is
  // re-verified against agent_runs + coding_schedules + the plan board so a
  // stale-looking satellite never shadows live work. Bounded, best-effort.
  try {
    const cutoff = new Date(Date.now() - FINISHED_CHILD_ARCHIVE_IDLE_MS);
    const rotate = !reaperCandidateRotationDisabled();
    const candidates: Array<{ id: string; userId: string }> = rotate
      ? await prisma.chatCodingState.findMany({
        where: {
          status: { in: ['ready', 'error'] },
          updatedAt: { lt: cutoff },
          ...(finishedChildCursor ? { id: { gt: finishedChildCursor } } : {}),
          chat: { is: { parentChatId: { not: null }, archivedAt: null, chatSchedules: { none: { enabled: true } } } },
        },
        select: { id: true, userId: true },
        orderBy: { id: 'asc' },
        take: FINISHED_CHILD_SCAN_CAP,
      })
      : await prisma.chatCodingState.findMany({
        where: {
          status: { in: ['ready', 'error'] },
          updatedAt: { lt: cutoff },
          chat: { is: { parentChatId: { not: null }, archivedAt: null } },
        },
        select: { id: true, userId: true },
        orderBy: { updatedAt: 'asc' },
        take: FINISHED_CHILD_SCAN_CAP,
      });
    if (rotate) finishedChildCursor = nextReaperCursor(candidates, FINISHED_CHILD_SCAN_CAP);
    let archived = 0;
    // Third review (2026-10-22): a child the owner restored stays; a failed marker read keeps them all.
    const restored = candidates.length ? await restoredAmong(candidates.map((c) => c.id)) : new Set<string>();
    const ready: Array<{ c: { id: string; userId: string }; idleH: number; steps: number }> = [];
    for (const c of candidates) {
      if (!restored || restored.has(c.id)) continue;
      const [liveRun, lastRun, enabledSchedules] = await Promise.all([
        prisma.agentRun.findFirst({ where: { sessionId: c.id, status: { in: ['queued', 'running', 'interrupted'] } }, select: { id: true } }),
        prisma.agentRun.findFirst({ where: { sessionId: c.id }, orderBy: { createdAt: 'desc' }, select: { status: true, finishedAt: true, createdAt: true } }),
        prisma.chatSchedule.count({ where: { sessionId: c.id, enabled: true } }),
      ]);
      if (liveRun || enabledSchedules > 0) continue;
      // Never ran → not "finished" (rule (e) handles abandoned children after 7 d).
      if (!lastRun || lastRun.status !== 'completed') continue;
      const endedAt = lastRun.finishedAt ?? lastRun.createdAt;
      if (!endedAt || new Date(endedAt).getTime() > cutoff.getTime()) continue;
      // Plan board must exist and be COMPLETE — a child with no plan or with
      // open steps is not finished, only quiet; leave it for rule (e).
      let planComplete = false;
      let steps = 0;
      try {
        const { getPlanStrict } = await import('./plan.service');
        const plan = await getPlanStrict(c.id);
        steps = plan?.steps?.length ?? 0;
        planComplete = steps > 0 && (plan!.steps as Array<{ status: string }>).every((st) => st.status !== 'pending' && st.status !== 'in_progress');
      } catch { planComplete = false; }
      if (!planComplete) continue;
      const idleH = Math.round((Date.now() - new Date(endedAt).getTime()) / 3_600_000);
      ready.push({ c, idleH, steps });
    }
    // Fourth review (2026-10-22): a restore the marker never recorded (the audit) keeps the child; a failed read keeps them all.
    const audited = await restoredByAuditAmong(ready.map((r) => r.c.id), passAuditCache);
    for (const { c, idleH, steps } of ready) {
      if (!audited || audited.has(c.id)) continue;
      const ok = await archiveChildProperly(c.id, c.userId, 'finished', { idleH, steps }, cascade ? { budget: cascade, idleMs: FINISHED_CHILD_ARCHIVE_IDLE_MS, restoreAuditCache: passAuditCache } : undefined);
      if (ok) archived++;
    }
    if (archived) logger.info(`agent-run reaper: archived ${archived} FINISHED child session(s) this pass (plan complete, no schedule, idle ≥ ${Math.round(FINISHED_CHILD_ARCHIVE_IDLE_MS / 3_600_000)} h)`);
  } catch (err: any) {
    logger.warn(`agent-run reaper: finished-child archive failed (non-fatal): ${err.message}`);
  }

  // (f) loop_metrics retention GC — the wave-1 telemetry table's sweep
  // (loop-metrics.service): already batched + best-effort internally (never
  // throws), so no try/catch wrapper is needed here.
  await sweepLoopMetrics();

  // (i) worktree-snapshot Redis hygiene (autonomy loop #14, 2026-09-21): the
  // Files-tab snapshot pile (244 keys, up to 1.65 MB, 30 d TTL) filled the
  // shared 256 MB allkeys-lru Redis and evicted the session run LOCKS. New
  // snapshots are capped at publish; this re-fits the EXISTING ones to the
  // ceiling and clamps their TTL to 7 d. One pass per 6 h fleet-wide (NX
  // lock inside); dynamic import keeps this module off the redis chain.
  try {
    const { sweepSnapshotHygiene } = await import('./worktree-snapshot.service');
    await sweepSnapshotHygiene();
  } catch (err: any) {
    logger.warn(`agent-run reaper: snapshot hygiene skipped: ${err?.message ?? err}`);
  }
  // (j) Disk lock-litter sweep (Framework Operator firing 3, 2026-09-22): the
  // checkpoint temp-index locks leaked by signal-killed `git add` were never
  // removed — 12+ zero-byte .snap-index-*.lock strays in WORKSPACE_ROOT on
  // box C (some from August). The reseed fix handles new failures in-process;
  // this cleans the backlog on every reaper pass.
  try {
    const { sweepSnapshotLockLitter } = await import('./worktree-snapshot.service');
    await sweepSnapshotLockLitter();
  } catch (err: any) {
    logger.warn(`agent-run reaper: snapshot lock-litter sweep skipped: ${err?.message ?? err}`);
  }
}

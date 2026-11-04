/**
 * Supervisor wake ledger — the DB side of audit 2026-10-08 W6 (the rule, the
 * renderer and the history selector are pure in ./wake-material-rule.ts).
 *
 *  1. HIGH-WATER MARK — per supervisor chat, the START of its last completed
 *     machine wake (context store ['wake-ledger', chatId] / 'hwm'), written by
 *     the chat finalize (onSupervisorRunFinalized). Fallback: the newest
 *     machine-wake turn in the transcript, else now − 24 h (⇒ heartbeat).
 *  2. THE DIFF — computeWakeLedgerDiff reads, bounded and in parallel, what
 *     the ledger recorded in the supervisor's scope since the mark: owner
 *     messages / answers, goal + todo transitions (activities audit rows),
 *     lane runs, PR / push receipts, schedules fired / stopped, owner
 *     directives captured, tickets, agent messages into this chat, stalled
 *     lanes and the material gate's own skips. buildWakeLedgerBlock renders it
 *     as [SINCE YOUR LAST WAKE] for every supervisor MACHINE wake.
 *  3. THE GATE — materialGateForHook / ForSweep / ForDrain evaluate the pure
 *     rule over that diff + the trigger; the call sites (hooks.service
 *     deliverHookGroup, schedule.service stock sweeps, chat-agent
 *     drainChatQueue) skip a non-material wake and count it.
 *  4. COMPARISON + OUTCOME — recordMaterialGateAgreement writes one row per
 *     site decision beside the Jev purposes (shadow) that asked at the same
 *     site; the finalize writes `supervisor_material_gate_outcome` (did the
 *     delivered wake take a real action — the harness label of
 *     decision-outcome-labels realActionToolNames).
 *  5. TIERS (supervisor SOTA 2026-10-20, SUP-WAKE-TIERS) — a material verdict
 *     whose every reason is PROGRESS (wake-material-rule REASON_TIER) is
 *     skipped as 'skipped:progress_self_driving' when every source lane still
 *     drives itself (platform/lane-self-driving.ts — a live run or a schedule
 *     armed soon; never a todo alone, never a lane the diff lists as stalled,
 *     never more than 50 source lanes), below the progress heartbeat; 1 in
 *     SUPERVISOR_PROGRESS_SKIP_CONTROL_RATE such skips delivers as a CONTROL
 *     whose outcome row carries control:true. Any lookup error delivers. A lane
 *     report / run summary carrying an ask or a blocker is DECISION (lane_ask)
 *     and never held. Kill switch SUPERVISOR_MATERIAL_TIERS_DISABLED=1.
 *
 * Every read is bounded and every entry point is FAIL-OPEN: an error, a
 * timeout, a non-supervisor target ⇒ { skip:false } and the wake runs as
 * before. Kill switches in ./wake-material-rule.ts.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric } from './loop-metrics.service';
import { REDACT_HEAD_MARGIN, REDACTED_NOTE, redactInboundHead } from './secret-scan';
import {
  decideMaterialChange, drawProgressControl, emptyWakeLedgerDiff, isMaterialLedgerTransition, materialGateFloorHours, materialGateMode,
  materialTiersDisabled, progressHeartbeatHours, progressSkipDecision, progressSourceLaneIds,
  renderWakeLedgerDiff, statusChangeTier, wakeLedgerDiffActive, wakeLedgerUnderTest, MATERIAL_GATE_SKIP_STATUSES, STALL_IDLE_MIN,
  type LedgerArtifact, type LedgerPsCovered, type LedgerStatusChange, type MaterialDrainMessage, type MaterialGateMode, type MaterialInput, type MaterialSkipReason,
  type MaterialTriggerRow, type MaterialVerdict, type ProgressSkipWhy, type WakeGateOrigin, type WakeLedgerDiff,
} from './wake-material-rule';
import { failureResumeQueued, hookAlarmCauseAwareDisabled, quietAlarmCause } from './alarm-cause';
import { allLanesSelfDriving, SELF_DRIVING_MAX_LANES } from './lane-self-driving';
import { fleetAlarmPsFirstDisabled, fleetDiffPsCoveredDisabled } from './fleet-ps-first';
import { laneIdleWakeDisabled, scheduleArmsLane } from '../coding/lane-idle';

/** Window bound: a mark older than this is clamped (a long outage never scans a week). */
export const WAKE_LEDGER_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Whole-diff read deadline — past it the gate fails open and the block is omitted. */
export const WAKE_LEDGER_READ_TIMEOUT_MS = 5000;
/** SUP-WAKE-TIERS lane self-driving read deadline — past it the progress wake delivers. */
export const LANE_SELF_DRIVING_TIMEOUT_MS = 3000;
/** Read bounds (pathology guards). */
export const WAKE_LEDGER_MAX_SCOPE_CHATS = 2000;
const MAX_RUNS = 500;
const MAX_RECEIPTS = 200;
const MAX_ACTIVITIES = 300;
const MAX_MESSAGES = 120;
/** Chars of each owner / agent message head the diff carries (the renderer shows ≤ 120 of them). */
const MESSAGE_HEAD_CHARS = 400;
/**
 * Chars of each owner / agent message the read fetches: the head + the redactor's margin (re-review 2026-10-23), so a
 * credential that straddles char 400 — several tokens long included, e.g. a spaced app password — is matched WHOLE
 * before the head is cut. At most MAX_MESSAGES × 912 chars per read.
 */
const MESSAGE_READ_CHARS = MESSAGE_HEAD_CHARS + REDACT_HEAD_MARGIN;

/** Drop `s`'s trailing token (it may be part of a credential), keeping through the end of a redaction note it carries. */
function dropTrailingToken(s: string): string {
  const m = /\S+$/.exec(s);
  if (!m) return s;
  const note = s.lastIndexOf(REDACTED_NOTE);
  if (note >= 0 && note + REDACTED_NOTE.length > m.index) return s.slice(0, note + REDACTED_NOTE.length);
  return s.slice(0, m.index);
}

/**
 * The head a ledger diff carries for an owner / agent message (round-3 review + re-review, FS owner-turn context,
 * 2026-10-23). `read` is the first MESSAGE_READ_CHARS of the message and `cut` says the message went on past it.
 * The WHOLE read is redacted first (secret-scan redactInboundHead), then the head is cut at `n` on a token boundary:
 * a token that straddles `n` is dropped whole, a redaction note that straddles it is kept whole. Dropping only the
 * trailing token of a 400-char read (round 3) left the leading tokens of a SEVERAL-token credential — "abcd efgh
 * ijkl" of a spaced app password no longer matches the 16-letter shape. When the read itself was cut and nothing
 * past `n` is left to cut, its trailing token is dropped (nothing past it was read to redact against). No clip
 * downstream can show a key or a fragment of one. Pure; never throws.
 */
export function ledgerSafeHead(read: string, cut: boolean, n: number = MESSAGE_HEAD_CHARS): string {
  const r = redactInboundHead(String(read ?? ''), n);
  const s = r.text;
  if (s.length > n) {
    for (let i = s.indexOf(REDACTED_NOTE); i >= 0 && i < n; i = s.indexOf(REDACTED_NOTE, i + REDACTED_NOTE.length)) {
      if (i + REDACTED_NOTE.length > n) return `${s.slice(0, i + REDACTED_NOTE.length)} …`;
    }
    const head = s.slice(0, n);
    const midToken = /\S/.test(s[n]) && /\S/.test(s[n - 1]);
    return `${(midToken ? dropTrailingToken(head) : head).trimEnd()} …`;
  }
  return cut || r.cut ? `${dropTrailingToken(s).trimEnd()} …` : s;
}
const MAX_TODOS = 100;
/** LANE-IDLE-WAKE: enabled-schedule rows read for the stall "armed" check (they carry nextRunAt / cadence now). */
const MAX_ARMED_SCHEDULES = 500;

const STORE_NS = (chatId: string): string[] => ['wake-ledger', chatId];
const STORE_KEY = 'hwm';

/** Receipt tools the diff lists (artifacts). Only PRs are material (wake-material-rule). */
const ARTIFACT_RECEIPT_TOOLS = ['open_pull_request', 'merge_pull_request', 'git_push', 'push_to_github', 'register_artifact'];
/** Goal / todo audit actions the diff reads. */
const LEDGER_ACTIONS = [
  'goal.update', 'todo.update', 'goal.create', 'todo.create', 'goal.auto_done', 'goal.auto_block', 'goal.auto_unblock',
  'goal.auto_reopen', 'goal.force_done', 'todo.auto_block', 'todo.auto_unblock', 'todo.force_done',
];
/** Assistant rows the harness writes into supervisor chats (never a completed wake). */
const HARNESS_ASSISTANT_KINDS = new Set(['project_status', 'owner_briefing', 'watched-resource', 'report_up_ack', 'material_gate_ack']);
const HARNESS_ASSISTANT_ORIGINS = new Set(['project_status', 'attention-watchdog', 'owner-inbox', 'report-up-ack', 'material-gate-ack']);
const MACHINE_WAKE_ORIGINS = new Set(['hook', 'schedule', 'machine', 'webhook']);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    (t as any).unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const iso = (d: unknown): string => {
  const t = d instanceof Date ? d.getTime() : Date.parse(String(d ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString();
};

// ── 1. High-water mark ──────────────────────────────────────────────────────

/** Clamp a mark into [now − 24 h, now]. Pure. */
export function clampHighWaterMark(at: Date | null, now: Date): Date {
  const floor = now.getTime() - WAKE_LEDGER_MAX_WINDOW_MS;
  if (!at || !Number.isFinite(at.getTime())) return new Date(floor);
  return new Date(Math.min(now.getTime(), Math.max(floor, at.getTime())));
}

/**
 * The start of the last completed machine wake in the transcript (fallback
 * before the first finalize wrote the store row): the newest assistant row of
 * a machine-wake turn, anchored to its prompt row. Pure over newest-first rows.
 */
export function transcriptHighWaterMark(rowsNewestFirst: Array<{ role: string; createdAt: Date; origin?: string | null; kind?: string | null }>): Date | null {
  for (let i = 0; i < rowsNewestFirst.length; i += 1) {
    const r = rowsNewestFirst[i];
    if (r.role !== 'assistant') continue;
    if (r.kind && HARNESS_ASSISTANT_KINDS.has(r.kind)) continue;
    if (r.origin && HARNESS_ASSISTANT_ORIGINS.has(r.origin)) continue;
    if (!r.origin || !MACHINE_WAKE_ORIGINS.has(r.origin)) continue;
    for (let j = i + 1; j < rowsNewestFirst.length; j += 1) {
      if (rowsNewestFirst[j].role === 'user') return rowsNewestFirst[j].createdAt;
      if (rowsNewestFirst[j].role === 'assistant') break;
    }
    return r.createdAt;
  }
  return null;
}

/** Read the mark (store → transcript → now − 24 h), clamped. Never throws. */
export async function readWakeHighWaterMark(chatId: string, now: Date = new Date()): Promise<{ at: Date; source: 'store' | 'transcript' | 'default' }> {
  try {
    const { storeGet } = await import('../memory/context-store');
    const row = await storeGet<{ at?: string }>(STORE_NS(chatId), STORE_KEY);
    const t = row?.at ? Date.parse(row.at) : NaN;
    if (Number.isFinite(t)) return { at: clampHighWaterMark(new Date(t), now), source: 'store' };
  } catch { /* fall through */ }
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ role: string; createdAt: Date; origin: string | null; kind: string | null }>>(
      `SELECT role, "createdAt", metadata->>'origin' AS origin, metadata->>'kind' AS kind FROM crossmodel_messages WHERE "chatId" = $1 ORDER BY "createdAt" DESC LIMIT 40`,
      chatId,
    );
    const at = transcriptHighWaterMark(Array.isArray(rows) ? rows : []);
    if (at) return { at: clampHighWaterMark(at, now), source: 'transcript' };
  } catch { /* fall through */ }
  return { at: clampHighWaterMark(null, now), source: 'default' };
}

/**
 * FLEET-PS-FIRST (2026-10-20): the start of a machine wake still RUNNING on a
 * chat — the chat is busy (the shared cross-process busy check) and its newest
 * user row is a machine-wake prompt (written when that wake started). The mark
 * above only advances when a wake COMPLETES, so a held escalation reads this
 * to see a project supervisor mid-way through the wake most likely handling
 * the alarm. Null when idle, when the running turn is not a machine wake, or
 * on any error. Never throws.
 */
export async function readInflightMachineWakeStart(chatId: string): Promise<Date | null> {
  try {
    const { isChatBusy } = await import('../chat-agent/chat-busy');
    if (!(await isChatBusy(chatId))) return null;
    const rows = await prisma.$queryRawUnsafe<Array<{ createdAt: Date | string; origin: string | null }>>(
      `SELECT "createdAt", metadata->>'origin' AS origin FROM crossmodel_messages WHERE "chatId" = $1 AND role = 'user' ORDER BY "createdAt" DESC LIMIT 1`,
      chatId,
    );
    const top = Array.isArray(rows) ? rows[0] : null;
    if (!top?.origin || !MACHINE_WAKE_ORIGINS.has(top.origin)) return null;
    const at = top.createdAt instanceof Date ? top.createdAt : new Date(top.createdAt);
    return Number.isFinite(at.getTime()) ? at : null;
  } catch {
    return null;
  }
}

/** Advance the mark (monotonic — an older value never overwrites a newer one). Never throws. */
export async function recordWakeHighWaterMark(chatId: string, at: Date): Promise<void> {
  try {
    const { storeGet, storePut } = await import('../memory/context-store');
    const prev = await storeGet<{ at?: string }>(STORE_NS(chatId), STORE_KEY).catch(() => null);
    const prevMs = prev?.at ? Date.parse(prev.at) : NaN;
    if (Number.isFinite(prevMs) && prevMs >= at.getTime()) return;
    await storePut(STORE_NS(chatId), STORE_KEY, { at: at.toISOString(), writtenAt: new Date().toISOString() });
  } catch (err: any) {
    logger.debug?.(`wake-ledger: high-water mark write failed for ${chatId.slice(0, 8)}: ${err?.message ?? err}`);
  }
}

// ── 2. The diff ─────────────────────────────────────────────────────────────

interface SupervisorRow { id: string; userId: string; projectId: string | null; isSupervisor: boolean; isProjectSupervisor: boolean }

const diffCache = new Map<string, { at: number; diff: WakeLedgerDiff }>();
const DIFF_CACHE_MS = 60_000;
/** Test hook. */
export function clearWakeLedgerCache(): void { diffCache.clear(); pendingVerdicts.clear(); }

/** A user-role row's provenance: owner-typed (human), an agent send, or other machine traffic. Pure. */
export function classifyUserRow(content: string, origin: string | null | undefined): 'owner' | 'agent' | 'machine' {
  if (origin === 'agent') return 'agent';
  if (origin && origin !== 'user') return 'machine';
  return /^\s*\[(MACHINE-TRIGGERED RUN|AGENT-SENT MESSAGE|Owner inbox|Fleet goal board|ACTION VERIFIER|HARNESS NOTE|OWNER-QUESTION TRIAGE|Owner-anchored message|\d+ agent messages? arrived|\d+ status-only report-up|MATERIAL GATE|HARNESS CONTINUATION)/i.test(content)
    ? 'machine' : 'owner';
}

/**
 * FLEET-PS-FIRST (supervisor SOTA round 2, 2026-10-20): the owner's projects an
 * ENABLED project supervisor covers — the project toggle on, an enabled
 * project-scope hook receiving run_completed (the PS's progress feed), and the
 * project-supervisor admin switch ON. The fleet diff leaves those projects'
 * PROGRESS to their supervisors. Bounded; any error ⇒ empty (nothing omitted —
 * fail toward showing the Fleet everything).
 */
export async function readPsCoveredProjects(userId: string): Promise<Set<string>> {
  try {
    const { getProjectSupervisorsEnabled } = await import('./supervisor-switch');
    if (!(await getProjectSupervisorsEnabled())) return new Set();
    const hooks = (await prisma.eventHook.findMany({
      where: { userId, sourceChatId: null, projectId: { not: null }, enabled: true, eventTypes: { has: 'run_completed' } },
      select: { projectId: true },
      take: 200,
    })) as Array<{ projectId: string | null }>;
    const pids = [...new Set((hooks ?? []).map((h) => h?.projectId).filter((x): x is string => typeof x === 'string' && !!x))];
    if (!pids.length) return new Set();
    const projects = (await prisma.crossModelProject.findMany({
      where: { id: { in: pids }, userId, projectSupervisorEnabled: true },
      select: { id: true },
    })) as Array<{ id: string }>;
    return new Set((projects ?? []).map((p) => String(p.id)));
  } catch {
    return new Set();
  }
}

/**
 * Read the ledger diff for a supervisor chat since `since`. Bounded reads in
 * parallel; a section whose read fails is simply empty. Returns null for a
 * chat that is not a supervisor (or is gone). Cached 60 s per (chat, since)
 * so the gate and the wake composition share one read.
 */
export async function computeWakeLedgerDiff(chatId: string, since: Date, now: Date = new Date()): Promise<WakeLedgerDiff | null> {
  const cacheKey = `${chatId}|${since.toISOString()}`;
  const hit = diffCache.get(cacheKey);
  if (hit && now.getTime() - hit.at < DIFF_CACHE_MS) return hit.diff;

  const chat = await prisma.crossModelChat.findUnique({
    where: { id: chatId },
    select: { id: true, userId: true, projectId: true, isSupervisor: true, isProjectSupervisor: true },
  }) as SupervisorRow | null;
  if (!chat || !(chat.isSupervisor || chat.isProjectSupervisor)) return null;
  const fleet = chat.isSupervisor === true;
  const projectId = fleet ? null : chat.projectId ?? null;
  if (!fleet && !projectId) return null;
  const d = emptyWakeLedgerDiff(chatId, since, now, fleet ? 'fleet' : 'project', projectId);
  const truncated: string[] = [];

  // Privacy (review 2026-10-23): a GHOST chat never enters the scope — its
  // title (the first words of its first message), its typed heads and its
  // runs stay out of every supervisor prompt (docs/GHOST_MODE.md: no
  // cross-chat surfacing; board-digest excludes them the same way), and its
  // messages can never trigger a wake.
  const scopeRows = await prisma.crossModelChat.findMany({
    where: {
      id: { not: chatId },
      ...(fleet ? { userId: chat.userId } : { projectId: projectId as string }),
      ghostMode: false,
      OR: [{ archivedAt: null }, { archivedAt: { gte: since } }],
    },
    select: { id: true, title: true, isSupervisor: true, isProjectSupervisor: true, projectId: true, userId: true },
    orderBy: { updatedAt: 'desc' },
    take: WAKE_LEDGER_MAX_SCOPE_CHATS,
  }).catch(() => [] as Array<{ id: string; title: string | null; isSupervisor: boolean; isProjectSupervisor: boolean; projectId?: string | null; userId?: string }>);
  if (scopeRows.length >= WAKE_LEDGER_MAX_SCOPE_CHATS) truncated.push('scope');
  const ids = scopeRows.map((c) => c.id);
  // The owner / agent MESSAGE read covers only chats the supervisor's owner
  // owns: in a shared project a member's lane still counts for runs and
  // receipts, but what the member TYPED never lands in the owner's prompt.
  const ownIds = scopeRows.filter((c) => c.userId === chat.userId).map((c) => c.id);
  const title = new Map<string, string>(scopeRows.map((c) => [c.id, String(c.title ?? '')]));
  const t = (id: string): string | undefined => title.get(id) || undefined;

  // FLEET-PS-FIRST (2026-10-20): in the FLEET diff, the progress of chats in a
  // PS-covered project (finished / started / running runs, artifacts, progress-
  // tier todo closes, immaterial ledger rows, schedule firings) is left to that
  // project's supervisor and counted in ONE line instead; failures, stalls,
  // owner rows, decision-tier transitions, schedule stops and tickets stay.
  // Kill switch FLEET_DIFF_PS_COVERED_EXCLUDE_DISABLED=1.
  const coveredProjects = fleet && !fleetDiffPsCoveredDisabled() ? await readPsCoveredProjects(chat.userId) : new Set<string>();
  const coveredLane = new Set<string>(coveredProjects.size
    ? scopeRows.filter((c) => typeof c.projectId === 'string' && coveredProjects.has(c.projectId)).map((c) => c.id)
    : []);
  const omitted: LedgerPsCovered = { projects: coveredProjects.size, lanes: coveredLane.size, runsFinished: 0, artifacts: 0, prs: 0, todosDone: 0, other: 0, alarmsDelayed: !fleetAlarmPsFirstDisabled() };
  const progressIds = coveredLane.size ? ids.filter((id) => !coveredLane.has(id)) : ids;

  const empty = <T>(): T[] => [];
  const laneIdleWiden = !laneIdleWakeDisabled();
  const [runs, receipts, activities, msgs, asks, tickets, stopped, fired, stateDoc, hooks, todos] = await Promise.all([
    ids.length
      ? prisma.agentRun.findMany({
          where: { sessionId: { in: ids }, OR: [{ startedAt: { gte: since } }, { finishedAt: { gte: since } }, { status: { in: ['running', 'queued'] } }] },
          select: { id: true, sessionId: true, status: true, startedAt: true, finishedAt: true, error: true, createdAt: true },
          take: MAX_RUNS,
        }).catch(empty)
      : Promise.resolve(empty<any>()),
    ids.length
      ? prisma.runToolReceipt.findMany({
          where: { chatId: { in: ids }, createdAt: { gte: since }, ok: true, tool: { in: ARTIFACT_RECEIPT_TOOLS } },
          select: { chatId: true, tool: true, ids: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: MAX_RECEIPTS,
        }).catch(empty)
      : Promise.resolve(empty<any>()),
    prisma.activity.findMany({
      where: { userId: chat.userId, createdAt: { gte: since }, action: { in: LEDGER_ACTIONS } },
      select: { action: true, metadata: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_ACTIVITIES,
    }).catch(empty),
    // Owner + agent messages: THIS chat always; a project supervisor also reads its lanes' owner rows.
    // `head` is the read (the 400-char head + the redactor's margin); `cut`: the message went on past it (ledgerSafeHead).
    prisma.$queryRawUnsafe<Array<{ chatId: string; createdAt: Date; origin: string | null; source: string | null; head: string; cut?: boolean | null }>>(
      `SELECT "chatId", "createdAt", metadata->>'origin' AS origin, metadata->>'sourceChatId' AS source, LEFT(content, ${MESSAGE_READ_CHARS}) AS head,
              char_length(content) > ${MESSAGE_READ_CHARS} AS cut
         FROM crossmodel_messages
        WHERE "chatId" = ANY($1::text[]) AND role = 'user' AND "createdAt" >= $2
          AND COALESCE(metadata->>'origin', '') IN ('', 'user', 'agent')
        ORDER BY "createdAt" DESC LIMIT ${MAX_MESSAGES}`,
      fleet ? [chatId] : [chatId, ...ownIds.slice(0, 400)], since,
    ).catch(empty),
    prisma.ownerQuestion.findMany({
      where: { userId: chat.userId, resolvedAt: { gte: since } },
      select: { id: true, chatId: true, status: true, question: true, answeredBy: true, resolvedAt: true },
      take: 50,
    }).catch(empty),
    prisma.userFeatureRequest.findMany({
      where: { userId: chat.userId, OR: [{ createdAt: { gte: since } }, { updatedAt: { gte: since } }] },
      select: { id: true, title: true, status: true, source: true, createdAt: true, updatedAt: true, context: true },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    }).catch(empty),
    ids.length
      ? prisma.codingSchedule.findMany({
          where: { sessionId: { in: ids }, disabledAt: { gte: since } },
          select: { id: true, sessionId: true, kind: true, lastStatus: true, disabledAt: true },
          take: 30,
        }).catch(empty)
      : Promise.resolve(empty<any>()),
    progressIds.length
      ? prisma.codingSchedule.count({ where: { sessionId: { in: progressIds }, lastFiredAt: { gte: since } } }).catch(() => 0)
      : Promise.resolve(0),
    import('./supervisor-state.service').then((m) => m.getSupervisorState(chatId)).catch(() => null),
    prisma.eventHook.findMany({ where: { targetChatId: chatId }, select: { id: true } }).catch(empty),
    // LANE-IDLE-WAKE (2026-10-20): pending assigned work can stall a lane too (dependency-free only — filtered
    // below). Review fix: TWO reads scoped to the scope chats, each with its own cap — in_progress first, so a
    // pending backlog (dependency-waiting work, todos on other lanes) can never crowd an in_progress stall out
    // of an unordered 100-row window; a hit cap is a named read bound ('stalled lanes').
    laneIdleWiden
      ? (ids.length
        ? Promise.all((['in_progress', 'pending'] as const).map((status) => prisma.projectTodo.findMany({
          where: { userId: chat.userId, status, assigneeChatId: { in: ids }, ...(projectId ? { projectId } : {}) },
          select: { id: true, title: true, assigneeChatId: true, status: true, updatedAt: true },
          orderBy: { updatedAt: 'asc' },
          take: MAX_TODOS,
        }).catch(empty))).then(([inProgress, pending]) => {
          if ((inProgress as unknown[]).length >= MAX_TODOS || (pending as unknown[]).length >= MAX_TODOS) truncated.push('stalled lanes');
          return [...(inProgress as any[]), ...(pending as any[])];
        })
        : Promise.resolve(empty<any>()))
      : prisma.projectTodo.findMany({
        where: { userId: chat.userId, status: 'in_progress', assigneeChatId: { not: null }, ...(projectId ? { projectId } : {}) },
        select: { id: true, title: true, assigneeChatId: true },
        take: MAX_TODOS,
      }).catch(empty),
  ]);

  // Runs.
  const scopeSet = new Set(ids);
  type RunRow = { id?: string; sessionId: string; status: string; startedAt: Date | null; finishedAt: Date | null; error: string | null; createdAt?: Date | null };
  // ALARM-CAUSE-AWARE: a provider-transient failure whose resume took over (a later queued / running /
  // completed run on the lane) is listed with resumeQueued and is not lane_failed; a failed resume is.
  const causeAware = !hookAlarmCauseAwareDisabled();
  for (const r of runs as RunRow[]) {
    // FLEET-PS-FIRST: a PS-covered chat's progress counters are left to its project supervisor (failures stay).
    const coveredRun = coveredLane.has(r.sessionId);
    if (!coveredRun && (r.status === 'running' || r.status === 'queued')) { d.runsRunning += r.status === 'running' ? 1 : 0; }
    if (!coveredRun && r.startedAt && r.startedAt.getTime() >= since.getTime()) d.runsStarted += 1;
    if (!r.finishedAt || r.finishedAt.getTime() < since.getTime()) continue;
    if (r.status === 'completed' && coveredRun) { omitted.runsFinished += 1; continue; }
    if (r.status === 'cancelled' && coveredRun) continue;
    if (r.status === 'completed') d.runsFinished.push({ chatId: r.sessionId, title: t(r.sessionId), status: r.status, at: iso(r.finishedAt) });
    else if (r.status === 'failed') {
      const resumeQueued = causeAware && failureResumeQueued(r, runs as RunRow[]);
      d.runsFailed.push({ chatId: r.sessionId, title: t(r.sessionId), status: r.status, at: iso(r.finishedAt), error: r.error ? String(r.error).slice(0, 160) : null, ...(resumeQueued ? { resumeQueued: true } : {}) });
    }
    else if (r.status === 'cancelled' || r.status === 'interrupted') d.runsCancelled += 1;
  }
  if ((runs as unknown[]).length >= MAX_RUNS) truncated.push('runs');
  const newestFirst = <T extends { at: string }>(xs: T[]) => xs.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  newestFirst(d.runsFinished); newestFirst(d.runsFailed);

  // Artifacts.
  // todo 13dfa16d (monitor lesson 7): the artifact's work item comes from the
  // RECEIPT's event-time stamp (ids.todoId / ids.ticketId), never a join to the
  // lane's CURRENT title — the SCD trap that mislabelled PR #1590 (served todo
  // 27c215d6) with the lane's post-14:14:53Z title todo 908f48a7. Legacy rows
  // with no stamp print 'unattributed' honestly; the lane title still rides as
  // the artifact's WHO, not its WHAT-FOR.
  const receiptRows = (receipts as Array<{ chatId: string; tool: string; ids: unknown; createdAt: Date }>).filter((r) => {
    if (!coveredLane.has(r.chatId)) return true;
    omitted.artifacts += 1;
    if (r.tool === 'open_pull_request' || r.tool === 'merge_pull_request') omitted.prs += 1;
    return false;
  });
  d.artifacts = receiptRows.map((r): LedgerArtifact => {
    const x = (r.ids && typeof r.ids === 'object' ? r.ids : {}) as Record<string, unknown>;
    const ref = x.prNumber ? `#${x.prNumber}` : x.sha ? String(x.sha).slice(0, 8) : x.branch ? String(x.branch) : undefined;
    const todoId = typeof x.todoId === 'string' ? x.todoId : null;
    const ticketId = typeof x.ticketId === 'string' ? x.ticketId : null;
    const stamped = todoId ? `todo ${todoId.slice(0, 8)}` : ticketId ? `ticket ${ticketId.slice(0, 8)}` : null;
    return {
      chatId: r.chatId, title: t(r.chatId), tool: r.tool, at: iso(r.createdAt),
      ...(ref ? { ref } : {}),
      ...(stamped ? { workItem: stamped } : (r.tool === 'open_pull_request' || r.tool === 'merge_pull_request' || r.tool === 'git_push') ? { unattributed: true } : {}),
    };
  });

  // Goal / todo transitions — resolve the entities, keep this supervisor's scope.
  const acts = activities as Array<{ action: string; metadata: any; createdAt: Date }>;
  const todoIds = [...new Set(acts.filter((a) => a.action.startsWith('todo.')).map((a) => String(a.metadata?.todoId ?? '')).filter(Boolean))];
  const goalIds = [...new Set(acts.filter((a) => a.action.startsWith('goal.')).map((a) => String(a.metadata?.goalId ?? '')).filter(Boolean))];
  const [todoRows, goalRows] = await Promise.all([
    todoIds.length ? prisma.projectTodo.findMany({ where: { id: { in: todoIds } }, select: { id: true, title: true, projectId: true, goalId: true } }).catch(empty) : Promise.resolve(empty<any>()),
    goalIds.length ? prisma.projectGoal.findMany({ where: { id: { in: goalIds } }, select: { id: true, title: true, projectId: true } }).catch(empty) : Promise.resolve(empty<any>()),
  ]);
  const ent = new Map<string, { title: string; projectId: string; goalId?: string }>();
  for (const r of [...(todoRows as any[]), ...(goalRows as any[])]) ent.set(r.id, { title: String(r.title ?? ''), projectId: String(r.projectId ?? ''), ...(r.goalId ? { goalId: String(r.goalId) } : {}) });
  for (const a of acts) {
    const kind: 'goal' | 'todo' = a.action.startsWith('goal.') ? 'goal' : 'todo';
    const id = String((kind === 'goal' ? a.metadata?.goalId : a.metadata?.todoId) ?? '');
    const e = ent.get(id);
    if (!e) continue; // deleted or unreadable — never guess its project
    if (projectId && e.projectId !== projectId) continue;
    const row = { action: a.action, fromStatus: a.metadata?.fromStatus ?? null, toStatus: a.metadata?.toStatus ?? a.metadata?.status ?? null, actingChatId: a.metadata?.actingChatId ?? null };
    if (row.actingChatId === chatId) continue; // its own writes are not news
    if (isMaterialLedgerTransition(row, chatId)) {
      d.statusChanges.push({ kind, id, title: e.title, from: row.fromStatus, to: row.toStatus, action: a.action, at: iso(a.createdAt), byChatId: row.actingChatId } as LedgerStatusChange);
    } else if (coveredProjects.has(e.projectId)) {
      omitted.other += 1; // FLEET-PS-FIRST: an immaterial row of a PS-covered project
    } else {
      d.otherLedgerChanges += 1;
    }
  }
  if (acts.length >= MAX_ACTIVITIES) truncated.push('goals/todos');
  // SUP-WAKE-TIERS: a todo → done is PROGRESS only while its goal still holds open (pending / in_progress)
  // work — the last open todo of a goal done is a DECISION. Unknown (read failed / bound) stays decision.
  if (!materialTiersDisabled()) {
    const doneGoal = new Map<LedgerStatusChange, string>();
    for (const c of d.statusChanges) {
      const g = c.kind === 'todo' && c.to === 'done' ? ent.get(c.id)?.goalId : undefined;
      if (g) doneGoal.set(c, g);
    }
    if (doneGoal.size) {
      try {
        const open = await prisma.projectTodo.findMany({
          where: { goalId: { in: [...new Set(doneGoal.values())] }, status: { in: ['pending', 'in_progress'] } },
          select: { goalId: true },
          take: 1000,
        });
        const n = new Map<string, number>();
        for (const r of open as Array<{ goalId: string }>) n.set(r.goalId, (n.get(r.goalId) ?? 0) + 1);
        for (const [c, g] of doneGoal) c.goalOpenTodos = n.get(g) ?? 0;
      } catch { /* unknown ⇒ the change stays decision-tier */ }
    }
  }
  // FLEET-PS-FIRST: a PROGRESS-tier close in a PS-covered project (a lane-made todo done with work left in
  // its goal) is that supervisor's news; every decision-tier transition stays (unknown counts ⇒ decision).
  if (coveredProjects.size && !materialTiersDisabled()) {
    d.statusChanges = d.statusChanges.filter((c) => {
      const pid = ent.get(c.id)?.projectId;
      if (!pid || !coveredProjects.has(pid) || statusChangeTier(c) !== 'progress') return true;
      omitted.todosDone += 1;
      return false;
    });
  }

  // Owner + agent messages. Classified on the raw read; what the diff CARRIES is redacted (round-3 review
  // 2026-10-23 — the owner turn's [SINCE YOUR LAST NOTE] and every machine wake's [SINCE YOUR LAST WAKE] printed
  // these heads verbatim): the whole read is redacted, then cut to the head on a token boundary (ledgerSafeHead),
  // before any clip.
  for (const m of msgs as Array<{ chatId: string; createdAt: Date; origin: string | null; source: string | null; head: string; cut?: boolean | null }>) {
    const head = String(m.head ?? '');
    const cut = m.cut == null ? head.length >= MESSAGE_READ_CHARS : m.cut === true; // no flag (older driver) ⇒ by length
    const kind = classifyUserRow(head, m.origin);
    if (kind === 'owner') d.ownerMessages.push({ chatId: m.chatId, title: m.chatId === chatId ? undefined : t(m.chatId), at: iso(m.createdAt), head: ledgerSafeHead(head, cut), self: m.chatId === chatId });
    else if (kind === 'agent' && m.chatId === chatId) {
      const from = String(m.source ?? '');
      d.agentMessages.push({ fromChatId: from, title: from ? t(from) : undefined, at: iso(m.createdAt), head: ledgerSafeHead(head.replace(/^\s*\[AGENT-SENT MESSAGE[^\]]*\]\s*/i, ''), cut) });
    }
  }

  // Owner answers (this supervisor's scope; the Fleet sees all).
  const scopeAndSelf = new Set([chatId, ...ids]);
  for (const q of asks as Array<{ id: string; chatId: string; status: string; question: string; answeredBy: string | null; resolvedAt: Date | null }>) {
    if (!q.resolvedAt || (q.status !== 'answered' && q.status !== 'dismissed')) continue;
    if (!fleet && !scopeAndSelf.has(q.chatId)) continue;
    d.ownerAnswers.push({ id: q.id, chatId: q.chatId, status: q.status, at: iso(q.resolvedAt), head: String(q.question ?? '').slice(0, 120), by: q.answeredBy });
  }

  // Tickets (a project supervisor sees tickets filed from / dispatched to its scope).
  for (const r of tickets as Array<{ id: string; title: string; status: string; source: string | null; createdAt: Date; updatedAt: Date; context: any }>) {
    const ctx = (r.context && typeof r.context === 'object' ? r.context : {}) as Record<string, unknown>;
    const linked = [ctx.sessionId, ctx.filedBy, ctx.dispatchedTo, ctx.chatId].map((x) => String(x ?? '')).filter(Boolean);
    if (!fleet && !linked.some((x) => scopeAndSelf.has(x))) continue;
    d.tickets.push({ id: r.id, title: String(r.title ?? ''), status: String(r.status ?? ''), at: iso(r.updatedAt), source: r.source, isNew: r.createdAt.getTime() >= since.getTime() });
  }

  // Schedules.
  d.schedulesFired = Number(fired) || 0;
  d.schedulesStopped = (stopped as Array<{ id: string; sessionId: string; kind: string | null; lastStatus: string | null; disabledAt: Date | null }>)
    .map((s) => ({ id: s.id, chatId: s.sessionId, title: t(s.sessionId), at: iso(s.disabledAt), status: s.lastStatus, kind: s.kind }));

  // Owner directives captured since (harness-stamped origin only).
  try {
    const dirs = Array.isArray((stateDoc as any)?.directives) ? (stateDoc as any).directives : [];
    d.directivesOpened = dirs.filter((x: any) => (x?.origin === 'owner' || x?.origin === 'owner_question') && Date.parse(String(x?.at ?? '')) >= since.getTime()).length;
  } catch { d.directivesOpened = 0; }

  // Stalled lanes: in-progress work, no live run, no armed schedule, last run ended ≥ STALL_IDLE_MIN ago.
  // LANE-IDLE-WAKE (2026-10-20; LANE_IDLE_WAKE_DISABLED=1 restores the shape above): dependency-free PENDING
  // assigned work counts too, only a schedule that ARMS the lane (coding/lane-idle scheduleArmsLane: due within
  // 2 h, or a recurring row within 1.5× its own interval — the SAME rule the lane-idle wake applies at finalize
  // and delivery) keeps it "armed", and a CODING lane that never ran (no agent_runs row) is stalled once its
  // todo sat ≥ STALL_IDLE_MIN.
  try {
    type StallTodo = { id: string; title: string; assigneeChatId: string | null; status?: string; updatedAt?: Date | null };
    let assigned = (todos as StallTodo[]).filter((x) => x.assigneeChatId && scopeSet.has(x.assigneeChatId));
    if (laneIdleWiden) {
      const pendingIds = assigned.filter((x) => x.status === 'pending').map((x) => x.id);
      if (pendingIds.length) {
        // A failed dependency read keeps the pending todo (fail toward detection — a missed stall is the costly error).
        const deps = await prisma.todoDependency.findMany({ where: { todoId: { in: pendingIds } }, select: { todoId: true, dependsOnTodoId: true } }).catch(empty) as Array<{ todoId: string; dependsOnTodoId: string }>;
        if (deps.length) {
          const targets = await prisma.projectTodo.findMany({ where: { id: { in: [...new Set(deps.map((x) => x.dependsOnTodoId))] } }, select: { id: true, status: true } }).catch(empty) as Array<{ id: string; status: string }>;
          const open = new Set(targets.filter((x) => x.status !== 'done' && x.status !== 'dropped').map((x) => x.id));
          const waiting = new Set(deps.filter((x) => open.has(x.dependsOnTodoId)).map((x) => x.todoId));
          assigned = assigned.filter((x) => !(x.status === 'pending' && waiting.has(x.id)));
        }
      }
    }
    const laneIds = [...new Set(assigned.map((x) => x.assigneeChatId as string))];
    if (laneIds.length) {
      const [laneRuns, armed] = await Promise.all([
        prisma.$queryRawUnsafe<Array<{ sessionId: string; lastFinished: Date | null; live: boolean }>>(
          `SELECT "sessionId", MAX("finishedAt") AS "lastFinished", BOOL_OR(status IN ('running','queued')) AS live FROM agent_runs WHERE "sessionId" = ANY($1::text[]) GROUP BY "sessionId"`,
          laneIds,
        ).catch(empty),
        prisma.codingSchedule.findMany({
          where: { sessionId: { in: laneIds }, enabled: true },
          select: { sessionId: true, ...(laneIdleWiden ? { nextRunAt: true, kind: true, intervalSec: true } : {}) },
          ...(laneIdleWiden ? { take: MAX_ARMED_SCHEDULES } : {}),
        }).catch(empty),
      ]);
      type ArmedRow = { sessionId: string; nextRunAt?: Date | null; kind?: string | null; intervalSec?: number | null };
      const armedSet = new Set((armed as ArmedRow[]).filter((x) => !laneIdleWiden || scheduleArmsLane(x, now)).map((x) => x.sessionId));
      const runMap = new Map((laneRuns as Array<{ sessionId: string; lastFinished: Date | null; live: boolean }>).map((x) => [x.sessionId, x]));
      // Never-started CODING lanes (no agent_runs row at all): a plain chat holding a todo is not a lane.
      const neverRan = laneIdleWiden ? laneIds.filter((L) => !runMap.has(L) && !armedSet.has(L)) : [];
      const codingNeverRan = neverRan.length
        ? new Set(((await prisma.crossModelChat.findMany({ where: { id: { in: neverRan }, codingState: { isNot: null } }, select: { id: true } }).catch(empty)) as Array<{ id: string }>).map((c) => c.id))
        : new Set<string>();
      for (const todo of assigned) {
        const L = todo.assigneeChatId as string;
        const r = runMap.get(L);
        if (armedSet.has(L) || r?.live) continue;
        let idleFrom: Date | null = r?.lastFinished ? new Date(r.lastFinished) : null;
        let neverStarted = false;
        if (!r || !r.lastFinished) {
          if (r || !codingNeverRan.has(L) || !todo.updatedAt) continue;
          idleFrom = new Date(todo.updatedAt);
          neverStarted = true;
        }
        const idleMin = Math.round((now.getTime() - (idleFrom as Date).getTime()) / 60_000);
        if (!Number.isFinite(idleMin) || idleMin < STALL_IDLE_MIN) continue;
        if (d.stalledLanes.some((s) => s.chatId === L)) continue;
        d.stalledLanes.push({
          chatId: L, title: t(L), todoId: todo.id, todoTitle: todo.title, idleMin,
          ...(laneIdleWiden && todo.status === 'pending' ? { todoStatus: 'pending' } : {}),
          ...(neverStarted ? { neverStarted: true } : {}),
        });
      }
    }
  } catch { /* stall signal is best-effort */ }

  // The gate's own skips since the mark (transparency: nothing it skipped is invisible).
  try {
    const hookIds = (hooks as Array<{ id: string }>).map((h) => h.id);
    if (hookIds.length) {
      const skipped = await prisma.hookEvent.findMany({
        where: { hookId: { in: hookIds }, status: { in: [...MATERIAL_GATE_SKIP_STATUSES] }, createdAt: { gte: since } },
        select: { payload: true },
        take: 200,
      });
      const bySrc = new Map<string, number>();
      for (const s of skipped) {
        const src = String((s.payload as any)?.sourceChatId ?? '');
        bySrc.set(src, (bySrc.get(src) ?? 0) + 1);
      }
      d.gateSkips = [...bySrc.entries()].map(([src, n]) => ({ sourceChatId: src, title: t(src), n })).sort((a, b) => b.n - a.n);
    }
  } catch { /* transparency line is best-effort */ }

  if (truncated.length) d.truncated = truncated;
  if (omitted.runsFinished || omitted.artifacts || omitted.todosDone || omitted.other) d.psCovered = omitted;
  diffCache.set(cacheKey, { at: now.getTime(), diff: d });
  if (diffCache.size > 500) { for (const k of [...diffCache.keys()].slice(0, 250)) diffCache.delete(k); }
  return d;
}

/**
 * The [SINCE YOUR LAST WAKE] block for a supervisor MACHINE wake, plus the
 * mark it was read against (the finalize advances the mark to `at`). Returns
 * null when the feature is off, the chat is not a supervisor, or the read
 * failed / timed out. Never throws.
 *
 * `ownerTurn` (FS context map 2026-10-22, gap #3): the same diff for an OWNER
 * turn, under the [SINCE YOUR LAST NOTE — harness diff] heading and its own
 * telemetry kind. READ-ONLY on the mark — the caller must NOT hand `at` to the
 * finalize (an owner turn never advances it), so the next wake still sees
 * every event this owner turn saw. `timeoutMs` replaces the diff read's
 * WAKE_LEDGER_READ_TIMEOUT_MS (an owner turn passes its pathology ceiling,
 * OWNER_TURN_READ_CEILING_MS — the seam's startOwnerTurnRead decides how long
 * the turn waits: max(1.5 s, the moment the turn asks)).
 */
export async function buildWakeLedgerBlock(chatId: string, now: Date = new Date(), opts: { ownerTurn?: boolean; timeoutMs?: number } = {}): Promise<{ block: string; at: string; since: string } | null> {
  if (!wakeLedgerDiffActive()) return null;
  try {
    const hwm = await readWakeHighWaterMark(chatId, now);
    // An owner turn passes its own ceiling (review 2026-10-23 item 2 + re-review); the seam bounds the whole call.
    const diff = await withTimeout(computeWakeLedgerDiff(chatId, hwm.at, now), opts.timeoutMs ?? WAKE_LEDGER_READ_TIMEOUT_MS, 'wake ledger diff');
    if (!diff) return null;
    const block = renderWakeLedgerDiff(diff, { floorHours: materialGateFloorHours(), ...(opts.ownerTurn ? { ownerTurn: true } : {}) });
    recordLoopMetric({
      kind: opts.ownerTurn ? 'supervisor_owner_ledger_diff' : 'supervisor_wake_ledger_diff', sessionId: chatId, value: block.length,
      meta: {
        since: diff.since, sinceMin: Math.round((now.getTime() - hwm.at.getTime()) / 60_000), hwmSource: hwm.source, scope: diff.scope, ...diffCounts(diff),
        // FLEET-PS-FIRST: what the fleet diff left to the project supervisors (absent when nothing).
        ...(diff.psCovered ? { psCoveredProjects: diff.psCovered.projects, psCoveredOmitted: diff.psCovered.runsFinished + diff.psCovered.artifacts + diff.psCovered.todosDone + diff.psCovered.other } : {}),
      },
    });
    // `at` is when the diff was READ (a cached read may be ≤ 60 s older than now): the next diff starts
    // exactly there, so nothing that happened between the read and this composition is ever skipped.
    return { block, at: diff.now, since: diff.since };
  } catch (err: any) {
    logger.warn(`wake-ledger: diff block failed open for ${chatId.slice(0, 8)} (${err?.message ?? err}) — the wake runs without it`);
    return null;
  }
}

/** Section counts for telemetry (no text). Pure. */
export function diffCounts(d: WakeLedgerDiff): Record<string, number> {
  return {
    ownerMessages: d.ownerMessages.length, ownerAnswers: d.ownerAnswers.length, statusChanges: d.statusChanges.length,
    otherLedger: d.otherLedgerChanges, runsFinished: d.runsFinished.length, runsFailed: d.runsFailed.length,
    artifacts: d.artifacts.length, schedulesStopped: d.schedulesStopped.length, agentMessages: d.agentMessages.length,
    tickets: d.tickets.length, stalled: d.stalledLanes.length, gateSkips: d.gateSkips.reduce((n, g) => n + g.n, 0),
  };
}

// ── 3. The gate ─────────────────────────────────────────────────────────────

/** SUP-WAKE-TIERS evaluation of one material verdict (absent when the tiers are off). */
export interface ProgressTierEval {
  /** Every source lane drives itself below the progress heartbeat (the act gate skips unless `control`). */
  wouldSkip: boolean;
  why: ProgressSkipWhy;
  sourceLanes: number;
  /** null = the lookup did not run (decision tier / heartbeat / no source lane) or failed. */
  selfDriving: boolean | null;
  /** A would-be skip delivered as the 1-in-N labelled control. */
  control: boolean;
}

export interface MaterialGateResult {
  origin: WakeGateOrigin;
  chatId: string;
  mode: MaterialGateMode;
  /** null when the gate did not evaluate (off, not a supervisor, failed open). */
  verdict: MaterialVerdict | null;
  /** The caller skips the wake (mode act ∧ (not material ∨ a progress-tier wake whose lanes drive themselves)). */
  skip: boolean;
  /** Why it skips — the call site stamps the matching status (no_material_change ⇒ today's status). */
  skipReason?: MaterialSkipReason;
  tiers?: ProgressTierEval;
  hwmAt?: string;
  hwmSource?: 'store' | 'transcript' | 'default';
  error?: string;
}

const off = (origin: WakeGateOrigin, chatId: string, mode: MaterialGateMode, error?: string): MaterialGateResult =>
  ({ origin, chatId, mode, verdict: null, skip: false, ...(error ? { error } : {}) });

async function supervisorKind(chatId: string): Promise<{ fleet: boolean } | null> {
  const c = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { isSupervisor: true, isProjectSupervisor: true } }).catch(() => null);
  if (!c || !(c.isSupervisor || c.isProjectSupervisor)) return null;
  return { fleet: c.isSupervisor === true };
}

/**
 * SUP-WAKE-TIERS (2)+(3): judge a material verdict's tier. A DECISION verdict
 * is never gated; a PROGRESS verdict below the progress heartbeat would skip
 * when every source lane drives itself. Never throws — a lookup error or
 * timeout reads as selfDriving null ⇒ deliver. The control draw happens only
 * in act (shadow delivers every wake anyway and labels tierWouldSkip).
 */
export async function evaluateProgressTier(input: MaterialInput, verdict: MaterialVerdict, mode: MaterialGateMode): Promise<ProgressTierEval> {
  const sinceMs = Math.max(0, input.now.getTime() - input.hwmAt.getTime());
  const hbHours = progressHeartbeatHours();
  const lanes = verdict.material && verdict.tier === 'progress' ? progressSourceLaneIds(input) : [];
  // Review fix 2026-10-20: a source lane the diff already lists as STALLED is never self-driving, and more
  // source lanes than one read covers is never "every lane" — both deliver without a lane read.
  const stalled = new Set(input.diff.stalledLanes.map((s) => s.chatId));
  const stalledSource = lanes.some((l) => stalled.has(l));
  const tooManyLanes = lanes.length > SELF_DRIVING_MAX_LANES;
  let selfDriving: boolean | null = null;
  if (lanes.length && sinceMs < hbHours * 3_600_000 && !stalledSource && !tooManyLanes) {
    try {
      selfDriving = (await withTimeout(allLanesSelfDriving(lanes, input.now), LANE_SELF_DRIVING_TIMEOUT_MS, 'lane self-driving')).selfDriving;
    } catch (err: any) {
      logger.debug?.(`wake-ledger: lane self-driving read failed for ${input.diff.chatId.slice(0, 8)} (${err?.message ?? err}) — the progress wake delivers`);
      selfDriving = null;
    }
  }
  const dec = progressSkipDecision({ verdict, sinceMs, progressHeartbeatHours: hbHours, sourceLanes: lanes.length, selfDriving, stalledSource, tooManyLanes });
  return { ...dec, sourceLanes: lanes.length, selfDriving, control: mode === 'act' && dec.wouldSkip && drawProgressControl() };
}

async function evaluate(origin: WakeGateOrigin, chatId: string, build: (ctx: { fleet: boolean; diff: WakeLedgerDiff; hwmAt: Date; now: Date }) => Promise<Omit<Parameters<typeof decideMaterialChange>[0], 'origin' | 'diff' | 'hwmAt' | 'now' | 'isFleet'>>): Promise<MaterialGateResult> {
  const mode = materialGateMode();
  if (mode === 'off') return off(origin, chatId, mode);
  try {
    const kind = await supervisorKind(chatId);
    if (!kind) return off(origin, chatId, 'off');
    const now = new Date();
    const hwm = await readWakeHighWaterMark(chatId, now);
    const diff = await withTimeout(computeWakeLedgerDiff(chatId, hwm.at, now), WAKE_LEDGER_READ_TIMEOUT_MS, 'wake ledger diff');
    if (!diff) return off(origin, chatId, mode, 'no diff');
    const extra = await build({ fleet: kind.fleet, diff, hwmAt: hwm.at, now });
    const input: MaterialInput = { origin, diff, hwmAt: hwm.at, now, isFleet: kind.fleet, floorHours: materialGateFloorHours(), ...extra };
    const verdict = decideMaterialChange(input);
    // SUP-WAKE-TIERS: decision reasons are never gated; progress-only verdicts are held while the lanes drive themselves.
    const tiers = materialTiersDisabled() ? null : await evaluateProgressTier(input, verdict, mode);
    const tierSkip = mode === 'act' && tiers?.wouldSkip === true && !tiers.control;
    const skip = (mode === 'act' && !verdict.material) || tierSkip;
    const skipReason: MaterialSkipReason | undefined = skip ? (verdict.material ? 'progress_self_driving' : 'no_material_change') : undefined;
    recordLoopMetric({
      kind: 'supervisor_material_gate', sessionId: chatId, value: verdict.material ? 1 : 0,
      meta: {
        origin, mode, material: verdict.material, skipped: skip, reasons: verdict.reasons, sinceMin: verdict.sinceMin, floorHours: verdict.floorHours, hwmSource: hwm.source, ...diffCounts(diff),
        ...(tiers ? {
          tier: verdict.tier, decisionReasons: verdict.decisionReasons ?? [], tierWhy: tiers.why, tierWouldSkip: tiers.wouldSkip,
          sourceLanes: tiers.sourceLanes, selfDriving: tiers.selfDriving, control: tiers.control, ...(skipReason ? { skipReason } : {}),
        } : {}),
      },
    });
    if (!skip) notePendingVerdict(chatId, origin, verdict, mode, tiers);
    return { origin, chatId, mode, verdict, skip, ...(skipReason ? { skipReason } : {}), ...(tiers ? { tiers } : {}), hwmAt: hwm.at.toISOString(), hwmSource: hwm.source };
  } catch (err: any) {
    logger.warn(`wake-ledger: material gate (${origin}) failed open for ${chatId.slice(0, 8)} (${err?.message ?? err}) — the wake delivers`);
    return off(origin, chatId, mode, String(err?.message ?? err).slice(0, 120));
  }
}

/** The last DELIVERED run summary per source chat for this target's hooks (newest wins). Never throws. */
export async function loadPrevDeliveredSummaries(targetChatId: string, sourceIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!sourceIds.length) return out;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ src: string; summary: string }>>(
      `SELECT DISTINCT ON (e.payload->>'sourceChatId') e.payload->>'sourceChatId' AS src, LEFT(e.payload->>'summary', 4000) AS summary
         FROM hook_events e JOIN event_hooks h ON h.id = e."hookId"
        WHERE h."targetChatId" = $1 AND e.status = 'delivered' AND e."eventType" = 'run_completed'
          AND e.payload->>'sourceChatId' = ANY($2::text[]) AND NOT (e.payload ? 'suppressedAtDelivery')
          AND e."createdAt" >= $3
        ORDER BY e.payload->>'sourceChatId', e."createdAt" DESC`,
      // hook_events is indexed on (status, createdAt) only — a 3-day window keeps the delivered-row range small;
      // an older last delivery reads as "no previous summary" (the report is new ⇒ delivered).
      targetChatId, sourceIds, new Date(Date.now() - 3 * 86_400_000),
    );
    for (const r of Array.isArray(rows) ? rows : []) if (r?.src && typeof r.summary === 'string') out[r.src] = r.summary;
  } catch { /* no previous summary ⇒ every report is new (fail toward delivery) */ }
  return out;
}

/**
 * Hook origin. `rows` are the group's claimed hook_events rows; `alarm` is
 * true when an alarm-class row rides the group or the daily cap was bypassed.
 */
export async function materialGateForHook(input: { targetChatId: string; rows: Array<{ eventType?: string; payload?: unknown }>; alarm: boolean; isAlarmRow?: (r: any) => boolean }): Promise<MaterialGateResult> {
  return evaluate('hook', input.targetChatId, async () => {
    const rows: MaterialTriggerRow[] = input.rows.map((r) => {
      const p = (r?.payload ?? {}) as Record<string, unknown>;
      const eventType = String(r?.eventType ?? p.eventType ?? '');
      const alarm = input.isAlarmRow ? input.isAlarmRow(r) === true : false;
      // ALARM-CAUSE-AWARE: an alarm TYPE its payload made quiet adds no material reason (null under the kill switch).
      const quietCause = alarm ? null : quietAlarmCause(eventType, p);
      return {
        eventType,
        ...(p.sourceChatId ? { sourceChatId: String(p.sourceChatId) } : {}),
        summary: String(p.summary ?? ''),
        alarm,
        ...(quietCause ? { quietCause } : {}),
        // LANE-IDLE-WAKE: the harness lane-idle wake names its own DECISION reason.
        ...(p.wakeKind === 'lane_idle' ? { wakeKind: 'lane_idle' } : {}),
      };
    });
    const sources = [...new Set(rows.filter((r) => r.eventType === 'run_completed' && r.sourceChatId).map((r) => r.sourceChatId as string))];
    const prevSummaryBySource = await loadPrevDeliveredSummaries(input.targetChatId, sources);
    return { rows, prevSummaryBySource, alarm: input.alarm };
  });
}

/** Sweep origin (a stock fleet / project sweep firing on a supervisor chat). */
export async function materialGateForSweep(input: { chatId: string }): Promise<MaterialGateResult> {
  return evaluate('sweep', input.chatId, async () => ({}));
}

/** The previous agent message body per source delivered into this chat (7 days). Never throws. */
async function loadPrevAgentBodies(chatId: string, sourceIds: string[], before: Date): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!sourceIds.length) return out;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ src: string; body: string }>>(
      `SELECT DISTINCT ON (metadata->>'sourceChatId') metadata->>'sourceChatId' AS src, LEFT(content, 4000) AS body
         FROM crossmodel_messages
        WHERE "chatId" = $1 AND role = 'user' AND metadata->>'origin' = 'agent' AND metadata->>'sourceChatId' = ANY($2::text[])
          AND "createdAt" < $3 AND "createdAt" >= $4
        ORDER BY metadata->>'sourceChatId', "createdAt" DESC`,
      chatId, sourceIds, before, new Date(before.getTime() - 7 * 86_400_000),
    );
    for (const r of Array.isArray(rows) ? rows : []) if (r?.src && typeof r.body === 'string') out[r.src] = stripAgentHeader(r.body);
  } catch { /* none ⇒ every message is new */ }
  return out;
}

const stripAgentHeader = (s: string): string => String(s ?? '').replace(/^\s*\[AGENT-SENT MESSAGE[^\]]*\]\s*/i, '');

/** Drain origin (a queued AGENT batch for a supervisor chat). */
export async function materialGateForDrain(input: { chatId: string; rows: Array<{ content: string; createdAt?: Date }>; sourceChatIds: Array<string | undefined> }): Promise<MaterialGateResult> {
  return evaluate('drain', input.chatId, async ({ fleet, diff, now }) => {
    const srcIds = [...new Set(input.sourceChatIds.filter((x): x is string => !!x))];
    const srcRows = srcIds.length
      ? await prisma.crossModelChat.findMany({ where: { id: { in: srcIds } }, select: { id: true, projectId: true, isSupervisor: true, isProjectSupervisor: true } }).catch(() => [] as any[])
      : [];
    const src = new Map((srcRows as Array<{ id: string; projectId: string | null; isSupervisor: boolean; isProjectSupervisor: boolean }>).map((c) => [c.id, c]));
    const drain: MaterialDrainMessage[] = input.rows.map((r, i) => {
      const id = input.sourceChatIds[i];
      const c = id ? src.get(id) : undefined;
      const inScope = !!c && (fleet || (c.projectId != null && c.projectId === diff.projectId));
      return {
        ...(id ? { sourceChatId: id } : {}),
        body: stripAgentHeader(String(r.content ?? '')),
        sourceIsLane: inScope && !c!.isSupervisor && !c!.isProjectSupervisor,
        sourceIsProjectSupervisor: !!c && c.isProjectSupervisor === true,
      };
    });
    const prevAgentBodyBySource = await loadPrevAgentBodies(input.chatId, srcIds, now);
    return { drain, prevAgentBodyBySource };
  });
}

// ── 4. Agreement + outcome ──────────────────────────────────────────────────

/** What a Jev stash said at the site: the act question's p / choice and whether it read "quiet". Pure. */
export function jevVerdictFromStash(stash: unknown): { purpose: string; question: string; p?: number; choice?: string; quiet: boolean | null } | null {
  const s = stash as { purpose?: unknown; answers?: Record<string, any> } | null;
  if (!s || typeof s !== 'object' || typeof s.purpose !== 'string' || !s.answers) return null;
  const question = s.purpose === 'drain_triage' ? 'disposition' : s.purpose === 'supervisor_turn_noop' ? 'will_act' : 'needs_turn_now';
  const a = s.answers[question];
  if (!a || typeof a !== 'object') return { purpose: s.purpose, question, quiet: null };
  if (a.type === 'noul' && typeof a.noul === 'number') return { purpose: s.purpose, question, p: Number(a.noul.toFixed(3)), quiet: a.noul <= 0.15 };
  if (a.type === 'choice' && typeof a.choice === 'string') return { purpose: s.purpose, question, choice: a.choice, quiet: a.choice !== 'act_now' };
  return { purpose: s.purpose, question, quiet: null };
}

/**
 * ONE row per site decision comparing the deterministic verdict with every
 * Jev purpose that asked at the same site (the stash + its siblings).
 * agree = the Jev purpose's "quiet" equals ¬material. Never throws.
 */
export function recordMaterialGateAgreement(result: MaterialGateResult | null, stashes: unknown[]): void {
  try {
    if (!result?.verdict) return;
    const flat: unknown[] = [];
    for (const s of stashes) {
      if (!s) continue;
      flat.push(s);
      const also = (s as any)?.also;
      if (Array.isArray(also)) flat.push(...also);
    }
    const jev = flat.map(jevVerdictFromStash).filter((x): x is NonNullable<ReturnType<typeof jevVerdictFromStash>> => !!x);
    if (!jev.length) return;
    const material = result.verdict.material;
    recordLoopMetric({
      kind: 'supervisor_material_gate_agreement', sessionId: result.chatId, value: jev.filter((j) => j.quiet !== null && j.quiet === !material).length,
      meta: {
        origin: result.origin, mode: result.mode, material, skipped: result.skip, reasons: result.verdict.reasons,
        jev: jev.map((j) => ({ ...j, agree: j.quiet === null ? null : j.quiet === !material })),
      },
    });
  } catch { /* telemetry never blocks a wake */ }
}

/** Gate verdicts that let a wake through, waiting for the run's finalize (in-process; same process starts the run). */
const pendingVerdicts = new Map<string, { origin: WakeGateOrigin; verdict: MaterialVerdict; mode: MaterialGateMode; at: number; tiers?: ProgressTierEval | null }>();
const PENDING_TTL_MS = 30 * 60 * 1000;

function notePendingVerdict(chatId: string, origin: WakeGateOrigin, verdict: MaterialVerdict, mode: MaterialGateMode, tiers?: ProgressTierEval | null): void {
  pendingVerdicts.set(chatId, { origin, verdict, mode, at: Date.now(), ...(tiers ? { tiers } : {}) });
  if (pendingVerdicts.size > 500) for (const [k, v] of pendingVerdicts) if (Date.now() - v.at > PENDING_TTL_MS) pendingVerdicts.delete(k);
}

/**
 * The chat finalize of a SUPERVISOR run (fire-and-forget): advances the mark
 * after a completed machine wake, and labels the gate verdict that let this
 * wake through with what the run measurably did (a real action — the
 * harness label — vs not). Never throws.
 */
export async function onSupervisorRunFinalized(input: {
  chatId: string;
  machineWake: boolean;
  failed: boolean;
  /** When the wake's state (the diff) was composed — the next diff starts here. */
  wakeLedgerAt?: string | null;
  runStartedAt: number;
  parts: unknown;
}): Promise<void> {
  try {
    if (wakeLedgerUnderTest()) return;
    if (input.machineWake && !input.failed) {
      const at = input.wakeLedgerAt && Number.isFinite(Date.parse(input.wakeLedgerAt)) ? new Date(input.wakeLedgerAt) : new Date(input.runStartedAt);
      await recordWakeHighWaterMark(input.chatId, at);
    }
    const pending = pendingVerdicts.get(input.chatId);
    if (!pending || pending.at < input.runStartedAt - 120_000 || Date.now() - pending.at > PENDING_TTL_MS) return;
    pendingVerdicts.delete(input.chatId);
    const { realActionToolNames } = await import('./decision-outcome-labels');
    const actions = input.failed ? [] : realActionToolNames(input.parts, input.chatId);
    recordLoopMetric({
      kind: 'supervisor_material_gate_outcome', sessionId: input.chatId, value: actions.length,
      meta: {
        origin: pending.origin, mode: pending.mode, material: pending.verdict.material, wouldSkip: !pending.verdict.material,
        reasons: pending.verdict.reasons, acted: input.failed ? null : actions.length > 0, actions: [...new Set(actions)].slice(0, 8), failed: input.failed,
        // SUP-WAKE-TIERS: the tier label — a control row is a would-be progress skip delivered to measure the skip.
        ...(pending.tiers ? { tier: pending.verdict.tier, tierWouldSkip: pending.tiers.wouldSkip, tierWhy: pending.tiers.why, control: pending.tiers.control } : {}),
      },
    });
  } catch { /* finalize telemetry never throws */ }
}

/**
 * The drain origin's SKIP: persist the queued agent rows as ONE agent-origin
 * user row + a harness ack row (the transcript keeps every word; the next
 * wake's diff lists them under "Agent messages to you"), then delete the
 * pending rows. Returns false on any failure (the caller drains normally).
 */
export async function ackMaterialGateDrain(input: {
  chatId: string;
  rows: Array<{ id: string; content: string }>;
  sourceChatIds: Array<string | undefined>;
  verdict: MaterialVerdict | null;
  /** SUP-WAKE-TIERS: 'progress_self_driving' names the progress hold in both rows; absent = today's wording. */
  skipReason?: MaterialSkipReason;
}): Promise<boolean> {
  try {
    const { deletePending } = await import('../chat-agent/message-queue.service');
    const sources = [...new Set(input.sourceChatIds.filter((x): x is string => !!x))];
    const progress = input.skipReason === 'progress_self_driving';
    const why = progress
      ? 'were progress from lanes still driving themselves (a live run or a schedule armed within 30 min) with no ask or blocker'
      : 'carried no material change (near-duplicate lane report / status-only report-up)';
    const content = `[MATERIAL GATE — ${input.rows.length} queued agent message(s) from ${sources.map((s) => s.slice(0, 8)).join(', ') || 'unknown'} ${why}; acked by the harness, no turn started]\n\n${input.rows.map((r) => String(r.content ?? '').trim()).join('\n\n— — —\n\n')}`;
    await prisma.crossModelMessage.create({
      data: { chatId: input.chatId, role: 'user', content, metadata: { origin: 'agent', ...(sources[0] ? { sourceChatId: sources[0] } : {}), ackOnly: true, materialGate: true, batch: input.rows.length, ...(progress ? { skipReason: input.skipReason } : {}) } as any },
    });
    await prisma.crossModelMessage.create({
      data: {
        chatId: input.chatId, role: 'assistant',
        content: progress
          ? '[MATERIAL GATE — acked; progress only and the reporting lanes are driving themselves, no turn started]'
          : '[MATERIAL GATE — acked; no material change since the last wake, no turn started]',
        metadata: { origin: 'material-gate-ack', kind: 'material_gate_ack', batch: input.rows.length, reasons: input.verdict?.reasons ?? [], ...(progress ? { skipReason: input.skipReason } : {}) } as any,
      },
    });
    await prisma.crossModelChat.update({ where: { id: input.chatId }, data: { updatedAt: new Date() } }).catch(() => {});
    for (const r of input.rows) await deletePending(r.id).catch(() => {});
    return true;
  } catch (err: any) {
    logger.warn(`wake-ledger: material-gate drain ack failed for ${input.chatId.slice(0, 8)} (${err?.message ?? err}) — draining normally`);
    return false;
  }
}

/** Close the decision stashes of a wake the material gate skipped: one unlabelled outcome row per stash / sibling. Never throws. */
export async function closeStashesForGateSkip(stashes: unknown[], sessionId: string, origin: WakeGateOrigin): Promise<void> {
  try {
    const { reconstructDecision, recordDecisionOutcome, stashSiblings } = await import('./decision-gate');
    const { PURPOSE_QUESTION } = await import('./decision-outcome-labels');
    for (const stash of stashes) {
      if (!stash) continue;
      for (const s of [...stashSiblings(stash), stash]) {
        const decision = reconstructDecision(s);
        if (!decision) continue;
        const question = (PURPOSE_QUESTION as Record<string, string | undefined>)[decision.purpose];
        if (!question) continue;
        recordDecisionOutcome(decision, decision.purpose, { question, actual: null, acted: false, sessionId, note: `not started: material gate skip (${origin})` });
      }
    }
  } catch { /* telemetry never blocks */ }
}

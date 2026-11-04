/**
 * Plain-chat ORPHANED-TURN reconciliation (feedback ticket 68bc5aec).
 *
 * THE BUG: thinking-mode plain chats intermittently accept a user message (the
 * transcript row is visible) but the agent run never completes — the chat then
 * sits idle for hours, while a fresh send works fine. Root cause: a plain-chat
 * run is a fire-and-forget in-process IIFE with ZERO durable state — the user
 * row persists INSIDE the run (chat-agent.service runChatAgentTurn) and the
 * assistant row at its finalize; on process death (blue-green deploy,
 * unhandledRejection → exit, OOM) the run vanishes with no finally, no error
 * event, and no run_failed. Two holes result:
 *   (A) messages queued to pending_chat_messages BEHIND a run that then died
 *       are never drained — drainChatQueue's only caller is the dead run's
 *       finally;
 *   (B) transcript user rows whose run died mid-flight sit unanswered forever.
 *
 * THE SWEEPER: one per WEB instance (mirrors startCodingScheduleSweeper —
 * fireScheduleTarget already starts plain-chat runs from a per-instance web
 * sweeper, cross-instance safety via startDetachedChatRun's ATOMIC Redis
 * claim, so blue-green double-firing is structurally safe). The worker process
 * deliberately does NOT own this: plain-chat execution belongs on web.
 *
 * RULE A (corpse-queued pendings): pending rows older than the PENDING grace.
 * A live run drains its own queue, so an old pending means the run that
 * should have drained it is dead. Per distinct chat: FAIL-CLOSED idle probe
 * (isChatBusyStrict — a probe ERROR aborts the whole pass; the fail-open
 * isChatBusy is NEVER the sweeper's probe) → idle ⇒ drainChatQueue(chatId,
 * userId-from-row). The drain re-peeks, re-checks busy, starts the oldest row,
 * and deletes it only after a successful start — safe to call redundantly.
 *
 * RULE B (unanswered user rows): chats whose LATEST crossmodel_messages row is
 * role='user' and older than the UNANSWERED grace (5 min — a live run holds
 * the busy claim for its ENTIRE lifetime, claim-then-persist included, and
 * the pass probes fail-closed, so claim-absent + 5 min idle means safely
 * dead; see UNANSWERED_GRACE_MS for why this was lowered from 30 min).
 * Coding chats (a coding_sessions row) are EXCLUDED — run-reaper.ts owns them.
 * Per row: fail-closed probe → skip if busy → skip if a pending row exists
 * (Rule A owns it) → then:
 *   • HUMAN-origin row (metadata.origin absent/'user'), recovery budget left:
 *     re-fire — startDetachedChatRun with the row's content, the chat's
 *     userId, the chat row's mode (normalized like sendChatMessage), the
 *     row's createdAt as userTurnAt (the ORIGINAL send's confirmation
 *     anchor), and recoveryForMessageId=<row id> (the run skips the persist
 *     and excludes the row from its history load — see ChatAgentRunArgs).
 *     ONLY a won claim (non-null key) writes the marker
 *     metadata.recovery.{firedAt,attempts,by:'orphan-sweeper'}; a lost race
 *     leaves the row unmarked for a later pass. Attachments from the original
 *     send are NOT recoverable (they lived in the dead process's memory) —
 *     the re-fire carries the text only; the row's attachment chips stay on
 *     the transcript.
 *   • MACHINE-origin row, recovery budget left: re-fire down the path the
 *     ORIGINAL send ran (ticket bb2eca92 — see the MACHINE paragraph below).
 *   • Recovery budget SPENT (recovery.attempts >= MAX_RECOVERY_ATTEMPTS, 3 —
 *     ticket 6c1e595c) OR a machine-origin row without the clean-message
 *     stash (pre-bb2eca92 persist): escalate ONCE — attention_needed hook
 *     event naming the message id + age + attempt count, ONE assistant
 *     notice row (notifyScheduleTerminalOnce idiom: metadata.origin
 *     'orphan-recovery', Redis-NX once-gate per message id, gate reopens if
 *     the insert fails), then metadata.recovery.escalatedAt so it never
 *     re-alerts. escalatedAt already present ⇒ fully silent.
 *
 * THE BUDGET (ticket 6c1e595c): the re-fire is bounded to
 * MAX_RECOVERY_ATTEMPTS per row, then escalate. The shipped once-only design
 * (68bc5aec/bb2eca92) left lanes deaf during bumpy restart windows —
 * health-gate flaps and back-to-back deploys killed the single re-fire too,
 * and machine turns have no human to resend them (3 attention_needed
 * escalations in 48 h + a supervisor run that died mid-window and needed
 * manual steering). BACKWARD COMPAT: a row marked firedAt under the old
 * once-only semantics carries NO attempts field — it counts as ONE attempt
 * already spent (attempts ?? (firedAt ? 1 : 0)) and gets up to
 * MAX_RECOVERY_ATTEMPTS-1 further re-fires under the new budget.
 *
 * MACHINE-ORIGIN rows auto re-fire (ticket bb2eca92 — the 2026-08-28
 * redesign; the original 68bc5aec design escalated them WITHOUT re-firing,
 * which left machine turns dead for 9+ days when no human would ever resend —
 * the ticket's exact failure). Two faithful paths, keyed on how the ORIGINAL
 * send ran:
 *   • machineWake rows (schedule/hook/webhook — their persisted content has
 *     the freshness preamble BAKED IN, so the content itself can never be
 *     re-fired without doubling the preamble): the run now ALSO persists the
 *     clean PRE-PREAMBLE message as metadata.machineMessage
 *     (chat-agent.service machineWakeOriginalMessage), and the sweeper
 *     re-fires THAT with machineWake:true — startDetachedChatRun re-bakes a
 *     FRESH preamble + supervisor state block + clock exactly as for a live
 *     wake; persist is skipped (recoveryForMessageId) so nothing doubles, and
 *     the stale baked row stays in the transcript as history. Legacy rows
 *     persisted before the stash existed carry no machineMessage → escalate.
 *   • 'agent' rows (in-loop send_chat_message sends): the original send ran
 *     the INTERACTIVE path (platform.service sets machineWake only for
 *     webhook), so a content-as-is re-fire with machineWake off is
 *     byte-faithful to it.
 *   • origin 'machine' rows (ticket 540176d2): NEVER-ANSWERABLE machine
 *     injects (today: the action verifier's post-delivery correction row) —
 *     'machine' is not a run origin, so no accepted turn ever carries it;
 *     skipped silently. They previously fell through to escalate as "a
 *     machine turn with no clean-message stash… the user should resend" —
 *     manual-resend noise about an automated message that was never a turn.
 *   • Anything else machine-origin (unknown/legacy shapes): escalate once.
 * The loop-bound weakening the old design feared is bounded: the re-fire is
 * capped per row (MAX_RECOVERY_ATTEMPTS via the attempts counter), and the
 * dead run never cleared its hook depth stamp (clearHookDepth runs only in
 * the live finalize), so any resumed chain continues from an ELEVATED depth
 * — the conservative direction.
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { isChatBusyStrict } from './chat-busy';
import { peekOldest } from './message-queue.service';
import { storedModeToPreset } from '../types';
import {
  DEPLOY_INTERRUPT_ORIGIN,
  DEPLOY_REQUEUE_KEY,
  REQUEUE_ENTRY_TTL_MS,
  isDeployInterruptMeta,
  DeployRequeueEntry,
} from './shutdown-interrupt';
import { parseResumeBrief, type DeployResumeBrief } from './deploy-resume-brief';

// ── Env knobs (dev-container.service idiom: read per use so tests can set) ──
/** Env-knob parse with a garbage clamp (review N5): Number('junk') is NaN and
 *  setInterval(NaN) is a ~1ms hot sweep — fall back to the default instead. */
const envMs = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Sweep cadence (default 2 min). First pass fires after ONE interval, never at boot. */
const SWEEP_MS = () => envMs('CHAT_ORPHAN_SWEEP_MS', 120_000);
/**
 * A pending row older than this is corpse-queued (default 5 min): a live run's
 * finally drains its queue within seconds of finishing, and a run holds the
 * busy claim for its whole life, so 5 min behind a claimed chat can only mean
 * the drainer died.
 */
const PENDING_GRACE_MS = () => envMs('CHAT_ORPHAN_PENDING_GRACE_MS', 300_000);
/**
 * A latest-is-user transcript row older than this is orphaned (default 5
 * min): a LIVE run holds the busy claim for its ENTIRE lifetime (heartbeat
 * 15s, TTL 60s — and the claim is taken BEFORE the user row persists) while
 * this pass probes FAIL-CLOSED, so claim-absent + 5 min idle can only be a
 * dead run — the same claim semantics Rule A's 5-min pending grace already
 * relies on. The 30-min default this shipped with (68bc5aec) failed the exact
 * scenario it existed for (ticket bb2eca92: three restarts in 65 min killed
 * every re-fire before the 30-min mark); the only race the grace covers —
 * claim-then-persist — is seconds, and a Redis outage at claim time
 * self-heals via the unconditional heartbeat refresh within ~15s of Redis
 * returning (the probe aborts the pass whenever Redis is unreadable).
 */
const UNANSWERED_GRACE_MS = () => envMs('CHAT_ORPHAN_UNANSWERED_GRACE_MS', 300_000);
/**
 * Bounded re-fire budget per orphaned row (default 3 — ticket 6c1e595c):
 * escalate once a row's recovery attempts reach this count. envMs's positive-
 * number garbage clamp applies unchanged (a count, not ms, but the parse is
 * the same). A row marked firedAt under the pre-6c1e595c once-only semantics
 * (no attempts field) counts as ONE attempt already spent.
 */
const MAX_RECOVERY_ATTEMPTS = () => envMs('CHAT_ORPHAN_MAX_RECOVERY_ATTEMPTS', 3);

/** Batch caps — one pass never holds the event loop on a backlog. */
const PENDING_BATCH = 25;
const UNANSWERED_BATCH = 50;

/** metadata.origin values that mark MACHINE traffic — mirrors chat-agent.service's MACHINE_ROW_ORIGINS. */
const MACHINE_ORIGINS = new Set(['schedule', 'hook', 'agent', 'machine', 'webhook']);

/** One-shot notice gate: outlives any realistic orphan GC window (notifyScheduleTerminalOnce idiom). */
const NOTICE_TTL_SEC = 30 * 24 * 60 * 60;
const noticeKey = (messageId: string) => `cm:orphannotice:${messageId}`;

let sweeping = false; // overlap guard — a slow pass must never double-run (schedule.service idiom)
let sweeperTimer: ReturnType<typeof setInterval> | null = null;

/** Register the boot sweeper (idempotent). Called from server.ts on every web boot. */
export function startChatOrphanSweeper(): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => { void sweepOrphanedChatTurns(); }, SWEEP_MS());
  sweeperTimer.unref?.();
  logger.info(`chat orphan sweeper started (${Math.round(SWEEP_MS() / 1000)}s, pending grace ${Math.round(PENDING_GRACE_MS() / 60000)}m, unanswered grace ${Math.round(UNANSWERED_GRACE_MS() / 60000)}m, blue-green safe via the atomic run claim)`);
}

/**
 * One sweep tick. Exported for tests (the boot sweeper drives it via timer).
 * Never throws: each rule runs in its OWN try/catch so one rule's failure
 * (e.g. a Redis outage tripping the fail-closed probe) never skips the other.
 */
export async function sweepOrphanedChatTurns(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    try {
      await drainDeployRequeue();
    } catch (err: any) {
      logger.warn(`chat-orphan-recovery: deploy-requeue drain pass aborted: ${err?.message ?? err}`);
    }
    try {
      await sweepCorpseQueuedPendings();
    } catch (err: any) {
      // The fail-closed probe aborts HERE by design (a Redis/DB hiccup must
      // never be misread as "idle" — draining into a live chat would double-run it).
      logger.warn(`chat-orphan-recovery: rule A (corpse-queued pendings) pass aborted: ${err?.message ?? err}`);
    }
    try {
      await sweepUnansweredUserRows();
    } catch (err: any) {
      logger.warn(`chat-orphan-recovery: rule B (unanswered user rows) pass aborted: ${err?.message ?? err}`);
    }
    try {
      await sweepDeployInterruptRows();
    } catch (err: any) {
      logger.warn(`chat-orphan-recovery: rule C (deploy-interrupt rows) pass aborted: ${err?.message ?? err}`);
    }
  } finally {
    sweeping = false;
  }
}

/** RULE A — drain pending rows corpse-queued behind a dead run. */
async function sweepCorpseQueuedPendings(): Promise<void> {
  const cutoff = new Date(Date.now() - PENDING_GRACE_MS());
  const rows = await prisma.pendingChatMessage.findMany({
    where: { createdAt: { lt: cutoff } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PENDING_BATCH,
    select: { chatId: true, userId: true },
  });
  if (!rows.length) return;
  // Distinct chatIds, oldest-first (rows are globally ordered, so the FIRST
  // sighting of a chat carries its oldest pending's userId — the drainer's identity).
  const byChat = new Map<string, string>();
  for (const r of rows) if (!byChat.has(r.chatId)) byChat.set(r.chatId, r.userId);
  // Dynamic import (fireScheduleTarget idiom): chat-agent.service pulls the
  // whole agent loop; a static edge from a sweeper module would risk cycles.
  const { drainChatQueue } = await import('./chat-agent.service');
  let drained = 0;
  for (const [chatId, userId] of byChat) {
    // FAIL-CLOSED: a probe error THROWS out of the whole Rule-A pass — never catch-to-idle.
    if (await isChatBusyStrict(chatId)) continue;
    if (await drainChatQueue(chatId, userId)) drained++;
  }
  if (drained) logger.info(`chat-orphan-recovery: rule A drained corpse-queued pending(s) for ${drained} chat(s)`);
}

interface OrphanedUserRow {
  id: string;
  chatId: string;
  content: string;
  metadata: unknown;
  createdAt: Date;
  chatUserId: string;
  chatMode: string;
}

/** Defensive object read of a Json? column (objects only — arrays/scalars are not metadata). */
function asRecord(v: unknown): Record<string, any> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

/**
 * The chat row's stored mode → a chat-agent run mode — EXACTLY sendChatMessage's
 * normalization (platform.service normalizeChatAgentMode: normalizePatienceMode
 * aliases retired tiers, then only the two live multi-step levels survive;
 * anything else → L1). Mirrored inline like fireScheduleTarget does — importing
 * platform.service from a sweeper module would drag its whole static chain in.
 */
function normalizeStoredChatMode(mode: string): 'single_thinking' | 'thinking' | 'deep_research' {
  // 2026-09-26: the ONE stored-mode rule (types.ts) — a stored 'auto' re-fires
  // at the L2 preset fallback; legacy ids alias; unknown ⇒ L1 (unchanged).
  return storedModeToPreset(mode);
}

/** RULE B — re-fire (bounded: MAX_RECOVERY_ATTEMPTS per row) or escalate (once) transcript user rows whose run died. */
async function sweepUnansweredUserRows(): Promise<void> {
  const cutoff = new Date(Date.now() - UNANSWERED_GRACE_MS());
  // Chats whose LATEST message is an old USER row, excluding coding chats
  // (coding_sessions rows — run-reaper.ts owns their recovery). Raw SQL
  // (run-reaper idiom): "latest row" is not expressible as a Prisma where.
  const rows = await prisma.$queryRaw<OrphanedUserRow[]>`
    SELECT m."id", m."chatId", m."content", m."metadata", m."createdAt",
           c."userId" AS "chatUserId", c."mode" AS "chatMode"
    FROM "crossmodel_messages" m
    JOIN "crossmodel_chats" c ON c."id" = m."chatId"
    WHERE m."role" = 'user'
      AND m."createdAt" < ${cutoff}
      AND c."archivedAt" IS NULL -- never re-fire a run into an archived (hidden) chat
      AND NOT EXISTS (
        SELECT 1 FROM "crossmodel_messages" newer
        WHERE newer."chatId" = m."chatId"
          AND (newer."createdAt" > m."createdAt"
               OR (newer."createdAt" = m."createdAt" AND newer."id" > m."id"))
      )
      AND NOT EXISTS (SELECT 1 FROM "coding_sessions" cs WHERE cs."id" = m."chatId")
    ORDER BY m."createdAt" ASC
    LIMIT ${UNANSWERED_BATCH}`;
  if (!rows.length) return;
  const { startDetachedChatRun } = await import('./chat-agent.service');
  for (const row of rows) {
    // FAIL-CLOSED: a probe error THROWS out of the whole Rule-B pass — never catch-to-idle.
    await handleOrphanedUserRow(row, startDetachedChatRun, null, { requireLatest: true });
  }
}

/**
 * RULE B race guard (2026-10-04, found by the live query suite — scripts/e2e/query-suite.py):
 * the Rule-B SELECT is a SNAPSHOT, and a live run SAVES its answer before it releases the busy
 * marker. A sweep whose SELECT ran just before that save and whose busy probe ran just after the
 * release saw an "unanswered, idle" chat and re-fired the SAME question (prod chat 3fc0fb00: a
 * 462 s L1 run, then a second L2 answer to the one user row, with different numbers). Any human
 * run longer than the 5-min grace was exposed. After the probe says idle, a fresh read that the
 * row is STILL the newest closes the window (save-before-release ⇒ idle ⇒ the answer is visible).
 * Rule B only — the deploy-requeue drain and Rule C legitimately see an interrupt-notice row after
 * their user row. Kill switch CHAT_ORPHAN_LATEST_RECHECK_DISABLED=1.
 */
async function rowStillLatest(row: OrphanedUserRow): Promise<boolean> {
  const newer = await prisma.crossModelMessage.findFirst({
    where: {
      chatId: row.chatId,
      OR: [{ createdAt: { gt: row.createdAt } }, { createdAt: row.createdAt, id: { gt: row.id } }],
    },
    select: { id: true },
  });
  return !newer;
}

/** What ONE orphaned-row handling did — the deploy-requeue drain keys entry
 *  retirement on it: RETIRE on fired/escalated/silent (terminal), KEEP on
 *  busy/deferred (a later pass retries — never a lost turn). */
export type OrphanHandleOutcome = 'busy' | 'silent' | 'fired' | 'deferred' | 'escalated';

/**
 * ONE orphaned user row through the shared re-fire/escalate path — Rule B's
 * former per-row body, extracted (feedback 56159c5a) so the deploy-requeue
 * drain and the Rule-C interrupt-row backstop run the SAME faithful branches
 * (human vs machineWake-stash vs agent, the shared attempts budget, once-only
 * escalation) instead of re-deriving them.
 * FAIL-CLOSED contract preserved: the busy probe THROWS out of the pass.
 * `resume` (ticket 5ba5f03e): the deploy-interrupt soft checkpoint harvested by
 * the SIGTERM ritual — forwarded into the re-fired run so it CONTINUES the turn
 * instead of repeating side effects the dead attempt already executed. Null on
 * the organic-orphan Rule-B path (no ritual, no brief).
 */
async function handleOrphanedUserRow(
  row: OrphanedUserRow,
  startDetachedChatRun: StartDetachedChatRunFn,
  resume: DeployResumeBrief | null = null,
  opts: { requireLatest?: boolean } = {},
): Promise<OrphanHandleOutcome> {
  if (await isChatBusyStrict(row.chatId)) return 'busy';
  if (await peekOldest(row.chatId)) return 'busy'; // a live queue — Rule A owns this chat
  // Rule B: answered between the SELECT snapshot and the busy probe (see rowStillLatest).
  if (opts.requireLatest && process.env.CHAT_ORPHAN_LATEST_RECHECK_DISABLED !== '1' && !(await rowStillLatest(row))) return 'silent';
  const meta = asRecord(row.metadata);
  const recovery = asRecord(meta.recovery);
  if (recovery.escalatedAt) return 'silent'; // already escalated — fully silent
  // NEVER-ANSWERABLE machine injects (ticket 540176d2): 'machine' is NOT a
  // run origin (ChatAgentRunArgs.messageOrigin is 'user' | 'schedule' |
  // 'hook' | 'agent' | 'webhook'), so no accepted turn ever carries it — it
  // marks machine-authored informational injections (today: the action
  // verifier's post-delivery correction row, action-verifier.ts) that no run
  // was ever started for and none will ever answer. The old fall-through
  // (machine origin + no machineMessage stash + not 'agent') escalated every
  // such inject to the owner one grace later as "a machine turn with no
  // clean-message stash… the user should resend" — a manual-resend demand
  // for an AUTOMATED message that was never a turn (observed twice: turns
  // c4908c62 and a4dcca40, each ~6 min after a verifier strike).
  if (String(meta.origin ?? '') === 'machine') return 'silent';
  const machineOrigin = MACHINE_ORIGINS.has(String(meta.origin ?? ''));
  // Attempts already spent (ticket 6c1e595c): BACKWARD COMPAT — a row marked
  // firedAt under the pre-6c1e595c once-only semantics has NO attempts field
  // and counts as ONE attempt. Same count expression as markRecoveryFired.
  const attempts = typeof recovery.attempts === 'number' ? recovery.attempts : (recovery.firedAt ? 1 : 0);
  if (attempts < MAX_RECOVERY_ATTEMPTS()) {
    if (!machineOrigin) {
      return (await refireOrphanedTurn(row, startDetachedChatRun, resume)) ? 'fired' : 'deferred';
    }
    // Machine-origin rows auto re-fire too (bb2eca92) — but only down
    // a path faithful to the ORIGINAL send (module header): machineWake
    // rows (schedule/hook/webhook) from their stashed clean pre-preamble
    // message; 'agent' rows content-as-is down the interactive path they
    // originally ran. Anything else is a legacy/unknown shape → escalate.
    const cleanWake = typeof meta.machineMessage === 'string' && meta.machineMessage ? meta.machineMessage : null;
    if (cleanWake || meta.origin === 'agent') {
      return (await refireMachineOrphanedTurn(row, meta, cleanWake, startDetachedChatRun, resume)) ? 'fired' : 'deferred';
    }
  }
  // The recovery budget is SPENT (the re-fired runs died too) — or a
  // machine-origin row too old to carry the clean-message stash: tell the
  // owner exactly once.
  await escalateOrphanedTurn(row, recovery);
  return 'escalated';
}

type StartDetachedChatRunFn = typeof import('./chat-agent.service').startDetachedChatRun;

/**
 * Re-fire ONE orphaned human turn. The marker lands ONLY after a won start
 * (non-null key — the atomic claim): a lost race leaves the row unmarked so a
 * later pass retries once the winner's run has finished.
 * Returns true ONLY on a won start (marker landed) — the deploy-requeue drain
 * keys its entry retirement on this.
 */
async function refireOrphanedTurn(row: OrphanedUserRow, startDetachedChatRun: StartDetachedChatRunFn, resume: DeployResumeBrief | null = null): Promise<boolean> {
  const key = await startDetachedChatRun({
    userId: row.chatUserId,
    chatId: row.chatId,
    message: row.content,
    // The chat row's stored mode, normalized exactly like sendChatMessage.
    mode: normalizeStoredChatMode(row.chatMode),
    messageOrigin: 'user',
    // The ORIGINAL send's confirmation anchor (the dead run persisted at this
    // instant) — see ChatAgentRunArgs.recoveryForMessageId.
    userTurnAt: row.createdAt,
    recoveryForMessageId: row.id,
    // Deploy-interrupt soft checkpoint (ticket 5ba5f03e) — the re-run is told
    // what the dead attempt already executed so it continues, not repeats.
    ...(resume ? { resumeBrief: resume } : {}),
  });
  if (!key) return false; // lost the start race — a later pass retries (row stays unmarked)
  await markRecoveryFired(row);
  logger.info(`chat-orphan-recovery: re-fired orphaned turn ${row.id} in chat ${row.chatId} (unanswered since ${row.createdAt.toISOString()})`);
  return true;
}

/**
 * Re-fire ONE orphaned MACHINE turn (ticket bb2eca92) down the path its
 * ORIGINAL send ran:
 *   cleanWake != null → the machineWake path (schedule/hook/webhook sends):
 *     the stashed PRE-PREAMBLE message with machineWake:true — startDetachedChatRun
 *     re-bakes a FRESH preamble + supervisor state block + clock exactly as
 *     for a live wake, and the recovery skip-persist keeps the transcript single.
 *   cleanWake == null → an 'agent' row (in-loop send_chat_message): the
 *     original send ran the INTERACTIVE path (platform.service sets machineWake
 *     only for webhook), so content-as-is with machineWake off is byte-faithful.
 * NO userTurnAt either way — DELIBERATELY dropped even though an 'agent'
 * send CAN carry one (platform-tools threads the SENDING run's anchor when
 * that run was user-anchored): the re-fire is a machine-initiated recovery,
 * and a machine turn must never launder a human's anchor into a
 * confirmation — fail-closed; worst case a still-live pending (~14-min TTL)
 * simply re-registers.
 * The marker lands ONLY after a won claim, same as the human path; origin +
 * sourceChatId are re-stamped so fleet views keep telling machine traffic
 * apart from the human thread. Returns true ONLY on a won start.
 */
async function refireMachineOrphanedTurn(
  row: OrphanedUserRow,
  meta: Record<string, any>,
  cleanWake: string | null,
  startDetachedChatRun: StartDetachedChatRunFn,
  resume: DeployResumeBrief | null = null,
): Promise<boolean> {
  const origin = String(meta.origin ?? 'agent') as 'schedule' | 'hook' | 'agent' | 'webhook';
  const storedMode = normalizeStoredChatMode(row.chatMode);
  const key = await startDetachedChatRun({
    userId: row.chatUserId,
    chatId: row.chatId,
    message: cleanWake ?? row.content,
    // The chat row's stored mode, normalized exactly like sendChatMessage —
    // EXCEPT webhook wakes, which never run Deep Research (mirror of
    // platform.service.ts's 2026-08-23 hardening clamp — adversarial review
    // B1): the daily council quota is enforced only at the interactive stream
    // site, so re-firing a killed webhook wake at a stored L3 mode would burn
    // unmetered council runs on untrusted external traffic. Schedule/hook
    // wakes are NOT clamped — fireScheduleTarget reads the stored mode
    // directly, so deep_research there is the faithful re-fire.
    mode: origin === 'webhook' && storedMode === 'deep_research' ? 'thinking' : storedMode,
    messageOrigin: origin,
    ...(typeof meta.sourceChatId === 'string' && meta.sourceChatId ? { originSourceChatId: meta.sourceChatId } : {}),
    ...(cleanWake != null ? { machineWake: true } : {}),
    recoveryForMessageId: row.id,
    // Deploy-interrupt soft checkpoint (ticket 5ba5f03e) — same carry-forward
    // as the human path: the re-baked wake sees what the dead attempt did.
    ...(resume ? { resumeBrief: resume } : {}),
  });
  if (!key) return false; // lost the start race — a later pass retries (row stays unmarked)
  await markRecoveryFired(row);
  logger.info(`chat-orphan-recovery: re-fired orphaned MACHINE turn ${row.id} in chat ${row.chatId} (origin ${origin}${cleanWake != null ? ', machineWake' : ''}, unanswered since ${row.createdAt.toISOString()})`);
  return true;
}

/**
 * The firedAt/attempts marker — shared by both re-fire paths; lands ONLY
 * after a won claim. attempts increments per won re-fire (ticket 6c1e595c);
 * a firedAt-only row from the once-only era counts as 1 prior attempt (the
 * same backward-compat count Rule B branches on), so its next won re-fire
 * writes attempts:2.
 */
async function markRecoveryFired(row: OrphanedUserRow): Promise<void> {
  const meta = asRecord(row.metadata);
  const recovery = asRecord(meta.recovery);
  await prisma.crossModelMessage.update({
    where: { id: row.id },
    data: {
      metadata: {
        ...meta,
        recovery: {
          ...recovery,
          firedAt: new Date().toISOString(),
          attempts: (typeof recovery.attempts === 'number' ? recovery.attempts : (recovery.firedAt ? 1 : 0)) + 1,
          by: 'orphan-sweeper',
        },
      },
    },
  }).catch((err: any) => logger.warn(`chat-orphan-recovery: recovery marker write failed for message ${row.id}: ${err?.message ?? err}`));
}

/**
 * Escalate ONE orphaned turn to its owner — exactly once per message id:
 * attention_needed hook event (the supervisor sees it), ONE assistant notice
 * row in the chat (Redis-NX gated, notifyScheduleTerminalOnce idiom), then the
 * escalatedAt marker that silences every later pass.
 */
async function escalateOrphanedTurn(row: OrphanedUserRow, recovery: Record<string, any>): Promise<void> {
  const ageMs = Date.now() - new Date(row.createdAt).getTime();
  const ageMin = Math.max(1, Math.round(ageMs / 60000));
  // Same backward-compat attempt count as the Rule B branch (firedAt-only → 1).
  const attempts = typeof recovery.attempts === 'number' ? recovery.attempts : (recovery.firedAt ? 1 : 0);
  // Dynamic import (schedule.service's emitHookEventSafe idiom): emission must
  // never break the sweep, and hooks.service's static chain would cycle. The
  // *Safe variant never throws; the try/catch guards the import itself.
  try {
    const mod: any = await import('../platform/hooks.service').catch(() => null);
    await mod?.emitHookEventSafe?.(
      row.chatId,
      'attention_needed',
      `Chat turn ${row.id} went unanswered ~${ageMin} min: the run accepting it died on restart${attempts > 0 ? ` and the automatic recovery attempts (${attempts}) also died` : ' (a machine turn with no clean-message stash — it cannot be faithfully auto re-fired)'} — the user should resend.`,
    );
  } catch { /* best-effort — the notice row below is the owner-visible surface */ }
  // N1 (PR review 2026-08-28): escalatedAt — the silencer — lands ONLY when the
  // notice is durably handled (posted now, or the NX gate says already told).
  // A failed/hiccuped post leaves the row un-silenced so the next pass retries
  // (the reopened gate is what makes that retry possible).
  const noticeHandled = await postOrphanNoticeOnce(row, ageMin);
  if (!noticeHandled) {
    logger.warn(`chat-orphan-recovery: notice for orphaned turn ${row.id} not durably posted — escalatedAt left UNSET so the next pass retries`);
    return;
  }
  const meta = asRecord(row.metadata);
  await prisma.crossModelMessage.update({
    where: { id: row.id },
    data: { metadata: { ...meta, recovery: { ...recovery, escalatedAt: new Date().toISOString() } } },
  }).catch((err: any) => logger.warn(`chat-orphan-recovery: escalatedAt marker write failed for message ${row.id}: ${err?.message ?? err}`));
  logger.info(`chat-orphan-recovery: rule B escalated orphaned turn ${row.id} in chat ${row.chatId} (age ~${ageMin} min)`);
}

/**
 * The ONE in-chat notice for an orphaned turn (notifyScheduleTerminalOnce
 * idiom): Redis-NX once-gate per MESSAGE id; a failed insert reopens the gate
 * so the next pass retries rather than losing the notice forever.
 *
 * Returns true ONLY when the notice is durably handled — posted by this call,
 * or the gate was already held (definitively told / being told). False means
 * UNKNOWN (Redis hiccup on the claim) or FAILED (insert died, gate reopened):
 * the caller must NOT write escalatedAt, so the next pass retries. SET NX
 * returns null on conflict, so the claim catches explicitly — a `.catch(() =>
 * null)` would conflate an error with a held gate (N1).
 */
async function postOrphanNoticeOnce(row: OrphanedUserRow, ageMin: number): Promise<boolean> {
  let claimed: string | null;
  try {
    claimed = await redisClient.set(noticeKey(row.id), '1', { NX: true, EX: NOTICE_TTL_SEC });
  } catch {
    return false; // Redis hiccup — unknown whether told; stay quiet this pass, retry next
  }
  if (claimed !== 'OK') return true; // gate already held — the owner was (or is being) told
  // Same backward-compat attempt count as the Rule B branch (firedAt-only → 1).
  const noticeRecovery = asRecord(asRecord(row.metadata).recovery);
  const attempts = typeof noticeRecovery.attempts === 'number' ? noticeRecovery.attempts : (noticeRecovery.firedAt ? 1 : 0);
  try {
    await prisma.crossModelMessage.create({
      data: {
        chatId: row.chatId,
        role: 'assistant',
        content:
          `⚠️ **This turn was interrupted** — your message above was accepted ~${ageMin} minute${ageMin === 1 ? '' : 's'} ago, ` +
          `but the run answering it was lost to a server restart${attempts > 0 ? `, and the automatic recovery attempt${attempts === 1 ? '' : 's'} (${attempts}) also died` : ''}. ` +
          `It will NOT resume on its own — please resend the message (or just say "try again") and I'll pick it up fresh. Sorry about that.`,
        metadata: { origin: 'orphan-recovery' },
      },
    });
  } catch (err: any) {
    // Claim-then-fail must not lose the one-shot notice forever: reopen the NX
    // gate so the next pass retries (the orphaned row persists).
    await redisClient.del(noticeKey(row.id)).catch(() => {});
    logger.warn(`chat-orphan-recovery: orphan notice persist failed for message ${row.id}: ${err?.message ?? err}`);
    return false;
  }
  // Bump the chat so the notice actually surfaces in the updatedAt-sorted
  // sidebar (mirrors notifyScheduleTerminalOnce's deliberate bump).
  await prisma.crossModelChat.update({ where: { id: row.chatId }, data: { updatedAt: new Date() } }).catch(() => {});
  return true;
}

// ── Deploy-interrupt requeue (feedback 56159c5a) ─────────────────────────────

/** Grace before the Rule-C DB backstop re-fires a turn whose requeue ENTRY
 *  never landed (default 3 min): the boot-drain/sweep drain should fire
 *  within seconds of the new color's boot, so 3 min can only mean the RPUSH
 *  was lost (Redis hiccup mid-ritual) or every drainer died with its color. */
const REQUEUE_GRACE_MS = () => envMs('CHAT_DEPLOY_REQUEUE_GRACE_MS', 180_000);
const INTERRUPT_BATCH = 25;

let drainingRequeue = false; // own overlap guard — the boot-drain and a sweep pass must never double-drain

/**
 * Drain the durable deploy-requeue list. The OLD color's SIGTERM ritual
 * (shutdown-interrupt.ts) RPUSHes its in-flight chat turns here on its way
 * down; Redis lives in its own container and survives the teardown. Called at
 * WEB BOOT (server.ts — the incoming color re-fires interrupted turns within
 * seconds, the whole point of the requeue) and on every sweep tick.
 * Idempotent by construction:
 *   - malformed / stale (>REQUEUE_ENTRY_TTL_MS) / answered / superseded /
 *     archived / missing-row entries are RETIRED (LREM);
 *   - an entry whose turn is STILL unanswered (the chat's latest row is the
 *     referenced user row, or a deploy-interrupt row referencing it) re-fires
 *     down the SAME shared path as Rule B (busy probe, pending-queue check,
 *     attempts budget, once-only escalation) and retires ONLY on a terminal
 *     outcome (fired/escalated/silent); a busy chat or a lost start race
 *     KEEPS the entry for a later pass — never a lost turn, never a
 *     double-fire (startDetachedChatRun's atomic claim closes the
 *     cross-instance race, and the still-unanswered re-check voids entries
 *     whose run finished anyway).
 */
export async function drainDeployRequeue(): Promise<void> {
  if (drainingRequeue) return;
  drainingRequeue = true;
  try {
    let raws: string[];
    try {
      raws = await redisClient.lRange(DEPLOY_REQUEUE_KEY, 0, -1);
    } catch (err: any) {
      // FAIL-CLOSED like the sweep probes: a Redis hiccup aborts the pass
      // rather than retiring entries blind.
      logger.warn(`chat-deploy-requeue: Redis unreadable — pass aborted (fail-closed): ${err?.message ?? err}`);
      return;
    }
    if (!raws.length) return;
    const { startDetachedChatRun } = await import('./chat-agent.service');
    for (const raw of raws) {
      try {
        await handleRequeueEntry(raw, startDetachedChatRun);
      } catch (err: any) {
        logger.warn(`chat-deploy-requeue: entry handling failed (kept for a later pass): ${err?.message ?? err}`);
      }
    }
  } finally {
    drainingRequeue = false;
  }
}

/** One requeue-list entry: retire-or-keep per the contract above. */
async function handleRequeueEntry(raw: string, startDetachedChatRun: StartDetachedChatRunFn): Promise<void> {
  const retire = async (): Promise<void> => {
    await redisClient.lRem(DEPLOY_REQUEUE_KEY, 1, raw).catch(() => {});
  };
  let entry: DeployRequeueEntry;
  try {
    entry = JSON.parse(raw) as DeployRequeueEntry;
    if (!entry || typeof entry.chatId !== 'string' || typeof entry.userMessageId !== 'string') throw new Error('bad shape');
  } catch {
    await retire(); // malformed — must never block the list
    return;
  }
  const ageMs = Date.now() - new Date(entry.at).getTime();
  if (!Number.isFinite(ageMs) || ageMs > REQUEUE_ENTRY_TTL_MS) {
    await retire();
    return;
  }
  // A deploy-cut Dig-deeper rung (audit 2026-09-26): re-fire the RUNG against
  // the escalated row — never a plain re-ask of the question text.
  if (entry.escalation && typeof entry.escalation.ofMessageId === 'string') {
    const outcome = await handleEscalationRequeueEntry(entry, startDetachedChatRun);
    if (outcome !== 'busy') await retire();
    return;
  }
  // A deploy-cut turn-continuation ROUND (review fix 3): re-queue the SAME
  // round through the chat's queue — never a plain re-ask of the prompt.
  if (entry.continuation && entry.continuation.stash && typeof entry.continuation.stash.taskId === 'string') {
    const outcome = await handleContinuationRequeueEntry(entry);
    if (outcome !== 'busy') await retire();
    return;
  }
  const row = await loadOrphanableUserRow(entry.userMessageId);
  if (!row) {
    await retire(); // row gone / archived / a coding chat — nothing to re-fire
    return;
  }
  // Still unanswered? The chat's latest row must BE the referenced user row
  // or a deploy-interrupt row referencing it — anything else (a real answer
  // landed after the ritual snapshotted the run, or the user re-asked)
  // voids the entry.
  const latest = await latestChatRow(entry.chatId);
  const stillUnanswered = !!latest
    && ((latest.role === 'user' && latest.id === row.id)
      || (isDeployInterruptMeta(latest.metadata)
        && (latest.metadata as Record<string, any>).interruptedMessageId === row.id));
  if (!stillUnanswered) {
    await retire();
    return;
  }
  // The soft checkpoint the ritual rode on this entry (ticket 5ba5f03e) —
  // validated tolerantly; a junk/absent brief degrades to a plain re-fire.
  const resume = parseResumeBrief(entry.resume);
  const outcome = await handleOrphanedUserRow(row, startDetachedChatRun, resume);
  if (outcome === 'fired') {
    await retire();
    logger.info(`chat-deploy-requeue: re-fired deploy-interrupted turn ${row.id} in chat ${row.chatId} (interrupted at ${entry.at})`);
  } else if (outcome === 'escalated' || outcome === 'silent') {
    await retire(); // terminal — the owner was told (or already had been)
  }
  // busy / deferred → KEEP the entry: a later pass retries while the TTL lasts.
}

/**
 * A deploy-cut escalation rung: still owed iff no "Deeper findings" row newer
 * than the interrupt names the escalated message; the ORIGINAL question is the
 * user row right before the escalated answer (the controller's own rule).
 * Re-fired with `escalation` set (the run persists no user row, posts the
 * "Deeper findings" row, stamps the rung `done`). The quota was reserved by
 * the tap and is not reserved again.
 */
async function handleEscalationRequeueEntry(entry: DeployRequeueEntry, startDetachedChatRun: StartDetachedChatRunFn): Promise<'fired' | 'busy' | 'silent'> {
  const esc = entry.escalation!;
  if (await isChatBusyStrict(entry.chatId)) return 'busy';
  const orig = await prisma.crossModelMessage.findUnique({ where: { id: esc.ofMessageId }, select: { id: true, chatId: true, createdAt: true, metadata: true } });
  if (!orig || orig.chatId !== entry.chatId) return 'silent';
  const meta = asRecord(orig.metadata);
  const already = Array.isArray(meta.depth?.escalations) && meta.depth.escalations.some((e: any) => e?.rung === esc.rung && e?.status === 'done');
  const landed = await prisma.crossModelMessage.findFirst({ where: { chatId: entry.chatId, role: 'assistant', createdAt: { gt: new Date(entry.at) } }, orderBy: { createdAt: 'desc' }, select: { metadata: true } });
  if (already || (landed && asRecord(landed.metadata).escalationOf === esc.ofMessageId)) return 'silent';
  const question = await prisma.crossModelMessage.findFirst({ where: { chatId: entry.chatId, role: 'user', createdAt: { lte: orig.createdAt } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  const chat = await prisma.crossModelChat.findUnique({ where: { id: entry.chatId }, select: { userId: true, archivedAt: true } });
  const original = String(question?.content ?? '').trim();
  if (!original || !chat || chat.archivedAt) return 'silent';
  const key = await startDetachedChatRun({
    userId: chat.userId, chatId: entry.chatId, message: original,
    mode: esc.rung === 'research' ? 'deep_research' : 'thinking',
    escalation: { ofMessageId: esc.ofMessageId, rung: esc.rung },
    userTurnAt: new Date(entry.at),
  });
  if (!key) return 'busy';
  logger.info(`chat-deploy-requeue: re-fired deploy-interrupted Dig-deeper rung ${esc.rung} of ${esc.ofMessageId} in chat ${entry.chatId}`);
  return 'fired';
}

/**
 * A deploy-cut turn-continuation round (cohesive-chat wave 2026-09-28, review
 * fix 3): still owed iff the card on the original row still reads 'running'
 * for this task (a card settled meanwhile voids the entry). A human message
 * typed since the task started supersedes it (the card reads waiting_user
 * with the superseded line — the user's own turn owns the ask). Otherwise the
 * SAME round is re-enqueued through the chat's queue (source 'schedule' + the
 * continuation stash) and the queue drained; an enqueue failure settles the
 * card as failed so it never stays "running". Busy ⇒ the entry is kept for a
 * later pass. Mirrors handleEscalationRequeueEntry.
 */
async function handleContinuationRequeueEntry(entry: DeployRequeueEntry): Promise<'fired' | 'busy' | 'silent'> {
  const cont = entry.continuation!;
  const stash = cont.stash;
  const cr = await import('./continuation-recovery');
  if (await isChatBusyStrict(entry.chatId)) return 'busy';
  if (!(await cr.continuationCardOwed(entry.chatId, stash))) return 'silent';
  const chat = await prisma.crossModelChat.findUnique({ where: { id: entry.chatId }, select: { userId: true, archivedAt: true } });
  if (!chat || chat.archivedAt) return 'silent';
  // build 2026-10-08 A1: an answer-first follow-through (supervisor chat) is never dropped for a newer owner message.
  if (!stash.answerFirst) {
    const superseded = await cr.continuationSupersededByUser(entry.chatId, new Date(stash.startedAt));
    if (superseded) {
      const tc = await import('./turn-continuation');
      await cr.settleContinuationCard(entry.chatId, stash, 'waiting_user', tc.CONTINUATION_SUPERSEDED_LINE);
      logger.info(`chat-deploy-requeue: deploy-cut continuation round ${stash.round} of ${stash.taskId} in chat ${entry.chatId} superseded by a newer user message — card settled`);
      return 'silent';
    }
  }
  try {
    const mq = await import('./message-queue.service');
    await mq.enqueueChatMessage({ chatId: entry.chatId, userId: chat.userId, content: cont.prompt, mode: cont.mode, source: 'schedule', origin: { kind: 'schedule', continuation: stash } });
  } catch (err: any) {
    const tc = await import('./turn-continuation');
    await cr.settleContinuationCard(entry.chatId, stash, 'failed', tc.CONTINUATION_FAILED_LINE);
    logger.warn(`chat-deploy-requeue: continuation round ${stash.round} of ${stash.taskId} in chat ${entry.chatId} could not be re-queued (${err?.message ?? err}) — card settled as failed`);
    return 'silent';
  }
  const { drainChatQueue } = await import('./chat-agent.service');
  void drainChatQueue(entry.chatId, chat.userId).catch(() => {});
  logger.info(`chat-deploy-requeue: re-queued deploy-interrupted continuation round ${stash.round} of ${stash.taskId} in chat ${entry.chatId}`);
  return 'fired';
}

/** Latest crossmodel_messages row of a chat (id/role/metadata only). */
async function latestChatRow(chatId: string): Promise<{ id: string; role: string; metadata: unknown } | null> {
  return prisma.crossModelMessage.findFirst({
    where: { chatId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, role: true, metadata: true },
  });
}

/**
 * Load ONE user row into the OrphanedUserRow shape — the Rule-C and
 * requeue-drain re-fire paths feed it to the shared handler. Null when the
 * row is not an orphanable user row: missing, wrong role, archived chat, or
 * a coding chat (run-reaper owns those).
 */
async function loadOrphanableUserRow(id: string): Promise<OrphanedUserRow | null> {
  const rows = await prisma.$queryRaw<OrphanedUserRow[]>`
    SELECT m."id", m."chatId", m."content", m."metadata", m."createdAt",
           c."userId" AS "chatUserId", c."mode" AS "chatMode"
    FROM "crossmodel_messages" m
    JOIN "crossmodel_chats" c ON c."id" = m."chatId"
    WHERE m."id" = ${id}
      AND m."role" = 'user'
      AND c."archivedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "coding_sessions" cs WHERE cs."id" = m."chatId")
    LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * RULE C — the DB-row backstop for the deploy requeue (feedback 56159c5a). A
 * chat whose LATEST row is a deploy-interrupt assistant row older than the
 * requeue grace had its honest notice written but the requeue ENTRY never
 * landed (Redis hiccup mid-ritual) or every drainer died with its color.
 * Re-fire the referenced user row down the SAME shared path as Rule B — the
 * attempts budget rides the USER row's recovery marker, so a deploy storm
 * crash-looping the same turn still bounds at MAX_RECOVERY_ATTEMPTS before
 * the once-only escalation tells the owner.
 */
async function sweepDeployInterruptRows(): Promise<void> {
  const cutoff = new Date(Date.now() - REQUEUE_GRACE_MS());
  const rows = await prisma.$queryRaw<Array<{ id: string; chatId: string; metadata: unknown }>>`
    SELECT m."id", m."chatId", m."metadata"
    FROM "crossmodel_messages" m
    JOIN "crossmodel_chats" c ON c."id" = m."chatId"
    WHERE m."role" = 'assistant'
      AND m."metadata"->>'origin' = ${DEPLOY_INTERRUPT_ORIGIN}
      AND m."createdAt" < ${cutoff}
      AND c."archivedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "crossmodel_messages" newer
        WHERE newer."chatId" = m."chatId"
          AND (newer."createdAt" > m."createdAt"
               OR (newer."createdAt" = m."createdAt" AND newer."id" > m."id"))
      )
      AND NOT EXISTS (SELECT 1 FROM "coding_sessions" cs WHERE cs."id" = m."chatId")
    ORDER BY m."createdAt" ASC
    LIMIT ${INTERRUPT_BATCH}`;
  if (!rows.length) return;
  const { startDetachedChatRun } = await import('./chat-agent.service');
  for (const interruptRow of rows) {
    if (!isDeployInterruptMeta(interruptRow.metadata)) continue;
    const userMessageId = (interruptRow.metadata as Record<string, any>).interruptedMessageId as string;
    const row = await loadOrphanableUserRow(userMessageId);
    if (!row) continue;
    // FAIL-CLOSED like Rule B: a busy-probe error throws out of the pass.
    // The ritual's soft checkpoint rides the interrupt row's metadata too
    // (ticket 5ba5f03e) — forward it exactly like the drain path does.
    const resume = parseResumeBrief((interruptRow.metadata as Record<string, any>).resume);
    await handleOrphanedUserRow(row, startDetachedChatRun, resume);
  }
}

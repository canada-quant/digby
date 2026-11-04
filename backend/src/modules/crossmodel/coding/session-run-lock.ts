/**
 * Digby Code — CROSS-INSTANCE session run lock (blue-green safe).
 *
 * live-runs.ts is process-local: instance A's active run is invisible to instance
 * B, so B's HTTP /run or schedule sweeper could start a SECOND agent on the same
 * git worktree. This Redis lock is the cross-instance mutex: exactly one instance
 * anywhere holds a session's run at a time.
 *
 * It doubles as a LIVENESS signal for safe orphan-recovery: a session row left
 * status='running' by a crashed/redeployed instance has NO lock (it expired or the
 * holder died), so any instance can safely reset it to 'ready'. A genuinely-live
 * cross-instance run still holds the lock, so we must NOT false-orphan it.
 *
 * The holder REFRESHES the lock periodically (executeRun), so a long or ask_user-
 * blocked run keeps it; a crash lets it expire after LOCK_TTL_SEC.
 */

import * as os from 'os';
import redisClient from '../../../config/redis';

/**
 * Lazy logger (audit #8): utils/logger transitively loads config/env, and this
 * module is imported by leaf-ish modules (question/approval registries) whose
 * tests mock only redis — a top-level logger import would process.exit their
 * keyless jest workers at env validation. Awaited so callers observe the warn
 * deterministically; a logging failure never breaks the lock.
 */
async function warnLock(message: string): Promise<void> {
  try {
    const m = await import('../../../utils/logger');
    m.default.warn(message);
  } catch { /* logging must never break the lock */ }
}

const KEY = (sessionId: string) => `coding:session:run:${sessionId}`;
// Comfortably longer than the refresh interval (see executeRun, ~2.5 min) but
// short enough that a HARD crash (SIGKILL on deploy — no finally) only locks the
// session out briefly before the lock auto-expires and the run is recoverable.
export const LOCK_TTL_SEC = 6 * 60;

/**
 * Fencing owner token (audit #8): worker identity + the run it executes. The
 * worker segment mirrors worker.ts's `worker-<hostname>-<pid>`; the runId ties
 * the lock to ONE claimed row, so a zombie attempt of the same session (stale
 * lease, re-claimed elsewhere) can no longer refresh/release the new owner's
 * lock out from under it.
 */
export function runLockOwnerToken(runId: string): string {
  return `worker-${os.hostname()}-${process.pid}:${runId}`;
}

/** Legacy per-process token — callers that pass no ownerToken keep the old value. */
const defaultOwnerToken = () => String(process.pid);

/** Acquire the run lock for a session. Returns false if another instance holds it.
 *  The stored VALUE is the owner token — refresh/release are fenced against it. */
export async function acquireSessionRunLock(sessionId: string, ownerToken?: string): Promise<boolean> {
  const r = await redisClient.set(KEY(sessionId), ownerToken ?? defaultOwnerToken(), { NX: true, EX: LOCK_TTL_SEC }).catch(() => null);
  return r === 'OK';
}

/**
 * Extend the lock — HOLDER-ONLY (audit #8): the stored token must match the
 * caller's or the refresh is refused with a warn. GET-compare (the module's
 * plain-command best-effort style; the race window between GET and SET is a
 * heartbeat against a 6-min TTL). A MISSING key also refuses — the lock was
 * lost (expired mid-run); silently re-creating it here would let a paused
 * zombie steal the session back from whoever legitimately acquired it next.
 * TTL semantics unchanged (EX LOCK_TTL_SEC on the owner's refresh).
 */
export async function refreshSessionRunLock(sessionId: string, ownerToken?: string): Promise<void> {
  const token = ownerToken ?? defaultOwnerToken();
  const holder = await redisClient.get(KEY(sessionId)).catch(() => undefined);
  if (holder === undefined) return; // Redis hiccup — best-effort, same as before
  if (holder === null) {
    // MISSING key (autonomy loop #14, 2026-09-21): the lock was lost while the
    // run is still live — an allkeys-lru EVICTION (Redis at its 256 MB cap
    // evicted run locks; session 82656032 then ran THREE runs at once on one
    // worktree, 21:28–22:30Z) or a Redis restart (the 21:43Z box-A outage
    // flushed every lock). Re-acquire with NX: nobody holds it, so this is the
    // live owner re-establishing its own mutex — not a zombie steal (a zombie
    // whose session was legitimately re-acquired sees NX fail below and is
    // refused exactly as before).
    const r = await redisClient.set(KEY(sessionId), token, { NX: true, EX: LOCK_TTL_SEC }).catch(() => null);
    if (r === 'OK') {
      await warnLock(`session-run-lock: lock for session ${sessionId} was MISSING (evicted or Redis restarted) — re-acquired by its live owner ${token}`);
      void import('../platform/loop-metrics.service')
        .then((m) => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.RUN_LOCK_REACQUIRED, sessionId, meta: { owner: token.slice(0, 60) } }))
        .catch(() => {});
      return;
    }
    await warnLock(`session-run-lock: refresh refused for session ${sessionId} — lock not held and re-acquire lost the race; caller ${token} no-ops`);
    return;
  }
  if (holder !== token) {
    await warnLock(`session-run-lock: refresh refused for session ${sessionId} — held by another owner (${holder}); caller ${token} no-ops`);
    return;
  }
  await redisClient.set(KEY(sessionId), token, { EX: LOCK_TTL_SEC }).catch(() => {});
}

/**
 * Release the lock when the run ends — HOLDER-ONLY (audit #8): a non-owner
 * release warns and no-ops (deleting another worker's live lock re-opened the
 * two-runs-one-worktree hole this lock exists to close). Releasing an
 * already-expired lock (key gone) is a silent no-op — idempotent, nothing held.
 */
export async function releaseSessionRunLock(sessionId: string, ownerToken?: string): Promise<void> {
  const token = ownerToken ?? defaultOwnerToken();
  const holder = await redisClient.get(KEY(sessionId)).catch(() => undefined);
  if (holder === undefined || holder === null) return; // hiccup or already expired
  if (holder !== token) {
    await warnLock(`session-run-lock: release refused for session ${sessionId} — held by another owner (${holder}); caller ${token} no-ops`);
    return;
  }
  await redisClient.del(KEY(sessionId)).catch(() => {});
}

/** True if SOME instance currently holds this session's run lock (liveness check). */
export async function isSessionRunLocked(sessionId: string): Promise<boolean> {
  const n = await redisClient.exists(KEY(sessionId)).catch(() => 0);
  return Number(n) > 0;
}

/**
 * STRICT liveness check for the orphan sweep (Phase-3 review H1): Redis errors
 * PROPAGATE instead of catching to 0, so a Redis hiccup can't make an
 * actively-executing session look unlocked (the sweep fails CLOSED — it aborts
 * the whole pass rather than flipping live sessions to 'ready'). The fail-open
 * isSessionRunLocked above stays for its other call sites (SSE attach /
 * stopRun), where a hiccup degrades to a harmless honest close.
 */
export async function isSessionRunLockedStrict(sessionId: string): Promise<boolean> {
  const n = await redisClient.exists(KEY(sessionId));
  return Number(n) > 0;
}

/* ====================================================================
 * Phase 2 (worker tier) — CROSS-PROCESS cancel + steer channels.
 * The run executor lives in a WORKER process, so the web process can no
 * longer flip an in-memory flag / push into an in-memory queue: cancel and
 * steer ride Redis instead. Best-effort like the lock above (Redis hiccup
 * degrades to "cancel/steer missed this beat", never a thrown 500).
 * ==================================================================== */

import { ChatImage, MAX_IMAGES } from './chat-images';
import { SessionFilePayload, MAX_FILES } from './chat-files';
import { CANCEL_ACTOR_KEY, CANCEL_ACTOR_TTL_SEC, hookAlarmCauseAwareDisabled } from '../platform/alarm-cause';

const CANCEL_KEY = (sessionId: string) => `coding:session:cancel:${sessionId}`;
const STEER_KEY = (sessionId: string) => `coding:session:steer:${sessionId}`;
/** Matches the in-memory steer bound in live-runs.ts. */
const STEER_CAP = 20;

/**
 * Ask the worker to cancel this session's active run (worker polls the key).
 *
 * ALARM-CAUSE-AWARE (supervisor SOTA 2026-10-20, platform/alarm-cause.ts):
 * when a CHAT requests the stop (stop_run — `actorChatId` + the run it
 * targets), the requester is written to `cancel-actor:<runId>` (TTL 1 h); the
 * run finalize reads it back so the run_failed it emits names `cancelledBy`
 * and is not an alarm, and the requester itself is the hook actor (never woken
 * by its own stop). The owner's Stop button passes nothing — that stop stays
 * an alarm. Kill switch HOOK_ALARM_CAUSE_AWARE_DISABLED=1 writes no actor.
 */
export async function requestRunCancel(sessionId: string, opts?: { runId?: string | null; actorChatId?: string | null }): Promise<void> {
  await redisClient.set(CANCEL_KEY(sessionId), '1', { EX: 600 }).catch(() => {});
  const runId = typeof opts?.runId === 'string' ? opts.runId.trim() : '';
  const actor = typeof opts?.actorChatId === 'string' ? opts.actorChatId.trim() : '';
  if (runId && actor && !hookAlarmCauseAwareDisabled()) {
    await redisClient.set(CANCEL_ACTOR_KEY(runId), actor, { EX: CANCEL_ACTOR_TTL_SEC }).catch(() => {});
  }
}

/** The chat that requested this run's cancel (stop_run), or null (owner Stop button / none / Redis hiccup / switch off). Never throws. */
export async function readRunCancelActor(runId: string): Promise<string | null> {
  if (!runId || hookAlarmCauseAwareDisabled()) return null;
  const v = await redisClient.get(CANCEL_ACTOR_KEY(runId)).catch(() => null);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Worker-side cancel poll: true if a cancel was requested since the last poll.
 * Takes (GET then DEL) so one request cancels exactly one run.
 */
export async function takeRunCancelRequest(sessionId: string): Promise<boolean> {
  const key = CANCEL_KEY(sessionId);
  const v = await redisClient.get(key).catch(() => null);
  if (v == null) return false;
  await redisClient.del(key).catch(() => {});
  return true;
}

/** Queue a steer message for the session's active run (newest 20 kept).
 * `messageIds` (ticket fc7b2ca7): id(s) of user transcript row(s) that ALREADY
 * carry this payload's content — the controller persists a steer eagerly (so it
 * survives a reload) and pre-generates the row id so it can ride the mailbox.
 * The stranded-steer recovery forwards them as RunInput.existingUserMessageIds
 * so the recovered run's input persist ADOPTS that row instead of inserting a
 * second, byte-identical user row.
 * `origin` / `sourceChatId` (audit 2026-10-08 W2-9): WHO sent the steer — a
 * peer agent, a schedule firing, a result hook, a webhook; absent = the owner
 * typed it. The worker frames the injected text by it (steer-framing.ts)
 * instead of calling every steer "The user sent this". */
export type SteerOrigin = 'user' | 'schedule' | 'hook' | 'agent' | 'webhook';
export async function pushSteerMessage(sessionId: string, payload: { text: string; images?: ChatImage[]; files?: SessionFilePayload[]; messageIds?: string[]; origin?: SteerOrigin; sourceChatId?: string }): Promise<void> {
  const key = STEER_KEY(sessionId);
  await redisClient.rPush(key, JSON.stringify(payload)).catch(() => {});
  await redisClient.lTrim(key, -STEER_CAP, -1).catch(() => {});
}

/**
 * Worker-side steer drain (called once per top-level step, wired as the run's
 * injectSystem). Bounded LPOP loop (≤ STEER_CAP) with the SAME merge semantics
 * as live-runs.ts drainSteer: texts join '\n\n'; images concatenate, capped at
 * MAX_IMAGES with a drop note appended to the text; files (7f546b03)
 * concatenate the same way, capped at MAX_FILES. Empty → null.
 */
export async function drainSteerMessages(sessionId: string): Promise<{ text: string; images: ChatImage[]; files: SessionFilePayload[]; messageIds: string[]; entries: Array<{ text: string; origin?: SteerOrigin; sourceChatId?: string }> } | null> {
  const key = STEER_KEY(sessionId);
  const batch: Array<{ text?: string; images?: ChatImage[]; files?: SessionFilePayload[]; messageIds?: string[]; origin?: SteerOrigin; sourceChatId?: string }> = [];
  for (let i = 0; i < STEER_CAP; i++) {
    const raw = await redisClient.lPop(key).catch(() => null);
    if (raw == null) break;
    try {
      batch.push(JSON.parse(raw));
    } catch {
      // skip a malformed entry rather than poisoning the whole drain
    }
  }
  if (!batch.length) return null;
  const images = batch.flatMap(b => b.images ?? []);
  const files = batch.flatMap(b => b.files ?? []);
  // fc7b2ca7: concatenate the already-persisted user-row ids the same way —
  // the recovery forwards them so the follow-up run adopts those rows.
  const messageIds = batch.flatMap(b => Array.isArray(b.messageIds) ? b.messageIds : []);
  let text = batch.map(b => b.text ?? '').filter(Boolean).join('\n\n');
  // audit 2026-10-08 W2-9: the same texts, one entry per queued steer, with
  // the sender's origin — the worker frames each by who sent it. The cap
  // notes below ride the LAST entry (the merged `text` keeps them as before).
  const entries: Array<{ text: string; origin?: SteerOrigin; sourceChatId?: string }> = batch
    .filter(b => typeof b.text === 'string' && b.text)
    .map(b => ({
      text: b.text as string,
      ...(isSteerOrigin(b.origin) ? { origin: b.origin } : {}),
      ...(typeof b.sourceChatId === 'string' && b.sourceChatId ? { sourceChatId: b.sourceChatId } : {}),
    }));
  const capNotes: string[] = [];
  if (images.length > MAX_IMAGES) {
    const dropped = images.length - MAX_IMAGES;
    images.splice(MAX_IMAGES);
    capNotes.push(`[${dropped} attached image(s) dropped — a steer carries at most ${MAX_IMAGES}]`);
    text = `${text}${text ? '\n\n' : ''}[${dropped} attached image(s) dropped — a steer carries at most ${MAX_IMAGES}]`;
  }
  if (files.length > MAX_FILES) {
    const dropped = files.length - MAX_FILES;
    files.splice(MAX_FILES);
    capNotes.push(`[${dropped} attached file(s) dropped — a steer carries at most ${MAX_FILES}]`);
    text = `${text}${text ? '\n\n' : ''}[${dropped} attached file(s) dropped — a steer carries at most ${MAX_FILES}]`;
  }
  if (capNotes.length) {
    const note = capNotes.join('\n\n');
    if (entries.length) entries[entries.length - 1] = { ...entries[entries.length - 1], text: `${entries[entries.length - 1].text}\n\n${note}` };
    else entries.push({ text: note });
  }
  return { text, images, files, messageIds, entries };
}

const STEER_ORIGINS: ReadonlySet<string> = new Set(['user', 'schedule', 'hook', 'agent', 'webhook']);
function isSteerOrigin(v: unknown): v is SteerOrigin {
  return typeof v === 'string' && STEER_ORIGINS.has(v);
}

/* ====================================================================
 * Phase 2 LEG 2c — approval/question RESOLUTION transport (web → worker).
 *
 * The awaiting approval/question lives in the WORKER process (agent.ts →
 * awaitApproval/awaitAnswer), but the resolve endpoints run on the WEB
 * process — an in-memory registry there would never see the worker's
 * pendings. Two Redis pieces bridge the gap, mirroring the cancel/steer
 * channels above:
 *
 *   1. PENDING-PRESENCE keys — the worker SETs one when it starts awaiting
 *      and DELs it when the wait ends (resolve OR timeout). The web endpoint
 *      GETs it to learn the OWNING session (preserving the old registry
 *      ownership check + the unknown-id → success:false shape) — it never
 *      resolves anything itself.
 *   2. A per-session RESOLUTION MAILBOX (one list per session, like steer) —
 *      the web endpoint RPUSHes {kind, id, decision|answer}; the worker's
 *      2-s poll drains it and applies each entry to its process-local
 *      registry (unknown/expired ids are no-ops — a late click after the
 *      auto-deny does nothing, exactly as before).
 *
 * Best-effort like everything in this module: a Redis hiccup degrades to
 * "resolution missed this beat" (the client can retry), never a thrown 500.
 * ==================================================================== */

const APPROVAL_PENDING_KEY = (approvalId: string) => `coding:approval:pending:${approvalId}`;
const QUESTION_PENDING_KEY = (questionId: string) => `coding:question:pending:${questionId}`;
const RESOLVE_KEY = (sessionId: string) => `coding:session:resolve:${sessionId}`;
/** Bounded LPOP loop for the drain (same discipline as the steer drain). */
const RESOLVE_CAP = 20;
// Pending-key TTLs sit just ABOVE the registry timeouts (14-min auto-deny /
// 60-min question + 2-min answer grace) so a key never disappears while the
// worker still awaits.
const APPROVAL_PENDING_TTL_SEC = 900;
const QUESTION_PENDING_TTL_SEC = 3960;
/** Mailbox TTL — refreshed on every push; covers a dead-session list. */
const RESOLVE_TTL_SEC = 3600;

/**
 * Fleet supervisor (§3): a run parking on human input is the fleet's
 * 'attention_needed' signal. Emitted HERE, where the pending-presence keys are
 * SET, so every await path (approval or question) notifies exactly once.
 * Dynamic import + swallow: attention emission must never affect the wait.
 */
async function emitAttentionNeeded(sessionId: string, summary: string): Promise<void> {
  try {
    const mod: any = await import('../platform/hooks.service').catch(() => null);
    const clean = String(summary).replace(/\s+/g, ' ').trim().slice(0, 300);
    await mod?.emitHookEventSafe?.(sessionId, 'attention_needed', `Run needs input: ${clean}`);
  } catch {
    /* no-op — attention emission is best-effort */
  }
}

/** Mark an approval as awaiting (worker-side, on awaitApproval). */
export async function publishApprovalPending(approvalId: string, sessionId: string, attentionSummary?: string): Promise<void> {
  await redisClient.set(APPROVAL_PENDING_KEY(approvalId), sessionId, { EX: APPROVAL_PENDING_TTL_SEC }).catch(() => {});
  await emitAttentionNeeded(sessionId, attentionSummary ?? `approval ${approvalId}`);
}

/** The session a pending approval belongs to (web-side ownership check), or null. */
export async function getApprovalPendingSession(approvalId: string): Promise<string | null> {
  return redisClient.get(APPROVAL_PENDING_KEY(approvalId)).catch(() => null);
}

/** Clear the pending marker (worker-side, on resolve AND on timeout). */
export async function unpublishApprovalPending(approvalId: string): Promise<void> {
  await redisClient.del(APPROVAL_PENDING_KEY(approvalId)).catch(() => {});
}

/** Mark a question as awaiting (worker-side, on awaitAnswer). */
export async function publishQuestionPending(questionId: string, sessionId: string, attentionSummary?: string): Promise<void> {
  await redisClient.set(QUESTION_PENDING_KEY(questionId), sessionId, { EX: QUESTION_PENDING_TTL_SEC }).catch(() => {});
  await emitAttentionNeeded(sessionId, attentionSummary ?? `question ${questionId}`);
}

/**
 * Extend a question's pending presence into its answer-grace window (worker-side,
 * at the soft deadline). Value + ownership are unchanged — only the TTL moves so
 * the web resolve endpoint keeps finding the session while grace lasts. No
 * attention re-emit: the grace window is invisible to clients.
 */
export async function refreshQuestionPending(questionId: string, ttlSec: number): Promise<void> {
  await (redisClient as any).expire(QUESTION_PENDING_KEY(questionId), Math.max(1, Math.floor(ttlSec))).catch(() => {});
}

/** The session a pending question belongs to (web-side ownership check), or null. */
export async function getQuestionPendingSession(questionId: string): Promise<string | null> {
  return redisClient.get(QUESTION_PENDING_KEY(questionId)).catch(() => null);
}

/** Clear the pending marker (worker-side, on resolve AND on timeout). */
export async function unpublishQuestionPending(questionId: string): Promise<void> {
  await redisClient.del(QUESTION_PENDING_KEY(questionId)).catch(() => {});
}

/* ====================================================================
 * ATTENTION state (web-side reads) — "which sessions are blocked on a
 * human?" The pending-presence keys above are the live truth: the worker
 * SETs one while it awaits and DELs it on resolve/timeout, so a session
 * with a surviving key IS awaiting input right now. Keys are keyed by
 * approval/question id with the sessionId as the VALUE, so answering by
 * session costs one SCAN per pattern + one batched MGET — fine at this
 * fleet's scale (a handful of pendings at most). Best-effort like the
 * rest of this module: a Redis hiccup degrades to "nothing pending",
 * never a thrown 500 into a list/status endpoint.
 * ==================================================================== */

export interface SessionAttention {
  /** Ids of approvals (permission_requests) currently awaiting a decision. */
  approvals: string[];
  /** Ids of ask_user questions currently awaiting an answer. */
  questions: string[];
}

async function scanKeysMatching(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = 0;
  try {
    do {
      const res = await (redisClient as any).scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = Number(res?.cursor ?? 0);
      if (Array.isArray(res?.keys)) keys.push(...res.keys);
    } while (cursor !== 0);
  } catch {
    return [];
  }
  return keys;
}

/** Every session with ≥1 pending approval/question, mapped to the pending ids. */
export async function getPendingAttentionMap(): Promise<Map<string, SessionAttention>> {
  const map = new Map<string, SessionAttention>();
  try {
    const [approvalKeys, questionKeys] = await Promise.all([
      scanKeysMatching('coding:approval:pending:*'),
      scanKeysMatching('coding:question:pending:*'),
    ]);
    const fill = async (keys: string[], field: 'approvals' | 'questions') => {
      if (keys.length === 0) return;
      const values = await (redisClient as any).mGet(keys).catch(() => [] as unknown[]);
      keys.forEach((key, i) => {
        const sessionId = Array.isArray(values) ? values[i] : null;
        if (typeof sessionId !== 'string' || !sessionId) return;
        const entry = map.get(sessionId) ?? { approvals: [], questions: [] };
        entry[field].push(key.slice(key.lastIndexOf(':') + 1));
        map.set(sessionId, entry);
      });
    };
    await Promise.all([fill(approvalKeys, 'approvals'), fill(questionKeys, 'questions')]);
  } catch {
    /* best-effort — degrade to "nothing pending" */
  }
  return map;
}

/** Pending approvals/questions for ONE session (getChatStatus detail). */
export async function getSessionAttention(sessionId: string): Promise<SessionAttention> {
  const map = await getPendingAttentionMap();
  return map.get(sessionId) ?? { approvals: [], questions: [] };
}

export type ResolutionEntry =
  | { kind: 'approval'; id: string; decision: string }
  | { kind: 'question'; id: string; answer: string };

/** Queue an approval decision for the session's worker (web-side). */
export async function publishApprovalResolution(
  sessionId: string, approvalId: string, decision: 'allow' | 'always' | 'deny',
): Promise<void> {
  const key = RESOLVE_KEY(sessionId);
  await redisClient.rPush(key, JSON.stringify({ kind: 'approval', id: approvalId, decision })).catch(() => {});
  await redisClient.expire(key, RESOLVE_TTL_SEC).catch(() => {});
}

/** Queue an ask_user answer for the session's worker (web-side). */
export async function publishQuestionResolution(
  sessionId: string, questionId: string, answer: string,
): Promise<void> {
  const key = RESOLVE_KEY(sessionId);
  await redisClient.rPush(key, JSON.stringify({ kind: 'question', id: questionId, answer })).catch(() => {});
  await redisClient.expire(key, RESOLVE_TTL_SEC).catch(() => {});
}

/**
 * Worker-side resolution drain (the run executor's poll calls this each tick).
 * Bounded LPOP loop (≤ RESOLVE_CAP), FIFO; malformed entries are skipped rather
 * than poisoning the drain. Applying an entry to a registry whose id is
 * unknown/expired is a no-op — a late click after the auto-deny resolves nothing.
 */
export async function drainResolutions(sessionId: string): Promise<ResolutionEntry[]> {
  const key = RESOLVE_KEY(sessionId);
  const out: ResolutionEntry[] = [];
  for (let i = 0; i < RESOLVE_CAP; i++) {
    const raw = await redisClient.lPop(key).catch(() => null);
    if (raw == null) break;
    try {
      const parsed = JSON.parse(raw);
      if ((parsed?.kind === 'approval' && typeof parsed.id === 'string' && typeof parsed.decision === 'string')
        || (parsed?.kind === 'question' && typeof parsed.id === 'string' && typeof parsed.answer === 'string')) {
        out.push(parsed);
      }
      // wrong shape → skipped below like a parse failure
    } catch {
      // skip a malformed entry rather than poisoning the whole drain
    }
  }
  return out;
}

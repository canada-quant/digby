/**
 * MERGE-INTENT-AWAIT (supervisor SOTA round 3, 2026-10-20) — the side-effect
 * half of the harness-owned merge wait (the pure half + the WHY is
 * merge-intent.ts):
 *
 *   - registerMergeIntent — the tool layer (tools.ts merge_pull_request) calls
 *     it on a TIMING-class gate failure instead of handing a retry back;
 *   - clearMergeIntent — the tool merged the PR itself (or found it merged):
 *     it clears ONLY the calling chat's own intent (another chat's holder is
 *     woken by the cron with the outcome — never deleted from under it);
 *   - runHarnessWaitsOnce — the worker cron MERGE_INTENT_JOB_ID (every 2 min):
 *     the merge-intent pass, then the await_condition wake pass
 *     (await-condition.ts runConditionWakesPass), sharing the lane facts and
 *     the per-pass GitHub token cache.
 *
 * Registration enqueues a BACKSTOP one-shot on the lane at
 * MERGE_INTENT_BACKSTOP_MS FIRST (the lane is never stranded — the cron off,
 * down or failing to wake still ends in a wake); every outcome wake suppresses
 * it. A NEW head queued by ANOTHER chat hands the intent over: the old holder
 * gets a superseded BLOCKED wake first.
 *
 * The merge-intent pass, per due intent (oldest due first, ≤ MERGE_INTENT_MAX_PER_PASS;
 * undelivered outcome wakes have their own budget):
 *   1. the lane gone / archived, or the run that QUEUED the intent explicitly
 *      STOPPED ⇒ the intent is dropped with NO wake (stop means stop — a stop
 *      of a later, unrelated run does not abandon the merge);
 *   2. expired (MERGE_INTENT_TTL_MS from the first queue) ⇒ BLOCKED 'expired';
 *      the isolation boundary drops it, a human-set self-merge OFF closes it
 *      (OFF wakes the lane);
 *   3. ONE PR read: merged by someone else ⇒ MERGED (already); closed ⇒
 *      BLOCKED 'closed'; a new head ⇒ adopted when it is the update-branch
 *      merge commit the harness asked for, else BLOCKED 'superseded';
 *   4. ONE check-runs read on the head: a finished RED check ⇒ BLOCKED at
 *      once; anything still running ⇒ wait; a BEHIND branch is updated only
 *      on a head with no legacy status red and no lane run queued / running
 *      (r3 interactions fix — else held);
 *   5. the FULL gate engine (evaluateMergeGates) on that exact head: a timing
 *      class ⇒ wait, backing off exponentially while it repeats (a BEHIND
 *      branch gets its update-branch here too); a CI dispatch gap ⇒ two passes
 *      of grace, then BLOCKED with the gate's fix; any other failure ⇒
 *      BLOCKED with the gate's cause / evidence / fix; green ⇒
 *      the merge PUT pinned to the head, a follow-up GET confirms merged:true,
 *      then the merge receipt is minted on the lane chat (runId null,
 *      ids.harnessMerge), merge_success is recorded (meta.via
 *      'merge_intent'), the head branch is cleaned up, and the lane gets ONE
 *      [MERGE INTENT — MERGED …] wake.
 * A wake that cannot be queued keeps the row (pendingWake) and is retried (≤
 * MERGE_INTENT_PENDING_WAKE_TTL_MS; a gone / archived lane drops it) — the
 * merge result is never lost while the lane exists. Never throws.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { repoTargetAllowed } from '../platform/instance-targets';
import { classifyGithubError, isExplicitStop, noteHarnessRedWake } from './ci-watch.service';
import type { GithubApi, GateFailure, GatePass, MergeGate, SelfMergePolicy } from './self-merge.service';
import {
  MERGE_INTENT_NS, MERGE_INTENT_LIST_CAP, MERGE_INTENT_MAX_OPEN_PER_CHAT, MERGE_INTENT_MAX_PER_PASS,
  MERGE_INTENT_INTERVAL_SEC, MERGE_INTENT_MAX_ERRORS, MERGE_INTENT_ERROR_RETRY_MS, MERGE_INTENT_TTL_MS,
  MERGE_INTENT_BACKSTOP_MS, MERGE_INTENT_PENDING_WAKE_TTL_MS, MERGE_INTENT_DISPATCH_GAP_MAX_PASSES,
  mergeIntentQueueDisabled, selfMergeAutoUpdateBranchDisabled, intentKey, newIntent, intentDue, intentExpired, classifyHeadMove, orderDueIntents,
  mergeIntentGateBackoffMs, sameSha,
  renderMergedWake, renderBlockedWake, renderMergeBackstopWake,
  type MergeIntentRecord, type MergeIntentWaitKind, type MergeIntentOutcome,
} from './merge-intent';
import {
  runConditionWakesPass, stoppedSince, conditionWakeKey, suppressBackstop, awaitConditionDisabled, defaultConditionWakeStore,
  CONDITION_WAKE_LIST_CAP,
  type LaneFacts, type ConditionPassDeps, type ConditionPassCounters, type DirectWake, type ConditionWakeStore, type RedWakeBooker,
} from './await-condition';

/** A stored intent may carry a wake that could not be queued yet (retried every pass; `since` = the first failure). */
export type StoredMergeIntent = MergeIntentRecord & {
  pendingWake?: { prompt: string; outcome: MergeIntentOutcome; meta?: Record<string, unknown>; since?: string } | null;
  /** The merge PUT was sent at this instant — a later "merged" read is the harness's own merge, never "someone else". */
  mergePutAt?: string | null;
};

export interface MergeIntentStore {
  get(key: string): Promise<StoredMergeIntent | null>;
  put(key: string, rec: StoredMergeIntent): Promise<void>;
  del(key: string): Promise<void>;
  list(limit: number): Promise<StoredMergeIntent[]>;
}

export async function defaultMergeIntentStore(): Promise<MergeIntentStore> {
  const cs = await import('../memory/context-store');
  return {
    get: (key) => cs.storeGet<StoredMergeIntent>(MERGE_INTENT_NS, key),
    put: (key, rec) => cs.storePut(MERGE_INTENT_NS, key, rec as unknown as Record<string, unknown>),
    del: (key) => cs.storeDelete(MERGE_INTENT_NS, key),
    list: async (limit) => (await cs.storeListNamespace<StoredMergeIntent>(MERGE_INTENT_NS, limit)).map((r) => r.value).filter((v) => v && typeof v === 'object' && (v as any).v === 1),
  };
}

const defaultWake: DirectWake = async (o) => (await import('../platform/hooks.service')).enqueueDirectWake(o);
type Suppress = (hookEventId: string | null | undefined, reason: string) => Promise<boolean>;

/**
 * Did the run that QUEUED the intent get explicitly stopped? Review fix
 * (2026-10-20): only that run's stop drops the intent silently — a stop of a
 * later, unrelated run (a supervisor halting a drift) no longer abandons a
 * merge the lane was told the harness owns. A row without a run id (or lane
 * facts without one) keeps the older rule: any explicit stop after the queue.
 * Pure.
 */
export function queuingRunStopped(lane: LaneFacts, rec: Pick<MergeIntentRecord, 'runId' | 'createdAt'>): boolean {
  if (rec.runId && lane.lastRun?.id) return lane.lastRun.id === rec.runId && isExplicitStop(lane.lastRun);
  return stoppedSince(lane, rec.createdAt);
}

const metric = (rec: Pick<MergeIntentRecord, 'chatId' | 'owner' | 'repo' | 'pullNumber' | 'headSha'> & { runId?: string | null }, phase: string, extra: Record<string, unknown> = {}): void => {
  recordLoopMetric({
    kind: LOOP_METRIC_KINDS.MERGE_INTENT,
    sessionId: rec.chatId,
    ...(rec.runId ? { runId: rec.runId } : {}),
    meta: { phase, repo: `${rec.owner}/${rec.repo}`, pullNumber: rec.pullNumber, headSha: rec.headSha, ...extra },
  });
};

// ── registration (tool layer) ────────────────────────────────────────────────

export type RegisterMergeIntentResult =
  | { ok: true; record: MergeIntentRecord; refreshed: boolean; heldByOtherChat: string | null }
  | { ok: false; reason: 'disabled' | 'cap' | 'invalid' | 'store_error' | 'backstop_failed' | 'pending_wake' | 'handoff_failed'; error?: string };

const wakeErr = (err: any) => ({ ok: false, error: String(err?.message ?? err) } as { ok: boolean; hookEventId?: string; error?: string });

/**
 * Queue (or refresh) the merge intent for a PR. Same PR + same head already
 * queued by another chat ⇒ that chat keeps it (it is the one woken). A NEW
 * head replaces the row — when ANOTHER chat held it, that holder first gets a
 * superseded BLOCKED wake (review fix 2026-10-20: never replaced silently). A
 * row still carrying an undelivered outcome wake is delivered before anything
 * replaces it. A new row enqueues its BACKSTOP one-shot first (no backstop ⇒
 * nothing stored). Every refusal leaves the caller to bounce as before. Never
 * throws.
 */
export async function registerMergeIntent(i: {
  owner: string; repo: string; pullNumber: number; headSha: string;
  chatId: string; userId: string; projectId?: string | null; runId?: string | null;
  mergeMethod?: string; waitKind: MergeIntentWaitKind; gate?: MergeGate | null; cause?: string | null;
  updateBranchFrom?: string | null; updateBranchAt?: Date | null;
}, deps: { store?: MergeIntentStore; now?: Date; wake?: DirectWake; suppress?: Suppress } = {}): Promise<RegisterMergeIntentResult> {
  if (mergeIntentQueueDisabled()) return { ok: false, reason: 'disabled' };
  if (!i.owner || !i.repo || !Number.isInteger(i.pullNumber) || i.pullNumber <= 0 || !/^[0-9a-f]{7,40}$/i.test(String(i.headSha)) || !i.chatId) {
    return { ok: false, reason: 'invalid' };
  }
  const now = deps.now ?? new Date();
  const wake = deps.wake ?? defaultWake;
  const suppress: Suppress = deps.suppress ?? suppressBackstop;
  const slug = `${i.owner}/${i.repo}`;
  // An update-branch is recorded only for the head it was asked on (the intent's own head).
  const updateBranchFrom = i.updateBranchFrom && sameSha(i.updateBranchFrom, i.headSha) ? i.updateBranchFrom : null;
  try {
    const store = deps.store ?? await defaultMergeIntentStore();
    const key = intentKey(i.owner, i.repo, i.pullNumber);
    let existing = await store.get(key);
    if (existing && existing.v !== 1) existing = null;
    // An outcome wake still owed to the old holder: deliver it first — never lost to a replace.
    if (existing?.pendingWake) {
      const pw = existing.pendingWake;
      const res = await wake({ targetChatId: existing.chatId, prompt: pw.prompt, meta: pw.meta }).catch(wakeErr);
      if (!res?.ok) return { ok: false, reason: 'pending_wake', error: res?.error };
      await suppress(existing.backstopHookEventId ?? null, `merge_intent_${pw.outcome}`).catch(() => false);
      await store.del(key).catch(() => {});
      metric(existing, pw.outcome, { retriedWake: true, via: 'register' });
      existing = null;
    }
    if (existing && sameSha(existing.headSha, i.headSha)) {
      let backstopHookEventId = existing.backstopHookEventId ?? null;
      if (!backstopHookEventId) {
        // A row without a backstop (written before backstops existed) gains one — best-effort.
        const horizon = new Date((Date.parse(existing.createdAt) || now.getTime()) + MERGE_INTENT_BACKSTOP_MS);
        const b = await wake({
          targetChatId: existing.chatId,
          prompt: renderMergeBackstopWake({ slug, pullNumber: i.pullNumber, headSha: existing.headSha }, new Date(Date.parse(existing.createdAt) || now.getTime()), horizon),
          meta: { origin: 'merge-intent', wakeKind: 'merge_intent_backstop', mergeIntent: { repo: slug, pullNumber: i.pullNumber, headSha: existing.headSha } },
          notBefore: horizon,
        }).catch(wakeErr);
        if (b?.ok) backstopHookEventId = b.hookEventId ?? null;
      }
      const refreshed: StoredMergeIntent = {
        ...existing,
        updatedAt: now.toISOString(),
        waitKind: i.waitKind,
        lastGate: i.gate ?? existing.lastGate,
        lastCause: i.cause ? String(i.cause).slice(0, 200) : existing.lastCause,
        backstopHookEventId,
        ...(updateBranchFrom ? { updateBranchFrom, updateBranchAt: (i.updateBranchAt ?? now).toISOString() } : {}),
      };
      await store.put(key, refreshed);
      metric(refreshed, 'refreshed', { waitKind: i.waitKind, by: i.chatId, holder: existing.chatId });
      return { ok: true, record: refreshed, refreshed: true, heldByOtherChat: existing.chatId !== i.chatId ? existing.chatId : null };
    }
    if (!existing || existing.chatId !== i.chatId) {
      try {
        const open = (await store.list(MERGE_INTENT_LIST_CAP)).filter((r) => r.chatId === i.chatId && !r.pendingWake);
        if (open.length >= MERGE_INTENT_MAX_OPEN_PER_CHAT) {
          metric({ ...i }, 'cap', { open: open.length });
          return { ok: false, reason: 'cap' };
        }
      } catch { /* the cap is best-effort — an unreadable listing never blocks a queue */ }
    }
    // The backstop FIRST: a merge intent with no backstop is never stored.
    const horizon = new Date(now.getTime() + MERGE_INTENT_BACKSTOP_MS);
    const backstop = await wake({
      targetChatId: i.chatId,
      prompt: renderMergeBackstopWake({ slug, pullNumber: i.pullNumber, headSha: i.headSha }, now, horizon),
      meta: { origin: 'merge-intent', wakeKind: 'merge_intent_backstop', mergeIntent: { repo: slug, pullNumber: i.pullNumber, headSha: i.headSha } },
      notBefore: horizon,
    }).catch(wakeErr);
    if (!backstop?.ok) {
      metric({ ...i }, 'register_failed', { reason: 'backstop_failed', error: String(backstop?.error ?? '').slice(0, 120) });
      return { ok: false, reason: 'backstop_failed', error: backstop?.error };
    }
    // Another chat held the PR on an older head: hand over — that holder is told
    // first (it was promised a wake). A failed hand-over wake keeps the holder's
    // own backstop armed (it is never stranded); with no backstop to fall back
    // on, the caller bounces instead.
    let keepOldBackstop = false;
    if (existing && existing.chatId !== i.chatId) {
      const res = await wake({
        targetChatId: existing.chatId,
        prompt: renderBlockedWake(existing, { outcome: 'superseded', newHead: i.headSha, requeuedByChat: i.chatId }),
        meta: { origin: 'merge-intent', wakeKind: 'merge_intent', mergeIntent: { outcome: 'superseded', repo: slug, pullNumber: i.pullNumber, headSha: existing.headSha } },
      }).catch(wakeErr);
      if (res?.ok) {
        metric(existing, 'superseded', { requeuedBy: i.chatId, newHead: i.headSha, hookEventId: res.hookEventId ?? null });
      } else if (existing.backstopHookEventId) {
        keepOldBackstop = true;
        metric(existing, 'wake_failed', { outcome: 'superseded', requeuedBy: i.chatId, error: String(res?.error ?? 'error').slice(0, 120) });
      } else {
        await suppress(backstop.hookEventId ?? null, 'merge_intent_register_failed').catch(() => false);
        return { ok: false, reason: 'handoff_failed', error: res?.error };
      }
    }
    const rec = newIntent({ ...i, updateBranchFrom, updateBranchAt: i.updateBranchAt ?? null, backstopHookEventId: backstop.hookEventId ?? null }, now);
    try {
      await store.put(key, rec);
    } catch (err) {
      await suppress(backstop.hookEventId ?? null, 'merge_intent_register_failed').catch(() => false);
      throw err;
    }
    if (existing && !keepOldBackstop) await suppress(existing.backstopHookEventId ?? null, 'merge_intent_replaced').catch(() => false);
    metric(rec, 'queued', { waitKind: i.waitKind, gate: i.gate ?? null, updateBranch: !!updateBranchFrom, ...(existing ? { replacedHead: existing.headSha, replacedChat: existing.chatId } : {}) });
    return { ok: true, record: rec, refreshed: false, heldByOtherChat: null };
  } catch (err: any) {
    return { ok: false, reason: 'store_error', error: String(err?.message ?? err).slice(0, 160) };
  }
}

/**
 * The tool merged the PR itself / found it merged — the CALLING chat's intent
 * (if any) is done. Review fix (2026-10-20): another chat's intent is never
 * deleted from under it (it was told the harness wakes it) — its next check is
 * pulled forward instead, so the cron reads the PR merged and wakes that holder
 * with the outcome. Never throws.
 */
export async function clearMergeIntent(owner: string, repo: string, pullNumber: number, chatId: string, why: string, deps: { store?: MergeIntentStore; now?: Date; suppress?: Suppress } = {}): Promise<boolean> {
  if (mergeIntentQueueDisabled()) return false;
  try {
    const store = deps.store ?? await defaultMergeIntentStore();
    const key = intentKey(owner, repo, pullNumber);
    const existing = await store.get(key);
    if (!existing || existing.pendingWake) return false;
    if (existing.chatId !== chatId) {
      await store.put(key, { ...existing, nextCheckAt: (deps.now ?? new Date()).toISOString() }).catch(() => {});
      metric(existing, 'clear_deferred', { why, by: chatId });
      return false;
    }
    await store.del(key);
    await (deps.suppress ?? suppressBackstop)(existing.backstopHookEventId ?? null, `merge_intent_cleared:${why}`).catch(() => false);
    metric(existing, 'cleared', { why });
    return true;
  } catch {
    return false;
  }
}

/**
 * r3 interactions fix (2026-10-20) — ci-watch route(): does an open merge
 * intent (or a registered await_condition 'ci' wake) of THIS lane on THIS sha
 * owe the lane its wake about the sha's CI? Then ci-watch adds none (one wake
 * per red sha per lane). A wait the cron does not work (its kill switch, or
 * SELF_MERGE_DISABLED for intents) covers nothing; any read error ⇒ false
 * (ci-watch wakes — fail toward delivery). Never throws.
 */
export async function harnessWaitCoversSha(chatId: string, sha: string, deps: { store?: MergeIntentStore; conditionStore?: ConditionWakeStore; selfMergeDisabled?: () => boolean } = {}): Promise<boolean> {
  try {
    const selfMergeOff = deps.selfMergeDisabled ?? (await import('./self-merge.service')).selfMergeDisabled;
    if (!mergeIntentQueueDisabled() && !selfMergeOff()) {
      const store = deps.store ?? await defaultMergeIntentStore();
      if ((await store.list(MERGE_INTENT_LIST_CAP)).some((r) => r.chatId === chatId && sameSha(r.headSha, sha))) return true;
    }
    if (!awaitConditionDisabled()) {
      const cstore = deps.conditionStore ?? await defaultConditionWakeStore();
      if ((await cstore.list(CONDITION_WAKE_LIST_CAP)).some((r) => r.chatId === chatId && r.spec?.kind === 'ci' && sameSha(r.spec.sha, sha))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── the cron pass ────────────────────────────────────────────────────────────

export interface HarnessWaitsDeps {
  now?: Date;
  store?: MergeIntentStore;
  loadLane?: (chatId: string) => Promise<LaneFacts | null>;
  getToken?: (userId: string, label: string | null) => Promise<string | null>;
  makeApi?: (token: string) => GithubApi;
  evaluateGates?: (o: { api: GithubApi; owner: string; repo: string; pullNumber: number; sessionId: string; allowUpdateBranch?: boolean }) => Promise<GateFailure | GatePass>;
  /** Book a red-CI outcome wake with ci-watch (default ci-watch noteHarnessRedWake): 'loop' ⇒ do not wake the lane. */
  noteRedWake?: RedWakeBooker;
  resolvePolicy?: (o: { repo: string; projectId?: string | null; userId: string }) => Promise<SelfMergePolicy>;
  selfMergeDisabled?: () => boolean;
  wake?: DirectWake;
  /** Suppress a pending backstop one-shot (default await-condition suppressBackstop). */
  suppress?: Suppress;
  /** Mint the merge receipt on the lane chat; returns its id (null when not minted). */
  mintReceipt?: (rec: MergeIntentRecord, resultText: string) => Promise<string | null>;
  /** Post-merge housekeeping (attempt record, learnings, head-branch cleanup). Best-effort. */
  afterMerge?: (rec: MergeIntentRecord, api: GithubApi, confirmedPr: any, mergeSha: string) => Promise<void>;
  recordLearning?: (projectId: string | null, line: string) => Promise<void>;
  /** The await_condition pass (overridable in tests; default runConditionWakesPass). */
  conditionPass?: (d: ConditionPassDeps) => Promise<ConditionPassCounters>;
  maxPerPass?: number;
}

export interface MergeIntentCounters { open: number; checked: number; merged: number; blocked: number; waiting: number; dropped: number; errors: number; updateBranch: number; adopted: number; rateLimited: number; skipped: string | null }

/** The lane facts both passes read: owner, archive state, the project's GitHub label, the newest run. Throws on a DB error. */
export async function loadLaneFactsDefault(chatId: string): Promise<LaneFacts | null> {
  const c = await prisma.crossModelChat.findUnique({
    where: { id: chatId },
    select: { userId: true, archivedAt: true, codingState: { select: { status: true, project: { select: { githubLabel: true } } } } },
  });
  if (!c) return null;
  const cs = (c as any).codingState ?? null;
  const last = await prisma.agentRun.findFirst({
    where: { sessionId: chatId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, error: true, finishedAt: true, updatedAt: true },
  });
  return {
    userId: c.userId,
    archived: !!(c as any).archivedAt || cs?.status === 'archived',
    githubLabel: cs?.project?.githubLabel ?? null,
    lastRun: last ? { id: last.id ?? null, status: last.status ?? null, error: last.error ?? null, at: last.finishedAt ?? last.updatedAt ?? null } : null,
  };
}

async function mintMergeReceiptDefault(rec: MergeIntentRecord, resultText: string): Promise<string | null> {
  try {
    const { extractReceipt } = await import('./run-receipts');
    const { recordRunReceiptAsync } = await import('./run-receipts.service');
    const { randomUUID } = await import('crypto');
    const draft = extractReceipt('merge_pull_request', { pullNumber: rec.pullNumber, repo: `${rec.owner}/${rec.repo}`, mergeMethod: rec.mergeMethod }, resultText, new Date());
    if (!draft) return null;
    const id = randomUUID();
    recordRunReceiptAsync({ ...draft, id, chatId: rec.chatId, runId: null, ids: { ...draft.ids, harnessMerge: true, mergeIntent: rec.key } } as any);
    return id;
  } catch (err: any) {
    logger.warn(`merge-intent: merge receipt for ${rec.key} not recorded: ${err?.message ?? err}`);
    return null;
  }
}

async function afterMergeDefault(rec: MergeIntentRecord, api: GithubApi, confirmedPr: any, _mergeSha: string): Promise<void> {
  const sm = await import('./self-merge.service');
  const slug = `${rec.owner}/${rec.repo}`;
  await sm.clearAttempt(rec.chatId, slug, rec.pullNumber).catch(() => {});
  if (rec.lastGate) {
    await sm.recordMergeLearning(rec.projectId, `PR ${slug}#${rec.pullNumber} MERGED by the harness merge intent after ${rec.lastGate} waits (${rec.checks} re-checks).`).catch(() => {});
  }
  await sm.deleteMergedHeadBranch({ api, owner: rec.owner, repo: rec.repo, pr: confirmedPr }).catch(() => null);
}

const SUMMARY_MAX = 200;
/** After an update-branch request, a head still BEHIND is waited on (not re-gated / re-requested) this long. */
export const UPDATE_BRANCH_SETTLE_MS = 10 * 60 * 1000;
/** A finished check-run with any other conclusion is RED (the G2 gate's own rule). */
const CI_OK_CONCLUSIONS = ['success', 'neutral', 'skipped'];
const RED_CI_FIX = 'read the failing checks, fix, push to the PR branch, and retry once CI is green';

/** Compose the ≤200-char cron_jobs.lastStatus line. Pure. */
export function renderHarnessWaitsSummary(m: MergeIntentCounters, w: ConditionPassCounters | null): string {
  const parts: string[] = [];
  parts.push(m.skipped
    ? `intents: ${m.skipped}`
    : `intents ${m.open} open, ${m.checked} checked, ${m.merged} merged, ${m.blocked} blocked, ${m.waiting} waiting${m.updateBranch ? `, ${m.updateBranch} update-branch` : ''}${m.adopted ? `, ${m.adopted} adopted` : ''}${m.dropped ? `, ${m.dropped} dropped` : ''}${m.errors ? `, ${m.errors} errors` : ''}${m.rateLimited ? `, ${m.rateLimited} rate-limited` : ''}`);
  if (w) parts.push(`waits ${w.open} open, ${w.met} met, ${w.waiting} waiting${w.dropped ? `, ${w.dropped} dropped` : ''}${w.errors ? `, ${w.errors} errors` : ''}`);
  return parts.join('; ').slice(0, SUMMARY_MAX);
}

/**
 * The worker cron pass: merge intents, then condition wakes. Returns the
 * ≤200-char summary for cron_jobs.lastStatus. Never throws.
 */
export async function runHarnessWaitsOnce(deps: HarnessWaitsDeps = {}): Promise<string> {
  const now = deps.now ?? new Date();
  const loadLane = deps.loadLane ?? loadLaneFactsDefault;
  const tokenCache = new Map<string, Promise<string | null>>();
  const getTokenRaw = deps.getToken ?? (async (userId: string, label: string | null) => (await import('../github/token-manager')).getValidToken(userId, label || undefined));
  const getToken = (userId: string, label: string | null): Promise<string | null> => {
    const k = `${userId}|${label ?? ''}`;
    if (!tokenCache.has(k)) tokenCache.set(k, getTokenRaw(userId, label).catch(() => null));
    return tokenCache.get(k)!;
  };
  const covered = new Set<string>();
  let m: MergeIntentCounters = { open: 0, checked: 0, merged: 0, blocked: 0, waiting: 0, dropped: 0, errors: 0, updateBranch: 0, adopted: 0, rateLimited: 0, skipped: null };
  try {
    m = await runMergeIntentPass({ ...deps, now, loadLane, getToken }, covered);
  } catch (err: any) {
    m.skipped = `error ${String(err?.message ?? err).slice(0, 60)}`;
    logger.warn(`merge-intent: pass failed (next pass retries): ${err?.message ?? err}`);
  }
  let w: ConditionPassCounters | null = null;
  try {
    const pass = deps.conditionPass ?? runConditionWakesPass;
    w = await pass({ now, loadLane, getToken, covered, ...(deps.wake ? { wake: deps.wake } : {}), ...(deps.noteRedWake ? { noteRedWake: deps.noteRedWake } : {}) });
  } catch (err: any) {
    logger.warn(`await-condition: pass failed (next pass retries): ${err?.message ?? err}`);
  }
  return renderHarnessWaitsSummary(m, w);
}

async function runMergeIntentPass(
  deps: HarnessWaitsDeps & { now: Date; loadLane: (chatId: string) => Promise<LaneFacts | null>; getToken: (userId: string, label: string | null) => Promise<string | null> },
  covered: Set<string>,
): Promise<MergeIntentCounters> {
  const c: MergeIntentCounters = { open: 0, checked: 0, merged: 0, blocked: 0, waiting: 0, dropped: 0, errors: 0, updateBranch: 0, adopted: 0, rateLimited: 0, skipped: null };
  if (mergeIntentQueueDisabled()) { c.skipped = 'disabled'; return c; }
  const sm = await import('./self-merge.service');
  const selfMergeOff = deps.selfMergeDisabled ?? sm.selfMergeDisabled;
  if (selfMergeOff()) { c.skipped = 'self-merge disabled (intents kept)'; return c; }
  const now = deps.now;
  const store = deps.store ?? await defaultMergeIntentStore();
  const rows = await store.list(MERGE_INTENT_LIST_CAP);
  c.open = rows.length;
  const makeApi = deps.makeApi ?? sm.defaultGithubApi;
  const evaluateGates = deps.evaluateGates ?? sm.evaluateMergeGates;
  const resolvePolicy = deps.resolvePolicy ?? sm.resolveSelfMergePolicy;
  const wake: DirectWake = deps.wake ?? defaultWake;
  const suppress: Suppress = deps.suppress ?? suppressBackstop;
  const mintReceipt = deps.mintReceipt ?? mintMergeReceiptDefault;
  const afterMerge = deps.afterMerge ?? afterMergeDefault;
  const recordLearning = deps.recordLearning ?? sm.recordMergeLearning;
  const noteRedWake: RedWakeBooker = deps.noteRedWake ?? ((i) => noteHarnessRedWake(i, { now }));
  const nextCheck = (ms: number = MERGE_INTENT_INTERVAL_SEC * 1000) => new Date(now.getTime() + ms).toISOString();

  const prKey = (rec: StoredMergeIntent) => conditionWakeKey(rec.chatId, { kind: 'pr_merged', owner: rec.owner, repo: rec.repo, pullNumber: rec.pullNumber });
  /** The outcome wake is QUEUED: the backstop stands down, the row goes, a pr_merged wait of the lane is covered. */
  const settled = async (rec: StoredMergeIntent, outcome: MergeIntentOutcome) => {
    covered.add(prKey(rec)); // only once a wake really is queued (a failed one covers nothing)
    await suppress(rec.backstopHookEventId ?? null, `merge_intent_${outcome}`).catch(() => false);
    await store.del(rec.key).catch(() => {});
  };
  /** Queue the lane's wake; on failure the row is kept with pendingWake (retried). Returns true when queued. */
  const deliver = async (rec: StoredMergeIntent, outcome: MergeIntentOutcome, prompt: string, extraMeta: Record<string, unknown> = {}): Promise<boolean> => {
    const meta = { origin: 'merge-intent', wakeKind: 'merge_intent', mergeIntent: { outcome, repo: `${rec.owner}/${rec.repo}`, pullNumber: rec.pullNumber, headSha: rec.headSha }, ...extraMeta };
    const res = await wake({ targetChatId: rec.chatId, prompt, meta }).catch(wakeErr);
    if (res?.ok) {
      await settled(rec, outcome);
      metric(rec, outcome, { waitedMs: now.getTime() - (Date.parse(rec.createdAt) || now.getTime()), checks: rec.checks, hookEventId: res.hookEventId ?? null, ...extraMeta });
      return true;
    }
    await store.put(rec.key, { ...rec, pendingWake: { prompt, outcome, meta, since: now.toISOString() }, updatedAt: now.toISOString(), nextCheckAt: nextCheck() }).catch(() => {});
    metric(rec, 'wake_failed', { outcome, error: String(res?.error ?? 'error').slice(0, 120) });
    c.errors += 1;
    return false;
  };
  /** Close silently (no wake): the lane is gone / archived / stopped / isolated. Its backstop stands down too. */
  const dropSilently = async (rec: StoredMergeIntent, why: string) => {
    await suppress(rec.backstopHookEventId ?? null, `merge_intent_cancelled:${why}`).catch(() => false);
    await store.del(rec.key).catch(() => {});
    metric(rec, 'cancelled', { why });
    c.dropped += 1;
  };
  /**
   * Retry an outcome wake that could not be queued. Review fix (2026-10-20):
   * a gone / archived lane drops it (no wake can ever land), and it is
   * abandoned after MERGE_INTENT_PENDING_WAKE_TTL_MS (the backstop one-shot
   * has delivered by then) — a dead row no longer retries forever. A lane-read
   * error just retries.
   */
  const retryPendingWake = async (rec: StoredMergeIntent) => {
    const pw = rec.pendingWake!;
    const lane = await deps.loadLane(rec.chatId).catch(() => undefined);
    if (lane === null) { await dropSilently(rec, 'pending_wake_lane_gone'); return; }
    if (lane?.archived) { await dropSilently(rec, 'pending_wake_lane_archived'); return; }
    const since = Date.parse(String(pw.since ?? rec.updatedAt ?? ''));
    if (Number.isFinite(since) && now.getTime() - since > MERGE_INTENT_PENDING_WAKE_TTL_MS) {
      await store.del(rec.key).catch(() => {});
      metric(rec, 'wake_abandoned', { outcome: pw.outcome, since: pw.since ?? null });
      logger.warn(`merge-intent: ${rec.key} outcome wake (${pw.outcome}) to ${rec.chatId.slice(0, 8)} undeliverable for ${Math.round((now.getTime() - since) / 3_600_000)} h — abandoned (the backstop wake covers the lane)`);
      c.dropped += 1;
      return;
    }
    const res = await wake({ targetChatId: rec.chatId, prompt: pw.prompt, meta: pw.meta }).catch(wakeErr);
    if (res?.ok) {
      await settled(rec, pw.outcome);
      metric(rec, pw.outcome, { retriedWake: true, hookEventId: res.hookEventId ?? null });
      return;
    }
    c.errors += 1;
    await store.put(rec.key, { ...rec, nextCheckAt: nextCheck(MERGE_INTENT_ERROR_RETRY_MS) }).catch(() => {});
  };
  /** `red` = the head's CI is RED (the branch, when read): the wake is booked with ci-watch first. */
  const blocked = async (rec: StoredMergeIntent, b: Parameters<typeof renderBlockedWake>[1], red?: { branch: string | null }) => {
    c.blocked += 1;
    if (b.outcome === 'blocked' && b.gate) {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.MERGE_GATE_FAILURE, sessionId: rec.chatId,
        meta: { gate: b.gate, cause: String(b.cause ?? '').slice(0, 160), repo: `${rec.owner}/${rec.repo}`, pullNumber: rec.pullNumber, headSha: rec.headSha, via: 'merge_intent' },
      });
      await recordLearning(rec.projectId, `PR ${rec.owner}/${rec.repo}#${rec.pullNumber} merge intent BLOCKED at gate ${b.gate}: ${b.cause ?? ''} | fix: ${b.fix ?? ''}`).catch(() => {});
    }
    // r3 interactions fix (2026-10-20): a red-CI outcome is the lane's ONE
    // wake about that sha (ci-watch books it and never adds its own); once the
    // lane's red-fix loop budget is spent, ci-watch escalates the loop to the
    // supervisor instead — the lane is not woken. r3 lane-merge review fix
    // (2026-10-20): its backstop stands down too — 'loop' needs a sha ci-watch
    // still watches, so the escalation follows; left armed, the backstop's
    // "merge_pull_request again" wake re-entered the loop the supervisor owns.
    if (red && await noteRedWake({ chatId: rec.chatId, sha: rec.headSha, branch: red.branch, via: 'merge_intent' }).catch(() => 'deliver' as const) === 'loop') {
      await suppress(rec.backstopHookEventId ?? null, 'merge_intent_loop_handoff').catch(() => false);
      await store.del(rec.key).catch(() => {});
      metric(rec, 'loop_handoff', { gate: b.gate ?? null });
      return;
    }
    await deliver(rec, b.outcome, renderBlockedWake(rec, b), { gate: b.gate ?? null });
  };
  /**
   * Keep waiting. `delayMs` (default: the interval) never carries the next
   * check past the intent's expiry, so a backed-off intent still closes on time.
   */
  const wait = async (rec: StoredMergeIntent, patch: Partial<StoredMergeIntent>, delayMs: number = MERGE_INTENT_INTERVAL_SEC * 1000) => {
    c.waiting += 1;
    const toExpiry = (Date.parse(rec.createdAt) || now.getTime()) + MERGE_INTENT_TTL_MS - now.getTime() + 1000;
    const delay = Math.min(delayMs, Math.max(MERGE_INTENT_INTERVAL_SEC * 1000, toExpiry));
    await store.put(rec.key, { ...rec, ...patch, checks: rec.checks + 1, errors: 0, updatedAt: now.toISOString(), nextCheckAt: nextCheck(delay) });
  };

  const budget = Math.max(1, deps.maxPerPass ?? MERGE_INTENT_MAX_PER_PASS);
  const dueRows = rows.filter((r) => intentDue(r, now));
  // Undelivered outcome wakes have their own budget — they never crowd fresh intents out.
  for (const row of orderDueIntents(dueRows.filter((r) => r.pendingWake)).slice(0, budget)) {
    try { await retryPendingWake(row); } catch { c.errors += 1; }
  }
  const due = orderDueIntents(dueRows.filter((r) => !r.pendingWake)).slice(0, budget);
  for (const row of due) {
    let rec: StoredMergeIntent = row;
    try {
      const lane = await deps.loadLane(rec.chatId);
      if (!lane) { await dropSilently(rec, 'lane_gone'); continue; }
      if (lane.archived) { await dropSilently(rec, 'lane_archived'); continue; }
      if (queuingRunStopped(lane, rec)) { await dropSilently(rec, 'lane_stopped'); continue; }
      if (intentExpired(rec, now)) { await blocked(rec, { outcome: 'expired' }); continue; }
      const slug = `${rec.owner}/${rec.repo}`;
      if (!repoTargetAllowed(slug)) { await dropSilently(rec, 'isolation_boundary'); continue; }
      const policy = await resolvePolicy({ repo: slug, projectId: rec.projectId, userId: rec.userId });
      if (policy.policy === 'off') { await blocked(rec, { outcome: 'policy_off', cause: `source: ${policy.source}${policy.why ? ` — ${policy.why}` : ''}` }); continue; }
      const token = await deps.getToken(lane.userId, lane.githubLabel);
      if (!token) throw Object.assign(new Error('no GitHub token for the lane owner'), { noToken: true });
      const api = makeApi(token);
      c.checked += 1;

      // (3) ONE PR read — state + head.
      const pr = (await api.get(`https://api.github.com/repos/${rec.owner}/${rec.repo}/pulls/${rec.pullNumber}`)).data ?? {};
      if (pr.merged === true || pr.merged_at) {
        const mergeSha = String(pr.merge_commit_sha ?? '');
        if (rec.mergePutAt && sameSha(pr?.head?.sha, rec.headSha)) {
          // Our own PUT landed but its confirmation was lost — finish our merge's
          // bookkeeping. Only on the EXACT head the PUT pinned (review fix
          // 2026-10-20): a merge of any other head is someone else's, never
          // claimed with a harness receipt.
          await finishMerge(rec, api, pr, mergeSha);
        } else {
          c.merged += 1;
          await deliver(rec, 'already_merged', renderMergedWake(rec, { mergeSha, alreadyMerged: true }, now));
        }
        continue;
      }
      if (String(pr.state ?? 'open') !== 'open') { await blocked(rec, { outcome: 'closed' }); continue; }
      const head = String(pr?.head?.sha ?? '');
      if (!head) throw new Error('PR head sha missing from the API response');
      let parents: string[] | null = null;
      let commitAt: number | null = null;
      if (rec.updateBranchFrom && !sameSha(head, rec.headSha)) {
        const commit = (await api.get(`https://api.github.com/repos/${rec.owner}/${rec.repo}/commits/${head}`)).data ?? {};
        parents = Array.isArray(commit?.parents) ? commit.parents.map((p: any) => String(p?.sha ?? '')) : null;
        const at = Date.parse(String(commit?.commit?.committer?.date ?? ''));
        commitAt = Number.isFinite(at) ? at : null;
      }
      const move = classifyHeadMove(rec, head, parents, commitAt);
      if (move === 'superseded') { await blocked(rec, { outcome: 'superseded', newHead: head }); continue; }
      // The update-branch the harness asked for has not landed yet (GitHub
      // writes the merge commit asynchronously): wait — never re-request it
      // inside the window (a second request on the same head can be refused).
      if (move === 'same' && rec.updateBranchFrom && String(pr.mergeable_state ?? '') === 'behind'
        && now.getTime() - (Date.parse(String(rec.updateBranchAt ?? '')) || 0) < UPDATE_BRANCH_SETTLE_MS) {
        await wait(rec, { waitKind: 'ci_pending', lastGate: 'pr_state', lastCause: 'update-branch requested — waiting for GitHub to write the merge commit' });
        continue;
      }
      if (move === 'adopt') {
        c.adopted += 1;
        metric(rec, 'adopted', { newHead: head });
        rec = { ...rec, headSha: head, updateBranchFrom: null, updateBranchAt: null, gateTransients: 0, dispatchGapPasses: 0 };
      }

      // (4) ONE check-runs read. r3 interactions fix (2026-10-20): a COMPLETED
      // red check is the work item NOW — BLOCKED before the gate engine, whose
      // G1 would otherwise update-branch a BEHIND red head (a harness merge
      // commit on red: a wasted CI cycle, ci-watch's red wake deferred, the
      // lane's next plain push rejected) — even while other checks still run
      // (G2's rule for a finished check; ci-watch would route it within its
      // 20-min settle). Anything else still running is a wait.
      const runs = (await api.get(`https://api.github.com/repos/${rec.owner}/${rec.repo}/commits/${rec.headSha}/check-runs?per_page=50`)).data ?? {};
      const checkRuns: any[] = Array.isArray(runs?.check_runs) ? runs.check_runs : [];
      const headRef = pr?.head?.ref ? String(pr.head.ref) : null;
      const redRuns = checkRuns.filter((r) => r?.status === 'completed' && !CI_OK_CONCLUSIONS.includes(String(r?.conclusion)));
      if (redRuns.length) {
        await blocked(rec, {
          outcome: 'blocked', gate: 'ci', cause: 'CI is RED on the head sha',
          evidence: redRuns.map((r) => `${r?.name ?? 'check'}: ${r?.status}/${r?.conclusion ?? '-'}${r?.html_url ? ` ${r.html_url}` : ''}`).join('\n'),
          fix: RED_CI_FIX,
        }, { branch: headRef });
        continue;
      }
      if (checkRuns.some((r) => r?.status !== 'completed')) {
        // CI is moving: the full-gate backoff and the dispatch-gap count start over.
        await wait(rec, { waitKind: 'ci_pending', lastGate: 'ci', lastCause: `CI still running on the head (${checkRuns.filter((r) => r?.status !== 'completed').length} check(s))`, gateTransients: 0, dispatchGapPasses: 0 });
        continue;
      }

      // (4b) BEHIND (r3 interactions fix): the gates' update-branch rewrites the
      // PR branch, so it is allowed only on a head cleared here — no legacy
      // status red (one read) and no lane run queued / running (the lane's next
      // plain push would be rejected non-fast-forward). A behind the gates find
      // that this PR read did not see is held too (a timing wait).
      let allowUpdateBranch = false;
      if (String(pr.mergeable_state ?? '') === 'behind' && !selfMergeAutoUpdateBranchDisabled()) {
        if (['queued', 'running'].includes(String(lane.lastRun?.status ?? ''))) {
          await wait(rec, { waitKind: 'ci_pending', lastGate: 'pr_state', lastCause: 'PR branch is BEHIND its base — the update-branch is held while the lane has a run queued / running', gateTransients: 0, dispatchGapPasses: 0 });
          continue;
        }
        const st = (await api.get(`https://api.github.com/repos/${rec.owner}/${rec.repo}/commits/${rec.headSha}/status`).catch(() => null))?.data ?? null;
        const combined = String(st?.state ?? '');
        if (Array.isArray(st?.statuses) && st.statuses.length && (combined === 'failure' || combined === 'error')) {
          await blocked(rec, { outcome: 'blocked', gate: 'ci', cause: 'CI is RED on the head sha', evidence: `combined status: ${combined}`, fix: RED_CI_FIX }, { branch: headRef });
          continue;
        }
        allowUpdateBranch = !!st; // an unreadable status holds the update (the gates answer a timing wait)
      }

      // (5) The FULL gate engine on that exact head.
      const verdict = await evaluateGates({ api, owner: rec.owner, repo: rec.repo, pullNumber: rec.pullNumber, sessionId: rec.chatId, allowUpdateBranch });
      if (!verdict.ok) {
        if (verdict.branchUpdatedFrom && !sameSha(verdict.branchUpdatedFrom, rec.headSha)) {
          // Review fix (2026-10-20): the gates asked GitHub to update a head the
          // intent does not own — a push landed between the PR read and the
          // gates. That push retires the intent (an update commit built on an
          // unvetted head is never adopted).
          await blocked(rec, { outcome: 'superseded', newHead: verdict.headSha ?? verdict.branchUpdatedFrom, branchUpdatedFrom: verdict.branchUpdatedFrom });
          continue;
        }
        if (verdict.headSha && !sameSha(verdict.headSha, rec.headSha)) {
          await wait(rec, { lastCause: 'the head moved between the PR read and the gates — re-read next pass' });
          continue;
        }
        if (verdict.dispatchGap) {
          // Zero check-runs in a repo whose CI runs on PR heads: a short grace
          // (check-runs register a little after a push), then BLOCKED with the
          // gate's fix — nothing the harness waits on dispatches CI.
          const passes = (rec.dispatchGapPasses ?? 0) + 1;
          if (passes >= MERGE_INTENT_DISPATCH_GAP_MAX_PASSES) {
            await blocked(rec, { outcome: 'blocked', gate: verdict.gate, cause: verdict.cause, evidence: verdict.evidence, fix: verdict.suggestedFix });
            continue;
          }
          await wait(rec, { waitKind: verdict.transient ?? 'ci_pending', lastGate: verdict.gate, lastCause: verdict.cause.slice(0, 200), dispatchGapPasses: passes });
          continue;
        }
        if (verdict.transient) {
          if (verdict.branchUpdatedFrom) {
            c.updateBranch += 1;
            metric(rec, 'update_branch', { from: verdict.branchUpdatedFrom });
            await wait(rec, {
              waitKind: verdict.transient, lastGate: verdict.gate, lastCause: verdict.cause.slice(0, 200),
              updateBranchFrom: rec.headSha, updateBranchAt: now.toISOString(), gateTransients: 0, dispatchGapPasses: 0,
            });
            continue;
          }
          // A timing verdict the FULL gates keep returning: back off (the gate
          // engine is ~25 GitHub GETs) instead of re-running it every interval.
          const n = (rec.gateTransients ?? 0) + 1;
          await wait(rec, { waitKind: verdict.transient, lastGate: verdict.gate, lastCause: verdict.cause.slice(0, 200), gateTransients: n, dispatchGapPasses: 0 }, mergeIntentGateBackoffMs(n));
          continue;
        }
        const redVerdict = verdict.gate === 'ci' && verdict.cause.startsWith('CI is RED');
        await blocked(rec, { outcome: 'blocked', gate: verdict.gate, cause: verdict.cause, evidence: verdict.evidence, fix: verdict.suggestedFix }, redVerdict ? { branch: headRef } : undefined);
        continue;
      }
      if (verdict.alreadyMerged) {
        c.merged += 1;
        await deliver(rec, 'already_merged', renderMergedWake(rec, { mergeSha: verdict.headSha, alreadyMerged: true }, now));
        continue;
      }
      if (!sameSha(verdict.headSha, rec.headSha)) {
        await wait(rec, { lastCause: 'the gates read a different head than the intent — re-read next pass' });
        continue;
      }

      // Green on the exact head — merge, pinned to it.
      await store.put(rec.key, { ...rec, mergePutAt: now.toISOString(), updatedAt: now.toISOString(), nextCheckAt: nextCheck() }).catch(() => {});
      rec = { ...rec, mergePutAt: now.toISOString() };
      const put = await api.put(`https://api.github.com/repos/${rec.owner}/${rec.repo}/pulls/${rec.pullNumber}/merge`, { merge_method: rec.mergeMethod, sha: rec.headSha });
      if (put.status !== 200 || put.data?.merged !== true) {
        const kind = sm.classifyMergeWait({ apiStatus: put.status, apiMessage: String(put.data?.message ?? '') });
        if (kind) { await wait(rec, { waitKind: kind, lastGate: 'merge_api' as MergeGate, lastCause: `merge API answered ${put.status}`, mergePutAt: null }); continue; }
        // A refused PUT (head moved / not mergeable now): one re-read decides.
        const again = (await api.get(`https://api.github.com/repos/${rec.owner}/${rec.repo}/pulls/${rec.pullNumber}`)).data ?? {};
        if (again.merged === true) {
          // Ours only on the exact head the PUT pinned; any other head is someone else's merge (no receipt).
          if (sameSha(again?.head?.sha, rec.headSha)) await finishMerge(rec, api, again, String(again.merge_commit_sha ?? put.data?.sha ?? ''));
          else { c.merged += 1; await deliver(rec, 'already_merged', renderMergedWake(rec, { mergeSha: String(again.merge_commit_sha ?? ''), alreadyMerged: true }, now)); }
          continue;
        }
        await blocked({ ...rec, mergePutAt: null }, { outcome: 'blocked', gate: 'merge_api', cause: `merge API answered ${put.status}: ${String(put.data?.message ?? '').slice(0, 200)}`, fix: 'read the PR state, fix what GitHub refused, push, and call merge_pull_request again' });
        continue;
      }
      const confirm = (await api.get(`https://api.github.com/repos/${rec.owner}/${rec.repo}/pulls/${rec.pullNumber}`)).data ?? {};
      if (confirm.merged !== true) {
        // Unconfirmed: the next pass reads merged (mergePutAt marks it ours) or retries.
        await wait(rec, { lastCause: 'merge API answered 200 but the follow-up GET does not show merged:true yet' });
        continue;
      }
      await finishMerge(rec, api, confirm, String(put.data?.sha ?? confirm.merge_commit_sha ?? ''));
    } catch (err: any) {
      const g = classifyGithubError(err, now);
      if (g.kind === 'rate_limited') {
        c.rateLimited += 1;
        await store.put(rec.key, { ...rec, nextCheckAt: nextCheck(g.retryAfterMs) }).catch(() => {});
        if (c.rateLimited >= 2) break;
        continue;
      }
      c.errors += 1;
      const errorsNow = (rec.errors ?? 0) + 1;
      if (errorsNow >= MERGE_INTENT_MAX_ERRORS) {
        await blocked({ ...rec, errors: errorsNow }, { outcome: 'unobservable', cause: (err as any)?.noToken ? 'no GitHub token for the lane owner' : `${g.status ? `GitHub answered ${g.status}` : String(err?.message ?? err).slice(0, 120)}` });
      } else {
        await store.put(rec.key, { ...rec, errors: errorsNow, updatedAt: now.toISOString(), nextCheckAt: nextCheck(MERGE_INTENT_ERROR_RETRY_MS) }).catch(() => {});
      }
    }
  }
  return c;

  async function finishMerge(rec: StoredMergeIntent, api: GithubApi, confirmedPr: any, mergeSha: string): Promise<void> {
    c.merged += 1;
    const slug = `${rec.owner}/${rec.repo}`;
    const resultText = `MERGED ${slug}#${rec.pullNumber} (${rec.mergeMethod} sha ${mergeSha.slice(0, 12)}) — confirmed merged:true by follow-up GET (harness merge intent; every gate re-ran green on head ${rec.headSha.slice(0, 12)}).`;
    const receiptId = await mintReceipt(rec, resultText).catch(() => null);
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MERGE_SUCCESS, sessionId: rec.chatId,
      meta: { repo: slug, pullNumber: rec.pullNumber, mergeSha, cycles: 0, machineTriggered: true, via: 'merge_intent', waitedMs: now.getTime() - (Date.parse(rec.createdAt) || now.getTime()), checks: rec.checks },
    });
    await afterMerge(rec, api, confirmedPr, mergeSha).catch(() => {});
    await deliver(rec, 'merged', renderMergedWake(rec, { mergeSha, receiptId }, now), { mergeSha });
  }
}

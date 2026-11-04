/**
 * MERGE-INTENT-AWAIT (supervisor SOTA round 3, 2026-10-20) — the pure leaf of
 * the harness-owned merge wait: types, switches, constants and the renderers
 * the tool layer (tools.ts merge_pull_request) and the worker cron
 * (merge-intent.service.ts, job MERGE_INTENT_JOB_ID) share. Import-free of
 * prisma / config so the tool's mocks and the cron's tests load it as-is.
 *
 * WHY: a TIMING-class gate failure (CI still running on the PR head, the merge
 * API answering 405 "in progress" / a 5xx, a PR branch BEHIND its base) used
 * to come back to the lane as "MERGE BLOCKED … retry" — the lane then spent
 * model steps (and ticket slots) polling CI, or ended its turn and stranded
 * the PR. Prod before this change: merge_gate_failure 160 + merge_wait_once
 * 139 in 7 d, ticket_lane_slot_release 18 in 3 d, machine_run_would_cut 126 /
 * 462 — and merge latency grew with fleet width because every 'behind' state
 * needed a manual rebase (self-merge.service G1 refused 'behind').
 *
 * WHAT: the tool persists a MERGE INTENT (store namespace MERGE_INTENT_NS,
 * key = `<owner/repo>#<n>`) instead of handing the retry back; the cron
 * re-runs EVERY gate on the EXACT head the intent names every
 * MERGE_INTENT_INTERVAL_SEC, merges the moment they are green (the PUT pins
 * `sha` to that head), mints the merge receipt on the lane chat and wakes the
 * lane ONCE with [MERGE INTENT — MERGED …] or [MERGE INTENT — BLOCKED …].
 * A head the harness did not move (a push) retires the intent; an update-branch
 * merge commit the harness asked for (two parents, the first the intent head)
 * is adopted. Kill switch MERGE_INTENT_QUEUE_DISABLED=1 (the tool bounces as
 * before, the cron leaves every intent alone — the registration-time BACKSTOP
 * one-shot still wakes each holder at MERGE_INTENT_BACKSTOP_MS).
 *
 * Review fixes (2026-10-20): a CI DISPATCH GAP is never queued; a holder is
 * never cleared or replaced silently by another chat; repeated full-gate
 * timing verdicts back off; only the queuing run's stop drops an intent; a
 * merge of another head is never claimed as the harness's; an update commit is
 * adopted only when written after the request on the intent's own head.
 */

import type { MergeGate, MergeWaitKind } from './self-merge.service';

// ── switches ─────────────────────────────────────────────────────────────────

const on = (v: string | undefined): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

export const MERGE_INTENT_QUEUE_DISABLED_ENV = 'MERGE_INTENT_QUEUE_DISABLED';
export const SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED_ENV = 'SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED';

/** MERGE_INTENT_QUEUE_DISABLED=1 — no merge intents: the tool bounces timing-class failures as before and the cron does nothing with them. */
export function mergeIntentQueueDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return on(env[MERGE_INTENT_QUEUE_DISABLED_ENV]);
}

/** SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED=1 — G1 refuses a BEHIND PR as before instead of asking GitHub to update the branch. */
export function selfMergeAutoUpdateBranchDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return on(env[SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED_ENV]);
}

// ── constants ────────────────────────────────────────────────────────────────

/** The worker cron that re-checks merge intents (and the await_condition wakes — await-condition.ts). */
export const MERGE_INTENT_JOB_ID = 'merge-intents';
/** Cron cadence — also the re-check interval of a pending intent ("every 2 min"). */
export const MERGE_INTENT_INTERVAL_SEC = 120;
/** Store namespace of every intent row. */
export const MERGE_INTENT_NS = ['merge-intent'];
/** An intent that never went green on its head is closed (BLOCKED, expired) after this long. */
export const MERGE_INTENT_TTL_MS = 6 * 60 * 60 * 1000;
/** Intents worked per pass (each costs a PR GET + a check-runs GET; the full gate only when CI is complete). */
export const MERGE_INTENT_MAX_PER_PASS = 10;
/** Rows listed per pass (open intents are few; the bound keeps the read bounded). */
export const MERGE_INTENT_LIST_CAP = 200;
/** Open intents one chat may hold — past that the tool bounces as before (a lane queueing a merge storm is a bug, not a queue). */
export const MERGE_INTENT_MAX_OPEN_PER_CHAT = 6;
/** Consecutive errors (unreadable PR, no token, transport) before the intent is closed BLOCKED 'unobservable'. */
export const MERGE_INTENT_MAX_ERRORS = 5;
/** Re-check delay after an error / a rate limit. */
export const MERGE_INTENT_ERROR_RETRY_MS = 6 * 60 * 1000;
/**
 * Review fix (2026-10-20): the full gate engine costs ~25 GitHub GETs (the G2
 * workflow-file probe alone reads up to 20). A TIMING verdict that keeps coming
 * back from the FULL gates (a legacy status stuck pending, a head the cheap
 * check-runs read calls finished) backs off exponentially from the interval to
 * this cap instead of re-running every gate every 2 min.
 */
export const MERGE_INTENT_GATE_BACKOFF_MAX_MS = 30 * 60 * 1000;
/** Consecutive passes the full gates may read a CI DISPATCH GAP (zero check-runs) before the intent closes BLOCKED with the gate's fix — two passes (≥ 4 min) of grace for check-runs that register late (an adopted update-branch commit, a slow Actions queue). */
export const MERGE_INTENT_DISPATCH_GAP_MAX_PASSES = 3;
/** An outcome wake that cannot be queued is retried for this long, then abandoned (the backstop wake has delivered by then). */
export const MERGE_INTENT_PENDING_WAKE_TTL_MS = 24 * 60 * 60 * 1000;
/** The registration-time BACKSTOP one-shot fires this long after the queue (TTL + slack) — the lane is never stranded even when the cron is off or down. */
export const MERGE_INTENT_BACKSTOP_MS = MERGE_INTENT_TTL_MS + 15 * 60 * 1000;
/** Clock skew tolerated when adopting the update-branch merge commit (it must be written AFTER the harness asked for it). */
export const UPDATE_BRANCH_ADOPT_SKEW_MS = 2 * 60 * 1000;

// ── types ────────────────────────────────────────────────────────────────────

/** Why the intent waits: the gate engine's timing classes. */
export type MergeIntentWaitKind = MergeWaitKind;

export type MergeIntentOutcome =
  | 'merged'          // the cron merged it (receipt minted on the lane chat)
  | 'already_merged'  // someone else merged it first
  | 'blocked'         // a real gate failure on the exact head (red CI, conflicts, secret scan, …)
  | 'expired'         // MERGE_INTENT_TTL_MS without green
  | 'superseded'      // the head moved by a push the harness did not make
  | 'closed'          // the PR was closed without merging
  | 'unobservable'    // MERGE_INTENT_MAX_ERRORS in a row
  | 'policy_off'      // a human set self-merge OFF for the project
  | 'cancelled';      // the lane is gone / archived / explicitly stopped (no wake — stop means stop)

/** The row under MERGE_INTENT_NS / intentKey(). */
export interface MergeIntentRecord {
  v: 1;
  key: string;
  owner: string;
  repo: string;
  pullNumber: number;
  /** The EXACT head every gate is re-run on and the merge PUT pins. */
  headSha: string;
  /** The lane chat (= coding session id) that queued the merge — woken once on the outcome. */
  chatId: string;
  userId: string;
  projectId: string | null;
  runId: string | null;
  mergeMethod: 'squash' | 'merge' | 'rebase';
  createdAt: string;
  updatedAt: string;
  nextCheckAt: string;
  /** The timing class that queued it, refreshed by every re-check. */
  waitKind: MergeIntentWaitKind | null;
  lastGate: MergeGate | null;
  lastCause: string | null;
  checks: number;
  errors: number;
  /** update-branch (G1 'behind'): the head GitHub was asked to merge the base INTO — the next head is adopted iff it is that merge commit. */
  updateBranchFrom: string | null;
  updateBranchAt: string | null;
  /** The registration-time backstop one-shot (hook event id) — suppressed once the outcome wake is queued. */
  backstopHookEventId?: string | null;
  /** Consecutive TIMING verdicts from the FULL gate engine (drives the re-gate backoff). */
  gateTransients?: number;
  /** Consecutive CI-dispatch-gap verdicts (MERGE_INTENT_DISPATCH_GAP_MAX_PASSES ⇒ BLOCKED). */
  dispatchGapPasses?: number;
}

// ── pure helpers ─────────────────────────────────────────────────────────────

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export function intentKey(owner: string, repo: string, pullNumber: number): string {
  return `${owner}/${repo}`.toLowerCase() + `#${pullNumber}`;
}

const iso = (d: Date): string => d.toISOString();
const ms = (s: string | null | undefined): number => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : NaN;
};
const hhmmz = (d: Date): string => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
const short = (sha: string | null | undefined): string => String(sha ?? '').slice(0, 12);

/**
 * May this gate failure be QUEUED (waited out by the harness) instead of
 * bounced? Only the gate engine's timing classes — a failure carrying
 * `transient` (CI still running on the head, the update-branch the harness
 * just asked for) or a merge-API class — and only with the head it was judged
 * on. A red check, a conflict, a secret, a boarding train, a red deploy window
 * is a WORK ITEM: never queued. So is the CI DISPATCH GAP (review fix
 * 2026-10-20): it carries `transient` for WAIT-ONCE, but nothing dispatches CI
 * for it (the coverage watchdog backfills MAIN heads only) — the lane must push
 * a commit or dispatch CI, so it gets the gate's fix at once. Pure.
 */
export function queueableWaitKind(input: {
  failure?: { transient?: MergeWaitKind; headSha?: string; dispatchGap?: boolean } | null;
  apiKind?: MergeWaitKind | null;
}): MergeIntentWaitKind | null {
  if (input.failure?.dispatchGap) return null;
  const kind = input.failure?.transient ?? input.apiKind ?? null;
  if (!kind) return null;
  const head = String(input.failure?.headSha ?? '');
  if (!SHA_RE.test(head)) return null;
  return kind;
}

/** A fresh intent row. Pure. */
export function newIntent(i: {
  owner: string; repo: string; pullNumber: number; headSha: string;
  chatId: string; userId: string; projectId?: string | null; runId?: string | null;
  mergeMethod?: string; waitKind: MergeIntentWaitKind | null; gate?: MergeGate | null; cause?: string | null;
  updateBranchFrom?: string | null;
  /** When the update-branch was REQUESTED (defaults to `now`) — the adopted merge commit must be younger. */
  updateBranchAt?: Date | null;
  backstopHookEventId?: string | null;
}, now: Date): MergeIntentRecord {
  const method = (['squash', 'merge', 'rebase'] as const).find((m) => m === i.mergeMethod) ?? 'squash';
  return {
    v: 1,
    key: intentKey(i.owner, i.repo, i.pullNumber),
    owner: i.owner,
    repo: i.repo,
    pullNumber: i.pullNumber,
    headSha: i.headSha,
    chatId: i.chatId,
    userId: i.userId,
    projectId: i.projectId ?? null,
    runId: i.runId ?? null,
    mergeMethod: method,
    createdAt: iso(now),
    updatedAt: iso(now),
    nextCheckAt: iso(new Date(now.getTime() + MERGE_INTENT_INTERVAL_SEC * 1000)),
    waitKind: i.waitKind,
    lastGate: i.gate ?? null,
    lastCause: i.cause ? String(i.cause).slice(0, 200) : null,
    checks: 0,
    errors: 0,
    updateBranchFrom: i.updateBranchFrom ?? null,
    updateBranchAt: i.updateBranchFrom ? iso(i.updateBranchAt instanceof Date && Number.isFinite(i.updateBranchAt.getTime()) ? i.updateBranchAt : now) : null,
    backstopHookEventId: i.backstopHookEventId ?? null,
    gateTransients: 0,
    dispatchGapPasses: 0,
  };
}

/** Same commit (either may be abbreviated; both must look like shas). Pure. */
export function sameSha(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = String(a ?? '').toLowerCase();
  const y = String(b ?? '').toLowerCase();
  return SHA_RE.test(x) && SHA_RE.test(y) && (x.startsWith(y) || y.startsWith(x));
}

/**
 * The re-gate delay after the n-th CONSECUTIVE timing verdict from the FULL
 * gate engine: the interval doubled per repeat, capped at
 * MERGE_INTENT_GATE_BACKOFF_MAX_MS (n ≤ 1 ⇒ the plain interval). Pure.
 */
export function mergeIntentGateBackoffMs(n: number): number {
  const base = MERGE_INTENT_INTERVAL_SEC * 1000;
  const k = Math.max(0, Math.min(10, Math.floor(Number(n) || 0) - 1));
  return Math.min(MERGE_INTENT_GATE_BACKOFF_MAX_MS, base * 2 ** k);
}

/** Due for a re-check (open rows only — the store holds no terminal rows). Pure. */
export function intentDue(rec: Pick<MergeIntentRecord, 'nextCheckAt'> | null | undefined, now: Date): boolean {
  if (!rec) return false;
  const t = ms(rec.nextCheckAt);
  return !Number.isFinite(t) || t <= now.getTime();
}

/** Past its TTL (measured from the FIRST queue — a refresh never extends it). Pure. */
export function intentExpired(rec: Pick<MergeIntentRecord, 'createdAt'>, now: Date): boolean {
  const t = ms(rec.createdAt);
  return Number.isFinite(t) && now.getTime() - t > MERGE_INTENT_TTL_MS;
}

/**
 * The PR head is no longer the intent's head: is it the update-branch merge
 * commit the harness asked for (adopt) or a push it did not make (retire)?
 * An update-branch commit is a MERGE commit whose FIRST parent is the head
 * GitHub was asked to update AND that was written AFTER the harness asked
 * (review fix 2026-10-20: a merge commit the lane made itself on that head —
 * possibly of an unrelated branch — is a push, not the harness's update;
 * `commitAtMs` = the commit's committer date, null/unknown ⇒ never adopted).
 * Pure.
 */
export function classifyHeadMove(rec: Pick<MergeIntentRecord, 'headSha' | 'updateBranchFrom' | 'updateBranchAt'>, newHead: string, parents: string[] | null, commitAtMs: number | null = null): 'same' | 'adopt' | 'superseded' {
  if (sameSha(newHead, rec.headSha)) return 'same';
  const askedAt = ms(rec.updateBranchAt);
  if (rec.updateBranchFrom && Array.isArray(parents) && parents.length === 2
    && sameSha(parents[0], rec.updateBranchFrom)
    && Number.isFinite(askedAt) && typeof commitAtMs === 'number' && Number.isFinite(commitAtMs)
    && commitAtMs >= askedAt - UPDATE_BRANCH_ADOPT_SKEW_MS) return 'adopt';
  return 'superseded';
}

/** Order due intents: oldest due first (a starved intent never waits behind fresh ones). Pure. */
export function orderDueIntents<T extends Pick<MergeIntentRecord, 'nextCheckAt' | 'createdAt'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (ms(a.nextCheckAt) || 0) - (ms(b.nextCheckAt) || 0) || (ms(a.createdAt) || 0) - (ms(b.createdAt) || 0));
}

/** The tool result when the merge is queued (never a retry hand-back). Pure. */
export function renderMergeQueuedText(i: {
  slug: string; pullNumber: number; headSha: string; gate: string; cause: string;
  refreshed?: boolean; heldByOtherChat?: string | null; updateBranchFrom?: string | null; headBranch?: string | null;
}): string {
  const loop = `re-runs EVERY gate on that exact head (every ${Math.round(MERGE_INTENT_INTERVAL_SEC / 60)} min, backing off while nothing changes) and merges the moment they are green`;
  const lines = i.heldByOtherChat
    // Review fix (2026-10-20): the HOLDER — not this chat — is the one woken;
    // never promise this chat a wake it will not get.
    ? [
      `MERGE QUEUED (gate ${i.gate}: ${i.cause}) — session ${String(i.heldByOtherChat).slice(0, 8)} already holds the harness merge intent for ${i.slug}#${i.pullNumber} on head ${short(i.headSha)}: `
        + `the harness ${loop}, then wakes THAT session (not this chat) with the outcome.`,
      `This chat is NOT woken by that merge intent. Do NOT poll or retry merge_pull_request for this PR: continue with other work, or wait on it with await_condition condition:"pr_merged" pullNumber:${i.pullNumber} (the harness then wakes this chat when the PR merges or closes).`,
    ]
    : [
      `MERGE QUEUED (gate ${i.gate}: ${i.cause}) — the harness ${i.refreshed ? 'already holds' : 'now holds'} a merge intent for ${i.slug}#${i.pullNumber} on head ${short(i.headSha)}: `
        + `it ${loop}, then wakes this chat ONCE with `
        + '[MERGE INTENT — MERGED …] — or [MERGE INTENT — BLOCKED …] naming the gate to fix (a red check, a conflict, a push that moved the head, or '
        + `${Math.round(MERGE_INTENT_TTL_MS / 3_600_000)} h without green); a backstop wake follows if no outcome is reported.`,
      'Do NOT poll or retry merge_pull_request for this PR: continue with other work, or mark the merge step blocked ("merge queued — the harness wakes this chat") in update_plan and end your turn.',
    ];
  if (i.updateBranchFrom) {
    lines.push(`The PR branch was BEHIND its base: the harness asked GitHub to merge the base into it (update-branch from ${short(i.updateBranchFrom)}); CI now runs on the updated head. Pull ${i.headBranch ? `origin/${i.headBranch}` : 'the PR branch'} before you push more to it.`);
  }
  return lines.join('\n');
}

/** The lane's wake when the harness merged the PR. Pure. */
export function renderMergedWake(rec: MergeIntentRecord, merge: { mergeSha: string; receiptId?: string | null; alreadyMerged?: boolean }, now: Date): string {
  const slug = `${rec.owner}/${rec.repo}`;
  const waitedMin = Math.max(0, Math.round((now.getTime() - (ms(rec.createdAt) || now.getTime())) / 60_000));
  if (merge.alreadyMerged) {
    return `[MERGE INTENT — MERGED ${slug}#${rec.pullNumber}] The PR you queued was merged by someone else before the harness got to it (merge sha ${short(merge.mergeSha)}; queued ${waitedMin} min ago). `
      + 'The merge is done — do not call merge_pull_request again; continue from here.';
  }
  return `[MERGE INTENT — MERGED ${slug}#${rec.pullNumber}] The harness merged the PR you queued at ${hhmmz(now)} after every gate re-ran green on the exact head ${short(rec.headSha)} `
    + `(${rec.mergeMethod} sha ${short(merge.mergeSha)}; queued ${waitedMin} min ago${merge.receiptId ? `; receipt ${String(merge.receiptId).slice(0, 8)}` : ''}). `
    + 'The merge is done — do not call merge_pull_request again. Continue the task from here; if it needs the deploy, '
    + `await_condition condition:"deploy" sha:"${merge.mergeSha}" waits on it without polling.`;
}

/** The lane's wake when the intent closed without a merge. Pure. */
export function renderBlockedWake(rec: MergeIntentRecord, b: {
  outcome: Exclude<MergeIntentOutcome, 'merged' | 'already_merged' | 'cancelled'>;
  gate?: string | null; cause?: string | null; evidence?: string | null; fix?: string | null; newHead?: string | null;
  /** superseded: another session queued the merge on the new head and now holds the intent. */
  requeuedByChat?: string | null;
  /** superseded: the gates asked GitHub to update the NEW head (it was behind) — the remote branch carries a harness merge commit. */
  branchUpdatedFrom?: string | null;
}): string {
  const slug = `${rec.owner}/${rec.repo}`;
  const head = `[MERGE INTENT — BLOCKED ${slug}#${rec.pullNumber}] The merge you queued on head ${short(rec.headSha)} did NOT land`;
  switch (b.outcome) {
    case 'superseded':
      if (b.requeuedByChat) {
        return `${head}: the PR head moved to ${short(b.newHead)} and session ${String(b.requeuedByChat).slice(0, 8)} queued the merge on that new head — it now holds the merge intent and is the one woken on the outcome. `
          + `This chat's intent is retired: do not retry merge_pull_request for it; if this chat must wait on the merge, call await_condition condition:"pr_merged" pullNumber:${rec.pullNumber}.`;
      }
      return `${head}: the PR head moved to ${short(b.newHead)} by a push the harness did not make — an intent is for its exact head only, so it is retired. `
        + (b.branchUpdatedFrom ? 'That new head was BEHIND its base, so the harness asked GitHub to update it — pull the PR branch before you push more to it. ' : '')
        + 'When the new head is ready, call merge_pull_request again (a CI wait re-queues itself).';
    case 'expired':
      return `${head} within ${Math.round(MERGE_INTENT_TTL_MS / 3_600_000)} h — the last verdict was ${b.gate ?? rec.lastGate ?? 'unknown'}: ${b.cause ?? rec.lastCause ?? 'not green'}. `
        + 'The intent is closed. Look at why the head never went green (check_ci), fix or re-run it, then call merge_pull_request again.';
    case 'closed':
      return `${head}: the PR was closed without merging. The intent is closed — reopen it (or open a fresh PR) only if the change is still wanted.`;
    case 'unobservable':
      return `${head}: the harness could not read the PR ${MERGE_INTENT_MAX_ERRORS} times in a row (${b.cause ?? 'GitHub unreadable'}). `
        + 'The intent is closed — check the GitHub connection / repo access, then call merge_pull_request again.';
    case 'policy_off':
      return `${head}: self-merge is now OFF for this project (${b.cause ?? 'a human setting'}). The intent is closed — ask the owner to merge PR #${rec.pullNumber}.`;
    default:
      return `${head}: gate ${b.gate ?? 'unknown'} failed on that exact head — ${b.cause ?? 'not mergeable'}.`
        + (b.evidence ? `\nevidence: ${String(b.evidence).slice(0, 600)}` : '')
        + (b.fix ? `\nfix: ${b.fix}` : '')
        + '\nThe intent is closed. This is your next work item: fix the cause, push, and call merge_pull_request again.';
  }
}

/**
 * The registration-time BACKSTOP one-shot (review fix 2026-10-20): delivered
 * only when nothing else woke the lane by MERGE_INTENT_BACKSTOP_MS — the
 * merge-intents cron off (MERGE_INTENT_QUEUE_DISABLED / SELF_MERGE_DISABLED),
 * down, or its outcome wake failing. Pure.
 */
export function renderMergeBackstopWake(i: { slug: string; pullNumber: number; headSha: string }, createdAt: Date, horizonAt: Date): string {
  return `[MERGE INTENT — BACKSTOP ${i.slug}#${i.pullNumber}] You queued a merge of this PR on head ${short(i.headSha)} at ${hhmmz(createdAt)}; `
    + `no [MERGE INTENT — MERGED …] or [MERGE INTENT — BLOCKED …] outcome was reported by ${hhmmz(horizonAt)} (the harness merge watcher may be off or down). `
    + 'Read the PR once yourself and decide: merge_pull_request again, fix what blocks it, or report it blocked. '
    + 'If an outcome wake for this PR already reached you, ignore this one.';
}

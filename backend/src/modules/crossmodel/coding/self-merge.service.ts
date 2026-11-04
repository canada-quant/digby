/**
 * Self-merge (owner directive 2026-09-09, follow-on to remediation P5 v1#27) —
 * machine runs merge pull requests THEMSELVES through a deterministic gate
 * engine instead of parking every CI-green PR on an owner card.
 *
 * The P5 audit intent is preserved structurally:
 *   - nothing unverified lands: every gate gathers FRESH GitHub API evidence
 *     (never model-claimed), and a merge is only reported after a follow-up
 *     GET shows merged:true — a fabricated "merged" claim is impossible
 *     through this tool;
 *   - gate FAILURES are work items, not owner asks: the tool returns a
 *     structured { gate, cause, evidence, suggestedFix } envelope, and a
 *     retry is only accepted when something actually changed (new head sha
 *     or changed evidence for the failing gate) — forced reflection, no
 *     blind spin. After SELF_MERGE_MAX_CYCLES evidence-distinct failures on
 *     the same gate, ONE owner card fires as a circuit breaker (a stuck loop
 *     is a bug being surfaced, not a human-in-the-loop step).
 *   - the framework learns from its failures: every gate failure emits
 *     loop_metrics kind merge_gate_failure AND appends a one-line learning
 *     to the project's self-merge learnings ring (readable by later runs).
 *
 * POLICY (owner 2026-09-09, sharpened by the 2026-09-11 gate flip — owner:
 * "full steam"): crossmodel itself is ALWAYS self-merge — the self-enhancement
 * loop closes with no human click. Every OTHER project is self-merge ON BY
 * DEFAULT too: an explicit HUMAN-set ProjectSettings.selfMerge='off' (owner
 * setting / answered card) is still honored, but nothing else can turn it
 * off. The old inference → ask-once-card resolver (utilityChat judgment over
 * memory facts / answered merge questions / sibling-project adoption) is
 * DEFAULT-OFF: the day it shipped it read the owner's coerced "Approved."
 * clicks as a click preference and PERSISTED off on three repos, refusing a
 * user-turn run under the directive "always merge to main no gates". The
 * only owner words on record are ON. The inference judge, the 'ask' policy
 * and the ask-once card were DELETED (2026-09-28 backlog audit CT-6): the
 * opt-in tail had zero production use since the flip and existed only to
 * type-check a dead tool branch.
 *
 * GATES: G1 pr_state, G2 ci, G2.5 red_window and G4 secret_scan are deterministic
 * artifact gates and still REFUSE. G2.5 red_window (ticket 2bccefe0, 2026-10-18)
 * re-derives main's deploy window state FRESH at merge time — the PR-head
 * guard check mints its verdict at PUSH time, so a merge could ride a green
 * minted before the window opened (PR #1754: merged 15:16:54Z on a guard
 * SUCCESS minted 15:07:18Z while main's deploy had concluded failure at
 * 15:16:04Z). Kill switch RED_WINDOW_MERGE_GATE_DISABLED=1. G3 verify_chain (session verify red / UNVERIFIED)
 * is OBSERVE-ONLY since 2026-09-11 — 4/4 of its production reds were
 * environmental (OOM 137) on CI-green heads, holding a wanted platform fix
 * 12.5h; it now records a note + guard_miss metric, opt-in
 * VERIFY_CHAIN_GATE_ENFORCE=1 re-arms it (code-red, same-head only). G5
 * containment (the ladder's cadence_halved / model_swap_proposed tiers) was
 * REMOVED with the ladder's action path — no env re-arms it.
 *
 * MERGE-INTENT-AWAIT (2026-10-20, merge-intent.ts): G1 no longer refuses a
 * mergeable PR that is merely BEHIND its base — it asks GitHub to update the
 * branch and answers a timing failure (transient ci_pending, branchUpdatedFrom)
 * that the tool queues as a MERGE INTENT the worker cron merges on the exact
 * head (SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED=1 restores the refusal).
 *
 * Kill-switches: SELF_MERGE_DISABLED=1 (tool refuses with the P5 owner-merge
 * wording); SELF_MERGE_MAX_CYCLES (default 5).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';

// ── Config ───────────────────────────────────────────────────────────────────

export function selfMergeDisabled(): boolean {
  const v = String(process.env.SELF_MERGE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export function selfMergeMaxCycles(): number {
  const n = Number(process.env.SELF_MERGE_MAX_CYCLES);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.round(n), 50) : 5;
}

// Instance isolation boundary (ticket c75b5f34): import-free leaf — see
// platform/instance-targets.ts. On a NON-PROD instance (DIGBY_INSTANCE != prod)
// the own-repo slug comes from SELF_REPO ONLY: unset ⇒ '' (no own repo — never
// matches, the loop runs against explicitly configured targets), configured to
// the production repo ⇒ IsolationBoundaryError (hard fail, never a prod read).
import { resolveInstanceOwnRepoSlug } from '../platform/instance-targets';
import { classifyRedWindow, DEPLOY_FIX_LABEL, DEPLOY_WORKFLOW_PATH, redWindowMergeGateDisabled } from './red-window-merge-gate';
import { selfMergeAutoUpdateBranchDisabled } from './merge-intent';

/** The deployment's own repo — ALWAYS self-merge (owner directive 2026-09-09). */
export function ownRepoSlug(): string {
  return resolveInstanceOwnRepoSlug('SELF_REPO');
}

/** Gate flip 2026-09-11 (owner: full steam): G3 verify_chain is observe-only
 *  unless VERIFY_CHAIN_GATE_ENFORCE=1 (and even then only a CODE-red on the
 *  PR's own head sha refuses — environmental reds and other-worktree reds
 *  never block). */
export function verifyChainGateEnforced(): boolean {
  return process.env.VERIFY_CHAIN_GATE_ENFORCE === '1';
}

// ── Per-project policy ───────────────────────────────────────────────────────

export type SelfMergePolicy =
  | { policy: 'on'; source: 'framework' | 'owner' | 'answered' | 'inferred'; why?: string }
  | { policy: 'off'; source: 'owner' | 'answered' | 'inferred'; why?: string };

interface SelfMergeSettings {
  selfMerge?: 'on' | 'off';
  selfMergeSource?: 'owner' | 'answered' | 'inferred';
  selfMergeWhy?: string;
}

/**
 * Resolve whether machine self-merge applies for this repo/project/user.
 * Order: own repo (hardwired on) → explicit/answered stored setting →
 * DEFAULT ON (gate flip 2026-09-11). There is no 'ask' outcome: the legacy
 * inference → ask-once tail was removed (2026-09-28) — a stored INFERRED off
 * from that era is still ignored below.
 */
export async function resolveSelfMergePolicy(opts: {
  repo: string;
  projectId?: string | null;
  userId: string;
}): Promise<SelfMergePolicy> {
  const repo = String(opts.repo || '').toLowerCase();
  if (repo === ownRepoSlug()) {
    return { policy: 'on', source: 'framework', why: 'crossmodel is always self-merging (owner directive 2026-09-09)' };
  }
  const projectId = opts.projectId ?? null;
  if (projectId) {
    try {
      const { getMergedProjectStoreState } = await import('../platform/folder-inheritance');
      const s = await getMergedProjectStoreState<SelfMergeSettings>(projectId, 'settings');
      // Inference asymmetry (2026-09-09 inversion incident): a stored OFF is
      // honored only when a HUMAN put it there (owner setting / answered
      // question). An inferred 'off' — including rows persisted before this
      // rule — is IGNORED: the judge once read the owner's coerced merge
      // clicks as a preference for clicking and silently locked three lanes
      // out of their own directive.
      if (s?.selfMerge === 'on') {
        return { policy: 'on', source: s.selfMergeSource ?? 'owner', why: s.selfMergeWhy };
      }
      if (s?.selfMerge === 'off' && s.selfMergeSource !== 'inferred') {
        return { policy: 'off', source: s.selfMergeSource ?? 'owner', why: s.selfMergeWhy };
      }
    } catch { /* unreadable settings → fall through to the default */ }
  }
  // Gate flip 2026-09-11 (owner: full steam): DEFAULT ON. No human OFF is
  // stored, so self-merge applies — the owner doctrine is "self merge
  // everywhere". (The inference judge + ask-once card that once followed here
  // persisted a wrong OFF on three repos the day they shipped, no owner ever
  // answered OFF, and they were deleted after zero use post-flip.)
  return {
    policy: 'on',
    source: 'framework',
    why: 'default-on (owner doctrine: self merge everywhere; an explicit human OFF is still honored)',
  };
}

// ── Gate engine ──────────────────────────────────────────────────────────────

/** Gate flip 2026-09-11 (owner: full steam): 'containment' (G5) removed with
 *  the ladder's action path; 'verify_chain' (G3) only appears as a failure
 *  under the VERIFY_CHAIN_GATE_ENFORCE=1 opt-in; 'results_log' (G6, tt-rd
 *  audit 2026-09-27) only under RESULTS_LOG_GUARD_ENFORCE=1.
 *  'batch_train' (T2c, todo 9c89ab21, 2026-10-17): while a batch train is
 *  BOARDING (an unmerged batch/<ts> branch — auto-discovered), a code PR may
 *  not merge into main; docs-only/state-only PRs still can (the carve-out). */
export type MergeGate = 'pr_state' | 'ci' | 'red_window' | 'verify_chain' | 'secret_scan' | 'batch_train' | 'results_log' | 'detector_recall';

export interface GateFailure {
  ok: false;
  gate: MergeGate;
  cause: string;
  evidence: string;
  suggestedFix: string;
  evidenceHash: string;
  /** agent-decisions prerequisite 4 (2026-09-27): the PR head the gates judged (absent only when the PR itself was unreadable) — stamped as meta.headSha on every merge_gate_failure row so red-on-head can be measured. */
  headSha?: string;
  /** The failure is a TIMING artifact the tool may wait out ONCE (self-merge WAIT-ONCE): CI still running on the head. */
  transient?: MergeWaitKind;
  /**
   * MERGE-INTENT-AWAIT (2026-10-20): G1 found the PR BEHIND its base and the
   * harness asked GitHub to update the branch — the head it was asked to
   * update (the next head is that merge commit; a merge intent adopts it).
   */
  branchUpdatedFrom?: string;
  /**
   * MERGE-INTENT-AWAIT review fix (2026-10-20): the G2 CI DISPATCH GAP — zero
   * check-runs on the head in a repo whose workflows run on PR heads. It stays
   * `transient` (the tool's WAIT-ONCE still waits it out once, as before), but
   * nothing the harness can wait on resolves it (the coverage watchdog
   * backfills MAIN heads only), so a merge intent never QUEUES it — the lane
   * gets the gate's fix (push a commit / dispatch CI) at once.
   */
  dispatchGap?: true;
}

// ── WAIT-ONCE (agent-decisions prerequisite 4, 2026-09-27) ───────────────────
// 259 merge bounces / 14 d: 131 were `ci` PENDING, 39 merge_api (11 "merge
// already in progress"), and 180/194 bounced PRs merged later, avg 7 min
// (design §2.5, verified). Each bounce cost a model retry turn. The tool now
// waits ONCE, harness-side, on a timing-class failure — CI pending on the
// head, the merge API answering 405 "in progress" / a 5xx — then re-runs the
// gates ONE time before it declares the failure to the model. The wait is
// deadline-shielded (ToolContext.onShieldedWait → agent.ts deadlineOffsetMs,
// the awaitApproval idiom) and bounded: min(2 × the repo's CI p50, 10 min),
// floor 30 s; the API classes wait a short fixed slice. At most
// MERGE_WAIT_MAX_CONCURRENT waits hold worker slots at once (a wait past the
// cap bounces as today). One wait per PR HEAD: the attempt record remembers
// `waitedHeadSha`, so a second call on the same head bounces immediately.
// Fail-open everywhere — any error inside the wait path falls through to
// today's bounce. Kill switch SELF_MERGE_WAIT_ONCE_DISABLED=1.

export type MergeWaitKind = 'ci_pending' | 'merge_in_progress' | 'server_5xx';

/** Upper bound of one wait (env SELF_MERGE_WAIT_ONCE_MAX_MS overrides; ≤ 10 min — the tool hard timeout is 15). */
export const SELF_MERGE_WAIT_ONCE_MAX_MS = 10 * 60_000;
/** Floor of a CI wait (a check rarely finishes faster). */
export const SELF_MERGE_WAIT_ONCE_MIN_MS = 30_000;
/** CI p50 assumed when the repo has no history yet (2× ⇒ a 6-min wait). */
export const SELF_MERGE_WAIT_ONCE_DEFAULT_CI_P50_MS = 3 * 60_000;
/** The fixed slice for the merge-API classes (405 in-progress / 5xx). */
export const SELF_MERGE_WAIT_ONCE_API_MS = 45_000;
/** Default cap on concurrent harness-side merge waits per process (env MERGE_WAIT_MAX_CONCURRENT). */
export const MERGE_WAIT_MAX_CONCURRENT_DEFAULT = 4;
/** History window for the repo CI p50 (loop_metrics merge_gate_failure(ci) → merge_success deltas). */
export const REPO_CI_P50_WINDOW_DAYS = 30;
export const REPO_CI_P50_MIN_SAMPLES = 3;

/** SELF_MERGE_WAIT_ONCE_DISABLED=1 — the tool bounces every gate failure at once, as before 2026-09-27. */
export function selfMergeWaitOnceDisabled(): boolean {
  const v = String(process.env.SELF_MERGE_WAIT_ONCE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export function selfMergeWaitOnceMaxMs(): number {
  const n = Number(process.env.SELF_MERGE_WAIT_ONCE_MAX_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), SELF_MERGE_WAIT_ONCE_MAX_MS) : SELF_MERGE_WAIT_ONCE_MAX_MS;
}

export function mergeWaitMaxConcurrent(): number {
  const n = Number(process.env.MERGE_WAIT_MAX_CONCURRENT);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 32) : MERGE_WAIT_MAX_CONCURRENT_DEFAULT;
}

/**
 * Classify a merge failure as a timing artifact the tool may wait out once,
 * or null (a real work item: red CI on the head, dirty/conflicting, secret
 * scan, a closed PR …). Pure.
 */
export function classifyMergeWait(input: { failure?: Pick<GateFailure, 'transient'> | null; apiStatus?: number; apiMessage?: string }): MergeWaitKind | null {
  if (input.failure?.transient) return input.failure.transient;
  const status = Number(input.apiStatus);
  if (Number.isFinite(status) && status >= 500 && status <= 599) return 'server_5xx';
  if (status === 405 && /\bin progress\b|base branch was modified/i.test(String(input.apiMessage ?? ''))) return 'merge_in_progress';
  return null;
}

/** How long ONE wait of this kind lasts: ci_pending ⇒ clamp(2 × p50, floor, max); API classes ⇒ the fixed slice (≤ max). Pure. */
export function mergeWaitOnceMs(repoCiP50Ms: number | null | undefined, kind: MergeWaitKind, maxMs: number = selfMergeWaitOnceMaxMs()): number {
  const max = Math.max(1, maxMs);
  if (kind !== 'ci_pending') return Math.min(SELF_MERGE_WAIT_ONCE_API_MS, max);
  const p50 = typeof repoCiP50Ms === 'number' && Number.isFinite(repoCiP50Ms) && repoCiP50Ms > 0 ? repoCiP50Ms : SELF_MERGE_WAIT_ONCE_DEFAULT_CI_P50_MS;
  return Math.min(max, Math.max(Math.min(SELF_MERGE_WAIT_ONCE_MIN_MS, max), Math.round(2 * p50)));
}

/** Pure: the median of the (first ci-gate failure → merge_success) delta per PR over rows of both kinds, or null under REPO_CI_P50_MIN_SAMPLES. */
export function repoCiP50FromRows(rows: ReadonlyArray<{ kind: string; createdAt: Date | string; meta: unknown }>, minSamples: number = REPO_CI_P50_MIN_SAMPLES): number | null {
  const firstCi = new Map<string, number>();
  const merged = new Map<string, number>();
  for (const r of rows) {
    const m = (r?.meta && typeof r.meta === 'object' ? r.meta : {}) as Record<string, unknown>;
    const pr = m.pullNumber ?? m.pr;
    if (pr === undefined || pr === null) continue;
    const key = String(pr);
    const t = r.createdAt instanceof Date ? r.createdAt.getTime() : Date.parse(String(r.createdAt));
    if (!Number.isFinite(t)) continue;
    if (r.kind === 'merge_gate_failure' && m.gate === 'ci') { if (!firstCi.has(key) || t < (firstCi.get(key) as number)) firstCi.set(key, t); }
    else if (r.kind === 'merge_success') { if (!merged.has(key) || t < (merged.get(key) as number)) merged.set(key, t); }
  }
  const deltas: number[] = [];
  for (const [key, t0] of firstCi) { const t1 = merged.get(key); if (typeof t1 === 'number' && t1 > t0) deltas.push(t1 - t0); }
  if (deltas.length < Math.max(1, minSamples)) return null;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 ? deltas[mid] : Math.round((deltas[mid - 1] + deltas[mid]) / 2);
}

/** The repo's CI p50 from the last REPO_CI_P50_WINDOW_DAYS of loop_metrics (bounded read; null on any failure or too few samples). Never throws. */
export async function repoCiP50Ms(repo: string): Promise<number | null> {
  try {
    const since = new Date(Date.now() - REPO_CI_P50_WINDOW_DAYS * 86_400_000);
    const rows = await prisma.loopMetric.findMany({
      where: { kind: { in: [LOOP_METRIC_KINDS.MERGE_GATE_FAILURE, LOOP_METRIC_KINDS.MERGE_SUCCESS] }, createdAt: { gte: since }, meta: { path: ['repo'], equals: repo } },
      orderBy: { createdAt: 'asc' },
      take: 400,
      select: { kind: true, createdAt: true, meta: true },
    });
    return repoCiP50FromRows(rows as Array<{ kind: string; createdAt: Date; meta: unknown }>);
  } catch (err: any) {
    logger.debug(`self-merge: repo CI p50 lookup failed for ${repo} (default applies): ${err?.message ?? err}`);
    return null;
  }
}

let mergeWaitSlotsHeld = 0;
/** Claim one of the process's concurrent-wait slots; false when the cap is reached (the caller bounces as today). */
export function tryAcquireMergeWaitSlot(): boolean {
  if (mergeWaitSlotsHeld >= mergeWaitMaxConcurrent()) return false;
  mergeWaitSlotsHeld += 1;
  return true;
}
export function releaseMergeWaitSlot(): void { mergeWaitSlotsHeld = Math.max(0, mergeWaitSlotsHeld - 1); }
/** Test hook. */
export function mergeWaitSlotsInUse(): number { return mergeWaitSlotsHeld; }
/** The sleep the tool layer awaits (a module export so tests replace it). */
export const mergeWaitSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export interface GatePass {
  ok: true;
  headSha: string;
  evidenceNotes: string[]; // per-gate one-liners (incl. N/A reasons) for the receipt
  /** The PR was ALREADY merged (fresh GET) — report honestly, never re-merge. */
  alreadyMerged?: boolean;
}

export interface GithubApi {
  get(url: string, accept?: string): Promise<{ status: number; data: any }>;
  put(url: string, body: any): Promise<{ status: number; data: any }>;
  /** Optional — only the post-merge head-branch cleanup uses it (resolves on
   *  ANY status); a double without it simply keeps the head branch. */
  delete?(url: string): Promise<{ status: number; data: any }>;
}

export function defaultGithubApi(token: string): GithubApi {
  const headers = (accept?: string) => ({
    Authorization: `Bearer ${token}`,
    Accept: accept || 'application/vnd.github+json',
  });
  return {
    async get(url, accept) {
      const axios = (await import('axios')).default;
      const r = await axios.get(url, { headers: headers(accept), timeout: 20000, ...(accept === 'application/vnd.github.diff' ? { responseType: 'text' as const, transformResponse: [(d: any) => d], maxContentLength: 900_000 } : {}) });
      return { status: r.status, data: r.data };
    },
    async put(url, body) {
      const axios = (await import('axios')).default;
      const r = await axios.put(url, body, { headers: headers(), timeout: 25000, validateStatus: () => true });
      return { status: r.status, data: r.data };
    },
    async delete(url) {
      const axios = (await import('axios')).default;
      const r = await axios.delete(url, { headers: headers(), timeout: 20000, validateStatus: () => true });
      return { status: r.status, data: r.data };
    },
  };
}

// ── Post-merge head-branch cleanup (owner 2026-09-14) ────────────────────────

/** SELF_MERGE_KEEP_HEAD_BRANCH=1 keeps the merged PR's head branch (read per call). */
export function selfMergeKeepHeadBranch(): boolean {
  return process.env.SELF_MERGE_KEEP_HEAD_BRANCH === '1';
}

export type HeadBranchCleanupOutcome = 'deleted' | 'already_gone' | 'kept' | 'failed';

/**
 * Delete refs/heads/<head.ref> after a SUCCESSFUL merge (owner 2026-09-14:
 * "it seems the framework isnt automatically deleting branches after they
 * are merged" — GitHub's delete_branch_on_merge only fires for its own merge
 * API path and a lane can re-push after). Rules: the head must live in the
 * base repo (never a fork), and must not be the base branch or the repo's
 * default branch (unknown default ⇒ keep — conservative). Best-effort: never
 * throws; 404/422 = the repo already removed it (fine, no suffix); any other
 * failure gets ONE warn and the merge result stands.
 */
export async function deleteMergedHeadBranch(opts: {
  api: GithubApi;
  owner: string;
  repo: string;
  /** The PR as answered by the post-merge confirmation GET. */
  pr: any;
}): Promise<{ outcome: HeadBranchCleanupOutcome; branch: string | null; why?: string }> {
  const pr = opts.pr ?? {};
  const branch: string | null = typeof pr?.head?.ref === 'string' && pr.head.ref ? pr.head.ref : null;
  if (!branch) return { outcome: 'kept', branch: null, why: 'no head ref on the PR' };
  if (selfMergeKeepHeadBranch()) return { outcome: 'kept', branch, why: 'SELF_MERGE_KEEP_HEAD_BRANCH=1' };
  const baseRepo = String(pr?.base?.repo?.full_name ?? `${opts.owner}/${opts.repo}`).toLowerCase();
  const headRepo = String(pr?.head?.repo?.full_name ?? '').toLowerCase();
  if (!headRepo || headRepo !== baseRepo) return { outcome: 'kept', branch, why: 'head lives in a fork' };
  const defaultBranch = typeof pr?.base?.repo?.default_branch === 'string' ? pr.base.repo.default_branch : null;
  if (!defaultBranch) return { outcome: 'kept', branch, why: 'default branch unknown' };
  const baseRef = typeof pr?.base?.ref === 'string' ? pr.base.ref : null;
  if (branch === defaultBranch || branch === baseRef || branch === 'main' || branch === 'master') {
    return { outcome: 'kept', branch, why: 'head is the default/base branch' };
  }
  if (typeof opts.api.delete !== 'function') return { outcome: 'kept', branch, why: 'api has no delete' };
  const encoded = branch.split('/').map(encodeURIComponent).join('/');
  const slug = `${opts.owner}/${opts.repo}`;
  try {
    const r = await opts.api.delete(`https://api.github.com/repos/${opts.owner}/${opts.repo}/git/refs/heads/${encoded}`);
    if (r.status === 204) return { outcome: 'deleted', branch };
    if (r.status === 404 || r.status === 422) return { outcome: 'already_gone', branch };
    logger.warn(`self-merge: deleting merged head branch ${slug}:${branch} answered ${r.status}: ${String(r.data?.message ?? '').slice(0, 120)}`);
    return { outcome: 'failed', branch, why: `GitHub answered ${r.status}` };
  } catch (err: any) {
    logger.warn(`self-merge: deleting merged head branch ${slug}:${branch} failed: ${err?.message ?? err}`);
    return { outcome: 'failed', branch, why: String(err?.message ?? err).slice(0, 120) };
  }
}

function hashEvidence(s: string): string {
  // Tiny stable hash (djb2) — only used to answer "did the evidence change?".
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function fail(gate: MergeGate, cause: string, evidence: string, suggestedFix: string, extra: Pick<GateFailure, 'headSha' | 'transient' | 'branchUpdatedFrom' | 'dispatchGap'> = {}): GateFailure {
  return {
    ok: false, gate, cause, evidence: evidence.slice(0, 1200), suggestedFix, evidenceHash: hashEvidence(`${gate}|${cause}|${evidence}`),
    ...(extra.headSha ? { headSha: extra.headSha } : {}),
    ...(extra.transient ? { transient: extra.transient } : {}),
    ...(extra.branchUpdatedFrom ? { branchUpdatedFrom: extra.branchUpdatedFrom } : {}),
    ...(extra.dispatchGap ? { dispatchGap: true as const } : {}),
  };
}

/**
 * MERGE-INTENT-AWAIT (2026-10-20): ask GitHub to merge the base INTO a PR
 * branch that is BEHIND it (PUT …/pulls/<n>/update-branch, pinned to the head
 * the gates read via expected_head_sha — a head that moved meanwhile answers
 * 422 and nothing changes). 202 = accepted (the new merge commit lands
 * asynchronously and CI runs on it). Never throws.
 */
export async function requestBranchUpdate(api: GithubApi, owner: string, repo: string, pullNumber: number, expectedHeadSha: string): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    const r = await api.put(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/update-branch`, { expected_head_sha: expectedHeadSha });
    return { ok: r.status === 202 || r.status === 200, status: r.status, message: String(r.data?.message ?? '').slice(0, 160) };
  } catch (err: any) {
    return { ok: false, status: 0, message: String(err?.message ?? err).slice(0, 160) };
  }
}

/**
 * Run the merge gates with FRESH API evidence. Order: cheap/deterministic
 * first. Returns the first failure (the work item) or a pass with the head
 * sha the merge must target.
 */
export async function evaluateMergeGates(opts: {
  api: GithubApi;
  owner: string;
  repo: string;
  pullNumber: number;
  sessionId: string;
  /**
   * r3 interactions fix (2026-10-20): false = a BEHIND PR is NOT updated —
   * G1 answers a TIMING failure instead (the merge-intents cron holds the
   * update-branch on a head it has not cleared: red CI, a lane with a run in
   * flight). Default true (the tool path, unchanged).
   */
  allowUpdateBranch?: boolean;
}): Promise<GateFailure | GatePass> {
  const { api, owner, repo, pullNumber, sessionId } = opts;
  const notes: string[] = [];

  // Gate flip 2026-09-11 (owner: full steam): G5 containment REMOVED. The
  // ladder's cadence_halved / model_swap_proposed tiers used to refuse here
  // before any GitHub call — 8 strikes on 3 PRs, ~10h of platform fixes held,
  // no refused PR ever found defective; G1-G4 verify the artifact itself. The
  // ladder is telemetry-only now and no env re-arms this gate.

  // G1 PR state.
  let pr: any;
  try {
    const r = await api.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`);
    pr = r.data;
  } catch (err: any) {
    return fail('pr_state', 'PR unreadable', String(err?.message ?? err).slice(0, 200),
      'check the repo slug, PR number, and that the connected GitHub account can read the repo');
  }
  if (pr.merged === true) {
    // Already merged is a SUCCESS shape, not a failure — signal via pass with
    // a note; the tool layer reports it honestly without re-merging.
    return { ok: true, alreadyMerged: true, headSha: String(pr.merge_commit_sha || pr.head?.sha || ''), evidenceNotes: [...notes, `pr_state: ALREADY merged (merge sha ${String(pr.merge_commit_sha).slice(0, 12)})`] };
  }
  const headShaSeen = typeof pr?.head?.sha === 'string' && pr.head.sha ? String(pr.head.sha) : undefined;
  if (pr.state !== 'open') {
    return fail('pr_state', `PR is ${pr.state}, not open`, `state=${pr.state}`, 'reopen the PR (or open a fresh one) before merging', { headSha: headShaSeen });
  }
  // MERGE-INTENT-AWAIT (2026-10-20): a PR that is mergeable but BEHIND its base
  // (branch protection requires an up-to-date branch) used to refuse here and
  // hand a manual rebase back to the lane — merge latency grew with fleet width
  // because every merge to main put every other open PR behind. Now the harness
  // asks GitHub to update the branch (a merge commit of the base into the head,
  // pinned to the head read above) and answers a TIMING failure: CI runs on the
  // updated head, which the tool's WAIT-ONCE / a merge intent waits out and
  // gates exactly. A refused update (conflict, head moved, no push access)
  // falls through to the refusal below with GitHub's answer in the evidence.
  // Kill switch SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED=1.
  let behindNote = '';
  if (String(pr.mergeable_state) === 'behind' && pr.mergeable !== false && headShaSeen) {
    if (!selfMergeAutoUpdateBranchDisabled()) {
      if (opts.allowUpdateBranch === false) {
        return fail('pr_state', 'PR branch is BEHIND its base — the update-branch is held until the head is cleared (CI not red, no lane run in flight)',
          `mergeable_state=behind update-branch=held head ${headShaSeen.slice(0, 12)}`,
          'wait — the harness merge intent updates the branch once the head is cleared',
          { headSha: headShaSeen, transient: 'ci_pending' });
      }
      const upd = await requestBranchUpdate(api, owner, repo, pullNumber, headShaSeen);
      if (upd.ok) {
        return fail('pr_state', 'PR branch was BEHIND its base — the harness asked GitHub to merge the base into it (update-branch); CI now runs on the updated head',
          `mergeable_state=behind update-branch=${upd.status} from head ${headShaSeen.slice(0, 12)}`,
          'wait for CI on the updated head (a merge intent does this for you) — pull the PR branch before pushing more to it',
          { headSha: headShaSeen, transient: 'ci_pending', branchUpdatedFrom: headShaSeen });
      }
      behindNote = ` — the harness's update-branch was refused (${upd.status || 'error'}: ${upd.message || 'no message'})`;
    }
  }
  if (pr.mergeable === false || (pr.mergeable_state && !['clean', 'unstable', 'has_hooks', 'unknown'].includes(String(pr.mergeable_state)))) {
    return fail('pr_state', `PR not mergeable (mergeable=${pr.mergeable}, state=${pr.mergeable_state})${behindNote}`,
      `mergeable=${pr.mergeable} mergeable_state=${pr.mergeable_state}${behindNote}`,
      'rebase/update the branch to resolve conflicts, push, and retry', { headSha: headShaSeen });
  }
  const headSha = String(pr.head?.sha ?? '');
  if (!headSha) return fail('pr_state', 'PR head sha missing from the API response', JSON.stringify(pr.head ?? {}).slice(0, 200), 'retry when the API answers with a head sha');
  notes.push(`pr_state: open, mergeable_state=${pr.mergeable_state}, head ${headSha.slice(0, 12)}`);

  // G2 CI — check-runs + legacy statuses on the head sha. Zero of both = no CI
  // configured (docs repos): N/A pass, recorded.
  try {
    const runs = await api.get(`https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=50`);
    const checkRuns: any[] = runs.data?.check_runs ?? [];
    const statusResp = await api.get(`https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/status`);
    const statuses: any[] = statusResp.data?.statuses ?? [];
    if (checkRuns.length === 0 && statuses.length === 0) {
      // fb707538 (2026-10-06): zero check-runs used to pass unconditionally as
      // "no_ci (repo has no CI)" — a verdict written for docs repos. But
      // commits landed on main through the Contents/PR REST dispatch path
      // (single-parent squash "merge: K…" lands, direct base-branch PUTs)
      // create no refs/heads push event, so the `push: branches: [main]` CI
      // trigger never fires and those heads carry ZERO check-runs in a repo
      // that HAS CI workflows — this verdict let 13 of the 25 newest main
      // heads at diagnosis time merge with no CI at all, two of them red (the
      // DEPLOY was the first CI-equivalent run on that code). When the repo
      // has a workflow that runs on PR heads (adversarial-review N4
      // 2026-10-07: "any workflow file" conflates a scheduled-only repo with
      // a CI repo — a scheduled-only workflow never runs on a PR head, so
      // zero check-runs there is genuinely no-CI), zero check-runs is a
      // DISPATCH GAP, not "no CI": refuse as transient — the CI coverage
      // watchdog backfills uncovered main heads
      // (scripts/deploy/ci-coverage-watchdog.sh), and the retry then reads
      // the real verdict (green passes, red blocks).
      let prHeadWorkflows = false;
      try {
        const wf = await api.get(`https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows?ref=${encodeURIComponent(headSha)}`);
        const files: Array<{ name?: string; path?: string; download_url?: string | null }> = Array.isArray(wf.data) ? wf.data : [];
        // Only a workflow that can run ON A PR HEAD makes zero check-runs a
        // dispatch gap. The listing gives names, not triggers — read each
        // file's raw content (it is a repo-relative text file; the accept
        // header bypasses the base64 JSON envelope) and look for the PR/push
        // triggers. Capped at 20 files (a repo with more workflows than that
        // has CI among the newest 20 alphabetically-named ones — and the cap
        // only bounds gate latency, never correctness: a miss just keeps the
        // docs-repo no_ci pass, the fail-open direction this probe already
        // had for unreadable dirs).
        for (const f of files.slice(0, 20)) {
          const p = f.path ?? f.name;
          if (!p || !/\.ya?ml$/.test(p)) continue;
          try {
            // Path segments are encoded but the / separators are literal —
            // `contents/.github/workflows/ci.yml`, not `…workflows%2Fci.yml`.
            const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(headSha)}`;
            const body = await api.get(fileUrl, 'application/vnd.github.raw');
            const text = typeof body.data === 'string' ? body.data : '';
            if (/(^|\s)(pull_request|push)\s*:/.test(text)) { prHeadWorkflows = true; break; }
          } catch { /* unreadable workflow file — skip it */ }
        }
      } catch {
        prHeadWorkflows = false; // an unreadable workflows dir keeps the docs-repo pass
      }
      if (prHeadWorkflows) {
        return fail('ci',
          'zero check-runs on the head sha in a repo WITH workflows that run on PR heads — a CI dispatch gap, not "no CI"',
          `check-runs=0 statuses=0 pr-head-workflows>0 (head ${headSha.slice(0, 12)})`,
          'get CI to run on the head sha, then retry this merge. The CI coverage watchdog backfills uncovered heads but its cadence is BEST-EFFORT (two 15-min cron grids, GitHub schedule drops happen — a ~3h silent gap was observed on the single-grid day); do not count on a 15-min rescue. Reliable options: push a commit to the PR branch (a push event always dispatches CI), or trigger the CI workflow on the head via workflow_dispatch / a re-run. A merge must never proceed on an unverified head in a repo that has CI',
          { headSha, transient: 'ci_pending' as const, dispatchGap: true });
      }
      notes.push('ci: no_ci (no check-runs or statuses on this ref — repo has no CI)');
    } else {
      const badRuns = checkRuns.filter(r => r.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(String(r.conclusion)));
      const combined = String(statusResp.data?.state ?? 'success');
      const badStatuses = statuses.length > 0 && combined !== 'success';
      if (badRuns.length || badStatuses) {
        const detail = [
          ...badRuns.map(r => `${r.name}: ${r.status}/${r.conclusion ?? '-'}${r.html_url ? ` ${r.html_url}` : ''}`),
          ...(badStatuses ? [`combined status: ${combined}`] : []),
        ].join('\n');
        const pending = badRuns.some(r => r.status !== 'completed') || combined === 'pending';
        return fail('ci', pending ? 'CI still running on the head sha' : 'CI is RED on the head sha', detail,
          pending ? 'wait for the checks to finish, then retry' : 'read the failing checks, fix, push to the PR branch, and retry once CI is green',
          { headSha, ...(pending ? { transient: 'ci_pending' as const } : {}) });
      }
      notes.push(`ci: green (${checkRuns.length} check-runs, ${statuses.length} statuses)`);
    }
  } catch (err: any) {
    return fail('ci', 'CI verdict unreadable', String(err?.message ?? err).slice(0, 200), 'retry when the Checks API answers; a merge must never proceed on an unknown CI verdict', { headSha });
  }

  // G2.5 red window (ticket 2bccefe0, 2026-10-18): the PR-head guard check
  // (red-window-guard.yml) mints its verdict at PUSH time and G2 above reads
  // only the check-run CONCLUSION — so a merge could land inside an open red
  // window riding a green minted before the window opened (PR #1754: merged
  // 15:16:54Z on a guard SUCCESS minted 15:07:18Z; main's deploy run
  // 39139333344 had concluded failure at 15:16:04Z, 50 s earlier). This gate
  // re-derives the window FRESH from the Actions snapshot at merge time —
  // the SAME single-source selection rule the guard script implements
  // (leaf: red-window-merge-gate.ts; parity pinned by
  // red-window-merge-gate.2bccefe0.test.ts). Scope: the instance's OWN repo
  // only (ownRepoSlug — prod: canada-quant/digby; a self-hosted instance:
  // its SELF_REPO) and the repo's DEFAULT branch — the guard's own scope;
  // user-project repos keep their existing gates untouched. The deploy-fix
  // label is the SAME lawful override the check exposes (a deploy-repair PR
  // iterating toward green may merge while red — PR #1752). Fail-OPEN on
  // every error class (snapshot unreadable, base unresolvable) — a flaky
  // gate must never wedge the fleet's merges (the 2026-10-17 P0 class).
  try {
    if (redWindowMergeGateDisabled()) {
      notes.push('red_window: kill switch RED_WINDOW_MERGE_GATE_DISABLED=1 — mechanism off');
    } else {
      const slug = `${owner}/${repo}`.toLowerCase();
      const own = ownRepoSlug().toLowerCase();
      if (!own || slug !== own) {
        notes.push(`red_window: ${slug} is not this instance's own repo — no window to guard`);
      } else {
        const labels: string[] = Array.isArray(pr?.labels) ? pr.labels.map((l: any) => String(l?.name ?? '')) : [];
        if (labels.some((name) => name.includes(DEPLOY_FIX_LABEL))) {
          notes.push(`red_window: OVERRIDE label '${DEPLOY_FIX_LABEL}' present on PR #${pullNumber} — merge allowed (deploy-fix iteration), window not evaluated`);
        } else {
          const baseRef = String(pr?.base?.ref ?? '');
          const defaultBranch = String(pr?.base?.repo?.default_branch || 'main');
          const isDefaultBase = !baseRef || baseRef === defaultBranch;
          if (!isDefaultBase) {
            notes.push(`red_window: PR targets ${baseRef || defaultBranch} (not the default branch) — no window to guard`);
          } else {
            // ONE unfiltered snapshot (the script's single-source doctrine);
            // the path+branch filter is applied client-side by classifyRedWindow.
            const snap = await api.get(`https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=100`);
            const runs: any[] = Array.isArray(snap.data?.workflow_runs) ? snap.data.workflow_runs : [];
            const hasDeploy = runs.some((r) => String(r?.path ?? '') === DEPLOY_WORKFLOW_PATH);
            if (!hasDeploy) {
              notes.push('red_window: no deploy workflow on this repo — no window to guard');
            } else {
              const w = classifyRedWindow(runs, baseRef || defaultBranch);
              if (w.state === 'red') {
                return fail('red_window',
                  `main's deploy is RED (run ${w.runId}, sha ${w.runSha}, concluded ${w.concludedAt}) — merging now stacks this PR's deploy onto a failed deploy run`,
                  `run=${w.runId} conclusion=${w.conclusion} sha=${w.runSha} concluded=${w.concludedAt} base=${baseRef || defaultBranch} (FRESH at merge time — the PR-head guard verdict can predate this window; PR #1754, ticket 2bccefe0)`,
                  `add the '${DEPLOY_FIX_LABEL}' label to this PR (the lawful deploy-repair override, the same one the guard check honors), or wait for main's deploy to go green and retry`,
                  { headSha });
              }
              if (w.state === 'unproven') {
                notes.push('red_window: a deploy run on the default branch is in flight — window UNPROVEN, failing OPEN');
              } else {
                notes.push(`red_window: no red window (last completed deploy on ${baseRef || defaultBranch}: ${w.conclusion}, run ${w.runId})`);
              }
            }
          }
        }
      }
    }
  } catch (err: any) {
    notes.push(`red_window: window unreadable (fail-open) — ${String(err?.message ?? err).slice(0, 120)}`);
  }

  // G3 verify chain — session-scoped verify state. Gate flip 2026-09-11
  // (owner: full steam): OBSERVE-ONLY. A red or UNVERIFIED chain is NOTED on
  // the receipt + recorded as a guard_miss metric (seam self_merge_verify_chain)
  // and the merge proceeds — G2 already verified the same head via CI, and
  // 4/4 production reds were environmental (OOM 137) from the lane's OTHER
  // worktree, holding a CI-green platform fix 12.5h. Opt-in
  // VERIFY_CHAIN_GATE_ENFORCE=1 restores a refusal, and only for a CODE-red
  // (not environmental) recorded on THIS PR's head sha (or with no sha at all);
  // UNVERIFIED never refuses — CI on the PR is the verification of record.
  try {
    const { getVerifyState } = await import('./verify-state');
    const vs = await getVerifyState(sessionId);
    if (vs) {
      const red = vs.passed === false;
      const redKind = red ? (vs.environmental ? 'environmental' : 'code') : null;
      const sameHead = !vs.sha || vs.sha === headSha;
      const observed = red || vs.unverified === true;
      if (observed) {
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.GUARD_MISS,
          sessionId,
          meta: {
            seam: 'self_merge_verify_chain',
            outcome: 'observed',
            passed: vs.passed,
            environmental: vs.environmental === true,
            unverified: vs.unverified === true,
            failedStage: vs.failedStage ?? null,
            sameHead,
            enforced: verifyChainGateEnforced(),
          },
        });
      }
      if (red && verifyChainGateEnforced() && redKind === 'code' && sameHead) {
        return fail('verify_chain', 'this session’s verify chain is red on this head', `failedStage=${vs.failedStage ?? 'unknown'} sha=${String(vs.sha ?? headSha).slice(0, 12)}`,
          'run verify, get the chain green, then retry the merge', { headSha });
      }
      const status = red
        ? `RED (${redKind} failedStage=${vs.failedStage ?? 'unknown'}${sameHead ? '' : ', recorded on a different head'})`
        : 'passed';
      const unverifiedNote = vs.unverified ? ' UNVERIFIED (stages skipped — tool not installed; CI on the PR is the verification of record)' : '';
      notes.push(`verify_chain: ${status}${unverifiedNote}${observed ? ' — noted, not blocking (VERIFY_CHAIN_GATE_ENFORCE=1 re-arms a same-head code-red refusal)' : ''}`);
    } else {
      notes.push('verify_chain: n/a (no verify state this session)');
    }
  } catch { notes.push('verify_chain: n/a (state unreadable)'); }

  // G4 secret scan over the PR diff's ADDED lines.
  let diffText: string | null = null;
  try {
    const diff = await api.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`, 'application/vnd.github.diff');
    diffText = String(diff.data ?? '');
    const added = diffText.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n').slice(0, 800_000);
    const { scanTextForSecrets } = await import('../platform/secret-scan');
    const hits = scanTextForSecrets(added);
    if (hits.length) {
      return fail('secret_scan', `the PR diff adds ${hits.length} credential-shaped line(s)`, hits.slice(0, 5).join('; ').slice(0, 400),
        'remove/rotate the credential(s), push the scrubbed branch, and retry — a secret can never be retried through', { headSha });
    }
    notes.push('secret_scan: clean');
  } catch { notes.push('secret_scan: diff unreadable (fail-open — G2/G1 already anchored the evidence)'); }

  // G4.5 batch train (T2c, todo 9c89ab21, 2026-10-17): while a batch train is
  // BOARDING (auto-discovered from an unmerged batch/<ts> branch — the branch
  // IS the state; docs/BATCH_TRAIN.md), a CODE PR may not merge into the
  // repo's DEFAULT branch; docs-only / state-only PRs (.md family, docs/**,
  // .digby/**) still can — the todo's carve-out, verbatim. The train's own
  // landing is a raw fast-forward push to main, never a PR merge, so it never
  // passes through here. Fail-OPEN on BOTH flaky dependencies — discovery
  // errors (a GitHub hiccup must not hold every merge in the fleet — the
  // 2026-10-17 did-it-work P0 lesson) AND an unreadable diff (the runbook
  // makes a slipped merge cheap to absorb: the train's --ff-only refuses, the
  // runner re-cuts and re-boards; a held fleet is strictly worse). The ONLY
  // refusal is the classified case: a live train + base=default + a diff that
  // provably contains non-docs files. Kill switch BATCH_TRAIN_GATE_DISABLED=1.
  try {
    const bt = await import('./batch-train.service');
    const { discoveryApiFromGithub, classifyTrainDocsOnly, filesFromUnifiedDiff, batchTrainGateDisabled } = await import('./batch-train');
    if (batchTrainGateDisabled()) {
      notes.push('batch_train: kill switch BATCH_TRAIN_GATE_DISABLED=1 — mechanism off');
    } else {
    const discoveryApi = discoveryApiFromGithub(api, owner, repo);
    const train = await bt.getLiveBatchTrain(discoveryApi);
    if (train) {
      const baseRef = String(pr?.base?.ref ?? '');
      const defaultBranch = String(pr?.base?.repo?.default_branch || 'main');
      const baseIsDefault = !baseRef || baseRef === defaultBranch;
      const docsOnly = diffText !== null ? classifyTrainDocsOnly(filesFromUnifiedDiff(diffText)).docsOnly : false;
      if (baseIsDefault && diffText !== null && !docsOnly) {
        return fail('batch_train',
          `a batch train is BOARDING (${train.branch}) — code PRs ride the train, they do not merge straight into ${defaultBranch}`,
          `train=${train.branch} sha=${String(train.sha).slice(0, 12)} activity=${train.activity} determinedBy=${train.determinedBy}; base=${baseRef || defaultBranch}; docsOnly=${docsOnly}`,
          `re-target the PR onto ${train.branch} (gh pr edit ${pullNumber} --base ${train.branch}) so the train-runner's merge carries it — docs-only PRs (.md, docs/**, .digby/**) may still merge straight to ${defaultBranch}; docs/BATCH_TRAIN.md is the runbook`,
          { headSha });
      }
      if (baseIsDefault && diffText === null) {
        notes.push(`batch_train: train ${train.branch} boarding but the PR diff is unreadable — fail-open (the runbook's re-board absorbs a slipped merge; a held fleet is the P0 class)`);
      } else {
        notes.push(`batch_train: train ${train.branch} boarding; this PR ${docsOnly ? 'is docs-only — carve-out applies' : `targets ${baseRef} (not the default branch)`}`);
      }
    } else {
      notes.push('batch_train: no live train (direct merges allowed)');
    }
    }
  } catch (err: any) {
    notes.push(`batch_train: discovery error (fail-open) — ${String(err?.message ?? err).slice(0, 120)}`);
  }

  // G6 results-log truncation (tt-rd audit 2026-09-27, finding docs-churn-log-2):
  // the SAME diff, read for DELETIONS this time. A results/tracker/log markdown
  // file losing ≥ RESULTS_LOG_MAX_DELETED_LINES lines AND ≥ 50 % of its pre-PR
  // bytes (one contents GET at the base sha; hunk-span fallback) with no
  // archive/ file added in the same diff is a truncation of an append-only
  // record — two such PRs (#601, #809 on canada-quant/tt-rd: −8,409 and −4,232
  // lines, 399 sections) passed G1–G4 because nothing read the '-' lines.
  // OBSERVE-ONLY by default (2026-09-11 gate flip): a note on the receipt +
  // guard_strike seam 'results_log_truncate' state 'observed'; the merge
  // proceeds. RESULTS_LOG_GUARD_ENFORCE=1 promotes it to a merge gate.
  // Fail-open on every error.
  if (diffText !== null) {
    try {
      const rl = await import('./results-log-guard');
      {
        const stats = rl.parseUnifiedDiff(diffText);
        const candidates = rl.resultsLogCandidates(stats);
        if (candidates.length) {
          const baseRef = String(pr?.base?.sha || pr?.base?.ref || '');
          const preBytes = new Map<string, number | null>();
          for (const c of candidates) {
            try {
              const r = await api.get(`https://api.github.com/repos/${owner}/${repo}/contents/${c.path.split('/').map(encodeURIComponent).join('/')}${baseRef ? `?ref=${encodeURIComponent(baseRef)}` : ''}`);
              const size = Number(r.data?.size);
              preBytes.set(c.path, Number.isFinite(size) && size > 0 ? size : null);
            } catch { preBytes.set(c.path, null); }
          }
          const truncations = rl.findResultsLogTruncations(candidates, (path) => preBytes.get(path) ?? null, stats);
          for (const t of truncations) {
            const enforced = rl.resultsLogGuardEnforced() && t.archiveMissing;
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
              sessionId,
              meta: { seam: 'results_log_truncate', state: enforced ? 'enforced' : 'observed', path: t.path, deleted: t.deleted, added: t.added, sections: t.sectionsDeleted, ratio: t.ratio, hunkEstimated: t.hunkEstimated, archiveMissing: t.archiveMissing, repo: `${owner}/${repo}`, pullNumber },
            });
            if (enforced) {
              return fail('results_log', `${t.path} loses ${t.deleted} lines (${t.sectionsDeleted} sections) with no archive file added — a results log is append-only on main`,
                rl.renderResultsLogNote(t), rl.RESULTS_LOG_SUGGESTED_FIX, { headSha });
            }
            notes.push(`${rl.renderResultsLogNote(t)} — noted, not blocking (RESULTS_LOG_GUARD_ENFORCE=1 re-arms a refusal)`);
          }
        }
      }
    } catch { /* observe-only — never fail a merge on the guard's own error */ }
  }

  // G7 detector change (audit 2026-10-08 W5-3, detector-change-guard.ts): a PR
  // that changes a framework detector's source (action-verifier, evidence
  // guard, hand-back detector, nightly suite) must ship a RECALL REPLAY test
  // (marker "DETECTOR-RECALL REPLAY") of the detector's prior true positives —
  // five detector RELAXATIONS merged in 44 h with no recall check. A TICKET
  // LANE is refused without one (it adds the replay, or stops at "needs owner
  // review"); every other session gets an observe-only note.
  // DETECTOR_CHANGE_GUARD_OBSERVE_ONLY=1 notes everywhere;
  // DETECTOR_CHANGE_GUARD_DISABLED=1 skips the check. Fail-open on any error.
  if (diffText !== null) {
    try {
      const dg = await import('./detector-change-guard');
      if (!dg.detectorChangeGuardDisabled()) {
        const v = dg.assessDetectorChange(diffText);
        if (v.detectors.length) {
          const ticketLane = v.missingReplay ? await isDispatchedTicketLane(sessionId) : false;
          const enforced = v.missingReplay && ticketLane && !dg.detectorChangeGuardObserveOnly();
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
            sessionId,
            meta: { seam: 'detector_change', state: enforced ? 'enforced' : 'observed', outcome: enforced ? 'refused' : 'observed', detectors: v.detectors, replayFiles: v.replayFiles.slice(0, 5), missingReplay: v.missingReplay, ticketLane, repo: `${owner}/${repo}`, pullNumber },
          });
          if (enforced) {
            return fail('detector_recall', `DETECTOR CHANGE (${v.detectors.join(', ')}) with no recall replay — a ticket lane may not merge a detector change that has not shown its prior true positives still fire`,
              dg.renderDetectorChangeNote(v, true), dg.DETECTOR_RECALL_SUGGESTED_FIX, { headSha });
          }
          notes.push(dg.renderDetectorChangeNote(v, false));
        }
      }
    } catch { /* never fail a merge on the guard's own error */ }
  }

  return { ok: true, headSha, evidenceNotes: notes };
}

/**
 * Is this session a DEDICATED ticket lane (the fresh-lane dispatcher's
 * context.dispatchMode 'ticket_lane' + dispatchedTo = this session)? Fail-open
 * to false (observe-only) on any read error. Exported for tests.
 */
export async function isDispatchedTicketLane(sessionId: string): Promise<boolean> {
  try {
    const row: any = await (prisma as any).userFeatureRequest?.findFirst?.({
      where: { context: { path: ['dispatchedTo'], equals: sessionId } },
      select: { context: true },
    });
    return !!row && (row.context as any)?.dispatchMode === 'ticket_lane';
  } catch {
    return false;
  }
}

// ── Attempt records (forced reflection) + learnings ring ─────────────────────

export interface AttemptRecord {
  lastHeadSha?: string;
  lastGate?: MergeGate;
  lastEvidenceHash?: string;
  cycles?: number;
  cardFiled?: boolean;
  /** WAIT-ONCE (2026-09-27): the PR head the tool already waited on once — a later call on the same head bounces at once. */
  waitedHeadSha?: string;
}

const attemptKey = (repo: string, pullNumber: number) => `pr:${repo.toLowerCase()}#${pullNumber}`;

export async function readAttempt(chatId: string, repo: string, pullNumber: number): Promise<AttemptRecord> {
  const { storeGet } = await import('../memory/context-store');
  return (await storeGet<AttemptRecord>([chatId, 'selfmerge'], attemptKey(repo, pullNumber)).catch(() => null)) ?? {};
}

export async function writeAttempt(chatId: string, repo: string, pullNumber: number, rec: AttemptRecord): Promise<void> {
  const { storePut } = await import('../memory/context-store');
  await storePut([chatId, 'selfmerge'], attemptKey(repo, pullNumber), { ...rec });
}

export async function clearAttempt(chatId: string, repo: string, pullNumber: number): Promise<void> {
  const { storePut } = await import('../memory/context-store');
  await storePut([chatId, 'selfmerge'], attemptKey(repo, pullNumber), {});
}

/**
 * "Did anything change since the last failed attempt?" A retry with the same
 * head sha AND the same failing-gate evidence is refused — the model must fix
 * something (or the world must move) before the gates re-run.
 */
export function nothingChanged(prev: AttemptRecord, headShaNow: string | null, failure?: { gate: MergeGate; evidenceHash: string }): boolean {
  if (!prev.lastGate) return false;
  if (headShaNow && prev.lastHeadSha && headShaNow !== prev.lastHeadSha) return false;
  if (failure && (failure.gate !== prev.lastGate || failure.evidenceHash !== prev.lastEvidenceHash)) return false;
  return true;
}

/** Append-only per-project learnings ring (cap 40) — the "learn about itself" channel. */
export async function recordMergeLearning(projectId: string | null, line: string): Promise<void> {
  if (!projectId) return;
  try {
    const { storeGet, storePut } = await import('../memory/context-store');
    const cur = (await storeGet<{ lines?: string[] }>([projectId, 'selfmerge'], 'learnings').catch(() => null)) ?? {};
    const lines = Array.isArray(cur.lines) ? cur.lines : [];
    const stamped = `${new Date().toISOString().slice(0, 16)}Z ${line}`.slice(0, 300);
    await storePut([projectId, 'selfmerge'], 'learnings', { lines: [...lines, stamped].slice(-40) });
  } catch { /* learnings are best-effort */ }
}

export async function readMergeLearnings(projectId: string | null): Promise<string[]> {
  if (!projectId) return [];
  try {
    const { storeGet } = await import('../memory/context-store');
    const cur = await storeGet<{ lines?: string[] }>([projectId, 'selfmerge'], 'learnings');
    return Array.isArray(cur?.lines) ? cur!.lines! : [];
  } catch { return []; }
}

/**
 * MERGE-INTENT-AWAIT (supervisor SOTA round 3, 2026-10-20) — the
 * `await_condition` tool and its CONDITION WAKES: the harness, not the model,
 * waits for an external condition.
 *
 * WHY: lanes burned model steps (and ticket slots) polling CI, PR merges and
 * deploys — check_ci in a loop, run_command `sleep`, a one-shot schedule per
 * re-check — or ended their turn and stranded the work (prod 3 d:
 * ticket_lane_slot_release 18; machine_run_would_cut 126 / 462 runs).
 *
 * WHAT:
 *   - await_condition {condition: ci | pr_merged | deploy, sha | pullNumber,
 *     repo?, timeoutSec ≤ AWAIT_CONDITION_MAX_SEC}: BLOCKS harness-side,
 *     probing every AWAIT_CONDITION_POLL_MS (the wait is deadline-shielded via
 *     ToolContext.onShieldedWait, the WAIT-ONCE idiom), and returns the verdict
 *     the moment the condition is met.
 *   - Not met in time ⇒ it registers a CONDITION WAKE (store namespace
 *     CONDITION_WAKE_NS) plus a BACKSTOP one-shot wake on the lane at the
 *     condition's horizon (hooks.service enqueueDirectWake with notBefore —
 *     the lane is never stranded even if the cron never fires), and ENDS THE
 *     RUN (ToolContext.requestEndTurn → the agent loop's tools-off final turn;
 *     goal-continue and the unfinished-work continuation stand down —
 *     AgentRunResult.awaitingCondition).
 *   - The worker cron (merge-intent.service runHarnessWaitsOnce, every 2 min)
 *     re-probes every registered wake; met ⇒ ONE direct wake on the lane with
 *     the verdict, the backstop row is suppressed (status delivered +
 *     suppressedAtDelivery 'condition_met'), the row is deleted. A gone /
 *     archived / explicitly STOPPED lane drops its waits silently (stop means
 *     stop). Past the horizon the row is dropped and the backstop delivers.
 *
 * Kill switch AWAIT_CONDITION_DISABLED=1: the tool refuses (pointing at
 * check_ci / schedule_self) and the cron leaves registered waits alone (their
 * backstops still deliver). Telemetry: loop_metrics kind 'await_condition'.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { repoTargetAllowed, isolationRefusal, resolveInstanceOwnRepoSlug } from '../platform/instance-targets';
import { classifyGithubError, isExplicitStop, parseGithubRepo, noteHarnessRedWake } from './ci-watch.service';
import type { CiStatus } from './ci-status';
import { DEPLOY_WORKFLOW_PATH } from './red-window-merge-gate';

// ── switches + constants ─────────────────────────────────────────────────────

export const AWAIT_CONDITION_DISABLED_ENV = 'AWAIT_CONDITION_DISABLED';

/** AWAIT_CONDITION_DISABLED=1 — the tool refuses and the cron leaves condition wakes alone (backstops still deliver). */
export function awaitConditionDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env[AWAIT_CONDITION_DISABLED_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export type AwaitConditionKind = 'ci' | 'pr_merged' | 'deploy';
export const AWAIT_CONDITION_KINDS: readonly AwaitConditionKind[] = ['ci', 'pr_merged', 'deploy'];
/** The tool blocks at most this long (the design's 600 s; well under the 15-min tool hard timeout). */
export const AWAIT_CONDITION_MAX_SEC = 600;
/** In-tool probe cadence. */
export const AWAIT_CONDITION_POLL_MS = 20_000;
/** A sha with NO checks yet reads "not met" this long (CI registers its check runs a few seconds after a push). */
export const AWAIT_CONDITION_NONE_GRACE_MS = 90_000;
/** Consecutive probe errors that end the in-tool wait (honest error, nothing registered). */
export const AWAIT_CONDITION_MAX_TOOL_ERRORS = 3;
/** Concurrent in-tool waits per process — past it the tool probes once and registers the wake at once (no worker slot held). */
export const AWAIT_CONDITION_MAX_CONCURRENT = 6;
/** Store namespace of the registered condition wakes. */
export const CONDITION_WAKE_NS = ['await-condition'];
/** Open condition wakes one chat may hold. */
export const CONDITION_WAKE_MAX_PER_CHAT = 4;
/** Re-probe cadence of a registered wake (the cron's). */
export const CONDITION_WAKE_RECHECK_MS = 120_000;
/** Rows a pass works / lists. */
export const CONDITION_WAKE_MAX_PER_PASS = 20;
export const CONDITION_WAKE_LIST_CAP = 200;
/** Consecutive cron errors before a row is dropped (the backstop still delivers at the horizon). */
export const CONDITION_WAKE_MAX_ERRORS = 6;
/** The backstop horizon per condition — the one-shot wake that fires if nothing else did. */
export const CONDITION_WAKE_HORIZON_MS: Readonly<Record<AwaitConditionKind, number>> = {
  ci: 2 * 60 * 60 * 1000,
  pr_merged: 6 * 60 * 60 * 1000,
  deploy: 3 * 60 * 60 * 1000,
};

// ── types ────────────────────────────────────────────────────────────────────

export interface ConditionSpec {
  kind: AwaitConditionKind;
  owner: string;
  repo: string;
  sha?: string;
  pullNumber?: number;
}

export interface ConditionProbe {
  met: boolean;
  /** One line (bounded) — the verdict the lane reads. */
  summary: string;
  /** A 'ci' probe's CI state (a met 'failure' is a red-CI wake, booked with ci-watch). */
  ciState?: CiStatus['state'];
}

/** The row under CONDITION_WAKE_NS / conditionWakeKey(). */
export interface ConditionWakeRecord {
  v: 1;
  key: string;
  chatId: string;
  userId: string;
  runId: string | null;
  spec: ConditionSpec;
  createdAt: string;
  horizonAt: string;
  nextCheckAt: string;
  checks: number;
  errors: number;
  backstopHookEventId: string | null;
  lastSummary: string | null;
}

// ── pure helpers ─────────────────────────────────────────────────────────────

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const hhmmz = (d: Date): string => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
const msOf = (s: string | null | undefined): number => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

export function conditionKey(spec: ConditionSpec): string {
  const slug = `${spec.owner}/${spec.repo}`.toLowerCase();
  return spec.kind === 'pr_merged' ? `pr_merged:${slug}#${spec.pullNumber}` : `${spec.kind}:${slug}@${String(spec.sha ?? '').toLowerCase()}`;
}

export const conditionWakeKey = (chatId: string, spec: ConditionSpec): string => `${chatId}:${conditionKey(spec)}`;

/** Human label of a condition. Pure. */
export function describeCondition(spec: ConditionSpec): string {
  const slug = `${spec.owner}/${spec.repo}`;
  if (spec.kind === 'pr_merged') return `PR ${slug}#${spec.pullNumber} merged or closed`;
  if (spec.kind === 'deploy') return `deploy of ${slug}@${String(spec.sha).slice(0, 12)} concluded`;
  return `CI on ${slug}@${String(spec.sha).slice(0, 12)} finished`;
}

/**
 * Parse + validate the tool args against the session's repo. Pure.
 * `defaultRepo` = the session project's GitHub repo (null for a non-GitHub project).
 */
export function parseConditionArgs(args: any, defaultRepo: { owner: string; repo: string } | null): { ok: true; spec: ConditionSpec; timeoutSec: number } | { ok: false; error: string } {
  const kind = String(args?.condition ?? '').trim() as AwaitConditionKind;
  if (!AWAIT_CONDITION_KINDS.includes(kind)) return { ok: false, error: `Pass condition: one of ${AWAIT_CONDITION_KINDS.join(' | ')}.` };
  let owner = defaultRepo?.owner ?? '';
  let repo = defaultRepo?.repo ?? '';
  const repoArg = String(args?.repo ?? '').trim();
  if (repoArg) {
    const m = repoArg.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!m) return { ok: false, error: `Invalid repo "${repoArg}" — pass "owner/name".` };
    owner = m[1]; repo = m[2];
  }
  if (!owner || !repo) return { ok: false, error: 'No GitHub repo to watch: pass repo:"owner/name" or run this in a GitHub project session.' };
  const rawTimeout = Number(args?.timeoutSec);
  const timeoutSec = Number.isFinite(rawTimeout) ? Math.max(0, Math.min(AWAIT_CONDITION_MAX_SEC, Math.round(rawTimeout))) : AWAIT_CONDITION_MAX_SEC;
  if (kind === 'pr_merged') {
    const n = Number(args?.pullNumber);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'condition "pr_merged" needs pullNumber (a positive integer).' };
    return { ok: true, spec: { kind, owner, repo, pullNumber: n }, timeoutSec };
  }
  const sha = String(args?.sha ?? '').trim().toLowerCase();
  if (!SHA_RE.test(sha)) return { ok: false, error: `condition "${kind}" needs sha (7-40 hex) — the sha git_push / check_ci printed${kind === 'deploy' ? ', or the merge sha merge_pull_request printed' : ''}.` };
  return { ok: true, spec: { kind, owner, repo, sha }, timeoutSec };
}

/** A CI verdict → met? 'pending' never; 'none' only after the grace (checks register a few seconds after a push). Pure. */
export function evaluateCiProbe(ci: CiStatus, waitedMs: number, render: (sha: string, ci: CiStatus) => string, sha: string): ConditionProbe {
  const met = ci.state === 'success' || ci.state === 'failure' || (ci.state === 'none' && waitedMs >= AWAIT_CONDITION_NONE_GRACE_MS);
  return { met, summary: render(sha, ci).replace(/\s*\n\s*/g, ' · ').slice(0, 700), ciState: ci.state };
}

/** A pulls/<n> body → met? merged or closed. Pure. */
export function evaluatePrProbe(pr: any, spec: ConditionSpec): ConditionProbe {
  const slug = `${spec.owner}/${spec.repo}#${spec.pullNumber}`;
  if (pr?.merged === true || pr?.merged_at) {
    return { met: true, summary: `PR ${slug} is MERGED (merge sha ${String(pr?.merge_commit_sha ?? '').slice(0, 12) || 'unknown'}).` };
  }
  if (String(pr?.state ?? '') === 'closed') return { met: true, summary: `PR ${slug} was CLOSED without merging.` };
  return { met: false, summary: `PR ${slug} is still open (head ${String(pr?.head?.sha ?? '').slice(0, 12) || '?'}, mergeable_state ${String(pr?.mergeable_state ?? 'unknown')}).` };
}

/** The events a REAL deploy run starts from — a scheduled / workflow_run run carries the default-branch HEAD as head_sha and is never the deploy. */
export const DEPLOY_RUN_EVENTS: readonly string[] = ['push', 'workflow_dispatch'];

/**
 * Is this workflow run THE deploy of a sha? Review fix (2026-10-20): a name /
 * path regex also matched the instance's "Deployment Health Check" and
 * "Deploy Watchdog" (schedule + workflow_run runs, head_sha = the
 * default-branch HEAD = the merge sha right after a merge), so a FAILED deploy
 * read SUCCESS once the health check after it passed. Now only a push /
 * workflow_dispatch run counts, and on the instance's OWN repo only the
 * deploy workflow itself (DEPLOY_WORKFLOW_PATH, the red-window gate's source).
 * Pure.
 */
export function isDeployRun(r: any, ownRepo: boolean): boolean {
  if (!DEPLOY_RUN_EVENTS.includes(String(r?.event ?? ''))) return false;
  if (ownRepo) return String(r?.path ?? '') === DEPLOY_WORKFLOW_PATH;
  return /deploy/i.test(String(r?.path ?? '')) || /deploy/i.test(String(r?.name ?? ''));
}

const DEPLOY_FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const DEPLOY_OK = new Set(['success', 'neutral']);

/**
 * actions/runs?head_sha=<sha> → met? The DEPLOY run(s) for the sha
 * (isDeployRun) exist and the NEWEST run of each deploy workflow concluded;
 * the verdict is that run's own conclusion (several deploy workflows ⇒ the
 * worst one), never the newest run of any workflow. A cancelled / skipped run
 * is named as NOT a deploy of the sha (a newer wave usually superseded it). No
 * deploy run yet ⇒ not met (the run is created when the push lands on the
 * deploy branch). `ownRepoSlug` = the instance's own repo (deploy.yml only).
 * Pure.
 */
export function evaluateDeployProbe(runs: any[], spec: ConditionSpec, opts: { ownRepoSlug?: string | null } = {}): ConditionProbe {
  const sha12 = String(spec.sha ?? '').slice(0, 12);
  const own = !!opts.ownRepoSlug && `${spec.owner}/${spec.repo}`.toLowerCase() === String(opts.ownRepoSlug).toLowerCase();
  const deploys = (Array.isArray(runs) ? runs : []).filter((r) => isDeployRun(r, own));
  if (!deploys.length) return { met: false, summary: `No deploy workflow run exists for ${sha12} yet${own ? ` (${DEPLOY_WORKFLOW_PATH})` : ''}.` };
  // The newest run per deploy workflow (a re-dispatch on the same sha replaces an older verdict).
  const newest = new Map<string, any>();
  for (const r of deploys) {
    const k = String(r?.workflow_id ?? r?.path ?? r?.name ?? 'deploy');
    const cur = newest.get(k);
    const t = msOf(r?.created_at) || 0;
    const tc = cur ? (msOf(cur?.created_at) || 0) : -1;
    if (!cur || t > tc || (t === tc && Number(r?.id ?? 0) > Number(cur?.id ?? 0))) newest.set(k, r);
  }
  const heads = [...newest.values()];
  const open = heads.filter((r) => String(r?.status ?? '') !== 'completed');
  if (open.length) {
    const r = open[0];
    return { met: false, summary: `Deploy run ${r?.id ?? '?'}${r?.name ? ` (${r.name})` : ''} for ${sha12} is ${String(r?.status ?? 'running')}.` };
  }
  const rank = (r: any) => (DEPLOY_FAILED.has(String(r?.conclusion)) ? 2 : DEPLOY_OK.has(String(r?.conclusion)) ? 0 : 1);
  const verdict = [...heads].sort((a, b) => rank(b) - rank(a) || (msOf(b?.created_at) || 0) - (msOf(a?.created_at) || 0))[0];
  const conclusion = String(verdict?.conclusion ?? 'unknown');
  const where = `run ${verdict?.id ?? '?'}${verdict?.html_url ? ` ${verdict.html_url}` : ''}`;
  const per = heads.length > 1 ? `; per workflow: ${heads.map((r) => `${r?.name ?? r?.path ?? 'deploy'} ${String(r?.conclusion ?? 'unknown')}`).join(', ')}` : '';
  if (rank(verdict) === 1) {
    return {
      met: true,
      summary: `Deploy run for ${sha12} was ${conclusion.toUpperCase()} — NOT a completed deploy of this sha (${where}${per}). A cancelled deploy is usually superseded by a newer wave: that wave carries this change only if its sha descends from ${sha12} — read it before claiming the change is live.`,
    };
  }
  return {
    met: true,
    summary: `Deploy for ${sha12} CONCLUDED ${conclusion.toUpperCase()} (${where}${per})${rank(verdict) === 2 ? ' — this change is NOT live from this run' : ''}.`,
  };
}

/** The tool's met answer. Pure. */
export function renderConditionMetText(spec: ConditionSpec, probe: ConditionProbe, waitedMs: number): string {
  return `CONDITION MET (${describeCondition(spec)}; waited ${Math.round(waitedMs / 1000)}s harness-side, deadline-shielded): ${probe.summary}`;
}

/** The final-turn notice handed to the agent loop when the wait outlives the tool. Pure. */
export function renderEndTurnNotice(spec: ConditionSpec, horizonAt: Date): string {
  return `[HARNESS — WAITING ON A CONDITION] await_condition registered a CONDITION WAKE for: ${describeCondition(spec)}. `
    + `The harness re-checks it every ${Math.round(CONDITION_WAKE_RECHECK_MS / 60_000)} min and wakes this chat with [CONDITION MET — …] the moment it is met (backstop wake at ${hhmmz(horizonAt)} if it never is). `
    + 'Tools are off for this last turn: write a SHORT status — what you are waiting on and what you will do when it lands — and stop. Do not claim the awaited result.';
}

/** The tool's not-met answer (the run ends after it). Pure. */
export function renderNotMetText(spec: ConditionSpec, probe: ConditionProbe | null, waitedMs: number, horizonAt: Date): string {
  return `CONDITION NOT MET after ${Math.round(waitedMs / 1000)}s (${describeCondition(spec)})${probe ? ` — last read: ${probe.summary}` : ''}\n`
    + `Registered a CONDITION WAKE: the harness re-checks every ${Math.round(CONDITION_WAKE_RECHECK_MS / 60_000)} min and wakes this chat with [CONDITION MET — …]; backstop wake at ${hhmmz(horizonAt)}. `
    + 'This run is ending — write a one-line status and stop; do not poll.';
}

/** The lane's wake when the cron sees the condition met. Pure. */
export function renderConditionMetWake(rec: ConditionWakeRecord, probe: ConditionProbe, now: Date): string {
  const waitedMin = Math.max(0, Math.round((now.getTime() - (msOf(rec.createdAt) || now.getTime())) / 60_000));
  return `[CONDITION MET — ${describeCondition(rec.spec)}] ${probe.summary} `
    + `(you registered this wait with await_condition ${waitedMin} min ago; the harness checked it, no model steps were spent). Continue the task from here.`;
}

/** The backstop one-shot (delivered only when nothing woke the lane first). Pure. */
export function renderBackstopWake(spec: ConditionSpec, createdAt: Date, horizonAt: Date): string {
  return `[CONDITION WAIT — BACKSTOP] You registered await_condition at ${hhmmz(createdAt)} for: ${describeCondition(spec)}. `
    + `It was not reported met by ${hhmmz(horizonAt)} (or the watcher could not read it). Re-check it once yourself `
    + `(${spec.kind === 'pr_merged' ? 'a PR read' : spec.kind === 'deploy' ? 'the deploy run' : `check_ci sha "${String(spec.sha ?? '').slice(0, 12)}"`}) and decide: continue, fix, or report it blocked. `
    + 'If a [CONDITION MET] wake already reached you, ignore this one.';
}

// ── GitHub probes (side effects, injectable) ─────────────────────────────────

export interface ProbeDeps {
  fetchCiStatus?: (token: string, owner: string, repo: string, sha: string) => Promise<CiStatus>;
  renderCiStatus?: (sha: string, ci: CiStatus) => string;
  /** One GitHub GET (JSON). Throws on transport / HTTP errors. */
  ghGet?: (token: string, url: string) => Promise<any>;
  /** The instance's own repo slug ('' / null = none) — its deploy is deploy.yml only. */
  ownRepoSlug?: () => string | null;
  /** Resolve a (possibly short) sha to its full 40-hex form (ticket 0bc39100). Default resolveShaFull. */
  resolveSha?: (token: string, owner: string, repo: string, sha: string) => Promise<string>;
}

/**
 * Ticket 0bc39100 (2026-10-21): GitHub's actions `runs?head_sha=` filter
 * matches the FULL 40-hex sha only — a short sha (7-39 hex, what git_push /
 * check_ci / merge_pull_request print and models pass) returns an EMPTY run
 * list forever, so a registered 'deploy' condition wake probed "not met"
 * (checks: 86-87) through its whole horizon and every lane degraded to the
 * 3h backstop (prod 2026-10-21: 4/4 lanes, loop_metrics phase 'horizon' ×5
 — all short-sha; both 'met' rows were full-sha). `commits/{sha}/check-runs`
 (the 'ci' probe) resolves prefixes, so only the deploy branch needed this.
 * Resolve once per short sha (GET /commits/{sha} prefix-resolves ≥6 hex),
 * memoized in a bounded module cache shared by the in-tool wait and the cron
 * pass (a stored record keeps the model's sha; resolution is a probe detail).
 */
export interface ShaCache { map: Map<string, string> }

const shaCache: ShaCache = { map: new Map() };
const SHA_CACHE_MAX = 500;

const shaCacheKey = (owner: string, repo: string, sha: string): string => `${owner}/${repo}`.toLowerCase() + '@' + sha.toLowerCase();

/**
 * Resolve a sha to its full 40-hex form: a full sha passes through unchanged;
 * a short one (7-39 hex) is resolved via GET /repos/{o}/{r}/commits/{sha} and
 * memoized. Throws on transport / HTTP errors (the caller's error path —
 * classifyGithubError — handles 404/422 as not_found). Pure deps-injectable.
 */
export async function resolveShaFull(token: string, owner: string, repo: string, sha: string, deps: { ghGet?: (token: string, url: string) => Promise<any>; cache?: ShaCache } = {}): Promise<string> {
  const s = String(sha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(s)) throw Object.assign(new Error(`invalid sha "${String(sha).slice(0, 12)}"`), { invalidSha: true });
  if (s.length === 40) return s;
  const cache = deps.cache ?? shaCache;
  const k = shaCacheKey(owner, repo, s);
  const hit = cache.map.get(k);
  if (hit) return hit;
  const gh = deps.ghGet ?? defaultGhGet;
  const data = await gh(token, `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(s)}`);
  const full = String(data?.sha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(full)) throw Object.assign(new Error(`sha "${s}" did not resolve to a full sha`), { invalidSha: true });
  // Reviewer hardening (chat 16fb38fe, MINOR): /commits/{ref} also resolves
  // branch/tag NAMES — a hex-named ref shadowing the prefix must not resolve
  // the probe onto a different commit's deploy runs.
  if (!full.startsWith(s)) throw Object.assign(new Error(`sha "${s}" resolved to "${full}" which does not start with it`), { invalidSha: true });
  if (cache.map.size >= SHA_CACHE_MAX) {
    // Bounded: drop the oldest entry (Map preserves insertion order) — a
    // re-resolve is one extra GET, never a correctness loss.
    const oldest = cache.map.keys().next().value;
    if (oldest !== undefined) cache.map.delete(oldest);
  }
  cache.map.set(k, full);
  return full;
}

/** The instance's own repo (self-merge's ownRepoSlug — SELF_REPO, prod default). Never throws ('' on an isolation refusal). */
function defaultOwnRepoSlug(): string | null {
  try { return resolveInstanceOwnRepoSlug('SELF_REPO') || null; } catch { return null; }
}

async function defaultGhGet(token: string, url: string): Promise<any> {
  const axios = (await import('axios')).default;
  const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, timeout: 15_000 });
  return r.data;
}

/** ONE probe of a condition (one or two GitHub GETs). Throws on GitHub errors. */
export async function probeCondition(spec: ConditionSpec, token: string, waitedMs: number, deps: ProbeDeps = {}): Promise<ConditionProbe> {
  const gh = deps.ghGet ?? defaultGhGet;
  const base = `https://api.github.com/repos/${spec.owner}/${spec.repo}`;
  if (spec.kind === 'pr_merged') return evaluatePrProbe(await gh(token, `${base}/pulls/${spec.pullNumber}`), spec);
  if (spec.kind === 'deploy') {
    // The instance's own repo: read the deploy workflow's OWN runs (scheduled
    // watchdog / health-check runs pile up on the same head_sha and could push
    // the deploy run off a repo-wide page). Other repos: the repo-wide listing.
    const ownRepoSlug = (deps.ownRepoSlug ?? defaultOwnRepoSlug)();
    const own = !!ownRepoSlug && `${spec.owner}/${spec.repo}`.toLowerCase() === ownRepoSlug.toLowerCase();
    // Ticket 0bc39100: head_sha is an EXACT 40-hex filter — resolve a short sha
    // to its full form first (one memoized GET), or the listing reads empty
    // forever and the wake never meets.
    const resolve = deps.resolveSha ?? ((t, o, r, s) => resolveShaFull(t, o, r, s, { ghGet: deps.ghGet }));
    const full = await resolve(token, spec.owner, spec.repo, String(spec.sha));
    const sha = encodeURIComponent(full);
    const url = own
      ? `${base}/actions/workflows/${encodeURIComponent(DEPLOY_WORKFLOW_PATH.split('/').pop() as string)}/runs?head_sha=${sha}&per_page=30`
      : `${base}/actions/runs?head_sha=${sha}&per_page=100`;
    const data = await gh(token, url);
    return evaluateDeployProbe(Array.isArray(data?.workflow_runs) ? data.workflow_runs : [], spec, { ownRepoSlug });
  }
  const cs = deps.fetchCiStatus && deps.renderCiStatus ? null : await import('./ci-status');
  const fetchCi = deps.fetchCiStatus ?? cs!.fetchCiStatus;
  const render = deps.renderCiStatus ?? cs!.renderCiStatus;
  return evaluateCiProbe(await fetchCi(token, spec.owner, spec.repo, String(spec.sha)), waitedMs, render, String(spec.sha));
}

// ── condition-wake store + backstop (side effects, injectable) ───────────────

export interface ConditionWakeStore {
  get(key: string): Promise<ConditionWakeRecord | null>;
  put(key: string, rec: ConditionWakeRecord): Promise<void>;
  del(key: string): Promise<void>;
  list(limit: number): Promise<ConditionWakeRecord[]>;
}

export async function defaultConditionWakeStore(): Promise<ConditionWakeStore> {
  const cs = await import('../memory/context-store');
  return {
    get: (key) => cs.storeGet<ConditionWakeRecord>(CONDITION_WAKE_NS, key),
    put: (key, rec) => cs.storePut(CONDITION_WAKE_NS, key, rec as unknown as Record<string, unknown>),
    del: (key) => cs.storeDelete(CONDITION_WAKE_NS, key),
    list: async (limit) => (await cs.storeListNamespace<ConditionWakeRecord>(CONDITION_WAKE_NS, limit)).map((r) => r.value).filter((v) => v && typeof v === 'object' && (v as any).v === 1),
  };
}

export type DirectWake = (o: { targetChatId: string; prompt: string; meta?: Record<string, unknown>; notBefore?: Date | null }) => Promise<{ ok: boolean; hookEventId?: string; error?: string }>;

const defaultDirectWake: DirectWake = async (o) => (await import('../platform/hooks.service')).enqueueDirectWake(o);

/**
 * Suppress a still-PENDING backstop row (the condition was met / the lane
 * stopped) the way delivery-time revalidation does: status 'delivered' +
 * payload.suppressedAtDelivery. A row already delivering / delivered is left
 * alone (the backstop text tells the lane to ignore it). Never throws.
 */
export async function suppressBackstop(hookEventId: string | null | undefined, reason: string): Promise<boolean> {
  if (!hookEventId) return false;
  try {
    const row = await prisma.hookEvent.findUnique({ where: { id: hookEventId }, select: { status: true, payload: true } });
    if (!row || row.status !== 'pending') return false;
    const r = await prisma.hookEvent.updateMany({
      where: { id: hookEventId, status: 'pending' },
      data: { status: 'delivered', payload: { ...((row.payload as any) ?? {}), suppressedAtDelivery: reason } },
    });
    return r.count > 0;
  } catch (err: any) {
    logger.debug(`await-condition: backstop ${String(hookEventId).slice(0, 8)} not suppressed (${err?.message ?? err})`);
    return false;
  }
}

/**
 * Register (or refresh) a condition wake for a chat: the backstop one-shot is
 * enqueued FIRST — a wait with no backstop is never stored (a lane must never
 * be stranded). Never throws.
 */
export async function registerConditionWake(i: { chatId: string; userId: string; runId?: string | null; spec: ConditionSpec; lastSummary?: string | null }, deps: { store?: ConditionWakeStore; wake?: DirectWake; now?: Date } = {}): Promise<{ ok: true; record: ConditionWakeRecord; refreshed: boolean } | { ok: false; reason: 'cap' | 'backstop_failed' | 'store_error'; error?: string }> {
  const now = deps.now ?? new Date();
  try {
    const store = deps.store ?? await defaultConditionWakeStore();
    const key = conditionWakeKey(i.chatId, i.spec);
    const existing = await store.get(key);
    if (existing && existing.v === 1) {
      const refreshed: ConditionWakeRecord = { ...existing, nextCheckAt: new Date(now.getTime() + CONDITION_WAKE_RECHECK_MS).toISOString(), lastSummary: i.lastSummary ?? existing.lastSummary };
      await store.put(key, refreshed);
      return { ok: true, record: refreshed, refreshed: true };
    }
    try {
      const open = (await store.list(CONDITION_WAKE_LIST_CAP)).filter((r) => r.chatId === i.chatId);
      if (open.length >= CONDITION_WAKE_MAX_PER_CHAT) return { ok: false, reason: 'cap' };
    } catch { /* the cap is best-effort — an unreadable listing never blocks a wait */ }
    const horizonAt = new Date(now.getTime() + CONDITION_WAKE_HORIZON_MS[i.spec.kind]);
    const wake = deps.wake ?? defaultDirectWake;
    const backstop = await wake({
      targetChatId: i.chatId,
      prompt: renderBackstopWake(i.spec, now, horizonAt),
      meta: { origin: 'await-condition', wakeKind: 'condition_backstop', conditionKey: conditionKey(i.spec) },
      notBefore: horizonAt,
    }).catch((err: any) => ({ ok: false, error: String(err?.message ?? err) } as { ok: boolean; hookEventId?: string; error?: string }));
    if (!backstop?.ok) return { ok: false, reason: 'backstop_failed', error: backstop?.error };
    const record: ConditionWakeRecord = {
      v: 1,
      key,
      chatId: i.chatId,
      userId: i.userId,
      runId: i.runId ?? null,
      spec: i.spec,
      createdAt: now.toISOString(),
      horizonAt: horizonAt.toISOString(),
      nextCheckAt: new Date(now.getTime() + CONDITION_WAKE_RECHECK_MS).toISOString(),
      checks: 0,
      errors: 0,
      backstopHookEventId: backstop.hookEventId ?? null,
      lastSummary: i.lastSummary ?? null,
    };
    try {
      await store.put(key, record);
    } catch (err: any) {
      // The backstop alone still wakes the lane at the horizon — never stranded.
      return { ok: false, reason: 'store_error', error: String(err?.message ?? err) };
    }
    return { ok: true, record, refreshed: false };
  } catch (err: any) {
    return { ok: false, reason: 'store_error', error: String(err?.message ?? err) };
  }
}

// ── the tool ─────────────────────────────────────────────────────────────────

let waitSlotsHeld = 0;
/** Test hook. */
export function awaitConditionSlotsInUse(): number { return waitSlotsHeld; }

export interface AwaitConditionCtx {
  sessionId: string;
  userId: string;
  runId?: string | null;
  repoUrl?: string;
  provider?: string;
  getGithubToken?: () => Promise<string | null>;
  onShieldedWait?: (ms: number, opts?: { queued?: boolean }) => void;
  requestEndTurn?: (notice: string) => void;
}

export interface AwaitConditionDeps extends ProbeDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  store?: ConditionWakeStore;
  wake?: DirectWake;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Execute await_condition. Returns the tool result text; never throws. On a
 * registered wake it calls ctx.requestEndTurn (the agent loop ends the run
 * with a tools-off final turn and no continuation).
 */
export async function executeAwaitCondition(ctx: AwaitConditionCtx, args: any, deps: AwaitConditionDeps = {}): Promise<string> {
  if (awaitConditionDisabled()) {
    return 'await_condition is disabled (AWAIT_CONDITION_DISABLED=1) — read the state once (check_ci, a PR read) and, if it is not ready, arm a later re-check with schedule_self instead of polling.';
  }
  const repoArg = String(args?.repo ?? '').trim();
  if (!repoArg && ctx.repoUrl && !repoTargetAllowed(ctx.repoUrl)) return isolationRefusal(ctx.repoUrl);
  const defaultRepo = ctx.provider === 'github' || /github\.com/i.test(String(ctx.repoUrl ?? '')) ? parseGithubRepo(ctx.repoUrl) : null;
  const parsed = parseConditionArgs(args, defaultRepo);
  if (!parsed.ok) return parsed.error;
  const { spec, timeoutSec } = parsed;
  const slug = `${spec.owner}/${spec.repo}`;
  if (!repoTargetAllowed(slug)) return isolationRefusal(slug);
  const token = ctx.getGithubToken ? await ctx.getGithubToken().catch(() => null) : null;
  if (!token) return 'No connected GitHub account/token — connect GitHub in Settings → Integrations.';

  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const t0 = now();
  const haveSlot = waitSlotsHeld < AWAIT_CONDITION_MAX_CONCURRENT;
  if (haveSlot) waitSlotsHeld += 1;
  const budgetMs = haveSlot ? timeoutSec * 1000 : 0;
  let last: ConditionProbe | null = null;
  let errors = 0;
  let polls = 0;
  try {
    for (;;) {
      polls += 1;
      try {
        last = await probeCondition(spec, token, now() - t0, deps);
        errors = 0;
      } catch (err: any) {
        errors += 1;
        const g = classifyGithubError(err);
        if (g.kind === 'not_found' || g.kind === 'forbidden' || errors >= AWAIT_CONDITION_MAX_TOOL_ERRORS) {
          recordLoopMetric({ kind: LOOP_METRIC_KINDS.AWAIT_CONDITION, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined, meta: { phase: 'tool_error', condition: spec.kind, repo: slug, status: g.status, polls } });
          return `await_condition could not read the condition (${describeCondition(spec)}): GitHub ${g.status ? `answered ${g.status}` : 'was unreachable'}${g.kind === 'not_found' ? ' — check the sha / PR number and the repo' : ''}. Nothing was registered — read it once with check_ci (or a PR read) and decide.`;
        }
      }
      const waited = now() - t0;
      if (last?.met) {
        recordLoopMetric({ kind: LOOP_METRIC_KINDS.AWAIT_CONDITION, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined, meta: { phase: 'met_in_tool', condition: spec.kind, repo: slug, waitedMs: waited, polls } });
        return renderConditionMetText(spec, last, waited);
      }
      const remaining = budgetMs - waited;
      if (remaining <= 0) break;
      const slice = Math.min(AWAIT_CONDITION_POLL_MS, remaining);
      const s0 = now();
      await sleep(slice);
      try { ctx.onShieldedWait?.(Math.max(0, now() - s0)); } catch { /* the deadline shield is best-effort */ }
    }
  } finally {
    if (haveSlot) waitSlotsHeld = Math.max(0, waitSlotsHeld - 1);
  }

  const waitedMs = now() - t0;
  const reg = await registerConditionWake({ chatId: ctx.sessionId, userId: ctx.userId, runId: ctx.runId ?? null, spec, lastSummary: last?.summary ?? null }, { store: deps.store, wake: deps.wake });
  if (!reg.ok) {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.AWAIT_CONDITION, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined, meta: { phase: 'register_failed', condition: spec.kind, repo: slug, reason: reg.reason, waitedMs, polls } });
    return reg.reason === 'cap'
      ? `CONDITION NOT MET after ${Math.round(waitedMs / 1000)}s (${describeCondition(spec)}) — and this chat already holds ${CONDITION_WAKE_MAX_PER_CHAT} open condition wakes, so no new one was registered. Continue with other work and re-read it later (check_ci / a PR read).`
      : `CONDITION NOT MET after ${Math.round(waitedMs / 1000)}s (${describeCondition(spec)}) — and the harness could not register a wake (${reg.error ?? reg.reason}). Arm a re-check with schedule_self instead; do not poll.`;
  }
  const horizonAt = new Date(reg.record.horizonAt);
  recordLoopMetric({ kind: LOOP_METRIC_KINDS.AWAIT_CONDITION, sessionId: ctx.sessionId, runId: ctx.runId ?? undefined, meta: { phase: reg.refreshed ? 'refreshed' : 'registered', condition: spec.kind, repo: slug, waitedMs, polls, slot: haveSlot, horizonAt: reg.record.horizonAt } });
  try { ctx.requestEndTurn?.(renderEndTurnNotice(spec, horizonAt)); } catch { /* the run simply continues — the text still says to stop */ }
  return renderNotMetText(spec, last, waitedMs, horizonAt);
}

// ── the cron pass over registered wakes ──────────────────────────────────────

export interface LaneFacts {
  userId: string;
  archived: boolean;
  githubLabel: string | null;
  /** The lane's newest run (`id` lets a merge intent scope a stop to the run that queued it). */
  lastRun: { id?: string | null; status: string | null; error: string | null; at: Date | null } | null;
}

export interface ConditionPassDeps extends ProbeDeps {
  now?: Date;
  store?: ConditionWakeStore;
  wake?: DirectWake;
  loadLane: (chatId: string) => Promise<LaneFacts | null>;
  getToken: (userId: string, label: string | null) => Promise<string | null>;
  suppress?: (hookEventId: string | null, reason: string) => Promise<boolean>;
  /** Wake keys (`<chatId>:<conditionKey>`) another wake already covered this pass (a merge intent's MERGED / BLOCKED wake covers pr_merged). */
  covered?: ReadonlySet<string>;
  /** Book a red-CI met wake with ci-watch (default ci-watch noteHarnessRedWake): 'loop' ⇒ do not wake the lane. */
  noteRedWake?: RedWakeBooker;
  maxPerPass?: number;
}

/** ci-watch's booking of a harness red-CI outcome wake (ci-watch.service noteHarnessRedWake). */
export type RedWakeBooker = (i: { chatId: string; sha: string; branch?: string | null; via: string }) => Promise<'deliver' | 'loop'>;

export interface ConditionPassCounters { open: number; checked: number; met: number; waiting: number; dropped: number; errors: number; rateLimited: number }

/** The lane stopped AFTER the wait was registered (an explicit stop — stop means stop). Pure. */
export function stoppedSince(lane: LaneFacts, sinceIso: string): boolean {
  if (!lane.lastRun || !isExplicitStop(lane.lastRun)) return false;
  const since = msOf(sinceIso);
  const at = lane.lastRun.at ? lane.lastRun.at.getTime() : NaN;
  return !Number.isFinite(since) || !Number.isFinite(at) || at >= since;
}

/** One pass over the registered condition wakes. Never throws. */
export async function runConditionWakesPass(deps: ConditionPassDeps): Promise<ConditionPassCounters> {
  const c: ConditionPassCounters = { open: 0, checked: 0, met: 0, waiting: 0, dropped: 0, errors: 0, rateLimited: 0 };
  if (awaitConditionDisabled()) return c;
  const now = deps.now ?? new Date();
  let store: ConditionWakeStore;
  let rows: ConditionWakeRecord[];
  try {
    store = deps.store ?? await defaultConditionWakeStore();
    rows = await store.list(CONDITION_WAKE_LIST_CAP);
  } catch (err: any) {
    logger.warn(`await-condition: listing condition wakes failed (next pass retries): ${err?.message ?? err}`);
    return c;
  }
  c.open = rows.length;
  const wake = deps.wake ?? defaultDirectWake;
  const suppress = deps.suppress ?? suppressBackstop;
  const metric = (rec: ConditionWakeRecord, phase: string, extra: Record<string, unknown> = {}) => recordLoopMetric({
    kind: LOOP_METRIC_KINDS.AWAIT_CONDITION, sessionId: rec.chatId,
    meta: { phase, condition: rec.spec.kind, repo: `${rec.spec.owner}/${rec.spec.repo}`, key: rec.key, checks: rec.checks, ...extra },
  });
  const drop = async (rec: ConditionWakeRecord, phase: string, suppressReason: string | null, extra: Record<string, unknown> = {}) => {
    if (suppressReason) await suppress(rec.backstopHookEventId, suppressReason).catch(() => false);
    await store.del(rec.key).catch(() => {});
    if (phase !== 'met') c.dropped += 1; // a met wake is a resolution, not a drop
    metric(rec, phase, extra);
  };
  const tokens = new Map<string, string | null>();
  const due = rows
    .filter((r) => r && r.v === 1 && (!Number.isFinite(msOf(r.nextCheckAt)) || msOf(r.nextCheckAt) <= now.getTime() || deps.covered?.has(r.key)))
    .sort((a, b) => (msOf(a.nextCheckAt) || 0) - (msOf(b.nextCheckAt) || 0))
    .slice(0, Math.max(1, deps.maxPerPass ?? CONDITION_WAKE_MAX_PER_PASS));
  for (const rec of due) {
    try {
      if (deps.covered?.has(rec.key)) { await drop(rec, 'covered', 'covered_by_merge_intent'); continue; }
      if (now.getTime() >= (msOf(rec.horizonAt) || 0)) { await drop(rec, 'horizon', null); continue; } // the backstop delivers itself
      const lane = await deps.loadLane(rec.chatId);
      if (!lane) { await drop(rec, 'lane_gone', 'lane_gone'); continue; }
      if (lane.archived) { await drop(rec, 'lane_archived', 'lane_archived'); continue; }
      if (stoppedSince(lane, rec.createdAt)) { await drop(rec, 'lane_stopped', 'lane_stopped'); continue; }
      const tk = `${lane.userId}|${lane.githubLabel ?? ''}`;
      if (!tokens.has(tk)) tokens.set(tk, await deps.getToken(lane.userId, lane.githubLabel).catch(() => null));
      const token = tokens.get(tk);
      c.checked += 1;
      let probe: ConditionProbe;
      if (!token) {
        throw Object.assign(new Error('no GitHub token for the lane owner'), { noToken: true });
      }
      try {
        probe = await probeCondition(rec.spec, token, now.getTime() - (msOf(rec.createdAt) || now.getTime()), deps);
      } catch (err: any) {
        const g = classifyGithubError(err, now);
        if (g.kind === 'rate_limited') {
          c.rateLimited += 1;
          await store.put(rec.key, { ...rec, nextCheckAt: new Date(now.getTime() + g.retryAfterMs).toISOString() }).catch(() => {});
          if (c.rateLimited >= 2) break;
          continue;
        }
        throw err;
      }
      if (probe.met) {
        // r3 interactions fix (2026-10-20): a 'ci' wait met RED is the lane's
        // ONE wake about that sha (booked with ci-watch, which then adds none);
        // once the lane's red-fix loop budget is spent ci-watch escalates the
        // loop instead — no lane wake here, and (r3 lane-merge review fix) no
        // backstop either: 'loop' needs a sha ci-watch still watches, so its
        // escalation follows; the backstop's "decide: continue, fix" wake would
        // re-enter the loop the supervisor owns.
        if (rec.spec.kind === 'ci' && probe.ciState === 'failure') {
          const book: RedWakeBooker = deps.noteRedWake ?? ((i) => noteHarnessRedWake(i, { now }));
          if (await book({ chatId: rec.chatId, sha: String(rec.spec.sha ?? ''), via: 'await_condition' }).catch(() => 'deliver' as const) === 'loop') {
            await drop(rec, 'loop_handoff', 'condition_loop_handoff');
            continue;
          }
        }
        const res = await wake({
          targetChatId: rec.chatId,
          prompt: renderConditionMetWake(rec, probe, now),
          meta: { origin: 'await-condition', wakeKind: 'condition_met', conditionKey: conditionKey(rec.spec) },
        }).catch((err: any) => ({ ok: false, error: String(err?.message ?? err) } as { ok: boolean; hookEventId?: string; error?: string }));
        if (!res?.ok) {
          // Nothing queued: keep the row and retry next pass (the backstop still covers the horizon).
          c.errors += 1;
          await store.put(rec.key, { ...rec, nextCheckAt: new Date(now.getTime() + CONDITION_WAKE_RECHECK_MS).toISOString(), lastSummary: probe.summary }).catch(() => {});
          continue;
        }
        c.met += 1;
        await drop(rec, 'met', 'condition_met', { waitedMs: now.getTime() - (msOf(rec.createdAt) || now.getTime()), hookEventId: res.hookEventId ?? null });
        continue;
      }
      c.waiting += 1;
      await store.put(rec.key, { ...rec, checks: rec.checks + 1, errors: 0, lastSummary: probe.summary, nextCheckAt: new Date(now.getTime() + CONDITION_WAKE_RECHECK_MS).toISOString() });
    } catch (err: any) {
      c.errors += 1;
      const errorsNow = (rec.errors ?? 0) + 1;
      if (errorsNow >= CONDITION_WAKE_MAX_ERRORS) {
        await drop(rec, 'unobservable', null, { error: String(err?.message ?? err).slice(0, 160) }); // the backstop still wakes the lane at the horizon
      } else {
        await store.put(rec.key, { ...rec, errors: errorsNow, nextCheckAt: new Date(now.getTime() + 2 * CONDITION_WAKE_RECHECK_MS).toISOString() }).catch(() => {});
      }
    }
  }
  return c;
}

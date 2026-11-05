/**
 * Digby Code — per-session Docker container execution.
 *
 * When CODING_CONTAINER_MODE=1 AND the Docker socket is reachable, each session
 * gets its own long-lived container; shell tools (run_command/glob/grep) execute
 * INSIDE it via `docker exec`, isolating agent-run code from the backend. The
 * session's git worktree is visible because the container mounts the SAME
 * `coding_workspaces` named volume the backend uses, and we cd into the
 * worktree path.
 *
 * SAFETY / GRACEFUL DEGRADATION: this is best-effort. If container mode is off,
 * the socket is missing, the image can't be pulled, or `docker run` fails for a
 * session, callers fall back to in-process execution (isContainerReady returns
 * false). Enabling the feature therefore cannot break the working path.
 *
 * IDLE REAPER: containers whose session hasn't been touched (session.updatedAt)
 * in >24h are stopped + removed. A container is cheap to recreate on next use.
 *
 * NOTE: this requires the backend to reach the host Docker daemon (socket mount)
 * — a privileged capability. Single-tenant infra only.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { CODING_WORKSPACE_ROOT } from './workspace.service';
import { clearProcessRegistry } from './process.service';
// build 2026-10-08 ISO — per-user workspace subtree (isolation.md option A).
import {
  resolveSandboxHomeSync, volumeSubpathOf, pathSubtreeKey, subtreeRoot, subtreeSandboxHomesRoot,
  legacyWorktreePath, legacySandboxHome, isMigratedCompatLinkSync, perUserSubtreeAppliesTo,
  perUserSubtreeSetting, mirrorOfWorktreeSync, listSubtreeKeysSync, resolveWorktreePathSync, resolveMirrorPathSync,
} from './workspace-layout';
import { recordIsolationMetric } from './workspace-placement';
import { SESSION_USER_SCRIPT } from './session-user-row';
// ticket c25f8b7e: durable per-session container identity (survives the swap it
// describes — it lives on the coding_session_env volume, never in a container).
import {
  recordContainerIdentity, forgetContainerIdentity,
  type ContainerReplacement,
} from './container-identity';

/** ISO telemetry from this module: only once the per-user switch is on (or for
 *  a session already placed per-user) — the switch off adds no rows. */
function isoMetric(phase: string, meta: Record<string, unknown>, sessionId: string): void {
  if (perUserSubtreeSetting().mode === 'off' && meta.layout !== 'per_user') return;
  recordIsolationMetric(phase, meta, sessionId);
}

const execFileAsync = promisify(execFile);

const CONTAINER_MODE = process.env.CODING_CONTAINER_MODE === '1';
/** True when session runs are meant to be isolated in per-session containers.
 *  When true, the in-process shell fallback must FAIL CLOSED (never run arbitrary
 *  agent/repo code inside the backend container, which holds every secret + tenant). */
export function isContainerMode(): boolean { return CONTAINER_MODE; }

/**
 * May a session command run as plain bash ON THIS HOST when its container is
 * unavailable? Only when container isolation is OFF (dev / test / self-hosted
 * without CODING_CONTAINER_MODE). In container mode the answer is NO — the
 * agent's shell already fails closed (agent.ts execShell); the dependency
 * install at provision and the live preview's curl used to fall back to
 * in-worker bash instead (2026-10-20 review of #1717 — on a web box, where
 * the probe is skipped by design, that was EVERY call).
 * CODING_HOST_EXEC_FAIL_CLOSED_DISABLED=1 restores the old fallback.
 */
export function hostExecFallbackAllowed(envSource: NodeJS.ProcessEnv = process.env): boolean {
  if (!CONTAINER_MODE) return true;
  return envSource.CODING_HOST_EXEC_FAIL_CLOSED_DISABLED === '1';
}
const RUNNER_IMAGE = process.env.CODING_RUNNER_IMAGE || 'node:20';
const VOLUME_NAME = process.env.CODING_WORKSPACE_VOLUME || 'crossmodel_coding_workspaces';
const IDLE_MS = 24 * 60 * 60 * 1000; // 1 day
const LABEL = 'digby.code.session';

let dockerAvailable: boolean | null = null;
let dockerProbedAt = 0;
/**
 * A NEGATIVE Docker probe is re-tried after this long (autonomy loop #16,
 * 2026-09-21). It used to be memoized for the PROCESS LIFETIME: box A's new
 * colour probed C's docker-proxy during the 07:00Z deploy wave, got
 * "Cannot connect to the Docker daemon at tcp://10.0.0.15:2375", and every
 * container op from that backend then failed closed until the next deploy
 * (07:00 and 07:30 blips). A positive probe is re-checked after
 * DOCKER_POSITIVE_MEMO_MS so a later daemon outage fails closed
 * (ticket 7eb2aa51).
 */
export const DOCKER_NEGATIVE_MEMO_MS = 30_000;

/** A successful probe is trusted only this long, then one re-probe
 *  re-checks the daemon. A miss still fails closed — never an in-process
 *  fallback (ticket 7eb2aa51). */
export const DOCKER_POSITIVE_MEMO_MS = 60_000;

/** Quiet retries before the first "Docker not available" warn on a process
 *  that has never probed. Deploy waves start several processes in the same
 *  minute and the daemon often answers on the 2nd–4th try (ticket 7eb2aa51). */
export const DOCKER_STARTUP_PROBE_ATTEMPTS = 4;
const DOCKER_STARTUP_PROBE_DELAYS_MS = [0, 50, 150, 400] as const;

/** Delay before startup attempt `attempt` (0-based). 0 under NODE_ENV=test
 *  so unit tests never sleep. */
export function dockerProbeStartupDelayMs(attempt: number): number {
  if (process.env.NODE_ENV === 'test') return 0;
  const table = DOCKER_STARTUP_PROBE_DELAYS_MS;
  const i = Math.max(0, Math.min(attempt, table.length - 1));
  return table[i];
}

async function startupPause(attempt: number): Promise<void> {
  const delay = dockerProbeStartupDelayMs(attempt);
  if (delay <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delay));
}
// Sessions we've already failed to containerize — don't retry every command.
// Loop #16: the memo EXPIRES (was forever): a `docker create` that failed
// during a proxy blip must not pin the session to the fail-closed path for
// the rest of the process.
export const FAILED_SESSION_MEMO_MS = 5 * 60_000;
const failedSessions = new Map<string, number>();
function sessionRecentlyFailed(sessionId: string): boolean {
  const at = failedSessions.get(sessionId);
  if (at === undefined) return false;
  if (Date.now() - at < FAILED_SESSION_MEMO_MS) return true;
  failedSessions.delete(sessionId);
  return false;
}
/** Test seam: forget every Docker/session memo. */
export function __resetDockerAvailabilityForTest(): void { dockerAvailable = null; dockerProbedAt = 0; failedSessions.clear(); probeSkipNoticed = false; }

let probeSkipNoticed = false;
/**
 * Why this process does NOT probe Docker (null = it probes). A cron-only /
 * web-tier process (`CODING_WORKER_CONCURRENCY=0` — the box A workers) or an
 * explicitly labelled one (`CODING_CONTAINER_PROBE_DISABLED=1`, the box A/B
 * backends) has no daemon by design since the coding plane moved to its own
 * box: session commands route to the coding box over Redis, so a probe there
 * can only fail, and its "fail closed" warn re-fired on every blue/green
 * process start (47 rows / 7 d, none a real outage). Boxes with worker slots
 * keep the probe + warn byte-for-byte. Pure — exported for tests.
 */
export function dockerProbeSkipReason(envSource: NodeJS.ProcessEnv = process.env): string | null {
  if (envSource.CODING_CONTAINER_PROBE_DISABLED === '1') return 'CODING_CONTAINER_PROBE_DISABLED=1';
  const raw = (envSource.CODING_WORKER_CONCURRENCY ?? '').trim();
  if (raw !== '' && Number(raw) === 0) return 'CODING_WORKER_CONCURRENCY=0 (cron-only / web tier)';
  return null;
}

function containerName(sessionId: string): string {
  return `digby-code-${sessionId.slice(0, 12)}`;
}

// ── Shared tailnet dev container (owner decision 2026-08-22, 3ba5d35d) ───────
// When the session OWNER enabled the shared dev container AND it came up
// tailnet-joined, the session's commands run THERE instead of a per-session
// container. Per-process map (each process resolves in its own
// ensureSessionContainer call); absence = the classic per-session path — the
// shared container can degrade a session to fallback, never break it.
const sharedOverride = new Map<string, string>(); // sessionId → dev-container name
// Per-session egress grant (ticket 4ed6eb2e): sessionId → the credentialed
// per-session proxy URL to inject as DIGBY_TAILNET_PROXY. Populated when the
// session resolves the shared container; absent = legacy/no injection.
const egressGrants = new Map<string, string>();
// Sessions whose SHARED container target just answered "No such container"
// (ticket e2f40d10 review). Set on the exec path, consumed once by
// ensureSessionContainer to invalidate dev-container.service's per-user health
// memo — without it a reaped dev container is re-resolved from a warm memo to
// the same dead name and the rebind retries into the same wall.
const sharedVanished = new Map<string, true>();

/** The container a session's exec actually targets (shared override or per-session). */
function execTargetName(sessionId: string): string {
  return sharedOverride.get(sessionId) ?? containerName(sessionId);
}

/** Every RUNNING container's reap-relevant labels, one `docker ps` read.
 *  Never throws: an unreadable daemon yields [] so the caller keeps today's
 *  answer instead of failing the reap. Only RUNNING containers can host
 *  processes worth reaping, so a stopped one is not a target. */
async function runningContainerLabels(): Promise<Array<{ name: string; session: string; dev: string }>> {
  try {
    // The label NAMES are interpolated from the same constants the create path
    // emits, so a rename can never silently turn this read into a no-op. The
    // dev-container label lives in dev-container.service, which is imported
    // dynamically (kept out of this module's static graph for tests) — hence
    // the literal, kept byte-identical to its DEV_LABEL.
    const devLabel = 'digby.dev.container';
    const out = await docker(['ps', '--format', `{{.Names}}\t{{.Label "${LABEL}"}}\t{{.Label "${devLabel}"}}`], 15_000);
    return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, session, dev] = l.split('\t');
      return { name: name || '', session: session || '', dev: dev || '' };
    }).filter((r) => r.name);
  } catch { return []; }
}

/**
 * THE REAP TARGET — resolved from the daemon's own labels, not from the
 * in-process `sharedOverride` map alone (ticket 4bb6a68a).
 *
 * `execTargetName` answers from a map populated ONLY by the process that ran
 * `ensureSessionContainer` for this session. A reap running in another process
 * (a different worker, or this one after a deploy) has a COLD map, so it falls
 * back to `digby-code-<sid12>` — a container that exists only for sessions that
 * did NOT get the shared dev container. For a session that DID, that name has
 * never existed: the reap execs a phantom, throws "No such container", logs a
 * warning and silently reaps NOTHING. The leaked background processes then pin
 * the shared container's cgroup, and the NEXT run's verify is SIGKILLed (exit
 * 137, empty output) — the orphan doctrine at `reapOrphanedBuildProcesses`.
 * Production showed exactly this for 8+ sessions, f7e14cf8 included, at
 * 07:31:52Z and 08:31:48Z on 2026-11-03.
 *
 * Both facts are durable in the daemon: a per-session container carries
 * `digby.code.session=<full session id>`, the shared one carries
 * `digby.dev.container=<userId>`. The warm map is still consulted first (free,
 * and it wins when the daemon read fails); the label scan only ever ADDS a real
 * target, never invents one — no match returns the pre-existing fallback.
 */
async function resolveReapTarget(
  sessionId: string,
  pre?: { rows?: Array<{ name: string; session: string; dev: string }>; userId?: string | null },
): Promise<{ name: string; shared: boolean }> {
  const warm = sharedOverride.get(sessionId);
  if (warm) return { name: warm, shared: true };
  const fallback = { name: containerName(sessionId), shared: false };
  // A sweep resolves MANY sessions: the caller passes one label read (and one
  // user-id read) instead of paying a `docker ps` + a findUnique per session.
  const rows = pre?.rows ?? await runningContainerLabels();
  if (!rows.length) return fallback;
  const own = rows.find((r) => r.session === sessionId);
  if (own) return { name: own.name, shared: false };
  // The session may live in its owner's shared dev container (one per user).
  const userId: string | null = pre && 'userId' in pre
    ? (pre.userId ?? null)
    : await prisma.chatCodingState
      .findUnique({ where: { id: sessionId }, select: { userId: true } })
      .then((r: any) => r?.userId ?? null)
      .catch(() => null);
  if (!userId) return fallback;
  const shared = rows.find((r) => r.dev === userId);
  if (shared) return { name: shared.name, shared: true };
  return fallback;
}

// ── Whole-volume exposure (audit 2026-10-06 T7-7) ────────────────────────────
// Sessions whose shell can see the WHOLE workspace volume (every user's
// worktrees + every project's mirror): the shared dev container (it mounts the
// volume whole — no per-user volume layout exists) and a per-session container
// that fell back to the whole-volume mount (created here, or found running
// with that mount). The run_command workspace-scope guard
// (workspace-path-guard.ts) keys on this; scoped containers cannot see other
// sessions, so the guard stays out of their way.
// build 2026-10-08 ISO: 'user_subtree' = the shell sees ONE user's subtree
// (a dev container mounted per-user, or a per-user session's subtree fallback)
// — never another tenant's data, so the guard runs OBSERVE-ONLY there.
export type WorkspaceExecExposure = 'dev_container' | 'whole_volume' | 'user_subtree';
const wholeVolumeContainers = new Set<string>(); // per-session container names known to mount the whole volume
const userSubtreeContainers = new Set<string>(); // … known to mount one user's subtree (ISO fallback)
const scopedContainers = new Set<string>();      // … known to be scoped
const sharedExposure = new Map<string, WorkspaceExecExposure>(); // sessionId → exposure of its shared dev container
/** null = this session's shell cannot see other sessions (scoped container / not resolved here). */
export function workspaceExecExposure(sessionId: string): WorkspaceExecExposure | null {
  if (sharedOverride.has(sessionId)) return sharedExposure.get(sessionId) ?? 'dev_container';
  const name = containerName(sessionId);
  if (wholeVolumeContainers.has(name)) return 'whole_volume';
  return userSubtreeContainers.has(name) ? 'user_subtree' : null;
}
/** Mount destinations of a container (docker inspect), or null when unknown. Never throws. */
export async function containerMountDestinations(name: string): Promise<string[] | null> {
  try {
    const out = await docker(['inspect', '-f', '{{range .Mounts}}{{.Destination}}|{{end}}', name], 15_000);
    return out.split('|').map((d) => d.trim()).filter(Boolean);
  } catch { return null; }
}
/** Memoized mount probe for a container this process did not create (a pre-deploy one). Never throws. */
async function noteContainerMountMode(name: string): Promise<void> {
  if (wholeVolumeContainers.has(name) || scopedContainers.has(name) || userSubtreeContainers.has(name)) return;
  const dests = await containerMountDestinations(name);
  if (!dests) return; /* unknown — treated as scoped (the prior posture) */
  if (dests.includes(CODING_WORKSPACE_ROOT)) wholeVolumeContainers.add(name);
  else if (dests.some((d) => { const k = pathSubtreeKey(d, CODING_WORKSPACE_ROOT); return !!k && d === subtreeRoot(k, CODING_WORKSPACE_ROOT); })) userSubtreeContainers.add(name);
  else scopedContainers.add(name);
}

/**
 * build 2026-10-08 ISO: can this dev container's mounts reach the session's
 * worktree AND the mirror it points at? A whole-volume dev container covers
 * everything (today); a subtree-mounted one covers only its user's subtree +
 * the mirrors mounted one by one. Unknown mounts (inspect failed) → covered
 * (today's posture). Exported for tests.
 */
export function devContainerCovers(dests: string[] | null, worktree: string, mirror: string | null): { wholeVolume: boolean; covered: boolean } {
  if (!dests) return { wholeVolume: true, covered: true };
  if (dests.includes(CODING_WORKSPACE_ROOT)) return { wholeVolume: true, covered: true };
  const under = (p: string) => dests.some((d) => p === d || p.startsWith(`${d}/`));
  return { wholeVolume: false, covered: under(worktree) && (!mirror || under(mirror)) };
}

async function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return stdout.toString();
}

/** Is the Docker daemon reachable? A positive probe is re-checked after
 *  DOCKER_POSITIVE_MEMO_MS; a negative one after DOCKER_NEGATIVE_MEMO_MS.
 *  The first probe (never probed) retries quietly before warning. A miss
 *  fails closed — session commands never run in-process. */
export async function isDockerAvailable(): Promise<boolean> {
  if (!CONTAINER_MODE) return false;
  if (dockerAvailable === true && Date.now() - dockerProbedAt < DOCKER_POSITIVE_MEMO_MS) return true;
  const skip = dockerProbeSkipReason();
  if (skip) {
    if (!probeSkipNoticed) {
      probeSkipNoticed = true;
      logger.info(`coding container: Docker probe skipped on this process (${skip}) — no daemon here by design; session commands route to the coding box over Redis`);
    }
    return false;
  }
  if (dockerAvailable === false && Date.now() - dockerProbedAt < DOCKER_NEGATIVE_MEMO_MS) return false;
  const wasDown = dockerAvailable === false;
  // A previously-HEALTHY daemon gets one quiet retry on its memo re-probe
  // (2026-10-20): a single blip must not mark Docker down for 30 s and fail
  // every session command closed. DOCKER_REPROBE_RETRY_DISABLED=1 = one try.
  const attempts = dockerAvailable === null
    ? DOCKER_STARTUP_PROBE_ATTEMPTS
    : (dockerAvailable === true && process.env.DOCKER_REPROBE_RETRY_DISABLED !== '1' ? 2 : 1);
  let lastErr: { message?: string } | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await startupPause(attempt);
    try {
      await docker(['info', '--format', '{{.ServerVersion}}'], 10_000);
      dockerAvailable = true;
      dockerProbedAt = Date.now();
      if (wasDown) logger.info('coding container: Docker reachable again — container execution restored');
      return true;
    } catch (err: any) {
      lastErr = err;
    }
  }
  // In container mode the "in-process" path FAILS CLOSED (isContainerMode) —
  // say what actually happens. Logged once per outage, not per re-probe.
  if (!wasDown) logger.warn(`coding container: Docker not available (${lastErr?.message}) — session commands fail closed until it answers; re-probing every ${Math.round(DOCKER_NEGATIVE_MEMO_MS / 1000)} s`);
  dockerAvailable = false;
  dockerProbedAt = Date.now();
  return false;
}

// build 2026-10-08 ISO: where the session's worktree IS (dual-read — the
// legacy `${CODING_WORKSPACE_ROOT}/worktrees/<id>` unless it lives in a per-user subtree).
const WORKTREE_DIR = (sessionId: string) => resolveWorktreePathSync(sessionId, CODING_WORKSPACE_ROOT);

/** Per-session durable HOME on the workspace volume (ticket e267b760, 2026-08-24).
 *  Runners used HOME=/tmp — the sandbox /tmp is wiped aggressively (probe: a file
 *  written by one command is gone ~2 min later, no deploy needed) and recreated
 *  on every deploy, taking ~/.aws, ~/.ssh and ~/.local tool installs with it
 *  (cec340f2 lost its SSH key mid-bootstrap; af773f1e had the aws CLI reaped
 *  twice). The workspace volume survives deploys AND container recycles, so
 *  credentials, keys and tools now persist per session. A sibling of the
 *  worktree — never INSIDE it (would pollute git status). Reaped with the
 *  worktree by reapIdleWorktrees. */
export const SANDBOX_HOMES_ROOT = `${CODING_WORKSPACE_ROOT}/worktrees/.sandbox-home`;
/** build 2026-10-08 ISO: the session's home in its worktree's subtree when the
 *  worktree is placed per-user, else `${SANDBOX_HOMES_ROOT}/<id>` (unchanged). */
export const sandboxHomeDir = (sessionId: string): string =>
  resolveSandboxHomeSync(sessionId, CODING_WORKSPACE_ROOT);

/** Best-effort removal of a session's durable sandbox HOME — called by EVERY
 *  session-teardown path (deleteProject/deleteChat cascades, worktree reaper)
 *  so credential-bearing dirs never linger on the shared volume (PR #359
 *  review F1). The orphan sweep (pruneOrphanSandboxHomes) backstops the paths
 *  that don't reach here (adminDeleteUser's raw FK cascade). */
export async function removeSandboxHome(sessionId: string): Promise<void> {
  await fs.rm(sandboxHomeDir(sessionId), { recursive: true, force: true }).catch(() => {});
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

// ── Pre-exec disk guard (ticket dc05bc31) ────────────────────────────────────
// A full workspace volume makes EVERY docker exec fail at spawn — runc cannot
// write /tmp/runc-process* ("OCI runtime exec failed … no space left on
// device", exit 128) — so once the disk hits 100% the session has NO
// in-session recovery: you cannot exec `rm` when exec itself is dead (the
// 2026-08-19 incident: a session's container fs filled mid-run and every
// run_command died until manual intervention). The deploy-side pre-flight
// guard (#268/#279) and the reaper-side workspace hygiene (#269) run on
// deploys/crons and cannot help a session mid-run, so the harness guards
// itself here, at the exec choke point:
//   1. BEFORE every exec, statfs the filesystem backing the workspace volume:
//      past the soft cap, run a best-effort in-container cleanup (/tmp — the
//      container's HOME — plus package caches); past the hard cap, recycle the
//      container outright (the daemon-side rm needs no working exec).
//   2. If an exec STILL fails with the no-space signature, recycle the
//      container and retry the command ONCE on the freshly re-provisioned
//      container — the re-provision recovery path the incident lacked.
/** Volume-usage thresholds for the pre-exec guard: clean past soft, recycle past hard. */
export const PRE_EXEC_DISK_SOFT_CAP = 0.85;
export const PRE_EXEC_DISK_HARD_CAP = 0.95;

/** Used fraction (0..1) of the filesystem backing the workspace volume — the
 *  same disk the containers' writable layers and runc's /tmp state writes land
 *  on. In-process (no docker exec, so it still works when exec is dead). null
 *  when unmeasurable — the guard then fails OPEN, like the reaper's
 *  workspaceDiskUsage. */
export async function workspaceVolumeUsage(): Promise<number | null> {
  try {
    const st = await (fs as any).statfs(CODING_WORKSPACE_ROOT);
    if (!st || !st.blocks) return null;
    return (st.blocks - st.bavail) / st.blocks;
  } catch { return null; }
}

/** True ONLY for the runc SPAWN disk-full signature: docker exec failed with
 *  exit 128 and the OCI/runc + ENOSPC markers appear at the very start of
 *  stderr. This is the sole auto-recyclable failure — the command PROVABLY
 *  never started, so the retry can never double-apply work. Both the exit
 *  code and the stderr head are checked: a failing jest run of THIS repo's
 *  disk-guard tests prints the fixture text inside code frames (mid-stderr,
 *  exit 1) and must never trigger a destructive recycle (adversarial review,
 *  PR #285). */
export function isNoSpaceSpawnError(stderr: string | undefined | null, exitCode?: number | string): boolean {
  if (exitCode !== 128) return false;
  const head = (stderr || '').slice(0, 500);
  return /runc-process|OCI runtime exec failed/i.test(head) && /no space left on device/i.test(head);
}

/** True for ANY disk-full-flavored stderr — including a command's OWN ENOSPC
 *  report (dd/cp/jest writing files mid-run). Advisory only: such a command
 *  already ran (possibly partially), so it is NEVER auto-retried and the
 *  worktree is never pruned on this signature alone. */
export function isNoSpaceError(stderr: string | undefined | null): boolean {
  return /no space left on device|runc-process|OCI runtime exec failed/i.test(stderr || '');
}

/**
 * Transport-death classification now lives in the PURE LEAF module
 * `./exec-transport` (re-exported here for existing in-module callers).
 * It must NOT be re-implemented in this file: `container.service.ts` reaches
 * prisma → config/database → config/env, and any module importing the predicate
 * from here inherits that graph, so `parseEnv()` would `process.exit(1)` in every
 * env-less suite that imports tools (29 suites broke that way, 2026-11-03).
 */
export { isExecTransportFailure } from './exec-transport';

/** Best-effort in-container cleanup while exec still works. The container runs
 *  uid 1001 with HOME=/tmp, so /tmp accumulates npm/pip caches and agent
 *  scratch. Keep-list (ticket 6a8dddd3): /tmp/digby-proc (the live
 *  background-process registry) AND $HOME's documented install homes —
 *  /tmp/.local + /tmp/bin. The SHELL STATE note promises "$HOME/.local/bin,
 *  $HOME/bin and /usr/local/bin are ALWAYS on PATH, so a normally-installed
 *  tool is found next command"; while the volume sat chronically over the
 *  soft cap, the wipe ran before EVERY exec and deleted pip --user installs
 *  between the installing command and the verify leg, which then classified
 *  the stage "tool not installed" (exit 127 / "No module named"). Anything
 *  oversized that lands in the kept dirs is still bounded by the hard-cap
 *  container recycle. Never throws. */
async function cleanContainerCaches(name: string): Promise<void> {
  await docker(['exec', name, 'bash', '-lc',
    'find /tmp -xdev -mindepth 1 -maxdepth 1 ! -name digby-proc ! -name .local ! -name bin -exec rm -rf {} + 2>/dev/null; rm -rf /tmp/.npm /tmp/.cache /root/.npm /root/.cache 2>/dev/null; true',
  ], 30_000).catch(() => {});
}

/** Reinstallable top-level dirs pruned from the session worktree (backend-side
 *  fs — no exec) on a pressure recycle. Mirrors REINSTALLABLE_DIRS in
 *  project-workspace.service.ts (NOT imported: that module imports this one). */
const RECYCLE_PRUNE_DIRS = ['node_modules', '.next', '.turbo', '.pnpm-store', '__pycache__'];

/** Drop the session container (daemon-side — works when exec is dead), clear
 *  its failed-session marker so the next ensure re-provisions, and prune
 *  reinstallable worktree artifacts to hand back disk. Never throws. */
export async function recycleSessionContainer(sessionId: string, reason: string): Promise<void> {
  logger.warn(`coding container: recycling ${containerName(sessionId)} (${reason}) — the next exec re-provisions it`);
  await stopSessionContainer(sessionId);
  failedSessions.delete(sessionId);
  const wt = WORKTREE_DIR(sessionId);
  for (const d of RECYCLE_PRUNE_DIRS) {
    await (fs as any).rm(`${wt}/${d}`, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Idempotent soft-cap action (Review 2026-09-13 issue 8, option B) ─────────
// With the volume chronically in the soft band (box C at 89-90% for hours),
// the /tmp wipe ran before EVERY exec — 1,386 '89% → 89%' warnings in 3.3h,
// 100% no-op, each appending a note to the tool result and, because execs
// target the shared dev container, wiping its /tmp (= HOME) every ~9s. The
// wipe can only reclaim what a wipe reclaims; if the last one freed nothing,
// running it again seconds later frees nothing either. Remember the last
// measurement PER TARGET CONTAINER and skip the wipe while (a) the memo is
// younger than the cooldown and (b) that wipe changed nothing. A wipe that DID
// free space stays eligible (it is productive), and the memo expires so a
// container whose /tmp refilled gets wiped again. Observe-only: nothing here
// blocks an exec — a suppressed wipe simply runs the command.
/** How long a no-op wipe suppresses further wipes on the same container. */
export const SOFT_CLEAN_NOOP_COOLDOWN_MS = 10 * 60_000;
/** A wipe that lowered volume usage by less than this (0.1 pt ≈ 200 MB on a
 *  200 GB disk) counts as a no-op. */
export const SOFT_CLEAN_MIN_EFFECT = 0.001;
interface SoftCleanMemo { at: number; before: number; after: number | null; suppressed: number }
const softCleanMemo = new Map<string, SoftCleanMemo>();

function softCleanWasNoop(m: SoftCleanMemo): boolean {
  // An unmeasurable "after" (statfs failed) is treated as productive — never
  // suppress on uncertainty; the next exec measures again.
  return m.after !== null && (m.before - m.after) < SOFT_CLEAN_MIN_EFFECT;
}

/** Drop expired memos so the map stays bounded by live containers. */
function pruneSoftCleanMemo(now: number): void {
  for (const [name, m] of softCleanMemo) {
    if (now - m.at >= SOFT_CLEAN_NOOP_COOLDOWN_MS) softCleanMemo.delete(name);
  }
}

/** Test seam: forget every per-container soft-clean measurement. */
export function __resetPreExecDiskGuardForTest(): void { softCleanMemo.clear(); }

/**
 * The pre-exec guard: measure per exec; on soft pressure clean, on hard
 * pressure recycle + re-provision. Returns a one-line note for the tool result
 * when it acted (the agent must learn its container was reset — background
 * processes and container-local state are gone), else null. Never throws.
 */
async function ensureDiskHeadroom(sessionId: string): Promise<string | null> {
  const usage = await workspaceVolumeUsage();
  if (usage === null || usage < PRE_EXEC_DISK_SOFT_CAP) return null;
  const pct = (usage * 100).toFixed(0);
  const target = execTargetName(sessionId); // shared-aware (review F9: per-session name no-op'd for shared sessions)
  if (usage >= PRE_EXEC_DISK_HARD_CAP) {
    softCleanMemo.delete(target); // the container is about to be recreated — its /tmp memo is moot
    await recycleSessionContainer(sessionId, `workspace volume at ${pct}% (hard cap ${PRE_EXEC_DISK_HARD_CAP * 100}%)`);
    await ensureSessionContainer(sessionId).catch(() => false);
    return `[coding container: workspace volume at ${pct}% — recycled the session container and pruned reinstallable artifacts (node_modules/.next/…) to free disk. The container was re-created fresh; container-local state (background processes, /tmp) is gone and build dependencies may need reinstalling.]`;
  }
  // Review 2026-09-13 issue 8: skip the wipe while the last one on this
  // container is recent AND freed nothing (the 7/min no-op + shared HOME wipe).
  const now = Date.now();
  const memo = softCleanMemo.get(target);
  if (memo && now - memo.at < SOFT_CLEAN_NOOP_COOLDOWN_MS && softCleanWasNoop(memo)) {
    memo.suppressed += 1;
    return null; // no wipe ⇒ no note: the agent's /tmp was NOT touched
  }
  await cleanContainerCaches(target);
  const after = await workspaceVolumeUsage();
  pruneSoftCleanMemo(now);
  const next: SoftCleanMemo = { at: now, before: usage, after, suppressed: 0 };
  softCleanMemo.set(target, next);
  const noop = softCleanWasNoop(next);
  logger.warn(
    `coding container: pre-exec cleanup at ${pct}% volume usage${after !== null ? ` → ${(after * 100).toFixed(0)}%` : ''}` +
    (memo?.suppressed ? ` (${memo.suppressed} exec(s) ran without a wipe since the last one)` : '') +
    (noop ? ` — no-op; suppressing the /tmp wipe on ${target} for ${SOFT_CLEAN_NOOP_COOLDOWN_MS / 60_000} min` : ''),
  );
  return `[coding container: workspace volume at ${pct}% — auto-cleaned the container /tmp + package caches to keep execs alive.]`;
}

/**
 * Build the SCOPED mount args for a session — the security fix (finding #5).
 *
 * The old whole-volume mount (`-v VOL:${ROOT}`) exposed EVERY session's worktree,
 * EVERY project's repo mirror, and any persisted `.digby/session/env.sh` creds to
 * a single session's shell (cross-tenant). Instead we mount only:
 *   - this session's worktree     (worktrees/<sessionId>)
 *   - this session's project mirror (repos/<projectId>.git), IF it exists
 * …each via `--mount volume-subpath=`, KEEPING the original absolute path so git
 * worktrees (whose `.git` file stores an absolute gitdir into the mirror + share
 * its object store) keep working. Other sessions'/projects' data is not mounted.
 *
 * Returns null when we can't scope safely (worktree missing on disk) — the caller
 * then uses the whole-volume mount so a run is never blocked. `volume-subpath`
 * needs Docker Engine ≥ 25; unsupported daemons fail the `docker run`, which the
 * caller catches and falls back from (see ensureSessionContainer). The scoped
 * container is additionally git-self-verified before we trust it.
 */
async function scopedMountArgs(sessionId: string): Promise<string[] | null> {
  // build 2026-10-08 ISO: every subpath is derived from where the data IS
  // (dual-read) — for a legacy session these are exactly `worktrees/<id>`,
  // `repos/<project>.git` and `worktrees/.sandbox-home/<id>` (byte-identical
  // args); for a per-user one they point into `<userKey>/…`.
  const wtAbs = WORKTREE_DIR(sessionId);
  const wtSub = volumeSubpathOf(wtAbs, CODING_WORKSPACE_ROOT) ?? `worktrees/${sessionId}`;
  if (!(await pathExists(wtAbs))) return null; // not provisioned — can't scope
  const args = ['--mount', `type=volume,source=${VOLUME_NAME},target=${wtAbs},volume-subpath=${wtSub}`];
  // A MIGRATED session (compatibility link at its legacy path) also gets its
  // worktree at the legacy absolute path, so absolute paths baked into the
  // tree before the move ($DIGBY_ENV exports, venv shebangs) keep resolving.
  const legacyWt = legacyWorktreePath(sessionId, CODING_WORKSPACE_ROOT);
  if (legacyWt !== wtAbs && isMigratedCompatLinkSync(legacyWt)) {
    args.push('--mount', `type=volume,source=${VOLUME_NAME},target=${legacyWt},volume-subpath=${wtSub}`);
  }

  // Repo-backed session → also mount ONLY its project's mirror (same absolute
  // path) so git can reach the shared object store. Blank projects have no
  // mirror (self-contained .git in the worktree) → worktree mount is enough.
  const session = await prisma.chatCodingState.findUnique({
    where: { id: sessionId }, select: { projectId: true },
  }).catch(() => null);
  if (session?.projectId) {
    const mirrorAbs = resolveMirrorPathSync(session.projectId, CODING_WORKSPACE_ROOT);
    const mirrorSub = volumeSubpathOf(mirrorAbs, CODING_WORKSPACE_ROOT) ?? `repos/${session.projectId}.git`;
    if (await pathExists(mirrorAbs)) {
      args.push('--mount', `type=volume,source=${VOLUME_NAME},target=${mirrorAbs},volume-subpath=${mirrorSub}`);
    }
  }
  // Durable per-session HOME (e267b760): mount ONLY this session's home subdir,
  // at the same absolute path the whole-volume fallback exposes it at.
  const homeAbs = sandboxHomeDir(sessionId);
  const homeSub = volumeSubpathOf(homeAbs, CODING_WORKSPACE_ROOT) ?? `worktrees/.sandbox-home/${sessionId}`;
  args.push('--mount', `type=volume,source=${VOLUME_NAME},target=${homeAbs},volume-subpath=${homeSub}`);
  const legacyHome = legacySandboxHome(sessionId, CODING_WORKSPACE_ROOT);
  if (legacyHome !== homeAbs && legacyWt !== wtAbs && isMigratedCompatLinkSync(legacyWt)) {
    args.push('--mount', `type=volume,source=${VOLUME_NAME},target=${legacyHome},volume-subpath=${homeSub}`);
  }
  return args;
}

/**
 * build 2026-10-08 ISO: the per-user session's whole-subtree FALLBACK mount
 * (replaces the whole-volume fallback for a session placed per-user): the
 * user's subtree at its own absolute path + its mirror when that lives outside
 * the subtree, with the subtree's on-volume homes masked (HOME stays /tmp —
 * same posture as the legacy fallback). null = not a per-user session.
 */
async function userSubtreeFallbackArgs(sessionId: string): Promise<string[] | null> {
  const wtAbs = WORKTREE_DIR(sessionId);
  const key = pathSubtreeKey(wtAbs, CODING_WORKSPACE_ROOT);
  if (!key) return null;
  const rootAbs = subtreeRoot(key, CODING_WORKSPACE_ROOT);
  const args = [
    '--mount', `type=volume,source=${VOLUME_NAME},target=${rootAbs},volume-subpath=${key}`,
    '--tmpfs', `${subtreeSandboxHomesRoot(key, CODING_WORKSPACE_ROOT)}:rw,noexec,nosuid,size=64k`,
  ];
  const session = await prisma.chatCodingState.findUnique({ where: { id: sessionId }, select: { projectId: true } }).catch(() => null);
  if (session?.projectId) {
    const mirrorAbs = resolveMirrorPathSync(session.projectId, CODING_WORKSPACE_ROOT);
    const mirrorSub = volumeSubpathOf(mirrorAbs, CODING_WORKSPACE_ROOT);
    if (mirrorSub && !mirrorAbs.startsWith(`${rootAbs}/`) && await pathExists(mirrorAbs)) {
      args.push('--mount', `type=volume,source=${VOLUME_NAME},target=${mirrorAbs},volume-subpath=${mirrorSub}`);
    }
  }
  return args;
}

/**
 * build 2026-10-08 ISO step 1 (the report's "hardening quick win"): a session
 * placed per-user whose owner is in the switch gets a tighter container —
 * no capabilities (the runner is uid 1001 anyway), no privilege escalation
 * through setuid / file-caps binaries, and a pid ceiling against fork bombs.
 * Legacy sessions keep today's create args byte-for-byte.
 */
export const HARDENED_CREATE_ARGS: readonly string[] = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '4096'];

const BASE_CREATE = (name: string, sessionId: string, home: string) => [
  'run', '-d', '--name', name,
  '--label', `${LABEL}=${sessionId}`,
  '--init',
  // uid-drift fix (nightly 2026-08-02): run as the backend's uid so runner
  // commits write nodejs-owned objects/paths into the shared volume. As root,
  // runners left the backend's uid-1001 git ops dying with EACCES
  // ("insufficient permission for adding an object") and "detected dubious
  // ownership" — 128 snapshot fails/48h. git has no world-writable
  // sharedRepository mode, so aligning the writer uid is the complete fix.
  // HOME: uid 1001 has no passwd entry in stock node:20; git/npm need a
  // writable HOME. 1001 = the backend image's nodejs user (Dockerfile).
  // HOME is passed per create mode: the SCOPED path gets the per-session
  // DURABLE dir on the workspace volume (e267b760 — /tmp is wiped aggressively
  // and on every deploy); the whole-volume FALLBACK keeps HOME=/tmp
  // (container-local) AND its create masks the .sandbox-home root with an
  // empty tmpfs, so a fallback session can neither read nor poison another
  // session's on-volume home (PR #359 review F2 — both halves are required:
  // HOME=/tmp alone only keeps the fallback's OWN creds off the volume).
  '--user', '1001:1001',
  '-e', `HOME=${home}`,
];
const CREATE_TAIL = (sessionId: string, hardened = false) => [
  '-w', WORKTREE_DIR(sessionId),
  '--memory', '2g', '--cpus', '2',
  '--network', 'bridge',
  ...(hardened ? HARDENED_CREATE_ARGS : []),
  RUNNER_IMAGE, 'sleep', 'infinity',
];

/**
 * Mark every path git-safe inside the disposable runner container. Legacy
 * fallback: containers created BEFORE the 2026-08-02 uid alignment ran as the
 * image default user (root in stock node:20) while the volume's files are owned
 * by the backend uid (1001) → "fatal: detected dubious ownership", which broke
 * provisioning and forced agents to add safe.directory by hand (prod sessions
 * b92ef13f / 7242c1e4 / 7be7440a). New containers run as uid 1001 (BASE_CREATE
 * --user), so for them this exec is a harmless no-op (non-root can't write
 * /etc/gitconfig; the catch swallows it) — it still protects legacy stopped
 * containers re-entered as root via `docker start`. --system writes
 * /etc/gitconfig (survives HOME/user differences and does not collide with the
 * per-exec GIT_CONFIG_* credential env); the '*' wildcard is safe because the
 * container is single-session and disposable. Best-effort.
 */
async function markGitSafe(name: string): Promise<void> {
  await docker(['exec', name, 'git', 'config', '--system', '--add', 'safe.directory', '*']).catch(() => {});
}

// ── gh CLI provisioning (ticket ad7a1c3c, 2026-09-14) ─────────────────────
// Runner/dev images are stock node:20 — no gh — yet every session shell gets
// GITHUB_TOKEN/GH_TOKEN and the prompt tells agents to drive GitHub with gh
// (session-credentials.ts). Agents then self-install gh container-locally and
// a container recreation (deploy flip, idle/age reap, disk-pressure recycle)
// silently destroys it — a mid-run lane lost gh to a deploy and burned tokens
// on curl fallbacks (2026-09-14). The PLATFORM now provisions gh at every
// container-entering-service transition below: the pinned release tarball is
// fetched ONCE per backend container into a tmp cache (sha256-verified), then
// `docker cp` drops the binary at /usr/local/bin/gh — no container network,
// no root exec, no apt, so egress-locked shared dev containers work too.
// Best-effort like markGitSafe: failures log a warning and NEVER fail
// container readiness (sessions fall back to git/curl exactly as before).
const GH_VERSION = '2.100.0';
/** Pinned release-tarball sha256 (from gh_<v>_checksums.txt) — a compromised
 *  or truncated download is refused before it ever enters a session container.
 *  Exported so tests can point the pin at a fixture tarball's digest. */
export const GH_SHA256: Record<string, string> = {
  amd64: 'e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be',
  arm64: 'ea4e7a581a32ccad6cc7923cb1576ac5859ba4b9a16ab22eb8f8a96e78e2e961',
};
const GH_CHECK_TTL_MS = 15 * 60 * 1000;
/** container name → last successful gh check/provision. TTL'd so a same-name
 *  recreate outside this module (the shared dev container's own restart path
 *  in dev-container.service) self-heals on expiry; module-local removals
 *  invalidate eagerly in stopSessionContainer. */
const ghProvisionedAt = new Map<string, number>();
let ghCacheInFlight: Promise<string | null> | null = null;

function ghAssetArch(): 'amd64' | 'arm64' | null {
  if (process.arch === 'x64') return 'amd64';
  if (process.arch === 'arm64') return 'arm64';
  return null;
}

/** Download + sha256-verify + extract the pinned gh tarball into the tmp cache. */
async function fetchGhToCache(arch: 'amd64' | 'arm64', dir: string, final: string): Promise<string | null> {
  const asset = `gh_${GH_VERSION}_linux_${arch}.tar.gz`;
  const url = `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${asset}`;
  const tgz = path.join(dir, asset);
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== GH_SHA256[arch]) throw new Error(`sha256 mismatch (${sha.slice(0, 12)}… ≠ pinned)`);
    await fs.writeFile(tgz, buf);
    // Extract only bin/gh, then same-dir rename into place so a concurrent
    // reader never sees a partial binary.
    const extracted = path.join(dir, `gh_${GH_VERSION}_linux_${arch}`, 'bin', 'gh');
    await execFileAsync('tar', ['-xzf', tgz, '-C', dir, `gh_${GH_VERSION}_linux_${arch}/bin/gh`], { timeout: 120_000 });
    await fs.chmod(extracted, 0o755);
    await fs.rename(extracted, final);
    const st = await fs.stat(final);
    if (st.size < 1_000_000) throw new Error(`extracted gh suspiciously small (${st.size}b)`);
    return final;
  } catch (err: any) {
    logger.warn(`coding container: gh download failed (${err.message}) — sessions keep the git/curl fallback`);
    return null;
  } finally {
    await fs.rm(tgz, { force: true }).catch(() => {});
    await fs.rm(path.join(dir, `gh_${GH_VERSION}_linux_${arch}`), { recursive: true, force: true }).catch(() => {});
  }
}

/** Backend-local cached path of the gh binary (downloads on first use). The
 *  cache lives in the BACKEND container's tmp — never on the workspace volume,
 *  so a session shell can neither poison it nor depend on it. */
function ghCachePath(): Promise<string | null> {
  if (!ghCacheInFlight) {
    const arch = ghAssetArch();
    if (!arch) {
      logger.warn(`coding container: gh provisioning unsupported on ${process.arch} — sessions keep the git/curl fallback`);
      ghCacheInFlight = Promise.resolve(null);
    } else {
      const dir = path.join(os.tmpdir(), 'digby-gh-cache');
      const final = path.join(dir, `gh-${GH_VERSION}-${arch}`);
      ghCacheInFlight = (async () => {
        await fs.mkdir(dir, { recursive: true }).catch(() => {});
        try { await fs.access(final); return final; } catch { /* cache miss — download */ }
        return fetchGhToCache(arch, dir, final);
      })();
    }
    // In-flight dedup only: once settled, the next caller re-checks the disk
    // cache (one fs.access) — a failed download retries on demand and a wiped
    // /tmp self-heals.
    const settled = ghCacheInFlight;
    settled.finally(() => { if (ghCacheInFlight === settled) ghCacheInFlight = null; }).catch(() => {});
  }
  return ghCacheInFlight;
}

/** Provision the gh CLI into a ready container (idempotent, best-effort). */
export async function ensureGhCli(name: string): Promise<void> {
  try {
    const last = ghProvisionedAt.get(name);
    if (last && Date.now() - last < GH_CHECK_TTL_MS) return;
    // Fast path: already present (baked image, or a persistent container we
    // provisioned before a backend restart cleared the in-memory map).
    try {
      await docker(['exec', name, 'sh', '-c', 'command -v gh >/dev/null 2>&1'], 15_000);
      ghProvisionedAt.set(name, Date.now());
      return;
    } catch { /* missing — provision below */ }
    const bin = await ghCachePath();
    if (!bin) return; // warning already logged
    await docker(['cp', bin, `${name}:/usr/local/bin/gh`], 60_000);
    await docker(['exec', name, 'gh', 'version'], 15_000); // prove the copy runs
    ghProvisionedAt.set(name, Date.now());
    logger.info(`coding container: provisioned gh ${GH_VERSION} into ${name}`);
  } catch (err: any) {
    logger.warn(`coding container: gh provisioning failed for ${name} (${err.message}) — session continues with the git/curl fallback`);
  }
}

/** git works inside the scoped container? Requires reading objects from the
 *  (scoped) mirror, so it fails iff the mount scoping broke git. */
async function containerGitOk(name: string, sessionId: string): Promise<boolean> {
  try {
    await docker(['exec', '-w', WORKTREE_DIR(sessionId), name, 'git', 'rev-parse', 'HEAD'], 20_000);
    return true;
  } catch { return false; }
}

/**
 * Ensure the session's container exists and is running. Returns true if the
 * container is usable, false if we should fall back to in-process execution.
 */
export async function ensureSessionContainer(sessionId: string): Promise<boolean> {
  if (!(await isDockerAvailable())) return false;
  // Shared dev container first (owner opt-in; dynamic import keeps the
  // dev-container chain out of this module's static graph for tests). Any
  // failure falls through to the per-session path below.
  let sessionUserId: string | null = null;
  try {
    const row = await prisma.chatCodingState.findUnique({ where: { id: sessionId }, select: { userId: true } });
    sessionUserId = row?.userId ?? null;
    let shared: string | null = null;
    if (row?.userId) {
      // ticket e2f40d10 review: dev-container.service caches a per-user HEALTH
      // verdict (healthyMemo, 20 s TTL) and its invalidator had no caller — so a
      // reaped shared container was re-resolved from the memo to the SAME dead
      // name, and the rebind retry failed identically with no note. A session
      // whose shared target just answered "No such container" drops it first.
      if (sharedVanished.delete(sessionId)) {
        const { invalidateDevContainerMemo } = await import('./dev-container.service');
        invalidateDevContainerMemo(row.userId);
      }
      const { ensureUserDevContainer } = await import('./dev-container.service');
      shared = await ensureUserDevContainer(row.userId);
    }
    sharedExposure.delete(sessionId);
    if (shared && listSubtreeKeysSync(CODING_WORKSPACE_ROOT).length > 0) {
      // build 2026-10-08 ISO: a dev container mounted per-user sees only its
      // user's subtree (+ mirrors mounted one by one). A session it cannot
      // reach (a legacy worktree, a mirror not mounted at create time) runs in
      // its own scoped per-session container instead — never a broken shell.
      // (No per-user subtree on the volume ⇒ no dev container can be mounted
      // per-user ⇒ no inspect — today's path byte-for-byte.)
      const wt = WORKTREE_DIR(sessionId);
      const cov = devContainerCovers(await containerMountDestinations(shared), wt, mirrorOfWorktreeSync(wt));
      if (!cov.covered) {
        recordIsolationMetric('dev_uncovered', { container: shared, worktreeLayout: pathSubtreeKey(wt, CODING_WORKSPACE_ROOT) ? 'per_user' : 'legacy' }, sessionId);
        logger.info(`coding container: ${shared} (per-user mount) cannot reach session ${sessionId}'s worktree/mirror — using a scoped per-session container`);
        shared = null;
      } else {
        sharedExposure.set(sessionId, cov.wholeVolume ? 'dev_container' : 'user_subtree');
      }
    }
    if (shared) {
      const { ensureSessionEgressGrant } = await import('./dev-container.service');
      sharedOverride.set(sessionId, shared);
      // Per-session egress grant (ticket 4ed6eb2e): write this session's
      // credential+policy file into the container and memo the proxy URL for
      // exec-env injection. Once per run-resolve — a container recreation
      // re-runs this path and rewrites the (wiped) file. null = legacy
      // posture / write failure → no injection (scoped helpers then fail
      // closed; legacy helpers work as v1).
      const grant = await ensureSessionEgressGrant(sessionId, shared).catch(() => null);
      if (grant) egressGrants.set(sessionId, grant); else egressGrants.delete(sessionId);
      await ensureGhCli(shared);
      return true;
    }
    sharedOverride.delete(sessionId);
    sharedExposure.delete(sessionId);
    egressGrants.delete(sessionId);
  } catch { sharedOverride.delete(sessionId); sharedExposure.delete(sessionId); egressGrants.delete(sessionId); /* fall through to per-session */ }
  if (sessionRecentlyFailed(sessionId)) return false;
  const name = containerName(sessionId);
  try {
    // Already running?
    const running = (await docker(['ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])).trim();
    if (running === name) { await noteContainerMountMode(name); await ensureSessionUserRow(name); await ensureGhCli(name); return true; }
    // Exists but stopped? Start it.
    const exists = (await docker(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])).trim();
    if (exists === name) { await docker(['start', name]); await noteContainerMountMode(name); await markGitSafe(name); await ensureSessionUserRow(name); await ensureGhCli(name); return true; }

    // Non-root default image, no extra caps, memory-capped; idles on `sleep
    // infinity`. --init: PID 1 is tini, reaping orphaned background children.
    //
    // Prefer SCOPED mounts (finding #5). Try them, then GIT-SELF-VERIFY inside
    // the container; if git can't resolve HEAD (subpath unsupported/broke the
    // worktree↔mirror link) tear it down and fall back to the whole-volume mount
    // — today's proven behavior — so a run is never worse off than before.
    // Durable per-session HOME (e267b760): create it BEFORE any container
    // create — the HOME env and the scoped subpath mount both point at it.
    // The backend runs as uid 1001, so the dir lands runner-owned.
    await fs.mkdir(sandboxHomeDir(sessionId), { recursive: true }).catch(() => {});
    // build 2026-10-08 ISO: a session placed per-user (its worktree lives in a
    // `<userKey>/` subtree) gets hardened create args when its owner is in the
    // switch; every create is counted (the "scoped provision ≥ 99 %" bar).
    const perUser = !!pathSubtreeKey(WORKTREE_DIR(sessionId), CODING_WORKSPACE_ROOT);
    const hardened = perUser && perUserSubtreeAppliesTo(sessionUserId);
    const layout = perUser ? 'per_user' : 'legacy';
    const scoped = await scopedMountArgs(sessionId);
    if (scoped) {
      try {
        await docker([...BASE_CREATE(name, sessionId, sandboxHomeDir(sessionId)), ...scoped, ...CREATE_TAIL(sessionId, hardened)], 180_000);
        await markGitSafe(name); // before the git self-verify, or dubious-ownership fails it
        if (await containerGitOk(name, sessionId)) {
          wholeVolumeContainers.delete(name); userSubtreeContainers.delete(name); scopedContainers.add(name);
          await ensureSessionUserRow(name);
          await ensureGhCli(name);
          isoMetric('container', { layout, mount: 'scoped', hardened }, sessionId);
          logger.info(`coding container: started ${name} (SCOPED mounts) for session ${sessionId}`);
          return true;
        }
        logger.warn(`coding container: scoped mounts started but git failed inside ${name} — falling back to whole-volume mount`);
        await docker(['rm', '-f', name]).catch(() => {});
      } catch (scopedErr: any) {
        logger.warn(`coding container: scoped mount unsupported for ${sessionId} (${scopedErr.message}) — falling back to whole-volume`);
        await docker(['rm', '-f', name]).catch(() => {}); // clean any partial
      }
    }

    // build 2026-10-08 ISO: a per-user session falls back to ITS USER'S
    // SUBTREE (+ its mirror), never the whole volume — the cross-tenant
    // exposure the fallback used to open. Only if that create fails too does
    // it reach the legacy whole-volume fallback below (never worse than today).
    const subtreeArgs = perUser ? await userSubtreeFallbackArgs(sessionId) : null;
    if (subtreeArgs) {
      try {
        await docker([...BASE_CREATE(name, sessionId, '/tmp'), ...subtreeArgs, ...CREATE_TAIL(sessionId, hardened)], 180_000);
        await markGitSafe(name);
        if (await containerGitOk(name, sessionId)) {
          scopedContainers.delete(name); wholeVolumeContainers.delete(name); userSubtreeContainers.add(name);
          await ensureSessionUserRow(name);
          await ensureGhCli(name);
          isoMetric('container', { layout, mount: 'user_subtree', hardened }, sessionId);
          logger.info(`coding container: started ${name} (per-user SUBTREE mount) for session ${sessionId}`);
          return true;
        }
        logger.warn(`coding container: subtree mount started but git failed inside ${name} — falling back to whole-volume`);
        await docker(['rm', '-f', name]).catch(() => {});
      } catch (subErr: any) {
        logger.warn(`coding container: subtree mount failed for ${sessionId} (${subErr.message}) — falling back to whole-volume`);
        await docker(['rm', '-f', name]).catch(() => {});
      }
    }

    // Fallback: whole-volume mount (unchanged legacy behavior). HOME stays
    // /tmp here (review F2): the whole-volume mount already exposes every
    // session's data, so it must not ALSO put live credential homes on the
    // volume — and the .sandbox-home root is masked with an empty tmpfs so the
    // fallback session (uid 1001, same as the homes' owner) can neither read
    // nor poison OTHER sessions' on-volume homes. Credential posture: pre-PR.
    await docker([
      ...BASE_CREATE(name, sessionId, '/tmp'),
      '-v', `${VOLUME_NAME}:${CODING_WORKSPACE_ROOT}`,
      '--tmpfs', `${SANDBOX_HOMES_ROOT}:rw,noexec,nosuid,size=64k`,
      ...CREATE_TAIL(sessionId),
    ], 180_000);
    scopedContainers.delete(name); userSubtreeContainers.delete(name); wholeVolumeContainers.add(name);
    await markGitSafe(name);
    await ensureSessionUserRow(name);
    await ensureGhCli(name);
    isoMetric('container', { layout, mount: 'whole_volume', hardened: false }, sessionId);
    logger.info(`coding container: started ${name} (whole-volume mount) for session ${sessionId}`);
    return true;
  } catch (err: any) {
    logger.warn(`coding container: ensure failed for ${sessionId} (${err.message}) — falling back to in-process`);
    failedSessions.set(sessionId, Date.now());
    return false;
  }
}

/** True ONLY for the docker DAEMON's own "the container is gone" refusal —
 *  `Error response from daemon: No such container: <name>` at the very START of
 *  stderr. A command's own output that merely mentions the phrase (a test
 *  fixture, a `docker` call inside a script, a grep hit, an indented echo in
 *  diagnostic output) prints it after other output or indented, and must never
 *  be read as "our container vanished": the whole one-retry bound rests on
 *  "the exec provably never started".
 *  Merged from ticket c25f8b7e (position-0 anchor + exit-code guard) and
 *  ticket e2f40d10 (the optional `docker: ` wrapper prefix). */
export function isContainerGoneError(stderr: string | undefined | null, exitCode?: number | string): boolean {
  if (typeof exitCode === 'number' && exitCode === 0) return false;
  const head = (stderr || '').slice(0, 400);
  // The daemon's own prefix may be indented by the exec wrapper (docker's 125
  // exit) — pinned by ticket c25f8b7e: `  Error response from daemon: …`.
  return /^\s*(?:docker:\s*)?Error response from daemon: No such container/i.test(head)
    // The bare re-emit is NOT allowed leading whitespace (ticket e2f40d10
    // review, finding 3). Docker never indents its own refusal, so an INDENTED
    // bare phrase is a command's own output — a diagnostic echo, a jest line, a
    // `cat` of a log — and reading it as a container death would announce a
    // phantom replacement and burn the one-retry bound on work that ran.
    || /^No such container: /i.test(head);
}

// ── Container replacement across a deploy / restart wave (ticket c25f8b7e) ───
// The container NAME is deterministic, so a swap is invisible by name; the
// docker ID is not. Two things read it:
//   1. RUN START (agent.ts calls noteSessionContainerIdentity after the
//      container resolves) — the lane is told, in its prompt, that the
//      container it ran in last time was replaced and that everything it
//      started inside is gone; and
//   2. a MID-RUN exec that finds the container gone (a wave landing while the
//      run is in flight) — the exec note says the command did NOT run, and the
//      container is re-provisioned so the rest of the run still has a shell
//      instead of dying with "No such container" for the remainder of the
//      firing (the 2026-11-03 Schooltime lane 60dfc8a8 loss).
// Detection itself lives in the durable leaf ./container-identity (a record on
// the coding_session_env volume, which survives the swap and is never mounted
// into a session container). This module only feeds it the live docker id.

/** The container's docker ID, or null when it cannot be read (absent, daemon
 *  down, inspect failed). Never throws. */
export async function containerDockerId(name: string): Promise<string | null> {
  try {
    const id = (await docker(['inspect', '-f', '{{.Id}}', name], 15_000)).trim();
    return id || null;
  } catch { return null; }
}

/**
 * Remember that this session now runs in its exec target, and report a
 * REPLACEMENT when the container's docker id differs from the one on file.
 * Returns null for a first sighting, an unchanged container, or an unreadable
 * one — never a guess (a false "your work is gone" alarm costs a lane a whole
 * recovery cycle). Never throws.
 */
export async function noteSessionContainerIdentity(sessionId: string): Promise<ContainerReplacement | null> {
  try {
    const target = execTargetName(sessionId);
    const id = await containerDockerId(target);
    if (!id) return null;
    const replacement = await recordContainerIdentity(sessionId, target, id);
    if (!replacement) return null;
    logger.warn(
      `coding container: REPLACED for session ${sessionId} — ${target} now ${id.slice(0, 12)}, previous ${replacement.previousId.slice(0, 12)} first seen ${replacement.previousSeenAt} (deploy/restart wave or reprovision): background processes and container-local state from that container are gone`,
    );
    // Telemetry (dynamic import keeps this module's static graph unchanged):
    // a wave that swaps many lanes' containers in one minute is visible as a
    // burst of container_replaced rows rather than as lanes silently losing work.
    void import('../platform/loop-metrics.service')
      .then((m) => m.recordLoopMetric({
        kind: m.LOOP_METRIC_KINDS.CONTAINER_REPLACED,
        sessionId,
        meta: { container: target, previousSeenAt: replacement.previousSeenAt, replacedAt: replacement.replacedAt },
      }))
      .catch(() => {});
    return replacement;
  } catch { return null; }
}

/** Add the uid-1001 passwd/group rows to a per-session container (ticket
 *  e2f40d10). Session execs run as --user 1001:1001, but the stock default
 *  runner image (node:20) has NO uid-1001 row, so getpwuid fails and OpenSSH
 *  dies "No user exists for uid 1001" — the whole tailnet box path went dark
 *  and lanes had to compile a getpwuid LD_PRELOAD shim by hand. The dev
 *  container has had this since a6051a82/PR #1482; the per-session path never
 *  did. Writes /etc/passwd, so it needs root: `docker exec` defaults to the
 *  container's --user (1001) and would die EACCES — pass -u 0 explicitly.
 *  Idempotent (getent guards) and best-effort: a failure must never block a
 *  shell. Memoized per container name; a recreate uses a fresh ensure. */
const sessionUserRowEnsured = new Set<string>();
async function ensureSessionUserRow(name: string): Promise<void> {
  if (sessionUserRowEnsured.has(name)) return;
  try {
    await docker(['exec', '-u', '0', name, 'sh', '-c', SESSION_USER_SCRIPT], 15_000);
    sessionUserRowEnsured.add(name);
  } catch (err: any) {
    logger.warn(`coding container: uid-1001 passwd row unavailable in ${name} (${String(err?.message).slice(0, 100)}) — ssh/tailscale helpers may report "No user exists for uid 1001"`);
  }
}
/** Forget the per-container uid-row memo (a recreate must re-provision it). */
function forgetSessionUserRow(name: string): void { sessionUserRowEnsured.delete(name); }
/** Test-only: clear the whole uid-row memo (jest runs share the module state). */
export function __resetSessionUserRowMemoForTest(): void { sessionUserRowEnsured.clear(); }

/** Re-bind this session to a LIVE container after its target vanished mid-run.
 *  Drops every memo keyed on the dead name, then re-provisions. Returns true
 *  when a usable container is back. Never throws. */
async function rebindSessionContainer(sessionId: string): Promise<boolean> {
  const name = containerName(sessionId);
  sharedOverride.delete(sessionId);
  sharedExposure.delete(sessionId);
  egressGrants.delete(sessionId);
  ghProvisionedAt.delete(name);
  wholeVolumeContainers.delete(name); scopedContainers.delete(name); userSubtreeContainers.delete(name);
  softCleanMemo.delete(name);
  forgetSessionUserRow(name);
  failedSessions.delete(sessionId); // a vanished container is not a provisioning failure
  try { return await ensureSessionContainer(sessionId); } catch { return false; }
}

/**
 * Re-resolve the session's shell binding when the executor was left holding NO
 * container (ticket 093e9a61, family deploy-kills-lane-background-workers).
 *
 * `ensureSessionContainer` is called ONCE per run (agent.ts) and the result was
 * captured in a const. When that single call misses — a container being
 * re-provisioned at that instant, a Docker probe blip (DOCKER_NEGATIVE_MEMO_MS),
 * or the 5-minute failed-session memo left by an earlier failure — the executor
 * stayed bound to "no container" for the WHOLE firing: every shell tool refused,
 * including the probes a lane would use to diagnose it, so the lane lost the
 * firing and could not tell why. The memo expiring never helped, because
 * nothing re-read it.
 *
 * This is the stale-binding counterpart to rebindSessionContainer (which handles
 * a container that DIED under a live run). It makes at most ONE provisioning
 * attempt per call, and clearing the failed-session memo first is what lets a
 * recovered host bind immediately; re-arming it on failure keeps a broken host
 * from being hammered once per shell tool call.
 *
 * LIVENESS IS VERIFIED before success is reported (adversarial review of this
 * change, finding F3): `dev-container.service`'s `healthyMemo` returns the
 * shared container NAME for HEALTH_MEMO_MS (20 s) with NO liveness check, so a
 * shared container reaped moments ago still resolves to a name — and a dead
 * container is still inspectable/named. Reporting `true` there would tell the
 * lane "your shell is back" while every `docker exec` still answers "No such
 * container". The check below therefore requires docker to actually SEE the
 * resolved exec target. It only downgrades when docker is genuinely up and the
 * target is absent (never on "cannot tell"), because a false NEGATIVE would
 * cost a working lane its shell — the same loss this function exists to stop.
 * Isolation is unaffected either way: `true` routes to `execInContainer`
 * (`docker exec`), never to in-process execution. Never throws.
 */
export async function recoverSessionShellContainer(sessionId: string): Promise<boolean> {
  failedSessions.delete(sessionId); // a stale binding is not a provisioning verdict
  try {
    const ok = await ensureSessionContainer(sessionId);
    if (!ok) {
      // Re-arm the backoff we just cleared, so a host that still cannot
      // provision costs ONE attempt per window rather than one per tool call.
      failedSessions.set(sessionId, Date.now());
      return false;
    }
    // A resolved binding is not the same thing as a LIVE container (finding F3).
    const id = await containerDockerId(execTargetName(sessionId));
    if (!id && (await isDockerAvailable())) {
      failedSessions.set(sessionId, Date.now());
      return false;
    }
    return true;
  } catch {
    failedSessions.set(sessionId, Date.now());
    return false;
  }
}

/** Run a shell command inside the session container. Infra failures come back
 *  as `[exit: …]` stderr (never thrown) so the agent sees them. */
export async function execInContainer(
  sessionId: string, command: string, cwd: string, timeoutMs = 120_000,
  extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  // Pre-exec disk-headroom guard (ticket dc05bc31 — see the block above). Best
  // effort: a guard failure must never block an otherwise-working exec.
  const guardNote = await ensureDiskHeadroom(sessionId).catch(() => null);
  // Per-exec credential/env injection (the user's connected-integration tokens) —
  // passed fresh each command so a refreshed token is picked up next time and
  // nothing is baked into the long-lived container.
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(extraEnv || {})) { envArgs.push('-e', `${k}=${v}`); }
  // Shared dev container: session commands run as uid 1001 (same uid as
  // per-session containers) — NEVER as the container's root. Root execs would
  // regress the uid-alignment fix (dubious-ownership/EACCES) and could read
  // the root-owned tailnet secrets (adversarial review of #326, findings F1/F2).
  const shared = sharedOverride.has(sessionId);
  // Shared dev container: session commands run as uid 1001 (same uid as
  // per-session containers) — NEVER as the container's root. Root execs would
  // regress the uid-alignment fix (dubious-ownership/EACCES) and could read
  // the root-owned tailnet secrets (adversarial review of #326, findings F1/F2).
  // ACCEPTED LIMITATION (adversarial review F1, advisory model): every exec in
  // the shared container runs as uid 1001, so a concurrent same-uid process
  // could read this env via /proc/<pid>/environ and impersonate the session to
  // the shim — within ONE user's sessions only (the container is per-user).
  // Same-uid secret separation is impossible without per-session uids; the
  // network-enforced fix is the tagged-ephemeral-node upgrade (design doc Part
  // 3(a)), deliberately deferred. Cross-USER isolation is unaffected.
  //
  // RECOMPUTED PER ATTEMPT (ticket e2f40d10 review): identity + egress args
  // used to be computed once, before any retry. After an executor REBIND the
  // target may be a different container (shared → per-session or back), so a
  // cached `-u 1001:1001` would either be dropped (a retry running as the
  // container's default user) or applied to a per-session container that does
  // not need it. Resolve it inside `attempt` so every retry — the disk-full
  // recycle and the vanished-container rebind alike — re-derives it from the
  // live binding.
  const identityArgs = (): string[] => {
    const args: string[] = [];
    if (!sharedOverride.has(sessionId)) return args; // per-session: container's own --user
    args.push('-u', '1001:1001', '-e', 'HOME=/tmp');
    // Per-session egress scoping (ticket 4ed6eb2e): inject THIS session's
    // credentialed proxy URL so the shim on :1055 can authenticate + apply the
    // session's allowlist. An explicit caller-provided value wins (never
    // clobber); scoped containers deliberately carry no container-wide export
    // (profile.d is comment-only there) so this -e is the only source.
    const grant = egressGrants.get(sessionId);
    if (grant && !extraEnv?.DIGBY_TAILNET_PROXY) args.push('-e', `DIGBY_TAILNET_PROXY=${grant}`);
    return args;
  };
  const attempt = async (): Promise<{ stdout: string; stderr: string; failed: boolean; code: number | string }> => {
    try {
      const { stdout, stderr } = await execFileAsync(
        'docker', ['exec', '-w', cwd, ...identityArgs(), ...envArgs, execTargetName(sessionId), 'bash', '-lc', command],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      );
      return { stdout: stdout.toString(), stderr: stderr.toString(), failed: false, code: 0 };
    } catch (e: any) {
      return { stdout: e.stdout?.toString() || '', stderr: (e.stderr?.toString() || '') + `\n[exit: ${e.code ?? 'error'}${e.killed ? ' — timed out' : ''}]`, failed: true, code: e.code ?? 'error' };
    }
  };
  const r = await attempt();
  // The FIRST attempt's outcome, captured before anything below mutates `r`
  // (ticket e2f40d10 review). Both retry guards must test THIS, not `r`:
  // a disk-full retry that SUCCEEDED used to leave `r.failed` stale-true, so a
  // stderr line merely quoting the daemon phrase could then send an
  // already-successful command through the rebind branch a THIRD time — the
  // double-apply this fix promises cannot happen.
  const first = { failed: r.failed, stderr: r.stderr, code: r.code };
  // The name this attempt ACTUALLY targeted. Captured HERE because the
  // vanished-container block below deletes sharedOverride (line ~1147), after
  // which execTargetName() resolves to the PER-SESSION name — so a death of the
  // SHARED dev container would name the wrong container in the lane-facing
  // notice and the warn log (ticket e2f40d10 review, finding 2 — the fix was
  // written in review commit 3c306cb141 but lost in the merge).
  const attemptedTarget = execTargetName(sessionId);
  if (first.failed && isNoSpaceSpawnError(first.stderr, first.code)) {
    // runc SPAWN disk-full failure — the command provably never started, so
    // recycling daemon-side and retrying ONCE on a fresh container can never
    // double-apply work (ticket dc05bc31). This is the ONLY auto-retry path:
    // anything less certain (a command's own ENOSPC report) ran, maybe
    // partially, and is never re-executed by the harness.
    logger.warn(`coding container: exec hit the no-space spawn signature for ${sessionId} — recycling the container and retrying once`);
    await recycleSessionContainer(sessionId, 'exec failed: no space left on device (spawn)');
    if (await ensureSessionContainer(sessionId).catch(() => false)) {
      const retry = await attempt();
      r.failed = retry.failed; r.code = retry.code; // the retry's outcome is now the command's
      if (!retry.failed) {
        r.stdout = retry.stdout;
        r.stderr = retry.stderr + '\n[coding container: the first attempt failed at spawn because the session disk was full; the container was automatically recycled and this command re-ran on a fresh container. Container-local state (background processes, /tmp) was reset.]';
      } else if (isNoSpaceSpawnError(retry.stderr, retry.code)) {
        r.stdout = retry.stdout;
        r.stderr = retry.stderr + '\n[coding container: still out of disk after an automatic container recycle — the workspace disk needs operator attention (see docs/REMOTE_OPS.md); no further in-session recovery is possible.]';
      } else {
        // Re-provisioned fine; the retry's failure is the command's own — report as-is.
        r.stdout = retry.stdout;
        r.stderr = retry.stderr;
      }
    } else {
      r.stderr += '\n[coding container: recycled the disk-full container but re-provisioning failed — shell tools are unavailable for the rest of this run. The worktree on disk is untouched; the next run re-provisions automatically.]';
    }
  } else if (r.failed && isNoSpaceError(r.stderr)) {
    // The COMMAND itself reported ENOSPC — it ran (possibly partially), so the
    // harness must not re-execute it or prune anything. The pre-exec guard
    // engages on the next command; here we only advise.
    r.stderr += '\n[coding container: the command reported a full disk ("no space left on device"). It was NOT retried automatically — it may have partially completed. The workspace disk is likely nearly full: the pre-exec guard will auto-clean before the next command; if it persists, free space deliberately (or recycle the session container).]';
  }
  if (first.failed && shared && isContainerGoneError(first.stderr)) {
    // The shared container vanished under us (reap/restart in another process).
    // Drop the mapping so the next ensureSessionContainer re-resolves instead
    // of hammering a dead name (adversarial review of #326, finding F7/F8).
    // `sharedVanished` also invalidates dev-container.service's warm health memo,
    // which would otherwise re-resolve the SAME dead name (ticket e2f40d10).
    sharedVanished.set(sessionId, true);
    sharedOverride.delete(sessionId);
    sharedExposure.delete(sessionId);
    egressGrants.delete(sessionId);
  }
  // ticket c25f8b7e: a deploy/restart wave replaced the container WHILE this
  // run was in flight. Before this, every later command in the firing died
  // with a bare "No such container" and the lane lost the rest of its run (the
  // 2026-11-03 Schooltime lane 60dfc8a8 case: its last two probes could not
  // run at all). Distinguish the daemon's own refusal from a command that
  // merely PRINTS the phrase, then (a) say plainly that the command did NOT
  // run and what died with the old container, (b) re-provision so the rest of
  // the firing has a shell, and (c) remember the swap so the run-start notice
  // of the next firing carries the same fact.
  if (first.failed && isContainerGoneError(first.stderr, first.code)) {
    // The container this attempt actually targeted, NOT a fresh resolve: the
    // shared-mapping block above already deleted sharedOverride, so calling
    // execTargetName() here would name the per-session container when the
    // SHARED dev container is the one that died (ticket e2f40d10 review,
    // finding 2). `attemptedTarget` was captured before any memo cleanup.
    const replacedName = attemptedTarget;
    // The old container is gone; clear every memo keyed on it so the resolve
    // below really re-provisions (shared mapping, mount-mode learning, gh
    // provisioning, the failed-session backoff) instead of trusting a dead one.
    sharedVanished.set(sessionId, true); // also drops the dev-container health memo (e2f40d10)
    sharedOverride.delete(sessionId);
    sharedExposure.delete(sessionId);
    egressGrants.delete(sessionId);
    failedSessions.delete(sessionId);
    const reProvisioned = await rebindSessionContainer(sessionId);
    const replacement = await noteSessionContainerIdentity(sessionId).catch(() => null);
    const suffix = reProvisioned
      ? addendumForGoneContainer(replacement, replacedName)
      : `\n[coding container: the session container ${replacedName} was replaced under this run and could NOT be re-provisioned — shell tools are unavailable for the rest of this run. The git worktree and $DIGBY_ENV are intact; your LIVE $HOME (/tmp, the writable layer) went with the old container, so reinstall any CLI you put there when the next run re-provisions. Report this rather than retrying in a loop.]`;
    r.stderr = r.stderr ? `${r.stderr}${suffix}` : suffix.trimStart();
    logger.warn(`coding container: exec found ${replacedName} GONE for session ${sessionId} mid-run (deploy/restart wave) — re-provisioned=${reProvisioned}`);
  }
  if (guardNote) r.stderr = r.stderr ? `${guardNote}\n${r.stderr}` : guardNote;
  return r;
}

/** The note appended to a mid-run exec whose container was gone. Pure — the
 *  single wording for "your command did not run and here is what died". */
function addendumForGoneContainer(
  replacement: ContainerReplacement | null, container: string,
): string {
  const when = replacement
    ? ` It was replaced at ${replacement.replacedAt} (previous container id ${replacement.previousId.replace(/^sha256:/, '').slice(0, 12)}).`
    : '';
  return `\n[coding container: THIS COMMAND DID NOT RUN — the session container ${container} was replaced (a deploy/restart wave or a host reprovision), so docker exec had no container to run it in.${when} The container has now been re-provisioned: shell tools work again for the rest of this run, and this command can be re-run as-is (it provably never started, so re-running cannot double-apply anything). What did NOT survive: every background process you started inside the old container (start_background_process handles, generators, long probes, watchers) and container-local files (/tmp, the writable layer). What DID survive: the git worktree and $DIGBY_ENV (a worktree file). What did NOT: your LIVE $HOME — the shell's HOME is /tmp (the writable layer) unless this session runs with a scoped home on the workspace volume, so a CLI installed into the live home (including $HOME/.local/bin and $HOME/bin when HOME=/tmp) went with the old container; only image-shipped bins (/usr/local/bin, e.g. tssh, tcurl) and the worktree are still there. A tool answering 'command not found' (exit 127) is this, not a broken PATH — re-check with 'command -v <tool>' and reinstall it. Your SSH identity is gone too (ticket d9ed0c1f): pw_dir=/tmp makes ~/.ssh the container-local /tmp/.ssh, so keys/config/known_hosts died with the old container and a box deploy fails as 'Host key verification failed' (plain ssh) or 'Cannot stat /tmp/.ssh/known_hosts' (an rsync/scp-over-ssh deploy) rather than connecting — the target host is usually healthy, the CLIENT lost its identity. Re-establish it: the key survives only from the WORKTREE, and the sanctioned place there is .digby/secrets/ (git-excluded, so it never reaches a commit — a private key elsewhere in the tree can be swept into one), or use the keyless route (scripts/framework-audit/run-on-box.sh via SSM). Re-add the host key from a channel that is NOT the connection itself and compare it before writing it; NEVER disable host-key checking to get past this. Re-check any artifact an earlier run produced before relying on it, and relaunch a job with the count you can actually see.]`;
}

/**
 * ORPHANED BUILD-PROCESS REAPER (ticket db25c401). Exec legs (tsc/jest/prisma/
 * eslint) from prior "terminated" runs survive their wrappers: docker exec does
 * NOT kill the in-container process when the harness's client side dies, and an
 * OOM-SIGKILLed wrapper never reaps its children. In the SHARED dev container
 * these orphans pin the cgroup at its memory ceiling, so the NEXT run's verify
 * tsc gets SIGKILLed (exit 137, empty output — masquerading as a typecheck
 * failure). This kills, at run start, processes that:
 *   (a) belong to THIS session — cmdline contains its worktree path, so
 *       co-tenant sessions in the shared container are untouched;
 *   (b) are build/verify tools (tsc|jest|prisma|eslint) — dev servers
 *       (next dev, vite, node server…) never match;
 *   (c) are not watch-mode (tsc --watch / jest --watch stay alive on purpose);
 *   (d) are not tracked background processes — spared by process GROUP via the
 *       on-disk /tmp/digby-proc/<sid>/ registry (process.service.ts);
 *   (e) are not the reaper's own script (its argv embeds the marker).
 * Best-effort: a reap failure must never block a run.
 */
const REAPER_MARKER = 'DIGBY-ORPHAN-REAPER';

export function buildOrphanReapScript(sessionId: string): string {
  const wt = WORKTREE_DIR(sessionId);
  return `# ${REAPER_MARKER}
WT=${JSON.stringify(wt)}
SP=""
for f in /tmp/digby-proc/${sessionId}/*/pgid; do
  [ -s "$f" ] && SP="$SP $(cat "$f" 2>/dev/null)"
done
SP="$SP "
ps -eo pid=,pgid=,args= | while read -r pid pgid args; do
  case "$args" in *"$WT"*) ;; *) continue ;; esac
  case "$args" in *tsc*|*jest*|*prisma*|*eslint*) ;; *) continue ;; esac
  case "$args" in *watch*|*Watch*) continue ;; esac
  case "$args" in *${REAPER_MARKER}*) continue ;; esac
  case "$SP" in *" $pgid "*) continue ;; esac
  kill -9 "$pid" 2>/dev/null && echo "REAPED $pid $(echo "$args" | cut -c1-160)"
done
exit 0
`;
}

/** Kill this session's orphaned build/verify processes in its exec target.
 *  Returns the number reaped (0 on any failure — never throws). */
export async function reapOrphanedBuildProcesses(sessionId: string): Promise<number> {
  try {
    if (!(await isDockerAvailable())) return 0;
    const { name, shared } = await resolveReapTarget(sessionId);
    // Session commands in the shared dev container run as uid 1001 (never
    // root) — the orphans are uid-1001 processes, so the same uid can kill
    // them. Per-session containers exec as their create-time --user (1001).
    const userArgs = shared ? ['-u', '1001:1001'] : [];
    const stdout = await docker(['exec', ...userArgs, name, 'bash', '-lc', buildOrphanReapScript(sessionId)], 30_000);
    const victims = stdout.split('\n').filter(l => l.startsWith('REAPED '));
    if (victims.length) {
      logger.info(`coding container: reaped ${victims.length} orphaned build process(es) for ${sessionId} (ticket db25c401): ${victims.join(' | ').slice(0, 400)}`);
    }
    return victims.length;
  } catch (err: any) {
    logger.warn(`coding container: orphan reap failed for ${sessionId} (non-fatal): ${String(err?.message).slice(0, 120)}`);
    return 0;
  }
}

export async function stopSessionContainer(sessionId: string): Promise<void> {
  clearProcessRegistry(sessionId); // drop in-memory background-process handles
  // ticket c25f8b7e: EVERY path that reaches here is a teardown the HARNESS
  // chose (disk-pressure recycle, idle/age reap, session delete, migration) —
  // the lane is told in the same breath by the note that triggered it, so the
  // next run must register fresh rather than report a "replacement" nobody has
  // to react to. A swap the harness did NOT cause (deploy/restart wave, host
  // reprovision) never passes through here, which is exactly why it still
  // reports on the next run.
  await forgetContainerIdentity(sessionId);
  // A session on the SHARED dev container drops its mapping — the shared
  // container outlives sessions (reaped separately when the owner disables it).
  // Still rm the per-session NAME: a session that started per-session and later
  // resolved shared leaves an orphan behind (review F11); harmless if absent.
  sharedOverride.delete(sessionId);
  sharedExposure.delete(sessionId);
  egressGrants.delete(sessionId);
  ghProvisionedAt.delete(containerName(sessionId)); // a recreate must re-provision gh (ticket ad7a1c3c)
  // T7-7: a recreate re-learns its mount mode.
  wholeVolumeContainers.delete(containerName(sessionId)); scopedContainers.delete(containerName(sessionId));
  userSubtreeContainers.delete(containerName(sessionId)); // build 2026-10-08 ISO
  // ticket e2f40d10 review: the container NAME is deterministic, so a recreate at
  // the same name would hit the uid-row memo and silently skip the passwd row —
  // reinstating "No user exists for uid 1001" on the fresh container.
  forgetSessionUserRow(containerName(sessionId));
  if (!(await isDockerAvailable())) return;
  try { await docker(['rm', '-f', containerName(sessionId)]); } catch { /* already gone */ }
}

// ── Session background-process reap (ticket ff262da5 / todo 4ecfd309, 2026-10-16) ──
// The shared dev container outlives every session, so a session's background
// processes survive its runs FOREVER. The e72b88f9 operator lever reaps
// 24 h-old orphans on demand; this is the AUTOMATIC half, at the two moments
// a session's processes become garbage:
//   (1) run END — the run's untracked daemons (nothing can read/stop them
//       anymore; the agent's own tools own only tracked handles);
//   (2) session IDLE (the hourly reaper) — EVERY attributed process of an
//       idle session, tracked monitors included (the e72b88f9 33-day stray
//       class; the 2026-10-16 census: 54 session daemons, 8 × 50-day
//       ssh-agents, an 18 h next-server on a finished session's worktree).
// Attribution + scripts live in the pure leaf session-bg.ts (cwd OR inherited
// DIGBY_ENV environ — deleted-cwd blind spot — + the tracked-pgid registry).
// Exec as uid 1001 (same-uid /proc reads need no capability — the e72b88f9
// E2E lesson; root lacks CAP_SYS_PTRACE in the container's default cap set).

/** Kill ONE session's UNTRACKED background processes in its exec target.
 *  Returns { reaped, ok } — never throws (a reap failure must not block a
 *  run's finalize path). */
export async function reapSessionBackgroundProcesses(sessionId: string): Promise<{ reaped: number; ok: boolean }> {
  try {
    const { sessionRunEndReapScript, countReaped, sessionBgReapMinAgeSec, sessionBgReapDisabled } =
      await import('./session-bg');
    if (sessionBgReapDisabled()) return { reaped: 0, ok: true };
    if (!(await isDockerAvailable())) return { reaped: 0, ok: false };
    const { name, shared } = await resolveReapTarget(sessionId);
    const script = sessionRunEndReapScript(sessionId, CODING_WORKSPACE_ROOT, sessionBgReapMinAgeSec());
    const userArgs = shared ? ['-u', '1001:1001'] : [];
    const stdout = await docker(['exec', ...userArgs, name, 'bash', '-lc', script], 30_000);
    const reaped = countReaped(stdout);
    if (reaped > 0) {
      logger.info(`coding container: run-end reap took ${reaped} untracked background process(es) for session ${sessionId} (ff262da5)`);
    }
    return { reaped, ok: true };
  } catch (err: any) {
    logger.warn(`coding container: session-bg reap failed for ${sessionId} (non-fatal): ${String(err?.message ?? err).slice(0, 120)}`);
    return { reaped: 0, ok: false };
  }
}

/** Kill EVERY attributed process of the given IDLE sessions (tracked monitors
 *  included — the caller proves each session idle with no queued/running run,
 *  the e72b88f9 liveness doctrine) and drop their /tmp/digby-proc registries.
 *  One pass for all sessions (a container typically hosts dozens). Never throws. */
export async function reapIdleSessionBackgroundProcesses(sessionIds: string[]): Promise<number> {
  try {
    if (!sessionIds.length) return 0;
    const { sessionIdleReapScript, countReaped, sessionBgReapDisabled } = await import('./session-bg');
    if (sessionBgReapDisabled()) return 0;
    if (!(await isDockerAvailable())) return 0;
    // The sweep spans every session of the SHARED container: group targets by
    // resolved container name so a per-session container's sweep covers only
    // its own session. Idle victims are container-local by construction.
    // Target resolution is label-backed (ticket 4bb6a68a): the in-process map
    // is cold in a process that never resolved the session, and the per-session
    // name is a PHANTOM for a session living in the shared dev container.
    // ONE label read + ONE user-id read covers the whole sweep (this runs on
    // every idle pass over dozens of sessions — a per-session docker call would
    // turn a cheap sweep into a daemon storm).
    const rows = await runningContainerLabels();
    const userIds = new Map<string, string | null>();
    if (rows.length) {
      const ids = sessionIds.filter((sid) => !sharedOverride.has(sid));
      try {
        const found = await prisma.chatCodingState.findMany({
          where: { id: { in: ids } }, select: { id: true, userId: true },
        });
        for (const r of found as Array<{ id: string; userId: string }>) userIds.set(r.id, r.userId ?? null);
      } catch { /* DB hiccup — per-session containers still resolve from `rows` */ }
    }
    const byTarget = new Map<string, { sids: string[]; shared: boolean }>();
    for (const sid of sessionIds) {
      const { name: t, shared } = await resolveReapTarget(sid, { rows, userId: userIds.get(sid) ?? null });
      if (!byTarget.has(t)) byTarget.set(t, { sids: [], shared: false });
      const entry = byTarget.get(t)!;
      entry.sids.push(sid);
      if (shared) entry.shared = true;
    }
    let reaped = 0;
    for (const [target, { sids, shared }] of byTarget) {
      const script = sessionIdleReapScript(sids, CODING_WORKSPACE_ROOT);
      const userArgs = shared ? ['-u', '1001:1001'] : [];
      try {
        const stdout = await docker(['exec', ...userArgs, target, 'bash', '-lc', script], 30_000);
        const n = countReaped(stdout);
        if (n > 0) logger.info(`coding container: idle sweep reaped ${n} background process(es) for session(s) ${sids.join(', ').slice(0, 200)} (ff262da5)`);
        reaped += n;
        // The sweep killed every attributed process (tracked monitors too):
        // drop the in-memory handles as stopSessionContainer does, so a stale
        // 'running' handle cannot keep the worktree reaper's live check busy.
        for (const sid of sids) clearProcessRegistry(sid);
      } catch { /* one target failing must not stop the rest */ }
    }
    return reaped;
  } catch (err: any) {
    logger.warn(`coding container: idle session-bg sweep failed (non-fatal): ${String(err?.message ?? err).slice(0, 120)}`);
    return 0;
  }
}

/** A container older than this is RECYCLED even when its session never idles —
 *  self-scheduled sessions refresh updatedAt on every heartbeat, so their
 *  containers lived for weeks accumulating multi-GB writable layers (2026-08-19
 *  census: 19 running containers, up to 3GB each, some up 2 weeks). The next
 *  run recreates the container on demand; the worktree volume is untouched. */
const MAX_CONTAINER_AGE_MS = 7 * 24 * 3600 * 1000;

/** Stop + remove containers whose session is idle > 24h, plus age-recycle
 *  never-idle containers past MAX_CONTAINER_AGE_MS when no run is in flight. */
export async function reapIdleContainers(): Promise<void> {
  if (!(await isDockerAvailable())) return;
  // ff262da5 (2026-10-16): the idle sweep is ALSO the drain for session
  // background processes in the SHARED dev container — the container
  // outlives sessions, so the LABEL scan below sees only per-session
  // containers while the shared container's population (54 daemons at the
  // 2026-10-16 census) needs a DB-side census: every session of THIS host's
  // shared dev container whose updatedAt is past the cutoff AND has no
  // queued/running run (the e72b88f9 liveness doctrine) is swept — tracked
  // monitors included, they are garbage once the session idles. Fail-closed
  // on a DB error (nothing swept).
  try {
    const cutoff = new Date(Date.now() - IDLE_MS);
    const inFlight = await prisma.agentRun.findMany({
      where: { status: { in: ['queued', 'running'] } },
      select: { sessionId: true },
    });
    const live = new Set(inFlight.map((r) => r.sessionId));
    const idleSessions = await prisma.chatCodingState.findMany({
      where: { updatedAt: { lt: cutoff } },
      select: { id: true },
      // Bounded: the volume's known sessions; the sweep script's own gates
      // (uid + attribution + egress shape) bound a wrong id anyway.
      take: 2000,
    });
    const victims = idleSessions.map((s) => s.id).filter((sid) => !live.has(sid));
    if (victims.length) await reapIdleSessionBackgroundProcesses(victims);
  } catch { /* DB hiccup — the LABEL sweep below still runs */ }
  try {
    const out = (await docker(['ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{.Label "' + LABEL + '"}}'])).trim();
    const sessionIds = out ? out.split('\n').map(s => s.trim()).filter(Boolean) : [];
    if (!sessionIds.length) return;
    const cutoff = new Date(Date.now() - IDLE_MS);
    const sessions = await prisma.chatCodingState.findMany({
      where: { id: { in: sessionIds } }, select: { id: true, updatedAt: true },
    });
    const known = new Map(sessions.map(s => [s.id, s.updatedAt]));
    for (const sid of sessionIds) {
      const updatedAt = known.get(sid);
      // Reap if the session is gone OR idle past the cutoff.
      if (!updatedAt || updatedAt < cutoff) {
        await stopSessionContainer(sid);
        logger.info(`coding container: reaped idle container for session ${sid}`);
        continue;
      }
      // Age-recycle: active sessions keep their container fresh-ish. Only when
      // nothing is queued/running for the session (a mid-run recycle would kill
      // the tool executor under the agent) — the next run re-provisions.
      try {
        const created = (await docker(['inspect', '-f', '{{.Created}}', containerName(sid)])).trim();
        const ageMs = Date.now() - Date.parse(created);
        if (!Number.isFinite(ageMs) || ageMs < MAX_CONTAINER_AGE_MS) continue;
        const inFlight = await prisma.agentRun.count({
          where: { sessionId: sid, status: { in: ['queued', 'running'] } },
        });
        if (inFlight > 0) continue;
        await stopSessionContainer(sid);
        logger.info(`coding container: age-recycled container for session ${sid} (${Math.round(ageMs / 86400000)}d old)`);
      } catch { /* inspect/count hiccup — try again next pass */ }
    }
  } catch (err: any) {
    logger.debug(`coding container: reaper pass failed (non-fatal): ${err.message}`);
  }
}

let reaperTimer: ReturnType<typeof setInterval> | null = null;
export function startContainerReaper(): void {
  if (!CONTAINER_MODE || reaperTimer) return;
  // Hourly sweep. First pass shortly after boot.
  setTimeout(() => { void reapIdleContainers(); }, 60_000);
  reaperTimer = setInterval(() => { void reapIdleContainers(); }, 60 * 60 * 1000);
  logger.info('coding container: idle reaper started (hourly, 24h TTL)');
}

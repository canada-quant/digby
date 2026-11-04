/**
 * Infra-actuation lever (ticket c12239c1 — owner analysis 2026-09-10: "why did
 * the self-merging / self-fixing loop and the ticket system not fix the OOM on
 * their own?"). The 2026-09-09 incident: the shared dev container's 4 GiB
 * cgroup OOM-SIGKILLed verify chains (exit 137, empty output) for 5.5h —
 * FOURTEEN lane runs root-caused it correctly, FOUR tickets were filed, and
 * every lane stood down because no tool in the platform/coding toolset could
 * touch INFRASTRUCTURE; a human ran `docker update --memory 12g --cpus 4` at
 * 03:30Z and oom_kill flatlined at 219. This service is the missing lever.
 *
 * Two entry surfaces:
 *
 *   1. runInfraAction — backs the `infra_action` platform tool (machine lanes
 *      + supervisor). Kinds:
 *        env_probe            READ-ONLY, always executes: docker host capacity
 *                             (MemTotal/NCPU via `docker info` — INFO=1 is the
 *                             only probe the socket-proxy filter allows;
 *                             SYSTEM/VOLUMES are blocked) + the target dev
 *                             container's cgroup memory.current / memory.max /
 *                             oom_kill — the 2026-09-09 diagnostic signature.
 *        dev_container_resize grow-only live `docker update --memory [--cpus]`
 *                             (CONTAINERS+POST pass the proxy filter — proven
 *                             by ensureDevMemoryCeiling). Hard caps: memory ≤
 *                             host−4 GiB, cpus ≤ host−2. Grow-only: shrinking
 *                             a live container under its usage triggers the
 *                             OOM killer (same doctrine as db25c401).
 *        reap_orphans         kill >30-min orphaned `tsc --noEmit` / jest
 *                             processes inside the dev container — deploys
 *                             orphan them against the shared cgroup (same
 *                             signature as verify.service's pre-chain reap).
 *        reap_orphans_session_daemons
 *                             (ticket e72b88f9 / backlog DC-1, 2026-10-14) list
 *                             + reap daemons a SESSION spawned into the SHARED
 *                             dev container that outlived it — the 33-day stray
 *                             tailscaled on :1057. A victim needs ALL of: cwd
 *                             under a session worktree (both layouts), non-root
 *                             uid, args clear of the platform-egress SHAPE
 *                             (statedir / 1055 / 1056 — identified by function,
 *                             never by pid), age ≥ 24 h (env floor), and an
 *                             owner session with NO queued/running run
 *                             (fail-closed). env_probe surfaces the candidates
 *                             (probe.sessionDaemons) for the wedge-diagnosis
 *                             path; kill switch INFRA_SESSION_DAEMON_REAP_DISABLED.
 *        worker_restart       PROPOSE-ONLY by default: restarting the worker
 *                             from a process that may BE the worker is the
 *                             self-restart paradox, and the worker lifecycle
 *                             belongs to the deploy pipeline. Executes only
 *                             when armed AND INFRA_WORKER_RESTART_ARMED=1 AND
 *                             an explicit target is set AND target ≠ own
 *                             hostname.
 *        prune_build_cache    (WI-Q, 2026-09-25 — the disk-alert playbook's
 *                             step 1 as a lever instead of a dispatched lane)
 *                             `docker builder prune -af --filter until=<72h>
 *                             --keep-storage <N>GB` on THIS process's docker
 *                             host: entries older than INFRA_PRUNE_UNTIL beyond
 *                             a retained-cache cap of INFRA_PRUNE_KEEP_STORAGE_GB.
 *                             Env-armed like the others (dry-run receipt with
 *                             the exact command until INFRA_ACTIONS_ENABLED=1);
 *                             NX cooldown 6 h per HOST (target = the box
 *                             label) — claimed up front like every kind, but
 *                             RELEASED on the unarmed dry-run and on an
 *                             ok:false error receipt (review fix 2026-09-25):
 *                             only a prune that actually ran burns the window,
 *                             so arming the lever / adding BUILD=1 inside the
 *                             6 h does not leave it refusing with cooldown:true
 *                             while nothing was reclaimed. Regenerable data
 *                             only — never volumes, containers, or the coding
 *                             workspaces volume. Host-level: the platform tool
 *                             executes it only for admin users / supervisor
 *                             chats (platform-tools.ts infra_action).
 *                             NOTE: the coding box's socket proxy grants
 *                             CONTAINERS/IMAGES/INFO only (docker-compose.base
 *                             .yml) — an ARMED prune through it answers 403
 *                             until ops adds BUILD=1; the receipt names that.
 *                             CLI NOTE: `--keep-storage` is DEPRECATED on
 *                             docker ≥ 28 in favour of `--max-used-space`
 *                             (still accepted as an alias for now); `-a`
 *                             prunes ALL cache entries matching the `until`
 *                             filter, not just dangling ones — that is the
 *                             intent (the filter is the age floor). If a CLI
 *                             bump on the box drops the alias, every armed
 *                             prune turns into an ok:false receipt naming the
 *                             flag — set INFRA_PRUNE_KEEP_STORAGE_GB=0 to omit
 *                             it entirely (age floor only) until the flag is
 *                             switched here.
 *        propose_volume_growth READ + PROPOSE ONLY, never executes anything:
 *                             statfs of the named mount (default '/') ⇒ the
 *                             exact `aws ec2 modify-volume --size <n>` (+ the
 *                             growpart/resize2fs follow-up) and the projected
 *                             monthly cost delta at INFRA_GP3_USD_PER_GB_MONTH.
 *                             Growing a volume is OWNER SPEND — the receipt is
 *                             what the supervisor attaches to its ONE
 *                             flag_owner_question, never an action. Read-only
 *                             but NOT free of the cooldown: like env_probe it
 *                             carries the INFRA_PROBE_COOLDOWN_SEC (5 min) NX
 *                             window per box — a repeat inside it answers
 *                             cooldown:true with no proposal (the previous
 *                             receipt is the proposal). Host-level: admin /
 *                             supervisor-chat callers only at the tool.
 *
 *   2. sweepEnvRedInfraStreak — the attention-watchdog trigger (ASK #2): ≥3
 *      verify_env_red loop_metrics across ≥2 distinct sessions in 30 min (the
 *      fleet-wide OOM signature) ⇒ env_probe + dev_container_resize for each
 *      implicated session owner, instead of a fifteenth re-diagnosis.
 *
 * OBSERVE-ONLY DEFAULT (ASK #4): mutating kinds return DRY-RUN receipts
 * (desired state + the exact docker command) until ops arms
 * INFRA_ACTIONS_ENABLED=1 — the gate is the environment, not the confirmation
 * protocol, precisely so unattended machine lanes self-heal once a human has
 * reviewed a week of dry-run receipts. EVERY call (dry-run, refused, cooldown
 * included) writes ONE loop_metrics `infra_action` row — the receipt log the
 * owner reviews before arming.
 *
 * Safety shape: per-kind+target Redis NX cooldown (fail-CLOSED for mutations —
 * a Redis hiccup reads as "on cooldown", never as a free volley); hard caps
 * derived from the live host; docker actuation rides the process's DOCKER_HOST
 * like every other caller (the app env points it at the coding box's filtered
 * proxy — the same assumption the web-box dev-container restart twins make).
 * Nothing here throws into a caller: failures return ok:false receipts.
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import os from 'os';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import {
  devContainerName, parseMemoryBytes, resolveDevMemoryCeiling, dockerHostCapacity, memoryGrowArgs, parseMemoryInspect,
} from '../coding/dev-container.service';
import { boxLabel } from './infra-watch.service';

// ── Kinds + tunables ──────────────────────────────────────────────────────────

export const INFRA_ACTION_KINDS = ['env_probe', 'dev_container_resize', 'reap_orphans', 'reap_orphans_session_daemons', 'worker_restart', 'dev_container_restart', 'prune_build_cache', 'propose_volume_growth'] as const;
export type InfraActionKind = (typeof INFRA_ACTION_KINDS)[number];

/** The mutating kinds — everything except the read-only probe + the read-only volume proposal. */
const MUTATING_KINDS: ReadonlySet<InfraActionKind> = new Set(['dev_container_resize', 'reap_orphans', 'reap_orphans_session_daemons', 'worker_restart', 'dev_container_restart', 'prune_build_cache']);

/** Host-level kinds: they target the docker HOST / the box, not the caller's dev container, so no userId is needed. */
const HOST_LEVEL_KINDS: ReadonlySet<InfraActionKind> = new Set(['worker_restart', 'prune_build_cache', 'propose_volume_growth']);

/** Armed posture (ASK #4): read per call so ops can flip it live. */
export function infraActionsArmed(): boolean {
  return process.env.INFRA_ACTIONS_ENABLED === '1';
}

/** Per-kind NX cooldown (seconds): one action per kind+target per window.
 *  Read per call (like infraActionsArmed) so ops can flip it live. */
const COOLDOWN_SEC: Record<InfraActionKind, () => number> = {
  env_probe: () => Number(process.env.INFRA_PROBE_COOLDOWN_SEC || 300),
  dev_container_resize: () => Number(process.env.INFRA_ACTION_COOLDOWN_SEC || 1800),
  reap_orphans: () => Number(process.env.INFRA_ACTION_COOLDOWN_SEC || 1800),
  reap_orphans_session_daemons: () => Number(process.env.INFRA_ACTION_COOLDOWN_SEC || 1800),
  worker_restart: () => Number(process.env.INFRA_ACTION_COOLDOWN_SEC || 1800),
  dev_container_restart: () => Number(process.env.INFRA_ACTION_COOLDOWN_SEC || 1800),
  // 6 h per HOST (WI-Q): BuildKit cache regrows one wave at a time — a second
  // prune inside the window reclaims nothing and is a loop, not a fix.
  prune_build_cache: () => Number(process.env.INFRA_PRUNE_COOLDOWN_SEC || 6 * 3600),
  // read-only like env_probe
  propose_volume_growth: () => Number(process.env.INFRA_PROBE_COOLDOWN_SEC || 300),
};

/** Hard caps (ASK #1): never give a container the host's last 4 GiB / 2 cpus. */
const HOST_MEM_RESERVE_BYTES = 4 * 1024 ** 3;
const HOST_CPU_RESERVE = 2;

// ── prune_build_cache / propose_volume_growth tunables (WI-Q, 2026-09-25) ────

/** `--filter until=<x>` for the BuildKit prune — 72h keeps the current wave's layers warm. */
export const PRUNE_UNTIL_DEFAULT = '72h';
/** `--keep-storage <N>GB`: the cap on the build cache retained after the prune. */
export const PRUNE_KEEP_STORAGE_GB_DEFAULT = 20;
export function pruneUntil(env: NodeJS.ProcessEnv = process.env): string {
  const v = String(env.INFRA_PRUNE_UNTIL || '').trim();
  return /^\d+[hmd]$/.test(v) ? v : PRUNE_UNTIL_DEFAULT;
}
export function pruneKeepStorageGb(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.INFRA_PRUNE_KEEP_STORAGE_GB);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : PRUNE_KEEP_STORAGE_GB_DEFAULT;
}
/**
 * The exact prune command (the dry-run receipt content; `-f` because there is
 * no TTY). `--keep-storage` is deprecated on newer CLIs (alias of
 * `--max-used-space`, see the header) — INFRA_PRUNE_KEEP_STORAGE_GB=0 OMITS
 * the flag entirely (docker treats 0 as "no cap" anyway), which is the escape
 * hatch if a CLI bump drops the alias.
 */
export function pruneBuildCacheArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const keep = pruneKeepStorageGb(env);
  return ['builder', 'prune', '-af', '--filter', `until=${pruneUntil(env)}`, ...(keep > 0 ? ['--keep-storage', `${keep}GB`] : [])];
}

/** gp3 list price in ca-central-1 (USD per GiB-month, 2026-09) — the cost line's rate; override per region. */
export const GP3_USD_PER_GB_MONTH_DEFAULT = 0.088;
export function gp3UsdPerGbMonth(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.INFRA_GP3_USD_PER_GB_MONTH);
  return Number.isFinite(n) && n > 0 ? n : GP3_USD_PER_GB_MONTH_DEFAULT;
}
/** Target usage after growth + the size step: grow to the next 50 GiB step that lands usage ≤ 70%. */
export const VOLUME_GROWTH_TARGET_USED_FRACTION = 0.70;
export const VOLUME_GROWTH_STEP_GIB = 50;
const GIB = 1024 ** 3;

export interface VolumeGrowthProposal {
  volumePath: string;
  volumeId: string | null;
  instanceId: string | null;
  host: string;
  currentSizeGib: number;
  usedGib: number;
  freeGib: number;
  usedPct: number;
  proposedSizeGib: number;
  deltaGib: number;
  usdPerGibMonth: number;
  monthlyCostDeltaUsd: number;
  /** the exact modify-volume command (volume id filled from args/INFRA_VOLUME_ID, else a placeholder) */
  command: string;
  /** how to find the volume id when it is a placeholder */
  discoverCommand: string;
  /** the in-guest steps after the EBS grow (online, no reboot) */
  followUp: string;
  proposalOnly: true;
}

/**
 * Pure (WI-Q): from a statfs reading, the growth proposal + cost delta.
 * Sizes are GiB (EBS units); statfs total is slightly under the volume size
 * (fs overhead) so currentSizeGib is the ceiling. Proposed = the smallest
 * VOLUME_GROWTH_STEP_GIB multiple that puts usage ≤ 70%, and always ≥ current
 * + one step (a proposal that changes nothing is not a proposal).
 */
export function proposeVolumeGrowth(
  st: { totalBytes: number; freeBytes: number; usedBytes: number },
  opts: { volumePath: string; volumeId?: string | null; instanceId?: string | null; host: string; region?: string; usdPerGibMonth?: number },
): VolumeGrowthProposal {
  const currentSizeGib = Math.max(1, Math.ceil(st.totalBytes / GIB));
  const usedGib = Math.round((st.usedBytes / GIB) * 10) / 10;
  const freeGib = Math.round((st.freeBytes / GIB) * 10) / 10;
  const denom = st.usedBytes + st.freeBytes;
  const usedPct = denom > 0 ? Math.round((st.usedBytes / denom) * 100) : 0;
  const step = VOLUME_GROWTH_STEP_GIB;
  const forUsage = Math.ceil((st.usedBytes / VOLUME_GROWTH_TARGET_USED_FRACTION) / GIB / step) * step;
  const proposedSizeGib = Math.max(forUsage, currentSizeGib + step);
  const deltaGib = proposedSizeGib - currentSizeGib;
  const usdPerGibMonth = opts.usdPerGibMonth ?? gp3UsdPerGbMonth();
  const monthlyCostDeltaUsd = Math.round(deltaGib * usdPerGibMonth * 100) / 100;
  const region = opts.region || process.env.AWS_REGION || 'ca-central-1';
  const volumeId = opts.volumeId || null;
  const instanceId = opts.instanceId || null;
  return {
    volumePath: opts.volumePath,
    volumeId,
    instanceId,
    host: opts.host,
    currentSizeGib, usedGib, freeGib, usedPct, proposedSizeGib, deltaGib, usdPerGibMonth, monthlyCostDeltaUsd,
    command: `aws ec2 modify-volume --region ${region} --volume-id ${volumeId ?? '<volume-id>'} --size ${proposedSizeGib}`,
    discoverCommand: `aws ec2 describe-volumes --region ${region} --filters Name=attachment.instance-id,Values=${instanceId ?? `<instance-id of ${opts.host}>`} --query 'Volumes[].[VolumeId,Size,Attachments[0].Device]' --output table`,
    followUp: 'then on the box (online, no reboot): sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1 (xfs: sudo xfs_growfs /) — verify with df -h and the next box_health row',
    proposalOnly: true,
  };
}

/** statfs of a mount as plain byte counts; throws on an unreadable path. */
async function readMountUsage(mountPath: string): Promise<{ totalBytes: number; freeBytes: number; usedBytes: number }> {
  const st: any = await (fs as any).statfs(mountPath);
  const bsize = Number(st.bsize);
  const totalBytes = Number(st.blocks) * bsize;
  const freeBytes = Number(st.bavail) * bsize;
  const usedBytes = totalBytes - Number(st.bfree) * bsize;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) throw new Error(`statfs(${mountPath}) returned no size`);
  return { totalBytes, freeBytes, usedBytes };
}

/** Parse `Total reclaimed space: 1.234GB` from `docker builder prune` output (null when absent). */
export function parseReclaimedSpace(stdout: string): string | null {
  const m = /Total reclaimed space:\s*([0-9.]+\s*[KMGT]?i?B)/i.exec(String(stdout || ''));
  return m ? m[1].replace(/\s+/g, '') : null;
}

// ── Receipt ───────────────────────────────────────────────────────────────────

export interface InfraActionReceipt {
  ok: boolean;
  kind: InfraActionKind;
  /** container name the action targets (the BOX label for host-level kinds; null for a host-only probe). */
  target: string | null;
  /** true when the platform is NOT armed and a mutation was only proposed. */
  dryRun: boolean;
  /** true when a real probe ran / a real mutation was applied. */
  executed: boolean;
  reason: string;
  armed: boolean;
  host?: { memTotalBytes: number | null; ncpu: number | null; hostname: string };
  /** env_probe payload: cgroup + capacity readings. */
  probe?: Record<string, unknown>;
  /** resize/reap: the desired (or applied) end-state + the docker command. */
  desired?: Record<string, unknown>;
  /** which hard cap clamped the request (host-mem-reserve | host-cpu-reserve). */
  cappedBy?: string;
  /** honest refusal (grow-only no-op, proposal-only worker_restart, ...). */
  refused?: string;
  /** skipped by the per-kind NX cooldown. */
  cooldown?: boolean;
  /** docker/infra error text (truncated) when ok:false. */
  error?: string;
  at: string;
}

function docker(args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/** One telemetry receipt per call — fire-and-forget, never throws. */
function noteAction(sessionId: string | undefined, r: InfraActionReceipt): void {
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.INFRA_ACTION,
      sessionId,
      meta: {
        action: r.kind, target: r.target, dryRun: r.dryRun, executed: r.executed,
        reason: r.reason.slice(0, 200),
        ...(r.refused ? { refused: r.refused.slice(0, 200) } : {}),
        ...(r.cappedBy ? { cappedBy: r.cappedBy } : {}),
        ...(r.cooldown ? { cooldown: true } : {}),
        ...(r.error ? { error: r.error.slice(0, 200) } : {}),
        // prune_build_cache (review fix 2026-09-25): the dry-run command and
        // the reclaimed/disk readings used to live only in the tool result —
        // the prod verification query reads them from here:
        //   SELECT meta FROM loop_metrics WHERE kind='infra_action' AND meta->>'action'='prune_build_cache'
        ...(r.kind === 'prune_build_cache' && r.desired ? pruneMetricMeta(r.desired) : {}),
      },
    });
  } catch { /* telemetry must never take the action path down */ }
}

/** The prune receipt's telemetry slice (command + reclaimed + disk % before/after), absent keys omitted. */
function pruneMetricMeta(desired: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['command', 'reclaimed', 'diskPctBefore', 'diskPctAfter', 'diskFreeGbBefore', 'diskFreeGbAfter'] as const) {
    if (desired[k] !== undefined && desired[k] !== null) out[k] = desired[k];
  }
  return out;
}

/**
 * Per-kind+target NX cooldown. Mutating kinds fail CLOSED: a Redis hiccup is
 * indistinguishable from "already cooling down", and a mutation must never get
 * a free volley out of an infrastructure outage. The read-only probe fails
 * OPEN (worst case: one extra read-only `docker info`).
 */
async function claimCooldown(kind: InfraActionKind, target: string | null): Promise<boolean> {
  const key = `infra-action:cooldown:${kind}${target ? `:${target}` : ''}`;
  const nx = await (redisClient as any)
    .set(key, new Date().toISOString(), { NX: true, EX: Math.max(1, COOLDOWN_SEC[kind]()) })
    .catch(() => null);
  if (nx === 'OK') return true;
  return !MUTATING_KINDS.has(kind); // mutating: fail-closed; probe: fail-open
}

/**
 * Give a claimed cooldown window back — for a call that claimed it and then
 * did NOT act (an unarmed dry-run, an ok:false error receipt). Best-effort:
 * a failed DEL just leaves the original window in place.
 */
async function releaseCooldown(kind: InfraActionKind, target: string | null): Promise<void> {
  const key = `infra-action:cooldown:${kind}${target ? `:${target}` : ''}`;
  await (redisClient as any).del(key).catch(() => {});
}

// ── env_probe ─────────────────────────────────────────────────────────────────

interface CgroupMem { currentBytes: number | null; maxBytes: number | null; oomKill: number | null; }

/** The 2026-09-09 signature, straight from the container's cgroup v2 files. */
async function probeCgroupMemory(name: string): Promise<CgroupMem> {
  const empty = { currentBytes: null, maxBytes: null, oomKill: null };
  try {
    const { stdout } = await docker([
      'exec', name, 'sh', '-c',
      'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.events 2>/dev/null',
    ], 20_000);
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const num = (v: string | undefined): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    // memory.current and memory.max are bare numbers on their own lines
    // (memory.max can be the literal "max"); memory.events is "key value" rows.
    const currentBytes = num(lines[0]);
    const maxBytes = lines[1] === 'max' ? null : num(lines[1]);
    const oomLine = lines.find((l) => l.startsWith('oom_kill '));
    const oomKill = oomLine ? num(oomLine.split(/\s+/)[1]) : null;
    return { currentBytes, maxBytes, oomKill };
  } catch {
    return empty;
  }
}

// ── reap_orphans / session-daemon surfacing (ticket e72b88f9, 2026-10-14) ─────

/** The 2026-10-14 incident class (ticket e72b88f9): a session spawned a SECOND
 *  tailscaled into the SHARED dev container from its worktree scratch dir; the
 *  session finished 33 days before the daemon was noticed, still answering
 *  SOCKS5 on :1057 with a "General SOCKS server failure" that read as a wedged
 *  platform egress. reap_orphans knew only the tsc/jest orphan signature, so a
 *  session daemon persisted indefinitely. */
export const SESSION_DAEMON_MIN_AGE_SEC_DEFAULT = 86400;

export function sessionDaemonMinAgeSec(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.INFRA_SESSION_DAEMON_MIN_AGE_SEC);
  return Number.isFinite(n) && n >= 600 ? Math.floor(n) : SESSION_DAEMON_MIN_AGE_SEC_DEFAULT;
}

/** A `ps -eo pid,uid,etimes,args` line split into columns. */
export interface DaemonPsLine {
  pid: string;
  uid: string;
  etimes: number | null;
  args: string;
  raw: string;
}

/** One session-spawned daemon candidate, parsed from ps + its session's cwd. */
export interface SessionDaemonCandidate {
  pid: string;
  uid: string;
  etimes: number | null;
  /** the session (chatCodingState) id whose worktree the daemon was launched from */
  sessionId: string | null;
  cwd: string;
  args: string;
}

/**
 * Pure: parse `ps -eo pid,uid,etimes,args` output and keep the lines that are
 * session-spawned daemon candidates — cwd under ${CODING_WORKSPACE_ROOT}/worktrees/
 * (the cwd prefix IS the "session-spawned" test: the harness never starts
 * anything there; only a session's own run did). Exclusions by design:
 *  - uid 0 (the root-run platform daemons — e.g. the PLATFORM tailscaled on
 *    ports 1055/1056, which the shared dev container hosts deliberately);
 *  - the known ephemeral build/test one-shots (tsc/jest) — a different orphan
 *    class with its own 30-min floor;
 *  - the verify pre-chain reap signature, not duplicated here.
 * The 24-hour default floor (sessionDaemonMinAgeSec) still applies before any
 * kill decision: a LIVE-or-idle session's legitimately-spawned helper daemon
 * (a dev server it re-visits across runs) survives an idle night, and the
 * liveness check (daemonSessionIdsWithInFlightRun) is the second gate. The
 * incident daemon ran 33 DAYS — the floor is a garbage-collection horizon,
 * not a realtime killer.
 */
/**
 * The platform-egress daemon's args SHAPE (DC-1 caveat, ticket e72b88f9): the
 * platform tailscaled is identified by its statedir / bound ports, NEVER by a
 * remembered pid (it respawns — 1588133 → 1663628 within hours on
 * 2026-10-14). Belt-and-braces under the uid-0 exclusion: even if it were ever
 * run non-root, these distinctive flags keep it out of every reap decision.
 */
export const PLATFORM_EGRESS_ARGS_PATTERN = /--statedir=\/var\/lib\/digby-tailscale|--statedir=\/var\/lib\/tailscale|socks5-server=localhost:1055|outbound-http-proxy-listen=localhost:1056/;

/** Dedicated kill switch (doctrine — every automated reaper carries one):
 *  INFRA_SESSION_DAEMON_REAP_DISABLED=1 refuses the reap (listing still works
 *  via env_probe surfacing + the unarmed dry-run receipt). */
export function sessionDaemonReapDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INFRA_SESSION_DAEMON_REAP_DISABLED === '1';
}

export function filterSessionDaemonLines(
  psOut: string,
  opts: { excludeArgsPattern?: RegExp; platformEgressArgsPattern?: RegExp } = {},
): { candidates: SessionDaemonCandidate[]; lines: DaemonPsLine[] } {
  const exclude = opts.excludeArgsPattern ?? /(^|\/)(tsc|jest)( |$)|node_modules\/\.bin\//;
  const platformEgress = opts.platformEgressArgsPattern ?? PLATFORM_EGRESS_ARGS_PATTERN;
  const lines: DaemonPsLine[] = [];
  const candidates: SessionDaemonCandidate[] = [];
  for (const raw of String(psOut || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^\s*PID\b/.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const pid = cols[0];
    const uid = cols[1];
    const etimes = Number(cols[2]);
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(uid)) continue;
    const args = cols.slice(3).join(' ');
    lines.push({ pid, uid, etimes: Number.isFinite(etimes) ? etimes : null, args, raw: line });
    if (uid === '0') continue; // platform daemons run as root — never ours to kill
    if (platformEgress.test(args)) continue; // the egress daemon's SHAPE, even non-root (DC-1 caveat)
    if (exclude.test(args)) continue; // tsc/jest one-shots: their own reap class
    // cwd resolution happens per-pid at reap time; the candidate carries what
    // ps gave us. cwd is filled by the caller (readlink /proc/<pid>/cwd).
    candidates.push({ pid, uid, etimes: Number.isFinite(etimes) ? etimes : null, sessionId: null, cwd: '', args });
  }
  return { candidates, lines };
}

/**
 * Pure: attach the /proc/<pid>/cwd reading to candidates. Only processes whose
 * cwd sits under the workspace root AND below a `worktrees/` segment count as
 * session-spawned (both layouts: legacy `<root>/worktrees/<sid>/…` and
 * per-user `<root>/<key>/worktrees/<sid>/…` — workspace-layout.ts); the
 * sessionId is the first path segment after `worktrees/`.
 */
export function attachDaemonCwds(
  candidates: SessionDaemonCandidate[],
  cwds: Record<string, string | null>,
  workspaceRoot: string,
): SessionDaemonCandidate[] {
  const root = String(workspaceRoot || '').replace(/\/+$/, '') + '/';
  return candidates
    .map((c) => {
      const cwd = cwds[c.pid];
      if (!cwd || !cwd.startsWith(root)) return null; // e.g. the platform tailscaled (cwd /)
      // .sandbox-home/<sid> (the legacy sandbox-home layout — review N1): the
      // owning session is the segment AFTER .sandbox-home, not the marker itself.
      const m = /\/worktrees\/(?:\.sandbox-home\/)?([^/]+)/.exec(cwd.slice(root.length - 1));
      if (!m) return null; // under the volume but not under a session worktree
      // N1 residual: a cwd ENDING at the marker (…/worktrees/.sandbox-home, with or
      // without a trailing slash) has no session segment after it, so the regex
      // above backtracks and captures the MARKER itself as the id — no run ever has
      // that id, so it would slip the liveness gate and be reaped under a phantom
      // session. The bare marker is never a session worktree.
      if (m[1] === '.sandbox-home') return null;
      return { ...c, cwd, sessionId: m[1] || null };
    })
    .filter((c): c is SessionDaemonCandidate => c !== null);
}

/** The sh(1) case patterns matching a session-worktree cwd in BOTH layouts. */
export function worktreeCwdCasePatterns(workspaceRoot: string): string {
  const root = String(workspaceRoot || '/app/coding-workspaces').replace(/\/+$/, '').replace(/'/g, '');
  return `'${root}/worktrees/'*|'${root}/'*'/worktrees/'*`;
}

/** The reap command for the surviving victims — re-verifies EVERY gate at kill
 *  time (cwd case-pattern, non-root uid, age floor) so a pid that re-cycled
 *  between the scan and the kill can never die by stale data. */
export function sessionDaemonReapCommand(pids: string[], minAgeSec: number, workspaceRoot: string): string {
  const list = pids.map((p) => String(Number(p))).filter((p) => p !== 'NaN' && p !== '0').join(' ');
  const floor = Math.max(1, Math.floor(minAgeSec));
  return `for p in ${list}; do e=$(ps -o etimes= -p $p 2>/dev/null | tr -d ' '); u=$(ps -o uid= -p $p 2>/dev/null | tr -d ' '); `
    + `cwd=$(readlink /proc/$p/cwd 2>/dev/null); case "$cwd" in ${worktreeCwdCasePatterns(workspaceRoot)}) `
    + `if [ "$u" != "0" ] && [ -n "$e" ] && [ "$e" -ge ${floor} ]; then kill -9 $p 2>/dev/null; fi;; esac; done; true`;
}

/** The workspace root both the scan and the kill-time case patterns key on. */
export function sessionDaemonWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.CODING_WORKSPACE_ROOT || '/app/coding-workspaces').replace(/\/+$/, '');
}

/**
 * Scan one dev container for session-spawned daemon candidates: ps (pid, uid,
 * etimes, args) + one readlink round-trip for the cwds. Pure parsing lives in
 * filterSessionDaemonLines / attachDaemonCwds; this is the docker-exec shell.
 * Read-only — no kill decision happens here.
 */
async function scanSessionDaemons(
  container: string,
): Promise<{ ok: true; candidates: SessionDaemonCandidate[]; workspaceRoot: string } | { ok: false; error: string }> {
  const workspaceRoot = sessionDaemonWorkspaceRoot();
  const psCmd = 'ps -eo pid,uid,etimes,args 2>/dev/null || true';
  let psOut = '';
  try {
    const { stdout } = await docker(['exec', container, 'sh', '-c', psCmd], 20_000);
    psOut = stdout;
  } catch (err: any) {
    return { ok: false, error: `exec ps ${container}: ${String(err?.message ?? err).slice(0, 160)}` };
  }
  const { candidates: uidFiltered } = filterSessionDaemonLines(psOut);
  if (!uidFiltered.length) return { ok: true, candidates: [], workspaceRoot };
  // cwd round-trip AS THE OWNING UID, one exec per uid (2026-10-14 E2E, ticket
  // e72b88f9): `docker exec` defaults to root, and the dev container's default
  // capability set LACKS CAP_SYS_PTRACE — root gets EACCES on every cross-uid
  // readlink of /proc/<pid>/cwd, so a root-default round-trip returns all-null
  // cwds and the scan goes BLIND (0 candidates with dozens present — exactly
  // what the first deployed build returned). Same-uid readlink needs no
  // capability, so group the candidates by their ps uid and exec each group
  // with -u. (ps itself is world-readable and stays on the root exec.)
  const pidsByUid = new Map<string, string[]>();
  for (const c of uidFiltered) {
    if (!pidsByUid.has(c.uid)) pidsByUid.set(c.uid, []);
    pidsByUid.get(c.uid)!.push(c.pid);
  }
  const cwds: Record<string, string | null> = {};
  for (const [uid, pids] of pidsByUid) {
    const cwdCmd = `for p in ${pids.join(' ')}; do printf '%s ' "$p"; readlink /proc/$p/cwd 2>/dev/null || echo; echo; done`;
    let cwdOut = '';
    try {
      const { stdout } = await docker(['exec', '-u', uid, container, 'sh', '-c', cwdCmd], 20_000);
      cwdOut = stdout;
    } catch (err: any) {
      return { ok: false, error: `exec readlink (uid ${uid}) ${container}: ${String(err?.message ?? err).slice(0, 160)}` };
    }
    for (const line of cwdOut.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const sp = t.indexOf(' ');
      if (sp <= 0) continue;
      cwds[t.slice(0, sp)] = t.slice(sp + 1).trim() || null;
    }
  }
  return { ok: true, candidates: attachDaemonCwds(uidFiltered, cwds, workspaceRoot), workspaceRoot };
}

/**
 * The liveness gate: which of the candidate session ids currently have a
 * queued/running agent run. Those daemons are NOT orphans — their session is
 * live, and killing them would break a running lane's own tooling. Fail-closed
 * (unreadable → treat as in-flight).
 */
export async function daemonSessionIdsWithInFlightRun(sessionIds: string[]): Promise<{ inFlight: Set<string>; unreadable: boolean }> {
  const unique = [...new Set(sessionIds.filter((s) => typeof s === 'string' && s.trim()))];
  if (!unique.length) return { inFlight: new Set(), unreadable: false };
  try {
    const runs = await prisma.agentRun.findMany({
      where: { sessionId: { in: unique }, status: { in: ['queued', 'running'] } },
      select: { sessionId: true },
    });
    return { inFlight: new Set(runs.map((r) => r.sessionId)), unreadable: false };
  } catch {
    return { inFlight: new Set(unique), unreadable: true };
  }
}

// ── The lever ─────────────────────────────────────────────────────────────────

export interface InfraActionRequest {
  kind: InfraActionKind;
  /** dev-container owner (resize/reap target, probe container). Omit for a host-only probe. */
  userId?: string;
  /** explicit resize target in bytes (validated + clamped to the hard caps). */
  memoryBytes?: number;
  /** explicit resize target in cpus (clamped to host−2). */
  cpus?: number;
  /** audit trail — REQUIRED: why this action, in one line. */
  reason: string;
  /** calling lane's session id, stamped on the loop_metrics receipt. */
  sessionId?: string;
  /** propose_volume_growth only: the mount to measure (default '/', the root disk the deploy pre-flight measures). */
  volumePath?: string;
  /** propose_volume_growth only: the EBS volume id to fill into the command (else INFRA_VOLUME_ID, else a placeholder). */
  volumeId?: string;
}

export async function runInfraAction(req: InfraActionRequest): Promise<InfraActionReceipt> {
  const armed = infraActionsArmed();
  const reason = String(req.reason || '').trim() || 'unspecified';
  // Host-level kinds (WI-Q) target the BOX, so their cooldown + receipt key on
  // the box label, never on the caller's dev container.
  const target = HOST_LEVEL_KINDS.has(req.kind) && req.kind !== 'worker_restart'
    ? boxLabel()
    : req.userId ? devContainerName(req.userId) : null;
  const base: InfraActionReceipt = {
    ok: true, kind: req.kind, target, dryRun: false, executed: false,
    reason, armed, at: new Date().toISOString(),
  };
  const finish = (r: InfraActionReceipt): InfraActionReceipt => {
    noteAction(req.sessionId, r);
    if (!r.ok || r.refused || r.cooldown) {
      logger.warn(`infra-action ${r.kind} target=${r.target ?? '-'} ok=${r.ok} executed=${r.executed} dryRun=${r.dryRun}${r.refused ? ` refused=${r.refused}` : ''}${r.cooldown ? ' (cooldown)' : ''}${r.error ? ` error=${r.error}` : ''}`);
    } else {
      logger.info(`infra-action ${r.kind} target=${r.target ?? '-'} executed=${r.executed} dryRun=${r.dryRun} reason=${r.reason}`);
    }
    return r;
  };

  if (!INFRA_ACTION_KINDS.includes(req.kind)) {
    return finish({ ...base, ok: false, refused: `unknown kind ${String(req.kind)} — one of ${INFRA_ACTION_KINDS.join(' | ')}` });
  }
  if (MUTATING_KINDS.has(req.kind) && !req.userId && !HOST_LEVEL_KINDS.has(req.kind)) {
    return finish({ ...base, ok: false, refused: `${req.kind} needs userId (the dev-container owner)` });
  }

  // NX cooldown FIRST — one volley per kind+target per window.
  if (!(await claimCooldown(req.kind, target))) {
    return finish({ ...base, cooldown: true, refused: `${req.kind} is on cooldown for ${target ?? 'host'} (NX ${COOLDOWN_SEC[req.kind]()}s) — a repeat within the window is a loop, not a fix` });
  }

  // ── propose_volume_growth (READ + PROPOSE ONLY — never executes; WI-Q) ──
  // Branches BEFORE the docker host read: this is a statfs of a mount on THIS
  // box, and the web boxes' DOCKER_HOST path is dead by design (2026-09-24).
  if (req.kind === 'propose_volume_growth') {
    const volumePath = String(req.volumePath || '/').trim() || '/';
    if (!volumePath.startsWith('/') || volumePath.includes('..')) {
      return finish({ ...base, ok: false, refused: `volumePath must be an absolute mount path (got '${volumePath.slice(0, 80)}')` });
    }
    let usage: { totalBytes: number; freeBytes: number; usedBytes: number };
    try {
      usage = await readMountUsage(volumePath);
    } catch (err: any) {
      return finish({ ...base, ok: false, error: `statfs ${volumePath}: ${String(err?.message ?? err).slice(0, 160)}` });
    }
    const proposal = proposeVolumeGrowth(usage, {
      volumePath,
      volumeId: String(req.volumeId || process.env.INFRA_VOLUME_ID || '').trim() || null,
      instanceId: String(process.env.INFRA_INSTANCE_ID || '').trim() || null,
      host: target ?? boxLabel(),
    });
    // executed:true = the READ ran (same convention as env_probe); nothing was
    // mutated — desired.proposalOnly says so on the receipt. Growing a volume
    // is owner spend: the caller attaches this receipt to ONE owner question.
    return finish({ ...base, executed: true, desired: { ...proposal } });
  }

  const host = { ...(await dockerHostCapacity()), hostname: os.hostname() };

  // ── prune_build_cache (env-armed, NX 6 h per host; WI-Q) ──
  if (req.kind === 'prune_build_cache') {
    const args = pruneBuildCacheArgs();
    const command = `docker ${args.join(' ')}`;
    let before: { totalBytes: number; freeBytes: number; usedBytes: number } | null = null;
    try { before = await readMountUsage('/'); } catch { /* the reading is context, not a gate */ }
    const pct = (u: { usedBytes: number; freeBytes: number } | null) => (u && u.usedBytes + u.freeBytes > 0 ? Math.round((u.usedBytes / (u.usedBytes + u.freeBytes)) * 100) : null);
    const desired: Record<string, unknown> = {
      host: target, command, until: pruneUntil(), keepStorageGb: pruneKeepStorageGb(),
      scope: 'BuildKit build cache only — never volumes, containers, images in use, or the coding workspaces volume',
      ...(before ? { diskPctBefore: pct(before), diskFreeGbBefore: Math.round((before.freeBytes / 1e9) * 10) / 10 } : {}),
    };
    if (!armed) {
      // OBSERVE-ONLY DEFAULT (ASK #4): the receipt IS the deliverable. Nothing
      // ran, so the 6 h window is handed back — arming inside it must execute.
      await releaseCooldown(req.kind, target);
      return finish({ ...base, host, dryRun: true, desired });
    }
    try {
      const { stdout } = await docker(args, 10 * 60_000);
      const reclaimed = parseReclaimedSpace(stdout);
      let after: { totalBytes: number; freeBytes: number; usedBytes: number } | null = null;
      try { after = await readMountUsage('/'); } catch { /* best-effort */ }
      return finish({
        ...base, host, executed: true,
        desired: { ...desired, ...(reclaimed ? { reclaimed } : {}), ...(after ? { diskPctAfter: pct(after), diskFreeGbAfter: Math.round((after.freeBytes / 1e9) * 10) / 10 } : {}) },
      });
    } catch (err: any) {
      const text = String(err?.message ?? err);
      // The coding box's socket proxy filters by API section (CONTAINERS /
      // IMAGES / INFO — docker-compose.base.yml); `builder prune` is the BUILD
      // section, so a 403 here is the proxy, not the daemon.
      const proxyHint = /403|forbidden/i.test(`${text} ${String(err?.stderr ?? '')}`)
        ? ' — the docker socket proxy refused the BUILD section: add BUILD=1 to the docker-proxy service (docker-compose.base.yml) or run the prune on the box directly'
        : '';
      // Nothing was reclaimed: release the window so the retry after the fix
      // (BUILD=1 / CLI flag) is not refused as a loop for up to 6 h.
      await releaseCooldown(req.kind, target);
      return finish({ ...base, ok: false, host, desired, error: `${text.slice(0, 160)}${proxyHint}` });
    }
  }

  // ── env_probe (read-only — always executes) ──
  if (req.kind === 'env_probe') {
    const probe: Record<string, unknown> = { host };
    if (target) {
      let running = false;
      try {
        const { stdout } = await docker(['inspect', '-f', '{{.State.Running}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}', target], 15_000);
        const [run, mem, nano] = stdout.trim().split(/\s+/);
        running = run === 'true';
        probe.container = { running, memoryBytes: Number(mem) || 0, nanoCpus: Number(nano) || 0 };
      } catch (err: any) {
        probe.container = { running: false, error: String(err?.message ?? err).slice(0, 160) };
      }
      if (running) probe.cgroup = await probeCgroupMemory(target);
      // Session-daemon surfacing (ticket e72b88f9): the stray-daemon class must
      // be VISIBLE in the standing read-only probe, not only via the dedicated
      // reap kind — a lane diagnosing "wedged egress" env_probes FIRST, and the
      // candidate list (with cwd + owning session) is what tells it "that SOCKS
      // listener belongs to a FINISHED session's daemon", not the platform path.
      if (running) {
        const scan = await scanSessionDaemons(target);
        if (scan.ok) {
          const aged = scan.candidates.filter((c) => (c.etimes ?? 0) >= sessionDaemonMinAgeSec());
          if (scan.candidates.length) {
            probe.sessionDaemons = {
              count: scan.candidates.length,
              agedPastFloor: aged.length,
              minAgeSec: sessionDaemonMinAgeSec(),
              note: 'non-root processes launched from a session worktree cwd — the oldest of a FINISHED session are reappable via infra_action kind reap_orphans_session_daemons',
              candidates: scan.candidates.map((c) => ({ pid: c.pid, uid: c.uid, etimes: c.etimes, session: c.sessionId, cwd: c.cwd, args: c.args.slice(0, 120) })),
            };
          }
        } else {
          // review N4: a failed scan must be VISIBLE, not silent — the probe's
          // contract is "a reading, whatever it says", never a quiet gap.
          probe.sessionDaemons = { scanError: scan.error };
        }
      }
    }
    return finish({ ...base, host, probe, executed: true });
  }

  // ── dev_container_resize (grow-only, hard-capped) ──
  if (req.kind === 'dev_container_resize') {
    let currentMem = 0;
    let currentSwap: number | null = null;
    try {
      const { stdout } = await docker(['inspect', '-f', '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}', target!], 15_000);
      const parsed = parseMemoryInspect(stdout);
      currentMem = parsed.memory || 0;
      currentSwap = parsed.swap;
    } catch (err: any) {
      return finish({ ...base, ok: false, host, error: `inspect ${target}: ${String(err?.message ?? err).slice(0, 160)}` });
    }
    if (!currentMem) return finish({ ...base, ok: false, host, refused: `${target} is not running (or has no memory cgroup) — nothing to resize` });

    const explicitMem = !!(req.memoryBytes && req.memoryBytes > 0);
    let desiredMem = explicitMem
      ? Math.floor(req.memoryBytes!)
      : resolveDevMemoryCeiling(host.memTotalBytes);
    let cappedBy: string | undefined;
    if (host.memTotalBytes && desiredMem > host.memTotalBytes - HOST_MEM_RESERVE_BYTES) {
      desiredMem = host.memTotalBytes - HOST_MEM_RESERVE_BYTES;
      cappedBy = 'host-mem-reserve';
    }
    let desiredCpus = req.cpus && req.cpus > 0 ? req.cpus : 0;
    if (desiredCpus && host.ncpu && desiredCpus > host.ncpu - HOST_CPU_RESERVE) {
      desiredCpus = Math.max(1, host.ncpu - HOST_CPU_RESERVE);
      cappedBy = cappedBy ?? 'host-cpu-reserve';
    }
    // GROW-ONLY is a MEMORY-AXIS invariant (adversarial review B1): an EXPLICIT
    // shrink is refused outright, and a DERIVED target below current never
    // rides along on a cpus-only update — memory is simply left untouched.
    if (explicitMem && desiredMem < currentMem) {
      return finish({
        ...base, host, cappedBy,
        refused: `grow-only: explicit memory ${desiredMem} < current ${currentMem} bytes — shrinking a live container under its usage triggers the OOM killer`,
        probe: { currentMemoryBytes: currentMem },
      });
    }
    const memGrow = desiredMem > currentMem;
    if (!memGrow && !desiredCpus) {
      return finish({
        ...base, host, cappedBy,
        refused: `grow-only no-op: derived ${desiredMem} ≤ current ${currentMem} bytes and no cpus change requested`,
        probe: { currentMemoryBytes: currentMem },
      });
    }
    // Fail-closed on an unreadable host for ARMED mutations (review #3): the
    // hard caps cannot be enforced without the host totals. The dry-run
    // proposal still renders (it is only a proposal).
    if (armed && !host.memTotalBytes) {
      return finish({
        ...base, host, cappedBy,
        refused: 'host capacity unreadable (docker info) — refusing an ARMED mutation without cap enforcement (fail-closed)',
        probe: { currentMemoryBytes: currentMem },
      });
    }
    const cmd = ['update'];
    if (memGrow) cmd.push(...memoryGrowArgs(desiredMem, currentMem, currentSwap)); // keeps the swap allowance (a positive MemorySwap refuses --memory above it)
    if (desiredCpus) cmd.push('--cpus', String(desiredCpus));
    cmd.push(target!);
    const desired: Record<string, unknown> = {
      ...(memGrow
        ? { memoryBytes: desiredMem }
        : { memoryUntouched: `derived ${desiredMem} ≤ current ${currentMem} — grow-only, memory left as-is` }),
      ...(desiredCpus ? { cpus: desiredCpus } : {}),
      currentMemoryBytes: currentMem, command: `docker ${cmd.join(' ')}`,
    };
    if (!armed) {
      // OBSERVE-ONLY DEFAULT (ASK #4): the receipt IS the deliverable.
      return finish({ ...base, host, dryRun: true, desired, cappedBy });
    }
    try {
      await docker(cmd, 30_000);
      const { stdout } = await docker(['inspect', '-f', '{{.HostConfig.Memory}}', target!], 15_000);
      desired.appliedMemoryBytes = Number(stdout.trim()) || 0;
      return finish({ ...base, host, desired, cappedBy, executed: true });
    } catch (err: any) {
      return finish({ ...base, ok: false, host, desired, cappedBy, error: String(err?.message ?? err).slice(0, 160) });
    }
  }

  // ── reap_orphans (>30-min tsc/jest — the deploy-orphan signature) ──
  if (req.kind === 'reap_orphans') {
    // Same process signature + 30-min age floor as verify.service's pre-chain
    // reap (db25c401): only ANCIENT orphans die — a legitimate leg is bounded
    // well below 30 min by the chain timeout.
    const listCmd = 'ps -eo pid,etimes,args | grep -E "tsc --noEmit|node_modules/.bin/jest" | grep -v grep';
    let listing = '';
    try {
      const { stdout } = await docker(['exec', target!, 'sh', '-c', listCmd], 20_000);
      listing = stdout.trim();
    } catch (err: any) {
      return finish({ ...base, ok: false, host, error: `exec ps ${target}: ${String(err?.message ?? err).slice(0, 160)}` });
    }
    const ancient = listing.split('\n').filter((l) => {
      const cols = l.trim().split(/\s+/);
      return cols.length >= 3 && Number(cols[1]) > 1800;
    });
    const desired: Record<string, unknown> = {
      orphanLines: ancient.length, allMatchingLines: listing ? listing.split('\n').length : 0,
      victims: ancient.map((l) => l.trim().split(/\s+/).slice(0, 2).join(' ')),
    };
    if (!ancient.length) return finish({ ...base, host, desired, refused: 'no >30-min orphaned tsc/jest processes — nothing to reap' });
    if (!armed) return finish({ ...base, host, dryRun: true, desired });
    const reapCmd = 'for p in $(pgrep -f "tsc --noEmit|node_modules/.bin/jest" 2>/dev/null); do e=$(ps -o etimes= -p $p 2>/dev/null | tr -d " "); if [ -n "$e" ] && [ "$e" -gt 1800 ]; then kill -9 $p 2>/dev/null; fi; done; true';
    try {
      await docker(['exec', target!, 'sh', '-c', reapCmd], 30_000);
      return finish({ ...base, host, desired, executed: true });
    } catch (err: any) {
      return finish({ ...base, ok: false, host, desired, error: String(err?.message ?? err).slice(0, 160) });
    }
  }

  // ── reap_orphans_session_daemons (ticket e72b88f9, 2026-10-14) ──
  // The 33-day stray tailscaled on :1057: a FINISHED session's daemon in the
  // SHARED dev container. Criteria (all must hold to kill): cwd under a session
  // worktree (the "session-spawned" test — the harness starts nothing there;
  // both workspace layouts matched), non-root uid (the platform tailscaled is
  // root-owned by design), age ≥ the session-daemon floor (24 h default — above
  // any sane daemon-start jitter; the tsc/jest one-shots keep their own kind),
  // and the owning session has NO queued/running agent run (fail-closed on a
  // DB read error). The receipt always lists the candidates so the class is
  // VISIBLE even when unarmed or refused — the surfacing half of the ask.
  if (req.kind === 'reap_orphans_session_daemons') {
    if (sessionDaemonReapDisabled()) {
      return finish({ ...base, host, refused: 'INFRA_SESSION_DAEMON_REAP_DISABLED=1 — session-daemon reaping is switched off (env_probe still surfaces the candidates)' });
    }
    const scan = await scanSessionDaemons(target!);
    if (!scan.ok) return finish({ ...base, ok: false, host, error: scan.error });
    const { candidates } = scan;
    const minAgeSec = sessionDaemonMinAgeSec();
    const aged = candidates.filter((c) => (c.etimes ?? 0) >= minAgeSec);
    const { inFlight, unreadable } = await daemonSessionIdsWithInFlightRun(aged.map((c) => c.sessionId!).filter(Boolean));
    const victims = aged.filter((c) => c.sessionId && !inFlight.has(c.sessionId));
    const desired: Record<string, unknown> = {
      sessionDaemons: candidates.length,
      sessionDaemonVictims: victims.length,
      minAgeSec,
      ...(unreadable ? { livenessUnreadable: true } : {}),
      candidates: candidates.map((c) => ({ pid: c.pid, uid: c.uid, etimes: c.etimes, session: c.sessionId, cwd: c.cwd, args: c.args.slice(0, 160) })),
    };
    if (unreadable) {
      return finish({ ...base, host, desired, refused: `could not read run liveness for ${aged.length} session-daemon candidate(s) — fail-closed, nothing reaped (retry when the DB is readable)` });
    }
    if (!victims.length) {
      return finish({ ...base, host, desired, refused: candidates.length
        ? `no orphaned session daemons ≥ ${minAgeSec}s old (of ${candidates.length} session-spawned, ${aged.length} past the age floor, ${aged.length - victims.length} in live sessions) — nothing to reap`
        : 'no session-spawned daemon processes — nothing to reap' });
    }
    if (!armed) return finish({ ...base, host, dryRun: true, desired });
    // Kill AS THE OWNING UID (2026-10-14 E2E, ticket e72b88f9): the kill loop
    // re-verifies cwd via readlink — a root-default exec cannot read a
    // uid-1001 process's /proc/<pid>/cwd (no CAP_SYS_PTRACE in the container's
    // default cap set), so the case pattern would never match and the reap
    // would be blind. Same-uid execs can both readlink AND kill their own
    // processes with no capability; group the victims by uid, one exec each.
    const victimsByUid = new Map<string, string[]>();
    for (const v of victims) {
      if (!victimsByUid.has(v.uid)) victimsByUid.set(v.uid, []);
      victimsByUid.get(v.uid)!.push(v.pid);
    }
    try {
      for (const [uid, pids] of victimsByUid) {
        const reapCmd = sessionDaemonReapCommand(pids, minAgeSec, scan.workspaceRoot);
        try {
          await docker(['exec', '-u', uid, target!, 'sh', '-c', reapCmd], 30_000);
        } catch (err: any) {
          // review N2: name the failing uid group — an operator must see WHICH
          // exec died (earlier groups' kills may already have run).
          return finish({ ...base, ok: false, host, desired, error: `exec reap (uid ${uid}) ${target}: ${String(err?.message ?? err).slice(0, 140)}` });
        }
      }
      return finish({ ...base, host, desired, executed: true });
    } catch (err: any) {
      return finish({ ...base, ok: false, host, desired, error: String(err?.message ?? err).slice(0, 160) });
    }
  }

  if (req.kind === 'dev_container_restart') {
    // T4b (capability gap audit #28, 2026-09-24): the plain "recreate my dev
    // container" the UI offers (POST /coding/dev-container/restart), for a
    // wedged environment. Same env-armed class: dry-run receipt until
    // INFRA_ACTIONS_ENABLED=1; the service itself refuses while a run is in
    // flight (it returns the status with a note instead of restarting).
    const desired: Record<string, unknown> = { container: target, action: 'docker rm -f + ensureUserDevContainer' };
    if (!armed) return finish({ ...base, host, dryRun: true, desired });
    try {
      const { restartUserDevContainer } = await import('../coding/dev-container.service');
      const status = await restartUserDevContainer(req.userId!);
      const refusedNote = typeof (status as any)?.note === 'string' && /run is in progress/.test((status as any).note) ? (status as any).note : undefined;
      return finish({ ...base, host, desired: { ...desired, status }, ...(refusedNote ? { refused: refusedNote } : { executed: true }) });
    } catch (err: any) {
      return finish({ ...base, ok: false, host, desired, error: String(err?.message ?? err).slice(0, 160) });
    }
  }

  // ── worker_restart (PROPOSE-ONLY by default — self-restart paradox) ──
  {
    const restartArmed = armed && process.env.INFRA_WORKER_RESTART_ARMED === '1';
    const restartTarget = process.env.INFRA_WORKER_RESTART_TARGET || '';
    const refusedBase =
      'proposal-only by design: the worker lifecycle belongs to the deploy pipeline, and a restart fired from a process that may BE the worker is the self-restart paradox';
    if (!restartArmed) {
      return finish({
        ...base, host, refused: `${refusedBase} — arm INFRA_ACTIONS_ENABLED=1 AND INFRA_WORKER_RESTART_ARMED=1 and set INFRA_WORKER_RESTART_TARGET to execute`,
        desired: { target: restartTarget || null },
      });
    }
    if (!restartTarget) {
      return finish({ ...base, ok: false, host, refused: 'INFRA_WORKER_RESTART_TARGET is not set — refusing to guess a container to restart' });
    }
    if (restartTarget === os.hostname()) {
      return finish({ ...base, ok: false, host, target: restartTarget, refused: 'target is THIS process\'s own container — self-restart paradox, refusing' });
    }
    // Review #2 hardening: ops will set the container NAME, but the paradox
    // guard must hold against the container ID too — resolve the target and
    // prefix-compare with os.hostname() (the 12-char short id). Fail-CLOSED
    // when the target cannot be inspected at all.
    try {
      const { stdout } = await docker(['inspect', '-f', '{{.Id}}', restartTarget], 15_000);
      const id = stdout.trim();
      if (id && os.hostname() && id.startsWith(os.hostname())) {
        return finish({ ...base, ok: false, host, target: restartTarget, refused: `target resolves to THIS process's own container id ${id.slice(0, 12)} — self-restart paradox, refusing` });
      }
    } catch (err: any) {
      return finish({ ...base, ok: false, host, target: restartTarget, refused: `cannot verify the restart target is not-self (inspect failed: ${String(err?.message ?? err).slice(0, 120)}) — fail-closed` });
    }
    try {
      await docker(['restart', restartTarget], 60_000);
      return finish({ ...base, host, target: restartTarget, executed: true, desired: { command: `docker restart ${restartTarget}` } });
    } catch (err: any) {
      return finish({ ...base, ok: false, host, target: restartTarget, error: String(err?.message ?? err).slice(0, 160) });
    }
  }
}

// ── Watchdog trigger (ASK #2): VERIFY_ENV_RED streak ⇒ probe then act ─────────

export interface EnvRedStreakSummary {
  tripped: boolean;
  reds: number;
  sessions: number;
  windowMs: number;
  users: string[];
  receipts: Array<{ userId: string; kind: InfraActionKind; executed: boolean; dryRun: boolean; refused?: string; cooldown?: boolean }>;
  note?: string;
}

const ENV_RED_WINDOW_MS = () => Number(process.env.INFRA_ENV_RED_WINDOW_MS || 30 * 60_000);
const ENV_RED_MIN_REDS = () => Number(process.env.INFRA_ENV_RED_MIN_REDS || 3);
const ENV_RED_MIN_SESSIONS = () => Number(process.env.INFRA_ENV_RED_MIN_SESSIONS || 2);
const ENV_RED_MAX_USERS = 5;

// ── T2e starve notice (todo a04cda91, ticket 7ec6200b, 2026-10-17) ───────────
// The ticket's "post a supervisor notice after N starved stages per hour": a
// ONE-HOUR window over the starve-family telemetry kinds, a threshold, ONE
// notice per hour (Redis NX dedupe) into the Fleet Supervisor chat. This is
// the NOTICE arm — the ACTION arm is sweepEnvRedInfraStreak above (env_probe +
// dev_container_resize); they are deliberately separate because the notice is
// always-on (a diagnosis costs nothing) while the actions stay observe-only
// until INFRA_ACTIONS_ENABLED. Kill switch: INFRA_SWEEP_DISABLED (the family).
const STARVE_NOTICE_WINDOW_MS = 60 * 60_000;
const STARVE_NOTICE_KINDS = () => {
  const extra = String(process.env.VERIFY_STARVE_NOTICE_KINDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([LOOP_METRIC_KINDS.VERIFY_ENV_RED, LOOP_METRIC_KINDS.VERIFY_PRESSURE_DEFERRED, ...extra])];
};
const STARVE_NOTICE_MIN = () => Number(process.env.VERIFY_STARVE_NOTICE_MIN || 5);

export interface StarveNoticeSummary {
  tripped: boolean;
  starved: number;
  windowMs: number;
  min: number;
  sessions: number;
  noticePosted: boolean;
}

/** Count starve-family rows in the last hour and post ONE supervisor notice
 *  when they cross VERIFY_STARVE_NOTICE_MIN (default 5). Best-effort: never
 *  throws into the cron loop; a Redis dedupe miss fail-opens to posting. */
export async function sweepVerifyStarveNotice(opts?: { now?: Date }): Promise<StarveNoticeSummary> {
  const now = opts?.now ?? new Date();
  const summary: StarveNoticeSummary = { tripped: false, starved: 0, windowMs: STARVE_NOTICE_WINDOW_MS, min: STARVE_NOTICE_MIN(), sessions: 0, noticePosted: false };
  if (process.env.INFRA_SWEEP_DISABLED === '1') return summary;
  const since = new Date(now.getTime() - summary.windowMs);
  let rows: Array<{ sessionId: string | null }> = [];
  try {
    rows = (await (prisma as any).loopMetric.findMany({
      where: { kind: { in: STARVE_NOTICE_KINDS() }, createdAt: { gte: since } },
      select: { sessionId: true },
      take: 500,
    })) as Array<{ sessionId: string | null }>;
  } catch {
    return summary; // a read failure never posts a bogus notice
  }
  summary.starved = rows.length;
  summary.sessions = new Set(rows.map((r) => r.sessionId).filter(Boolean)).size;
  if (summary.starved < summary.min) return summary;
  // ONE notice per hour (NX). A Redis hiccup fails OPEN — the notice is cheap,
  // and a duplicate diagnosis beats a silent starvation herd (the ticket's
  // original failure: 4 of 4 sessions starved with no supervisor signal).
  const key = 'infra-action:verify-starve-notice';
  const nx = await (redisClient as any).set(key, now.toISOString(), { NX: true, EX: Math.max(60, Math.floor(summary.windowMs / 1000)) }).catch(() => 'OK');
  const deduped = nx !== 'OK';
  summary.tripped = true;
  if (deduped) return summary;
  const sup = await prisma.crossModelChat.findFirst({ where: { isSupervisor: true, archivedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } }).catch(() => null);
  if (!sup) return summary;
  const content = `[VERIFY STARVE WATCH — ticket 7ec6200b] ${summary.starved} starved verify stages in the last hour across ${summary.sessions} session(s) (verify_env_red + verify_pressure_deferred rows ≥ ${summary.min}/h). The dev container is starving lanes' verify chains — the ACTION arm (env_probe + dev_container_resize dry-run receipts) fires separately on the 30-min OOM signature. Check container working set vs the 85% defer bar, reap orphaned jest/tsc (infra_action reap_orphans), and consider whether the capacity cluster (dev_container_resize, gated on INFRA_ACTIONS_ENABLED) should be armed. One notice per hour (deduped).`;
  await prisma.crossModelMessage.create({ data: { chatId: sup.id, role: 'assistant', content, metadata: { origin: 'infra-actions.service', kind: 'verify-starve-notice', starved: summary.starved, sessions: summary.sessions } } }).catch(() => {});
  logger.warn(`infra-actions: verify starve notice posted — ${summary.starved} starved stages across ${summary.sessions} session(s) in the last hour (ticket 7ec6200b)`);
  summary.noticePosted = true;
  return summary;
}

/**
 * The fleet-wide OOM signature (ASK #2): ≥ INFRA_ENV_RED_MIN_REDS verify_env_red
 * metrics across ≥ INFRA_ENV_RED_MIN_SESSIONS distinct sessions in the last
 * INFRA_ENV_RED_WINDOW_MS ⇒ for each implicated session owner, env_probe (real,
 * read-only) then dev_container_resize (dry-run unless armed). One fleet-wide
 * sweep dedupe rides the same NX discipline as the actions themselves, so a
 * sustained incident produces ONE volley per cooldown window — the receipts,
 * not a fifteenth re-diagnosis.
 */
export async function sweepEnvRedInfraStreak(opts?: { now?: Date }): Promise<EnvRedStreakSummary> {
  const now = opts?.now ?? new Date();
  const summary: EnvRedStreakSummary = {
    tripped: false, reds: 0, sessions: 0, windowMs: ENV_RED_WINDOW_MS(), users: [], receipts: [],
  };

  const since = new Date(now.getTime() - summary.windowMs);
  const rows = await (prisma as any).loopMetric.findMany({
    where: { kind: LOOP_METRIC_KINDS.VERIFY_ENV_RED, createdAt: { gte: since } },
    select: { sessionId: true },
    take: 500,
  }).catch(() => [] as Array<{ sessionId: string | null }>);
  const sessionIds = [...new Set((rows as Array<{ sessionId: string | null }>).map((r) => r.sessionId).filter(Boolean))] as string[];
  summary.reds = (rows as any[]).length;
  summary.sessions = sessionIds.length;
  if (summary.reds < ENV_RED_MIN_REDS() || summary.sessions < ENV_RED_MIN_SESSIONS()) return summary;

  // Sweep-level NX dedupe (fail-open like the watchdog's notice dedupe — the
  // per-action cooldowns still bound the volley if Redis hiccups).
  const sweepKey = 'infra-action:env-red-sweep';
  const nx = await (redisClient as any).set(sweepKey, now.toISOString(), { NX: true, EX: Math.max(60, Math.floor(summary.windowMs / 1000)) }).catch(() => 'OK');
  if (nx !== 'OK') return { ...summary, note: 'sweep dedupe: a volley already fired inside this window' };

  summary.tripped = true;
  const chats = await prisma.crossModelChat.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, userId: true },
  }).catch(() => [] as Array<{ id: string; userId: string }>);
  const userIds = [...new Set(chats.map((c) => c.userId))].slice(0, ENV_RED_MAX_USERS);
  summary.users = userIds;

  const reason = `verify_env_red streak: ${summary.reds} environmental verify reds across ${summary.sessions} sessions in ${Math.round(summary.windowMs / 60000)}m (ticket c12239c1)`;
  for (const userId of userIds) {
    try {
      const probe = await runInfraAction({ kind: 'env_probe', userId, reason });
      summary.receipts.push({ userId, kind: 'env_probe', executed: probe.executed, dryRun: probe.dryRun, refused: probe.refused, cooldown: probe.cooldown });
      const resize = await runInfraAction({ kind: 'dev_container_resize', userId, reason });
      summary.receipts.push({ userId, kind: 'dev_container_resize', executed: resize.executed, dryRun: resize.dryRun, refused: resize.refused, cooldown: resize.cooldown });
    } catch (err: any) {
      logger.warn(`infra-actions: env-red streak action failed for ${userId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
    }
  }
  logger.warn(`infra-actions: VERIFY_ENV_RED streak tripped — ${summary.reds} reds / ${summary.sessions} sessions in ${Math.round(summary.windowMs / 60000)}m ⇒ probe+resize volley for ${userIds.length} user(s) (armed=${infraActionsArmed()})`);
  recordLoopMetric({
    kind: LOOP_METRIC_KINDS.INFRA_ACTION,
    meta: { action: 'env_red_streak_sweep', reds: summary.reds, sessions: summary.sessions, users: userIds.length, armed: infraActionsArmed() },
  });
  return summary;
}

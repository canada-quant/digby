/**
 * SHARED TAILNET DEV CONTAINER (owner decision 2026-08-22, ticket 3ba5d35d;
 * hardened 2026-08-23 after adversarial review of PR #326).
 *
 * One long-lived dev container PER USER (`digby-dev-<userId12>`) that joins the
 * user's tailnet, replacing per-session containers for that user's coding
 * sessions — so sessions ssh/stream to tailnet infrastructure directly instead
 * of paying SSM send-command round-trips. Per-session containers remain the
 * automatic FALLBACK whenever this container can't come up or can't join the
 * tailnet — enabling the feature can degrade, never break, a session.
 *
 * ADMIN-ONLY (v1): the container mounts the whole workspace volume (there is
 * no per-user subtree in the volume layout yet), so enabling it for arbitrary
 * users would re-open the cross-tenant exposure the scoped-mounts fix closed
 * (container.service scopedMountArgs, security finding #5). The per-user
 * volume layout is NOT built and has no open ticket: 4ed6eb2e (cited here
 * before audit 2026-10-06) delivered the per-session EGRESS scoping below and
 * closed as a tailnet-ACL item — it never changed the mount. So ensure()
 * honors the preference only for ADMIN accounts — the owner working on Digby
 * itself, per the design brief — and even the admin's sessions can still SEE
 * every other user's worktree and every project's mirror through this mount
 * (audit 2026-10-06 stanne.md #1: an independent-reviewer worker listed 144
 * session dirs and read another user's worktree). Mitigation, not a fix: the
 * run_command workspace-scope guard (workspace-path-guard.ts, keyed on
 * container.service workspaceExecExposure 'dev_container') refuses commands
 * that name another session's worktree / another project's mirror (kill
 * switch RUN_COMMAND_WORKSPACE_GUARD_DISABLED=1). The real fix is a per-user
 * volume subtree mounted here instead of the whole volume.
 * build 2026-10-08 ISO: that fix now exists behind CODING_WORKSPACE_PER_USER_SUBTREE
 * — when the switch applies to the user AND every live (non-archived) worktree
 * of theirs sits in their `<userKey>/` subtree (workspace-placement
 * userContainmentCensus), the container is created with ONLY that subtree
 * mounted (+ the mirrors of shared projects it uses, one by one); otherwise
 * the whole-volume mount below stays (byte-identical args). A session the
 * container cannot reach falls back to its scoped per-session container
 * (container.service devContainerCovers); a running container converges to the
 * desired mounts only in the quiet sweep (convergeDevContainerMounts — never
 * mid-run), or on the Settings restart.
 * Session commands in the shared container still run as uid 1001 (the
 * same uid as per-session containers), never root: git ownership stays aligned
 * with the backend's uid (no "dubious ownership"/EACCES regressions) and
 * sessions cannot read the root-owned tailnet secrets.
 *
 * Networking: tailscaled runs in USERSPACE mode (--tun=userspace-networking) —
 * no TUN device, no extra capabilities, so it works through the filtered
 * docker-socket-proxy. Outbound tailnet access goes via the SOCKS5 proxy on
 * localhost:1055. Deliberately NOT exported as ALL_PROXY: a global proxy would
 * break every curl/git the moment tailscaled degrades. Shells get
 * DIGBY_TAILNET_PROXY instead and opt in per command (documented in the
 * Settings UI).
 *
 * Auth key: stored as a coding credential (provider 'tailscale', envKey
 * TS_AUTHKEY — AES-256-GCM, write-only) but EXCLUDED from session-shell env
 * (credentials.service INFRA_ONLY_PROVIDERS). Delivery is synchronized: the
 * boot script poll-waits for /run/secrets/ts_authkey (root-owned, 0600 — uid
 * 1001 session shells can't read it), the backend writes it via stdin exec
 * right after create, the script consumes + deletes it, and the backend then
 * VERIFIES the join (tailscale status → Running) before reporting the
 * container usable; a failed join tears the container down and falls back.
 *
 * State: tailscale state persists under the workspace volume
 * (devcontainers/<uid12>/ts-state via volume-subpath; the directory is
 * PRE-CREATED backend-side because docker requires subpaths to exist) so the
 * node identity survives recreation — re-joining after a redeploy/reap does
 * not consume a new machine entry. The boot script chowns it root:root 0700
 * so uid-1001 session shells can't read the node key.
 *
 * Concurrency: creation is guarded by a Redis lock (SET NX) and a docker
 * name-conflict is treated as "another creator won" — never rm -f'd.
 *
 * PER-SESSION EGRESS SCOPING (ticket 4ed6eb2e, design doc Part 3(b)): when
 * CODING_EGRESS_SECRET is set, tailscaled's SOCKS5 moves to the undocumented
 * upstream 127.0.0.1:1057 and a Digby shim takes the canonical :1055 — RFC1929
 * per-session credentials (HMAC-derived from the pepper, deterministic across
 * backend+worker processes) + an allowlist per session (session override ??
 * per-user default ?? allow-all). ADVISORY by design: a process that hunts
 * the upstream port bypasses the shim (one netns/uid; tailscaled listeners
 * are TCP-only — verified vs tailscale v1.102.3 cmd/tailscaled/proxy.go).
 * Pepper ABSENT → the v1 layout renders verbatim and status reports legacy.
 */

import { execFile } from 'child_process';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import redisClient from '../../../config/redis';
import { isDockerAvailable, SANDBOX_HOMES_ROOT, containerMountDestinations } from './container.service';
import { CODING_WORKSPACE_ROOT } from './workspace.service';
import {
  perUserSubtreeAppliesTo, perUserSubtreeSetting, listSubtreeKeysSync, ensureUserSubtreeSync,
  subtreeRoot, subtreeSandboxHomesRoot, volumeSubpathOf,
} from './workspace-layout';
import { userContainmentCensus, recordIsolationMetric } from './workspace-placement';
import { getCredentialValueDecrypted } from './credentials.service';
import {
  egressSecret, egressUsername, egressPassword, passwordHash,
  validatePolicyInput, policyToStrings,
} from './egress-policy';

const DEV_LABEL = 'digby.dev.container';
const DEV_IMAGE = () => process.env.CODING_DEV_IMAGE || process.env.CODING_RUNNER_IMAGE || 'node:20';
const VOLUME_NAME = () => process.env.CODING_WORKSPACE_VOLUME || 'crossmodel_coding_workspaces';
// Memory ceiling for the shared dev container (ticket db25c401): 4 GiB was
// repeatedly exhausted by co-tenant sessions' verify chains (tsc/jest each
// peak 1.5–2.5 GiB; the cgroup OOM-killer SIGKILLed them → exit 137, empty
// output, masquerading as typecheck failures). Main raised the ceiling to 12g
// (c03ab2724); this makes it env-tunable and live-grows legacy containers.
const DEV_MEMORY = () => process.env.CODING_DEV_CONTAINER_MEMORY || '12g';

/** Parse a docker memory string ('12g', '512m', '4294967296') to bytes; 0 on garbage. */
export function parseMemoryBytes(v: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?\s*$/i.exec(v);
  if (!m) return 0;
  const mult: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return Math.floor(Number(m[1]) * (mult[m[2].toLowerCase()] ?? 1));
}

/** Owner floor (ticket c12239c1 ASK #3): the ceiling never derives BELOW the
 *  12g the human set at 03:30Z on 2026-09-10 to flatline oom_kill at 219. */
const DEV_MEMORY_FLOOR_BYTES = 12 * 1024 ** 3;
/** Hard reserve (ticket c12239c1 ASK #1): a container never gets the host's
 *  last 4 GiB — the host's own daemons (worker, redis, dockerd) live there. */
export const HOST_MEM_RESERVE_BYTES = 4 * 1024 ** 3;

/**
 * Host-derived memory ceiling (ticket c12239c1 ASK #3 — "derive the memory cap
 * from the host (min 12g)"): the configured value (CODING_DEV_CONTAINER_MEMORY,
 * default 12g), floored at 12g, then capped at host−4 GiB when the host total
 * is known. A tiny host lands below the floor via the cap (safety wins); a big
 * host never strands capacity the cgroup could lend the verify herd.
 */
export function resolveDevMemoryCeiling(hostTotalBytes?: number | null): number {
  const explicit = String(process.env.CODING_DEV_CONTAINER_MEMORY ?? '').trim() !== '';
  const configured = parseMemoryBytes(DEV_MEMORY()) || DEV_MEMORY_FLOOR_BYTES;
  let desired = Math.max(configured, DEV_MEMORY_FLOOR_BYTES);
  if (hostTotalBytes && hostTotalBytes > 0) {
    // 2026-09-29 (box C verify pressure): with NO explicit CODING_DEV_CONTAINER_MEMORY
    // the ceiling is HOST-DERIVED — host total minus DEV_HOST_RESERVE_BYTES (8 GiB for
    // the workers, drain workers, session containers and dockerd), never below the
    // 12g floor. The 12g default stranded ~15 GB on the 32 GB coding box while the
    // shared container logged 288 OOM kills and ~100 verify deferrals/week.
    // An explicit env value keeps the old configured → floor → cap rule exactly.
    if (!explicit) {
      desired = Math.max(desired, hostTotalBytes - DEV_HOST_RESERVE_BYTES);
    }
    const cap = hostTotalBytes - HOST_MEM_RESERVE_BYTES;
    if (cap > 0) desired = Math.min(desired, cap);
  }
  return desired;
}

/** Host headroom kept OUTSIDE a host-derived dev-container ceiling (workers, drains, session containers, dockerd). */
export const DEV_HOST_RESERVE_BYTES = 8 * 1024 ** 3;

/**
 * `docker update` memory args for a GROW (2026-09-29): a container whose
 * HostConfig.MemorySwap is a positive byte count REFUSES `--memory` above it
 * ("Memory limit should be smaller than already set memoryswap limit"), so the
 * grow passes `--memory-swap` too, preserving the container's swap allowance
 * (swap − memory, floored at 0). MemorySwap 0 (unset) or -1 (unlimited) needs no
 * second flag. Pure; exported for the pins.
 */
export function memoryGrowArgs(desiredBytes: number, currentMemBytes: number, currentSwapBytes?: number | null): string[] {
  const args = ['--memory', String(desiredBytes)];
  if (currentSwapBytes && currentSwapBytes > 0) {
    const allowance = Math.max(0, currentSwapBytes - Math.max(0, currentMemBytes));
    args.push('--memory-swap', String(desiredBytes + allowance));
  }
  return args;
}

/** Parse `inspect -f '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}'` (the second field optional). */
export function parseMemoryInspect(stdout: string): { memory: number; swap: number | null } {
  const [m, sw] = String(stdout || '').trim().split(/\s+/);
  const memory = Number(m);
  const swapN = sw === undefined ? NaN : Number(sw);
  return { memory: Number.isFinite(memory) ? memory : NaN, swap: Number.isFinite(swapN) ? swapN : null };
}

/**
 * Host totals via `docker info` (INFO=1 — the one probe the socket-proxy
 * filter allows; SYSTEM/VOLUMES are blocked). Nulls when the daemon is
 * unreachable or the format surprises us — callers fall back to the
 * configured ceiling (never to a guess).
 */
export async function dockerHostCapacity(): Promise<{ memTotalBytes: number | null; ncpu: number | null }> {
  try {
    const { stdout } = await docker(['info', '--format', '{{.MemTotal}} {{.NCPU}}'], 15_000);
    const [mem, cpu] = stdout.trim().split(/\s+/).map(Number);
    return {
      memTotalBytes: Number.isFinite(mem) && mem > 0 ? mem : null,
      ncpu: Number.isFinite(cpu) && cpu > 0 ? cpu : null,
    };
  } catch {
    return { memTotalBytes: null, ncpu: null };
  }
}

/**
 * Grow a RUNNING dev container's memory cgroup in place (ticket db25c401):
 * containers created with an older ceiling keep it until recreated, so
 * raising the create-time default alone would leave every existing container
 * OOM-killing verify chains for days. `docker update --memory` applies live.
 * GROW-ONLY — shrinking a live container under its current usage triggers the
 * OOM killer. Best-effort: a failed update must never break ensure().
 * Host-derived target (ticket c12239c1 ASK #3): floored at 12g, capped at
 * host−4 GiB — pass hostTotalBytes when the caller already read it (the
 * convergence sweep), else it's read here best-effort.
 */
async function ensureDevMemoryCeiling(name: string, hostTotalBytes?: number | null): Promise<void> {
  try {
    const host = hostTotalBytes !== undefined ? hostTotalBytes : (await dockerHostCapacity()).memTotalBytes;
    const desired = resolveDevMemoryCeiling(host);
    if (!desired) return;
    const { memory: cur, swap } = parseMemoryInspect((await docker(['inspect', '-f', '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}', name], 15_000)).stdout);
    if (cur > 0 && desired > cur) {
      await docker(['update', ...memoryGrowArgs(desired, cur, swap), name], 30_000);
      logger.info(`dev-container: grew ${name} memory ceiling ${cur} → ${desired} bytes (ticket db25c401)`);
    }
  } catch (err: any) {
    logger.warn(`dev-container: memory-ceiling update failed for ${name} (non-fatal): ${String(err?.message).slice(0, 120)}`);
  }
}

/**
 * Converge EVERY running dev container to the host-derived ceiling (ticket
 * c12239c1 ASK #3 — "make the running container converge to the configured cap
 * at worker start, so a config change is not a no-op for the live container").
 * Rides the container-reaper cadence on the coding box (worker.ts); each pass
 * reads the host ONCE and live-grows every running digby-dev-* container
 * (ensureDevMemoryCeiling stays grow-only + best-effort per container).
 */
export async function convergeDevContainerCeilings(): Promise<void> {
  try {
    if (!(await isDockerAvailable())) return;
    const { stdout } = await docker(['ps', '--filter', `label=${DEV_LABEL}`, '--filter', 'status=running', '--format', '{{.Names}}'], 15_000);
    const names = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    const { memTotalBytes } = await dockerHostCapacity();
    for (const name of names) await ensureDevMemoryCeiling(name, memTotalBytes);
  } catch (err: any) {
    logger.warn(`dev-container: ceiling convergence failed (non-fatal): ${String(err?.message).slice(0, 120)}`);
  }
}
const TS_STATE_DIR = '/var/lib/digby-tailscale';
// tailscaled's compiled-in default CLI socket — this service never passes
// --socket, so the CLI and the daemon always meet here (ticket db587fc1).
const TS_SOCKET_PATH = '/var/run/tailscale/tailscaled.sock';
// Env-tunable so tests can use tiny windows (and ops can stretch slow tailnets).
const JOIN_VERIFY_TIMEOUT_MS = () => Number(process.env.DEV_JOIN_VERIFY_TIMEOUT_MS || 60_000);
const JOIN_VERIFY_POLL_MS = () => Number(process.env.DEV_JOIN_VERIFY_POLL_MS || 3_000);

export function devContainerName(userId: string): string {
  return `digby-dev-${userId.slice(0, 12)}`;
}

/**
 * ff262da5 (todo 4ecfd309, 2026-10-16): admission-control probe for RUNS.
 * Reads a dev container's memory working set (memory.current −
 * memory.stat:inactive_file — the same kubelet-eviction metric verify's
 * pressure arm uses; the RAW current counts reclaimable page cache and reads
 * ~60 points high) and compares it to the admission threshold (default 85%,
 * env RUN_ADMISSION_PCT; RUN_ADMISSION_DISABLED=1 kills the check).
 * Returns { admit: true } on any read failure — fail-open by doctrine: a
 * wedged docker socket must never wedge the run queue (the bounded escape
 * below covers a PERSISTENTLY starved container, not a probe error).
 */
export async function devContainerMemoryAdmission(
  userId: string,
): Promise<{ admit: boolean; workingSetPct: number | null; rawPct: number | null; reason?: string }> {
  try {
    if (process.env.RUN_ADMISSION_DISABLED === '1') return { admit: true, workingSetPct: null, rawPct: null };
    const name = devContainerName(userId);
    const { stdout } = await docker([
      'exec', name, 'sh', '-c',
      'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max 2>/dev/null; awk \'/^inactive_file /{print $2}\' /sys/fs/cgroup/memory.stat 2>/dev/null',
    ], 15_000);
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    // Order per the command: current, max, inactive_file (absent stat → 0).
    if (lines.length < 2) return { admit: true, workingSetPct: null, rawPct: null };
    const current = Number(lines[0]);
    const maxRaw = lines[1];
    const max = maxRaw === 'max' ? null : Number(maxRaw);
    const inactive = lines.length > 2 ? Number(lines[2]) : 0;
    if (!Number.isFinite(current) || current <= 0 || max == null || !Number.isFinite(max) || max <= 0) {
      return { admit: true, workingSetPct: null, rawPct: null };
    }
    const inactiveFile = Number.isFinite(inactive) && inactive > 0 ? Math.min(inactive, current) : 0;
    const workingSet = current - inactiveFile;
    const workingSetPct = (workingSet / max) * 100;
    const rawPct = (current / max) * 100;
    const thresholdPct = Number(process.env.RUN_ADMISSION_PCT) || 85;
    if (workingSetPct >= thresholdPct) {
      return {
        admit: false, workingSetPct, rawPct,
        reason: `run admission deferred: shared dev container ${name} memory working set at ${workingSetPct.toFixed(1)}% (raw ${rawPct.toFixed(1)}% incl. reclaimable page cache) ≥ ${thresholdPct}% admission threshold (ticket ff262da5 — environment, not a run fault)`,
      };
    }
    return { admit: true, workingSetPct, rawPct };
  } catch {
    return { admit: true, workingSetPct: null, rawPct: null }; // fail-open
  }
}

function docker(args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * Tri-state preference read: true / false / null (= UNKNOWN, e.g. a DB blip).
 * Callers that DESTROY things (the reaper) must treat null as "skip", never
 * as "disabled" — a transient Prisma error must not wipe every enabled
 * user's container (adversarial-review finding F6).
 */
export async function devContainerEnabledTriState(userId: string): Promise<boolean | null> {
  if (!userId || userId === 'anonymous') return false;
  try {
    const [prefs, user] = await Promise.all([
      prisma.userPreferences.findUnique({ where: { userId }, select: { devContainerEnabled: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { role: true } }),
    ]);
    if (prefs?.devContainerEnabled !== true) return false;
    // Admin-only v1 gate (see header). Non-admins keep the pref stored but it
    // is not honored until a per-user volume layout exists (NOT built — ticket
    // 4ed6eb2e was the egress-scoping item; audit 2026-10-06 T7-7).
    return user?.role === 'ADMIN';
  } catch {
    return null;
  }
}

/** Boolean convenience for non-destructive callers (unknown → false = fall back). */
export async function devContainerEnabled(userId: string): Promise<boolean> {
  return (await devContainerEnabledTriState(userId)) === true;
}

// ── Per-session egress scoping (ticket 4ed6eb2e) ────────────────────────────
const EGRESS_DIR = '/run/digby-egress';               // container-local, root-only (policy + creds)
const EGRESS_LIB = '/usr/local/lib/digby-egress';     // shim + socks-connect helper (world-readable, no secrets)
const EGRESS_MARKER = `${EGRESS_DIR}/scoped`;         // written only after a verified shim start
const SHIM_PORT = 1055;                                // the canonical, documented proxy port
const UPSTREAM_PORT = 1057;                            // tailscaled's undocumented upstream (scoped mode)

/**
 * Session user (2026-10-13). Session execs run as uid 1001 with HOME=/tmp, but
 * stock node:20 has no passwd row for 1001, so OpenSSH (getpwuid) exits with
 * "No user exists for uid 1001" before it connects: tssh and `tailscale ssh`
 * could never reach a tailnet host from a session. Root, idempotent: the rows
 * are added only when missing; pw_dir=/tmp so ssh's ~/.ssh is the session's
 * existing /tmp/.ssh (known_hosts, keys). Runs in the boot script (new and
 * restarted containers) and once per process on a running container
 * (ensureSessionUser), so a live container is fixed without a restart.
 */
export const SESSION_USER_SCRIPT = [
  "getent passwd 1001 >/dev/null 2>&1 || { N=digby; grep -q '^digby:' /etc/passwd && N=digby1001; echo \"$N:x:1001:1001:Digby session:/tmp:/bin/bash\" >> /etc/passwd; } || true",
  "getent group 1001 >/dev/null 2>&1 || { G=digby; grep -q '^digby:' /etc/group && G=digby1001; echo \"$G:x:1001:\" >> /etc/group; } || true",
].join('\n');

const sessionUserEnsured = new Set<string>();

/** Add the uid-1001 passwd/group rows to a running container once per process. Never throws. */
async function ensureSessionUser(name: string): Promise<void> {
  if (sessionUserEnsured.has(name)) return;
  try {
    await docker(['exec', name, 'sh', '-c', SESSION_USER_SCRIPT], 15_000);
    sessionUserEnsured.add(name);
  } catch { /* best effort — retried on the next ensure */ }
}

/** Shell printf lines writing the tssh/tcurl helpers for a posture. ONE source
 *  of truth — the boot script (create) and post-create rewrites both use it.
 *  'scoped': helpers go through the shim (auth'd, fail closed without creds).
 *  'direct': shim-down degradation — helpers bypass the shim to the upstream
 *  so tailnet access still works UNSCOPED (status reports degraded). */
function helperLines(mode: 'legacy' | 'scoped' | 'direct'): string[] {
  if (mode === 'scoped') {
    return [
      // netcat-openbsd can't do RFC1929 auth — the node helper speaks it.
      `printf '%s\\n' '#!/bin/sh' 'exec ssh -o ProxyCommand='\\''node ${EGRESS_LIB}/socks-connect.js %h %p'\\'' "$@"' > /usr/local/bin/tssh 2>/dev/null || true`,
      `printf '%s\\n' '#!/bin/sh' 'exec curl --proxy "$DIGBY_TAILNET_PROXY" "$@"' > /usr/local/bin/tcurl 2>/dev/null || true`,
      'chmod 755 /usr/local/bin/tssh /usr/local/bin/tcurl 2>/dev/null || true',
    ];
  }
  if (mode === 'direct') {
    return [
      `printf '%s\\n' '#!/bin/sh' 'exec ssh -o ProxyCommand='\\''nc -x 127.0.0.1:${UPSTREAM_PORT} %h %p'\\'' "$@"' > /usr/local/bin/tssh 2>/dev/null || true`,
      `printf '%s\\n' '#!/bin/sh' 'exec curl --proxy socks5h://127.0.0.1:${UPSTREAM_PORT} "$@"' > /usr/local/bin/tcurl 2>/dev/null || true`,
      'chmod 755 /usr/local/bin/tssh /usr/local/bin/tcurl 2>/dev/null || true',
    ];
  }
  return [
    "printf '%s\\n' '#!/bin/sh' 'exec ssh -o ProxyCommand='\\''nc -x localhost:1055 %h %p'\\'' \"$@\"' > /usr/local/bin/tssh 2>/dev/null || true",
    "printf '%s\\n' '#!/bin/sh' 'exec curl --proxy socks5h://localhost:1055 \"$@\"' > /usr/local/bin/tcurl 2>/dev/null || true",
    'chmod 755 /usr/local/bin/tssh /usr/local/bin/tcurl 2>/dev/null || true',
  ];
}

/** /etc/profile.d line(s) per posture. SCOPED writes only a comment: the
 *  per-session credentialed value is injected by the backend per exec, and a
 *  container-wide export would (a) lack creds (shim rejects → confusing
 *  failures) and (b) clobber the injected value (profile.d runs after docker
 *  exec -e). DIRECT exports the upstream so shells keep working unscoped. */
function profileLines(mode: 'legacy' | 'scoped' | 'direct'): string[] {
  if (mode === 'scoped') {
    return [
      `printf '%s\\n' '# digby-tailnet: per-session egress scoping active (ticket 4ed6eb2e).' '# DIGBY_TAILNET_PROXY is injected per session by the backend with per-session' '# credentials — intentionally NOT set container-wide (fail closed).' > /etc/profile.d/digby-tailnet.sh 2>/dev/null || true`,
    ];
  }
  if (mode === 'direct') {
    return [
      `printf '%s\\n' '# digby-tailnet: egress shim DOWN — direct upstream fallback (UNSCOPED, see status).' 'export DIGBY_TAILNET_PROXY=socks5h://127.0.0.1:${UPSTREAM_PORT}' > /etc/profile.d/digby-tailnet.sh 2>/dev/null || true`,
    ];
  }
  return [
    'echo "export DIGBY_TAILNET_PROXY=socks5://localhost:1055" > /etc/profile.d/digby-tailnet.sh 2>/dev/null || true',
  ];
}

/** Post-create posture rewrite (helpers + profile) via a root exec. */
async function writePosture(name: string, mode: 'scoped' | 'direct'): Promise<void> {
  const script = [...helperLines(mode), ...profileLines(mode)].join('\n');
  await docker(['exec', name, 'sh', '-c', script], 30_000);
}

/**
 * The container boot script (runs as root; session execs run as uid 1001):
 * install tailscale once, start userspace tailscaled with its state on the
 * persistent volume, then POLL-WAIT for the auth key file (the backend writes
 * it via stdin exec after create — this closes the read-before-write race),
 * join, delete the key, and idle. Root-owned 0600 secrets + 0700 state keep
 * both away from uid-1001 session shells.
 *
 * scoped=true (CODING_EGRESS_SECRET present): tailscaled's SOCKS5 moves to
 * 127.0.0.1:1057 (no HTTP proxy — closes the unauthenticated :1056 bypass),
 * the policy dir is prepared root-only, the shim is auto-started when its
 * file exists (docker-start restarts keep it alive), and helpers/profile are
 * the scoped variants. scoped=false renders v1 verbatim (pepper absent).
 *
 * keyWaitSec: how long to poll-wait for the out-of-band key delivery — 120s
 * when a key IS configured (delivery race window), a few seconds when none is
 * (no delivery is coming; the URL-flow elif must fire well inside the
 * join-verify window or the create path tears the container down first —
 * review B1, PR #473).
 */
function bootScript(scoped: boolean, keyWaitSec = 120): string {
  // Respawn loop (platform task 2026-08-28, tailnet session-recourse): a wedged
  // or crashed tailscaled self-heals in <=2s with the SAME flags instead of
  // needing a full container restart — the 2026-08-28 tt-quietbox window showed
  // a session's only recourse must never be root. The pidfile guard keeps
  // docker-start re-runs of this script from stacking a second loop (a stale
  // pid fails kill -0 after a container restart, so exactly one loop survives).
  const tailscaledLine = scoped
    ? `if [ -f /tmp/digby-ts-loop.pid ] && kill -0 $(cat /tmp/digby-ts-loop.pid 2>/dev/null) 2>/dev/null; then :; else ( while true; do tailscaled --tun=userspace-networking --statedir=${TS_STATE_DIR} --socks5-server=127.0.0.1:${UPSTREAM_PORT} >>/tmp/tailscaled.log 2>&1 || true; sleep 2; done ) & echo $! > /tmp/digby-ts-loop.pid 2>/dev/null || true; fi`
    : `if [ -f /tmp/digby-ts-loop.pid ] && kill -0 $(cat /tmp/digby-ts-loop.pid 2>/dev/null) 2>/dev/null; then :; else ( while true; do tailscaled --tun=userspace-networking --statedir=${TS_STATE_DIR} --socks5-server=localhost:1055 --outbound-http-proxy-listen=localhost:1056 >>/tmp/tailscaled.log 2>&1 || true; sleep 2; done ) & echo $! > /tmp/digby-ts-loop.pid 2>/dev/null || true; fi`;
  const scopedLines = scoped
    ? [
      `mkdir -p ${EGRESS_DIR}/creds && chmod 700 ${EGRESS_DIR} ${EGRESS_DIR}/creds || true`,
      // docker-start restarts re-run this script; the shim file persists in the
      // container layer, so bring the shim back with it (create-time start is
      // done by the backend after it writes the file — verifyEgressShim).
      `[ -f ${EGRESS_LIB}/proxy.js ] && (nohup node ${EGRESS_LIB}/proxy.js >>/tmp/digby-egress.log 2>&1 &) || true`,
    ]
    : [];
  return [
    'set -e',
    SESSION_USER_SCRIPT,
    'command -v tailscale >/dev/null 2>&1 || (curl -fsSL https://tailscale.com/install.sh | sh) >/tmp/ts-install.log 2>&1 || true',
    // netcat-openbsd = the SOCKS-capable `nc -x` the legacy/direct tssh helper
    // needs (node:20 bookworm ships NO nc variant). Same `command -v`
    // idempotence as the tailscale line, so a prebuilt CODING_DEV_IMAGE
    // (docker/dev-image) with it baked in skips the apt round-trip entirely
    // (ticket 793f5130).
    'command -v nc >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq --no-install-recommends netcat-openbsd) >/tmp/nc-install.log 2>&1 || true',
    // Baked-in helpers (ticket d3a983ca) so agents don't hand-write the
    // ProxyCommand: `tssh host`, `tcurl url`. Plain rewrites of static text —
    // idempotent on restart AND over a prebuilt image; no secrets involved.
    ...helperLines(scoped ? 'scoped' : 'legacy'),
    `mkdir -p ${TS_STATE_DIR} /run/secrets`,
    `chown -R 0:0 ${TS_STATE_DIR} 2>/dev/null || true; chmod 700 ${TS_STATE_DIR} 2>/dev/null || true`,
    tailscaledLine,
    ...scopedLines,
    // Wait for the backend to deliver the key: 120s when one is configured
    // (delivery race window), a few seconds when none is (no delivery is
    // coming — fall through to the URL-flow elif promptly, review B1). If
    // state already holds an identity (persistent ts-state), tailscaled
    // reconnects without a key and the wait simply times out harmlessly.
    `i=0; while [ $i -lt ${keyWaitSec} ] && [ ! -s /run/secrets/ts_authkey ]; do i=$((i+1)); sleep 1; done`,
    'TS_KEY=$(cat /run/secrets/ts_authkey 2>/dev/null || true)',
    'rm -f /run/secrets/ts_authkey || true',
    // URL-flow fallback (feedback 0bd05198): no auth key delivered AND no
    // persisted ts-state identity (state != Running) → start an interactive
    // join so the login URL lands in /tmp/ts-up.log; getDevContainerStatus
    // scrapes it and Settings shows a "click to authorize" link. --timeout
    // keeps boot non-blocking; the issued URL stays usable after it lapses.
    'if [ -n "$TS_KEY" ]; then tailscale up --authkey="$TS_KEY" --hostname="digby-dev" --accept-dns=false --timeout=90s >/tmp/ts-up.log 2>&1 || true; elif ! tailscale status --json 2>/dev/null | tr -d " \\n" | grep -q \'"BackendState":"Running"\'; then tailscale up --hostname="digby-dev" --accept-dns=false --timeout=30s >/tmp/ts-up.log 2>&1 || true; fi',
    // Keyed join that did not reach Running (2026-10-13): the persisted
    // ts-state holds an EXPIRED identity (a URL-flow node past its key
    // expiry), so the plain `up` above keeps the dead login and the saved key
    // is never used. Retry ONCE forcing re-authentication with the key. Both
    // keyed joins are bounded (--timeout) so a bad key cannot wedge boot.
    'if [ -n "$TS_KEY" ] && ! tailscale status --json 2>/dev/null | tr -d " \\n" | grep -q \'"BackendState":"Running"\'; then tailscale up --authkey="$TS_KEY" --hostname="digby-dev" --accept-dns=false --force-reauth --timeout=60s >>/tmp/ts-up.log 2>&1 || true; fi',
    'unset TS_KEY',
    // Opt-in proxy env for session shells — deliberately NOT ALL_PROXY (a
    // global proxy would break every curl/git whenever tailscaled degrades).
    ...profileLines(scoped ? 'scoped' : 'legacy'),
    'sleep infinity',
  ].join('\n');
}

/**
 * The egress shim — a dependency-free Node SOCKS5 server (RFC1928 + RFC1929
 * auth) written into the container by the backend. Runs as ROOT (started by
 * the boot script / backend exec) so the root-only policy dir stays away from
 * uid-1001 sessions. Speaks CONNECT only; chains allowed connections to
 * tailscaled's upstream SOCKS5 (127.0.0.1:1057) preserving ATYP=DOMAIN
 * (socks5h semantics — upstream MagicDNS resolves tailnet names).
 *
 * Policy per connection (re-read from disk — edits/concurrent writers take
 * effect immediately, and byte-identical deterministic content makes
 * multi-process writes safe):
 *   creds/<user>.json { v, pwHash, allow? } → session credential + override
 *   default.json { v, allow? }              → per-user default
 *   neither                                  → allow-all (v1 reachability)
 * An explicit "allow": [] = deny-all. pwHash = HMAC_SHA256('digby-egress-
 * store', password) — the file never holds the password itself.
 *
 * JS STYLE CONSTRAINT: embedded in a TS template literal — no backticks, no
 * ${, and (String.raw) backslashes would stay literal, so regexes are kept
 * minimal and literal. Exported for the jest real-socket suite.
 */
export function egressProxyJs(): string {
  return String.raw`
'use strict';
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const DIR = process.env.DIGBY_EGRESS_DIR || '/run/digby-egress';
const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = Number(process.env.DIGBY_EGRESS_PORT || 1055);
const UP_HOST = '127.0.0.1';
const UP_PORT = Number(process.env.DIGBY_EGRESS_UP_PORT || 1057);
const STORE_KEY = 'digby-egress-store';

function pwHash(pw) { return crypto.createHmac('sha256', STORE_KEY).update(String(pw)).digest('hex'); }
function log(line) { try { console.log(new Date().toISOString() + ' ' + line); } catch (e) {} }
function loadJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

// ── allowlist matcher (compact mirror of egress-policy.ts; the jest suite
// exercises THIS code over real sockets against the same corpus) ──
function ipv4Bytes(ip) {
  const m = new RegExp('^([0-9]{1,3})[.]([0-9]{1,3})[.]([0-9]{1,3})[.]([0-9]{1,3})$').exec(ip);
  if (!m) return null;
  const b = Buffer.alloc(4);
  for (let i = 1; i <= 4; i++) { const n = Number(m[i]); if (n > 255 || String(n) !== m[i]) return null; b[i - 1] = n; }
  return b;
}
function parseRule(raw0) {
  let body = String(raw0).trim();
  if (!body || body.length > 263) throw new Error('bad rule');
  let port = null;
  const bp = new RegExp('^[[]([^\]]+)[]](?::([0-9]{1,5}))?$').exec(body);
  if (bp) { body = bp[1]; if (bp[2] !== undefined) port = Number(bp[2]); }
  else if ((body.match(/:/g) || []).length === 1) {
    const m = /^(.*):([0-9]{1,5})$/.exec(body);
    if (m) { body = m[1]; port = Number(m[2]); }
  } else if (body.indexOf(':') >= 0 && !net.isIPv6(body.split('/')[0])) {
    throw new Error('v6 port needs brackets');
  }
  if (port !== null && (port < 1 || port > 65535)) throw new Error('bad port');
  const slash = body.lastIndexOf('/');
  if (slash >= 0) {
    const addr = body.slice(0, slash);
    const prefix = Number(body.slice(slash + 1));
    if (!new RegExp('^[0-9]{1,3}$').test(body.slice(slash + 1))) throw new Error('bad prefix');
    if (net.isIPv4(addr) && prefix <= 32) return { kind: 'cidr', ip: addr, prefix: prefix, port: port };
    if (net.isIPv6(addr) && prefix <= 128) return { kind: 'cidr', ip: addr, prefix: prefix, port: port };
    throw new Error('bad cidr');
  }
  if (net.isIP(body)) return { kind: 'cidr', ip: body, prefix: net.isIPv4(body) ? 32 : 128, port: port };
  if (new RegExp('^[0-9]+([.][0-9]+)+$').test(body)) throw new Error('bad IPv4 address');
  let host = body.toLowerCase();
  if (host === '*') return { kind: 'host', host: '', port: port };
  if (host.indexOf('*.') === 0) host = host.slice(1);
  if (!new RegExp('^[.]?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$').test(host) || host.indexOf('..') >= 0) throw new Error('bad host');
  return { kind: 'host', host: host, port: port };
}
function parseRuleSafe(s) { try { return parseRule(s); } catch (e) { return null; } }
function matches(rules, host, port) {
  const h = String(host).trim().toLowerCase();
  if (!h) return false;
  const isIp = net.isIP(h) !== 0;
  for (const r of rules) {
    if (!r) continue;
    if (r.port !== null && r.port !== port) continue;
    if (r.kind === 'host') {
      if (r.host === '') return true; // '*' matches EVERY destination (hosts + IPs)
      if (isIp) continue; // named host rules never match IP literals
      if (r.host.charAt(0) === '.') { if (h.length > r.host.length && h.endsWith(r.host)) return true; }
      else if (h === r.host) return true;
    } else if (isIp) {
      if (net.isIPv4(h) && net.isIPv4(r.ip)) { if (v4PrefixMatch(r.ip, r.prefix, h)) return true; }
      else if (net.isIPv6(h) && net.isIPv6(r.ip)) {
        const rb = ipv6Bytes(r.ip); const hb = ipv6Bytes(h);
        if (rb && hb && bytesPrefixMatch(rb, r.prefix, hb)) return true;
      }
    }
  }
  return false;
}
function v4PrefixMatch(netAddr, prefix, addr) {
  const n = ipv4Bytes(netAddr); const a = ipv4Bytes(addr);
  if (!n || !a) return false;
  const full = Math.floor(prefix / 8);
  for (let i = 0; i < full; i++) if (n[i] !== a[i]) return false;
  const rem = prefix % 8;
  if (rem === 0) return true;
  if (full >= 4) return false;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (n[full] & mask) === (a[full] & mask);
}
// v6 parser/prefix-match mirroring egress-policy.ts (adversarial review F3:
// the shim previously matched v6 CIDR rules only against EXACT canonical
// addresses — stricter than the TS validator, a silent-deny correctness gap).
function ipv6Bytes(ip) {
  if (!net.isIPv6(ip)) return null;
  let s = String(ip).toLowerCase();
  const v4 = ipv4Bytes(s.split(':').pop() || '');
  if (v4 && s.indexOf('.') >= 0) {
    const hex = [];
    for (let i = 0; i < 4; i++) hex.push(v4[i].toString(16).padStart(2, '0'));
    s = s.slice(0, s.lastIndexOf(':')) + ':' + hex[0] + hex[1] + ':' + hex[2] + hex[3];
  }
  const dc = s.indexOf('::');
  let head = [];
  let tail = [];
  if (dc >= 0) {
    head = s.slice(0, dc).split(':').filter(Boolean);
    tail = s.slice(dc + 2).split(':').filter(Boolean);
    if (s.indexOf('::', dc + 1) >= 0) return null;
  } else {
    head = s.split(':');
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (dc < 0 && missing !== 0) || head.length + tail.length > 8) return null;
  const groups = head.concat(new Array(missing).fill('0'), tail);
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    if (!new RegExp('^[0-9a-f]{1,4}$').test(groups[i])) return null;
    out.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  }
  return out;
}
function bytesPrefixMatch(network, prefix, addr) {
  if (network.length !== addr.length) return false;
  const full = Math.floor(prefix / 8);
  for (let i = 0; i < full; i++) if (network[i] !== addr[i]) return false;
  const rem = prefix % 8;
  if (rem === 0) return true;
  if (full >= addr.length) return false;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (network[full] & mask) === (addr[full] & mask);
}

function policyFor(user) {
  const safe = new RegExp('^s[0-9a-f]{12}$').test(user) ? user : null;
  if (!safe) return { ok: false };
  const cred = loadJson(DIR + '/creds/' + safe + '.json');
  if (!cred || typeof cred.pwHash !== 'string') return { ok: false };
  let allow = null;
  if (Object.prototype.hasOwnProperty.call(cred, 'allow')) allow = cred.allow;
  else {
    // default.json distinguishes ABSENT (allow-all, legacy-compatible) from
    // CORRUPT (fail CLOSED — deny-all; adversarial review F2). Valid object
    // without an 'allow' key ({"v":1}) is the explicit allow-all default.
    let raw = null;
    try { raw = fs.readFileSync(DIR + '/default.json', 'utf8'); } catch (e) { /* absent */ }
    if (raw !== null) {
      let d = null;
      try { d = JSON.parse(raw); } catch (e) { d = null; }
      if (d === null || typeof d !== 'object' || Array.isArray(d)) { allow = []; log('corrupt default.json — failing CLOSED (deny-all)'); }
      else if (Object.prototype.hasOwnProperty.call(d, 'allow')) allow = d.allow;
    }
  }
  return { ok: true, cred: cred, allow: Array.isArray(allow) ? allow.map(parseRuleSafe) : null };
}

function reply(client, rep) {
  // VER=5 REP=rep RSV=0 ATYP=1 BND.ADDR=0.0.0.0 BND.PORT=0
  client.write(Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]));
}

const server = net.createServer(function (client) {
  client.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let stage = 'greet';
  let user = '';
  let policy = null;
  let upstream = null;
  let done = false;
  function cleanup() {
    if (done) return;
    done = true;
    try { client.destroy(); } catch (e) {}
    if (upstream) { try { upstream.destroy(); } catch (e) {} }
  }
  client.on('error', cleanup);
  client.on('close', function () { if (upstream) { try { upstream.destroy(); } catch (e) {} } });
  client.setTimeout(30000, function () { if (stage !== 'pipe') cleanup(); });
  client.on('data', function (chunk) {
    if (done || stage === 'pipe') return; // piped streams forward via .pipe — never buffer here
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 4096) return cleanup();
    try { pump(); } catch (e) { cleanup(); }
  });
  function pump() {
    for (;;) {
      if (stage === 'pipe') return;
      if (stage === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return cleanup();
        const n = buf[1];
        if (buf.length < 2 + n) return;
        let hasAuth = false;
        for (let i = 0; i < n; i++) if (buf[2 + i] === 2) hasAuth = true;
        buf = buf.slice(2 + n);
        if (!hasAuth) { client.write(Buffer.from([5, 255])); return cleanup(); }
        client.write(Buffer.from([5, 2]));
        stage = 'auth';
      } else if (stage === 'auth') {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 3 + ulen) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        if (buf[0] !== 1) return cleanup();
        user = buf.slice(2, 2 + ulen).toString('utf8');
        const pass = buf.slice(3 + ulen, 3 + ulen + plen).toString('utf8');
        buf = buf.slice(3 + ulen + plen);
        const pol = policyFor(user);
        const ok = pol.ok && typeof pol.cred.pwHash === 'string' &&
          crypto.timingSafeEqual(Buffer.from(pwHash(pass)), Buffer.from(pol.cred.pwHash));
        if (!ok) {
          log('deny auth user=' + user);
          client.write(Buffer.from([1, 1]));
          return cleanup();
        }
        policy = pol;
        client.write(Buffer.from([1, 0]));
        stage = 'request';
      } else if (stage === 'request') {
        if (buf.length < 4) return;
        if (buf[0] !== 5 || buf[1] !== 1) { reply(client, 7); return cleanup(); } // CONNECT only
        const atyp = buf[3];
        let host = null;
        let need = 0;
        if (atyp === 1) { need = 4 + 4 + 2; if (buf.length < need) return; host = Array.from(buf.slice(4, 8)).join('.'); }
        else if (atyp === 3) {
          const dlen = buf[4];
          need = 5 + dlen + 2;
          if (buf.length < need) return;
          host = buf.slice(5, 5 + dlen).toString('utf8');
          if (host.length > 253) { reply(client, 4); return cleanup(); }
        } else if (atyp === 4) {
          need = 4 + 16 + 2;
          if (buf.length < need) return;
          const b = buf.slice(4, 20);
          const parts = [];
          for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16));
          host = parts.join(':');
        } else { reply(client, 8); return cleanup(); }
        const port = buf.readUInt16BE(need - 2);
        const rest = buf.slice(need);
        buf = Buffer.alloc(0);
        if (policy.allow !== null && !matches(policy.allow, host, port)) {
          log('deny dest user=' + user + ' dest=' + host + ':' + port);
          reply(client, 2);
          return cleanup();
        }
        stage = 'pipe';
        upstreamConnect(client, host, port, atyp, rest, function (err) {
          if (err) { reply(client, 5); cleanup(); }
        });
        return;
      }
    }
  }
  function upstreamConnect(clientSock, host, port, atyp, rest, cb) {
    const up = net.connect(UP_PORT, UP_HOST);
    upstream = up;
    let ubuf = Buffer.alloc(0);
    let ustage = 'greet';
    let failed = false;
    up.on('error', function () { if (!failed) { failed = true; cb(new Error('upstream')); } });
    up.on('connect', function () { up.write(Buffer.from([5, 1, 0])); }); // no-auth upstream
    up.on('data', function (chunk) {
      ubuf = Buffer.concat([ubuf, chunk]);
      if (ustage === 'greet') {
        if (ubuf.length < 2) return;
        if (ubuf[0] !== 5 || ubuf[1] !== 0) { if (!failed) { failed = true; cb(new Error('upstream method')); } return; }
        ubuf = ubuf.slice(2);
        ustage = 'request';
        let req;
        if (atyp === 3) {
          const hb = Buffer.from(host, 'utf8');
          req = Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb, Buffer.from([port >> 8, port & 255])]);
        } else if (atyp === 1) {
          const parts = host.split('.').map(Number);
          req = Buffer.concat([Buffer.from([5, 1, 0, 1]), Buffer.from(parts), Buffer.from([port >> 8, port & 255])]);
        } else {
          const groups = host.split(':');
          const b = Buffer.alloc(16);
          for (let i = 0; i < 8; i++) b.writeUInt16BE(parseInt(groups[i] || '0', 16), i * 2);
          req = Buffer.concat([Buffer.from([5, 1, 0, 4]), b, Buffer.from([port >> 8, port & 255])]);
        }
        up.write(req);
      } else if (ustage === 'request') {
        if (ubuf.length < 10) return;
        if (ubuf[0] !== 5 || ubuf[1] !== 0) { if (!failed) { failed = true; cb(new Error('upstream denied ' + ubuf[1])); } return; }
        ustage = 'pipe';
        reply(clientSock, 0);
        if (rest.length) up.write(rest);
        clientSock.pipe(up);
        up.pipe(clientSock);
        log('allow user=' + user + ' dest=' + host + ':' + port);
      }
    });
  }
});
server.on('error', function (err) { log('server error ' + (err && err.message)); process.exit(1); });
server.listen(LISTEN_PORT, LISTEN_HOST, function () { log('digby-egress shim listening on ' + LISTEN_HOST + ':' + LISTEN_PORT); });
`;
}

/**
 * socks-connect.js — tssh's ProxyCommand in scoped mode (netcat-openbsd can't
 * do RFC1929). Speaks auth'd SOCKS5 to the shim using DIGBY_TAILNET_PROXY
 * (socks5h://user:pass@host:port — injected per session by the backend), then
 * pipes stdio. Exit != 0 (ssh fails closed) when the shim denies or the env
 * is missing. Same embedding constraints as egressProxyJs. Exported for tests.
 */
export function socksConnectJs(): string {
  return String.raw`
'use strict';
const net = require('net');
const url = process.env.DIGBY_TAILNET_PROXY || '';
const m = new RegExp('^socks5h?://([^:]+):([^@]+)@([^:/]+):([0-9]+)$').exec(url);
const host = process.argv[2];
const port = Number(process.argv[3]);
function die(msg) { process.stderr.write('socks-connect: ' + msg + '\n'); process.exit(2); }
if (!m) die('DIGBY_TAILNET_PROXY missing or malformed — per-session egress scoping requires the backend-injected value (ticket 4ed6eb2e)');
if (!host || !port) die('usage: socks-connect.js <host> <port>');
const up = net.connect(Number(m[4]), m[3]);
let stage = 'greet';
let buf = Buffer.alloc(0);
up.on('error', function (e) { die('connect failed: ' + e.message); });
up.on('connect', function () { up.write(Buffer.from([5, 1, 2])); });
up.on('data', function (chunk) {
  if (stage === 'pipe') return; // .pipe forwards from here — never double-write
  buf = Buffer.concat([buf, chunk]);
  if (stage === 'greet') {
    if (buf.length < 2) return;
    if (buf[0] !== 5 || buf[1] !== 2) die('proxy refused auth negotiation');
    buf = buf.slice(2);
    const u = Buffer.from(m[1], 'utf8');
    const p = Buffer.from(m[2], 'utf8');
    up.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    stage = 'auth';
  } else if (stage === 'auth') {
    if (buf.length < 2) return;
    if (buf[1] !== 0) die('proxy auth failed (bad per-session credentials)');
    buf = buf.slice(2);
    const hb = Buffer.from(host, 'utf8');
    up.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb, Buffer.from([port >> 8, port & 255])]));
    stage = 'request';
  } else if (stage === 'request') {
    if (buf.length < 10) return;
    if (buf[0] !== 5 || buf[1] !== 0) die('proxy denied ' + host + ':' + port + ' by egress policy (code ' + buf[1] + ')');
    // The shim always replies with the fixed 10-byte ATYP=1 form.
    const rest = buf.slice(10);
    buf = Buffer.alloc(0);
    stage = 'pipe';
    process.stdin.pipe(up);
    up.pipe(process.stdout);
    if (rest.length) up.write(rest);
  }
});
`;
}

/** Write the shim + socks-connect into the container (world-readable, no
 *  secrets) via stdin execs — same out-of-band pattern as deliverAuthKey. */
async function writeEgressSupport(name: string): Promise<void> {
  const put = async (remote: string, content: string) => new Promise<void>((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', name, 'sh', '-c', `mkdir -p ${EGRESS_LIB} && cat > ${remote} && chmod 644 ${remote}`],
      { timeout: 30_000 }, (err) => (err ? reject(err) : resolve()));
    child.stdin?.write(content);
    child.stdin?.end();
  });
  await put(`${EGRESS_LIB}/proxy.js`, egressProxyJs());
  await put(`${EGRESS_LIB}/socks-connect.js`, socksConnectJs());
}

/** Write a JSON blob atomically into the root-only policy dir (tmp + mv). The
 *  tmp name carries the writer shell's PID ($$) so two concurrent writers
 *  (backend + worker, deterministic identical content by design B2) never
 *  interleave into one tmp file — last intact mv wins (adversarial review F2:
 *  a shared tmp could corrupt default.json, and corrupt used to read as
 *  allow-all = fail-open; the shim now also fails closed on corrupt). */
function putPolicyFile(name: string, remote: string, json: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', name, 'sh', '-c',
      `mkdir -p ${EGRESS_DIR}/creds && chmod 700 ${EGRESS_DIR} ${EGRESS_DIR}/creds && cat > ${remote}.$$.tmp && chmod 600 ${remote}.$$.tmp && mv ${remote}.$$.tmp ${remote}`],
      { timeout: 30_000 }, (err) => (err ? reject(err) : resolve()));
    child.stdin?.write(json);
    child.stdin?.end();
  });
}

/** Push the per-user default allowlist (null/absent = allow-all). */
async function pushDefaultPolicy(name: string, userId: string): Promise<void> {
  let allow: string[] | null = null;
  try {
    const prefs = await prisma.userPreferences.findUnique({ where: { userId }, select: { devContainerEgressAllow: true } });
    if (prefs?.devContainerEgressAllow) {
      const parsed = JSON.parse(prefs.devContainerEgressAllow);
      if (Array.isArray(parsed)) allow = parsed.filter((s): s is string => typeof s === 'string');
    }
  } catch (err: any) {
    logger.warn(`dev-container: default egress policy read failed for ${userId.slice(0, 8)} (${String(err?.message).slice(0, 80)}) — pushing allow-all`);
  }
  await putPolicyFile(name, `${EGRESS_DIR}/default.json`, JSON.stringify(allow === null ? { v: 1 } : { v: 1, allow }));
}

/** Bash fragment: connect :1055, offer ONLY user/pass auth (method 2), read
 *  the 2-byte method reply. The shim answers [5,2]; tailscaled's no-auth
 *  SOCKS5 answers [5,0xFF] (or [5,0] if it accepted) — so "5 2" uniquely
 *  identifies the shim, and a dead port prints nothing. POSIX-octal printf. */
const SHIM_PROBE = `(exec 3<>/dev/tcp/127.0.0.1/${SHIM_PORT} && printf '\\005\\001\\002' >&3 && head -c 2 <&3; exec 3<&-; exec 3>&-) 2>/dev/null | od -An -tu1`;
const shimAnswered = (stdout: string) => /5\s+2\s*$/.test(stdout);

/** (Re)start the shim if its listener is absent; probe = auth-method banner. */
async function ensureShimRunning(name: string): Promise<boolean> {
  const probe = await docker(['exec', name, 'bash', '-c', SHIM_PROBE], 15_000).catch(() => null);
  if (probe && shimAnswered(probe.stdout)) return true;
  await docker(['exec', name, 'sh', '-c', `pkill -f 'node ${EGRESS_LIB}/proxy.js' 2>/dev/null; (nohup node ${EGRESS_LIB}/proxy.js >>/tmp/digby-egress.log 2>&1 &)`], 15_000).catch(() => null);
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    const p = await docker(['exec', name, 'bash', '-c', SHIM_PROBE], 15_000).catch(() => null);
    if (p && shimAnswered(p.stdout)) return true;
  }
  return false;
}

/**
 * Post-create (or repair-time) scoping setup: support files + default policy +
 * verified shim start, then posture + marker. On ANY failure the container
 * falls back to the DIRECT posture (helpers bypass the dead shim to the
 * upstream — sessions keep working UNSCOPED, status reports degraded) instead
 * of breaking tailnet access. Never throws.
 */
async function setupEgressScoping(name: string, userId: string): Promise<boolean> {
  try {
    await writeEgressSupport(name);
    await pushDefaultPolicy(name, userId);
    if (await ensureShimRunning(name)) {
      await writePosture(name, 'scoped').catch(() => {});
      await docker(['exec', name, 'sh', '-c', `echo scoped > ${EGRESS_MARKER} && chmod 600 ${EGRESS_MARKER}`], 15_000).catch(() => {});
      return true;
    }
    logger.warn(`dev-container: egress shim failed to start on ${name} — DIRECT fallback (unscoped tailnet access)`);
    await writePosture(name, 'direct').catch(() => {});
    return false;
  } catch (err: any) {
    logger.warn(`dev-container: egress scoping setup failed on ${name} (${String(err?.message).slice(0, 120)}) — DIRECT fallback`);
    await writePosture(name, 'direct').catch(() => {});
    return false;
  }
}

/**
 * Session grant: write creds/<user>.json (deterministic content — HMAC-derived
 * password hash + this session's allow override) and return the per-session
 * proxy URL for exec-env injection. Returns null when scoping is unavailable
 * (pepper absent / write failed) — the caller then injects NOTHING and the
 * session behaves per posture (legacy: v1; scoped: helpers fail closed).
 * Never throws.
 */
export async function ensureSessionEgressGrant(sessionId: string, name: string): Promise<string | null> {
  try {
    const pepper = egressSecret();
    if (!pepper) return null;
    const user = egressUsername(sessionId);
    const pass = egressPassword(sessionId, pepper);
    // Session override (NULL/absent = inherit the per-user default inside the
    // shim). A corrupt stored override can only come from manual DB edits —
    // degrade to INHERIT (never silently deny-all a session on bad data).
    let allow: string[] | undefined;
    try {
      const row = await prisma.chatCodingState.findUnique({ where: { id: sessionId }, select: { tailnetEgressAllow: true } });
      if (row?.tailnetEgressAllow) {
        const parsed = JSON.parse(row.tailnetEgressAllow);
        if (Array.isArray(parsed)) allow = parsed.filter((s): s is string => typeof s === 'string');
      }
    } catch { allow = undefined; }
    const body: Record<string, unknown> = { v: 1, pwHash: passwordHash(pass) };
    if (allow !== undefined) body.allow = allow;
    await putPolicyFile(name, `${EGRESS_DIR}/creds/${user}.json`, JSON.stringify(body));
    return `socks5h://${user}:${pass}@localhost:${SHIM_PORT}`;
  } catch (err: any) {
    logger.warn(`dev-container: session egress grant failed for ${sessionId.slice(0, 8)} (${String(err?.message).slice(0, 100)}) — no injection`);
    return null;
  }
}

/** Live egress posture for the Settings UI / sweep. Never throws. */
async function probeEgressState(name: string): Promise<{ marker: boolean; shim: boolean }> {
  const r = await docker(['exec', name, 'bash', '-c',
    `test -f ${EGRESS_MARKER} && echo MARKER; ${SHIM_PROBE}`], 15_000).catch(() => null);
  if (!r) return { marker: false, shim: false };
  return { marker: r.stdout.includes('MARKER'), shim: shimAnswered(r.stdout) };
}

/**
 * Quiet-window sweep (worker cron, alongside the container reaper): upgrade
 * LEGACY (pre-scoping) dev containers to the scoped layout by RECREATING them
 * (persisted ts-state re-joins keyless), and repair scoped containers whose
 * shim died. Never mid-run: containers with an in-flight run are skipped, and
 * everything is skipped when the pepper is absent (legacy by configuration).
 */
export async function upgradeLegacyEgressContainers(): Promise<void> {
  try {
    if (!egressSecret()) return;
    if (!(await isDockerAvailable())) return;
    const ls = await docker(['ps', '--filter', `label=${DEV_LABEL}`, '--format', `{{.Names}}\t{{.Label "${DEV_LABEL}"}}`]).catch(() => null);
    if (!ls?.stdout.trim()) return;
    for (const line of ls.stdout.trim().split('\n')) {
      const [name, userId] = line.split('\t');
      if (!name || !userId) continue;
      try {
        if ((await devContainerEnabledTriState(userId)) !== true) continue; // disabled/unknown → not our business
        if (await userHasInFlightRun(userId)) continue;                     // never mid-run
        const st = await probeEgressState(name);
        if (!st.marker) {
          logger.info(`dev-container: upgrading legacy container ${name} to per-session egress scoping (recreate)`);
          healthyMemo.delete(userId);
          await docker(['rm', '-f', name]).catch(() => {});
          await ensureUserDevContainer(userId); // fresh scoped create + setupEgressScoping inside
        } else if (!st.shim) {
          logger.info(`dev-container: repairing dead egress shim on ${name}`);
          healthyMemo.delete(userId);
          await setupEgressScoping(name, userId);
        }
      } catch (err: any) {
        logger.warn(`dev-container: egress sweep skipped ${name} (${String(err?.message).slice(0, 100)})`);
      }
    }
  } catch (err: any) {
    logger.warn(`dev-container: egress upgrade sweep failed (non-fatal): ${String(err?.message).slice(0, 120)}`);
  }
}
/** A Settings-started dev-container action, recorded in Redis so any web box
 *  can show its progress (dev-container-remote.ts writes it). */
export interface DevContainerActionRecord {
  action: 'restart' | 'tailnet_restart' | 'tailnet_reconnect';
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  note?: string;
}

export interface DevContainerStatus {
  enabled: boolean;
  running: boolean;
  container: string;
  image: string;
  tailscale: {
    state: string; ip4?: string; hostname?: string; loginUrl?: string; socket?: string; socks5?: string; httpProxy?: string;
    /** 2026-10-13 (remote ops): the node as the coordination server sees it. */
    online?: boolean;
    /** RFC 3339 node-key expiry; null = expiry disabled (tagged nodes). */
    keyExpiry?: string | null;
    tags?: string[];
    /** A login is pending. When a key is saved the URL itself is withheld —
     *  the fix is Reconnect with the saved key, never a personal login. */
    loginPending?: boolean;
  } | null;
  keyConfigured: boolean;
  /** Where this status was read (2026-10-13): this process, the coding server
   *  over Redis, or nobody answered (live state unknown — never "not running"). */
  reach?: 'local' | 'remote' | 'unreachable';
  /** The last Restart / Reconnect started from Settings (Redis record). */
  action?: DevContainerActionRecord | null;
  /** Per-session egress scoping posture (ticket 4ed6eb2e). */
  egress: {
    /** scoped = shim on :1055 with per-session creds; legacy = v1 shared
     *  posture (pepper absent or pre-upgrade); degraded = scoped-era
     *  container whose shim is down (helpers currently bypass UNSCOPED);
     *  off = feature disabled / no container; unknown = the coding server
     *  did not answer (2026-10-13 remote ops — never guessed). */
    mode: 'scoped' | 'legacy' | 'degraded' | 'off' | 'unknown';
    shim: boolean | null;          // shim answering on :1055 (null = unknown)
    policyRules: number | null;    // per-user default rule count (null = allow-all)
    note?: string;
  };
  note?: string;
}

/** Per-process, per-user health memo (short TTL bounds cross-instance staleness). */
const healthyMemo = new Map<string, number>();
const HEALTH_MEMO_MS = 20_000;

/** Drop the cached health verdict (e.g. after an exec failed with "No such container"). */
export function invalidateDevContainerMemo(userId: string): void {
  healthyMemo.delete(userId);
}

async function isRunning(name: string): Promise<boolean> {
  return docker(['ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])
    .then(r => r.stdout.trim() === name).catch(() => false);
}

/** Poll `tailscale status --json` until BackendState is Running (or timeout). */
async function verifyTailnetJoin(name: string, timeoutMs = JOIN_VERIFY_TIMEOUT_MS()): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await docker(['exec', name, 'tailscale', 'status', '--json'], 15_000).catch(() => null);
    if (st) {
      try {
        if (String(JSON.parse(st.stdout)?.BackendState) === 'Running') return true;
      } catch { /* not json yet */ }
    }
    await new Promise(r => setTimeout(r, JOIN_VERIFY_POLL_MS()));
  }
  return false;
}

/** Where the boot script waits for the create-time key. */
const BOOT_KEY_PATH = '/run/secrets/ts_authkey';
/** Where Reconnect stages the key — a DIFFERENT file, so a boot script still
 *  inside its key-wait window can never consume the reconnect's copy. */
export const RECONNECT_KEY_PATH = '/run/secrets/ts_authkey_reconnect';

/** Deliver the auth key out-of-band: stdin → root-owned 0600 file (never argv/env).
 *  umask 077 first (2026-10-13): `cat >` under the default 022 left the file
 *  0644 until the chmod — a brief window a uid-1001 session shell could read. */
function deliverAuthKey(name: string, authKey: string, path: string = BOOT_KEY_PATH): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', name, 'sh', '-c', `umask 077 && mkdir -p /run/secrets && cat > ${path} && chmod 600 ${path}`],
      { timeout: 30_000 }, (err) => (err ? reject(err) : resolve()));
    child.stdin?.write(authKey);
    child.stdin?.end();
  });
}

/** Best-effort cross-process create lock (SET NX). Returns a release fn (or null if not acquired). */
async function acquireCreateLock(userId: string): Promise<(() => Promise<void>) | null> {
  try {
    const key = `coding:devlock:${userId.slice(0, 12)}`;
    const ok = await redisClient.set(key, `${process.pid}`, { NX: true, EX: 300 });
    if (!ok) return null;
    return async () => { await redisClient.del(key).catch(() => {}); };
  } catch {
    // Redis down → proceed lockless; the docker name-conflict path below still
    // resolves a race safely (conflict = adopt the winner, never rm -f).
    return async () => {};
  }
}

// ── build 2026-10-08 ISO: the dev container's workspace mount plan ──────────

export type DevMountPlan =
  | { mode: 'whole_volume'; reason: string }
  | { mode: 'user_subtree'; key: string; extraMirrors: string[]; reason: string };

/**
 * The mounts this user's dev container SHOULD have. whole_volume (today) unless
 * the per-user switch applies to the user AND the census finds every live
 * worktree of theirs in their subtree. Fail-safe: any census error → whole
 * volume (the prior posture; sessions stay covered). Never throws.
 */
export async function desiredDevMountPlan(userId: string): Promise<DevMountPlan> {
  if (!perUserSubtreeAppliesTo(userId)) return { mode: 'whole_volume', reason: 'switch_off' };
  try {
    const c = await userContainmentCensus(userId, CODING_WORKSPACE_ROOT);
    if (c.legacy > 0) return { mode: 'whole_volume', reason: `legacy_worktrees:${c.legacy}` };
    if (c.foreign > 0) return { mode: 'whole_volume', reason: `foreign_worktrees:${c.foreign}` };
    const key = ensureUserSubtreeSync(userId, CODING_WORKSPACE_ROOT); // the mount source must exist
    return { mode: 'user_subtree', key, extraMirrors: c.extraMirrors, reason: `contained:${c.perUser}` };
  } catch {
    return { mode: 'whole_volume', reason: 'census_failed' };
  }
}

/** docker create args for a plan — whole_volume is byte-identical to the pre-ISO args. Pure. */
export function devMountArgs(plan: DevMountPlan): string[] {
  if (plan.mode === 'whole_volume') {
    return [
      // WHOLE-VOLUME mount (cross-tenant visible — see the header; audit
      // 2026-10-06 T7-7: guarded at run_command, not fixed here).
      '-v', `${VOLUME_NAME()}:${CODING_WORKSPACE_ROOT}`,
      // Mask per-session credential homes (PR #359, F2-class): the shared
      // dev container mounts the whole volume and session execs enter it as
      // uid 1001 — the homes' owner. Without this mask every scoped
      // session's ~/.aws/~/.ssh would be readable/poisonable from here.
      '--tmpfs', `${SANDBOX_HOMES_ROOT}:rw,noexec,nosuid,size=64k`,
    ];
  }
  const args = [
    '--mount', `type=volume,source=${VOLUME_NAME()},target=${subtreeRoot(plan.key, CODING_WORKSPACE_ROOT)},volume-subpath=${plan.key}`,
    // Same F2-class mask for the user's own on-volume homes (dev execs use HOME=/tmp).
    '--tmpfs', `${subtreeSandboxHomesRoot(plan.key, CODING_WORKSPACE_ROOT)}:rw,noexec,nosuid,size=64k`,
  ];
  for (const m of plan.extraMirrors) {
    const sub = volumeSubpathOf(m, CODING_WORKSPACE_ROOT);
    if (sub) args.push('--mount', `type=volume,source=${VOLUME_NAME()},target=${m},volume-subpath=${sub}`);
  }
  return args;
}

/** Do a container's mount destinations satisfy the plan? Unknown mounts → true (never churn on uncertainty). Pure. */
export function devMountsMatch(plan: DevMountPlan, dests: string[] | null): boolean {
  if (!dests) return true;
  const whole = dests.includes(CODING_WORKSPACE_ROOT);
  if (plan.mode === 'whole_volume') return whole;
  if (whole) return false;
  return dests.includes(subtreeRoot(plan.key, CODING_WORKSPACE_ROOT)) && plan.extraMirrors.every((m) => dests.includes(m));
}

/** Is any ISO state in play (switch on, or a subtree already on the volume)? Off ⇒ every ISO step is skipped. */
function isoInPlay(): boolean {
  return perUserSubtreeSetting().mode !== 'off' || listSubtreeKeysSync(CODING_WORKSPACE_ROOT).length > 0;
}

/**
 * Quiet-window sweep (worker cron, next to the egress upgrade): recreate a
 * RUNNING dev container whose mounts no longer match its plan (a user became
 * fully contained → subtree-only; the switch went off → whole volume again).
 * Never mid-run (any queued/running run of the user defers it); one
 * `workspace_isolation` dev_mount row per container per pass while ISO is in
 * play. No-op when ISO is not in play. Never throws.
 */
export async function convergeDevContainerMounts(): Promise<void> {
  try {
    if (!isoInPlay()) return;
    if (!(await isDockerAvailable())) return;
    const ls = await docker(['ps', '--filter', `label=${DEV_LABEL}`, '--format', `{{.Names}}\t{{.Label "${DEV_LABEL}"}}`]).catch(() => null);
    if (!ls?.stdout.trim()) return;
    for (const line of ls.stdout.trim().split('\n')) {
      const [name, userId] = line.split('\t');
      if (!name || !userId) continue;
      try {
        if ((await devContainerEnabledTriState(userId)) !== true) continue;
        const plan = await desiredDevMountPlan(userId);
        const dests = await containerMountDestinations(name);
        const meta = { container: name, plan: plan.mode, planReason: plan.reason, extraMirrors: plan.mode === 'user_subtree' ? plan.extraMirrors.length : 0 };
        if (devMountsMatch(plan, dests)) { recordIsolationMetric('dev_mount', { ...meta, outcome: 'match' }); continue; }
        if (await userHasInFlightRun(userId)) { recordIsolationMetric('dev_mount', { ...meta, outcome: 'deferred_in_flight' }); continue; }
        logger.info(`dev-container: ${name} mounts drifted from its plan (${plan.mode}: ${plan.reason}) — recreating in the quiet window`);
        healthyMemo.delete(userId);
        await docker(['rm', '-f', name]).catch(() => {});
        const recreated = await ensureUserDevContainer(userId);
        recordIsolationMetric('dev_mount', { ...meta, outcome: recreated ? 'recreated' : 'recreate_failed' });
      } catch (err: any) {
        logger.warn(`dev-container: mount convergence skipped ${name} (${String(err?.message).slice(0, 100)})`);
      }
    }
  } catch (err: any) {
    logger.warn(`dev-container: mount convergence sweep failed (non-fatal): ${String(err?.message).slice(0, 120)}`);
  }
}

/**
 * Ensure the user's shared dev container is up AND tailnet-joined.
 * Returns the container name on success, null on ANY failure (caller falls
 * back to the per-session container path). Never throws.
 */
export async function ensureUserDevContainer(userId: string): Promise<string | null> {
  try {
    if (!(await devContainerEnabled(userId))) return null;
    if (!(await isDockerAvailable())) return null;
    const name = devContainerName(userId);

    const memoAt = healthyMemo.get(userId);
    if (memoAt !== undefined && Date.now() - memoAt < HEALTH_MEMO_MS) return name;

    if (await isRunning(name)) {
      await ensureDevMemoryCeiling(name); // live-grow legacy containers (db25c401)
      await ensureSessionUser(name);
      healthyMemo.set(userId, Date.now());
      return name;
    }
    // Exists but stopped → start it (persistent ts-state re-joins without a key).
    let exists = await docker(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}']).then(r => r.stdout.trim() === name).catch(() => false);
    // build 2026-10-08 ISO: plan the workspace mounts (whole volume unless the
    // per-user switch applies and the user is fully contained). A STOPPED
    // container whose mounts drifted from the plan is idle by definition —
    // recreate it instead of starting it. ISO not in play ⇒ no inspect.
    const plan: DevMountPlan = isoInPlay() ? await desiredDevMountPlan(userId) : { mode: 'whole_volume', reason: 'switch_off' };
    if (exists && isoInPlay() && !devMountsMatch(plan, await containerMountDestinations(name))) {
      logger.info(`dev-container: stopped ${name} has drifted mounts (${plan.mode}: ${plan.reason}) — recreating instead of starting`);
      await docker(['rm', '-f', name]).catch(() => {});
      exists = false;
    }
    if (exists) {
      await docker(['start', name]);
      await ensureDevMemoryCeiling(name); // live-grow legacy containers (db25c401)
      await markDevGitSafe(name);
      await ensureSessionUser(name);
      healthyMemo.set(userId, Date.now());
      return name;
    }

    const authKey = await getCredentialValueDecrypted(userId, 'tailscale', 'TS_AUTHKEY');
    // Pre-create the ts-state subpath (docker refuses to mount a missing
    // volume subpath — review finding F5: without this the persistent
    // identity NEVER engaged). The backend has the volume mounted at
    // CODING_WORKSPACE_ROOT; if that assumption fails, skip the state mount
    // deliberately and say so.
    let stateMount: string[] = [];
    try {
      await mkdir(join(CODING_WORKSPACE_ROOT, 'devcontainers', userId.slice(0, 12), 'ts-state'), { recursive: true });
      stateMount = ['--mount', `type=volume,source=${VOLUME_NAME()},target=${TS_STATE_DIR},volume-subpath=devcontainers/${userId.slice(0, 12)}/ts-state`];
    } catch (err: any) {
      logger.warn(`dev-container: cannot pre-create ts-state dir (${String(err?.message).slice(0, 100)}) — creating WITHOUT persistent tailnet identity`);
    }
    // Without persisted state AND without a key the container could never
    // join — don't create a useless one.
    if (!authKey && stateMount.length === 0) {
      logger.info(`dev-container: enabled for ${userId.slice(0, 8)} but no auth key and no persisted state — falling back`);
      return null;
    }

    const lockRelease = await acquireCreateLock(userId);
    if (!lockRelease) {
      // Another process is creating it right now — adopt its result.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (await isRunning(name)) { healthyMemo.set(userId, Date.now()); return name; }
        await new Promise(r => setTimeout(r, 2_000));
      }
      return null;
    }
    try {
      // Per-session egress scoping (ticket 4ed6eb2e): the pepper decides the
      // layout AT CREATE TIME — scoped (shim :1055 / tailscaled :1057) when
      // CODING_EGRESS_SECRET is set, legacy v1 verbatim otherwise. Legacy
      // containers already running are upgraded only by the quiet sweep /
      // Settings restart — never mid-run.
      const scoped = !!egressSecret();
      const createArgs = (mountArgs: string[]) => [
        'run', '-d', '--name', name,
        '--label', `${DEV_LABEL}=${userId}`,
        '--init',
        // Container root: tailscaled + install need it. Session execs run as
        // uid 1001 (container.service passes -u for shared targets) — never root.
        // build 2026-10-08 ISO: the workspace mounts come from the plan —
        // whole_volume = the pre-ISO `-v VOLUME:ROOT` + homes tmpfs mask,
        // byte-identical; user_subtree = only `<ROOT>/<userKey>` (+ mirrors).
        ...devMountArgs(plan),
        ...mountArgs,
        '-w', CODING_WORKSPACE_ROOT,
        // 2026-09-10 OOM-herd fix (tickets 15:09/18:07/19:46/21:31): 4g starved
        // concurrent verify legs — oom_kill hit 159/day, SIGKILLed tsc read as
        // red typecheck, and every PR gate wedged fleet-wide. Box C is 32GB
        // with ~26GB page cache; 12g leaves ample host headroom.
        // db25c401 hardening: env-tunable via CODING_DEV_CONTAINER_MEMORY.
        '--memory', DEV_MEMORY(), '--cpus', '4',
        '--network', 'bridge',
        DEV_IMAGE(), 'bash', '-lc', bootScript(scoped, authKey ? 120 : 5),
      ];
      try {
        await docker(createArgs(stateMount), 120_000);
      } catch (err: any) {
        const msg = String(err?.stderr || err?.message || '');
        if (/already in use/i.test(msg)) {
          // Racing creator won — adopt, never destroy (review finding F4).
          if (await isRunning(name)) { healthyMemo.set(userId, Date.now()); return name; }
          return null;
        }
        if (stateMount.length > 0 && /subpath|invalid mount|unknown flag/i.test(msg)) {
          // volume-subpath needs Docker ≥25 — retry once without persistent state.
          logger.warn(`dev-container: state subpath unsupported (${msg.slice(0, 120)}) — retrying without persistent ts-state`);
          await docker(['rm', '-f', name]).catch(() => {});
          if (!authKey) return null; // no state AND no key = can never join
          await docker(createArgs([]), 120_000);
        } else {
          throw err;
        }
      }
      if (authKey) await deliverAuthKey(name, authKey);
      await markDevGitSafe(name);
      // VERIFY the join before reporting usable (review finding F3: running
      // ≠ joined). A keyed container that can't join is torn down so the
      // session falls back to the per-session path instead of a degraded
      // shared box.
      if (authKey && !(await verifyTailnetJoin(name))) {
        logger.warn(`dev-container: ${name} failed to join the tailnet within ${JOIN_VERIFY_TIMEOUT_MS() / 1000}s — removing, falling back to per-session containers`);
        await docker(['rm', '-f', name]).catch(() => {});
        return null;
      }
      // KEYLESS creates are exempt from that teardown (feedback 0bd05198,
      // review B1 on PR #473): with no key the boot script's interactive
      // `tailscale up --timeout=30s` (URL-flow) leaves a login URL in
      // /tmp/ts-up.log for Settings — pending-authorization is a VALID end
      // state, the container is fully usable, and tailnet joins when the
      // owner clicks the link. Tearing down at the keyed window killed the
      // container ~60s before its 120s key wait even reached the elif.
      if (!authKey) {
        // A persisted identity re-joins on its own within seconds — give it
        // a short window, then accept pending-authorization (never rm).
        const joined = await verifyTailnetJoin(name, Math.min(20_000, JOIN_VERIFY_TIMEOUT_MS()));
        if (!joined) logger.info(`dev-container: ${name} created pending URL-flow tailnet authorization (feedback 0bd05198) — login URL surfaces in Settings → Coding`);
      }
      // Egress scoping post-create setup (scoped creates only): support files,
      // per-user default policy, verified shim start, posture + marker. A
      // failure degrades the container to DIRECT posture (unscoped but
      // working) — never tears down a joined container over the shim.
      if (scoped) await setupEgressScoping(name, userId);
      if (isoInPlay()) recordIsolationMetric('dev_mount', { container: name, plan: plan.mode, planReason: plan.reason, extraMirrors: plan.mode === 'user_subtree' ? plan.extraMirrors.length : 0, outcome: 'created' });
      logger.info(`dev-container: created ${name}, tailnet joined${scoped ? ', egress scoping set up' : ' (legacy egress layout)'}${plan.mode === 'user_subtree' ? `, workspace mount = ${plan.key}/ subtree only` : ''}`);
      healthyMemo.set(userId, Date.now());
      return name;
    } finally {
      await lockRelease();
    }
  } catch (err: any) {
    logger.warn(`dev-container: ensure failed for ${userId.slice(0, 8)} (falling back to per-session): ${String(err?.stderr || err?.message).slice(0, 200)}`);
    return null;
  }
}

/** git safe.directory for the shared container (same rationale as container.service markGitSafe). */
async function markDevGitSafe(name: string): Promise<void> {
  await docker(['exec', name, 'git', 'config', '--system', '--add', 'safe.directory', '*']).catch(() => {});
}

/** Live status for the Settings UI. Never throws. */
/**
 * Node identity from `tailscale status --json` (2026-10-13): online, the node
 * key expiry (null when disabled — tagged nodes), ACL tags and whether a
 * login is pending (AuthURL set). Never returns the AuthURL itself. Pure.
 */
export function nodeIdentityFields(j: any): { online?: boolean; keyExpiry: string | null; tags: string[]; loginPending?: boolean } {
  const self = j?.Self ?? {};
  const rawExpiry = typeof self.KeyExpiry === 'string' ? self.KeyExpiry : '';
  // Go's zero time ("0001-01-01T00:00:00Z") means no expiry.
  const keyExpiry = rawExpiry && !rawExpiry.startsWith('0001-') ? rawExpiry : null;
  const tags = Array.isArray(self.Tags) ? self.Tags.filter((t: unknown): t is string => typeof t === 'string') : [];
  const out: { online?: boolean; keyExpiry: string | null; tags: string[]; loginPending?: boolean } = { keyExpiry, tags };
  if (typeof self.Online === 'boolean') out.online = self.Online;
  if (typeof j?.AuthURL === 'string' && j.AuthURL) out.loginPending = true;
  return out;
}

export async function getDevContainerStatus(userId: string): Promise<DevContainerStatus> {
  const enabled = (await devContainerEnabledTriState(userId)) === true;
  const name = devContainerName(userId);
  const keyConfigured = !!(await getCredentialValueDecrypted(userId, 'tailscale', 'TS_AUTHKEY'));
  const out: DevContainerStatus = {
    enabled, running: false, container: name, image: DEV_IMAGE(), tailscale: null, keyConfigured,
    egress: { mode: enabled ? 'legacy' : 'off', shim: null, policyRules: null },
  };
  // Egress posture (ticket 4ed6eb2e): pepper absent → legacy by configuration;
  // pepper present → marker + live probe decide scoped/degraded/legacy.
  const pepper = egressSecret();
  let policyRules: number | null = null;
  try {
    const prefs = await prisma.userPreferences.findUnique({ where: { userId }, select: { devContainerEgressAllow: true } });
    if (prefs?.devContainerEgressAllow) {
      const parsed = JSON.parse(prefs.devContainerEgressAllow);
      if (Array.isArray(parsed)) policyRules = parsed.length;
    }
  } catch { /* policy count is cosmetic — leave null */ }
  out.egress.policyRules = policyRules;
  if (!enabled) { out.egress.mode = 'off'; }
  else if (!pepper) { out.egress.mode = 'legacy'; out.egress.note = 'per-session scoping inactive — CODING_EGRESS_SECRET is not set on the server'; }
  try {
    if (!(await isDockerAvailable())) { out.note = 'container mode is off or docker is unreachable'; return out; }
    out.running = await isRunning(name);
    if (out.running) {
      if (enabled && pepper) {
        const eg = await probeEgressState(name);
        out.egress.shim = eg.shim;
        if (!eg.marker) {
          out.egress.mode = 'legacy';
          out.egress.note = 'pre-scoping container — upgraded automatically in a quiet window, or immediately via Restart';
        } else if (!eg.shim) {
          out.egress.mode = 'degraded';
          out.egress.note = 'egress shim is DOWN — helpers currently bypass it UNSCOPED (direct upstream); the quiet sweep repairs this';
        } else {
          out.egress.mode = 'scoped';
        }
      }
      const st = await docker(['exec', name, 'tailscale', 'status', '--json'], 15_000).catch(() => null);
      if (st) {
        try {
          const j = JSON.parse(st.stdout);
          out.tailscale = {
            state: String(j?.BackendState ?? 'unknown'),
            ip4: Array.isArray(j?.Self?.TailscaleIPs) ? j.Self.TailscaleIPs.find((ip: string) => ip.includes('.')) : undefined,
            hostname: j?.Self?.HostName ? String(j.Self.HostName) : undefined,
            ...nodeIdentityFields(j),
            // Ticket db587fc1: expose the CLI socket + posture proxy ports so
            // an agent can adapt explicitly (tailscale --socket=…, socks5h://…)
            // instead of discovering them when the defaults lag. The socket is
            // tailscaled's compiled-in default — this service never passes
            // --socket. The proxy layout is keyed on the CONTAINER'S ACTUAL
            // layout (egress.mode — decided at create time), NOT the server's
            // current env: a pre-scoping legacy container still listens on
            // 1055/1056 even when CODING_EGRESS_SECRET is now set (review B1).
            // scoped/degraded = scoped layout (daemon SOCKS5 on the
            // undocumented upstream port; the shim owns 1055 there).
            socket: TS_SOCKET_PATH,
            ...(out.egress.mode === 'scoped' || out.egress.mode === 'degraded'
              ? { socks5: `127.0.0.1:${UPSTREAM_PORT}` }
              : { socks5: 'localhost:1055', httpProxy: 'localhost:1056' }),
          };
        } catch { out.tailscale = { state: 'unparseable' }; }
      } else {
        out.tailscale = { state: 'starting' };
      }
      // URL-flow surface (feedback 0bd05198): when the node isn't connected,
      // expose the interactive login URL the boot-time join left in the logs
      // so Settings can offer "click to authorize" — the auth-key-free join
      // path (no 90-day key expiry on re-joins once the node is tagged).
      if (out.tailscale.state !== 'Running') {
        // 2026-10-13: with a saved key the login URL is WITHHELD (only
        // loginPending) — approving it would join the node as the clicking
        // human (personal tailnet permissions, a key expiry); the
        // professional path is Reconnect with the saved tagged key.
        if (keyConfigured) {
          if (out.tailscale.loginPending === undefined) out.tailscale.loginPending = out.tailscale.state === 'NeedsLogin';
        } else {
          const u = await docker(['exec', name, 'sh', '-c', 'grep -hoE "https://login\\.tailscale\\.com/a/[A-Za-z0-9]+" /tmp/ts-up.log /tmp/tailscaled.log 2>/dev/null | tail -1'], 10_000).catch(() => null);
          const loginUrl = u?.stdout?.trim();
          if (loginUrl) { out.tailscale.loginUrl = loginUrl; out.tailscale.loginPending = true; }
        }
      }
    }
  } catch (err: any) {
    out.note = String(err?.message ?? err).slice(0, 160);
  }
  return out;
}

/**
 * Save the per-user default egress policy (Settings UI). Validates first
 * (invalid input is a 400, never stored), stores JSON on user_preferences,
 * then best-effort pushes to the running scoped container so the change is
 * live without a restart. Returns the canonical stored strings.
 */
export async function saveUserEgressPolicy(userId: string, raw: unknown, opts?: { push?: boolean }): Promise<{ allow: string[] | null; pushed: boolean }> {
  if (raw === null) {
    await prisma.userPreferences.upsert({ where: { userId }, update: { devContainerEgressAllow: null }, create: { userId, devContainerEgressAllow: null } });
  } else {
    const v = validatePolicyInput(raw);
    if (!v.rules) throw new Error(v.errors.join('; '));
    const strings = policyToStrings(v.rules);
    await prisma.userPreferences.upsert({ where: { userId }, update: { devContainerEgressAllow: JSON.stringify(strings) }, create: { userId, devContainerEgressAllow: JSON.stringify(strings) } });
  }
  // opts.push === false (2026-10-13): the caller has no Docker here and pushes
  // on the coding server instead (dev-container-remote.ts) — the DB write is
  // the same everywhere.
  const pushed = opts?.push === false ? false : await pushUserEgressPolicyNow(userId);
  const prefs = await prisma.userPreferences.findUnique({ where: { userId }, select: { devContainerEgressAllow: true } });
  const stored = prefs?.devContainerEgressAllow ? (JSON.parse(prefs.devContainerEgressAllow) as string[]) : null;
  return { allow: stored, pushed };
}

/** Push the stored per-user default policy into the running scoped container
 *  now (best-effort; false = nothing pushed). Runs where Docker is. */
export async function pushUserEgressPolicyNow(userId: string): Promise<boolean> {
  try {
    const name = devContainerName(userId);
    if (egressSecret() && (await isRunning(name))) {
      await pushDefaultPolicy(name, userId);
      return true;
    }
  } catch { /* container push is best-effort; the next create/sweep converges */ }
  return false;
}

/** Read the per-user default policy for the Settings UI (null = allow-all). */
export async function getUserEgressPolicy(userId: string): Promise<{ allow: string[] | null }> {
  const prefs = await prisma.userPreferences.findUnique({ where: { userId }, select: { devContainerEgressAllow: true } }).catch(() => null);
  if (!prefs?.devContainerEgressAllow) return { allow: null };
  try {
    const parsed = JSON.parse(prefs.devContainerEgressAllow);
    return { allow: Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : null };
  } catch { return { allow: null }; }
}

/**
 * Save a per-SESSION egress override (ticket 4ed6eb2e — the literal
 * per-session ACL). null clears it (session inherits the user default).
 * Ownership is enforced by the caller (404s for other users' sessions). After
 * saving, the session's cred file on the running container is refreshed
 * immediately (deterministic content — safe from any process).
 */
export async function saveSessionEgressOverride(sessionId: string, raw: unknown, opts?: { refresh?: boolean }): Promise<{ allow: string[] | null; refreshed: boolean }> {
  if (raw === null) {
    await prisma.chatCodingState.update({ where: { id: sessionId }, data: { tailnetEgressAllow: null } });
  } else {
    const v = validatePolicyInput(raw);
    if (!v.rules) throw new Error(v.errors.join('; '));
    const strings = policyToStrings(v.rules);
    await prisma.chatCodingState.update({ where: { id: sessionId }, data: { tailnetEgressAllow: JSON.stringify(strings) } });
  }
  const refreshed = opts?.refresh === false ? false : await refreshSessionEgressNow(sessionId);
  const stored = await prisma.chatCodingState.findUnique({ where: { id: sessionId }, select: { tailnetEgressAllow: true } });
  return { allow: stored?.tailnetEgressAllow ? (JSON.parse(stored.tailnetEgressAllow) as string[]) : null, refreshed };
}

/** Refresh one session's egress grant on the running container now
 *  (best-effort; false = nothing refreshed). Runs where Docker is. */
export async function refreshSessionEgressNow(sessionId: string): Promise<boolean> {
  try {
    const row = await prisma.chatCodingState.findUnique({ where: { id: sessionId }, select: { userId: true } });
    if (row?.userId) {
      const name = devContainerName(row.userId);
      if (egressSecret() && (await isRunning(name))) {
        return !!(await ensureSessionEgressGrant(sessionId, name));
      }
    }
  } catch { /* refresh is best-effort; the next run-resolve converges */ }
  return false;
}

/** Any queued/running agent run for this user's coding sessions? */
async function userHasInFlightRun(userId: string): Promise<boolean> {
  try {
    const sessions = await prisma.chatCodingState.findMany({ where: { userId }, select: { id: true } });
    if (sessions.length === 0) return false;
    const n = await prisma.agentRun.count({
      where: { sessionId: { in: sessions.map(s => s.id) }, status: { in: ['queued', 'running'] } },
    });
    return n > 0;
  } catch {
    return true; // unknown → assume busy (don't destroy under a possible run)
  }
}

/** Recreate from scratch (Settings 'Restart' button): rm + fresh ensure.
 *  Refuses while a run is in flight — rm -f under a live exec kills it opaquely. */
/**
 * Which of the user's coding sessions have a queued/running run (2026-10-13):
 * the full Restart's refusal names them so the owner knows what to stop.
 * null = could not read (callers treat as busy, like userHasInFlightRun).
 */
export async function inFlightRunSummary(userId: string): Promise<{ count: number; titles: string[] } | null> {
  try {
    const sessions = await prisma.chatCodingState.findMany({ where: { userId }, select: { id: true, title: true } });
    if (sessions.length === 0) return { count: 0, titles: [] };
    const runs = await prisma.agentRun.findMany({
      where: { sessionId: { in: sessions.map(s => s.id) }, status: { in: ['queued', 'running'] } },
      select: { sessionId: true },
    });
    const busy = new Set(runs.map(r => r.sessionId));
    const titles = sessions.filter(s => busy.has(s.id)).map(s => String(s.title || 'Untitled session'));
    return { count: runs.length, titles };
  } catch {
    return null;
  }
}

/** Plain-words refusal for a full Restart while runs are in flight. Pure. */
export function inFlightRestartNote(summary: { count: number; titles: string[] } | null): string {
  const hint = 'Stop them first, or use Reconnect — it rejoins the tailnet without interrupting running work.';
  if (!summary) return `Couldn't check for running coding work, so the container was not rebuilt. ${hint}`;
  const shown = summary.titles.slice(0, 3).map(t => `“${t.length > 60 ? `${t.slice(0, 57)}…` : t}”`);
  const more = summary.titles.length > 3 ? ` and ${summary.titles.length - 3} more` : '';
  const runs = summary.count === 1 ? '1 coding run is' : `${summary.count} coding runs are`;
  return `${runs} still going${shown.length ? ` (${shown.join(', ')}${more})` : ''}, so the container was not rebuilt. ${hint}`;
}

export async function restartUserDevContainer(userId: string): Promise<DevContainerStatus> {
  try {
    if (await userHasInFlightRun(userId)) {
      const st = await getDevContainerStatus(userId);
      st.note = inFlightRestartNote(await inFlightRunSummary(userId));
      return st;
    }
    healthyMemo.delete(userId);
    await docker(['rm', '-f', devContainerName(userId)]).catch(() => {});
    await ensureUserDevContainer(userId);
  } catch (err: any) {
    logger.warn(`dev-container: restart failed for ${userId.slice(0, 8)}: ${err?.message}`);
  }
  return getDevContainerStatus(userId);
}

/**
 * Bounce ONLY tailscaled inside the user's dev container (platform task
 * 2026-08-28, tailnet session-recourse). MID-RUN-SAFE by design — unlike
 * restartUserDevContainer it neither removes the container nor touches the
 * session's exec processes, so there is deliberately NO in-flight-run guard:
 * the intended use is a wedged tailnet path mid-run (in-flight ssh sessions
 * die with the daemon, but a dead path has none worth keeping). Recourse for
 * the 2026-08-28 incident class — a session blocked on a stale tailnet relay
 * can rule out its own end without root (kill on the platform-owned pid was
 * EPERM from uid 1001).
 *
 * One root exec does the bounce, posture-agnostically: capture the live
 * tailscaled cmdline, TERM it (KILL if it survives 3s), then let the boot
 * script's respawn loop win when present — only re-exec when nothing came
 * back (legacy pre-loop containers), preferring the captured cmdline so
 * scoped/legacy postures restart with their original flags. The re-join is
 * then verified (BackendState Running) with the same env-tunable knobs as
 * ensure(). The egress shim (scoped posture) is untouched: it re-connects to
 * the fresh upstream automatically.
 */
export async function restartDevTailnet(userId: string): Promise<DevContainerStatus> {
  const name = devContainerName(userId);
  const finish = async (note: string): Promise<DevContainerStatus> => {
    const st = await getDevContainerStatus(userId);
    st.note = note;
    return st;
  };
  try {
    if (!(await devContainerEnabled(userId))) return finish('dev container is not enabled for this account — nothing to restart');
    if (!(await isDockerAvailable()) || !(await isRunning(name))) return finish('dev container is not running — use the full dev-container Restart instead');
    const fallbackCmd = egressSecret()
      ? `tailscaled --tun=userspace-networking --statedir=${TS_STATE_DIR} --socks5-server=127.0.0.1:${UPSTREAM_PORT}`
      : `tailscaled --tun=userspace-networking --statedir=${TS_STATE_DIR} --socks5-server=localhost:1055 --outbound-http-proxy-listen=localhost:1056`;
    // Shell (root exec): capture "pid cmdline" → TERM → 3s → KILL survivor →
    // if the boot respawn loop already brought a fresh daemon up, done
    // ("respawned"); else re-exec the captured line (or the posture fallback
    // when no daemon was running at all). $CMD word-splits back into argv.
    // The /proc scan is safe from self-matches: case patterns are anchored,
    // and the sh -c cmdline begins with "sh", not "tailscaled".
    const script = [
      'LIVE=$(for p in /proc/[0-9]*; do c=$(tr \'\\0\' \' \' < "$p/cmdline" 2>/dev/null); case "$c" in tailscaled*--tun*) echo "${p#/proc/} $c"; break;; esac; done)',
      'PID=${LIVE%% *}; CMD=${LIVE#* }',
      'if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; fi',
      'sleep 3',
      'if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then kill -9 "$PID" 2>/dev/null || true; fi',
      'AGAIN=$(for p in /proc/[0-9]*; do c=$(tr \'\\0\' \' \' < "$p/cmdline" 2>/dev/null); case "$c" in tailscaled*--tun*) echo x; break;; esac; done)',
      `if [ -z "$AGAIN" ]; then if [ -n "$CMD" ] && [ "$CMD" != "$PID" ]; then (nohup $CMD >>/tmp/tailscaled.log 2>&1 &); else (nohup ${fallbackCmd} >>/tmp/tailscaled.log 2>&1 &); fi; echo reexec; else echo respawned; fi`,
    ].join('\n');
    const res = await docker(['exec', name, 'sh', '-c', script], 30_000);
    // Verify the re-join with the same knobs ensure() uses.
    const deadline = Date.now() + JOIN_VERIFY_TIMEOUT_MS();
    let joined = false;
    while (Date.now() < deadline) {
      const st = await docker(['exec', name, 'tailscale', 'status', '--json'], 15_000).catch(() => null);
      if (st) {
        try {
          if (String(JSON.parse(st.stdout)?.BackendState ?? '') === 'Running') { joined = true; break; }
        } catch { /* keep polling */ }
      }
      await new Promise((r) => setTimeout(r, JOIN_VERIFY_POLL_MS()));
    }
    logger.info(`dev-container: tailnet bounce for ${userId.slice(0, 8)} — ${String(res.stdout).trim() || 'no-output'}, joined=${joined}`);
    return finish(joined
      ? 'tailscaled restarted and re-joined (Running)'
      : 'tailscaled restarted but did not reach Running within the verify window — check /tmp/tailscaled.log in the container');
  } catch (err: any) {
    logger.warn(`dev-container: tailnet bounce failed for ${userId.slice(0, 8)}: ${err?.message}`);
    return finish(`tailnet restart failed: ${String(err?.message ?? err).slice(0, 140)}`);
  }
}

// ── Reconnect with the saved key (2026-10-13, owner: "properly configure it") ──
// The stored TS_AUTHKEY reaches a container only at CREATE; a running container
// whose node key expired (a URL-flow node past its expiry) sits in NeedsLogin
// and the saved key is never used. Reconnect re-joins THAT container with the
// saved key — mid-run safe like restartDevTailnet: it neither removes the
// container nor touches session execs.

export type ReconnectOutcome =
  | 'joined' | 'not_enabled' | 'not_running' | 'no_key'
  | 'invalid_key' | 'tags_not_permitted' | 'key_expired' | 'timeout' | 'failed';

const RECONNECT_UP_TIMEOUT_SEC = 60;

/** Plain-words note per outcome (shown in Settings). Pure. */
export function reconnectNote(outcome: ReconnectOutcome): string {
  switch (outcome) {
    case 'joined': return 'Reconnected — the container rejoined your tailnet with the saved key.';
    case 'not_enabled': return 'The dev container is not enabled for this account.';
    case 'not_running': return 'The dev container is not running — use Restart to rebuild it with the saved key.';
    case 'no_key': return 'No Tailscale auth key is saved. Save a tagged, reusable auth key first, then press Reconnect.';
    case 'invalid_key': return 'Tailscale rejected the saved key (invalid, revoked, or a one-time key already used). Create a new reusable, tagged auth key, save it, and press Reconnect.';
    case 'tags_not_permitted': return "Tailscale refused the key's tags — your tailnet policy must let the key's creator own that tag (tagOwners). Fix the policy or create the key with an allowed tag, then press Reconnect.";
    case 'key_expired': return 'The saved auth key has expired. Create a new reusable, tagged auth key, save it, and press Reconnect.';
    case 'timeout': return "The container didn't finish joining the tailnet in time. Check that the key is valid and press Reconnect again.";
    default: return "The container couldn't rejoin the tailnet. Try Reconnect again; if it keeps failing, save a new tagged auth key.";
  }
}

/**
 * The in-container join script (root exec). Reads the staged key through
 * tailscale's `--auth-key=file:` form, so the key never touches argv; the
 * trap deletes the key file and the log on every exit path; a failure is
 * classified INSIDE the container and only a token is printed — tailscale's
 * own output (which can carry a login URL) never leaves it. Pure.
 */
export function reconnectScript(): string {
  return [
    `F=${RECONNECT_KEY_PATH}`,
    `L=/tmp/ts-reconnect.log`,
    `trap 'rm -f "$F" "$L"' EXIT`,
    'if [ ! -s "$F" ]; then echo "DIGBY_RECONNECT rc=99 class=no_key"; exit 0; fi',
    `tailscale up --reset --auth-key="file:$F" --hostname=digby-dev --accept-dns=false --force-reauth --timeout=${RECONNECT_UP_TIMEOUT_SEC}s >"$L" 2>&1; rc=$?`,
    'rm -f "$F"',
    'cls=ok',
    'if [ $rc -ne 0 ]; then',
    "  if grep -qiE 'requested tags|not permitted|tagowners' \"$L\"; then cls=tags_not_permitted",
    "  elif grep -qiE 'expired' \"$L\"; then cls=key_expired",
    "  elif grep -qiE 'invalid key|not valid|unable to validate|key not found|invalid auth|unauthorized' \"$L\"; then cls=invalid_key",
    "  elif grep -qiE 'timeout|timed out|deadline exceeded' \"$L\"; then cls=timeout",
    '  else cls=failed; fi',
    'fi',
    'echo "DIGBY_RECONNECT rc=$rc class=$cls"',
  ].join('\n');
}

const RECONNECT_CLASSES: Record<string, ReconnectOutcome> = {
  ok: 'joined', no_key: 'no_key', invalid_key: 'invalid_key', tags_not_permitted: 'tags_not_permitted',
  key_expired: 'key_expired', timeout: 'timeout', failed: 'failed',
};

/** Parse the script's one token line → outcome (null = no token). Pure. */
export function parseReconnectOutput(stdout: string): ReconnectOutcome | null {
  const m = /DIGBY_RECONNECT rc=\d+ class=([a-z_]+)/.exec(String(stdout || ''));
  if (!m) return null;
  return RECONNECT_CLASSES[m[1]] ?? 'failed';
}

/**
 * Rejoin the user's RUNNING dev container to the tailnet with the saved key.
 * Delivery is the create path's: stdin → root-owned 0600 file (never host
 * argv/env/logs), at a separate path the boot script never reads. Verified
 * (BackendState Running) with the same knobs as ensure().
 */
export async function reconnectDevTailnet(userId: string): Promise<{ outcome: ReconnectOutcome; status: DevContainerStatus }> {
  const name = devContainerName(userId);
  const finish = async (outcome: ReconnectOutcome): Promise<{ outcome: ReconnectOutcome; status: DevContainerStatus }> => {
    const status = await getDevContainerStatus(userId);
    status.note = reconnectNote(outcome);
    return { outcome, status };
  };
  try {
    if (!(await devContainerEnabled(userId))) return finish('not_enabled');
    if (!(await isDockerAvailable()) || !(await isRunning(name))) return finish('not_running');
    const key = await getCredentialValueDecrypted(userId, 'tailscale', 'TS_AUTHKEY');
    if (!key) return finish('no_key');
    let outcome: ReconnectOutcome;
    try {
      await deliverAuthKey(name, key, RECONNECT_KEY_PATH);
      const r = await docker(['exec', name, 'sh', '-c', reconnectScript()], (RECONNECT_UP_TIMEOUT_SEC + 30) * 1000)
        .catch((err: any) => ({ stdout: String(err?.stdout ?? ''), stderr: '' }));
      outcome = parseReconnectOutput(r.stdout) ?? 'failed';
    } finally {
      // Belt and braces: a killed exec skips the trap — the key file must not outlive the attempt.
      await docker(['exec', name, 'rm', '-f', RECONNECT_KEY_PATH], 15_000).catch(() => {});
    }
    if (outcome === 'joined' || outcome === 'failed') {
      // Trust the daemon, not the CLI's exit code: Running = joined.
      outcome = (await verifyTailnetJoin(name)) ? 'joined' : (outcome === 'joined' ? 'timeout' : 'failed');
    }
    healthyMemo.delete(userId);
    logger.info(`dev-container: tailnet reconnect for ${userId.slice(0, 8)} — ${outcome}`);
    return finish(outcome);
  } catch (err: any) {
    logger.warn(`dev-container: tailnet reconnect failed for ${userId.slice(0, 8)}: ${String(err?.message ?? err).slice(0, 140)}`);
    return finish('failed');
  }
}

/**
 * Reap dev containers whose owner EXPLICITLY disabled the feature — called
 * from the worker's container-reaper cron. Tri-state: an unknown preference
 * (DB error) is SKIPPED, never treated as disabled; and a user with an
 * in-flight run is skipped this pass (rm -f would brick the run).
 */
export async function reapDisabledDevContainers(): Promise<void> {
  try {
    if (!(await isDockerAvailable())) return;
    const ls = await docker(['ps', '-a', '--filter', `label=${DEV_LABEL}`, '--format', `{{.Names}}\t{{.Label "${DEV_LABEL}"}}`]).catch(() => null);
    if (!ls?.stdout.trim()) return;
    for (const line of ls.stdout.trim().split('\n')) {
      const [name, userId] = line.split('\t');
      if (!name || !userId) continue;
      const enabled = await devContainerEnabledTriState(userId);
      if (enabled !== false) continue;           // enabled or UNKNOWN → keep
      if (await userHasInFlightRun(userId)) continue; // run in flight → next pass
      await docker(['rm', '-f', name]).catch(() => {});
      logger.info(`dev-container: reaped ${name} (feature disabled)`);
    }
  } catch (err: any) {
    logger.warn(`dev-container: reap sweep failed (non-fatal): ${err?.message}`);
  }
}

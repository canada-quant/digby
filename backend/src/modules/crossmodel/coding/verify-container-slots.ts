/**
 * build 2026-10-09 VS — per-CONTAINER verify-chain concurrency (a Redis counting semaphore).
 *
 * The incident (box C, 2026-10-09). Every one of the owner's coding lanes runs in ONE shared dev
 * container (`digby-dev-<uid12>`, dev-container.service; its memory cgroup cap is host-derived,
 * ≈ 22.8 GiB on box C). Several lanes — ticket lanes and project lanes — ran this repo's verify
 * chain (a cold `tsc --noEmit` ≈ 2.5 GB, a jest tree of main + 2 workers) at the same time inside
 * it: the container sat at 15.4 GiB / 405 % CPU with load 12–20, and the kernel's MEMORY-CGROUP
 * OOM killer took ~2.5 GB node processes at 17:30, 19:21 and 19:24Z. The lanes then read
 * "[ENVIRONMENTAL] stage terminated without an exit code (the wrapper shell died …)" reds and
 * "Tool "verify" exceeded 900s and was aborted", and the harness filed "3× tool-failure streak:
 * verify …" tickets. What the shipped defenses do not cover:
 *   · verify-limiter.ts (ticket 6bf8ce36) is PER PROCESS (VERIFY_GATE_CONCURRENCY, 2) — box C runs
 *     the live worker PLUS up to WORKER_MAX_DRAINERS (4) parked drainers during deploy waves
 *     (scripts/deploy/deploy-coding-worker.sh), each with its own 2;
 *   · the 7fbc34cd pre-flight reads HOST memory, and the cgroup pre-flight fires only at ≥ 92 %:
 *     both are point-in-time reads taken BEFORE a cold chain allocates its gigabytes, so N chains
 *     that start together all read "healthy" and then OOM together.
 * The binding limit is the CONTAINER's cgroup cap and the number of concurrent verify chains in it.
 *
 * What this adds. Before a chain runs, ONE probe round-trip inside the chain's own shell reads the
 * container identity (/etc/hostname — docker's container id; no create path here sets --hostname)
 * and its cgroup memory cap; a Redis ZSET semaphore keyed by that container then admits at most
 * `verifySlotsForCap(cap)` chains at once ACROSS every worker process (FIFO queue, lease-based):
 *   · a holder's lease (VERIFY_SLOT_LEASE_MS) is renewed by a heartbeat, so a crashed holder frees
 *     its slot within the lease; the slot is released in `finally`;
 *   · a waiter re-touches its queue entry every poll, so a crashed waiter leaves the line within
 *     VERIFY_SLOT_WAITER_STALE_MS and never blocks the queue;
 *   · a chain holds ONE slot for its whole run — a chain runs one stage at a time, so a slot is one
 *     stage's peak memory, and a chain never re-queues between its own stages.
 *
 * Slot math (`verifySlotsForCap`): floor(cap × (1 − 25 % headroom) / 5 GiB), clamped to [1, 4].
 *   5 GiB per stage — from what 8fa33b39 (ticket 7fbc34cd) sets and measured: every leg now really
 *   exports NODE_OPTIONS=--max-old-space-size=4096 (≤ 4 GiB of V8 old space per node process; RSS
 *   adds young gen + code + native buffers), a cold `tsc --noEmit` of this repo needs > 2042 MB
 *   (it dies under a 2048 cap, exits 0 under 4096 — ≈ 2.5 GB RSS, the size of the processes the
 *   OOM killer took), and the test stage is a jest main process (~1 GB haste map over ~1,100 test
 *   files) plus 2 workers (`--maxWorkers=2` in .digby/config.json) recycled at 1 GB IDLE
 *   (workerIdleMemoryLimit) but free to grow past it mid-suite (~2 GB each) ⇒ ≈ 5 GB.
 *   25 % headroom — the container is not verify-only: the same lanes run their own run_command
 *   builds / tests (another cold tsc is ≈ 2.5 GB), git, dev servers, and memory.max counts page
 *   cache; 25 % of 22.8 GiB ≈ 5.7 GiB ≈ two ad-hoc tsc runs.
 *   Box C's dev container: floor(22.8 × 0.75 / 5) = 3. The 12 GiB floor container: 1. A scoped
 *   per-session container (a few GiB, one session): 1 — it only serialises a session's own parallel
 *   delegate verifies, which could not both fit in it anyway. No cap ('max') ⇒ no limit.
 *
 * The bounded wait (VERIFY_SLOT_MAX_WAIT_MS, 10 min) then DEFERS, it does not run anyway: a chain
 * still waiting after 10 min means `slots` chains are running in that container right now, so
 * running on top is exactly the incident (the OOM killer then takes the largest node process —
 * often a PEER lane's tsc — turning one lane's wait into another lane's environmental red). The
 * deferral reuses the v1#30 hollow-pass semantics every consumer already understands (passed +
 * unverified + a `deferred` stage: no fix-loop burn, no green check, not a tool-failure shape, so
 * no streak ticket), and it hands the lane its turn back at once — the run keeps flowing.
 *
 * The wait is never charged to the run: every queued millisecond (this wait AND the per-process
 * FIFO wait in front of it) is reported to `onQueuedWait` as it accrues, which agent.ts adds to the
 * run deadline and — for the `verify` tool — to that call's hard timer (tool-hard-timeout.ts), so a
 * merely-queued verify is never answered "exceeded 900s and was aborted". The chain's per-command
 * timeouts start only once the slot is held.
 *
 * Fail-OPEN everywhere: no REDIS_URL / a client that is not ready / any Redis error or 3 s timeout
 * / an unreadable probe ⇒ the chain runs exactly as before. Telemetry: ONE loop_metrics
 * `verify_slot_wait` row per gated chain (outcome immediate | acquired | timeout | fail_open |
 * no_limit). Kill switch VERIFY_SLOT_LIMIT_DISABLED=1 restores today's path byte-for-byte (the
 * per-process FIFO only; no probe, no Redis, no rows, no queue-time shielding).
 */

import * as os from 'os';
import { randomUUID } from 'crypto';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { withVerifySlot } from './verify-limiter';
import type { VerifyResult } from './verify.service';

type ExecShell = (command: string, cwd?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;

const GiB = 1024 ** 3;
/** Peak memory of ONE verify stage of this repo's chain (see the header for the derivation). */
export const VERIFY_STAGE_PEAK_BYTES = 5 * GiB;
/** Share of the container cap kept for the lanes' non-verify work (their own builds / tests, git, dev servers). */
export const VERIFY_SLOT_HEADROOM = 0.25;
export const VERIFY_SLOTS_MIN = 1;
export const VERIFY_SLOTS_MAX = 4;
/** A holder's lease; the heartbeat renews it, so only a CRASHED holder ever lets it lapse. */
export const VERIFY_SLOT_LEASE_MS = 90_000;
export const VERIFY_SLOT_HEARTBEAT_MS = 30_000;
/** How often a waiter re-asks (and re-touches its place in line). */
export const VERIFY_SLOT_POLL_MS = 5_000;
/** A waiter not seen for this long left the line (crashed / cancelled) and is pruned. */
export const VERIFY_SLOT_WAITER_STALE_MS = 30_000;
/** Bounded wait, then the chain is DEFERRED (see the header for why not "run anyway"). */
export const VERIFY_SLOT_MAX_WAIT_MS = 10 * 60_000;
/** Idle expiry of the three keys (every acquire / renew / poll pushes it out). */
export const VERIFY_SLOT_KEY_TTL_MS = 30 * 60_000;
/** One Redis round-trip; past it the call is treated as an outage (fail-open). */
export const VERIFY_SLOT_REDIS_TIMEOUT_MS = 3_000;
export const VERIFY_SLOT_PROBE_TIMEOUT_MS = 15_000;
/** The process-FIFO wait is reported to onQueuedWait in increments this size (the hard timer reads them live). */
const QUEUE_TICK_MS = 15_000;
const PROGRESS_EVERY_MS = 60_000;

/** Kill switch: restores the per-process FIFO alone (today's path, byte-for-byte). */
export function verifySlotLimitDisabled(): boolean {
  return process.env.VERIFY_SLOT_LIMIT_DISABLED === '1';
}

/** How many verify chains a container with this memory cap may run at once. */
export function verifySlotsForCap(capBytes: number): number {
  const n = Math.floor((capBytes * (1 - VERIFY_SLOT_HEADROOM)) / VERIFY_STAGE_PEAK_BYTES);
  return Math.min(VERIFY_SLOTS_MAX, Math.max(VERIFY_SLOTS_MIN, Number.isFinite(n) ? n : VERIFY_SLOTS_MIN));
}

/** ONE round-trip inside the chain's own shell: the container identity + its cgroup memory cap (v2, then v1). */
export const VERIFY_SLOT_PROBE = 'echo "__VSLOT__ $(cat /etc/hostname 2>/dev/null || hostname 2>/dev/null || echo x) $(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo x)"';

export interface VerifySlotProbe { container: string; capBytes: number | null }

/** Parse the probe line. null = no usable identity (fail-open); capBytes null = no cap known ('max', unreadable, the v1 ~2^63 sentinel). */
export function parseVerifySlotProbe(stdout: string): VerifySlotProbe | null {
  const m = /__VSLOT__\s+(\S+)\s+(\S+)/.exec(stdout || '');
  if (!m) return null;
  const container = m[1];
  if (container === 'x' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) return null;
  const raw = m[2];
  const cap = Number(raw);
  const capBytes = raw !== 'max' && raw !== 'x' && Number.isFinite(cap) && cap > 0 && cap < 2 ** 60 ? cap : null;
  return { container, capBytes };
}

// ── Redis scripts (atomic; the clock is the SERVER's TIME, so worker processes never disagree) ─────────────
// KEYS = [holders ZSET (score = lease expiry ms), queue ZSET (score = arrival ms), seen ZSET (score = last poll ms)].
// Validated against a real Lua interpreter (fakeredis + lupa) when written; the jest fake mirrors these semantics.

/** ARGV = token, limit, leaseMs, waiterStaleMs, keyTtlMs, enqueue('1'|'0') → {admitted 0|1, holders, position}. */
export const VERIFY_SLOT_ACQUIRE_LUA = `-- verify-slot:acquire
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit = tonumber(ARGV[2])
local keyTtl = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local stale = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now - tonumber(ARGV[4]))
for _, w in ipairs(stale) do
  redis.call('ZREM', KEYS[2], w)
  redis.call('ZREM', KEYS[3], w)
end
local held = redis.call('ZCARD', KEYS[1])
local ahead = redis.call('ZRANK', KEYS[2], ARGV[1])
if not ahead then ahead = redis.call('ZCARD', KEYS[2]) end
if held + ahead < limit then
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[3], ARGV[1])
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
  redis.call('PEXPIRE', KEYS[1], keyTtl)
  return {1, held + 1, 0}
end
if ARGV[6] == '1' then
  if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then redis.call('ZADD', KEYS[2], now, ARGV[1]) end
  redis.call('ZADD', KEYS[3], now, ARGV[1])
  redis.call('PEXPIRE', KEYS[2], keyTtl)
  redis.call('PEXPIRE', KEYS[3], keyTtl)
end
return {0, held, ahead + 1}`;

/** ARGV = token, leaseMs, keyTtlMs. Re-asserts the lease unconditionally: a holder that is still running COUNTS,
 *  even if a Redis blip let its lease lapse (honest accounting — newcomers then wait for it). */
export const VERIFY_SLOT_RENEW_LUA = `-- verify-slot:renew
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1`;

/** ARGV = token. Leaves every structure (release AND abandoning the line). */
export const VERIFY_SLOT_RELEASE_LUA = `-- verify-slot:release
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1`;

/** The slice of the node-redis v4 client this module uses (tests inject a fake). */
export interface VerifySlotRedis {
  isReady?: boolean;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

let redisOverride: VerifySlotRedis | null | undefined;
/** Test seam: a fake client (or null = "no Redis"); undefined restores the real lookup. */
export function __setVerifySlotRedisForTest(client: VerifySlotRedis | null | undefined): void { redisOverride = client; }

function slotRedis(): VerifySlotRedis | null {
  if (redisOverride !== undefined) return redisOverride;
  // No REDIS_URL ⇒ no cross-process semaphore — and config/redis (whose config/env import process.exits on a
  // missing var) is never loaded, so the env-free suites that reach the verify tool stay env-free. Lazy require:
  // the project-lock.ts idiom.
  if (!process.env.REDIS_URL) return null;
  try {
    const client = require('../../../config/redis').default as VerifySlotRedis | undefined;
    // node-redis queues commands while disconnected — a not-ready client would hang the chain: fail open instead.
    return client && client.isReady === true && typeof client.eval === 'function' ? client : null;
  } catch {
    return null;
  }
}

export function verifySlotKeys(container: string): [string, string, string] {
  const base = `verify-slots:{${container}}`; // hash tag: the three keys share a cluster slot
  return [`${base}:holders`, `${base}:queue`, `${base}:seen`];
}

async function evalBounded(client: VerifySlotRedis, script: string, keys: string[], args: string[]): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.eval(script, { keys, arguments: args }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`redis call exceeded ${VERIFY_SLOT_REDIS_TIMEOUT_MS}ms`)), VERIFY_SLOT_REDIS_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface AcquireReply { admitted: boolean; holders: number; position: number }
function parseAcquireReply(reply: unknown): AcquireReply {
  if (!Array.isArray(reply) || reply.length < 3) throw new Error(`unexpected acquire reply ${JSON.stringify(reply)?.slice(0, 80)}`);
  const [a, h, p] = reply.map(Number);
  if (![a, h, p].every(Number.isFinite)) throw new Error(`unexpected acquire reply ${JSON.stringify(reply).slice(0, 80)}`);
  return { admitted: a === 1, holders: h, position: p };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface VerifyGateHooks {
  /** 'tool' = the agent-callable verify (and the open_pull_request auto-verify); 'auto' = the harness finish auto-verify. */
  seam: 'tool' | 'auto';
  sessionId?: string;
  runId?: string | null;
  /** A status line for the live run ("Waiting for a verify slot — …"). */
  progress: (message: string) => void;
  /** Queued time (not the run's work), reported AS IT ACCRUES: the caller leaves it out of the run deadline and the
   *  tool's hard timer. Only called with the limiter on. */
  onQueuedWait?: (ms: number) => void;
}

function reportQueued(hooks: VerifyGateHooks, ms: number): void {
  if (!(ms > 0)) return;
  try { hooks.onQueuedWait?.(ms); } catch { /* the shield is best-effort */ }
}

function progress(hooks: VerifyGateHooks, message: string): void {
  try { hooks.progress(message); } catch { /* a status-line failure must never cost the slot */ }
}

function note(hooks: VerifyGateHooks, waitedMs: number, meta: Record<string, unknown>): void {
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.VERIFY_SLOT_WAIT,
      sessionId: hooks.sessionId,
      runId: hooks.runId ?? undefined,
      value: Math.max(0, Math.round(waitedMs)),
      unit: 'ms',
      meta: { seam: hooks.seam, waitedMs: Math.max(0, Math.round(waitedMs)), ...meta },
    });
  } catch { /* telemetry never takes the verify path down */ }
}

/** The DEFERRED result after the bounded wait (v1#30 hollow pass: passed + unverified + a deferred stage). */
export function verifySlotsBusyResult(d: { holders: number; slots: number; capGiB: number; waitedMs: number; position: number }): VerifyResult {
  const min = Math.max(1, Math.round(d.waitedMs / 60_000));
  return {
    passed: true, ran: false, unverified: true, failedStage: null,
    stages: [{
      key: 'verify_slots', command: '', exitCode: 0, passed: true, skipped: true, deferred: true,
      outputTail: `[DEFERRED — verify slots busy] ${d.holders} verify chain(s) are already running in this container (limit ${d.slots}, derived from its ${d.capGiB} GiB memory cap at ~5 GiB per stage) and no slot freed within ${min} min of waiting (position ${d.position} in line). Running a cold typecheck/test chain on top would push the container's memory cgroup past its cap — the OOM killer then SIGKILLs the largest node process, often a PEER lane's (the "stage terminated without an exit code" environmental class). The chain did NOT run: this is neither a pass nor a failure. Do NOT edit code in response; run verify again in a few minutes (or finish other work first). Ops: kill switch VERIFY_SLOT_LIMIT_DISABLED=1.`,
    }],
  };
}

/**
 * Run `run` (one verify chain) holding a slot of the container the chain's shell runs in. Fail-open on every
 * error; DEFERS (never runs) after VERIFY_SLOT_MAX_WAIT_MS in line. Never throws on its own account — an error
 * thrown by `run` itself propagates exactly as before (the slot is released first).
 */
export async function withContainerVerifySlot(
  execShell: ExecShell, worktree: string, hooks: VerifyGateHooks, run: () => Promise<VerifyResult>,
): Promise<VerifyResult> {
  if (verifySlotLimitDisabled()) return run();
  const client = slotRedis();
  if (!client) return run();

  const probeOut = await execShell(VERIFY_SLOT_PROBE, worktree, VERIFY_SLOT_PROBE_TIMEOUT_MS).catch(() => null);
  const probe = parseVerifySlotProbe(probeOut?.stdout || '');
  if (!probe || probe.capBytes === null) {
    note(hooks, 0, { outcome: 'no_limit', reason: probe ? 'no_memory_cap' : 'probe_unreadable', container: probe?.container ?? null });
    return run();
  }
  const slots = verifySlotsForCap(probe.capBytes);
  const capGiB = round1(probe.capBytes / GiB);
  const keys = verifySlotKeys(probe.container);
  const token = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const base = { container: probe.container, capGiB, slots };

  const t0 = Date.now();
  let reported = 0;
  const flushQueued = () => { const e = Date.now() - t0; reportQueued(hooks, e - reported); reported = e; };
  let first: AcquireReply | null = null;
  let last: AcquireReply | null = null;
  let failOpen: string | null = null;
  let lastProgressAt = 0;
  try {
    for (;;) {
      last = parseAcquireReply(await evalBounded(client, VERIFY_SLOT_ACQUIRE_LUA, keys, [
        token, String(slots), String(VERIFY_SLOT_LEASE_MS), String(VERIFY_SLOT_WAITER_STALE_MS), String(VERIFY_SLOT_KEY_TTL_MS), '1',
      ]));
      first = first ?? last;
      if (last.admitted) break;
      const waited = Date.now() - t0;
      if (waited >= VERIFY_SLOT_MAX_WAIT_MS) break;
      if (!lastProgressAt || Date.now() - lastProgressAt >= PROGRESS_EVERY_MS) {
        lastProgressAt = Date.now();
        progress(hooks, `Waiting for a verify slot — ${last.holders} running in this container (limit ${slots}, from its ${capGiB} GiB memory cap); position ${last.position} in line${waited >= 1000 ? `, ${Math.round(waited / 1000)}s so far` : ''}. The wait does not count against this run's time.`);
      }
      await sleep(Math.min(VERIFY_SLOT_POLL_MS, VERIFY_SLOT_MAX_WAIT_MS - waited));
      if (first && !first.admitted) flushQueued();
    }
  } catch (e: any) {
    failOpen = String(e?.message || e).slice(0, 160);
  }
  const waitedMs = Date.now() - t0;
  const queued = !!first && !first.admitted;
  if (queued) flushQueued();

  if (failOpen !== null || !last) {
    void evalBounded(client, VERIFY_SLOT_RELEASE_LUA, keys, [token]).catch(() => {});
    logger.warn(`verify-slots: Redis unavailable (${failOpen}) — container ${probe.container} runs this chain WITHOUT the slot limit (fail-open)`);
    note(hooks, waitedMs, { ...base, outcome: 'fail_open', reason: failOpen, holders: first?.holders ?? null, position: first?.position ?? null });
    return run();
  }
  if (!last.admitted) {
    void evalBounded(client, VERIFY_SLOT_RELEASE_LUA, keys, [token]).catch(() => {});
    logger.warn(`verify-slots: DEFERRED after ${Math.round(waitedMs / 1000)}s — container ${probe.container} still has ${last.holders}/${slots} verify chains running (position ${last.position})`);
    note(hooks, waitedMs, { ...base, outcome: 'timeout', holders: last.holders, position: last.position });
    return verifySlotsBusyResult({ holders: last.holders, slots, capGiB, waitedMs, position: last.position });
  }

  note(hooks, queued ? waitedMs : 0, { ...base, outcome: queued ? 'acquired' : 'immediate', holders: last.holders, position: first!.position });
  if (queued) {
    logger.info(`verify-slots: slot granted after ${Math.round(waitedMs / 1000)}s in container ${probe.container} (${last.holders}/${slots})`);
    progress(hooks, `Verify slot granted after ${Math.round(waitedMs / 1000)}s — running the chain (${last.holders} of ${slots} in this container).`);
  }
  let renewWarned = false;
  const heartbeat = setInterval(() => {
    evalBounded(client, VERIFY_SLOT_RENEW_LUA, keys, [token, String(VERIFY_SLOT_LEASE_MS), String(VERIFY_SLOT_KEY_TTL_MS)])
      .catch((e: any) => {
        if (renewWarned) return;
        renewWarned = true;
        logger.warn(`verify-slots: lease renew failed for container ${probe.container} (${String(e?.message || e).slice(0, 120)}) — the chain keeps running; the slot may lapse after ${VERIFY_SLOT_LEASE_MS / 1000}s`);
      });
  }, VERIFY_SLOT_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
    await evalBounded(client, VERIFY_SLOT_RELEASE_LUA, keys, [token]).catch(() => {});
  }
}

/** The process-FIFO "queued" status line (verbatim the line tools.ts / agent.ts emitted before this module). */
export function processQueueLine(position: number, limit: number): string {
  return `Verify queued (position ${position}; max ${limit} run at once on this box) — waiting for a free slot`;
}

/**
 * THE gated verify runner both seams call (tools.ts runVerifyChainForTool — the `verify` tool and the
 * open_pull_request auto-verify — and agent.ts's finish auto-verify): the per-process FIFO (verify-limiter.ts,
 * unchanged) and then the per-container slot. With the kill switch on it is exactly the old
 * `withVerifySlot(run, onQueued)`. With it off, the FIFO wait is also reported to onQueuedWait (live, in
 * QUEUE_TICK_MS increments) — a queued verify is queued, whichever line it stands in.
 */
export async function runGatedVerifyChain(
  execShell: ExecShell, worktree: string, hooks: VerifyGateHooks, run: () => Promise<VerifyResult>,
): Promise<VerifyResult> {
  if (verifySlotLimitDisabled()) {
    return withVerifySlot(run, (position, limit) => hooks.progress(processQueueLine(position, limit)));
  }
  const t0 = Date.now();
  let reported = 0;
  let tick: ReturnType<typeof setInterval> | undefined;
  const flush = () => { const e = Date.now() - t0; reportQueued(hooks, e - reported); reported = e; };
  const stopTick = () => { if (tick) { clearInterval(tick); tick = undefined; flush(); } };
  try {
    return await withVerifySlot(
      () => { stopTick(); return withContainerVerifySlot(execShell, worktree, hooks, run); },
      (position, limit) => {
        progress(hooks, processQueueLine(position, limit));
        if (!tick) { tick = setInterval(flush, QUEUE_TICK_MS); tick.unref?.(); }
      },
    );
  } finally {
    if (tick) clearInterval(tick);
  }
}

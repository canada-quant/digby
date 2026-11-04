/**
 * Digby Code — process-wide verify-gate concurrency limiter (ticket 6bf8ce36).
 *
 * The coding box runs up to CODING_WORKER_CONCURRENCY (24) agent sessions in ONE
 * worker process, and each session's verify gate — the agent-callable `verify`
 * tool (tools.ts) and the harness auto-verify loop (agent.ts) — spawns a cold
 * full verification (tsc/lint/tests) in its own worktree. When N sessions hit
 * the gate together they stampede the box: CPU saturates, every chain runs far
 * slower than serial, some time out (corroborated from two independent
 * sessions). This FIFO semaphore caps how many chains run at once — it changes
 * only WHEN a verify chain may run, never what it does.
 *
 * Tunable via VERIFY_GATE_CONCURRENCY (default 2 — a single tsc+jest chain
 * already parallelizes internally, so 2 keeps an 8-vCPU box busy without
 * thrashing). Read per-acquire so an override needs no restart-order care.
 *
 * Deadlock safety: withVerifySlot releases in `finally` and release() is
 * idempotent, so a throwing (or double-releasing) holder can never wedge the
 * queue. No max-hold timer on top — every chain stage is already bounded by
 * perCommandTimeoutMs (verify.service.ts), so a holder cannot hold forever.
 * Scope is deliberately per-process: all 24 worker sessions share one process,
 * which is where the stampede lives (no cross-instance Redis limiter needed).
 */

import logger from '../../../utils/logger';

const DEFAULT_VERIFY_GATE_CONCURRENCY = 2;

/** Max verify chains allowed to run at once in this process (min 1). */
export function verifyGateConcurrency(): number {
  const n = Number(process.env.VERIFY_GATE_CONCURRENCY || DEFAULT_VERIFY_GATE_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_VERIFY_GATE_CONCURRENCY;
}

let active = 0;
const waiters: Array<() => void> = [];

/** Wake queued waiters while capacity allows. The slot is counted (active += 1)
 *  BEFORE the waiter's promise resolves, so a fresh acquire arriving in the
 *  microtask gap cannot steal it and jump the queue. */
function pump(): void {
  while (waiters.length && active < verifyGateConcurrency()) {
    active += 1;
    waiters.shift()!();
  }
}

export interface VerifyGateStats { active: number; queued: number; }

/** Snapshot for logs/tests. */
export function verifyGateStats(): VerifyGateStats {
  return { active, queued: waiters.length };
}

/**
 * Acquire a verify slot (FIFO). Resolves with an idempotent release function.
 * `onQueued(position, limit)` fires once, only when the caller actually has to
 * wait — surface it as a progress event so a queued session never looks hung.
 */
export async function acquireVerifySlot(onQueued?: (position: number, limit: number) => void): Promise<() => void> {
  const limit = verifyGateConcurrency();
  if (!waiters.length && active < limit) {
    active += 1;
  } else {
    const position = waiters.length + 1;
    logger.info(`verify-gate: queued (position ${position}, ${active} running, limit ${limit})`);
    try { onQueued?.(position, limit); } catch { /* a progress-emit failure must not lose the queue slot */ }
    const queuedAt = Date.now();
    await new Promise<void>(resolve => { waiters.push(resolve); pump(); });
    // pump() already counted our slot (active += 1) before waking us.
    logger.info(`verify-gate: slot granted after ${Math.round((Date.now() - queuedAt) / 1000)}s in queue`);
  }
  let released = false;
  return () => {
    if (released) return; // idempotent — a double release must not free someone else's slot
    released = true;
    active -= 1;
    pump();
  };
}

/** Run `fn` holding a verify slot; the slot is ALWAYS released (throw included). */
export async function withVerifySlot<T>(fn: () => Promise<T>, onQueued?: (position: number, limit: number) => void): Promise<T> {
  const release = await acquireVerifySlot(onQueued);
  try {
    return await fn();
  } finally {
    release();
  }
}

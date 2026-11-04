/**
 * iMessage Agent Link — Redis-backed command broker
 *
 * The macOS agent runs on the user's own Mac (behind NAT) and "dials home" by
 * long-polling GET /api/crossmodel/imessage/agent/poll. The backend can therefore
 * never open a connection TO the Mac — instead it parks a command here and the
 * agent's next poll picks it up. When the agent finishes it POSTs the result to
 * /api/crossmodel/imessage/agent/result, which the awaiting dispatcher picks up.
 *
 * Transport is Redis lists (NOT in-memory Maps): production runs multiple backend
 * processes (2 web instances behind a per-request ALB + 1 worker), so the process
 * that dispatches a command, the process that serves the Mac's long-poll, and the
 * process that receives the result POST are usually DIFFERENT processes. Keys:
 *   imsg:cmd:<agentId> — queued commands (RPUSH by dispatch, LPOP by the poll)
 *   imsg:res:<cmdId>   — the command's result (RPUSH by result POST, LPOP by the
 *                        dispatcher's await loop; self-expires if nobody is waiting)
 *
 * There is deliberately NO same-process fast path — one code path for every
 * topology so local dev exercises exactly what prod runs.
 *
 * Redis-down posture: dispatch rejects with the existing "agent did not respond"
 * error shape; the poll returns empty (the Mac immediately re-polls).
 */

import { randomUUID } from 'crypto';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';

export interface AgentCommand {
  cmdId: string;
  method: string;
  params: Record<string, unknown>;
  /** Optional: only agents at >= this version may claim this command (the agent
   *  ignores the field; the broker enforces it in waitForCommand). */
  minAgentVersion?: string;
  /** Optional: only agents that ADVERTISE this capability may claim this
   *  command (W1 multi-device, 2026-09-25 — mirrors minAgentVersion). A
   *  Windows agent advertises ['browser','computer'] and never 'imessage', so
   *  iMessage-tagged commands stay queued for a Mac. A poller that advertises
   *  nothing (every pre-W0 Mac) claims everything — the agent ignores the
   *  field; the broker enforces it in waitForCommand. */
  capability?: string;
}

/** Wire format stored in imsg:cmd:<agentId> — AgentCommand + expiry metadata. */
interface StoredCommand extends AgentCommand {
  dispatchedAt: number;
  timeoutMs: number;
}

/** Semver-ish compare: '0.3.2' >= [0,3,2]. Missing/unparseable → false. */
export function agentVersionAtLeast(version: string | null | undefined, min: string): boolean {
  if (!version) return false;
  const a = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

interface StoredResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// Upper bound on commands buffered for a single (likely-offline) agent. Each
// dispatched command self-expires (the poll skips entries past their dispatch
// timeout), but the cap is a hard backstop against unbounded queue growth if
// many commands are dispatched to an agent that never polls.
const MAX_QUEUED_COMMANDS_PER_AGENT = 50;

/** How often the dispatcher checks imsg:res:<cmdId> for the agent's result. */
const RESULT_POLL_INTERVAL_MS = 250;
/** How often the agent's long-poll re-checks imsg:cmd:<agentId> for a command. */
const COMMAND_POLL_INTERVAL_MS = 1000;
/** Results outlive the longest dispatch timeout slightly; stale ones self-expire. */
const RESULT_TTL_SEC = 60;

/**
 * Mac iMessage READ-path dispatch budget (2026-10-22, Mac-wedge class fix):
 * the owner's outdated v0.6.3 agent reads a large chat.db slowly — the 8 s
 * budget expired before list_chats / get_messages answered, so iMessage read
 * enrichment and the lane tools silently degraded (non-blocking warns) while
 * the Mac itself was healthy. 30 s default; a slow-but-working agent now
 * answers. IMESSAGE_READ_DISPATCH_BUDGET_30S_DISABLED=1 restores the 8 s
 * budget (switch-registry ledger 663). The send path keeps its own 20 s
 * budget; the controller's DISPATCH_TIMEOUT_MS (20 s) is untouched.
 */
export const IMESSAGE_READ_DISPATCH_TIMEOUT_MS = process.env.IMESSAGE_READ_DISPATCH_BUDGET_30S_DISABLED === '1' ? 8_000 : 30_000;
/** Queue backstop TTL, refreshed on every push — must exceed the longest dispatch
 *  timeout in use (browser ops: 45s) so a live command is never expired early. */
const CMD_QUEUE_TTL_SEC = 120;

const cmdKey = (agentId: string) => `imsg:cmd:${agentId}`;
const resKey = (cmdId: string) => `imsg:res:${cmdId}`;

/**
 * Ticket e6b16c4e: the broker transports commands for EVERY surface (iMessage,
 * the local browser, computer use), but its timeout error always said "iMessage
 * agent" — a browser_navigate dispatched to the Windows agent timed out reading
 * "iMessage agent did not respond within 45000ms" in a browser task's result.
 * Derive the surface noun from the capability tag dispatchers already send;
 * untagged commands (and 'imessage') keep the exact historical wording, which
 * tests and every pre-capability caller pin.
 */
function surfaceNounFor(capability?: string): string {
  if (capability === 'browser') return 'browser agent';
  if (capability === 'computer') return 'computer agent';
  return 'iMessage agent';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AgentLinkBroker {
  // Poll intervals are injectable so tests can run the real loops fast.
  constructor(
    private readonly commandPollIntervalMs = COMMAND_POLL_INTERVAL_MS,
    private readonly resultPollIntervalMs = RESULT_POLL_INTERVAL_MS,
  ) {}

  /**
   * Send a command to a specific agent and await its result.
   * Rejects if the agent does not respond within timeoutMs.
   */
  async dispatch(
    agentId: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 20000,
    opts?: { minAgentVersion?: string; capability?: string },
  ): Promise<unknown> {
    const cmdId = randomUUID();
    const stored: StoredCommand = {
      cmdId, method, params, dispatchedAt: Date.now(), timeoutMs,
      ...(opts?.minAgentVersion ? { minAgentVersion: opts.minAgentVersion } : {}),
      ...(opts?.capability ? { capability: opts.capability } : {}),
    };
    const payload = JSON.stringify(stored);

    try {
      await redisClient.rPush(cmdKey(agentId), payload);
      // Cap the buffer (drop oldest) and refresh the backstop TTL so the queue
      // of an agent that never reconnects dies on its own.
      await redisClient.lTrim(cmdKey(agentId), -MAX_QUEUED_COMMANDS_PER_AGENT, -1);
      await redisClient.expire(cmdKey(agentId), CMD_QUEUE_TTL_SEC);
    } catch (err) {
      logger.warn(`AgentLink dispatch enqueue failed (redis): ${(err as Error).message}`);
      throw new Error(`${surfaceNounFor(opts?.capability)} did not respond within ${timeoutMs}ms`);
    }
    logger.info(`AgentLink dispatch → agent=${agentId} method=${method} cmd=${cmdId}`);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let raw: string | null = null;
      try {
        raw = await redisClient.lPop(resKey(cmdId));
      } catch {
        raw = null; // transient Redis error — keep polling until the deadline
      }
      if (raw) {
        let parsed: StoredResult;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(`${surfaceNounFor(opts?.capability)} reported an error`);
        }
        if (parsed.ok) return parsed.result;
        throw new Error(parsed.error || `${surfaceNounFor(opts?.capability)} reported an error`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this.resultPollIntervalMs, remaining));
    }

    // Timed out. If the agent never polled, the command is still sitting in its
    // queue — remove it (best-effort) so a dead agent leaves nothing behind.
    try {
      await redisClient.lRem(cmdKey(agentId), 0, payload);
    } catch { /* the queue TTL is the backstop */ }
    throw new Error(`${surfaceNounFor(opts?.capability)} did not respond within ${timeoutMs}ms`);
  }

  /**
   * Called by the agent's long-poll. Bounded loop: pops a queued command if one
   * exists, otherwise sleeps and retries until the budget runs out (→ null; the
   * Mac immediately re-polls). Never a blocking Redis client — a plain LPOP loop
   * so any web instance can serve the poll regardless of who dispatched.
   *
   * isCancelled: checked between iterations (e.g. the HTTP client disconnected).
   * A command popped after cancellation is pushed back for the next poll.
   */
  async waitForCommand(
    agentId: string,
    timeoutMs = 25000,
    isCancelled?: () => boolean,
    pollerVersion?: string,
    pollerCapabilities?: readonly string[],
  ): Promise<AgentCommand | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (isCancelled?.()) return null;
      if (Date.now() >= deadline) return null; // enforced on EVERY path — the gate-requeue branch must not outlive the poll budget
      let raw: string | null = null;
      try {
        raw = await redisClient.lPop(cmdKey(agentId));
      } catch {
        return null; // Redis down → empty poll; the Mac re-polls
      }
      if (raw) {
        const cmd = this.parseCommand(raw);
        if (!cmd) continue; // malformed or already past its dispatch timeout — skip
        // Version gate (2026-08-31): a queued command may require a newer agent
        // than the one polling (multi-device fleets share one agentId — an old
        // clone must never claim work it cannot run). Leave it for a capable
        // poller: requeue at the head, re-arm the TTL, and keep waiting.
        if (cmd.minAgentVersion && !agentVersionAtLeast(pollerVersion, cmd.minAgentVersion)) {
          try {
            await redisClient.lPush(cmdKey(agentId), raw);
            await redisClient.expire(cmdKey(agentId), CMD_QUEUE_TTL_SEC);
          } catch { /* command is lost; dispatcher times out */ }
          logger.info(`AgentLink: poller v${pollerVersion || 'unknown'} skipped cmd=${cmd.cmdId} (needs v${cmd.minAgentVersion})`);
          await sleep(Math.min(this.commandPollIntervalMs, Math.max(deadline - Date.now(), 1)));
          continue;
        }
        // Capability gate (W1 multi-device, 2026-09-25): a command dispatched to
        // a surface a device does not HAVE (iMessage on a Windows agent) must
        // never be claimed by it — the agent would answer "Unknown method" after
        // a wasted round trip. Same requeue-and-continue contract as the version
        // gate: leave it at the head for a capable poller, re-arm the TTL, keep
        // waiting within the SAME poll budget. A poller that advertises NOTHING
        // (undefined/empty — every pre-W0 Mac) claims everything: the gate only
        // fires when BOTH the command names a capability AND the poller
        // advertised a non-empty set, so legacy Macs are byte-identical.
        if (
          cmd.capability &&
          Array.isArray(pollerCapabilities) &&
          pollerCapabilities.length > 0 &&
          !pollerCapabilities.includes(cmd.capability)
        ) {
          try {
            await redisClient.lPush(cmdKey(agentId), raw);
            await redisClient.expire(cmdKey(agentId), CMD_QUEUE_TTL_SEC);
          } catch { /* command is lost; dispatcher times out */ }
          logger.info(`AgentLink: poller (capabilities: ${pollerCapabilities.join(', ')}) skipped cmd=${cmd.cmdId} (needs capability '${cmd.capability}')`);
          await sleep(Math.min(this.commandPollIntervalMs, Math.max(deadline - Date.now(), 1)));
          continue;
        }
        if (isCancelled?.()) {
          // Client vanished between the pop and the write — requeue for the next
          // poll. The LPOP that emptied the list deleted the key, so re-arm the
          // TTL: a requeue-recreated key must never outlive an agent that goes
          // permanently offline (review 2026-08-16).
          try {
            await redisClient.lPush(cmdKey(agentId), raw);
            await redisClient.expire(cmdKey(agentId), CMD_QUEUE_TTL_SEC);
          } catch { /* command is lost; dispatcher times out */ }
          return null;
        }
        return cmd;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await sleep(Math.min(this.commandPollIntervalMs, remaining));
    }
  }

  /** Parse a queued entry; null for malformed JSON or a command whose dispatcher
   *  has already timed out (no point handing dead work to the Mac). */
  private parseCommand(raw: string): AgentCommand | null {
    try {
      const p = JSON.parse(raw) as StoredCommand;
      if (typeof p?.cmdId !== 'string' || typeof p?.method !== 'string') return null;
      if (Number.isFinite(p.dispatchedAt) && Number.isFinite(p.timeoutMs) && p.dispatchedAt + p.timeoutMs <= Date.now()) {
        logger.warn(`AgentLink: skipping expired queued cmd=${p.cmdId}`);
        return null;
      }
      return { cmdId: p.cmdId, method: p.method, params: p.params || {}, ...(typeof p.minAgentVersion === 'string' ? { minAgentVersion: p.minAgentVersion } : {}), ...(typeof p.capability === 'string' ? { capability: p.capability } : {}) };
    } catch {
      return null;
    }
  }

  /**
   * Cancel a parked poll — no-op on the Redis transport (there is no parked
   * in-process waiter; unclaimed keys simply expire). Kept for API compatibility.
   */
  cancelWaiter(_agentId: string): void {
    // intentionally empty
  }

  /**
   * Deliver a command's result. Pushed to imsg:res:<cmdId> for whichever process
   * is awaiting it; self-expires if the dispatcher already timed out.
   * Returns false only if the write failed (Redis down).
   */
  async deliverResult(cmdId: string, ok: boolean, result: unknown, error?: string): Promise<boolean> {
    // No capability context here (the result POST arrives from whichever process
    // serves the agent) — a neutral noun, never a wrong-surface one (e6b16c4e).
    const stored: StoredResult = { ok, ...(ok ? { result } : { error: error || 'the paired agent reported an error' }) };
    try {
      await redisClient.rPush(resKey(cmdId), JSON.stringify(stored));
      await redisClient.expire(resKey(cmdId), RESULT_TTL_SEC);
      return true;
    } catch (err) {
      logger.warn(`AgentLink deliverResult failed (redis) cmd=${cmdId}: ${(err as Error).message}`);
      return false;
    }
  }
}

export const agentBroker = new AgentLinkBroker();

/**
 * BROKERED SESSION STORE — the Redis half of the per-session auth contract
 * (ticket c468f922, owner ruling 2026-10-29 on card oq_b5118c38).
 *
 * `brokered-session.ts` is the pure state machine; this module is where a
 * grant actually LIVES, because prod runs multiple backend processes (2 web
 * instances behind an ALB + 1 worker). A `Map` here would mean the process
 * that mints a grant and the process that consumes it are usually different —
 * so the grant would be invisible to the device that presents it. Redis is the
 * same discipline `agent-link.ts` already uses for its command broker, and
 * `imessage.service.ts` for its pairing codes.
 *
 * ── THREE DEFECTS FOUND BY REVIEW AND FIXED HERE (2026-11-02) ──────────────
 *
 * D2 — THE TTL MADE `stale` A FIVE-MINUTE BLIP. The first cut used a 300s
 * slack over `expiresAt`, so a grant consumed one second into its window
 * reported `stale` for exactly 300s and then the key EXPIRED: `load` → null,
 * state → 'none', no blocker, and the verdict went back to `ready: true`
 * while the channel was still authenticated with nobody behind it. That is
 * the false-clean this module exists to prevent, implemented by the module
 * itself. The retention is now GRANT_RETENTION_SEC (7 days): a grant outlives
 * its window by a week so an overrun session stays REPORTABLE, which is the
 * whole point of the `stale` token. One key per device, so the cost is one
 * small row per paired Mac — and the row is bounded, not immortal.
 *
 * D3 — "SINGLE-USE FROM ANY PROCESS" WAS NOT ATOMIC. The first cut was
 * load → check → setEx, so two processes that both read before either wrote
 * would both return ok:true — a captured authorization opening two sessions,
 * exactly the replay the contract forbids. Consumption now CLAIMS an atomic
 * `SET … NX` marker keyed by sessionId: exactly one caller anywhere in the
 * fleet can win it, and every loser is refused as `already-consumed`.
 *
 * D4 — "FAIL-OPEN" DID NOT HOLD AGAINST A WEDGED (not down) REDIS. `config/
 * redis.ts` sets no `disableOfflineQueue`/`connectTimeout`, so node-redis
 * queues commands while the socket is not ready and a `get` can hang forever —
 * which would hang `/imessage/status` behind it. Every read here is bounded by
 * REDIS_READ_TIMEOUT_MS and a timeout reads as "no session" (the safe
 * direction: the window fold can only make a verdict STRICTER).
 *
 * ⚠ NO TOP-LEVEL `config/redis` / `utils/logger` IMPORT. This module is pulled
 * in by `account-tools.ts`, which sits under `coding/tools.ts` — so a plain
 * top-level import would boot `config/env.ts` (and its `parseEnv` validation)
 * in EVERY suite that merely imports the tool registry. Measured 2026-11-02:
 * doing exactly that turned 53 unrelated suites red with `Jest worker
 * encountered 4 child process exceptions`, the real cause being
 * `parseEnv (src/config/env.ts:101)` reached from here. `account-tools.ts`
 * already imports its redis-touching dependencies dynamically for this same
 * reason; these loaders follow that precedent. Both `jest.mock` boundaries
 * still intercept the dynamic import, so tests mock them exactly as before.
 *
 * No credential has a slot here: the stored value is the grant shape from
 * `brokered-session.ts`, which is itself credential-free by construction.
 */

import {
  type BrokeredSessionGrant,
  type BrokeredSessionRequest,
  type BrokeredSessionClaim,
  type BrokeredSessionConsume,
  type BrokeredSessionIssue,
  consumeBrokeredSession,
  closeBrokeredSession,
  issueBrokeredSession,
  brokeredSessionBlocker,
  brokeredSessionState,
  applyBrokeredSessionWindow,
} from './brokered-session';
import type { RemoteAccessAdvert } from './remote-access-verdict';
import type { RemoteAccessVerdict } from './remote-access-verdict';

/**
 * How long a grant row survives after its window ends.
 *
 * NOT a small slack. A grant must remain READABLE long after `expiresAt` or the
 * `stale` blocker it produces disappears the moment it becomes true (D2). A
 * week is long enough that an operator session abandoned on a Friday is still
 * reported `blocked` on Monday, and bounded so the row is not immortal.
 */
export const GRANT_RETENTION_SEC = 7 * 24 * 60 * 60;

/** Hard bound on any single Redis read/write from this module (D4). */
export const REDIS_READ_TIMEOUT_MS = 750;

/** Minimal structural type for the Redis calls used here, so this module
 *  never needs the concrete client type (and never imports it eagerly). */
interface BrokerRedis {
  get(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
  /** `SET key value NX EX ttl` — the atomic single-use claim (D3). */
  set(key: string, value: string, opts: { NX: true; EX: number }): Promise<string | null>;
}

/** The Redis client, loaded on first use. */
async function store(): Promise<BrokerRedis> {
  const mod = await import('../../../config/redis');
  return mod.default as unknown as BrokerRedis;
}

/** The logger, loaded on first use (same reason as `store`). */
async function log(): Promise<{ warn: (...a: unknown[]) => void }> {
  const mod = await import('../../../utils/logger');
  return mod.default as unknown as { warn: (...a: unknown[]) => void };
}

/**
 * Bound a store call so a WEDGED redis cannot hang the caller (D4).
 *
 * Rejects on timeout rather than resolving a sentinel, so each caller decides
 * what "unknown" means for it — `load` reads it as no-session, `create` refuses.
 */
async function bounded<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${REDIS_READ_TIMEOUT_MS}ms`)),
          REDIS_READ_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The Redis key for one device's CURRENT grant. One session per device: a
 *  second grant replaces the first, because two simultaneously-live operator
 *  sessions on one box is not a shape this contract authorizes. */
function sessionKey(agentId: string): string {
  return `imsg:brokered:${agentId}`;
}

/** The atomic single-use claim marker, keyed by sessionId (D3). */
function claimKey(sessionId: string): string {
  return `imsg:brokered-claimed:${sessionId}`;
}

/** Parse a stored row defensively — a corrupt value must read as "no session",
 *  never throw into a device list. */
function parseGrant(raw: string | null): BrokeredSessionGrant | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as BrokeredSessionGrant;
    if (!o || typeof o.sessionId !== 'string' || typeof o.agentId !== 'string') return null;
    if (typeof o.expiresAt !== 'number') return null;
    return o;
  } catch {
    return null;
  }
}

/**
 * Mint and persist a grant for one device.
 *
 * The verdict is passed through to the leaf, which refuses on anything that is
 * not `ready` — so the harden contract cannot be bypassed by calling the store
 * directly instead of the leaf.
 */
export async function createBrokeredSession(
  req: BrokeredSessionRequest | null | undefined,
  verdict: Pick<RemoteAccessVerdict, 'ready'> | null | undefined,
  now: number = Date.now(),
): Promise<BrokeredSessionIssue> {
  const issued = issueBrokeredSession(req, verdict, now);
  if (!issued.ok) return issued;
  try {
    const redis = await store();
    await bounded(
      redis.setEx(sessionKey(issued.grant.agentId), GRANT_RETENTION_SEC, JSON.stringify(issued.grant)),
      'createBrokeredSession',
    );
  } catch (e) {
    // A grant we could not persist is a grant the device can never present, so
    // reporting success would be a lie the operator discovers at use time.
    try { (await log()).warn('brokered-session: could not persist grant', e); } catch { /* logging never breaks the path */ }
    return {
      ok: false,
      refusal: 'not-ready',
      reason:
        'the session could not be recorded — the broker store is unavailable, so a grant minted now could not be honored; retry once it recovers',
    };
  }
  return issued;
}

/**
 * Load one device's current grant, or null when there is none / it is
 * unreadable / the store did not answer in time (D4).
 */
export async function loadBrokeredSession(agentId: string): Promise<BrokeredSessionGrant | null> {
  try {
    const redis = await store();
    return parseGrant(await bounded(redis.get(sessionKey(agentId)), 'loadBrokeredSession'));
  } catch (e) {
    try { (await log()).warn('brokered-session: could not read grant', e); } catch { /* logging never breaks the path */ }
    return null;
  }
}

/**
 * Use a device's grant exactly once, ATOMICALLY across processes.
 *
 * The check order is the leaf's (identity → replay → expiry); the atomicity is
 * here: winner-takes-all on `SET claim NX`. Two processes that both loaded the
 * same unused grant can both pass the leaf, but only ONE can create the claim
 * marker — the loser is refused as `already-consumed`, so a captured
 * authorization opens exactly one session anywhere in the fleet (D3).
 */
export async function consumeStoredBrokeredSession(
  claim: BrokeredSessionClaim | null | undefined,
  now: number = Date.now(),
): Promise<BrokeredSessionConsume> {
  const agentId = claim?.agentId;
  if (!agentId) {
    return {
      ok: false,
      refusal: 'malformed',
      reason: 'the claim does not name a device, so there is no session to consume',
    };
  }
  const stored = await loadBrokeredSession(agentId);
  const out = consumeBrokeredSession(stored, claim, now);
  if (!out.ok) return out;

  // ── THE ATOMIC SINGLE-USE CLAIM (D3) ──────────────────────────────────────
  // `SET NX` is the whole mechanism: exactly ONE caller anywhere in the fleet
  // can create this marker, and every other caller gets null and is refused.
  // Nothing is written at mint time, so the first consumer always wins it.
  try {
    const redis = await store();
    const ttlSec = Math.max(60, Math.ceil((out.grant.expiresAt - now) / 1000) + GRANT_RETENTION_SEC);
    const won = await bounded(
      redis.set(claimKey(out.grant.sessionId), String(now), { NX: true, EX: ttlSec }),
      'claimBrokeredSession',
    );
    if (won === null) {
      return {
        ok: false,
        refusal: 'already-consumed',
        reason:
          'this grant was already used — a brokered session is single-use, so a replayed authorization cannot open a second session',
      };
    }
  } catch (e) {
    // A store that cannot prove single-use must NOT silently allow the session:
    // refusing is the safe direction (a re-mint is cheap, a duplicate session
    // on a locked device is not).
    try { (await log()).warn('brokered-session: could not claim grant', e); } catch { /* ignore */ }
    return {
      ok: false,
      refusal: 'already-consumed',
      reason:
        'the single-use claim could not be recorded — refusing rather than risk opening a second session; retry once the broker store recovers',
    };
  }

  try {
    const redis = await store();
    // Re-write with the ORIGINAL expiry (the leaf never extends it) and the
    // long retention, so a consumed grant stays readable long enough for an
    // overrun to be REPORTED stale rather than silently expiring (D2).
    await bounded(
      redis.setEx(sessionKey(agentId), GRANT_RETENTION_SEC, JSON.stringify(out.grant)),
      'persist-consumed',
    );
  } catch (e) {
    try { (await log()).warn('brokered-session: could not record consumption', e); } catch { /* ignore */ }
  }
  return out;
}

/**
 * Record a session as ended. The ONLY way a live session stops being
 * live-before-expiry — and therefore the control that keeps `stale` meaningful:
 * a host that closes its sessions reads clean, and one that never does is
 * exactly what the fleet should see.
 */
export async function closeStoredBrokeredSession(
  agentId: string,
  now: number = Date.now(),
): Promise<BrokeredSessionGrant | null> {
  const stored = await loadBrokeredSession(agentId);
  if (!stored) return null;
  const closed = closeBrokeredSession(stored, now);
  if (!closed) return null;
  try {
    const redis = await store();
    await bounded(redis.setEx(sessionKey(agentId), GRANT_RETENTION_SEC, JSON.stringify(closed)), 'persist-close');
  } catch (e) {
    try { (await log()).warn('brokered-session: could not persist close', e); } catch { /* ignore */ }
  }
  return closed;
}

/**
 * THE PRODUCER. Attach the session-window blocker (if any) to a device's
 * advertised remote-access state, so `remoteAccessVerdict()` reports `stale`
 * through the SAME path it reports every other blocker.
 *
 * This is the function the missing producer was: before it, the `stale` token
 * existed in the vocabulary, both agents listed it, and nothing could ever
 * emit it. It returns the advert UNCHANGED when there is nothing to say, so the
 * absent-never-clobbers contract holds and a device with no session is
 * byte-identical to today.
 */
export async function withBrokeredSessionWindow(
  agentId: string,
  advert: RemoteAccessAdvert | null | undefined,
  now: number = Date.now(),
): Promise<RemoteAccessAdvert | null | undefined> {
  if (!advert || !advert.enabled) return advert;
  const grant = await loadBrokeredSession(agentId);
  const stale = brokeredSessionBlocker(grant, now);
  if (!stale) return advert;
  // Fold via the leaf so the merge/priority rules live in ONE place.
  return applyBrokeredSessionWindow(advert, grant, now);
}

/** Re-exported so a caller can classify without importing the leaf directly. */
export { brokeredSessionState };
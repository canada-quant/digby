/**
 * BROKERED SESSION — the time-boxed, single-use operator grant for one device
 * (ticket c468f922, owner ruling 2026-10-29 on card oq_b5118c38).
 *
 * THE OWNER'S DECISION, verbatim: "can we do option three but a little more
 * secure like how it's just like TeamViewer".
 *
 * WHAT ALREADY SHIPPED (verified on main before writing this — do not rebuild
 * it): `agent-link.ts` is an outbound-only dial-home broker (the Mac long-polls;
 * the backend can never open a connection TO it), device pairing issues a
 * random 32-byte token stored only as a hash (`imessage.service.ts`
 * startPairing/completePairing), and `remote-access-verdict.ts` governs the OS
 * channel with a closed blocker vocabulary. So three of the four properties the
 * ruling named exist: device dials out, device pairing, encrypted transport
 * (HTTPS long-poll).
 *
 * WHAT WAS MISSING, and is the entire reason this module exists. The ruling's
 * fourth property is **strong per-session auth** — and the hardening contract
 * already DECLARED it without any producer:
 *
 *   - `REMOTE_HARDEN_REQUIREMENTS` lists `session-window`:
 *     "every brokered session is time-boxed and closes with the session that
 *      opened it".
 *   - `REMOTE_BLOCKER_PRIORITY` lists the `stale` token: "a brokered session
 *     outlived its window".
 *   - Both agents carry `stale` in their local blocker union
 *     (`imessage-agent/src/remote-access.ts`, `windows-agent/src/remote-access.ts`)
 *     but NOTHING ever emits it, and no backend type models a session at all.
 *
 * A requirement with no producer is a rule that only exists in prose: a lane
 * reading `ready: true` cannot tell a channel whose session closed on time from
 * one still authenticated hours after the operator left. This module supplies
 * the missing half — the grant — and the one function that turns an overrun
 * into the `stale` blocker the vocabulary already promised.
 *
 * THE THREE PROPERTIES, and why each is load-bearing:
 *   1. TIME-BOXED. A grant expires. A hard ceiling exists because "pass a big
 *      number" is how an unbounded window gets created by accident, and an
 *      unbounded window is a permanently open door with extra steps.
 *   2. SINGLE-USE. Consuming is idempotent-fail: a replayed grant is refused,
 *      so a captured authorization cannot open a second session.
 *   3. DEVICE-BOUND. A grant names its agentId. A grant for the office Mac
 *      cannot drive the home mini even if it leaks into the wrong request — the
 *      pairing identity and the session identity are checked together.
 *
 * `stale` IS NOT `expired`, and the difference is the whole point. A grant that
 * expired WITHOUT ever being consumed authenticated nothing — the operator
 * never showed up, so there is no session to be past its window and reporting
 * `stale` would be a false alarm that trains lanes to ignore the token. `stale`
 * is reserved for the dangerous shape: a grant that WAS consumed, whose window
 * has since passed, and which carries no recorded close. That channel is
 * authenticated right now with nobody's session behind it — the condition the
 * existing reason text describes and the reason it says "revoke and re-enable".
 *
 * NO CREDENTIAL, STRUCTURALLY. None of these shapes has a slot a secret could
 * ride in on: no `password`, no `token`, no free-form bag. A VNC/RDP credential
 * passed in by mistake has nowhere to go, which is the property acceptance
 * criterion 5 ("no credential is ever logged, echoed into a chat, or
 * committed") needs at the place a session is minted. Pinned by test.
 *
 * Pure leaf: no Prisma / Redis / logger / fs / child_process imports, so the
 * device list, the agents' planners and this module answer from ONE definition.
 * No clock is read here either — `now` is always a parameter, so the state
 * machine is testable and never depends on when it runs.
 */

import {
  REMOTE_BLOCKER_PRIORITY,
  type RemoteAccessAdvert,
  type RemoteChannel,
} from './remote-access-verdict';
import type { RemoteAccessVerdict } from './remote-access-verdict';

/**
 * The absolute ceiling on a brokered session, in seconds.
 *
 * One hour, deliberately not "as long as the operator likes". The threat this
 * bounds is an operator session outliving the human: a window that survives a
 * commute, a meeting and a night is indistinguishable from a standing backdoor
 * if the grant leaks. An operator who genuinely needs longer opens a NEW
 * session — which is the point of per-session auth, not a limitation of it.
 */
export const BROKERED_SESSION_HARD_MAX_SEC = 3600;

/** The default window when a caller does not ask for one: ten minutes, the
 *  scale of "look at the login window and type one thing". */
export const BROKERED_SESSION_DEFAULT_SEC = 600;

/** Why a grant was refused at issue time. Closed vocabulary: a caller switches
 *  on these, so a new code is a deliberate change, never a string surprise. */
export type BrokeredSessionRefusal =
  /** The device's channel is not in a hardened, tunnel-bound, blocker-free
   *  state. A session is never minted over an unsafe channel — the verdict is
   *  the gate, so the harden contract cannot be bypassed by minting `ready`. */
  | 'not-ready'
  /** The requested window exceeds BROKERED_SESSION_HARD_MAX_SEC. */
  | 'window-too-long'
  /** Zero or negative: a grant that is already dead is not a grant. */
  | 'window-not-positive'
  /** The grant names a different device than the one presenting it. */
  | 'wrong-device'
  /** The grant was already consumed (replay). */
  | 'already-consumed'
  /** The window had already passed when it was presented for use. */
  | 'expired'
  /** A field the caller must supply is empty or malformed. */
  | 'malformed';

/**
 * ONE brokered operator session. Every timestamp is unix MILLISECONDS, matching
 * `Date.now()`, so no caller has to remember a unit.
 *
 * The optional `consumedAt` / `closedAt` are the state machine: absent absent =
 * issued-but-unused; consumed set = the session is live; both set = cleanly
 * ended. Any other combination is either in-flight or stale, and
 * `brokeredSessionState` is the single place that decides which.
 */
export interface BrokeredSessionGrant {
  /** Opaque id, generated by the issuer — never derived from a credential. */
  sessionId: string;
  /** The paired device this grant may drive, and ONLY this one. */
  agentId: string;
  /** The OS channel being brokered, so a macOS grant cannot be presented to a
   *  Windows agent by way of a shared code path. */
  channel: RemoteChannel;
  /** When the grant was minted. */
  issuedAt: number;
  /** When the grant stops being usable. */
  expiresAt: number;
  /** When the operator FIRST used it. Presence makes the session live. */
  consumedAt?: number;
  /** When the session was recorded as ended. Presence makes it closed. */
  closedAt?: number;
}

/** What a caller supplies to mint a grant. */
export interface BrokeredSessionRequest {
  sessionId: string;
  agentId: string;
  channel: RemoteChannel;
  /** Requested window; omit for BROKERED_SESSION_DEFAULT_SEC. */
  windowSec?: number;
}

/** Issue outcome — a discriminated union so a caller cannot read `.grant` on a
 *  refusal (the classic "it compiled, so it must have worked"). */
export type BrokeredSessionIssue =
  | { ok: true; grant: BrokeredSessionGrant; expiresInSec: number }
  | { ok: false; refusal: BrokeredSessionRefusal; reason: string };

/** The single reason line for each refusal, so prose cannot drift per caller. */
const REFUSAL_REASONS: Readonly<Record<BrokeredSessionRefusal, string>> = {
  'not-ready':
    'the channel is not in a hardened, tunnel-bound state — a brokered session is never opened over a channel that has not passed the remote-access harden contract',
  'window-too-long': `a brokered session may not exceed ${BROKERED_SESSION_HARD_MAX_SEC}s — open a new session instead of widening this one`,
  'window-not-positive':
    'the requested window is not positive — a grant that is already expired is not a grant',
  'wrong-device':
    'this grant names a different device — a brokered session may only drive the device it was minted for',
  'already-consumed':
    'this grant was already used — a brokered session is single-use, so a replayed authorization cannot open a second session',
  expired:
    'this grant passed its window before it was used — mint a new one; an expired grant never opened a session, so nothing is left authenticated',
  malformed: 'the grant is incomplete or malformed — every field must be a non-empty value',
};

/** The ONE reason line for a refusal code. */
export function reasonForBrokeredRefusal(refusal: BrokeredSessionRefusal): string {
  return REFUSAL_REASONS[refusal];
}

/** True when a value is a usable non-empty string. */
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Mint a grant, or refuse with a typed reason.
 *
 * `verdict` is REQUIRED and is the gate: a session is only ever opened on a
 * channel that is already `ready` (enabled, tunnel-bound, no blockers). Passing
 * the verdict in — rather than reading a stored row — keeps this a pure leaf
 * and makes "can I open a session?" and "is the channel safe?" the same answer
 * by construction, instead of two computations that can disagree.
 */
export function issueBrokeredSession(
  req: BrokeredSessionRequest | null | undefined,
  verdict: Pick<RemoteAccessVerdict, 'ready'> | null | undefined,
  now: number,
): BrokeredSessionIssue {
  if (!req || !nonEmpty(req.sessionId) || !nonEmpty(req.agentId) || !nonEmpty(req.channel)) {
    return { ok: false, refusal: 'malformed', reason: reasonForBrokeredRefusal('malformed') };
  }
  // The harden gate comes FIRST: an unsafe channel must report the channel
  // problem, not a window problem, or a caller chasing the wrong refusal
  // "fixes" the window and mints a session onto an exposed port.
  if (!verdict || verdict.ready !== true) {
    return { ok: false, refusal: 'not-ready', reason: reasonForBrokeredRefusal('not-ready') };
  }
  const windowSec = req.windowSec === undefined ? BROKERED_SESSION_DEFAULT_SEC : req.windowSec;
  if (typeof windowSec !== 'number' || !Number.isFinite(windowSec)) {
    return { ok: false, refusal: 'malformed', reason: reasonForBrokeredRefusal('malformed') };
  }
  if (windowSec <= 0) {
    return { ok: false, refusal: 'window-not-positive', reason: reasonForBrokeredRefusal('window-not-positive') };
  }
  if (windowSec > BROKERED_SESSION_HARD_MAX_SEC) {
    return { ok: false, refusal: 'window-too-long', reason: reasonForBrokeredRefusal('window-too-long') };
  }
  return {
    ok: true,
    expiresInSec: windowSec,
    grant: {
      sessionId: req.sessionId,
      agentId: req.agentId,
      channel: req.channel,
      issuedAt: now,
      expiresAt: now + windowSec * 1000,
    },
  };
}

/** What a device presents to USE a grant. Mirrors the pairing identity. */
export interface BrokeredSessionClaim {
  sessionId: string;
  agentId: string;
  channel: RemoteChannel;
}

/** Consume outcome — `ok:true` carries the updated grant to persist. */
export type BrokeredSessionConsume =
  | { ok: true; grant: BrokeredSessionGrant }
  | { ok: false; refusal: BrokeredSessionRefusal; reason: string };

/**
 * Use a grant exactly once, on the device it belongs to, inside its window.
 *
 * Check ORDER matters and is deliberate: identity first (a leaked grant
 * presented by the wrong device must not learn whether it is still valid),
 * then replay, then expiry. Consuming stamps `consumedAt` and is otherwise
 * immutable — `expiresAt` is NEVER extended by a use, because a grant that
 * renews itself on use is an unbounded window wearing a time-box costume.
 */
export function consumeBrokeredSession(
  grant: BrokeredSessionGrant | null | undefined,
  claim: BrokeredSessionClaim | null | undefined,
  now: number,
): BrokeredSessionConsume {
  if (!grant || !claim || !nonEmpty(claim.sessionId) || !nonEmpty(claim.agentId)) {
    return { ok: false, refusal: 'malformed', reason: reasonForBrokeredRefusal('malformed') };
  }
  if (grant.sessionId !== claim.sessionId || grant.agentId !== claim.agentId || grant.channel !== claim.channel) {
    return { ok: false, refusal: 'wrong-device', reason: reasonForBrokeredRefusal('wrong-device') };
  }
  // `closedAt` is the end of the story: a closed session is not consumable
  // again, and reporting it as a replay is the honest description.
  if (grant.consumedAt !== undefined || grant.closedAt !== undefined) {
    return { ok: false, refusal: 'already-consumed', reason: reasonForBrokeredRefusal('already-consumed') };
  }
  if (!(now < grant.expiresAt)) {
    return { ok: false, refusal: 'expired', reason: reasonForBrokeredRefusal('expired') };
  }
  return { ok: true, grant: { ...grant, consumedAt: now } };
}

/**
 * Record that a session ended cleanly. This is the ONLY way a live session
 * stops being live-before-expiry, and the reason a `stale` verdict is a real
 * finding rather than the normal case: a host that closes its sessions reports
 * `closed`, and one that never does is exactly what the fleet should see.
 */
export function closeBrokeredSession(
  grant: BrokeredSessionGrant | null | undefined,
  now: number,
): BrokeredSessionGrant | null {
  if (!grant) return null;
  if (grant.closedAt !== undefined) return grant;
  return { ...grant, closedAt: now };
}

/**
 * The session's state, in one place so the fleet and the agents cannot disagree.
 *
 *   none     — no grant at all (honest unknown; never reads as stale).
 *   issued   — minted, never used.
 *   open     — used, inside its window, not closed.
 *   closed   — recorded as ended.
 *   expired  — the window passed and NO session was live over it. Benign: an
 *              operator who never showed up left nothing authenticated.
 *   stale    — the window passed on a session that WAS live and was never
 *              recorded closed. Authenticated past its own authorization.
 */
export type BrokeredSessionState = 'none' | 'issued' | 'open' | 'closed' | 'expired' | 'stale';

/** Classify a grant at `now`. Never throws; a malformed grant reads `none`. */
export function brokeredSessionState(
  grant: BrokeredSessionGrant | null | undefined,
  now: number,
): BrokeredSessionState {
  if (!grant || !Number.isFinite(grant.expiresAt)) return 'none';
  if (grant.closedAt !== undefined) return 'closed';
  const withinWindow = now < grant.expiresAt;
  if (grant.consumedAt === undefined) {
    // Never used. Past the window it is expired, NOT stale — nothing was
    // authenticated, so there is no session to have outlived anything.
    return withinWindow ? 'issued' : 'expired';
  }
  return withinWindow ? 'open' : 'stale';
}

/**
 * The blocker token a grant contributes, or `null` when it contributes none.
 *
 * Returns literally `'stale'` — the token already declared in
 * `REMOTE_BLOCKER_PRIORITY` — so there is ONE spelling of it in the tree. Only
 * a live session past its window qualifies (see brokeredSessionState).
 */
export function brokeredSessionBlocker(
  grant: BrokeredSessionGrant | null | undefined,
  now: number,
): 'stale' | null {
  return brokeredSessionState(grant, now) === 'stale' ? 'stale' : null;
}

/**
 * Fold an overrun session into the advert the fleet already understands.
 *
 * ADDITIVE ONLY — this can add `stale` and can never remove a blocker, clear
 * `off`, or flip `enabled`. That direction is load-bearing: a session window is
 * an additional reason to distrust a channel, never a reason to trust one, so a
 * bug here can only make the verdict stricter. When there is no grant, or the
 * grant contributes nothing, the advert is returned UNCHANGED (same reference
 * where possible) so the absent-never-clobbers contract holds.
 *
 * `stale` is only attached to an ENABLED channel: a device whose channel is off
 * has no authenticated session to outlive, and inventing a blocker there would
 * send an operator to revoke something that is not listening.
 */
export function applyBrokeredSessionWindow(
  advert: RemoteAccessAdvert | null | undefined,
  grant: BrokeredSessionGrant | null | undefined,
  now: number,
): RemoteAccessAdvert | null | undefined {
  if (!advert || !advert.enabled) return advert;
  const blockers = advert.blockers ?? [];
  const stale = brokeredSessionBlocker(grant, now);
  if (!stale || blockers.includes(stale)) return advert;
  const merged = [...blockers, stale];
  // Re-emit in PRIORITY order so the stored JSONB is stable regardless of the
  // order the extra token arrived in (same contract as normalizeRemoteAccess).
  const ordered = REMOTE_BLOCKER_PRIORITY.map((b) => b.token).filter((t) => merged.includes(t));
  return { ...advert, blockers: ordered };
}
/**
 * Turn-failure classification (log-signal family 5ae52ca3, 2026-10-24).
 *
 * The coding loop's turn-failure catch (agent.ts) distinguishes a STATUS-LESS
 * transport abort — the exact 'aborted' message, no HTTP status, no drained
 * provider body — from every other failure shape. The audit detector pinned
 * this as a known graceful-degradation signature (f184 bb77c1b9a, sig 5: the
 * premature gateway close), and the loop is designed to survive it (the
 * transient lane retries; failed_runs stays 0), so those rows are tagged
 * logClass:'external' for the log-signal sweep.
 *
 * The predicate is DELIBERATELY exact (f184's conservative axis): anything
 * wider would tag real, sweep-worthy fault shapes —
 *   - an HTTP 429/5xx 'aborted' is a load/gateway signal, not a clean close;
 *   - a drained body means the provider SPOKE (a diagnosable provider error);
 *   - ECONNRESET / status-code messages are different failure classes.
 * Exported from this import-free leaf so the replay test pins the REAL
 * predicate, not a local re-implementation that could drift.
 */

export interface TurnFailureShape {
  message?: string;
  /** HTTP status carried by the error (err.response.status), if any. */
  status?: number;
  /** Body text drained from the error response, if any ('' when none). */
  bodyText?: string;
}

/** True only for the exact status-less premature-gateway-close 'aborted'. */
export function isStatuslessTransportAbort(err: TurnFailureShape): boolean {
  return !err.status
    && !err.bodyText
    && /^aborted$/i.test(String(err.message ?? '').trim());
}

/**
 * A status-less SOCKET-level failure — the dependency we do not control dropped
 * the connection before it could answer. Ticket 0ae066fe (log-signal family,
 * 2026-10-30, 22 rows / 10 hours).
 *
 * `read ECONNRESET` is the canonical shape: Node's socket read was reset by the
 * peer, so there is no HTTP status and no drained provider body (the peer never
 * spoke). The coding loop is DESIGNED to survive it — agent.ts's transient lane
 * matches `/ECONNRESET|ETIMEDOUT|ESTALL|socket hang up/` and retries the same
 * request; failed_runs stays 0. But the emit site tagged only the exact
 * 'aborted' wording as external, so a bare `read ECONNRESET` row sat untagged at
 * warn and the sweep filed it as an internal fault every time, forever.
 *
 * DELIBERATELY NARROW (the f184 conservative axis this module documents):
 *   - an HTTP status means the peer ANSWERED — a 429/5xx reset is a load/gateway
 *     signal and stays sweep-worthy, so any status disqualifies;
 *   - a drained body means the provider SPOKE (a diagnosable provider error);
 *   - only the codes agent.ts's TRANSIENT LANE actually retries match, never
 *     arbitrary wording.
 *
 * THE SET MUST EQUAL THE RETRY LANE (adversarial review, PR #2103 S2): the
 * justification for sweeping a class blind is that the loop is DESIGNED to
 * survive it, so it must be the SAME set agent.ts:4387 retries —
 * `/ECONNRESET|ETIMEDOUT|ESTALL|socket hang up/` plus the second clause's
 * `EPIPE|ECONNABORTED|other side closed|premature close|terminated|stream
 * (ended|closed)`. A wider predicate tags a failure sweep-BLIND that nothing
 * retries, which is strictly worse than filing it. Two codes were dropped for
 * exactly that reason and are pinned OUT below:
 *   - `EAI_AGAIN` (DNS resolution failure) — never retried by that lane;
 *   - `ESOCKETTIMEDOUT` — the lane matches `ETIMEDOUT`, not this one.
 * `ECONNREFUSED` is likewise absent: an unambiguous "the provider is dead"
 * signal must keep reaching the sweep at full volume.
 * Kept in this import-free leaf beside its sibling so the replay test pins the
 * REAL predicate, not a local re-implementation that could drift.
 */
const EXTERNAL_TRANSPORT_CODES = /\b(ECONNRESET|ETIMEDOUT|EPIPE|ECONNABORTED)\b|socket hang up|other side closed|premature close|\bterminated\b|stream (?:ended|closed)/i;

export function isExternalTransportFailure(err: TurnFailureShape): boolean {
  if (err.status) return false;          // the peer answered — its status is the signal
  if (err.bodyText) return false;        // the peer spoke — a diagnosable provider error
  const message = String(err.message ?? '').trim();
  if (!message) return false;
  return EXTERNAL_TRANSPORT_CODES.test(message);
}

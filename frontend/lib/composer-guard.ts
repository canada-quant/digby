/**
 * Composer send/steer routing decisions for the coding-session view
 * (ticket 55e9967d — "I can't send anything to this session").
 *
 * THE WEDGE this module exists to pin: the composer routes Enter to steer()
 * whenever the local `live.running` flag is set. When that flag is STALE
 * (the SSE 'complete' was missed across a deploy flip, a suspended tab, or a
 * silently dead stream), the backend steer endpoint answers 409 "No active
 * run to steer" — and the old fallback then called send(), which re-checked
 * the SAME stale flag and silently returned. No toast, no state change, the
 * draft just sat there: every Enter was a silent no-op, forever.
 *
 * The fix is a decision table with ONE explicit escape: after a server-
 * authoritative 409 the caller passes `bypassRunningGuard: true`, the stale
 * flag is ignored ONCE, and the message goes out as a fresh run. This module
 * keeps that table pure and unit-tested so the wedge cannot regress inside
 * the component's closure spaghetti.
 */

export type SendRoute = 'skip' | 'proceed' | 'steer-reroute' | 'queue-until-ready' | 'blocked-toast';

/**
 * Where a composer send should go.
 *
 * - `skip`          — silent no-op (no session, no content, or a genuinely
 *                     live run: the composer routes Enter to steer() instead).
 * - `proceed`       — start a fresh run.
 * - `steer-reroute` — the session row says 'running' but no stream is
 *                     attached: reconcile + steer into the server-side run
 *                     (the owner "smash enter" fix, 2026-08-28).
 * - `queue-until-ready` — the worktree is still provisioning: keep the message
 *                     (lib/provision-queue.ts) and send it the moment the
 *                     session reads 'ready' (owner 2026-10-14 — never the old
 *                     "Session is still provisioning — one moment" toast).
 * - `blocked-toast` — error / unknown state: explain and stop.
 *
 * `bypassRunningGuard` is ONLY legitimate immediately after the steer
 * endpoint answered 409 ("no active run") — the local running flag and the
 * cached session status are both proven stale, so the send must not loop
 * back into the same dead steer.
 */
export function routeSend(args: {
  hasSession: boolean;
  hasContent: boolean;
  liveRunning: boolean;
  sessionStatus?: string;
  bypassRunningGuard?: boolean;
}): SendRoute {
  if (!args.hasSession || !args.hasContent) return 'skip';
  // A live run owns the composer — Enter goes to steer, never a fresh run.
  // (The bypass is honored below, not here: after a 409 there IS no live run,
  // and skipping again would re-wedge.)
  if (args.liveRunning && !args.bypassRunningGuard) return 'skip';
  if (args.sessionStatus === 'ready') return 'proceed';
  if (args.sessionStatus === 'running') {
    // Without a bypass the run may be alive server-side — reconcile + steer.
    // With it, the server JUST said "no active run": the status is stale too,
    // so try the fresh run instead of looping steer → 409 → steer → 409 …
    return args.bypassRunningGuard ? 'proceed' : 'steer-reroute';
  }
  if (args.sessionStatus === 'provisioning') return 'queue-until-ready';
  return 'blocked-toast';
}

export type SteerFailure = 'fallback-send' | 'toast';

/**
 * Classify a steer POST failure. 409 is the server's authoritative "no
 * active run to steer" — the caller must reconcile the stale running state
 * and fall back to a normal (bypassing) send. Anything else is a generic
 * transient failure → toast.
 */
export function classifySteerFailure(status: number | undefined): SteerFailure {
  return status === 409 ? 'fallback-send' : 'toast';
}

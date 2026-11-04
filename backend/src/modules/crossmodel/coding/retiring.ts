/**
 * Retiring-colour flag (2026-09-18 — the deploy-replay tax).
 *
 * THE BUG: after the nginx flip, deploy-blue-green.sh drains the OLD colour by
 * polling its /drain-status until in-flight chat runs hit 0 (bounded at
 * DRAIN_MAX_SECONDS = 20 min). But the old process kept STARTING new machine
 * runs while draining — every hook event it emitted (instant delivery), every
 * run-finalize queue drain and every schedule firing it claimed landed on the
 * retiring process — so the drain never converged: the 2026-09-18 18:16Z wave
 * waited the full 1200 s for a Fleet Supervisor wake that had started AFTER
 * the flip, then killed it at 18:36:29 (deploy-interrupt → replay). 38
 * replays on 2026-09-17, 12 on 09-18 — each one a 10–20 min machine run
 * thrown away and re-run.
 *
 * THE FIX: the deploy script marks the old backend RETIRING (POST
 * /drain-status/retire, localhost-bound like the GET) the moment the drain
 * begins. A retiring process refuses to START machine-triggered chat runs
 * (startDetachedChatRun returns null → callers take their existing "busy"
 * lanes: hooks park with attempts frozen, schedule firings queue behind the
 * chat, queued messages stay for the new colour's orphan sweeper). In-flight
 * runs finish; user-typed turns are never refused (nginx already routes them
 * to the new colour). Process-local by design — the flag IS the process's
 * own retirement; nothing else should read it.
 *
 * Dependency-free leaf (app.ts, chat-agent.service.ts and tests import it).
 */

let retiringSince: Date | null = null;

/** Mark this process retiring (idempotent — the first call's time sticks). */
export function markRetiring(now: Date = new Date()): Date {
  if (!retiringSince) retiringSince = now;
  return retiringSince;
}

/** Is this process the OLD colour of a deploy in its drain window? */
export function isRetiring(): boolean {
  return retiringSince !== null;
}

export function retiringSinceIso(): string | null {
  return retiringSince ? retiringSince.toISOString() : null;
}

/** Test seam. */
export function __resetRetiringForTests(): void {
  retiringSince = null;
}

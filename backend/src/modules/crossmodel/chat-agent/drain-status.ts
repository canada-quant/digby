/**
 * /drain-status payload builder (WI-G, 2026-09-25 — finish long supervisor
 * wakes in place across deploys).
 *
 * THE GAP: the blue-green drain (deploy-blue-green.sh) polls the OLD colour's
 * /drain-status until its chat runs hit 0, bounded at DRAIN_MAX_RETIRING_SECONDS
 * (900 s). A glm-5.3 reasoning-max supervisor wake runs 8–16 min, so the cut
 * still landed ~3×/day (chat_run_interrupted reason=deploy) — every one a
 * 10–20 min run thrown away and replayed on the new colour.
 *
 * THE FIX (this half): the payload now carries PER-RUN detail — {runId, chatId,
 * startedAt, isSupervisorWake, lastToolAt} — plus ONE aggregate the deploy
 * script can grep without JSON tooling: `extensionEligible`, true only while
 * the process is retiring AND every remaining chat run is a supervisor-class
 * wake that made a tool call within DRAIN_PROGRESS_WINDOW_MS (progressing, not
 * wedged) AND no late cross-check reconcile is pending. The script's bounded
 * one-time budget extension keys on exactly that flag (default OFF there).
 *
 * The pre-WI-G fields (activeRuns / chatRuns / lateCrossChecks / uptime /
 * retiring / retiringSince) are unchanged — the script's `"activeRuns":N`
 * sed still matches.
 *
 * RESEARCH (2026-10-20 — deep research has no wall clock, council-dispatch.ts researchNoWallClock): a research council
 * can legitimately outlive the 900 s retiring budget, and the cut requeued it from its receipts. A second aggregate,
 * `researchExtensionEligible`, is true only while retiring, no late cross-check is pending, at least one remaining run
 * is a research council (`isResearchCouncil`, stamped by the chat-agent) and EVERY remaining run is either a progressing
 * research council — its latest progress beat (a real model / tool event of the lead or a colleague, live-runs
 * noteRunProgress) or tool event is no older than the council's stall window (COUNCIL_STALL_MS — a council quiet
 * that long has STALLED and is not worth waiting for) — or a progressing supervisor wake. The deploy script's
 * research-only extension (DRAIN_RESEARCH_EXTENSION_SECONDS) keys on it; `extensionEligible` keeps its exact rule.
 * RESEARCH_NO_WALL_CLOCK_DISABLED=1 ⇒ researchExtensionEligible is always false (today's eligibility).
 */

import { listActiveRunDetails } from '../coding/live-runs';
import { pendingLateCrossCheckCount } from './late-crosscheck';
import { isRetiring, retiringSinceIso } from '../coding/retiring';
import { councilStallMs, researchNoWallClock } from './council-dispatch';

/** A run counts as PROGRESSING when its last tool event is at most this old (default 120 s; env DRAIN_PROGRESS_WINDOW_SECONDS). */
export function drainProgressWindowMs(): number {
  const raw = Number(process.env.DRAIN_PROGRESS_WINDOW_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 1000) : 120_000;
}

export interface DrainRunDetail {
  runId: string;
  chatId: string | null;
  startedAt: string;
  ageSeconds: number;
  isSupervisorWake: boolean;
  machineTriggered: boolean;
  lastToolAt: string | null;
  /** seconds since the last tool event, or null when none yet */
  sinceToolSeconds: number | null;
  /** last tool event within the progress window */
  progressing: boolean;
  /** an unclocked research council run (live-run meta isResearchCouncil) */
  isResearchCouncil: boolean;
  /** seconds since the run's latest progress beat or tool event, or null when neither yet */
  sinceProgressSeconds: number | null;
  /** a research council whose latest beat / tool event is inside the stall window (not stalled) */
  researchProgressing: boolean;
}

export interface DrainStatus {
  activeRuns: number;
  chatRuns: number;
  lateCrossChecks: number;
  uptime: number;
  retiring: boolean;
  retiringSince: string | null;
  runs: DrainRunDetail[];
  /** every remaining chat run is a progressing supervisor wake, nothing else pending, process retiring */
  extensionEligible: boolean;
  /** ≥ 1 progressing research council and every other run a progressing research council / supervisor wake, nothing else pending, process retiring */
  researchExtensionEligible: boolean;
  progressWindowSeconds: number;
}

/** Pure shape of one run row — exported for tests. `researchWindowMs`: the research council stall window (default COUNCIL_STALL_MS). */
export function shapeDrainRun(r: { runId: string; startedAt: number; lastToolAt: number | null; lastProgressAt?: number | null; chatId?: string; machineTriggered?: boolean; isSupervisorWake?: boolean; isResearchCouncil?: boolean }, nowMs: number, windowMs: number, researchWindowMs: number = councilStallMs()): DrainRunDetail {
  const sinceTool = r.lastToolAt == null ? null : Math.max(0, Math.round((nowMs - r.lastToolAt) / 1000));
  const lastBeat = Math.max(r.lastToolAt ?? -Infinity, r.lastProgressAt ?? -Infinity);
  const hasBeat = Number.isFinite(lastBeat);
  const isResearchCouncil = r.isResearchCouncil === true;
  return {
    runId: r.runId,
    chatId: r.chatId ?? null,
    startedAt: new Date(r.startedAt).toISOString(),
    ageSeconds: Math.max(0, Math.round((nowMs - r.startedAt) / 1000)),
    isSupervisorWake: r.isSupervisorWake === true,
    machineTriggered: r.machineTriggered === true,
    lastToolAt: r.lastToolAt == null ? null : new Date(r.lastToolAt).toISOString(),
    sinceToolSeconds: sinceTool,
    progressing: r.lastToolAt != null && nowMs - r.lastToolAt <= windowMs,
    isResearchCouncil,
    sinceProgressSeconds: hasBeat ? Math.max(0, Math.round((nowMs - lastBeat) / 1000)) : null,
    researchProgressing: isResearchCouncil && hasBeat && nowMs - lastBeat <= researchWindowMs,
  };
}

/** Pure eligibility rule — exported for tests. */
export function extensionEligibleFor(runs: DrainRunDetail[], opts: { retiring: boolean; lateCrossChecks: number }): boolean {
  if (!opts.retiring) return false;
  if (opts.lateCrossChecks > 0) return false;
  if (!runs.length) return false;
  return runs.every((r) => r.isSupervisorWake && r.progressing);
}

/**
 * Pure research eligibility rule — exported for tests. A STALLED research council (no beat inside its stall window),
 * a plain user turn, a wedged supervisor wake or a late cross-check never extends; under
 * RESEARCH_NO_WALL_CLOCK_DISABLED=1 (`disabled`) nothing does.
 */
export function researchExtensionEligibleFor(runs: DrainRunDetail[], opts: { retiring: boolean; lateCrossChecks: number; disabled?: boolean }): boolean {
  if (opts.disabled ?? !researchNoWallClock()) return false;
  if (!opts.retiring) return false;
  if (opts.lateCrossChecks > 0) return false;
  if (!runs.some((r) => r.isResearchCouncil)) return false;
  return runs.every((r) => (r.isResearchCouncil && r.researchProgressing) || (r.isSupervisorWake && r.progressing));
}

export function buildDrainStatus(nowMs: number = Date.now()): DrainStatus {
  const windowMs = drainProgressWindowMs();
  const chatRunsRaw = listActiveRunDetails().filter((r) => r.runId.startsWith('chat:'));
  const runs = chatRunsRaw.map((r) => shapeDrainRun(r, nowMs, windowMs));
  const lateCrossChecks = pendingLateCrossCheckCount();
  const retiring = isRetiring();
  return {
    activeRuns: runs.length + lateCrossChecks,
    chatRuns: runs.length,
    lateCrossChecks,
    uptime: process.uptime(),
    retiring,
    retiringSince: retiringSinceIso(),
    runs,
    extensionEligible: extensionEligibleFor(runs, { retiring, lateCrossChecks }),
    researchExtensionEligible: researchExtensionEligibleFor(runs, { retiring, lateCrossChecks }),
    progressWindowSeconds: Math.round(windowMs / 1000),
  };
}

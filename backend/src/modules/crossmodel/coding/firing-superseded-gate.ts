/**
 * Superseded-firing gate — decision-gate purpose `firing_superseded`
 * (N7, docs/DECISION_MODEL_ENHANCEMENTS_2026-09-25.md §5; shipped SHADOW).
 *
 * WHY: a due recurring firing that finds its lane BUSY is parked and re-armed
 * every ~3 min (`schedule_busy_skip` ≈ 1,154 rows/day) and then runs IN FULL
 * the moment the lane frees — even when the run that held the lane (often the
 * schedule's own previous firing overrunning its cadence, or a hook wake that
 * did the same sweep) already did exactly the work the prompt asks for. The
 * gate asks ONE typed Choice at that claim moment, over facts the HARNESS
 * computes: the schedule prompt (≤2.5k), the finished run's final (≤1.5k) with
 * its code-counted receipts (tools called / evidence-bearing / mutating), how
 * many minutes ago it finished, how long this firing sat parked, and when the
 * next cadence fires anyway.
 *
 * ELIGIBILITY (never widened by any mode): recurring rows only (a one-shot
 * carries a real ask — never gated); MACHINE-authored prompts only
 * (`promptSetBy` 'machine' | 'system'; 'user' and NULL are explicit owner
 * instruction — the dormancy gate's convention); never an owner-subscribed
 * row; only when the row was actually parked (`busySkips > 0`) and a run
 * COMPLETED on the lane since this schedule last fired AND inside the parked
 * window (review follow-up 2026-09-25: "latest completed since lastFiredAt"
 * is not necessarily the run that HELD the lane — when the blocker failed /
 * was cancelled, an earlier hook wake that completed long before the park
 * would otherwise be judged; such a run is `finished_before_park`, the facts
 * still ride the `schedule_parked_claim` metric so shadow rows can be
 * filtered, and the gate is not asked).
 *
 * MODES (decisionMode('firing_superseded'); default shadow, NODE_ENV=test off):
 *   shadow — the firing is UNCHANGED; the stash rides the fired run
 *            (fireScheduleTarget → RunInput.decision) and
 *            decision-outcome-labels.ts labels it from what the run did
 *            (mutating tool or a non-noop evidenced final ⇒ 'fire' was right;
 *            a no-op ⇒ 'drop_superseded' / 'merge_into_next' was right).
 *   act    — DESIGNED, NOT ENABLED (the caller keys on the RESULT's mode, E2):
 *            a confident drop_superseded / merge_into_next (confidence ≥
 *            DECISION_GATE_THRESHOLD_FIRING_SUPERSEDED, default 0.9) SKIPS
 *            the firing: lastStatus 'skipped:superseded' | 'skipped:merged_next',
 *            daily-cap token refunded, busySkips reset, loop metric
 *            schedule_superseded_skip, and the row re-arms at its NEXT natural
 *            cadence (the atomic claim already slid nextRunAt) — no run, no
 *            maxRuns budget. 'fire' is the pre-gate path.
 * Fail-open everywhere: a read error, a null gate answer, a thrown anything ⇒
 * the firing proceeds exactly as before. Kill switches: the gate-wide switches.
 *
 * LEAF: prisma + decision-gate + the label module's pure helpers; the
 * supervisor note classifier is pulled DYNAMICALLY (it would cycle).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import {
  decide, decisionMode, decisionThreshold, recordDecisionOutcome, stashDecision,
  type DecideResult, type DecisionQuestion, type DecisionStash,
} from '../platform/decision-gate';
import { evidenceToolCallCount, toolNamesCalled, tookPlatformAction } from '../platform/decision-outcome-labels';
import { parkedMinutesWithBackoff } from './schedule-cadence';
import { pickTranscriptSource } from './transcript-source';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** The question key on every firing_superseded decision/outcome row. */
export const FIRING_SUPERSEDED_QUESTION = 'disposition';
/** Acting confidence for drop/merge (DECISION_GATE_THRESHOLD_FIRING_SUPERSEDED overrides; clamped by decisionThreshold). */
export const FIRING_SUPERSEDED_DEFAULT_THRESHOLD = 0.9;
/** Gate deadline — the sweeper tick is 30 s; this must stay a small slice of it. */
export const FIRING_SUPERSEDED_TIMEOUT_MS = 4000;
/** Ledger read deadline — past it the gate is NOT asked (no state, no decision). */
export const FIRING_SUPERSEDED_READ_TIMEOUT_MS = 6000;
/** Upper bound on "a run finished since this schedule last fired" (a lane idle for a week is not a parked firing). */
export const FIRING_SUPERSEDED_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The busy re-arm cadence (schedule.service: +3 min per busy skip) — parked minutes = busySkips × this. */
export const BUSY_REARM_MIN = 3;
/** Slack on the parked window (sweeper ticks are 30 s; the first busy skip lands up to a tick after the row became due,
 *  and a re-arm can slip a tick) — a run that finished more than parked + this many minutes ago did not hold the lane. */
export const FINISHED_BEFORE_PARK_SLACK_MIN = 10;
export const SCHEDULE_PROMPT_MAX_CHARS = 2500;
export const FINISHED_FINAL_MAX_CHARS = 1500;
/** lastStatus stamped on an ACT skip. */
export const SUPERSEDED_SKIP_STATUS: Readonly<Record<SupersededSkipDisposition, string>> = {
  drop_superseded: 'skipped:superseded',
  merge_into_next: 'skipped:merged_next',
};

export type FiringDisposition = 'fire' | 'drop_superseded' | 'merge_into_next';
export type SupersededSkipDisposition = Exclude<FiringDisposition, 'fire'>;

/** The schedule-row fields the gate reads (a DueScheduleRow satisfies it). */
export interface ParkedFiringRow {
  id: string;
  sessionId: string;
  prompt: string;
  kind: string;
  intervalSec?: number | null;
  busySkips?: number | null;
  promptSetBy?: string | null;
  ownerSubscribed?: boolean | null;
  lastFiredAt?: Date | null;
  createdAt?: Date | null;
}

/**
 * Is this due row one the gate may judge at all? Pure; the SAME predicate
 * bounds shadow and act, so no mode can ever reach an owner-authored or
 * one-shot row. Returns the reason it is NOT eligible (null = eligible).
 */
export function parkedFiringIneligibleReason(s: ParkedFiringRow): string | null {
  if (s.kind !== 'recurring') return 'one_shot';
  if (!(typeof s.busySkips === 'number' && s.busySkips > 0)) return 'not_parked';
  if (s.promptSetBy !== 'machine' && s.promptSetBy !== 'system') return 'owner_authored';
  if (s.ownerSubscribed === true) return 'owner_subscribed';
  return null;
}

// ── The code-computed state ──────────────────────────────────────────────────

export interface FinishedRunFacts {
  runId: string;
  /** The finished run was THIS schedule's own previous firing (RunInput.scheduleId). */
  wasThisSchedulesFiring: boolean;
  triggerKind: string | null;
  finishedAgoMin: number;
  durationMin: number | null;
  /** Final text head (≤ FINISHED_FINAL_MAX_CHARS). */
  finalHead: string;
  finalChars: number;
  toolCalls: number;
  evidenceCalls: number;
  mutatingCalls: number;
  /** classifySupervisorNote of the final (supervisor vocabulary; 'unclassified' when unavailable). */
  noteKind: string;
  /** The run finished BEFORE this firing was parked (+ slack) — it cannot be the run that held the lane; not judged. */
  finishedBeforePark: boolean;
}

/** Minutes this firing sat parked — the SUM of the busy re-arm delays (flat
 *  3 min each before wake-cadence-6; geometric 3→6→12→24 min capped at half
 *  the cadence under the backoff). Pure. */
export function parkedMinutes(s: Pick<ParkedFiringRow, 'busySkips'> & { intervalSec?: number | null }): number {
  return parkedMinutesWithBackoff(s.busySkips ?? 1, s.intervalSec ?? null);
}

const clip = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The most recent run that COMPLETED on the lane since this schedule last
 * fired (bounded window), with its final and code-counted receipts. null =
 * no such run (the lane was held by something that failed/was cancelled, or
 * by a run outside agent_runs) ⇒ nothing to judge. Throws propagate (the
 * caller fails open).
 */
export async function readFinishedRunFacts(s: ParkedFiringRow, now: Date): Promise<FinishedRunFacts | null> {
  const floor = now.getTime() - FIRING_SUPERSEDED_MAX_WINDOW_MS;
  const sinceMs = Math.max(floor, (s.lastFiredAt ?? s.createdAt ?? new Date(floor)).getTime());
  const run = await prisma.agentRun.findFirst({
    where: { sessionId: s.sessionId, status: 'completed', finishedAt: { gte: new Date(sinceMs) } },
    orderBy: { finishedAt: 'desc' },
    select: { id: true, startedAt: true, finishedAt: true, createdAt: true, input: true },
  });
  if (!run || !run.finishedAt) return null;
  const startedAt = run.startedAt ?? run.createdAt;
  // MERGE-1 slice 1: resolve through the ONE read-switch seam instead of reading
  // coding_messages directly — this was one of six readers invisible to TRANSCRIPT_READ.
  const source = await pickTranscriptSource(s.sessionId);
  const msg = source === 'legacy'
    ? await prisma.codingMessage.findFirst({
        where: { chatId: s.sessionId, role: 'assistant', createdAt: { gte: startedAt } },
        orderBy: { createdAt: 'desc' },
        select: { content: true, parts: true, metadata: true },
      })
    : await prisma.crossModelMessage.findFirst({
        where: { chatId: s.sessionId, role: 'assistant', createdAt: { gte: startedAt } },
        orderBy: { createdAt: 'desc' },
        select: { content: true, parts: true, metadata: true },
      });
  const input = (run.input && typeof run.input === 'object' ? run.input : {}) as Record<string, unknown>;
  const metadata = (msg?.metadata && typeof msg.metadata === 'object' ? msg.metadata : {}) as Record<string, unknown>;
  const toolNames = toolNamesCalled(msg?.parts);
  const content = String(msg?.content ?? '');
  let noteKind = 'unclassified';
  try {
    const { classifySupervisorNote } = await import('../platform/supervisor.service');
    noteKind = classifySupervisorNote(content);
  } catch { noteKind = 'unclassified'; }
  const finishedAgoMin = Math.max(0, Math.round((now.getTime() - run.finishedAt.getTime()) / 60000));
  return {
    runId: run.id,
    wasThisSchedulesFiring: input.scheduleId === s.id,
    triggerKind: typeof metadata.triggerKind === 'string' ? metadata.triggerKind : (typeof input.triggerKind === 'string' ? input.triggerKind : null),
    finishedAgoMin,
    finishedBeforePark: finishedAgoMin > parkedMinutes(s) + FINISHED_BEFORE_PARK_SLACK_MIN,
    durationMin: run.startedAt ? Math.max(0, Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 60000)) : null,
    finalHead: clip(content, FINISHED_FINAL_MAX_CHARS),
    finalChars: content.length,
    toolCalls: toolNames.length,
    evidenceCalls: evidenceToolCallCount(toolNames),
    mutatingCalls: toolNames.filter((n) => tookPlatformAction([n])).length,
    noteKind,
  };
}

/** The gate state — numbers first, prose last. Pure; ≤ ~4.5k chars. */
export function buildFiringSupersededState(s: ParkedFiringRow, facts: FinishedRunFacts, now: Date): Record<string, unknown> {
  const busySkips = Math.max(1, s.busySkips ?? 1);
  const intervalMin = Math.max(1, Math.round((s.intervalSec ?? 3600) / 60));
  const lastFiredAgoMin = s.lastFiredAt ? Math.max(0, Math.round((now.getTime() - s.lastFiredAt.getTime()) / 60000)) : null;
  const state: Record<string, unknown> = {
    firing: 'a recurring machine-authored schedule firing that was parked because a run held its lane; the lane is now free',
    parked_minutes: parkedMinutes(s),
    busy_skips: busySkips,
    cadence_minutes: intervalMin,
    next_cadence_fires_in_minutes: intervalMin,
    minutes_since_this_schedule_last_fired: lastFiredAgoMin ?? undefined,
    finished_run: {
      was_this_schedules_own_previous_firing: facts.wasThisSchedulesFiring,
      trigger: facts.triggerKind ?? undefined,
      finished_minutes_ago: facts.finishedAgoMin,
      duration_minutes: facts.durationMin ?? undefined,
      tool_calls: facts.toolCalls,
      evidence_bearing_calls: facts.evidenceCalls,
      mutating_platform_calls: facts.mutatingCalls,
      final_class: facts.noteKind,
      final_chars: facts.finalChars,
    },
    schedule_prompt: clip(s.prompt, SCHEDULE_PROMPT_MAX_CHARS),
    finished_run_final: facts.finalHead || undefined,
  };
  for (const k of Object.keys(state)) if (state[k] === undefined) delete state[k];
  const fr = state.finished_run as Record<string, unknown>;
  for (const k of Object.keys(fr)) if (fr[k] === undefined) delete fr[k];
  return state;
}

/** The typed question. */
export const FIRING_SUPERSEDED_QUESTIONS: Record<string, DecisionQuestion> = {
  [FIRING_SUPERSEDED_QUESTION]: {
    type: 'choice',
    instructions: 'A recurring machine schedule was due, found its lane busy, and waited. The run that held the lane has now finished. Given the schedule prompt and what that run actually did, should the parked firing still run now?',
    criteria: {
      fire: 'the finished run did NOT cover what the schedule prompt asks for (different task, different scope, or it produced no real work), so running the firing now does real work',
      drop_superseded: 'the finished run already did the work this firing would do (same sweep / check / report, evidenced by its receipts), so running it now would repeat that work — drop this firing and let the next cadence run',
      merge_into_next: 'the finished run covered most of it and the little that remains is better folded into the next cadence (fires soon anyway) than run as a full turn now',
    },
  },
};

// ── backlog E09 (2026-09-28): the call-site ORDERING that starved the purpose ──
// schedule.service consulted this gate only when NO other stash rode the firing
// (`!deltaDecision && !sweepDecision`), and a busy-parked STOCK SWEEP — the
// bulk of parked firings — always carries a sweep_triage stash, so the ask
// never happened: 0 decision rows all-time (the "label biased toward fire"
// note described rows that did not exist). The gate is now asked for EVERY
// eligible parked row; when a primary stash already rides the firing the
// superseded stash rides as its SIBLING (DecisionStash.also — the
// supervisor_turn_noop pattern) and the finalize labels it from the same run
// evidence. Act (tier 2, designed only) still skips the firing when confident;
// the sibling stashes of a skipped firing are closed unlabelled so every
// decision row pairs with one outcome.

/** Pure: does the schedule site consult this gate for the due row? (The leaf re-checks full eligibility.) */
export function supersededAskEligibleAtSite(s: Pick<ParkedFiringRow, 'kind' | 'busySkips'>): boolean {
  if (s.kind !== 'recurring' || !(typeof s.busySkips === 'number' && s.busySkips > 0)) return false;
  return true;
}

/** Close a superseded stash whose firing never started (a skip by another gate, a busy re-arm, a steer) — unlabelled, so the decision row still pairs. Never throws. */
export function closeUnstartedSupersededStash(stash: DecisionStash | null | undefined, sessionId: string, reason: string): void {
  try {
    if (!stash || stash.purpose !== 'firing_superseded') return;
    const decision: DecideResult = { id: stash.id, answers: stash.answers, backend: stash.backend, ms: 0, mode: stash.mode, ...(stash.backendSpec ? { backendSpec: stash.backendSpec } : {}) };
    recordDecisionOutcome(decision, 'firing_superseded', { question: FIRING_SUPERSEDED_QUESTION, actual: null, acted: false, sessionId, note: `not started: ${reason}`.slice(0, 160) });
  } catch { /* telemetry never throws */ }
}

// ── The consumer entry point (called from coding/schedule.service processDueScheduleRow) ──

export interface FiringSupersededResult {
  /** Why the gate was not consulted (null = it was). */
  ineligible: string | null;
  facts: FinishedRunFacts | null;
  decision: DecideResult | null;
  /** SHADOW/ACT-fired: the stash the firing carries to its finalize (null when labels are off or no decision). */
  stash: DecisionStash | null;
  /** ACT only: the caller skips this firing. */
  skip: { disposition: SupersededSkipDisposition; confidence: number; finishedRunId: string } | null;
}

const NO_GATE = (ineligible: string | null, facts: FinishedRunFacts | null = null): FiringSupersededResult => ({ ineligible, facts, decision: null, stash: null, skip: null });

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Pre-gate ONE due firing that had been busy-parked. Ineligible rows and
 * mode 'off' return without touching the DB or the seat.
 * Never throws — every failure returns NO_GATE so the firing proceeds
 * unchanged.
 */
export async function preGateParkedFiring(s: ParkedFiringRow, now: Date = new Date()): Promise<FiringSupersededResult> {
  try {
    const ineligible = parkedFiringIneligibleReason(s);
    if (ineligible) return NO_GATE(ineligible);
    const mode = decisionMode('firing_superseded');
    if (mode === 'off') return NO_GATE('mode_off');

    const facts = await withTimeout(readFinishedRunFacts(s, now), FIRING_SUPERSEDED_READ_TIMEOUT_MS, 'finished-run read');
    if (!facts) return NO_GATE('no_finished_run');
    // The latest completed run predates the parked window: the lane was held
    // by something else (a failed / cancelled run, or one outside agent_runs)
    // — nothing to judge; the facts still ride the parked-claim metric.
    if (facts.finishedBeforePark) return NO_GATE('finished_before_park', facts);

    const decision = await decide(buildFiringSupersededState(s, facts, now), FIRING_SUPERSEDED_QUESTIONS, {
      purpose: 'firing_superseded', timeoutMs: FIRING_SUPERSEDED_TIMEOUT_MS, sessionId: s.sessionId,
    });
    if (!decision) return NO_GATE(null, facts);

    const a = decision.answers[FIRING_SUPERSEDED_QUESTION];
    const choice = a && a.type === 'choice' ? a.choice : 'fire';
    const confidence = a && a.type === 'choice' ? a.confidence : 0;
    const threshold = decisionThreshold('firing_superseded', FIRING_SUPERSEDED_DEFAULT_THRESHOLD);
    const skipChoice = choice === 'drop_superseded' || choice === 'merge_into_next' ? (choice as SupersededSkipDisposition) : null;
    // E2 (2026-09-25): the RESULT's mode gates acting — an uncalibrated backend answers as 'shadow'.
    if (decision.mode === 'act' && skipChoice && confidence >= threshold) {
      recordDecisionOutcome(decision, 'firing_superseded', {
        question: FIRING_SUPERSEDED_QUESTION, actual: null, acted: true, sessionId: s.sessionId,
        note: `skipped parked firing (${skipChoice} ${confidence.toFixed(2)}; finished run ${facts.runId.slice(0, 8)} ${facts.finishedAgoMin}m ago)`,
      });
      return { ineligible: null, facts, decision, stash: null, skip: { disposition: skipChoice, confidence, finishedRunId: facts.runId } };
    }
    return { ineligible: null, facts, decision, stash: stashDecision(decision, 'firing_superseded'), skip: null };
  } catch (err: any) {
    logger.warn(`firing-superseded-gate: ${s.id} failed open (${err?.message ?? err}) — the firing proceeds as before`);
    return NO_GATE('error');
  }
}

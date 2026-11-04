/**
 * turn_plan outcome labels — dynamic roster phase 2 (docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md).
 * Owner 2026-10-03: the router learns from Dig-deeper taps, re-asks, thumbs and
 * offline replays only — never from live exploration.
 *
 * `actual` on a `turn_plan` outcome row is the lane the turn turned out to NEED:
 *   Dig-deeper tap ≤ 30 min      → the next lane up        label 'escalated' (primary)
 *   window closed, never tapped  → the predicted lane      label 'escalated' (primary; weak "no complaint")
 *   re-ask ≤ 5 min               → the next lane up        label 'reask_5m'
 *   thumbs down / up             → next lane up / predicted label 'thumbs'
 * The persisted record is metadata.depth.turnPlan (turn-plan.ts turnPlanMetadata):
 * { lane, act, stash, … }. One primary row per decision: the tap stamps
 * `labelledAt` through the window closer's own guard (a tapped row has
 * escalations, which the closer skips). Never throws; kill switch
 * TURN_PLAN_LABELS_DISABLED=1.
 *
 * Label hygiene (roster 2026-10-06 B-1 — readiness report #1: 59 % of the
 * "real" turn_plan labels were supervisor-chat turns the plan never acts on,
 * and a window-close "held" label recorded the PREDICTED lane even when the
 * user saw a different run):
 *   - SUPERVISOR rows never enter the fit: the harness no longer ASKS the turn
 *     plan on a supervisor-class chat (chat-agent.service.ts; the kill switch
 *     TURN_PLAN_SUPERVISOR_SKIP_DISABLED=1 asks again, then the ask carries
 *     segment 'supervisor' and the record `supervisor:true`); a stored row from
 *     before (its compute_policy stash says segment 'supervisor', or the record
 *     says so) is written excludeFromFit;
 *   - the COUNTERFACTUAL rule: a label for a lane that did NOT run is written
 *     excludeFromFit (+ extra.ranLane / counterfactual) — the user's signal
 *     speaks to the lane they saw, not the predicted one. The ran lane comes
 *     from the record's `ran` (turnPlanMetadata, roster 2026-10-06) or, for an
 *     older row, from metadata.depth.plan / facts (ranLaneFromDepth). Unknown ⇒
 *     today's behaviour (the row enters). Kill switch
 *     TURN_PLAN_COUNTERFACTUAL_LABELS_DISABLED=1.
 */

import { reconstructDecision, recordDecisionOutcome } from '../platform/decision-gate';
import { LANES, TURN_PLAN_PURPOSE, type Lane } from '../platform/turn-plan';

export const TURN_PLAN_ESCALATION_WINDOW_MS = 30 * 60_000;

export function turnPlanLabelsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const s = String(env.TURN_PLAN_LABELS_DISABLED ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
}

/** The next lane up (research stays research). Pure. */
export function nextLaneUp(l: Lane): Lane {
  const i = LANES.indexOf(l);
  return i < 0 ? 'checked' : LANES[Math.min(LANES.length - 1, i + 1)];
}

export interface TurnPlanRecord {
  lane: Lane; act: boolean; stash: unknown; lead: string | null; synthetic: boolean;
  /** roster 2026-10-06 B-1: the lane the turn actually RAN (null = unknown — an older row with no depth plan). */
  ranLane: Lane | null;
  /** roster 2026-10-06 B-1: a supervisor-class chat's turn (never fit evidence — the plan never acts there). */
  supervisor: boolean;
}

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** roster 2026-10-06 B-1: TURN_PLAN_SUPERVISOR_SKIP_DISABLED=1 — the turn plan is asked on supervisor chats again (tagged supervisor, excluded from fit). */
export function turnPlanSupervisorSkipDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.TURN_PLAN_SUPERVISOR_SKIP_DISABLED);
}
/** roster 2026-10-06 B-1: TURN_PLAN_COUNTERFACTUAL_LABELS_DISABLED=1 — a label for a lane that did not run enters the fit again (the pre-2026-10-06 rule). */
export function turnPlanCounterfactualLabelsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.TURN_PLAN_COUNTERFACTUAL_LABELS_DISABLED);
}

/** roster 2026-10-06 B-1: the loop_metrics kind of the turn-plan hygiene decisions (a supervisor-chat ask skipped). Literal so partial LOOP_METRIC_KINDS mocks cannot drop it. */
export const TURN_PLAN_HYGIENE_KIND = 'turn_plan_hygiene';

const asObj = (v: unknown): Record<string, any> => (v && typeof v === 'object' ? v as Record<string, any> : {});
const isLane = (v: unknown): v is Lane => (LANES as readonly string[]).includes(v as string);

/**
 * The lane a turn RAN, from its persisted metadata.depth (pure; roster 2026-10-06 B-1):
 * the record's own `ran.lane` when stamped; else the Quick act (`turnPlan.act` /
 * `plan.lane 'quick'`); else the depth plan — a council preset ⇒ research, a checker
 * that spawned (facts.checkerSpawned, else plan.spawnChecker) ⇒ checked, otherwise
 * standard. No plan ⇒ null (unknown — the caller keeps today's behaviour).
 */
export function ranLaneFromDepth(metadata: unknown): Lane | null {
  const depth = asObj(asObj(metadata).depth);
  const tp = asObj(depth.turnPlan);
  if (isLane(asObj(tp.ran).lane)) return asObj(tp.ran).lane;
  const plan = asObj(depth.plan);
  if (tp.act === true || plan.lane === 'quick') return 'quick';
  if (!plan.preset) return null;
  if (plan.preset === 'deep_research' || plan.preset === 'deep_research_all') return 'research';
  const facts = asObj(depth.facts);
  const checker = typeof facts.checkerSpawned === 'boolean' ? facts.checkerSpawned : plan.spawnChecker === true;
  return checker ? 'checked' : 'standard';
}

/** The roster a turn RAN (persisted beside the predicted one as metadata.depth.turnPlan.ran). Pure. */
export interface RanRoster { lane: Lane; lead: string | null; checker: string | null; colleagues: string[] }

/** Compose the ran roster from what the harness knows at finalize (pure; roster 2026-10-06 B-1). */
export function ranRosterOf(i: { quick: boolean; council: boolean; checkerSpawned: boolean; lead: string | null | undefined; checker?: string | null; colleagues?: ReadonlyArray<string | null | undefined> }): RanRoster {
  const lane: Lane = i.quick ? 'quick' : i.council ? 'research' : i.checkerSpawned ? 'checked' : 'standard';
  const colleagues = i.council ? [...new Set((i.colleagues ?? []).filter((m): m is string => typeof m === 'string' && !!m))] : [];
  return { lane, lead: i.lead ?? null, checker: i.checkerSpawned && !i.quick && !i.council ? (i.checker ?? null) : null, colleagues };
}

/** metadata.depth.turnPlan → what a label needs, or null (no plan / no decision). Pure. */
export function turnPlanFromMetadata(metadata: unknown): TurnPlanRecord | null {
  const meta = metadata && typeof metadata === 'object' ? metadata as Record<string, any> : null;
  const tp = meta?.depth?.turnPlan;
  if (!tp || typeof tp !== 'object' || !tp.stash || typeof tp.stash !== 'object') return null;
  const lane = (LANES as readonly string[]).includes(tp.lane) ? (tp.lane as Lane) : null;
  if (!lane) return null;
  // P3 (2026-10-05): the writer stamps synthetic:true on bench/e2e answer rows
  // (chat-agent.service.ts, same flag as the UX_TTFT row). Those labels are
  // proxies that must never move turn_plan's fit / act-band / auto-demote evidence.
  const synthetic = tp.synthetic === true;
  // roster 2026-10-06 B-1: a supervisor-class chat's row — stamped by the writer when the
  // kill switch asks there again, or (rows from before) read off the compute_policy stash.
  const supervisor = tp.supervisor === true || meta?.depth?.decision?.segment === 'supervisor';
  return { lane, act: tp.act === true, stash: tp.stash, lead: typeof tp.roster?.lead === 'string' ? tp.roster.lead : null, synthetic, ranLane: ranLaneFromDepth(meta), supervisor };
}

export type TurnPlanSignal = 'tap' | 'window_closed' | 'reask' | 'thumbs_up' | 'thumbs_down';

/** The lane a signal says the turn needed. Pure. */
export function actualLaneFor(predicted: Lane, signal: TurnPlanSignal): Lane {
  return signal === 'tap' || signal === 'reask' || signal === 'thumbs_down' ? nextLaneUp(predicted) : predicted;
}

const LABEL_OF: Record<TurnPlanSignal, string> = { tap: 'escalated', window_closed: 'escalated', reask: 'reask_5m', thumbs_up: 'thumbs', thumbs_down: 'thumbs' };

/**
 * Write ONE turn_plan outcome row for a signal on an answer row. `messageCreatedAt`
 * bounds a tap to the 30-min primary window (a later tap writes 'escalated_late',
 * a secondary row). Returns the label written, or false. Never throws.
 */
export function labelTurnPlan(metadata: unknown, signal: TurnPlanSignal, opts: { sessionId?: string; messageCreatedAt?: Date | string | null; now?: Date } = {}): string | false {
  try {
    if (turnPlanLabelsDisabled()) return false;
    const rec = turnPlanFromMetadata(metadata);
    if (!rec) return false;
    const decision = reconstructDecision(rec.stash);
    if (!decision) return false;
    let label = LABEL_OF[signal];
    if (signal === 'tap' && opts.messageCreatedAt) {
      const ageMs = (opts.now ?? new Date()).getTime() - new Date(opts.messageCreatedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs > TURN_PLAN_ESCALATION_WINDOW_MS) label = 'escalated_late';
    }
    const actual = actualLaneFor(rec.lane, signal);
    // roster 2026-10-06 B-1: the counterfactual rule — the signal speaks to the lane the
    // user SAW; when that is not the predicted lane the row is a fact, never fit evidence.
    const counterfactual = !turnPlanCounterfactualLabelsDisabled() && rec.ranLane !== null && rec.ranLane !== rec.lane;
    const exclude = rec.synthetic || rec.supervisor || counterfactual;
    const why = [rec.synthetic ? 'synthetic' : '', rec.supervisor ? 'supervisor chat' : '', counterfactual ? `counterfactual (ran ${rec.ranLane})` : ''].filter(Boolean).join(', ');
    recordDecisionOutcome(decision, TURN_PLAN_PURPOSE, {
      question: 'lane', actual, acted: rec.act, label,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      // P3 (2026-10-05): synthetic rows (bench/e2e answer rows the writer stamps
      // metadata.depth.turnPlan.synthetic) are proxy labels — they must never
      // move turn_plan's fit / act-band / durable-demote evidence.
      // roster 2026-10-06 B-1: neither may a supervisor-chat row or a lane that did not run.
      ...(exclude ? { excludeFromFit: true } : {}),
      note: `${signal}: predicted ${rec.lane}${actual !== rec.lane ? ` → needed ${actual}` : ' held'}${why ? `; ${why} — excluded from fit` : ''}`,
      extra: {
        signal, predictedLane: rec.lane, ...(rec.lead ? { lead: rec.lead } : {}), ...(rec.synthetic ? { synthetic: true } : {}),
        ...(rec.ranLane ? { ranLane: rec.ranLane } : {}), ...(counterfactual ? { counterfactual: true } : {}), ...(rec.supervisor ? { supervisor: true } : {}),
      },
    });
    return label;
  } catch {
    return false;
  }
}

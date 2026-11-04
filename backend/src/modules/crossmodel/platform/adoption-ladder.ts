/**
 * ADOPTION LADDER signal (tt-rd audit 2026-09-27, "kpi-honesty-loops" finding 3).
 *
 * Why: no detector in the framework could see a lane that is BUSY, produces a
 * DIFFERENT artifact every firing, and never moves the KPI. The idle-cadence
 * classifier (supervisor-state.service judgeIdleCadence), the attention
 * watchdog's STUCK rule and both supervisors' STUCK doctrine all key on
 * IDENTICAL / no-op content, and the doctrine counted any artifact as
 * progress — so a 4.5-day, ≥19-rung hypothesis ladder (27 firings, 13
 * EXONERATED / REFUTED / NULL verdicts, 0 adoptions, ≈$300) with the KPI flat
 * at 5.08 tok/s since 09-21 tripped nothing and nobody redirected it.
 *
 * What this is: a HARNESS-MEASURED, observe-only signal per (goal, assignee
 * lanes) — `experiments` = completed agent runs on the goal's assignee lanes
 * since the goal's `kpi:` premise last moved toward its bar by a receipted
 * value (premise history, finding 2a), and `hours` since that move. Rendered
 * on the goal's [BOARD] line, the owner status card's KPI row and the lane's
 * [SCHEDULE STATE] block; at K experiments (ADOPTION_LADDER_K, 8) or H hours
 * (ADOPTION_LADDER_HOURS, 48 — only with ≥ 1 experiment in the window) the
 * project supervisor's next wake carries ONE [NO-ADOPTION] block (deduped
 * 24 h per goal in Redis — the follow-through idiom — and re-sent only on NEW
 * evidence: more experiments, or a fresh ladder after a KPI move) whose
 * doctrine answer is mandatory: re-plan with the next lever and its
 * falsifiable adoption criterion, or escalate STUCK-SINCE with the KPI
 * receipt. Never bounces, never cards, never stops a lane (the wake never
 * instructs pause_schedule either). A goal WITHOUT a kpi: premise has no
 * adoption signal — registering one is the incentive; a goal whose value
 * already satisfies its bar, or that is BLOCKED, has none either (nothing is
 * left to adopt toward / its lanes are not expected to move it) — fixer
 * follow-up 2, 2026-09-27: those states tripped the hours branch and produced
 * a daily paid no-op wake asserting artifacts the harness never measured.
 *
 * Failure posture: every read fails toward "no signal"; the sweep never throws
 * into the cron loop. Telemetry:
 * loop_metrics kind adoption_ladder {goalId, projectId, lane, experiments,
 * hours, kpiKey} — one row per wake sent.
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from './loop-metrics.service';
import { getProjectSupervisorsEnabled, recordSupervisorSwitchSkip } from './supervisor-switch';
import { readPremises } from './premise-register';
import {
  kpiPremiseOf, kpiValueText, kpiBarText, kpiBarMet, normalizeKpiBarDirection, stampMdHm, formatAge, effectiveKpiBar,
  adoptionLadderK, adoptionLadderHours,
  type KpiPremiseLike, type PremiseValueStamp,
} from './kpi-of-record';

/** The thresholds live in kpi-of-record.ts (a leaf) so the doctrine's per-lever budget reads the SAME numbers; re-exported for the sweep's callers and tests. */
export { adoptionLadderK, adoptionLadderHours };

const SOURCE = 'adoption-ladder';

export const ADOPTION_LADDER_DEDUPE_SEC = 24 * 3600;
/** Lifetime of the "what the last wake already said" stamp: a goal is re-woken only on NEW evidence (a higher experiment count on the same ladder, or a new ladder after a KPI move) — never daily on the same count. */
export const ADOPTION_LADDER_SEEN_SEC = 7 * 86400;
export const ADOPTION_LADDER_MAX_RUNS = 500;
export const ADOPTION_LADDER_MAX_PROJECTS = 60;
export const ADOPTION_WAKE_PREFIX = '[NO-ADOPTION — harness-measured]';
const NOADOPT_KEY = (goalId: string) => `adoption:noadopt:${goalId}`;
const NOADOPT_SEEN_KEY = (goalId: string) => `adoption:noadopt:seen:${goalId}`;
/** What the last wake said about a goal: {experiments, lastMoveAt}. */
function parseSeen(raw: unknown): { experiments: number; lastMoveAt: string } | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && Number.isFinite(Number(o.experiments)) ? { experiments: Number(o.experiments), lastMoveAt: String(o.lastMoveAt ?? '') } : null;
  } catch { return null; }
}
/** Pure: is this ladder NEW evidence against what the last wake already said? */
export function ladderIsNewEvidence(l: Pick<AdoptionLadder, 'experiments' | 'lastMoveAt'>, seen: { experiments: number; lastMoveAt: string } | null): boolean {
  if (!seen) return true;
  if (seen.lastMoveAt !== (l.lastMoveAt ?? '')) return true; // the KPI moved since — a fresh ladder
  return l.experiments > seen.experiments;
}

export interface AdoptionLadder {
  goalId: string;
  projectId: string;
  goalTitle: string;
  kpiKey: string;
  kpiValue: number;
  kpiUnit?: string;
  bar?: number;
  /** The KPI's declared bar direction when it has one ('up' floor / 'down' ceiling) — carried so the rendered bar clause reads the declared semantics, not a re-inference (review 4112375b m3). */
  barDirection?: 'up' | 'down';
  receiptId?: string;
  /** ISO of the last receipted move toward the bar (the registration when none) — null when the premise carries no stamp. */
  lastMoveAt: string | null;
  experiments: number;
  hours: number;
  lanes: string[];
  tripped: boolean;
}

/** Did the value move TOWARD the bar (closer when a bar exists; any change otherwise)? */
export function movedToward(prev: number, cur: number, bar: number | undefined): boolean {
  if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === cur) return false;
  if (Number.isFinite(Number(bar))) return Math.abs(Number(bar) - cur) < Math.abs(Number(bar) - prev);
  return true;
}

/**
 * Pure: when the KPI last reached a NEW BEST toward its bar by a receipted
 * value — an adoption. Walks the premise's history ring (oldest first) + the
 * current value, newest-first: an entry counts when it is closer to the bar
 * than EVERY earlier entry (so a regression-and-recovery to the same number,
 * the 5.364 → 2.464 → 5.08 flap, is not a move; without a bar any change from
 * the previous value counts) AND carries a receipt (while the contract is on).
 * Falls back to the FIRST registration's stamp — the ladder starts at
 * registration.
 */
export function lastKpiMoveAt(kpi: KpiPremiseLike): string | null {
  const series: PremiseValueStamp[] = [
    ...(Array.isArray(kpi.history) ? kpi.history : []),
    { value: Number(kpi.value), ...(kpi.setAt ? { setAt: kpi.setAt } : {}), ...(kpi.receiptId ? { receiptId: kpi.receiptId } : {}) },
  ].filter((s) => s && Number.isFinite(Number(s.value)));
  const bar = Number.isFinite(Number(kpi.bar)) ? Number(kpi.bar) : undefined;
  const isNewBest = (i: number): boolean => {
    const cur = Number(series[i].value);
    if (bar === undefined) return movedToward(Number(series[i - 1].value), cur, undefined);
    const dist = Math.abs(bar - cur);
    for (let j = 0; j < i; j++) if (Math.abs(bar - Number(series[j].value)) <= dist) return false;
    return true;
  };
  for (let i = series.length - 1; i >= 1; i--) {
    if (!isNewBest(i)) continue;
    if (!series[i].receiptId) continue;
    return series[i].setAt ?? null;
  }
  return series[0]?.setAt ?? null;
}

/**
 * Pure: the ladder for one goal from its KPI premise, assignee lanes and their
 * completed runs. Null = no signal: no registration stamp, or the value already
 * satisfies the bar (kpiBarMet — nothing left to adopt toward). Trips at K
 * experiments, or at H hours ONLY when at least one experiment completed in the
 * window — hours alone measured nothing about the lane (fixer follow-up 2).
 */
export function computeAdoptionLadder(input: {
  goalId: string;
  projectId: string;
  goalTitle: string;
  kpi: KpiPremiseLike;
  lanes: string[];
  completedRuns: Array<{ sessionId: string; finishedAt: Date | string | null }>;
  now: Date;
}): AdoptionLadder | null {
  if (kpiBarMet(input.kpi)) return null;
  const lastMoveAt = lastKpiMoveAt(input.kpi);
  const lastMs = lastMoveAt ? new Date(lastMoveAt).getTime() : NaN;
  if (!Number.isFinite(lastMs)) return null;
  const lanes = new Set(input.lanes);
  let experiments = 0;
  for (const r of input.completedRuns) {
    if (!lanes.has(r.sessionId) || !r.finishedAt) continue;
    const t = new Date(r.finishedAt).getTime();
    if (Number.isFinite(t) && t > lastMs) experiments++;
  }
  const hours = Math.max(0, (input.now.getTime() - lastMs) / 3_600_000);
  return {
    goalId: input.goalId,
    projectId: input.projectId,
    goalTitle: input.goalTitle,
    kpiKey: input.kpi.key,
    kpiValue: Number(input.kpi.value),
    ...(input.kpi.unit ? { kpiUnit: input.kpi.unit } : {}),
    // Ticket d1a7bec2 (CASE 2): the ladder's bar must be the bar the KPI is
    // MEASURED on — a boolean unit's is 1, not a copied-over numeric one. The
    // wake body (renderNoAdoptionWake) prints via kpiBarText without the unit,
    // so carrying the raw bar there told a supervisor "bar ≥90" for a boolean.
    ...(effectiveKpiBar(input.kpi) !== undefined ? { bar: effectiveKpiBar(input.kpi)! } : {}),
    ...(normalizeKpiBarDirection(input.kpi.barDirection) ? { barDirection: normalizeKpiBarDirection(input.kpi.barDirection)! } : {}),
    ...(input.kpi.receiptId ? { receiptId: input.kpi.receiptId } : {}),
    lastMoveAt,
    experiments,
    hours: Math.round(hours * 10) / 10,
    lanes: [...lanes],
    tripped: experiments >= adoptionLadderK() || (experiments >= 1 && hours >= adoptionLadderHours()),
  };
}

const daysText = (hours: number): string => `${(Math.round((hours / 24) * 10) / 10).toString()} d`;

/** Board / card / schedule-state inline ('' while there is nothing to say yet). */
export function renderAdoptionLadderInline(l: AdoptionLadder): string {
  if (!l || (l.experiments < 1 && l.hours < 1)) return '';
  const val = kpiValueText({ value: l.kpiValue, unit: l.kpiUnit });
  const since = l.lastMoveAt ? stampMdHm(l.lastMoveAt) : '?';
  return `KPI ${val} unchanged since ${since} · ${l.experiments} experiment${l.experiments === 1 ? '' : 's'} / ${l.hours >= 24 ? daysText(l.hours) : `${formatAge(l.hours * 3_600_000)}`} without adoption`;
}

/** The lane-side clause for [SCHEDULE STATE]. */
export function renderLaneLadderClause(l: AdoptionLadder): string {
  return `${l.experiments} experiment${l.experiments === 1 ? '' : 's'} since the last KPI move (${l.kpiKey}=${kpiValueText({ value: l.kpiValue, unit: l.kpiUnit })}${l.lastMoveAt ? ` since ${stampMdHm(l.lastMoveAt)}` : ''})`;
}

/** The [NO-ADOPTION] wake body (a mandatory-answer block, never a refusal). */
export function renderNoAdoptionWake(l: AdoptionLadder, projectName: string, now: Date): string {
  const val = kpiValueText({ value: l.kpiValue, unit: l.kpiUnit });
  const bar = kpiBarText({ value: l.kpiValue, bar: l.bar, ...(l.barDirection ? { barDirection: l.barDirection } : {}) });
  const lanes = l.lanes.length ? l.lanes.map((id) => id.slice(0, 8)).join(', ') : 'no assignee lane';
  return (
    `${ADOPTION_WAKE_PREFIX} goal ${l.goalId.slice(0, 8)} "${l.goalTitle}" in ${projectName}: KPI ${l.kpiKey}=${val}${l.receiptId ? ` (receipt ${l.receiptId.slice(0, 8)})` : ''}${bar ? `, ${bar},` : ''} has not moved toward its bar since ${l.lastMoveAt ? stampMdHm(l.lastMoveAt) : '?'} — ${l.experiments} completed work session${l.experiments === 1 ? '' : 's'} / ${formatAge(l.hours * 3_600_000)} on lane(s) ${lanes} without an adoption (measured ${now.toISOString().slice(0, 16)}Z; thresholds ${adoptionLadderK()} experiments / ${adoptionLadderHours()} h).\n` +
    (l.experiments > 0
      ? `${l.experiments} completed work session${l.experiments === 1 ? '' : 's'} since that move and no receipted KPI move: a lane that reports a verdict every firing but never a KPI move is not progressing — do not report its folds as WHAT MOVED. (The harness measures completed runs, not artifacts.)\n`
      : `No work session has completed on the assignee lane(s) since that move — the goal is idle, not busy; the answer below still applies.\n`) +
    `This wake you MUST answer with exactly ONE of:\n` +
    `(a) RE-PLAN — todo_update the assignee's todo with the NEXT lever (from the backlog or the queued rebase/upstream item), its BUDGET (N firings / H hours) and its falsifiable ADOPTION CRITERION (which KPI receipt must move, by how much), then send_chat_message the lane that steer — cite both ids; or\n` +
    `(b) ESCALATE — report STUCK-SINCE to the Fleet Supervisor with the KPI receipt id and the experiment count, and steer the lane (send_chat_message) to fold once and stop extending the ladder until the re-plan lands — cite the message id. The harness never pauses a lane for this; a cadence change is your own re-plan decision, not this wake's instruction.\n` +
    `Extending the current ladder requires naming, in the todo, what the next rung would change in the KPI. Fold the negative result ONCE (one PR, not one per rung). Never a card, never a budget question — budgets are pre-approved.`
  );
}

// ── DB readers ───────────────────────────────────────────────────────────────

interface GoalRow { id: string; projectId: string; title: string; status: string; premises: unknown }

async function laddersForGoals(goals: GoalRow[], now: Date): Promise<Map<string, AdoptionLadder>> {
  const out = new Map<string, AdoptionLadder>();
  // ACTIVE goals only (fixer follow-up 2): a BLOCKED goal's lanes are not expected to move its KPI, so its clock is not evidence.
  const withKpi = goals
    .map((g) => ({ g, kpi: kpiPremiseOf(readPremises(g.premises)) }))
    .filter((x): x is { g: GoalRow; kpi: KpiPremiseLike } => !!x.kpi && x.g.status === 'active');
  if (!withKpi.length) return out;
  const todos = (await prisma.projectTodo.findMany({
    where: { goalId: { in: withKpi.map((x) => x.g.id) }, assigneeChatId: { not: null }, status: { not: 'dropped' } },
    select: { goalId: true, assigneeChatId: true },
  })) as Array<{ goalId: string; assigneeChatId: string | null }>;
  const lanesByGoal = new Map<string, Set<string>>();
  for (const t of todos) {
    if (!t.assigneeChatId) continue;
    if (!lanesByGoal.has(t.goalId)) lanesByGoal.set(t.goalId, new Set());
    lanesByGoal.get(t.goalId)!.add(t.assigneeChatId);
  }
  const allLanes = [...new Set(todos.map((t) => t.assigneeChatId).filter(Boolean) as string[])];
  // One run read for every lane; the per-goal count filters by lane + the goal's own lastMoveAt.
  const earliest = withKpi
    .map((x) => lastKpiMoveAt(x.kpi))
    .filter((s): s is string => !!s)
    .map((s) => new Date(s).getTime())
    .filter((n) => Number.isFinite(n));
  const runs = allLanes.length && earliest.length
    ? ((await prisma.agentRun.findMany({
        where: { sessionId: { in: allLanes }, status: 'completed', finishedAt: { gt: new Date(Math.min(...earliest)) } },
        select: { sessionId: true, finishedAt: true },
        orderBy: { finishedAt: 'desc' },
        take: ADOPTION_LADDER_MAX_RUNS,
      })) as Array<{ sessionId: string; finishedAt: Date | null }>)
    : [];
  for (const { g, kpi } of withKpi) {
    const ladder = computeAdoptionLadder({
      goalId: g.id, projectId: g.projectId, goalTitle: String(g.title ?? ''), kpi,
      lanes: [...(lanesByGoal.get(g.id) ?? [])], completedRuns: runs, now,
    });
    if (ladder) out.set(g.id, ladder);
  }
  return out;
}

/** Ladders for every ACTIVE goal of a project that carries a kpi: premise (blocked goals and goals at their bar have no signal). Never throws (empty map). */
export async function loadAdoptionLadders(projectId: string, now: Date = new Date()): Promise<Map<string, AdoptionLadder>> {
  try {
    const goals = (await (prisma.projectGoal as any).findMany({
      where: { projectId, status: 'active' },
      select: { id: true, projectId: true, title: true, status: true, premises: true },
      orderBy: { createdAt: 'asc' },
    })) as GoalRow[];
    return await laddersForGoals(goals, now);
  } catch (err: any) {
    logger.warn(`${SOURCE}: ladders unreadable for ${String(projectId).slice(0, 8)} (no signal): ${err?.message ?? err}`, { source: SOURCE });
    return new Map();
  }
}

/** The ladder of the KPI goal a LANE is assigned to (its [SCHEDULE STATE] clause). Null = no signal. */
export async function ladderForLane(chatId: string, now: Date = new Date()): Promise<AdoptionLadder | null> {
  try {
    const todos = (await prisma.projectTodo.findMany({
      where: { assigneeChatId: chatId, status: { in: ['in_progress', 'pending', 'blocked'] } },
      select: { goalId: true },
      take: 20,
    })) as Array<{ goalId: string }>;
    const goalIds = [...new Set(todos.map((t) => t.goalId).filter(Boolean))];
    if (!goalIds.length) return null;
    const goals = (await (prisma.projectGoal as any).findMany({
      where: { id: { in: goalIds }, status: 'active' },
      select: { id: true, projectId: true, title: true, status: true, premises: true },
    })) as GoalRow[];
    const ladders = await laddersForGoals(goals, now);
    let best: AdoptionLadder | null = null;
    for (const l of ladders.values()) if (l.lanes.includes(chatId) && (!best || l.experiments > best.experiments)) best = l;
    return best;
  } catch (err: any) {
    logger.warn(`${SOURCE}: lane ladder unreadable for ${String(chatId).slice(0, 8)} (no clause): ${err?.message ?? err}`, { source: SOURCE });
    return null;
  }
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export interface AdoptionLadderDeps {
  now?: Date;
  enqueueDirectWake?: (opts: { targetChatId: string; prompt: string; meta?: Record<string, unknown> }) => Promise<unknown>;
}

/** One sweep over every ENABLED, attached project supervisor. Never throws. */
export async function sweepAdoptionLadder(deps: AdoptionLadderDeps = {}): Promise<{ projects: number; tripped: number; wakes: number; unchanged: number }> {
  const counters = { projects: 0, tripped: 0, wakes: 0, unchanged: 0 };
  const now = deps.now ?? new Date();
  let sups: Array<{ id: string; projectId: string | null }> = [];
  try {
    sups = (await prisma.crossModelChat.findMany({
      where: { isProjectSupervisor: true, projectId: { not: null }, archivedAt: null },
      select: { id: true, projectId: true },
      take: ADOPTION_LADDER_MAX_PROJECTS,
    })) as Array<{ id: string; projectId: string | null }>;
  } catch (err: any) {
    logger.warn(`${SOURCE}: supervisor listing failed: ${err?.message ?? err}`, { source: SOURCE });
    return counters;
  }
  sups = sups.filter((s) => !!s.projectId);
  if (!sups.length) return counters;
  const projects = (await prisma.crossModelProject.findMany({
    where: { id: { in: sups.map((s) => s.projectId as string) } },
    select: { id: true, name: true, projectSupervisorEnabled: true, archivedAt: true },
  }).catch(() => [] as any[])) as Array<{ id: string; name: string; projectSupervisorEnabled: boolean; archivedAt: Date | null }>;
  const enabled = new Map(projects.filter((p) => p.projectSupervisorEnabled === true && !p.archivedAt).map((p) => [p.id, p]));
  sups = sups.filter((s) => enabled.has(s.projectId as string));
  if (!(await getProjectSupervisorsEnabled().catch(() => true))) {
    for (const s of sups) recordSupervisorSwitchSkip({ target: 'project', source: SOURCE, chatId: s.id });
    return counters;
  }
  const wake = deps.enqueueDirectWake ?? (async (o) => (await import('./hooks.service')).enqueueDirectWake(o));
  for (const sup of sups) {
    counters.projects++;
    const project = enabled.get(sup.projectId as string)!;
    let ladders: Map<string, AdoptionLadder>;
    try {
      ladders = await loadAdoptionLadders(project.id, now);
    } catch {
      continue;
    }
    for (const l of ladders.values()) {
      if (!l.tripped) continue;
      counters.tripped++;
      try {
        const key = NOADOPT_KEY(l.goalId);
        if (await (redisClient as any).get(key).catch(() => null)) continue;
        // Re-wake only on NEW evidence (fixer follow-up 2): the same count on the same
        // ladder is the block the supervisor already answered — a daily repeat of it
        // is exactly the paid no-op wake class the audit counted.
        const seenKey = NOADOPT_SEEN_KEY(l.goalId);
        const seen = parseSeen(await (redisClient as any).get(seenKey).catch(() => null));
        if (!ladderIsNewEvidence(l, seen)) { counters.unchanged++; continue; }
        // abd733af (6d19f11f sibling seam): enqueueDirectWake reports failure as
        // { ok: false } instead of throwing. Treating it as delivered set the
        // 24h no-adopt key AND the 7d seen-evidence key — the ladder wake was
        // silenced for a day and the new-evidence comparator consumed the
        // evidence, so no later pass retried even on NEW counts. Not delivered ⇒
        // neither key is set (the same new evidence retries next sweep) + a
        // failure row.
        const wres: any = await wake({
          targetChatId: sup.id,
          prompt: renderNoAdoptionWake(l, project.name, now),
          meta: { origin: SOURCE, kind: 'no_adoption', goalId: l.goalId, projectId: l.projectId, experiments: l.experiments, hours: l.hours },
        });
        if (wres && typeof wres === 'object' && wres.ok === false) {
          logger.warn(`${SOURCE}: no-adoption wake enqueue not ok for goal ${l.goalId.slice(0, 8)}: ${wres.error ?? 'unknown error'}`, { source: SOURCE });
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.ADOPTION_LADDER, sessionId: sup.id,
            meta: { goalId: l.goalId, projectId: l.projectId, lane: l.lanes.map((id) => id.slice(0, 8)), experiments: l.experiments, hours: l.hours, kpiKey: l.kpiKey, kpiValue: l.kpiValue, woken: false, outcome: 'enqueue_failed', error: wres.error ?? null },
          });
          continue;
        }
        await (redisClient as any).set(key, `${l.experiments}:${now.toISOString()}`, { EX: ADOPTION_LADDER_DEDUPE_SEC }).catch(() => {});
        await (redisClient as any).set(seenKey, JSON.stringify({ experiments: l.experiments, lastMoveAt: l.lastMoveAt ?? '' }), { EX: ADOPTION_LADDER_SEEN_SEC }).catch(() => {});
        counters.wakes++;
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.ADOPTION_LADDER, sessionId: sup.id,
          meta: { goalId: l.goalId, projectId: l.projectId, lane: l.lanes.map((id) => id.slice(0, 8)), experiments: l.experiments, hours: l.hours, kpiKey: l.kpiKey, kpiValue: l.kpiValue, woken: true },
        });
      } catch (err: any) {
        logger.warn(`${SOURCE}: wake failed for goal ${l.goalId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
      }
    }
  }
  if (counters.wakes || counters.unchanged) logger.info(`${SOURCE}: sweep projects=${counters.projects} tripped=${counters.tripped} wakes=${counters.wakes} unchanged=${counters.unchanged}`, { source: SOURCE });
  return counters;
}

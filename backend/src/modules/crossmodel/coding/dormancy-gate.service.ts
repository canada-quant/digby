/**
 * Goal-gate / dormancy gate (ticket b1d435fd, owner directive 2026-09-18):
 * a project with NO live work — no active/blocked goals, no open todos
 * (pending/in_progress/blocked), no live/queued agent runs, and no live
 * watched-resource registrations — is DORMANT and must waste ZERO tokens on
 * wakes: neither project-supervisor sweeps nor session-level monitors may arm
 * or stay active there. The wake path for new work is event hooks (zero
 * tokens until an event fires), not heartbeats.
 *
 * This module is the single predicate every arming/resume/firing path reads:
 *   - createSchedule (machine recurring arms are REFUSED while dormant),
 *   - the firing sweeper (an enabled recurring row on a dormant project is
 *     AUTO-PARKED: enabled:false, lastStatus 'parked:dormant', one-line
 *     reason),
 *   - maybeRenewOnExhaustion (no successor renewal onto a dormant project),
 *   - the project-supervisor sweep ensure / toggle-ON resume (stock sweeps
 *     park instead of resurrecting — the spark-cluster resurrection loop).
 *
 * Carve-outs (all deliberate, all in the predicate — never a caller's job):
 *   - OWNER-authored schedules (promptSetBy 'user', or legacy NULL predating
 *     the column) are explicit owner instruction and are never gated.
 *   - Chats with NO project are not project work — the gate does not apply.
 *   - LIVE watched-resource registrations (reservationEndsAt null or in the
 *     future) mark operational monitors (production gateways, GPU boxes) —
 *     those keep their heartbeats; past-ended registrations do not.
 *   - One-shot schedules are out of scope everywhere (a deferred single fire
 *     is not a recurring wake) — with ONE observe-only exception: a `once`
 *     row that is link ≥3 of a self-re-arming chain in 24h
 *     (schedule-once-chain.ts, finding B1) is EVALUATED by the sweeper at
 *     fire time; a dormant verdict records `would_park_dormant` and the link
 *     still fires.
 *
 * FAIL-OPEN like every gate in this codebase (spend-cap doctrine): any
 * evaluation error returns not-dormant so a telemetry hiccup can never block
 * a real firing.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';

/** lastStatus stamped on an auto-parked row. Cancel-class for the stale-firing
 *  guards (a queued firing of a parked row is dropped, never executed). */
export const DORMANT_LAST_STATUS = 'parked:dormant';

export interface DormancySignals {
  /** Goals status 'active' | 'blocked' (blocked goals are still live work). */
  activeGoals: number;
  /** Todos status 'pending' | 'in_progress' | 'blocked'. */
  openTodos: number;
  /** agent_runs status 'running' | 'queued' on the project's WORK chats — supervision scaffolding (the project-supervisor lane + its direct spawned children) is EXCLUDED (ticket 37fa747d) — for the project gate; or runs created in the
   *  last FLEET_DORMANT_AFTER_MS anywhere in the account (account gate). */
  liveRuns: number;
  /** Project gate only: live/queued runs on supervision scaffolding (the
   *  project-supervisor lane's own runs + its direct children's). Reported for
   *  observability; NEVER part of the dormant decision (37fa747d). */
  scaffoldingRuns?: number;
  /** Watched resources with reservationEndsAt null or in the future. */
  watchedResources: number;
  /** Account gate only: enabled recurring schedules on the account's OTHER chats. */
  otherSchedules?: number;
  // ── audit 2026-10-06 T4-4 live-work signals (project gate; present only when > 0) ──
  /** OPEN owner-origin directives (≤7 d) on the project supervisor's ledger. */
  ownerDirectives?: number;
  /** Alarm-class hook events (run_failed / goal_blocked / attention_needed) from the project's WORK chats in the last 6 h. */
  recentAlarms?: number;
  /** Goals closed 'done' in the last 7 d whose close is suspect (goal-done-suspect board reasons / an open owner directive naming it). */
  doneSuspectGoals?: number;
  /** Enabled RECURRING owner-armed schedules (promptSetBy 'user' / legacy NULL, or ownerSubscribed) on the project's WORK chats. */
  ownerLaneSchedules?: number;
  /** GOAL-OUTCOME-UNMET part 2 (2026-10-20): goals closed 'done' MORE than 7 d ago whose own outcome bar is still unmet (kpi_bar_unmet / premise_target_unmet) and whose close is still LIVE — same KPI / target value + bar as at close, not owner-accepted. No 7-day limit. */
  outcomeUnmetGoals?: number;
}

/**
 * audit 2026-10-06 T4-4 (spark.md F3, others.md F10): a project whose LEDGER
 * is empty is still live while (a) an OWNER directive is open on its
 * supervisor's ledger (spark: the sweep auto-parked 6 min after the cluster
 * went dark, mid-incident, owner directives open), (b) an alarm fired from one
 * of its work chats in the last DORMANCY_ALARM_WINDOW_MS (6 h), (c) a goal was
 * closed SUSPECT in the last 7 days (CanLaw: goal auto-done on a PR merge with
 * the owner's "update me every hour" directive open — the sweep parked and the
 * hourly update was refused; since 2026-10-20 a close whose OWN outcome bar is
 * unmet stays live past the 7 days — see (e) in readLiveWorkSignals), or (d)
 * an OWNER-armed recurring lane schedule is
 * live (the owner's own cadence proves the work is not over). Read ONLY when
 * the base predicate already says dormant (zero cost for live projects); each
 * read is best-effort — a failed read counts 0, i.e. the pre-fix verdict.
 * Kill switch DORMANCY_LIVE_SIGNALS_DISABLED=1. Read per call.
 */
export function dormancyLiveSignalsDisabled(): boolean {
  const v = process.env.DORMANCY_LIVE_SIGNALS_DISABLED || '';
  return v === '1' || /^true$/i.test(v);
}
export const DORMANCY_ALARM_WINDOW_MS = 6 * 60 * 60 * 1000;
/** GOAL-OUTCOME-UNMET part 2: how many older done goals one check assesses (newest closes first). */
export const DORMANCY_OUTCOME_SCAN_TAKE = 100;
export const DORMANCY_DONE_SUSPECT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DORMANCY_ALARM_EVENT_TYPES = ['run_failed', 'goal_blocked', 'attention_needed'];

async function readLiveWorkSignals(opts: {
  projectId: string;
  projectName: string;
  userId: string | null;
  supervisorChatIds: string[];
  workChatIds: string[];
  now: Date;
}): Promise<{ ownerDirectives: number; recentAlarms: number; doneSuspectGoals: number; ownerLaneSchedules: number; outcomeUnmetGoals: number }> {
  const out = { ownerDirectives: 0, recentAlarms: 0, doneSuspectGoals: 0, ownerLaneSchedules: 0, outcomeUnmetGoals: 0 };
  const directiveTexts: Array<{ id: string; text: string; at: string; scope?: string }> = [];
  const nowMs = opts.now.getTime();
  // (a) open OWNER directives on the supervisor ledger(s).
  if (opts.supervisorChatIds.length) {
    try {
      const st = await import('../platform/supervisor-state.service');
      for (const chatId of opts.supervisorChatIds.slice(0, 3)) {
        const doc = await st.getSupervisorState(chatId);
        out.ownerDirectives += st.countOpenOwnerDirectives(doc, opts.now).open;
        for (const d of doc.directives ?? []) {
          if (d?.status === 'open' && d.origin === 'owner') directiveTexts.push({ id: d.id, text: d.text, at: d.at, ...(d.scope ? { scope: d.scope } : {}) });
        }
      }
    } catch { /* best-effort: 0 */ }
  }
  // (b) alarms from WORK chats in the last 6 h (scaffolding excluded — the
  // supervisor's own failures / park events never keep its sweep alive).
  if (opts.workChatIds.length) {
    try {
      const work = new Set(opts.workChatIds);
      const rows: any[] = (await prisma.hookEvent.findMany({
        where: {
          eventType: { in: DORMANCY_ALARM_EVENT_TYPES },
          createdAt: { gte: new Date(nowMs - DORMANCY_ALARM_WINDOW_MS) },
          ...(opts.userId ? { userId: opts.userId } : {}),
        },
        select: { eventType: true, payload: true },
        take: 500,
      })) ?? [];
      const seen = new Set<string>();
      for (const r of rows) {
        const src = String((r?.payload as any)?.sourceChatId ?? '');
        if (!work.has(src)) continue;
        seen.add(`${r.eventType}:${src}:${String((r?.payload as any)?.runId ?? '')}`);
      }
      out.recentAlarms = seen.size;
    } catch { /* best-effort: 0 */ }
    // (d) owner-armed recurring schedules on WORK chats.
    try {
      out.ownerLaneSchedules = Number(await prisma.codingSchedule.count({
        where: {
          sessionId: { in: opts.workChatIds }, enabled: true, kind: 'recurring',
          OR: [{ promptSetBy: 'user' }, { promptSetBy: null }, { ownerSubscribed: true }],
        },
      })) || 0;
    } catch { /* best-effort: 0 */ }
  }
  // (c) goals closed suspect in the last 7 days.
  try {
    const goals: any[] = (await prisma.projectGoal.findMany({
      where: { projectId: opts.projectId, status: 'done', updatedAt: { gte: new Date(nowMs - DORMANCY_DONE_SUSPECT_WINDOW_MS) } },
      select: { id: true, title: true, progressNote: true, premises: true },
      take: 50,
    })) ?? [];
    if (goals.length) {
      const gds = await import('../platform/goal-done-suspect');
      for (const g of goals) {
        const v = gds.assessGoalDoneSuspect({ title: g.title, progressNote: g.progressNote, premises: g.premises }, directiveTexts, { now: nowMs, projectName: opts.projectName });
        if (v.boardReasons.length || v.reasons.includes('open_directive')) out.doneSuspectGoals += 1;
      }
    }
  } catch { /* best-effort: 0 */ }
  // (e) GOAL-OUTCOME-UNMET part 2 (architecture review #3, 2026-10-20): a goal
  // closed while its OWN outcome bar is unmet (the KPI of record below its bar,
  // an observed target missing) is not finished work just because its todos
  // landed — it stays live with NO 7-day limit, until the KPI / target value or
  // the bar changes (the close record's fingerprint drifts) or the owner closes
  // it explicitly (ownerAccepted). (c) already covers the last 7 days; this
  // reads only OLDER closes, and only closes recorded since the change are
  // live here (goal-outcome.ts liveOutcomeUnmetGoalIds). Kill switch
  // GOAL_OUTCOME_CHECK_DISABLED=1.
  try {
    const go = await import('../platform/goal-outcome');
    if (!go.goalOutcomeCheckDisabled()) {
      const older: any[] = (await prisma.projectGoal.findMany({
        where: { projectId: opts.projectId, status: 'done', updatedAt: { lt: new Date(nowMs - DORMANCY_DONE_SUSPECT_WINDOW_MS) } },
        select: { id: true, premises: true },
        orderBy: { updatedAt: 'desc' },
        take: DORMANCY_OUTCOME_SCAN_TAKE,
      })) ?? [];
      if (older.length) out.outcomeUnmetGoals = (await go.liveOutcomeUnmetGoalIds(older)).size;
    }
  } catch { /* best-effort: 0 */ }
  return out;
}

export interface DormancyVerdict {
  dormant: boolean;
  projectId: string | null;
  /** One-line human reason — recorded as the park reason / refusal envelope. */
  reason: string;
  signals: DormancySignals;
}

const ZERO_SIGNALS: DormancySignals = { activeGoals: 0, openTodos: 0, liveRuns: 0, watchedResources: 0 };

function pass(projectId: string | null, reason: string): DormancyVerdict {
  return { dormant: false, projectId, reason, signals: { ...ZERO_SIGNALS } };
}

/**
 * Project-scoped core: is this project dormant RIGHT NOW? Used by the
 * project-supervisor ensure paths and (via evaluateScheduleDormancy) every
 * schedule-level path. Never throws.
 */
export async function evaluateProjectDormancy(projectId: string): Promise<DormancyVerdict> {
  try {
    const project = await prisma.crossModelProject.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, archivedAt: true, userId: true },
    });
    if (!project) return pass(projectId, 'project row missing — fail-open');
    if (project.archivedAt) {
      return {
        dormant: true, projectId,
        reason: `project "${project.name}" is archived — no wakes (owner directive 2026-09-18: zero wakes on goal-less/dormant projects)`,
        signals: { ...ZERO_SIGNALS },
      };
    }
    const chats = await prisma.crossModelChat.findMany({
      where: { projectId, archivedAt: null },
      select: { id: true, isProjectSupervisor: true, parentChatId: true },
      take: 500,
    });
    // Ticket 37fa747d: SUPERVISION SCAFFOLDING is not project work. The
    // project-supervisor lane's OWN runs (its sweep firings, event wakes,
    // self-audits) AND the runs on chats it SPAWNED (its self-audit/work
    // children — canlegal-bench's "Acceptance Criteria Verified" child was
    // live 01:16–01:48Z) must never be the liveness that keeps a 0-goal
    // project "not dormant" — otherwise the machinery defeats its own park:
    // the park event itself wakes the supervisor (ALARM-class,
    // debounce-bypassing), whose live run (or live child) then reads as
    // liveness at the next heal, and the toggle-ON resume re-arms the parked
    // sweep (canlegal-bench 2026-09-24: parked ~01:2xZ, re-armed by the
    // ensure at 01:40:03.772Z stamping 'resumed:project_sweep_ensure' — 8
    // no-op wakes/day on a 0-goal board). Scaffolding-descendant chats still
    // emit their run_completed/todo_done hook events, so the supervisor keeps
    // its zero-token wake path — only the 60-min heartbeat stays parked.
    // Runs on chats NOT descending from the lane (owner-created sessions,
    // other lanes' children spawned into this project) are real live work and
    // keep the sweep armed, as before.
    const scaffoldingIds = new Set<string>();
    for (const c of chats as any[]) if (c.isProjectSupervisor === true) scaffoldingIds.add(c.id);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of chats as any[]) {
        if (c.parentChatId && scaffoldingIds.has(c.parentChatId) && !scaffoldingIds.has(c.id)) {
          scaffoldingIds.add(c.id);
          grew = true;
        }
      }
    }
    const workChatIds = (chats as any[]).map((c: any) => c.id).filter((id: string) => !scaffoldingIds.has(id));
    const scaffoldingIdList = [...scaffoldingIds];
    const now = new Date();
    const [activeGoals, openTodos, liveRuns, watchedResources, scaffoldingRuns] = await Promise.all([
      prisma.projectGoal.count({ where: { projectId, status: { in: ['active', 'blocked'] } } }),
      prisma.projectTodo.count({ where: { projectId, status: { in: ['pending', 'in_progress', 'blocked'] } } }),
      workChatIds.length
        ? prisma.agentRun.count({ where: { sessionId: { in: workChatIds }, status: { in: ['running', 'queued'] } } })
        : Promise.resolve(0),
      // Infra-monitor carve-out: a LIVE watched-resource registration (no known
      // end, or an end still in the future — the same liveness rule the
      // resource watchdog alarms by) marks an operational monitor, not a
      // project-work wake.
      prisma.watchedResource.count({
        where: { projectId, OR: [{ reservationEndsAt: null }, { reservationEndsAt: { gt: now } }] },
      }),
      // Observability only (37fa747d) — NEVER part of the dormant decision.
      scaffoldingIdList.length
        ? prisma.agentRun.count({ where: { sessionId: { in: scaffoldingIdList }, status: { in: ['running', 'queued'] } } })
        : Promise.resolve(0),
    ]);
    const signals: DormancySignals = {
      activeGoals: Number(activeGoals) || 0,
      openTodos: Number(openTodos) || 0,
      liveRuns: Number(liveRuns) || 0,
      watchedResources: Number(watchedResources) || 0,
      ...(Number(scaffoldingRuns) ? { scaffoldingRuns: Number(scaffoldingRuns) } : {}),
    };
    let dormant = signals.activeGoals === 0 && signals.openTodos === 0 && signals.liveRuns === 0 && signals.watchedResources === 0;
    // audit 2026-10-06 T4-4: the extra live-work signals — read only when the
    // ledger alone says dormant; each nonzero one keeps the project live.
    let liveSignalsReason = '';
    if (dormant && !dormancyLiveSignalsDisabled()) {
      const extra = await readLiveWorkSignals({
        projectId, projectName: String(project.name ?? ''), userId: (project as any).userId ?? null,
        supervisorChatIds: [...(chats as any[])].filter((c: any) => c.isProjectSupervisor === true).map((c: any) => c.id),
        workChatIds, now,
      });
      const parts: string[] = [];
      if (extra.ownerDirectives > 0) { signals.ownerDirectives = extra.ownerDirectives; parts.push(`${extra.ownerDirectives} open owner directive(s)`); }
      if (extra.recentAlarms > 0) { signals.recentAlarms = extra.recentAlarms; parts.push(`${extra.recentAlarms} alarm(s) from its lanes in the last ${Math.round(DORMANCY_ALARM_WINDOW_MS / 3_600_000)} h`); }
      if (extra.doneSuspectGoals > 0) { signals.doneSuspectGoals = extra.doneSuspectGoals; parts.push(`${extra.doneSuspectGoals} goal(s) closed ⚠ suspect in the last 7 d`); }
      if (extra.ownerLaneSchedules > 0) { signals.ownerLaneSchedules = extra.ownerLaneSchedules; parts.push(`${extra.ownerLaneSchedules} owner-armed recurring lane schedule(s)`); }
      if (extra.outcomeUnmetGoals > 0) { signals.outcomeUnmetGoals = extra.outcomeUnmetGoals; parts.push(`${extra.outcomeUnmetGoals} goal(s) closed with the outcome bar unmet (KPI / target below its bar)`); }
      if (parts.length) {
        dormant = false;
        liveSignalsReason = parts.join(', ');
        logger.info(`dormancy gate: project ${String(projectId).slice(0, 8)} has an empty ledger but stays LIVE — ${liveSignalsReason} (audit 2026-10-06 T4-4)`);
        void import('../platform/loop-metrics.service')
          .then((m) => m.recordLoopMetric({ kind: 'dormancy_live_signal', meta: { projectId: String(projectId).slice(0, 8), ownerDirectives: extra.ownerDirectives, recentAlarms: extra.recentAlarms, doneSuspectGoals: extra.doneSuspectGoals, ownerLaneSchedules: extra.ownerLaneSchedules, ...(extra.outcomeUnmetGoals ? { outcomeUnmetGoals: extra.outcomeUnmetGoals } : {}) } }))
          .catch(() => {});
      }
    }
    const reason = dormant
      ? `project "${project.name}" is dormant — no active goals, open todos, live/queued runs, or live watched resources (owner directive 2026-09-18: zero wakes on goal-less/dormant projects; event hooks are the wake path when work appears)${Number(scaffoldingRuns) ? `; ${Number(scaffoldingRuns)} supervision run(s) on the project-supervisor lane excluded as scaffolding (37fa747d)` : ''}`
      : liveSignalsReason
      ? `project "${project.name}" has no active goals, open todos or live runs but is LIVE — ${liveSignalsReason}`
      : `project "${project.name}" has live work (${signals.activeGoals} active goal(s), ${signals.openTodos} open todo(s), ${signals.liveRuns} live run(s), ${signals.watchedResources} watched resource(s))`;
    return { dormant, projectId, reason, signals };
  } catch (err: any) {
    logger.warn(`dormancy gate: evaluation failed for project ${String(projectId).slice(0, 8)} (fail-open — wake proceeds): ${err?.message ?? err}`);
    return pass(projectId, `evaluation error — fail-open: ${err?.message ?? err}`);
  }
}

/**
 * ACCOUNT-level gate for the FLEET sweep (autonomy loop #18, 2026-09-21). The
 * project gate above skips chats with no project — and the Fleet Supervisor
 * is exactly that, so four foreign-account Fleet Supervisors kept sweeping
 * accounts that had not run a coding session in 8–11 days: 17 wakes/day, all
 * 'SWEEP: no-op', ~$2.8/day of pure spend. An account is dormant for the
 * fleet sweep when, over the last FLEET_DORMANT_AFTER_MS, it created no agent
 * run, and RIGHT NOW holds no active/blocked goal, open todo or live watched
 * resource on any of its projects and no enabled recurring schedule on any
 * chat but the supervisor's own. Plain-chat activity does not count — the
 * Fleet Supervisor supervises coding lanes, not conversations. The wake path
 * back is the supervisor's wildcard hook (kept enabled) plus
 * ensureFleetSupervisor's resume on the account's next project / chat /
 * session creation. Fail-open like the project gate.
 */
export const FLEET_DORMANT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export async function evaluateAccountDormancy(userId: string, opts: { excludeChatId?: string } = {}): Promise<DormancyVerdict> {
  try {
    if (!userId) return pass(null, 'no userId — fail-open');
    const now = new Date();
    const cutoff = new Date(now.getTime() - FLEET_DORMANT_AFTER_MS);
    const projects = await prisma.crossModelProject.findMany({ where: { userId, archivedAt: null }, select: { id: true }, take: 500 });
    const projectIds = (Array.isArray(projects) ? projects : []).map((p: any) => p.id);
    const [recentRuns, activeGoals, openTodos, watchedResources, otherSchedules] = await Promise.all([
      prisma.agentRun.count({ where: { createdAt: { gte: cutoff }, state: { userId } } }),
      projectIds.length ? prisma.projectGoal.count({ where: { projectId: { in: projectIds }, status: { in: ['active', 'blocked'] } } }) : Promise.resolve(0),
      projectIds.length ? prisma.projectTodo.count({ where: { projectId: { in: projectIds }, status: { in: ['pending', 'in_progress', 'blocked'] } } }) : Promise.resolve(0),
      projectIds.length
        ? prisma.watchedResource.count({ where: { projectId: { in: projectIds }, OR: [{ reservationEndsAt: null }, { reservationEndsAt: { gt: now } }] } })
        : Promise.resolve(0),
      prisma.codingSchedule.count({
        where: { userId, enabled: true, kind: 'recurring', ...(opts.excludeChatId ? { sessionId: { not: opts.excludeChatId } } : {}) },
      }),
    ]);
    const signals: DormancySignals = {
      activeGoals: Number(activeGoals) || 0,
      openTodos: Number(openTodos) || 0,
      liveRuns: Number(recentRuns) || 0,
      watchedResources: Number(watchedResources) || 0,
      otherSchedules: Number(otherSchedules) || 0,
    };
    const dormant = signals.liveRuns === 0 && signals.activeGoals === 0 && signals.openTodos === 0 && signals.watchedResources === 0 && signals.otherSchedules === 0;
    const days = Math.round(FLEET_DORMANT_AFTER_MS / 86_400_000);
    const reason = dormant
      ? `account is dormant — no coding run in ${days} days and no active goals, open todos, live watched resources or enabled schedules on any other chat; the fleet sweep is parked (zero wakes on a dormant account — its wildcard hook stays armed and the sweep resumes on the next project/chat/session)`
      : `account has live work (${signals.liveRuns} run(s) in ${days} days, ${signals.activeGoals} active goal(s), ${signals.openTodos} open todo(s), ${signals.watchedResources} live watched resource(s), ${signals.otherSchedules} enabled schedule(s) elsewhere)`;
    return { dormant, projectId: null, reason, signals };
  } catch (err: any) {
    logger.warn(`dormancy gate: account evaluation failed for ${String(userId).slice(0, 8)} (fail-open — wake proceeds): ${err?.message ?? err}`);
    return pass(null, `evaluation error — fail-open: ${err?.message ?? err}`);
  }
}

/**
 * Schedule-level gate: may a recurring schedule on this chat arm/stay active?
 * (Also asked, observe-only by default, for a recurring-like one-shot chain
 * link at fire time — see the header's one-shot note.)
 * promptSetBy is the schedule row's (or the create input's) authorship stamp —
 * 'user' and legacy NULL are explicit owner instruction and never gated.
 * Never throws.
 */
export async function evaluateScheduleDormancy(sessionId: string, promptSetBy?: string | null): Promise<DormancyVerdict> {
  try {
    // Explicit owner instruction (mirrors the fleet/project ensures' legacy-NULL
    // treatment: NULL predates the promptSetBy column and is owner-authored).
    if (promptSetBy === 'user' || promptSetBy == null) {
      return pass(null, 'owner-authored schedule — explicit owner instruction, never gated');
    }
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: sessionId },
      select: { id: true, projectId: true, isSupervisor: true, userId: true },
    });
    if (!chat) return pass(null, 'chat row missing — fail-open');
    if (!chat.projectId) {
      // Fleet Supervisor (loop #18): a projectless SUPERVISOR chat is gated at the
      // ACCOUNT level — its stock sweep must not burn wakes on an account with no
      // coding activity. Any other projectless chat is not project work.
      if ((chat as any).isSupervisor && (chat as any).userId) {
        return await evaluateAccountDormancy((chat as any).userId, { excludeChatId: sessionId });
      }
      return pass(null, 'chat has no project — not project work, gate does not apply');
    }
    return await evaluateProjectDormancy(chat.projectId);
  } catch (err: any) {
    logger.warn(`dormancy gate: schedule evaluation failed for ${String(sessionId).slice(0, 8)} (fail-open — wake proceeds): ${err?.message ?? err}`);
    return pass(null, `evaluation error — fail-open: ${err?.message ?? err}`);
  }
}

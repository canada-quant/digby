/**
 * FLEET-PS-FIRST (supervisor SOTA round 2, 2026-10-20) — project supervisors
 * handle their own projects first; the Fleet Supervisor hears a PS-covered
 * project's alarms only as DELAYED ESCALATIONS. Pure leaf (no prisma / redis /
 * logger; only the import-free metric-kind registry): the hook emission +
 * delivery seams (hooks.service), the fleet ledger diff (supervisor-wake-ledger)
 * and the fleet [BOARD] (board-digest.service) read these helpers.
 *
 * Why: an alarm-class event (run_failed / attention_needed / goal_blocked /
 * schedule_disabled) from a lane whose project has an enabled project
 * supervisor reached BOTH supervisors at once — the project-scope hook and the
 * owner-scope wildcard — and both bypass every gate (debounce, cap, material
 * gate, triage). Two supervisors reacting at max effort to the same lane event
 * risk conflicting steers and keep the Fleet Supervisor on project noise
 * instead of cross-project decisions. The quiet events were already shed
 * (FLEET_FEED_SHED_EVENT_TYPES); the alarms were not.
 *
 * Now:
 *   1. ROUTING (hooks.service emitHookEvent): for a PS-covered project the
 *      Fleet's OWNER-SCOPE WILDCARD row is NOT written for these types.
 *      Alarm-class rows (the cause-aware isAlarmEvent) become ONE durable
 *      direct wake (enqueueDirectWake, origin 'ps-escalation') held for
 *      PS_ESCALATION_DELAY_MS on the Fleet chat; a second alarm from the same
 *      project while it is held is APPENDED to that row (one open escalation
 *      per Fleet chat × project; serialized by a short Redis lock + a CAS on
 *      the stored count). An enqueue failure writes the original wildcard row
 *      instead (fail toward delivery). The two CADENCE signals
 *      (schedule_near_cap / schedule_cap_skipped) and an alarm TYPE its own
 *      payload made quiet are SHED from the Fleet, never escalated: the
 *      escalation is a todo_wake row — alarm-class — so escalating a quiet
 *      signal would turn it into a gate-bypassing Fleet wake; the project
 *      supervisor owns its lanes' cadences, and schedule_disabled (alarm-class)
 *      still escalates when a schedule actually dies. A Fleet chat that ALSO
 *      has a direct hook on the lane (an explicit subscribe_to_chat watch or a
 *      child-result hook) keeps today's immediate routing — the Fleet asked to
 *      hear that lane at once.
 *   2. HELD, NEVER RIDING: a held escalation never starts a wake from the
 *      finalize drain / un-park, never joins a window / sibling drain and is
 *      never "deliverable now" for the hooks-first arbitration — the Fleet must
 *      not see it before the project supervisor has had its window.
 *   3. DELIVERY REVALIDATION: at delivery the project supervisor's high-water
 *      mark (the start of its last completed machine wake) is read. An alarm
 *      older than the mark was handled — dropped. Nothing left ⇒ the row is
 *      terminal 'skipped:ps_handled'. Unhandled alarms the PS has not yet had
 *      its full window for re-hold (bounded by PS_ESCALATION_MAX_HOLD_MS from
 *      the first alarm). Otherwise the Fleet is woken with only the unhandled
 *      alarms. A wedged PS (no completed wake since) is exactly the case that
 *      escalates.
 *
 *      A project supervisor wake that STARTED after the oldest unhandled
 *      alarm and is still running re-holds the row (rechecked every
 *      PS_ESCALATION_INFLIGHT_RECHECK_MS, same cap) — that wake is most likely
 *      the one handling it. The enqueue-time prompt is NEUTRAL ("check its
 *      chat first"); only the prompt re-rendered after a successful
 *      revalidation states that the project supervisor has not completed a
 *      wake since the alarms fired.
 *
 * A project supervisor's OWN alarms (source = the PS chat) are never covered
 * (its project hook targets itself), so the Fleet hears them at once; a
 * Fleet-spawned lane's child-result hook keeps its immediate verdict path.
 * Kill switch HOOK_FLEET_ALARM_PS_FIRST_DISABLED=1 restores immediate
 * alarm delivery to both supervisors for NEW events. Rows already held are no
 * longer revalidated or excluded from drains: they deliver no later than their
 * retryAt (sooner when a finalize / window drain picks them up) with their
 * neutral enqueue-time prompt.
 */

import { LOOP_METRIC_KINDS } from './loop-metric-kinds';

/**
 * Event types routed PS-first for a PS-covered project: the Fleet's wildcard
 * row is not written. Alarm-class rows escalate (delayed); the cadence signals
 * and quiet-cause alarm types are shed (psEscalationWanted).
 */
export const PS_FIRST_EVENT_TYPES = [
  'attention_needed', 'run_failed', 'goal_blocked', 'schedule_disabled', 'schedule_near_cap', 'schedule_cap_skipped',
] as const;
/** The two cadence signals — the project supervisor's to act on, shed from the Fleet (never alarm-class). */
export const PS_CADENCE_EVENT_TYPES = ['schedule_near_cap', 'schedule_cap_skipped'] as const;

/** How long the project supervisor gets before the Fleet Supervisor is woken. */
export const PS_ESCALATION_DELAY_MS = 45 * 60 * 1000;
/** Upper bound on a re-held escalation, from its FIRST alarm (stays under the 2 h stale-event banner). */
export const PS_ESCALATION_MAX_HOLD_MS = 90 * 60 * 1000;
/** Alarms one escalation row lists (newest kept; the count is always exact). */
export const PS_ESCALATION_MAX_ALARMS = 6;
/** Project-supervisor chats one escalation tracks. */
export const PS_ESCALATION_MAX_PS = 3;
/** Per-alarm summary clip inside the escalation prompt. */
export const PS_ESCALATION_SUMMARY_CHARS = 280;
/**
 * A project-supervisor wake still running that started after the oldest
 * unhandled alarm re-holds the escalation this long (then re-checked; never
 * past PS_ESCALATION_MAX_HOLD_MS from the first alarm).
 */
export const PS_ESCALATION_INFLIGHT_RECHECK_MS = 10 * 60 * 1000;
/**
 * Passthrough handles an alarm carries into the escalation (the Fleet needs
 * them to act: answer_owner_question takes the question id, which the summary
 * clip could otherwise cut — the owner-question triage summary ENDS with it).
 */
export const PS_ESCALATION_HANDLE_KEYS = ['ownerQuestionId', 'runId', 'scheduleId', 'goalId', 'todoId'] as const;
const HANDLE_LABEL: Record<string, string> = {
  ownerQuestionId: 'owner question id', runId: 'run id', scheduleId: 'schedule id', goalId: 'goal id', todoId: 'todo id',
};
const HANDLE_CHARS = 64;

/** payload.origin of the escalation's direct wake (hookWakeSource reads it). */
export const PS_ESCALATION_ORIGIN = 'ps-escalation';
/** Terminal hook_events status: every alarm the escalation carried was handled by the project supervisor. */
export const HOOK_STATUS_PS_HANDLED = 'skipped:ps_handled';
/** loop_metrics kind (registered in loop-metric-kinds.ts). */
export const PS_ESCALATION_METRIC_KIND = LOOP_METRIC_KINDS.FLEET_PS_ESCALATION;

export function fleetAlarmPsFirstDisabled(): boolean {
  return process.env.HOOK_FLEET_ALARM_PS_FIRST_DISABLED === '1';
}
/** Fleet ledger diff: drop PS-covered lanes from the PROGRESS sections (supervisor-wake-ledger). */
export function fleetDiffPsCoveredDisabled(): boolean {
  return process.env.FLEET_DIFF_PS_COVERED_EXCLUDE_DISABLED === '1';
}
/** Fleet [BOARD]: one top-goal pace line per project (board-digest.service). */
export function fleetBoardGoalPaceDisabled(): boolean {
  return process.env.FLEET_BOARD_GOAL_PACE_DISABLED === '1';
}

export function isPsFirstEventType(eventType: unknown): boolean {
  return (PS_FIRST_EVENT_TYPES as readonly string[]).includes(String(eventType ?? ''));
}
export function isPsCadenceEventType(eventType: unknown): boolean {
  return (PS_CADENCE_EVENT_TYPES as readonly string[]).includes(String(eventType ?? ''));
}

/**
 * Does a redirected row become a delayed escalation, or is it simply shed?
 * ONLY an alarm-class row (the caller's cause-aware isAlarmEvent) escalates.
 * The escalation is a todo_wake row, and todo_wake IS alarm-class at the Fleet
 * (debounce, daily cap, material gate and triage all bypassed) — escalating a
 * QUIET row would turn a gateable signal into a more expensive wake exactly
 * when the project supervisor judged it not worth waking for. So the cadence
 * signals (schedule_near_cap / schedule_cap_skipped — the project supervisor
 * owns its lanes' cadences; schedule_disabled escalates when the schedule
 * actually dies) and an alarm TYPE its own payload made quiet (a stop by a
 * chat, a provider-limit failure whose resume is queued, a rollover with a
 * successor, an archived target's schedule) are shed from the Fleet; the
 * project supervisor still gets the row. Pure.
 */
export function psEscalationWanted(_eventType: unknown, isAlarm: boolean): boolean {
  return isAlarm === true;
}

/** The loop_metrics phase of a shed (not escalated) PS-first row. Pure. */
export function psShedPhase(eventType: unknown): 'shed_cadence' | 'shed_quiet' {
  return isPsCadenceEventType(eventType) ? 'shed_cadence' : 'shed_quiet';
}

/** The passthrough handles (PS_ESCALATION_HANDLE_KEYS) an emission's extra carries; empty values dropped. Pure. */
export function pickAlarmHandles(extra: unknown): Record<string, string> | undefined {
  if (!extra || typeof extra !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const k of PS_ESCALATION_HANDLE_KEYS) {
    const v = (extra as Record<string, unknown>)[k];
    if ((typeof v === 'string' || typeof v === 'number') && String(v).trim()) out[k] = String(v).trim().slice(0, HANDLE_CHARS);
  }
  return Object.keys(out).length ? out : undefined;
}

/** One alarm an escalation carries. */
export interface PsEscalationAlarm {
  eventType: string;
  sourceChatId: string;
  sourceChatTitle?: string;
  /** ISO — when the alarm was emitted (the revalidation compares the PS mark against it). */
  at: string;
  summary: string;
  /** Passthrough handles (PS_ESCALATION_HANDLE_KEYS) rendered after the clipped summary. */
  handles?: Record<string, string>;
}

/** payload.psEscalation of the held direct wake. */
export interface PsEscalationMeta {
  projectId: string;
  projectName?: string | null;
  psChatIds: string[];
  /** ISO of the FIRST alarm (bounds the re-hold). */
  firstAt: string;
  /** Exact number of alarms appended (the list keeps the newest PS_ESCALATION_MAX_ALARMS). */
  count: number;
  alarms: PsEscalationAlarm[];
  /** ISO — the revalidation that escalated this row (the 'escalated' metric is recorded once per stamp). */
  escalatedAt?: string;
}

const msOf = (iso: unknown): number => {
  const t = iso instanceof Date ? iso.getTime() : Date.parse(String(iso ?? ''));
  return Number.isFinite(t) ? t : NaN;
};

/** Tolerant reader of payload.psEscalation (null when absent / malformed). Pure. */
export function readPsEscalation(payload: unknown): PsEscalationMeta | null {
  const p = payload && typeof payload === 'object' ? (payload as any).psEscalation : null;
  if (!p || typeof p !== 'object') return null;
  const projectId = typeof p.projectId === 'string' ? p.projectId : '';
  const alarms: PsEscalationAlarm[] = Array.isArray(p.alarms)
    ? p.alarms.filter((a: any) => a && typeof a === 'object' && Number.isFinite(msOf(a.at))).map((a: any) => {
      const handles = pickAlarmHandles(a.handles);
      return {
        eventType: String(a.eventType ?? ''),
        sourceChatId: String(a.sourceChatId ?? ''),
        ...(a.sourceChatTitle ? { sourceChatTitle: String(a.sourceChatTitle) } : {}),
        at: new Date(msOf(a.at)).toISOString(),
        summary: String(a.summary ?? ''),
        ...(handles ? { handles } : {}),
      };
    })
    : [];
  if (!projectId || !alarms.length) return null;
  const psChatIds = Array.isArray(p.psChatIds) ? p.psChatIds.map((x: unknown) => String(x ?? '')).filter(Boolean).slice(0, PS_ESCALATION_MAX_PS) : [];
  const firstMs = Number.isFinite(msOf(p.firstAt)) ? msOf(p.firstAt) : Math.min(...alarms.map((a) => msOf(a.at)));
  return {
    projectId,
    ...(p.projectName ? { projectName: String(p.projectName) } : {}),
    psChatIds,
    firstAt: new Date(firstMs).toISOString(),
    count: Math.max(alarms.length, Number.isFinite(Number(p.count)) ? Math.floor(Number(p.count)) : alarms.length),
    alarms,
    ...(Number.isFinite(msOf(p.escalatedAt)) ? { escalatedAt: new Date(msOf(p.escalatedAt)).toISOString() } : {}),
  };
}

/** Is this a held escalation row (escalation payload, retryAt still in the future, feature on)? Pure. */
export function isHeldPsEscalation(row: any, nowMs: number = Date.now()): boolean {
  if (fleetAlarmPsFirstDisabled()) return false;
  if (!readPsEscalation(row?.payload)) return false;
  const retryMs = row?.retryAt ? msOf(row.retryAt) : NaN;
  return Number.isFinite(retryMs) && retryMs > nowMs;
}

/** A fresh escalation's meta for its first alarm. Pure. */
export function newPsEscalation(input: { projectId: string; projectName?: string | null; psChatIds: string[]; alarm: PsEscalationAlarm }): PsEscalationMeta {
  return {
    projectId: input.projectId,
    ...(input.projectName ? { projectName: input.projectName } : {}),
    psChatIds: [...new Set(input.psChatIds.filter(Boolean))].slice(0, PS_ESCALATION_MAX_PS),
    firstAt: input.alarm.at,
    count: 1,
    alarms: [clipAlarm(input.alarm)],
  };
}

/** Append one alarm to an open escalation (newest PS_ESCALATION_MAX_ALARMS kept, count exact, PS set unioned). Pure. */
export function appendPsEscalation(meta: PsEscalationMeta, alarm: PsEscalationAlarm, psChatIds: string[] = []): PsEscalationMeta {
  const alarms = [...meta.alarms, clipAlarm(alarm)].sort((a, b) => msOf(a.at) - msOf(b.at)).slice(-PS_ESCALATION_MAX_ALARMS);
  const { escalatedAt: _escalatedAt, ...held } = meta; // a new alarm re-arms the row: its next escalation is counted again
  return {
    ...held,
    psChatIds: [...new Set([...meta.psChatIds, ...psChatIds].filter(Boolean))].slice(0, PS_ESCALATION_MAX_PS),
    count: meta.count + 1,
    alarms,
  };
}

function clipAlarm(a: PsEscalationAlarm): PsEscalationAlarm {
  const s = String(a.summary ?? '').replace(/\s+/g, ' ').trim();
  const { handles: rawHandles, ...rest } = a;
  const handles = pickAlarmHandles(rawHandles);
  return { ...rest, summary: s.length > PS_ESCALATION_SUMMARY_CHARS ? `${s.slice(0, PS_ESCALATION_SUMMARY_CHARS - 1)}…` : s, ...(handles ? { handles } : {}) };
}

/** The project supervisor's high-water mark as the ledger reads it ('default' = no record ⇒ never proof of handling). */
export interface PsMark { at: Date; source: 'store' | 'transcript' | 'default' }

export type PsEscalationVerdict =
  | { action: 'handled'; handled: number }
  | { action: 'rehold'; until: Date; handled: number; unhandled: PsEscalationAlarm[]; reason: 'window' | 'inflight' }
  | { action: 'escalate'; handled: number; unhandled: PsEscalationAlarm[]; psMarkAt: string | null; inflight: boolean };

/** The re-hold cap of an escalation: its FIRST alarm + PS_ESCALATION_MAX_HOLD_MS (epoch ms). Pure. */
export function psEscalationCapMs(meta: PsEscalationMeta): number {
  return msOf(meta.firstAt) + PS_ESCALATION_MAX_HOLD_MS;
}

/**
 * The delivery-time revalidation. An alarm is HANDLED when some project
 * supervisor's recorded mark (store / transcript — never the 24 h default) is
 * later than the alarm. Nothing unhandled ⇒ 'handled'. The oldest unhandled
 * alarm younger than PS_ESCALATION_DELAY_MS ⇒ 'rehold' until it has had its
 * window (capped at firstAt + PS_ESCALATION_MAX_HOLD_MS — past the cap it
 * escalates). A project-supervisor wake still RUNNING that started after the
 * oldest unhandled alarm (opts.inflightStartMs — the mark only advances when a
 * wake completes, so the wake most likely handling the alarm would otherwise
 * not count) ⇒ 'rehold' for PS_ESCALATION_INFLIGHT_RECHECK_MS, same cap.
 * Otherwise 'escalate' with only the unhandled alarms. Pure.
 */
export function psEscalationVerdict(
  meta: PsEscalationMeta,
  marks: Array<PsMark | null | undefined>,
  nowMs: number = Date.now(),
  opts: { inflightStartMs?: number | null } = {},
): PsEscalationVerdict {
  const recorded = marks
    .filter((m): m is PsMark => !!m && m.source !== 'default' && Number.isFinite(m.at?.getTime?.()))
    .map((m) => m.at.getTime());
  const markMs = recorded.length ? Math.max(...recorded) : NaN;
  const unhandled = meta.alarms.filter((a) => !(Number.isFinite(markMs) && markMs > msOf(a.at)));
  const handled = meta.alarms.length - unhandled.length;
  if (!unhandled.length) return { action: 'handled', handled };
  const oldest = Math.min(...unhandled.map((a) => msOf(a.at)));
  const due = oldest + PS_ESCALATION_DELAY_MS;
  const cap = psEscalationCapMs(meta);
  if (due > nowMs && cap > nowMs) return { action: 'rehold', until: new Date(Math.min(due, cap)), handled, unhandled, reason: 'window' };
  const inflightMs = Number(opts.inflightStartMs ?? NaN);
  const inflight = Number.isFinite(inflightMs) && inflightMs > oldest;
  if (inflight && cap > nowMs) {
    return { action: 'rehold', until: new Date(Math.min(nowMs + PS_ESCALATION_INFLIGHT_RECHECK_MS, cap)), handled, unhandled, reason: 'inflight' };
  }
  return { action: 'escalate', handled, unhandled, psMarkAt: Number.isFinite(markMs) ? new Date(markMs).toISOString() : null, inflight };
}

const hhmmz = (iso: string): string => {
  const t = msOf(iso);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 16)}Z` : '?';
};
const clip = (v: unknown, n: number): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** " — owner question id oq_1 · run id r1" (empty when the alarm carries none). Pure. */
function renderHandles(h: Record<string, string> | undefined): string {
  const parts = Object.entries(h ?? {}).filter(([k, v]) => HANDLE_LABEL[k] && v).map(([k, v]) => `${HANDLE_LABEL[k]} ${clip(v, HANDLE_CHARS)}`);
  return parts.length ? ` — ${parts.join(' · ')}` : '';
}

/**
 * The Fleet Supervisor's escalation wake prompt (the direct-wake row's
 * summary). Rendered NEUTRAL at enqueue / append ("held for it first; check
 * its chat — it may already have handled them": a fail-open delivery or the
 * kill switch can deliver it without a revalidation); re-rendered with
 * `revalidated: true` at delivery with only the unhandled alarms — the one
 * place the "has not completed a wake since they fired" fact is known. Each
 * alarm's passthrough handles (owner question id, run id, …) ride after its
 * clipped summary so the clip never cuts them. Generic: no project names
 * beyond the row's own, no incident ids. Pure.
 */
export function renderPsEscalationPrompt(
  meta: PsEscalationMeta,
  opts: { alarms?: PsEscalationAlarm[]; delayMin?: number; revalidated?: boolean; inflight?: boolean } = {},
): string {
  const alarms = opts.alarms ?? meta.alarms;
  const delayMin = opts.delayMin ?? Math.round(PS_ESCALATION_DELAY_MS / 60_000);
  const project = `${meta.projectName ? `"${clip(meta.projectName, 60)}" ` : ''}(${meta.projectId.slice(0, 8)})`;
  const ps = meta.psChatIds.length ? meta.psChatIds.join(', ') : 'unknown';
  const omitted = Math.max(0, meta.count - meta.alarms.length);
  const lines = alarms.map((a) =>
    `- ${a.eventType} at ${hhmmz(a.at)} from lane ${a.sourceChatTitle ? `"${clip(a.sourceChatTitle, 50)}" ` : ''}(chat id ${a.sourceChatId}): ${clip(a.summary, PS_ESCALATION_SUMMARY_CHARS)}${renderHandles(a.handles)}`);
  if (omitted > 0) lines.push(`- …and ${omitted} earlier alarm(s) from this project not listed`);
  const status = opts.revalidated
    ? `These alarm(s) were held ≥${delayMin} min for it first, and it has not completed a wake since they fired${opts.inflight ? ' (a wake it started after them is still running past the hold cap)' : ''}:`
    : 'These alarm(s) are held for it first; check its chat before acting — it may already have handled them:';
  return `[PS ESCALATION — harness-delayed alarm] Project ${project} has its own project supervisor (chat id ${ps}). `
    + `${status}\n${lines.join('\n')}\n\n`
    + 'Read the project supervisor first (get_chat_status / get_chat_messages on its chat id): steer it, or act on the lane directly only if the project supervisor is stuck. '
    + 'Do not duplicate a steer it already sent to the lane.';
}

// ── Fleet [BOARD] top-goal pace line ────────────────────────────────────────

/** A goal row as the fleet pace line picks among them. */
export interface PaceGoalCandidate {
  id: string;
  title: string;
  status: string;
  createdAt?: Date | string | null;
  /** The goal carries a kpi: premise (the project's register of record). */
  hasKpi?: boolean;
  /** Open (pending / in_progress / blocked) todos under it. */
  openTodos?: number;
  /** GOAL-PRIORITY-SPEND (round 3, 2026-10-20): the goal's priority score (goal-priority.ts scoreGoal); absent = unranked. */
  score?: number;
}

/**
 * The project's TOP goal for the fleet pace line: among active / blocked goals,
 * the highest priority SCORE first when the caller ranked them (GOAL-PRIORITY-
 * SPEND, round 3 — absent scores compare equal), then the one carrying a KPI
 * of record, then active over blocked, then the most open work, then the
 * oldest (the mission goal), then id. Null when none. Pure.
 */
export function pickTopGoal<T extends PaceGoalCandidate>(goals: T[]): T | null {
  const live = goals.filter((g) => g && (g.status === 'active' || g.status === 'blocked'));
  if (!live.length) return null;
  const scoreOf = (g: PaceGoalCandidate): number => (typeof g.score === 'number' && Number.isFinite(g.score) ? g.score : 0);
  return [...live].sort((a, b) =>
    scoreOf(b) - scoreOf(a)
    || Number(!!b.hasKpi) - Number(!!a.hasKpi)
    || Number(b.status === 'active') - Number(a.status === 'active')
    || (b.openTodos ?? 0) - (a.openTodos ?? 0)
    || (msOf(a.createdAt) || 0) - (msOf(b.createdAt) || 0)
    || String(a.id).localeCompare(String(b.id)))[0];
}

/** "35m" / "3h" / "4d" — whole units, never negative. Pure. */
export function ageText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export const FLEET_PACE_TITLE_CHARS = 48;

/**
 * One fleet [BOARD] pace line under a project's count line: its top goal, the
 * harness pace phrase (computeGoalEta via goalEtaPhrase), the KPI register when
 * the goal carries one, and how long since the project last moved (a todo
 * closed or the KPI changed). Every value is harness-read. Pure.
 */
export function renderFleetPaceLine(input: {
  goalId: string; goalTitle: string; pace: string; kpi?: string | null; lastMoveMs?: number | null; now: Date;
  /** GOAL-PRIORITY-SPEND (round 3): "P1" / "P2 owner" — rendered right after the goal id. */
  priority?: string | null;
  /** GOAL-PRIORITY-SPEND: "KPI gap 4.92 tok/s to bar ≥10" / "KPI bar ≥10 met". */
  kpiGap?: string | null;
  /** GOAL-PRIORITY-SPEND: "7d $41.20" — the goal's attributed run_spend. */
  spend?: string | null;
}): string {
  const move = input.lastMoveMs != null && Number.isFinite(input.lastMoveMs)
    ? `last move ${ageText(input.now.getTime() - (input.lastMoveMs as number))} ago`
    : 'no move recorded';
  const prio = input.priority ? ` [${clip(input.priority, 12)}]` : '';
  return `  ↳ top goal ${String(input.goalId).slice(0, 8)}${prio} "${clip(input.goalTitle, FLEET_PACE_TITLE_CHARS)}": ${clip(input.pace, 140)}${input.kpi ? ` · ${clip(input.kpi, 140)}` : ''}${input.kpiGap ? ` · ${clip(input.kpiGap, 80)}` : ''}${input.spend ? ` · ${clip(input.spend, 24)}` : ''} · ${move}`;
}

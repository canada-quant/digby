/**
 * Project update — the part of the hourly status card an owner running MANY
 * projects actually reads (owner 2026-09-29, screen recording of the
 * digby-benchmarks supervisor chat: "see how unhelpful the project status are
 * and im still constantly asking for where the project is at … repurpose the
 * status update because really what is wanted in an hourly message about the
 * project … it is too hard to understand what is going on with these statuses
 * and is not helpful when managing many projects").
 *
 * What the recording showed, card after card: the SAME headline every hour
 * ("1 of 4 goals active, 3 done; 1 lane scheduled, none running"), a model
 * paragraph re-worded each hour with contradicting counts ("seven of eight
 * goals" / "three of four"), a "where things stand" strip saying "no estimate
 * yet", and a "You asked" ledger of the same six messages re-annotated every
 * hour — while the one number the owner wanted (66 of 89 tasks, 10 errors)
 * sat inside the paraphrase. Nothing said what CHANGED since the last card,
 * and nothing said, at a glance, whether the project needed him.
 *
 * This leaf answers exactly four questions, DETERMINISTICALLY (no model):
 *
 *   state      one word for the whole project — Needs you / Blocked /
 *              Stalled / Working / Idle / Done / No goals — the pill an owner
 *              scans across many projects;
 *   summary    one line: the main piece of work and how far along it is
 *              ("TB 2.1 v3 full-framework run · 66 of 89 done (74%) · about
 *              2 h left at this pace");
 *   changes    what moved SINCE THE LAST UPDATE (goals / to-dos finished or
 *              newly blocked, new to-dos, a work session started or finished
 *              for good, a progress count moving, the KPI moving, failed
 *              work sessions, new questions) — never "the supervisor checked
 *              in" and never a scheduled lane's routine firing, which are
 *              machine traffic, not news;
 *   needsYou   the open owner questions in their OWN words (≤ 3), and when
 *              the next check is.
 *
 * `changes` is also the card's change signal: an hour with no change and an
 * unchanged board is a quiet hour (the card's in-place "no change" stub), so
 * routine check-ins stop producing a full card every hour. `milestone` (owner
 * 2026-09-29: "the project supervisor should always update the user with a
 * message when something changes or progress is made or a new session related
 * or subsession finishes"; then "doesnt the sweep just cause too much noise? …
 * operate off hooks, schedules, messages, responses") marks a change worth a
 * message — anything but a count ticking up, which counts only when it crosses
 * a quarter mark. Project supervisor chats post ONLY on a milestone (hook
 * events trigger the check; the 15-min sweep is the catch-all).
 *
 * Pure: every input is passed in; the caller (project-status.service) owns the
 * reads.
 */

import { plain, parseProgressFraction, plural } from './project-status.service';
import type { ProjectStatus, ProjectTiming } from './project-status.service';
import { progressNoteLead } from '../platform/progress-note';

/** "Since the last update" bullets kept (newest-first by kind priority). */
export const PROJECT_UPDATE_MAX_CHANGES = 6;
/** Open owner questions quoted on the card. */
export const PROJECT_UPDATE_MAX_ASKS = 3;
const FOCUS_MAX = 90;
const CHANGE_MAX = 110;
const QUESTION_MAX = 180;

export type ProjectUpdateState = 'needs_you' | 'blocked' | 'stalled' | 'working' | 'idle' | 'done' | 'no_goals';

/** Owner-facing pill text per state. */
export const PROJECT_UPDATE_STATE_LABEL: Record<ProjectUpdateState, string> = {
  needs_you: 'Needs you',
  blocked: 'Blocked',
  stalled: 'Stalled',
  working: 'Working',
  idle: 'Idle',
  done: 'Done',
  no_goals: 'No goals',
};

export interface ProjectUpdateProgress {
  done: number;
  total: number;
  /** What the count is of (a to-do / goal / lane title, plain). */
  label?: string;
}

export interface ProjectUpdate {
  state: ProjectUpdateState;
  stateLabel: string;
  /** The one piece of work the project is about right now (plain, ≤ 90). */
  focus?: string;
  progress?: ProjectUpdateProgress;
  /** Rate-based minutes left, when the timing block measured one. */
  etaMinutes?: number;
  /** One line: focus · progress · ETA — or why nothing is moving. */
  summary: string;
  /** Since the last update. Empty = nothing changed. */
  changes: string[];
  /** True when a change is worth posting before the hourly slot — anything
   *  but the progress count moving. */
  milestone: boolean;
  /** Open owner questions, their own words (≤ PROJECT_UPDATE_MAX_ASKS). */
  needsYou: string[];
  /** All open owner questions (the list above is capped). */
  needsYouCount: number;
  /** ISO — the supervisor's next scheduled check, else the earliest lane wake. */
  nextCheckAt?: string;
  /** ISO — the window start ("since the last update"). */
  since: string;
}

export interface UpdateGoalRow { id: string; title: string; status: string; progressNote: string | null; blockedReason: string | null; updatedAt: Date; createdAt?: Date | null; blockedAt?: Date | null }
export interface UpdateTodoRow { id: string; goalId?: string | null; title: string; status: string; progressNote: string | null; blockedReason: string | null; updatedAt: Date; createdAt?: Date | null; blockedAt?: Date | null }

export interface ProjectUpdateInputs {
  status: ProjectStatus;
  goals: UpdateGoalRow[];
  todos: UpdateTodoRow[];
  since: Date;
  now: Date;
  /** Open owner questions on the project's chats, newest first. */
  openQuestions: Array<{ question: string; createdAt?: Date | null }>;
  /** run_failed hook events in the window. */
  failedRuns: number;
  /** The previous card's update — the progress delta source. */
  prev?: Pick<ProjectUpdate, 'progress'> | null;
  /** Work sessions (lane chats, sub-sessions included) that STARTED in the
   *  window, and ones that FINISHED for good in it (last run completed, not
   *  running, no enabled schedule — a scheduled lane's routine firing is not a
   *  finish). `gist` = the first line of the session's last reply, plain. */
  sessions?: { started: string[]; finished: Array<{ title: string; gist?: string }> };
}

const at = (d: Date | null | undefined): number => (d instanceof Date ? d.getTime() : d ? new Date(d as any).getTime() : NaN);
const inWindow = (d: Date | null | undefined, sinceMs: number, nowMs: number): boolean => {
  const t = at(d);
  return Number.isFinite(t) && t >= sinceMs && t <= nowMs;
};

/** The main piece of work + its countable progress. Pure. */
export function pickFocus(inputs: Pick<ProjectUpdateInputs, 'goals' | 'todos'> & { timing?: ProjectTiming }): { focus?: string; progress?: ProjectUpdateProgress; etaMinutes?: number } {
  const inProgress = inputs.todos.filter((t) => t.status === 'in_progress');
  const active = inputs.goals.filter((g) => g.status === 'active');
  const blocked = inputs.goals.filter((g) => g.status === 'blocked');
  const focusRow = inProgress[0] ?? active[0] ?? blocked[0];
  const focus = focusRow ? plain(focusRow.title, FOCUS_MAX) || undefined : undefined;

  // Progress: a lane's measured fraction first (it carries the ETA), then the
  // in-progress to-dos' notes, then the active goals' notes — the count the
  // owner kept asking for usually lives in the goal's own progress note.
  const lane = (inputs.timing?.lanes ?? []).find((l) => l.progress);
  if (lane?.progress) {
    return {
      focus,
      progress: { done: lane.progress.done, total: lane.progress.total, ...(lane.progress.label ? { label: lane.progress.label } : {}) },
      ...(lane.eta && lane.eta.minutes > 0 ? { etaMinutes: lane.eta.minutes } : {}),
    };
  }
  for (const r of [...inProgress, ...active]) {
    // a8d6e514: parse the note's LEAD (the count lives in the one-line status; a ledger tail is not progress).
    const frac = parseProgressFraction(progressNoteLead(r.progressNote)) ?? parseProgressFraction(r.title);
    if (frac) return { focus, progress: { ...frac, label: plain(r.title, 80) } };
  }
  return { focus };
}

export function deriveState(input: {
  status: ProjectStatus;
  todos: UpdateTodoRow[];
  stalled: boolean;
}): ProjectUpdateState {
  const { status } = input;
  const g = status.goals;
  const total = g.active + g.done + g.blocked;
  if (status.ownerItems > 0) return 'needs_you';
  if (total > 0 && g.active === 0 && g.blocked === 0) return 'done';
  const inProgress = input.todos.some((t) => t.status === 'in_progress');
  if (g.blocked > 0 && g.active === 0) return 'blocked';
  if (!inProgress && input.todos.some((t) => t.status === 'blocked') && status.lanesRunning === 0) return 'blocked';
  if (input.stalled) return 'stalled';
  if (status.lanesRunning > 0) return 'working';
  if (total === 0 && !inProgress) return 'no_goals';
  return 'idle';
}

function progressText(p: ProjectUpdateProgress): string {
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  return p.total === 100 && !p.label ? `${p.done}%` : `${p.done.toLocaleString('en-US')} of ${p.total.toLocaleString('en-US')} done (${pct}%)`;
}

export function etaText(min: number): string {
  if (min < 60) return `about ${Math.max(1, Math.ceil(min))} min left at this pace`;
  if (min < 24 * 60) return `about ${Math.round(min / 60)} h left at this pace`;
  return `about ${Math.round(min / 1440)} d left at this pace`;
}

/** The one change that is NOT a milestone on its own — a count ticking up. */
const PROGRESS_LINE_RE = /^Progress: /;

/** A count moving is news only when it crosses a quarter mark (25 / 50 / 75 /
 *  100 %) on the same total — 61 → 62 of 89 rides the next real update. Pure. */
export function progressCrossedQuarter(prev: { done: number; total: number } | undefined, cur: { done: number; total: number } | undefined): boolean {
  if (!prev || !cur || prev.total !== cur.total || cur.total <= 0 || cur.done <= prev.done) return false;
  const q = (d: number) => Math.floor((d / cur.total) * 4 + 1e-9);
  return q(cur.done) > q(prev.done);
}

/** What moved since the last update. Pure; ordered by importance. */
export function deriveChanges(inputs: ProjectUpdateInputs, progress?: ProjectUpdateProgress): string[] {
  const sinceMs = inputs.since.getTime();
  const nowMs = inputs.now.getTime();
  const out: string[] = [];
  const push = (s: string) => { const t = plain(s, CHANGE_MAX); if (t && !out.includes(t)) out.push(t); };

  for (const g of inputs.goals) if (g.status === 'done' && inWindow(g.updatedAt, sinceMs, nowMs)) push(`Goal done: ${g.title}`);
  // "Now blocked" keys on blockedAt — stamped on the TRANSITION into blocked
  // (goals.service), never on a reason rewrite. The reason itself is NOT
  // quoted here: the card's Blocked section renders it through the owner-wait
  // rules (a lane-written "owner decided …" is never repeated as a ruling).
  for (const g of inputs.goals) if (g.status === 'blocked' && inWindow(g.blockedAt ?? null, sinceMs, nowMs)) push(`Goal now blocked: ${g.title}`);
  const newQuestions = inputs.openQuestions.filter((q) => inWindow(q.createdAt ?? null, sinceMs, nowMs)).length;
  if (newQuestions > 0) push(`${newQuestions === 1 ? 'A new question is' : `${newQuestions} new questions are`} waiting for you`);
  if (inputs.failedRuns > 0) push(`${plural(inputs.failedRuns, 'work session')} hit an error`);
  for (const f of inputs.sessions?.finished ?? []) {
    const gist = plain(f.gist ?? '', 70);
    push(`Session finished: ${plain(f.title, 50)}${gist ? ` — ${gist}` : ''}`);
  }
  for (const t of inputs.sessions?.started ?? []) push(`New session started: ${t}`);

  const kpi = inputs.status.kpi;
  if (kpi && kpi.setAt && inWindow(new Date(kpi.setAt), sinceMs, nowMs)) {
    const key = kpi.key.replace(/^kpi:/, '').replace(/[_-]+/g, ' ');
    const unit = kpi.unit ? ` ${kpi.unit}` : '';
    if (typeof kpi.prevValue === 'number' && kpi.prevValue !== kpi.value) push(`${key}: ${kpi.prevValue} → ${kpi.value}${unit}`);
    else if (typeof kpi.prevValue !== 'number') push(`${key} measured: ${kpi.value}${unit}`);
  }

  const prev = inputs.prev?.progress;
  if (progress && prev && prev.total === progress.total && prev.done !== progress.done) {
    push(`Progress: ${prev.done.toLocaleString('en-US')} → ${progress.done.toLocaleString('en-US')} of ${progress.total.toLocaleString('en-US')}`);
  }

  for (const t of inputs.todos) if (t.status === 'done' && inWindow(t.updatedAt, sinceMs, nowMs)) push(`Finished: ${t.title}`);
  for (const t of inputs.todos) if (t.status === 'blocked' && inWindow(t.blockedAt ?? null, sinceMs, nowMs)) push(`Now blocked: ${t.title}`);
  for (const t of inputs.todos) {
    if ((t.status === 'pending' || t.status === 'in_progress') && inWindow(t.createdAt ?? null, sinceMs, nowMs)) push(`New to-do: ${t.title}`);
  }
  for (const g of inputs.goals) if (g.status === 'active' && inWindow(g.createdAt ?? null, sinceMs, nowMs)) push(`New goal: ${g.title}`);

  if (out.length > PROJECT_UPDATE_MAX_CHANGES) {
    const rest = out.length - (PROJECT_UPDATE_MAX_CHANGES - 1);
    return [...out.slice(0, PROJECT_UPDATE_MAX_CHANGES - 1), `…and ${plural(rest, 'more change')}`];
  }
  return out;
}

function nextCheck(timing: ProjectTiming | undefined): string | undefined {
  if (!timing) return undefined;
  if (timing.nextCheckAt) return timing.nextCheckAt;
  return timing.lanes.map((l) => l.nextWakeAt).filter((x): x is string => !!x).sort()[0];
}

function buildSummary(state: ProjectUpdateState, f: ReturnType<typeof pickFocus>, status: ProjectStatus): string {
  const parts: string[] = [];
  if (f.focus) parts.push(f.focus);
  if (f.progress) parts.push(progressText(f.progress));
  if (f.etaMinutes) parts.push(etaText(f.etaMinutes));
  if (state === 'done') {
    const n = status.goals.done;
    return `All ${plural(n, 'goal')} done.`;
  }
  if (state === 'no_goals') return 'No goals have been set for this project yet.';
  if (!parts.length) {
    if (state === 'idle') return 'Nothing is running right now.';
    return 'No work item is in progress.';
  }
  let s = parts.join(' · ');
  if (state === 'idle' && !f.progress) s += ' · nothing running right now';
  if (state === 'stalled') s += ' · no movement since the last update';
  return s;
}

/** The whole update. Pure. */
export function buildProjectUpdate(inputs: ProjectUpdateInputs): ProjectUpdate {
  const f = pickFocus({ goals: inputs.goals, todos: inputs.todos, timing: inputs.status.timing });
  // Stalled only on the timing block's MEASURED stall (a lane's own count
  // unmoved ≥ 30 min across two cards) — a goal note nobody rewrote this hour
  // is not evidence the work stopped, and a false "Stalled" pill is an alarm.
  const stalled = (inputs.status.timing?.lanes ?? []).some((l) => l.progress?.stalled && l.state === 'running');
  const state = deriveState({ status: inputs.status, todos: inputs.todos, stalled });
  const needsYou = inputs.openQuestions.map((q) => plain(q.question, QUESTION_MAX)).filter(Boolean);
  const next = nextCheck(inputs.status.timing);
  const changes = deriveChanges(inputs, f.progress);
  return {
    state,
    stateLabel: PROJECT_UPDATE_STATE_LABEL[state],
    ...(f.focus ? { focus: f.focus } : {}),
    ...(f.progress ? { progress: f.progress } : {}),
    ...(f.etaMinutes ? { etaMinutes: f.etaMinutes } : {}),
    summary: buildSummary(state, f, inputs.status),
    changes,
    milestone: changes.some((c) => !PROGRESS_LINE_RE.test(c)) || progressCrossedQuarter(inputs.prev?.progress, f.progress),
    needsYou: needsYou.slice(0, PROJECT_UPDATE_MAX_ASKS),
    needsYouCount: Math.max(inputs.status.ownerItems, needsYou.length),
    ...(next ? { nextCheckAt: next } : {}),
    since: inputs.since.toISOString(),
  };
}

/** Markdown lines for surfaces that only have the body (Telegram, history). */
export function renderUpdateMarkdown(u: ProjectUpdate): string {
  const lines = [`**${u.stateLabel}** — ${u.summary}`];
  lines.push(u.changes.length ? `Since the last update: ${u.changes.join('; ')}.` : 'No change since the last update.');
  if (u.needsYou.length) lines.push(`Needs you: ${u.needsYou.map((q) => `"${q}"`).join('; ')}`);
  return lines.join('\n');
}

/**
 * In-run NO-PROGRESS brake (audit 2026-10-06 T1-7, litellm.md F5).
 *
 * The litellm MiMo lane ran 340 + 416 minutes (a8d408d5 / 01fcfe2a: 471 and
 * 290 run_command calls, 126 search_memory calls) with ZERO file edits while
 * its plan step "add the two routes" sat in_progress — "Recon is nearly
 * complete. Before editing I need four remaining facts…" every ~2 min for
 * hours. The existing zero-edit guard (continuation-guard.ts) counts whole
 * continuation ROUNDS (each a 4–8 h run), and goal-continue's "no progress for
 * two rounds" also fires only at round end — nothing watched INSIDE a run.
 *
 * Rule: a CODING-profile top-level run (never a supervisor / chat profile, never
 * a worker) that makes ≥ NO_PROGRESS_BRAKE_CALLS (default 80) consecutive tool
 * calls none of which CHANGED anything (file write / edit, git commit / push,
 * PR open / merge, a delegation, or an organizational platform mutation —
 * communication-only tools such as send_chat_message / notify_user /
 * file_feedback / schedule arms do not count), while a plan step is
 * in_progress, gets ONE harness notice per run: make the core change now or
 * state the blocker. A notice, never a gate — the run keeps every tool.
 * Telemetry: loop_metrics `no_progress_brake`. Kill switch
 * NO_PROGRESS_BRAKE_DISABLED=1. Pure leaf (no I/O) except the env reads.
 */

import { PLATFORM_MUTATING_TOOLS } from '../platform/platform-tool-names';

export const NO_PROGRESS_BRAKE_DEFAULT_CALLS = 80;
/** Past the threshold with no in_progress step, the plan is re-read at most every this many calls. */
export const NO_PROGRESS_RECHECK_EVERY = 10;

export function noProgressBrakeDisabled(): boolean {
  const v = String(process.env.NO_PROGRESS_BRAKE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** NO_PROGRESS_BRAKE_CALLS (integer ≥ 10) else the default 80. */
export function noProgressBrakeThreshold(): number {
  const n = Number(process.env.NO_PROGRESS_BRAKE_CALLS);
  return Number.isFinite(n) && n >= 10 ? Math.floor(n) : NO_PROGRESS_BRAKE_DEFAULT_CALLS;
}

/** Platform mutations that move WORDS or TIMERS, not the work itself. */
const NOT_PROGRESS_PLATFORM: ReadonlySet<string> = new Set([
  'send_chat_message', 'notify_user', 'file_feedback', 'update_feedback', 'flag_owner_question',
  'remember_fact', 'forget_fact', 'add_knowledge_note', 'add_knowledge_url',
  'schedule_message', 'update_schedule', 'cancel_schedule', 'rename_chat',
  'update_supervisor_state', 'goal_premise_set',
]);

/** Tool calls that CHANGE something — any one resets the streak. */
export const NO_PROGRESS_RESET_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'edit_file', 'ast_rewrite',
  'git_commit', 'git_push', 'open_pull_request', 'merge_pull_request',
  // A delegation may carry the edits (a coder worker writes in this worktree).
  'delegate', 'delegate_parallel',
  ...(PLATFORM_MUTATING_TOOLS as readonly string[]).filter((t) => !NOT_PROGRESS_PLATFORM.has(t)),
]);

/**
 * audit 2026-10-08 W2-7 (lanes.md F9): the brake fired ONCE per run and ANY
 * delegation reset the streak — One Piece runs kept going 2.5–4.7 h after the
 * notice (5d96cb5c issued 11 read-only delegations, each "changed something").
 * Now (v2): a delegation is not progress by itself — the WORKER's own changes
 * are (its write / edit / commit / push / PR calls, counted by the worker's loop
 * and reported back — AgentRunResult.progressCalls); and the brake re-fires
 * with escalation every N further no-progress calls (rungs, ≤
 * NO_PROGRESS_MAX_RUNGS per run). Kill switch NO_PROGRESS_BRAKE_V2_DISABLED=1
 * restores the one-shot, delegation-resets brake.
 */
export function noProgressBrakeV2Disabled(): boolean {
  const v = String(process.env.NO_PROGRESS_BRAKE_V2_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Rungs per run (rung 1 = the original notice; 2+ = escalations). */
export const NO_PROGRESS_MAX_RUNGS = 4;

const DELEGATION_TOOLS: ReadonlySet<string> = new Set(['delegate', 'delegate_parallel']);

export function isProgressTool(name: string): boolean {
  const n = String(name ?? '');
  if (!noProgressBrakeV2Disabled() && DELEGATION_TOOLS.has(n)) return false;
  return NO_PROGRESS_RESET_TOOLS.has(n);
}

/** A tool call that itself CHANGED something (never a delegation) — what a worker reports back as progress. */
export function isChangeTool(name: string): boolean {
  const n = String(name ?? '');
  return !DELEGATION_TOOLS.has(n) && NO_PROGRESS_RESET_TOOLS.has(n);
}

/** The escalated notice for rung ≥ 2 (W2-7). Pure. */
export function noProgressEscalationNotice(calls: number, step: { id: number | string; text: string }, rung: number): string {
  const stepText = String(step.text ?? '').replace(/\s+/g, ' ').slice(0, 160);
  return `[HARNESS NOTICE — not typed by the user] NO-PROGRESS CHECK #${rung}: ${calls} tool calls in a row have now changed NOTHING since the last notice (no file edit, commit, push or PR — delegating more research does not count; only a worker's own edits do) while plan step #${step.id} "${stepText}" is in progress. Stop investigating. Your NEXT call must be the core change itself — or mark step #${step.id} blocked via update_plan with the exact blocker and finish this round with a short blocker report (it reaches whoever is waiting on this run). Do not start another read-only pass.`;
}

/** The one notice (user-role harness framing — ZAI rejects mid-run system messages). Pure. */
export function noProgressNotice(calls: number, step: { id: number | string; text: string }): string {
  const stepText = String(step.text ?? '').replace(/\s+/g, ' ').slice(0, 160);
  return `[HARNESS NOTICE — not typed by the user] NO-PROGRESS CHECK: ${calls} tool calls in a row without changing anything (no file edit, commit, push or PR) while plan step #${step.id} "${stepText}" is in progress. More reading will not finish it. Make the core change NOW — the minimal edit that moves the step, then commit — and leave peripheral checks for after it lands; or, if something genuinely blocks the change, mark the step blocked via update_plan with the exact blocker. If this step is operational by nature (deploys, probes, migrations run by command), say so in one line and carry on.`;
}

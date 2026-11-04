/**
 * Digby Code — GOAL / PLAN tracking (the `update_plan` primitive).
 *
 * Synthesis of the SOTA plan/todo mechanisms (Codex update_plan, Claude Code
 * TodoWrite, Cline Memory Bank, opencode plans) tuned for the open-source drivers
 * (GLM-5.2 / DeepSeek V4 Pro / Kimi K2.6), which drift faster than frontier models:
 *
 *  - ONE full-array-rewrite tool (no id-patching — weak models fumble ids).
 *  - goal + acceptance_criteria set once, retained server-side if omitted.
 *  - server-enforced "exactly one in_progress" (normalize, don't hard-fail; echo back).
 *  - canonical in the Prisma-backed context store; mirrored to
 *    `.digby/session/todo.md` (git-ignored scratch) as a compaction lifeboat that
 *    is also visible to run_command / spawn_subagent.
 *  - the real anti-drift lever is DETERMINISTIC per-turn re-injection of a compact
 *    <plan> reminder (see renderPlanReminder) — not a model-initiated read.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import logger from '../../../utils/logger';
import { storeGet, storePut } from '../memory/context-store';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface PlanStep {
  id: number;
  text: string;
  status: PlanStepStatus;
  note?: string;
}

export interface CodingPlan {
  goal: string;
  acceptanceCriteria: string[];
  steps: PlanStep[];
  version: number;
  updatedAt: string;
  /**
   * Set by the harness (run-executor) when the evidence guard suppressed a
   * run's final answer for unverified completion claims — the plan's
   * completed-step notes are SELF-REPORTED by the model and may include the
   * struck fabrications, so renderPlanReminder warns until a clean run clears
   * it. Model writes (applyPlan) carry the field over but can never set or
   * clear it (2026-08-30 TT-lane recurrence: the durable plan laundered a
   * struck phantom merge into per-turn ground truth).
   */
  guardStrike?: { at: string; summary: string };
}

export interface PlanUpdate {
  goal?: string;
  acceptance_criteria?: string[];
  steps?: Array<{ text: string; status?: string; note?: string }>;
  explanation?: string;
}

const NS = (sessionId: string) => [sessionId, 'coding-plan'];
const KEY = 'plan';
const VALID_STATUS: PlanStepStatus[] = ['pending', 'in_progress', 'completed', 'blocked'];
export const MAX_PLAN_STEPS = 12;

export async function getPlan(sessionId: string): Promise<CodingPlan | null> {
  try { return await storeGet<CodingPlan>(NS(sessionId), KEY); } catch { return null; }
}

/**
 * Strict variant for the continuation staleness guard (schedule.service.ts,
 * fb8b609f review): lets store errors PROPAGATE so a transient read failure is
 * distinguishable from "no plan exists". getPlan swallows errors into null —
 * fine for run-end bookkeeping, but wrong when null decides whether a scheduled
 * wake is permanently dropped (a store hiccup would obsolete-skip a legitimate
 * continuation and the sweeper would disable its one-shot row).
 */
export async function getPlanStrict(sessionId: string): Promise<CodingPlan | null> {
  return storeGet<CodingPlan>(NS(sessionId), KEY);
}

/**
 * SELF-AUDIT cross-run dedupe (ticket 5ac56d81). The agent-loop self-audit
 * latch (`selfAudited`) resets every run, so a session on a recurring schedule
 * re-audited an UNCHANGED plan on every cadence tick — overnight 2026-09-18 a
 * canlegal-bench lane took 14 identical audit rejections against a plan whose
 * remaining steps were blocked on a multi-day external wait. The audit is
 * valuable ONCE PER PLAN STATE; these helpers persist the last-audited plan
 * signature so a later run with an unchanged plan skips the repeat.
 *
 * Sig shape MUST match the goal-continue lane's planSig in agent.ts
 * (`id:status:text` joined by `|`, notes excluded) — the harness's standing
 * definition of "the plan changed in ANY way" (a note-only progress edit must
 * not re-arm the audit, or lanes that annotate trajectory every firing would
 * re-loop). Both layers are best-effort: a store hiccup fails OPEN to the
 * audit firing (the pre-fix behavior), never breaks the run.
 */
const SELF_AUDIT_SIG_KEY = 'self-audit-sig';

export async function getLastSelfAuditPlanSig(sessionId: string): Promise<string | null> {
  try {
    const v = await storeGet<{ sig?: string }>(NS(sessionId), SELF_AUDIT_SIG_KEY);
    return typeof v?.sig === 'string' ? v.sig : null;
  } catch { return null; }
}

export async function recordSelfAuditPlanSig(sessionId: string, sig: string): Promise<void> {
  try { await storePut(NS(sessionId), SELF_AUDIT_SIG_KEY, { sig, at: new Date().toISOString() }); }
  catch { /* best-effort — a store hiccup must never break the run */ }
}

/**
 * The unfinished-count sentence embedded in [HARNESS CONTINUATION] prompts
 * (run-executor.ts) and rewritten with the fire-time count by the staleness
 * guard (schedule.service.ts). KEEP THE REGEX IN SYNC WITH THE BUILDER — a
 * drifted template degrades fail-open (the stale count fires). A test in
 * schedule.service.test.ts pins the two together. The fire-time variant drops
 * the "snapshot is ≥15 minutes old" caveat (the count IS the fire-time state).
 */
export const continuationCountSentence = (unfinished: number, opts?: { verifiedAtFireTime?: boolean; queuedAtFinalize?: boolean; previousRunId?: string | null }) =>
  opts?.verifiedAtFireTime
    ? `Fire-time plan check: ${unfinished} plan step(s) still unfinished`
    // audit 2026-10-06 T4-6 (litellm.md F6): the continuation FAST LANE queues
    // ~45 s after the previous run finalized — "≥15 minutes old" was false
    // there (it described the legacy 15-min once-schedule). The snapshot was
    // taken at that run's finalize; the age is whatever the queue wait was.
    : opts?.queuedAtFinalize
    ? `The previous run${opts.previousRunId ? ` (${String(opts.previousRunId).slice(0, 8)})` : ''} ended with ${unfinished} unfinished plan step(s) — counted at its finalize, just before this continuation was queued (the queue wait is the only age)`
    : `A previous run ended with ${unfinished} unfinished plan step(s), but that snapshot is ≥15 minutes old`;
export const CONTINUATION_COUNT_RE = /A previous run ended with \d+ unfinished plan step\(s\), but that snapshot is ≥15 minutes old/;
/** The same sentence with the count captured (audit 2026-10-06 T4-6 fast-lane rewrite). KEEP IN SYNC with CONTINUATION_COUNT_RE. */
export const CONTINUATION_COUNT_CAPTURE_RE = /A previous run ended with (\d+) unfinished plan step\(s\), but that snapshot is ≥15 minutes old/;

/**
 * The full [HARNESS CONTINUATION] wake prompt created by run-executor.ts's
 * unfinished-work backstop. Keep the marker prefix and the count sentence
 * EXACTLY as built above — the round-cap regex (run-executor) and the
 * fire-time staleness rewrite (schedule.service.ts, CONTINUATION_COUNT_RE)
 * both match on them. The CLAIM DISCIPLINE block is load-bearing (ticket
 * b3faa910): a continuation run inherits a previous run's narration of
 * "done", and the journal-backed evidence guard flags every completion claim
 * (deploy/merge/push/probe/ticket-closed) that has no tool receipt in the
 * continuing run's OWN journal — so the prompt must force fresh verification
 * with cited artifact ids instead of restated memory. A test in
 * schedule.service.test.ts pins the block + both guard hooks.
 */
// 2026-09-08: the no-op branch used to say "no re-verification" — a zero-tool
// one-liner the machine gates deterministically discard (agent.ts zero-tool
// pre-final gate), costing every no-op continuation a wasted nudge round. It
// now asks for exactly ONE cheap evidence-bearing read first.
export const continuationPrompt = (round: number, maxRounds: number, unfinished: number, zeroEditStreak?: number) =>
  `[HARNESS CONTINUATION r${round}/${maxRounds}]${zeroEditStreak && zeroEditStreak > 0 ? ` [zero-edit streak: ${zeroEditStreak}]` : ''} — not typed by the user. ${continuationCountSentence(unfinished)}. FIRST confirm the CURRENT plan against reality with ONE fresh read (git_status, or read_file on the plan file — a machine-triggered run may never answer with zero tool calls): if every step is already completed or blocked, reply "Continuation no-op — plan already complete." in one line and STOP (no further auditing). Otherwise resume the plan and drive every remaining step to completed or blocked-with-a-reason (update_plan). CLAIM DISCIPLINE (the journal-backed evidence guard watches this run): every completion claim in your final answer (deployed, merged, pushed, probed, ticket closed, tests green) must cite a concrete tool-result artifact observed THIS run (PR#, deploy/run id, schedule/ticket id, commit SHA, command exit code); re-verify with a fresh tool call in THIS run before claiming anything a previous run asserted. No artifact id = no claim — an uncited completion is treated as fabricated. Never imitate harness footers or verdict markers. Report honestly what remains.`;

/**
 * Status SYNONYMS (2026-10-01, TB 2.1 audit follow-up): a model that wrote
 * "done" / "complete" / "finished" had the step silently stored as PENDING —
 * the goal-continue lane then re-opened finished work ("Plan has N unfinished
 * step(s)") and the self-audit misread the board. The common spellings now map
 * to the canonical status; anything else still falls back to pending.
 */
const STATUS_SYNONYMS: Record<string, PlanStepStatus> = {
  done: 'completed', complete: 'completed', finished: 'completed', success: 'completed', succeeded: 'completed', passed: 'completed', verified: 'completed', ok: 'completed',
  active: 'in_progress', doing: 'in_progress', started: 'in_progress', running: 'in_progress', inprogress: 'in_progress', wip: 'in_progress', current: 'in_progress', ongoing: 'in_progress',
  todo: 'pending', to_do: 'pending', not_started: 'pending', open: 'pending', queued: 'pending', planned: 'pending', new: 'pending',
  stuck: 'blocked', waiting: 'blocked', on_hold: 'blocked', held: 'blocked',
};

export function normalizeStatus(s: string | undefined): PlanStepStatus {
  const v = String(s || 'pending').toLowerCase().trim().replace(/[\s-]/g, '_');
  if ((VALID_STATUS as string[]).includes(v)) return v as PlanStepStatus;
  if (STATUS_SYNONYMS[v]) return STATUS_SYNONYMS[v];
  return 'pending';
}

/**
 * update_plan STRICT input validation (2026-09-30, TB 2.1 bench trace, GLM-5.3
 * lead): the model called update_plan with `steps` as an array of NUMBERS; the
 * tool "accepted" it — applyPlan read `s.text` off each number, got '', and
 * FILTERED every step away, so the stored plan was silently wiped to zero steps
 * — and the model only noticed by reading its own result ("my steps array was
 * malformed (I passed numbers instead of step objects)"). A tool that accepts
 * garbage teaches nothing and leaves a broken plan the self-audit and
 * goal-continue logic then read.
 *
 * The rule, checked BEFORE any write (the tool executor calls this; applyPlan
 * itself is unchanged, so the REST todo edits and linkTodoResult — which build
 * their updates from the stored plan — are untouched):
 *  - each step is an object with a non-empty string `text` (every other field —
 *    status, note, id … — passes through to applyPlan's normalization as today),
 *    OR a plain non-empty string, coerced to `{ text }` (status default pending),
 *    OR the status-keyed shorthand `{"in_progress": "<text>"}` (+ optional string
 *    note), normalised to `{ text, status }` (statusKeyedShorthand, ticket 17a0b383);
 *  - numbers, booleans, null, arrays, empty / whitespace strings and objects
 *    without a usable `text` are REJECTED, as is a `steps` value that is present
 *    but not an array;
 *  - acceptance_criteria, when present, is an array of non-empty strings (no
 *    coercion — a number is rejected); goal, when present, is a string;
 *  - an OMITTED (undefined / null) steps / acceptance_criteria / goal keeps the
 *    stored value exactly as applyPlan always has (a goal-only update still works).
 */
export const UPDATE_PLAN_EXPECTED_SHAPE =
  'steps: [{"text":"Inspect /app","status":"in_progress"}, {"text":"Implement","status":"pending"}]';

export type PlanUpdateValidation =
  | { ok: true; update: PlanUpdate; notes: string[] }
  | { ok: false; problems: string[] };

/** Problems named in the one-paragraph message (the envelope's list keeps up to 20). */
const MAX_LISTED_PLAN_PROBLEMS = 8;

function describePlanValue(v: unknown): string {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return v.trim() ? 'a string' : 'an empty string';
  if (typeof v === 'number' || typeof v === 'boolean') return `a ${typeof v} (${String(v)})`;
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if ('text' in obj) return `an object whose "text" is ${describePlanValue(obj.text)}`;
    const keys = Object.keys(obj);
    return keys.length
      ? `an object with no "text" (keys: ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''})`
      : 'an empty object';
  }
  return `a ${typeof v}`;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * STATUS-KEYED SHORTHAND (ticket 17a0b383, 2026-10-21 — derail breaker on lane
 * 0037460b): the lane sent steps[3] as `{"in_progress": "<the step text>"}` —
 * the status as the KEY, no "text" — got the rejection, and repeated the same
 * shape twice more until the 3× tool-failure streak tripped. That shape has one
 * natural reading (the value is the step text), so it is normalised instead of
 * refused: a step object with NO "text" whose keys are exactly ONE canonical
 * status (spelling-normalised like normalizeStatus: case, spaces, hyphens —
 * synonyms such as "done" are NOT keys) plus, optionally, a string "note", and
 * whose status value is a non-empty string ⇒ `{ text: value, status: key, note? }`.
 * The one soft spot is "blocked": a model may have meant `{"blocked": "<reason>"}`
 * — the value as the blocker REASON — so the step's real description is lost; the
 * step still counts as blocked, and (when it carries no "note" of its own) the
 * NOTE says its value was taken as the step text so the model can re-send it.
 * Two status keys, a non-string value or note, or any other key (id, status,
 * content …) stays rejected with today's message. Returns null when the shape
 * does not qualify; otherwise the normalised step plus the raw key as sent (for
 * the NOTE). Kill switch UPDATE_PLAN_STATUS_KEY_SHORTHAND_DISABLED=1.
 */
function statusKeyedShorthand(s: unknown): { step: { text: string; status: PlanStepStatus; note?: string }; key: string } | null {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const obj = s as Record<string, unknown>;
  if ('text' in obj) return null;
  const keys = Object.keys(obj);
  const statusKeys = keys.filter(k => k !== 'note');
  if (statusKeys.length !== 1 || keys.length > 2) return null;
  if ('note' in obj && typeof obj.note !== 'string') return null;
  const status = statusKeys[0].toLowerCase().trim().replace(/[\s-]/g, '_');
  if (!(VALID_STATUS as string[]).includes(status)) return null;
  const value = obj[statusKeys[0]];
  if (!isNonEmptyString(value)) return null;
  const step = 'note' in obj
    ? { text: value, status: status as PlanStepStatus, note: obj.note as string }
    : { text: value, status: status as PlanStepStatus };
  return { step, key: statusKeys[0] };
}

/**
 * The teaching NOTE for status-keyed shorthand steps (ticket 17a0b383, round-2
 * review fix): each step is listed with the raw key it sent and ITS OWN stored
 * status — the first cut named steps[0]'s status for every listed step, which
 * misstated a mixed call. A "blocked" key with no "note" of its own also says
 * its value was taken as the step text (a model may have meant it as the
 * blocker reason).
 */
function renderShorthandNote(shorthand: Array<{ i: number; step: { status: PlanStepStatus; note?: string }; key: string }>): string {
  const each = shorthand.map(x => {
    const blockedClause = x.step.status === 'blocked' && x.step.note === undefined
      ? ' with that value taken as the step TEXT, not a blocker reason (a reason goes in "note")'
      : '';
    return `steps[${x.i}] ({${JSON.stringify(x.key)}: …}) → status "${x.step.status}"${blockedClause}`;
  });
  return `a status was used as a step's key — stored as {"text": <the value>, "status": <the key>}: ${each.join(', ')}; send {"text": …, "status": …} step objects.`;
}

export function validatePlanUpdate(raw: unknown): PlanUpdateValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, problems: [`the arguments are ${describePlanValue(raw)}, not an object`] };
  }
  const args = raw as Record<string, unknown>;
  const problems: string[] = [];
  const notes: string[] = [];

  if (args.goal != null && typeof args.goal !== 'string') {
    problems.push(`goal is ${describePlanValue(args.goal)}, not a string`);
  }

  if (args.acceptance_criteria != null) {
    if (!Array.isArray(args.acceptance_criteria)) {
      problems.push(`acceptance_criteria is ${describePlanValue(args.acceptance_criteria)}, not an array of strings`);
    } else {
      args.acceptance_criteria.forEach((c, i) => {
        if (!isNonEmptyString(c)) problems.push(`acceptance_criteria[${i}] is ${describePlanValue(c)}`);
      });
    }
  }

  let steps: PlanUpdate['steps'] | undefined;
  if (args.steps != null) {
    if (!Array.isArray(args.steps)) {
      const encoded = typeof args.steps === 'string' && args.steps.trim().startsWith('[')
        ? ' (it looks like a JSON-encoded array — pass the array itself, not a string)'
        : '';
      problems.push(`steps is ${describePlanValue(args.steps)}, not an array${encoded}`);
    } else {
      const coerced: number[] = [];
      const shorthand: Array<{ i: number; step: { status: PlanStepStatus; note?: string }; key: string }> = [];
      const shorthandOn = process.env.UPDATE_PLAN_STATUS_KEY_SHORTHAND_DISABLED !== '1';
      steps = args.steps.map((s, i) => {
        if (isNonEmptyString(s)) { coerced.push(i); return { text: s }; }
        if (s && typeof s === 'object' && !Array.isArray(s) && isNonEmptyString((s as any).text)) return s as any;
        const sh = shorthandOn ? statusKeyedShorthand(s) : null;
        if (sh) { shorthand.push({ i, step: sh.step, key: sh.key }); return sh.step; }
        problems.push(`steps[${i}] is ${describePlanValue(s)}`);
        return s as any;
      });
      if (coerced.length) {
        notes.push(`${coerced.map(i => `steps[${i}]`).join(', ')} ${coerced.length === 1 ? 'was a plain string' : 'were plain strings'} — stored as {"text": …} with status pending; send step objects to set a status.`);
      }
      if (shorthand.length) notes.push(renderShorthandNote(shorthand));
    }
  }

  if (problems.length) return { ok: false, problems };
  const update = steps && notes.length ? ({ ...args, steps } as PlanUpdate) : (args as PlanUpdate);
  return { ok: true, update, notes };
}

/**
 * The rejection envelope — the same structured `{ "ok": false, … }` refusal
 * shape the other refuse-before-write coding tools use (git_commit's shrink
 * guard, run_command's publish guard); looksLikeToolFailure reads it as a
 * failure, so the derail streak counts a model that keeps sending garbage.
 */
export function renderPlanValidationFailure(problems: string[]): string {
  const listed = problems.slice(0, MAX_LISTED_PLAN_PROBLEMS).join('; ')
    + (problems.length > MAX_LISTED_PLAN_PROBLEMS ? `; and ${problems.length - MAX_LISTED_PLAN_PROBLEMS} more` : '');
  const message = `update_plan REJECTED — nothing was written and the stored plan is unchanged. Malformed input: ${listed}. Each step must be an object with a non-empty string "text" (optional "status": pending | in_progress | completed | blocked; optional "note"), or a plain non-empty string; acceptance_criteria, when given, must be an array of non-empty strings. Expected shape: ${UPDATE_PLAN_EXPECTED_SHAPE}. Re-call update_plan with the FULL steps array in that shape.`;
  return JSON.stringify({
    ok: false,
    reason: 'invalid_plan_update',
    message,
    problems: problems.slice(0, 20),
    expected: {
      steps: [
        { text: 'Inspect /app', status: 'in_progress' },
        { text: 'Implement', status: 'pending' },
      ],
    },
  }, null, 1);
}

/**
 * Apply a full-rewrite plan update. Merges goal/acceptance (retained if omitted),
 * normalizes to exactly one in_progress step, persists, and mirrors markdown.
 * Returns { plan, warnings } — warnings are echoed to the model as a correction.
 */
export async function applyPlan(
  sessionId: string,
  worktree: string,
  update: PlanUpdate,
): Promise<{ plan: CodingPlan; warnings: string[] }> {
  const prev = await getPlan(sessionId);
  const warnings: string[] = [];

  const goal = (update.goal ?? prev?.goal ?? '').trim();
  const acceptanceCriteria = update.acceptance_criteria
    ? update.acceptance_criteria.map(s => String(s).trim()).filter(Boolean)
    : (prev?.acceptanceCriteria ?? []);

  let rawSteps = Array.isArray(update.steps) ? update.steps : (prev?.steps ?? []).map(s => ({ text: s.text, status: s.status, note: s.note }));
  if (rawSteps.length > MAX_PLAN_STEPS) {
    warnings.push(`Plan had ${rawSteps.length} steps; kept the first ${MAX_PLAN_STEPS}. Split large work into a delegated worker task instead of a long list.`);
    rawSteps = rawSteps.slice(0, MAX_PLAN_STEPS);
  }

  const steps: PlanStep[] = rawSteps
    .map((s, i) => ({ id: i + 1, text: String(s.text || '').trim(), status: normalizeStatus(s.status), note: s.note ? String(s.note).trim() : undefined }))
    .filter(s => s.text);

  // Enforce exactly one in_progress: keep the first, demote the rest to pending.
  const inProgress = steps.filter(s => s.status === 'in_progress');
  if (inProgress.length > 1) {
    let kept = false;
    for (const s of steps) {
      if (s.status === 'in_progress') {
        if (kept) s.status = 'pending';
        else kept = true;
      }
    }
    warnings.push(`Only one step may be in_progress at a time — kept step ${inProgress[0].id}, set the others to pending.`);
  }

  const plan: CodingPlan = {
    goal,
    acceptanceCriteria,
    steps,
    version: (prev?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    // Harness-owned: carried over, never set/cleared by a model write.
    ...(prev?.guardStrike ? { guardStrike: prev.guardStrike } : {}),
  };

  try { await storePut(NS(sessionId), KEY, plan as any); }
  catch (err: any) { logger.warn(`coding plan: persist failed for ${sessionId}: ${err.message}`); }

  await mirrorMarkdown(worktree, plan, update.explanation).catch(() => {});
  return { plan, warnings };
}

/** Write .digby/session/todo.md (git-ignored) — compaction lifeboat + subagent-visible. */
async function mirrorMarkdown(worktree: string, plan: CodingPlan, explanation?: string): Promise<void> {
  const dir = path.join(worktree, '.digby', 'session');
  await fs.mkdir(dir, { recursive: true });
  // Keep the whole scratch dir out of git so todo.md never dirties the worktree/PR.
  // '*\n' (NOT '*\n!.gitignore') so the .gitignore self-ignores too — otherwise
  // the un-ignored .gitignore made the parent `.digby/` show as untracked in
  // `git status` (prod session b92ef13f committed `?? .digby/`).
  await fs.writeFile(path.join(dir, '.gitignore'), '*\n', 'utf8').catch(() => {});
  await fs.writeFile(path.join(dir, 'todo.md'), renderPlanMarkdown(plan, explanation), 'utf8');
}

const MARK: Record<PlanStepStatus, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]', blocked: '[!]' };

export function renderPlanMarkdown(plan: CodingPlan, explanation?: string): string {
  const crit = plan.acceptanceCriteria.length
    ? plan.acceptanceCriteria.map(c => `- [ ] ${c}`).join('\n')
    : '- _(none set)_';
  const steps = plan.steps.length
    ? plan.steps.map(s => `- ${MARK[s.status]} ${s.text}${s.note ? `  — ${s.note}` : ''}`).join('\n')
    : '- _(no steps)_';
  return `# Goal\n${plan.goal || '_(not set)_'}\n\n## Acceptance criteria\n${crit}\n\n## Progress\n${steps}\n${explanation ? `\n## Last update\n${explanation}\n` : ''}`;
}

/**
 * Harness-owned guard-strike marker (2026-08-30 TT-lane recurrence fix): the
 * evidence guard suppresses a machine run's confabulated final, but the plan's
 * completed-step notes were written by that same model and survive untouched —
 * re-injected every later turn as ground truth. A hard-finding finalize stamps
 * the strike; the next CLEAN completed run clears it. Model plan writes carry
 * the marker over (applyPlan) but can never set or clear it. Best-effort.
 */
export async function markPlanGuardStrike(sessionId: string, summary: string): Promise<void> {
  try {
    const plan = await getPlan(sessionId);
    if (!plan) return;
    plan.guardStrike = { at: new Date().toISOString(), summary: summary.slice(0, 300) };
    await storePut(NS(sessionId), KEY, plan as any);
  } catch (err: any) { logger.warn(`coding plan: guard-strike mark failed for ${sessionId}: ${err.message}`); }
}

export async function clearPlanGuardStrike(sessionId: string): Promise<void> {
  try {
    const plan = await getPlan(sessionId);
    if (!plan?.guardStrike) return;
    delete plan.guardStrike;
    await storePut(NS(sessionId), KEY, plan as any);
  } catch (err: any) { logger.warn(`coding plan: guard-strike clear failed for ${sessionId}: ${err.message}`); }
}

/**
 * The compact <plan> reminder re-injected EVERY model turn — the load-bearing
 * anti-drift mechanism. Restates the goal verbatim + a step counter + rules.
 */
export function renderPlanReminder(plan: CodingPlan, opts: { step: number; maxSteps: number; nudge?: string }): string {
  const done = plan.steps.filter(s => s.status === 'completed').length;
  const lines = plan.steps.map(s => {
    const here = s.status === 'in_progress' ? '  ← HERE' : '';
    return `  ${MARK[s.status]} ${s.id} ${s.text}${s.note ? ` (${s.note})` : ''}${here}`;
  });
  const crit = plan.acceptanceCriteria.length ? `\nAcceptance: ${plan.acceptanceCriteria.map(c => `[ ] ${c}`).join('  ')}` : '';
  // A guard strike poisons trust in self-reported completions until a clean run clears it.
  const strike = plan.guardStrike
    ? `\n⚠️ EVIDENCE GUARD STRIKE (${plan.guardStrike.at}): a recent run's final answer was SUPPRESSED for unverified completion claims (${plan.guardStrike.summary}). Completed-step notes below are SELF-REPORTED and may be false — re-verify with fresh tool calls before building on, restating, or claiming them.`
    : '';
  return `<plan>
GOAL: ${plan.goal || '(not set — call update_plan to set it)'}${crit}
Plan (step ${opts.step}/${opts.maxSteps} budget · ${done}/${plan.steps.length} done):
${lines.join('\n') || '  (no steps yet)'}${strike}
Rules: finish the in_progress step before starting another; keep the plan current via update_plan; if stuck, mark the step blocked and move on; don't open a PR until every step is completed and acceptance criteria are met.${opts.nudge ? `\nNUDGE: ${opts.nudge}` : ''}
</plan>`;
}

/**
 * Convert a stored plan back into a full-rewrite PlanUpdate. Used by the REST
 * layer so user edits (add/toggle/delete a todo, set the goal from the sidebar)
 * go through the exact same applyPlan normalization as the agent's update_plan.
 */
export function planToUpdate(plan: CodingPlan | null): Required<Pick<PlanUpdate, 'goal' | 'acceptance_criteria' | 'steps'>> {
  return {
    goal: plan?.goal ?? '',
    acceptance_criteria: [...(plan?.acceptanceCriteria ?? [])],
    steps: (plan?.steps ?? []).map(s => ({ text: s.text, status: s.status, note: s.note })),
  };
}

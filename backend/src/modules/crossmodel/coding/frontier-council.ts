/**
 * FRONTIER REFLECTION COUNCIL (F2, owner 2026-10-06 late, verbatim: "pickers should never choose frontier anyway...the
 * only reason a frontier model is ever used is for a special use case and tool like reflection when a coding agent or
 * any agent makes multiple failures it should reflect then message a frontier of its choosing or multiple to create a
 * council citing all its failures and goals and where it is at").
 *
 * Builds on coding/reflection.ts (a 3× tool-failure streak ⇒ ONE advisory consult of the Double Checker seat + one
 * deduped investigation ticket). When failures REPEAT, the run escalates:
 *
 *   TRIGGERS (any top-level agent loop — coding lanes, chat leads, supervisors, machine runs; never a human Quick-lane
 *   turn, a worker or an anonymous chat), evaluated by `councilTrigger` (pure):
 *     streak_repeat            a SECOND failure-streak trip in the same run (the derail breaker's trips);
 *     streak_after_failed_run  a trip on a session whose PREVIOUS run also tripped (Redis marker) or failed (agent_runs);
 *     verify_red               the verify chain red ≥ 2 times in the run (the `verify` tool and the harness auto-verify);
 *     guard_reject_back        ≥ 2 evidence-guard reject-backs of the run's final answer;
 *     failed_runs              ≥ 2 consecutive failed agent_runs on the session (read at run start; durable runs only);
 *     mixed                    any two of the in-run kinds above (+1 when the previous run tripped / failed).
 *   STEP 1 REFLECT — the harness injects `[REFLECT — REPEATED FAILURES]` (buildReflectNote): every counted failure
 *     DETERMINISTICALLY (tool, error text, args — the StreakEvidence capture; verify stage tails; failed run ids + their
 *     error), the goal (the run's request, the plan + step states, the charter goal / todo with premises) and where the
 *     run is (steps, last receipts), and asks the agent to write its reflection, then consult.
 *   STEP 2 COUNCIL — `consult_frontier_council({ models (1–3), reflection, question })`: the agent CHOOSES its advisors
 *     from the servable frontier-class models (model-endpoints/reflection-council.service.ts — prices shown). The harness
 *     builds ONE brief = the agent's reflection + question + the SAME dossier (the agent cannot omit failures) + goal +
 *     state, redacts it with the outbound credential helper (platform/secret-scan.ts redactOutboundSecrets — the brief
 *     leaves for a third-party vendor), and runs the advisors IN PARALLEL as one-shot, tool-less calls on the existing
 *     custom-endpoint path (helper-completion.ts postNonStreamingCompletion; per-advisor timeout, sane max output,
 *     reasoning effort capped at 'high', one step-down retry on an effort rejection). The answers come back labelled per
 *     model with one deterministic agreement line. The lead weighs them and keeps its own model.
 *   AUTO-RUN — the agent ignored the reflect note for FRONTIER_COUNCIL_IGNORE_STEPS (2) steps, or the run is stopping
 *     (a verify same-signature stop, a derail run-end) with the trigger met: the harness runs the council itself with the
 *     agent's latest text as the reflection and the configured default advisors.
 *
 * Bounds: ≤ FRONTIER_COUNCIL_MAX_PER_RUN (2) councils per run, ≤ FRONTIER_COUNCIL_SESSION_DAILY_CAP (6) per session per
 * UTC day (Redis; fail-open to the per-run cap), the tool refuses outside a trigger window unless the run counted ≥ 2
 * failures — it is not a general "ask a frontier model" tool. Kill switch FRONTIER_REFLECTION_COUNCIL_DISABLED=1: no
 * controller is created and every streak keeps today's Double-Checker consult.
 *
 * Cost + telemetry: one `run_spend` row (+ run_tokens_in/out) per advisor call (meta.profile 'reflection_council'; an
 * unknown price is estimated at model-pick UNKNOWN_FRONTIER_PRICE and flagged); loop_metrics `frontier_council`
 * {phase armed | run | refused | no_models, trigger, models, chosenBy agent|harness, ok per model, latencyMs, usdEst,
 * failures}; the council's answers land as ONE `subagent` transcript part (role 'reflection_council').
 *
 * Every I/O dependency is injectable (FrontierCouncilDeps) and lazy-loaded by default; nothing here throws into the
 * agent loop.
 */

import type { ToolReceipt } from './run-receipts';
// Both leaves (no imports of their own): the outbound credential redaction and the frontier price estimate.
import { redactOutboundSecrets } from '../platform/secret-scan';
import { UNKNOWN_FRONTIER_PRICE } from '../platform/model-pick';

export const FRONTIER_COUNCIL_TOOL = 'consult_frontier_council';
export const REFLECT_NOTE_PREFIX = '[REFLECT — REPEATED FAILURES';
export const COUNCIL_RESULT_PREFIX = '[FRONTIER COUNCIL';
export const FRONTIER_COUNCIL_SPEND_PROFILE = 'reflection_council';
export const FRONTIER_COUNCIL_METRIC = 'frontier_council'; // LOOP_METRIC_KINDS.FRONTIER_COUNCIL (loop-metrics.service is not imported here — it boots prisma)
export const FRONTIER_COUNCIL_ROLE = 'reflection_council';
export const FRONTIER_COUNCIL_TITLE = 'Frontier council';
export const FRONTIER_COUNCIL_CARD_KEY = 'frontier_council';

/** Clips (chars). */
export const FAILURE_TEXT_CHARS = 400;
export const FAILURE_ARGS_CHARS = 200;
export const MAX_FAILURES_RENDERED = 20;
export const REFLECTION_CHARS = 6_000;
export const QUESTION_CHARS = 2_000;
export const ADVISOR_ANSWER_CHARS = 6_000;
export const RUN_GOAL_CHARS = 600;
/** The shortest reflection the tool accepts (a one-word "stuck" is not a reflection). */
export const MIN_REFLECTION_CHARS = 40;
/** Two NEXT STEP lines this similar (content-word Jaccard) count as agreeing. */
export const AGREE_THRESHOLD = 0.3;

// ── Env (each read per call; never cached) ────────────────────────────────────

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};
const intEnv = (v: unknown, dflt: number, lo: number, hi: number): number => {
  const raw = String(v ?? '').trim();
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};
type Env = Record<string, string | undefined>;

/** FRONTIER_REFLECTION_COUNCIL_DISABLED=1 — no council; every streak keeps today's Double-Checker consult. */
export function frontierCouncilDisabled(env: Env = process.env): boolean { return onFlag(env.FRONTIER_REFLECTION_COUNCIL_DISABLED); }
export function councilMaxPerRun(env: Env = process.env): number { return intEnv(env.FRONTIER_COUNCIL_MAX_PER_RUN, 2, 1, 4); }
export function councilSessionDailyCap(env: Env = process.env): number { return intEnv(env.FRONTIER_COUNCIL_SESSION_DAILY_CAP, 6, 1, 50); }
export function councilTimeoutMs(env: Env = process.env): number { return intEnv(env.FRONTIER_COUNCIL_TIMEOUT_MS, 120_000, 15_000, 300_000); }
export function councilMaxTokens(env: Env = process.env): number { return intEnv(env.FRONTIER_COUNCIL_MAX_TOKENS, 16_384, 1_024, 65_536); }
export function councilIgnoreSteps(env: Env = process.env): number { return intEnv(env.FRONTIER_COUNCIL_IGNORE_STEPS, 2, 1, 6); }
/** Reasoning effort cap for the advisors ('low' | 'medium' | 'high'; default high — bounded, still reasoning). */
export function councilEffortCap(env: Env = process.env): 'low' | 'medium' | 'high' {
  const v = String(env.FRONTIER_COUNCIL_REASONING_EFFORT ?? '').trim().toLowerCase();
  return v === 'low' || v === 'medium' || v === 'high' ? v : 'high';
}

// ── Failures + triggers (pure) ────────────────────────────────────────────────

export type CouncilFailureKind = 'streak' | 'verify_red' | 'guard_reject_back' | 'prior_run_failed' | 'prior_run_tripped';

export interface CouncilFailure {
  kind: CouncilFailureKind;
  /** The step it was counted at (null: before this run). */
  step: number | null;
  /** One code-composed headline ("tool update_feedback — 3-failure streak, second this run"). */
  title: string;
  /** Error / result texts (newest first). */
  texts: string[];
  /** The args of the calls that produced them (newest first). */
  args?: string[];
  runId?: string;
}

export interface CouncilCounts {
  streakTrips: number;
  verifyReds: number;
  rejectBacks: number;
  /** Consecutive failed agent_runs on the session before this run. */
  priorConsecutiveFailed: number;
  /** The previous run on this session tripped a failure streak or failed. */
  priorRunTroubled: boolean;
}

export type CouncilTrigger = 'streak_repeat' | 'streak_after_failed_run' | 'verify_red' | 'guard_reject_back' | 'failed_runs' | 'mixed';

export const TRIGGER_LABEL: Readonly<Record<CouncilTrigger, string>> = {
  streak_repeat: 'a second failure-streak trip this run',
  streak_after_failed_run: 'a failure-streak trip right after a previous run that also tripped or failed',
  verify_red: 'the verify chain failed twice this run',
  guard_reject_back: 'the evidence guard rejected the final answer twice',
  failed_runs: 'the previous runs on this session failed back to back',
  mixed: 'repeated failures of different kinds this run',
};

/** Failures counted toward the trigger (the in-run ones, +1 for a troubled previous run once this run failed). Pure. */
export function countedFailures(c: CouncilCounts): number {
  const inRun = c.streakTrips + c.verifyReds + c.rejectBacks;
  return inRun + (inRun > 0 && (c.priorRunTroubled || c.priorConsecutiveFailed > 0) ? 1 : 0);
}

/** Which trigger (if any) the counts meet — the most specific label wins. Pure. */
export function councilTrigger(c: CouncilCounts): { trigger: CouncilTrigger; counted: number } | null {
  const inRun = c.streakTrips + c.verifyReds + c.rejectBacks;
  const counted = countedFailures(c);
  if (inRun === 0) return c.priorConsecutiveFailed >= 2 ? { trigger: 'failed_runs', counted: c.priorConsecutiveFailed } : null;
  if (counted < 2 && c.priorConsecutiveFailed < 2) return null;
  if (c.streakTrips >= 2) return { trigger: 'streak_repeat', counted };
  if (c.verifyReds >= 2) return { trigger: 'verify_red', counted };
  if (c.rejectBacks >= 2) return { trigger: 'guard_reject_back', counted };
  if (c.streakTrips >= 1 && (c.priorRunTroubled || c.priorConsecutiveFailed > 0)) return { trigger: 'streak_after_failed_run', counted };
  if (c.priorConsecutiveFailed >= 2 && counted < 2) return { trigger: 'failed_runs', counted: c.priorConsecutiveFailed };
  return { trigger: 'mixed', counted };
}

// ── Prompt material (pure) ────────────────────────────────────────────────────

const oneLine = (v: unknown, n: number): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** The failure dossier — every counted failure, numbered, oldest first (capped with a "+N more" line). Pure. */
export function renderFailureDossier(failures: readonly CouncilFailure[]): string {
  if (!failures.length) return '(none recorded)';
  const shown = failures.slice(-MAX_FAILURES_RENDERED);
  const lines: string[] = [];
  if (failures.length > shown.length) lines.push(`(${failures.length - shown.length} earlier failure(s) not shown)`);
  shown.forEach((f, i) => {
    lines.push(`${i + 1}. ${f.step === null ? '[before this run]' : `[step ${f.step}]`} ${oneLine(f.title, 240)}${f.runId ? ` (run ${f.runId.slice(0, 8)})` : ''}`);
    for (const t of f.texts.slice(0, 3)) lines.push(`   error: "${oneLine(t, FAILURE_TEXT_CHARS)}"`);
    for (const a of (f.args ?? []).slice(0, 3)) lines.push(`   args: ${oneLine(a, FAILURE_ARGS_CHARS)}`);
  });
  return lines.join('\n');
}

export interface CouncilPlanStep { id: number | string; text: string; status: string }
export interface CouncilGoal {
  runGoal: string;
  plan?: { goal?: string; steps: CouncilPlanStep[] } | null;
  charterGoal?: { id: string; title: string; status?: string; premises?: Array<{ key: string; value: unknown; unit?: string }> } | null;
  charterTodo?: { id: string; title: string; status?: string } | null;
}

export function renderGoalBlock(g: CouncilGoal): string {
  const lines = [`- Run goal (the request this run serves): "${oneLine(g.runGoal || '(none)', RUN_GOAL_CHARS)}"`];
  if (g.plan && (g.plan.goal || g.plan.steps.length)) {
    lines.push(`- Plan: ${oneLine(g.plan.goal || '(no goal line)', 240)}`);
    for (const s of g.plan.steps.slice(0, 12)) lines.push(`   ${s.id}. [${s.status}] ${oneLine(s.text, 160)}`);
  } else {
    lines.push('- Plan: none set');
  }
  if (g.charterGoal) {
    const prem = (g.charterGoal.premises ?? []).slice(0, 6).map((p) => `${oneLine(p.key, 40)}=${oneLine(p.value, 40)}${p.unit ? ` ${oneLine(p.unit, 12)}` : ''}`).join('; ');
    lines.push(`- Charter goal ${g.charterGoal.id.slice(0, 8)} "${oneLine(g.charterGoal.title, 160)}"${g.charterGoal.status ? ` (${g.charterGoal.status})` : ''}${prem ? ` — premises: ${prem}` : ''}`);
  }
  if (g.charterTodo) lines.push(`- Charter todo ${g.charterTodo.id.slice(0, 8)} "${oneLine(g.charterTodo.title, 160)}"${g.charterTodo.status ? ` (${g.charterTodo.status})` : ''}`);
  return lines.join('\n');
}

export interface CouncilWhere {
  step: number;
  maxSteps: number;
  receipts?: ReadonlyArray<Pick<ToolReceipt, 'tool' | 'ok' | 'ids'>>;
  councilsUsed: number;
  councilsMax: number;
}

const RECEIPT_ID_KEYS = ['prNumber', 'sha', 'branch', 'failedStage', 'scheduleId', 'ticketId', 'chatId'];
export function renderWhereBlock(w: CouncilWhere): string {
  const receipts = [...(w.receipts ?? [])].slice(-6).reverse().map((r) => {
    const ids = RECEIPT_ID_KEYS.filter((k) => r.ids && r.ids[k] !== undefined && r.ids[k] !== null && r.ids[k] !== '')
      .map((k) => `${k} ${oneLine(k === 'sha' ? String(r.ids[k]).slice(0, 10) : r.ids[k], 40)}`).join(', ');
    return `${r.tool} ${r.ok ? 'ok' : 'FAILED'}${ids ? ` (${ids})` : ''}`;
  });
  return [
    `- Step ${w.step} of ${w.maxSteps}; frontier councils this run: ${w.councilsUsed}/${w.councilsMax}`,
    `- Last receipts (newest first): ${receipts.length ? receipts.join(' · ') : 'none this run'}`,
  ].join('\n');
}

/** A frontier advisor the agent may choose (reflection-council.service FrontierCouncilModel, structurally). */
export interface CouncilModelChoice {
  spec: string;
  family: string;
  tier?: string;
  priceIn: number | null;
  priceOut: number | null;
}

const fmtPrice = (n: number): string => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(2).replace(/\.?0+$/, '') : n.toFixed(3).replace(/\.?0+$/, ''));
export function renderModelList(models: readonly CouncilModelChoice[], unknown: { in: number; out: number }): string {
  return models.map((m) => {
    const priced = m.priceIn !== null || m.priceOut !== null;
    const price = priced
      ? `$${fmtPrice(m.priceIn ?? 0)} → $${fmtPrice(m.priceOut ?? 0)} per 1M tokens`
      : `price not on record (estimated at $${fmtPrice(unknown.in)} → $${fmtPrice(unknown.out)} per 1M tokens)`;
    return `- ${m.spec} (${m.family}${m.tier ? `, ${m.tier}` : ''}) — ${price}`;
  }).join('\n');
}

export function buildReflectNote(i: {
  trigger: CouncilTrigger;
  counted: number;
  failures: readonly CouncilFailure[];
  goal: CouncilGoal;
  where: CouncilWhere;
  models: readonly CouncilModelChoice[];
  defaults: readonly string[];
  ignoreSteps: number;
  unknownPrice: { in: number; out: number };
}): string {
  return [
    `${REFLECT_NOTE_PREFIX} — harness note, not typed by the user]`,
    `This run has failed repeatedly (trigger: ${TRIGGER_LABEL[i.trigger]}; ${i.counted} failure(s) counted). Before another attempt, REFLECT in your reply: what failed, why you think it failed, what you already tried, and what you need. Then call ${FRONTIER_COUNCIL_TOOL}({ models, reflection, question }) with 1–3 frontier advisors of YOUR choosing from the list below — your reflection, and one precise question.`,
    `The harness attaches every failure below, your goal and where the run is to the brief, whatever your reflection says. The advisors answer once, in parallel, without tools; they advise only — you keep your own model and decide what to do. If you do not consult within ${i.ignoreSteps} steps, the harness consults ${i.defaults.length ? i.defaults.join(', ') : 'the default advisors'} with your latest text as the reflection.`,
    '',
    'FAILURES (every one the harness counted, oldest first)',
    renderFailureDossier(i.failures),
    '',
    'GOAL',
    renderGoalBlock(i.goal),
    '',
    'WHERE THE RUN IS',
    renderWhereBlock(i.where),
    '',
    'FRONTIER ADVISORS YOU MAY CHOOSE',
    renderModelList(i.models, i.unknownPrice),
    '[/REFLECT]',
  ].join('\n');
}

/** The tool schema (offered only while the trigger window is open). Pure. */
export function councilToolSchema(models: readonly CouncilModelChoice[], unknownPrice: { in: number; out: number }): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } } {
  const specs = models.map((m) => m.spec);
  return {
    type: 'function',
    function: {
      name: FRONTIER_COUNCIL_TOOL,
      description: `After REPEATED failures only (offered once the harness posted its ${REFLECT_NOTE_PREFIX}] note): consult a council of 1–3 FRONTIER models of your choosing. Pass your reflection (what failed, why you think so, what you tried, what you need) and one precise question; the harness adds the full failure dossier, your goal and where the run is. The advisors answer once, in parallel, without tools; their answers come back labelled per model with where they agree. They advise only — you keep your model. Choose from:\n${renderModelList(models, unknownPrice)}`,
      parameters: {
        type: 'object',
        properties: {
          models: { type: 'array', items: { type: 'string', ...(specs.length ? { enum: specs } : {}) }, minItems: 1, maxItems: 3, description: '1–3 advisor model specs from the list (different vendors give independent views).' },
          reflection: { type: 'string', description: 'Your reflection: what failed, why you think it failed, what you already tried, what you need.' },
          question: { type: 'string', description: 'The one question you want the council to answer.' },
        },
        required: ['models', 'reflection', 'question'],
      },
    },
  };
}

export type CouncilArgsCheck =
  | { ok: true; models: string[]; reflection: string; question: string }
  | { ok: false; reason: 'bad_models' | 'unknown_model' | 'no_reflection' | 'no_question'; message: string };

/** Validate the tool's args against the servable frontier list. Pure. */
export function validateCouncilArgs(args: any, models: readonly CouncilModelChoice[], unknownPrice: { in: number; out: number }): CouncilArgsCheck {
  const list = renderModelList(models, unknownPrice);
  const raw = Array.isArray(args?.models) ? args.models : typeof args?.models === 'string' ? [args.models] : null;
  const picked = raw ? [...new Set(raw.map((m: unknown) => String(m ?? '').trim()).filter(Boolean))] as string[] : [];
  if (!picked.length || picked.length > 3) {
    return { ok: false, reason: 'bad_models', message: `${FRONTIER_COUNCIL_TOOL} needs 1–3 advisor models (got ${picked.length}). Choose from:\n${list}` };
  }
  const known = new Set(models.map((m) => m.spec));
  const bad = picked.filter((m) => !known.has(m));
  if (bad.length) {
    return { ok: false, reason: 'unknown_model', message: `${FRONTIER_COUNCIL_TOOL} refused: ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not a servable frontier-class model on this instance (the council seats frontier models only). Choose 1–3 from:\n${list}` };
  }
  const reflection = String(args?.reflection ?? '').trim();
  if (reflection.length < MIN_REFLECTION_CHARS) {
    return { ok: false, reason: 'no_reflection', message: `${FRONTIER_COUNCIL_TOOL} needs your reflection (at least ${MIN_REFLECTION_CHARS} characters): what failed, why you think it failed, what you already tried, what you need. Nothing was sent.` };
  }
  const question = String(args?.question ?? '').trim();
  if (!question) return { ok: false, reason: 'no_question', message: `${FRONTIER_COUNCIL_TOOL} needs the one question you want answered. Nothing was sent.` };
  return { ok: true, models: picked, reflection: reflection.slice(0, REFLECTION_CHARS), question: question.slice(0, QUESTION_CHARS) };
}

export const COUNCIL_SYSTEM_PROMPT = [
  'You are one member of a council of frontier models consulted by another AI agent (an autonomous coding / chat agent) that has failed repeatedly.',
  'You advise only: you cannot run tools, read files or act. Read the agent\'s reflection, its question and the FAILURE DOSSIER — the dossier is written by the harness from what actually happened (ground truth), not by the agent.',
  'Diagnose the root cause and prescribe the single best next step. Be concrete (exact commands, paths, parameters, which tool) and honest about uncertainty; say so if the agent\'s reflection misreads its failures, or if the failures look deterministic (a framework / permission / schema rejection that no retry can fix).',
  'Answer in this format, no preamble:\nDIAGNOSIS: <one sentence>\nNEXT STEP: <one sentence>\nthen at most 12 short lines of supporting detail.',
].join(' ');

/** The ONE brief every advisor receives (before outbound redaction). Pure. */
export function buildCouncilBrief(i: {
  reflection: string;
  question: string;
  chosenBy: 'agent' | 'harness';
  trigger: CouncilTrigger;
  failures: readonly CouncilFailure[];
  goal: CouncilGoal;
  where: CouncilWhere;
}): { system: string; user: string } {
  return {
    system: COUNCIL_SYSTEM_PROMPT,
    user: [
      `TRIGGER: ${TRIGGER_LABEL[i.trigger]}.`,
      '',
      i.chosenBy === 'agent' ? "AGENT'S REFLECTION" : "AGENT'S LATEST TEXT (it did not consult on its own — the harness convened this council)",
      i.reflection || '(empty)',
      '',
      "AGENT'S QUESTION",
      i.question,
      '',
      'FAILURE DOSSIER (harness-written; every failure counted, oldest first)',
      renderFailureDossier(i.failures),
      '',
      'GOAL',
      renderGoalBlock(i.goal),
      '',
      'WHERE THE RUN IS',
      renderWhereBlock(i.where),
    ].join('\n'),
  };
}

export const HARNESS_COUNCIL_QUESTION = 'What is the root cause of these repeated failures, and what single next step should the agent take now?';

// ── Agreement (pure, deterministic) ───────────────────────────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'then', 'from', 'into', 'your', 'you', 'its', 'are', 'was', 'not', 'but', 'use', 'run', 'step', 'next', 'call', 'all', 'any', 'one', 'have', 'has', 'can', 'will', 'should', 'instead', 'first', 'before', 'after', 'again']);
function contentWords(s: string): Set<string> {
  return new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9_./-]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}
export function jaccard(a: string, b: string): number {
  const A = contentWords(a), B = contentWords(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}
/** The advisor's NEXT STEP line (else its first 300 chars). Pure. */
export function nextStepOf(text: string): string {
  const m = /^\s*\**\s*NEXT STEP\s*\**\s*:\s*\**\s*(.+)$/im.exec(String(text ?? ''));
  return (m ? m[1] : String(text ?? '').slice(0, 300)).trim();
}
const shortSpec = (spec: string): string => { const i = spec.indexOf(':'); return i >= 0 ? spec.slice(i + 1) : spec; };

/** The pre-2026-10-08 line (NEXT STEP Jaccard only) — kept byte-identical for the kill switch. Pure. */
function agreementLineV1(answers: ReadonlyArray<{ model: string; text: string }>): string {
  const ok = answers.filter((a) => a.text.trim());
  if (ok.length === 0) return 'Agreement: no advisor answered.';
  if (ok.length === 1) return `Agreement: only ${shortSpec(ok[0].model)} answered — no second opinion to compare.`;
  const steps = ok.map((a) => ({ model: shortSpec(a.model), step: nextStepOf(a.text) }));
  const pairs: Array<{ a: string; b: string; s: number }> = [];
  for (let i = 0; i < steps.length; i++) for (let j = i + 1; j < steps.length; j++) pairs.push({ a: steps[i].model, b: steps[j].model, s: jaccard(steps[i].step, steps[j].step) });
  const agreeing = pairs.filter((p) => p.s >= AGREE_THRESHOLD);
  if (agreeing.length === pairs.length) return `Agreement: all ${ok.length} advisors prescribe a similar next step (overlap ≥ ${Math.min(...pairs.map((p) => p.s)).toFixed(2)}).`;
  if (!agreeing.length) return 'Agreement: the advisors prescribe DIFFERENT next steps — compare their NEXT STEP lines against your own evidence before acting.';
  const best = agreeing.sort((x, y) => y.s - x.s)[0];
  const others = steps.map((s) => s.model).filter((m) => m !== best.a && m !== best.b);
  return `Agreement: ${best.a} and ${best.b} prescribe a similar next step (overlap ${best.s.toFixed(2)})${others.length ? `; ${others.join(', ')} differs — weigh the difference` : ''}.`;
}

// ── Agreement v2 (audit 2026-10-08 W2-11) ─────────────────────────────────────
// Every council since launch (5 / 5) reported "the advisors prescribe DIFFERENT
// next steps" — including run 0134595f, where all three advisors gave the SAME
// diagnosis (the session branch's stale supervisor-state test, NOW6 =
// 2026-09-19) and only their next steps differed (fix the test / report it as
// blocked / stop). The v1 line compared whole NEXT STEP sentences by content-
// word Jaccard ≥ 0.3, which two differently-worded sentences about the same
// thing almost never reach, and ignored DIAGNOSIS entirely. v2 reports the two
// dimensions separately: DIAGNOSIS agreement by stemmed key-word overlap
// (|A∩B| / min(|A|,|B|)) or ≥ 2 shared anchors (identifiers, paths, numbers —
// supervisor-state.service.test.ts, now6, 2026-09-19); NEXT STEP agreement as
// before (Jaccard, now also on stemmed words). Kill switch
// FRONTIER_COUNCIL_AGREEMENT_V2_DISABLED=1 restores the v1 line byte-for-byte.

/** FRONTIER_COUNCIL_AGREEMENT_V2_DISABLED=1 — the v1 next-step-only agreement line. */
export function councilAgreementV2Disabled(env: Env = process.env): boolean { return onFlag(env.FRONTIER_COUNCIL_AGREEMENT_V2_DISABLED); }

/** Two DIAGNOSIS lines whose stemmed key words overlap this much (overlap coefficient) name the same cause. */
export const DIAGNOSIS_AGREE_THRESHOLD = 0.3;
/** …or that share at least this many anchors (identifiers / paths / numbers). */
export const DIAGNOSIS_AGREE_ANCHORS = 2;

/** An identifier / path / number token (kept verbatim — never stemmed). */
const isAnchor = (w: string): boolean => /[0-9._/]/.test(w) || (w.includes('-') && w.length >= 6);
/** Crude stem (plural / tense / -ness / -ally) so "tests"/"testing"/"test" and "failures"/"failure" meet. Pure. */
export function stemWord(w: string): string {
  let s = String(w ?? '').toLowerCase();
  if (isAnchor(s)) return s;
  for (const [suf, rep] of [['ically', 'ic'], ['ally', ''], ['ness', ''], ['ing', ''], ['ed', '']] as const) {
    if (s.endsWith(suf) && s.length - suf.length >= 3) { s = s.slice(0, s.length - suf.length) + rep; break; }
  }
  if (/(?:ss|x|z|ch|sh)es$/.test(s) && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) s = s.slice(0, -1);
  if (s.endsWith('e') && s.length > 4) s = s.slice(0, -1);
  return s;
}
/** Stemmed content words of a line (identifiers, paths and numbers kept whole). Pure. */
export function keyWords(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of String(s ?? '').toLowerCase().replace(/[`'"*]/g, ' ').split(/[^a-z0-9_./-]+/)) {
    const w = raw.replace(/^[./-]+|[./-]+$/g, '');
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(stemWord(w));
  }
  return out;
}
/** |A∩B| / min(|A|,|B|) — 0 when either side is empty. Pure. */
export function overlapCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / Math.min(a.size, b.size);
}
function stemmedJaccard(a: string, b: string): number {
  const A = keyWords(a), B = keyWords(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}
/** Diagnosis-pair verdict: the overlap coefficient, or ≥ 2 shared anchors. Pure. */
export function diagnosisAgreement(a: string, b: string): { score: number; anchors: number; agree: boolean } {
  const A = keyWords(a), B = keyWords(b);
  let anchors = 0;
  for (const w of A) if (isAnchor(w) && B.has(w)) anchors += 1;
  const score = overlapCoefficient(A, B);
  return { score, anchors, agree: score >= DIAGNOSIS_AGREE_THRESHOLD || anchors >= DIAGNOSIS_AGREE_ANCHORS };
}

type AgreePair = { a: string; b: string; s: number; agree: boolean };
function agreePairs(items: ReadonlyArray<{ model: string; v: string }>, score: (x: string, y: string) => { s: number; agree: boolean }): AgreePair[] {
  const out: AgreePair[] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const r = score(items[i].v, items[j].v);
    out.push({ a: items[i].model, b: items[j].model, s: r.s, agree: r.agree });
  }
  return out;
}

/** One line saying where the advisors agree / disagree — on the DIAGNOSIS and on the NEXT STEP. Pure. */
export function agreementLine(answers: ReadonlyArray<{ model: string; text: string }>): string {
  if (councilAgreementV2Disabled()) return agreementLineV1(answers);
  const ok = answers.filter((a) => a.text.trim());
  if (ok.length <= 1) return agreementLineV1(answers);
  const models = ok.map((a) => shortSpec(a.model));
  const stepPairs = agreePairs(ok.map((a, i) => ({ model: models[i], v: nextStepOf(a.text) })), (x, y) => {
    const s = Math.max(jaccard(x, y), stemmedJaccard(x, y));
    return { s, agree: s >= AGREE_THRESHOLD };
  });
  const withDiag = ok.map((a, i) => ({ model: models[i], v: diagnosisOf(a.text) })).filter((d) => d.v);
  const diagPairs = withDiag.length >= 2 ? agreePairs(withDiag, (x, y) => { const r = diagnosisAgreement(x, y); return { s: r.score, agree: r.agree }; }) : [];
  // The diagnosis clause (empty when fewer than two advisors wrote a DIAGNOSIS line).
  let diag: { all: boolean; some: boolean; text: string } = { all: false, some: false, text: '' };
  if (diagPairs.length) {
    const agreeing = diagPairs.filter((p) => p.agree);
    if (agreeing.length === diagPairs.length && withDiag.length === ok.length) {
      diag = { all: true, some: true, text: `all ${ok.length} advisors give the same diagnosis (overlap ≥ ${Math.min(...diagPairs.map((p) => p.s)).toFixed(2)})` };
    } else if (agreeing.length) {
      const best = [...agreeing].sort((x, y) => y.s - x.s)[0];
      const others = models.filter((m) => m !== best.a && m !== best.b);
      diag = { all: false, some: true, text: `${best.a} and ${best.b} give the same diagnosis (overlap ${best.s.toFixed(2)})${others.length ? `; ${others.join(', ')} ${others.length === 1 ? 'diagnoses' : 'diagnose'} differently` : ''}` };
    } else diag = { all: false, some: false, text: 'their diagnoses differ' };
  }
  const stepAgreeing = stepPairs.filter((p) => p.agree);
  if (stepAgreeing.length === stepPairs.length) {
    const head = `Agreement: all ${ok.length} advisors prescribe a similar next step (overlap ≥ ${Math.min(...stepPairs.map((p) => p.s)).toFixed(2)})`;
    if (!diag.text) return `${head}.`;
    return diag.all ? `${head} and give the same diagnosis.` : `${head}; on the cause: ${diag.text} — check which root cause your evidence supports.`;
  }
  if (!stepAgreeing.length) {
    if (diag.all) return `Agreement: ${diag.text}, but they prescribe DIFFERENT next steps — the root cause is shared; choose the next step your own evidence supports.`;
    if (diag.some) return `Agreement: ${diag.text}; the advisors prescribe DIFFERENT next steps — compare their NEXT STEP lines against your own evidence before acting.`;
    return `Agreement: the advisors prescribe DIFFERENT next steps${diag.text ? ' and their diagnoses differ' : ''} — compare their NEXT STEP lines against your own evidence before acting.`;
  }
  const best = [...stepAgreeing].sort((x, y) => y.s - x.s)[0];
  const others = models.filter((m) => m !== best.a && m !== best.b);
  return `Agreement: ${best.a} and ${best.b} prescribe a similar next step (overlap ${best.s.toFixed(2)})${others.length ? `; ${others.join(', ')} differs — weigh the difference` : ''}${diag.text ? `; on the cause: ${diag.text}` : ''}.`;
}

// ── Advisor results + formatting ──────────────────────────────────────────────

export interface AdvisorCall {
  model: string;
  ok: boolean;
  text: string;
  ms: number;
  inTokens: number;
  outTokens: number;
  /** Token counts estimated (~4 chars/token) because the vendor reported none. */
  tokensEstimated: boolean;
  usd: number;
  /** Priced from the registry (false ⇒ UNKNOWN_FRONTIER_PRICE estimate). */
  priced: boolean;
  error?: string;
}

const secs = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))} s`;

export function formatCouncilResult(i: { calls: readonly AdvisorCall[]; chosenBy: 'agent' | 'harness'; latencyMs: number; autoReason?: string }): string {
  const answered = i.calls.filter((c) => c.ok);
  const head = `${COUNCIL_RESULT_PREFIX} — advisory; advisors chosen by ${i.chosenBy === 'agent' ? 'you' : 'the harness'}${i.autoReason ? ` (${i.autoReason})` : ''}; ${answered.length} of ${i.calls.length} answered in ${secs(i.latencyMs)}]`;
  const body: string[] = [head, agreementLine(answered.map((c) => ({ model: c.model, text: c.text })))];
  for (const c of i.calls) {
    if (c.ok) body.push(`── ${c.model} (${secs(c.ms)}) ──`, c.text.slice(0, ADVISOR_ANSWER_CHARS));
    else body.push(`── ${c.model} — no answer (${oneLine(c.error || 'failed', 160)}) ──`);
  }
  body.push('[/FRONTIER COUNCIL]');
  body.push(answered.length
    ? 'The council advises; you keep your own model and decide. Weigh each answer against your own evidence (a tool result beats advice), act on what holds up, and never report a fix as done until a tool result shows it.'
    : 'No advisor answered — continue on your own evidence, and say plainly in your final answer what is still failing.');
  return body.join('\n');
}

/** The advisor's DIAGNOSIS line (else ''). Pure. */
export function diagnosisOf(text: string): string {
  const m = /^\s*\**\s*DIAGNOSIS\s*\**\s*:\s*\**\s*(.+)$/im.exec(String(text ?? ''));
  return m ? m[1].trim() : '';
}

/**
 * The SHORT form for a run that is stopping (the advice rides its final note — the full answers are in the
 * transcript part): head + agreement + one DIAGNOSIS / NEXT STEP line per advisor. Pure.
 */
export function compactCouncilResult(i: { calls: readonly AdvisorCall[]; reason?: string }): string {
  const answered = i.calls.filter((c) => c.ok);
  const lines = [
    `${COUNCIL_RESULT_PREFIX} — convened by the harness${i.reason ? ` (${i.reason})` : ''}; ${answered.length} of ${i.calls.length} advisors answered; full answers in the transcript]`,
    agreementLine(answered.map((c) => ({ model: c.model, text: c.text }))),
  ];
  for (const c of i.calls) {
    if (!c.ok) { lines.push(`- ${shortSpec(c.model)}: no answer (${oneLine(c.error || 'failed', 100)})`); continue; }
    const d = diagnosisOf(c.text);
    const n = nextStepOf(c.text);
    lines.push(`- ${shortSpec(c.model)}: ${d ? `DIAGNOSIS ${oneLine(d, 300)} · ` : ''}NEXT STEP ${oneLine(n, 300)}`);
  }
  return lines.join('\n');
}

/** The newest assistant prose in a transcript (string or text parts). Pure. */
export function lastAssistantText(messages: ReadonlyArray<{ role?: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const c = m.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n') : '';
    if (text.trim()) return text.trim();
  }
  return '';
}

// ── I/O dependencies (injectable; lazy-loaded defaults) ───────────────────────

export interface CouncilModelsView { candidates: CouncilModelChoice[]; defaults: string[] }

export interface PriorRunsView {
  consecutiveFailed: number;
  /** Newest first. */
  failed: Array<{ id: string; error: string }>;
}

export interface FrontierCouncilDeps {
  models: () => Promise<CouncilModelsView>;
  priorRuns: (sessionId: string, runId: string) => Promise<PriorRunsView>;
  /** Read + clear the "previous run tripped" marker. */
  consumeTripMarker: (sessionId: string) => Promise<boolean>;
  setTripMarker: (sessionId: string) => Promise<void>;
  /** Councils this session ran today (null = unknown). */
  dailyCount: (sessionId: string) => Promise<number | null>;
  bumpDaily: (sessionId: string) => Promise<void>;
  plan: (sessionId: string) => Promise<CouncilGoal['plan']>;
  charter: (sessionId: string) => Promise<Pick<CouncilGoal, 'charterGoal' | 'charterTodo'> | null>;
  callAdvisor: (spec: string, brief: { system: string; user: string }, o: { timeoutMs: number; maxTokens: number; effortCap: 'low' | 'medium' | 'high'; userId?: string }) => Promise<{ text: string; inTokens?: number; outTokens?: number }>;
  redact: (text: string) => { text: string; count: number };
  recordMetric: (row: { kind: string; sessionId?: string; runId?: string; value?: number; unit?: string; meta?: Record<string, unknown> }) => void;
  recordRows: (rows: Array<{ kind: string; sessionId?: string; runId?: string; value?: number; unit?: string; meta?: Record<string, unknown> }>) => void;
  unknownPrice: { in: number; out: number };
  now: () => number;
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => new Promise<T>((resolve) => {
  const t = setTimeout(() => resolve(fallback), ms);
  (t as any)?.unref?.();
  p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
});

const tripKey = (sessionId: string) => `frontier-council:trip:${sessionId}`;
const dayKey = (sessionId: string, now: number) => `frontier-council:day:${sessionId}:${new Date(now).toISOString().slice(0, 10)}`;
/**
 * Failed-run errors that are NOT the agent's failures — the harness superseded the run, the process died before its
 * first checkpoint (a deploy / crash), or the model PROVIDER killed it (quota / size / billing: prod 7 d to 2026-10-06,
 * 23 of 23 failed runs). A frontier council cannot fix any of them; they neither count nor break the streak.
 */
export const NON_AGENT_FAILURE_RE = /superseded by a newer run|process died before the first checkpoint|model provider killed the run/i;

/** Consecutive failed runs (newest first; stop at the first completed / cancelled run). Pure. */
export function priorRunsFrom(rows: ReadonlyArray<{ id: string; status: string; error?: string | null }>): PriorRunsView {
  const failed: Array<{ id: string; error: string }> = [];
  for (const r of rows) {
    if (r.status !== 'failed') break;
    if (NON_AGENT_FAILURE_RE.test(String(r.error ?? ''))) continue;
    failed.push({ id: r.id, error: String(r.error ?? '').trim() || '(no error recorded)' });
  }
  return { consecutiveFailed: failed.length, failed };
}

const realDeps: FrontierCouncilDeps = {
  models: async () => {
    const { resolveReflectionCouncil } = await import('../model-endpoints/reflection-council.service');
    const r = await resolveReflectionCouncil();
    return { candidates: r.candidates, defaults: r.defaults };
  },
  priorRuns: async (sessionId, runId) => {
    const prisma: any = (await import('../../../config/database')).default;
    if (typeof prisma?.agentRun?.findMany !== 'function') return { consecutiveFailed: 0, failed: [] };
    const rows = await prisma.agentRun.findMany({
      where: { sessionId, id: { not: runId }, status: { in: ['completed', 'failed', 'cancelled'] } },
      orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, status: true, error: true },
    });
    return priorRunsFrom(rows ?? []);
  },
  consumeTripMarker: async (sessionId) => {
    const redis: any = (await import('../../../config/redis')).default;
    let v: unknown;
    try { v = await redis.getDel(tripKey(sessionId)); } catch {
      v = await redis.get(tripKey(sessionId));
      if (v) await redis.del(tripKey(sessionId));
    }
    return typeof v === 'string' && !!v;
  },
  setTripMarker: async (sessionId) => {
    const redis: any = (await import('../../../config/redis')).default;
    await redis.set(tripKey(sessionId), '1', { EX: 86_400 });
  },
  dailyCount: async (sessionId) => {
    const redis: any = (await import('../../../config/redis')).default;
    const v = await redis.get(dayKey(sessionId, Date.now()));
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  },
  bumpDaily: async (sessionId) => {
    const redis: any = (await import('../../../config/redis')).default;
    const k = dayKey(sessionId, Date.now());
    await redis.incr(k);
    await redis.expire(k, 172_800);
  },
  plan: async (sessionId) => {
    const { getPlan } = await import('./plan.service');
    const p = await getPlan(sessionId);
    return p ? { goal: p.goal, steps: p.steps.map((s) => ({ id: s.id, text: s.text, status: s.status })) } : null;
  },
  charter: async (sessionId) => {
    const prisma: any = (await import('../../../config/database')).default;
    if (typeof prisma?.crossModelChat?.findUnique !== 'function') return null;
    const chat = await prisma.crossModelChat.findUnique({ where: { id: sessionId }, select: { charterGoalId: true, charterTodoId: true } });
    if (!chat?.charterGoalId && !chat?.charterTodoId) return null;
    const [goal, todo] = await Promise.all([
      chat.charterGoalId ? prisma.projectGoal.findUnique({ where: { id: chat.charterGoalId }, select: { id: true, title: true, status: true, premises: true } }) : null,
      chat.charterTodoId ? prisma.projectTodo.findUnique({ where: { id: chat.charterTodoId }, select: { id: true, title: true, status: true } }) : null,
    ]);
    const premises = Array.isArray(goal?.premises)
      ? goal.premises.filter((p: any) => p && typeof p.key === 'string').map((p: any) => ({ key: p.key, value: p.value, ...(typeof p.unit === 'string' ? { unit: p.unit } : {}) }))
      : [];
    return {
      charterGoal: goal ? { id: goal.id, title: goal.title, status: goal.status, premises } : null,
      charterTodo: todo ? { id: todo.id, title: todo.title, status: todo.status } : null,
    };
  },
  callAdvisor: async (spec, brief, o) => {
    const { resolveProviderForRun, nextReasoningEffortAfterRejection, extractProviderErrorDetail } = await import('./coding-model');
    const { postNonStreamingCompletion, extractNonStreamingAnswer, isCustomEndpoint } = await import('./helper-completion');
    const { capReasoningEffort } = await import('./effort-cap');
    const provider = await resolveProviderForRun(spec, o.userId);
    // Frontier advisors live on registry endpoints; a spec that fell back to a built-in is not the model asked for.
    if (!isCustomEndpoint(provider)) throw new Error(`${spec} did not resolve to an enabled endpoint model`);
    const extra: Record<string, any> = capReasoningEffort({ ...(provider.extra ?? {}) }, o.effortCap);
    const t0 = Date.now();
    const body = () => ({
      model: provider.model,
      messages: [{ role: 'system', content: brief.system }, { role: 'user', content: brief.user }],
      ...extra,
      max_tokens: o.maxTokens,
    });
    let resp: any;
    try {
      resp = await postNonStreamingCompletion(provider, body(), { timeout: o.timeoutMs, keepThinking: true });
    } catch (err: any) {
      const status = err?.response?.status;
      const left = o.timeoutMs - (Date.now() - t0);
      if (typeof status === 'number' && status >= 400 && status < 500 && left > 15_000) {
        const data = err?.response?.data;
        const detail = extractProviderErrorDetail(typeof data === 'string' ? data : (() => { try { return JSON.stringify(data ?? ''); } catch { return ''; } })());
        const next = nextReasoningEffortAfterRejection(typeof extra.reasoning_effort === 'string' ? extra.reasoning_effort : undefined, detail);
        if (!next) throw err;
        if (next === 'omit') delete extra.reasoning_effort; else extra.reasoning_effort = next;
        resp = await postNonStreamingCompletion(provider, body(), { timeout: left, keepThinking: true });
      } else {
        throw err;
      }
    }
    const ans = extractNonStreamingAnswer(resp?.data?.choices?.[0]);
    const usage = resp?.data?.usage ?? {};
    return {
      text: ans.text,
      ...(typeof usage.prompt_tokens === 'number' ? { inTokens: usage.prompt_tokens } : {}),
      ...(typeof usage.completion_tokens === 'number' ? { outTokens: usage.completion_tokens } : {}),
    };
  },
  // The OUTBOUND credential helper send_chat_message / notify_user use (OUTBOUND_SECRET_REDACT_DISABLED=1 = verbatim).
  redact: (text) => {
    const r = redactOutboundSecrets(text);
    return { text: r.text, count: r.count };
  },
  recordMetric: (row) => {
    void import('../platform/loop-metrics.service').then((m: any) => m?.recordLoopMetric?.(row)).catch(() => { /* telemetry never breaks a run */ });
  },
  recordRows: (rows) => {
    void import('../platform/loop-metrics.service').then((m: any) => m?.recordLoopMetrics?.(rows)).catch(() => { /* telemetry never breaks a run */ });
  },
  unknownPrice: { in: UNKNOWN_FRONTIER_PRICE.in, out: UNKNOWN_FRONTIER_PRICE.out },
  now: () => Date.now(),
};

// ── Running the council (parallel, bounded) ───────────────────────────────────

const estTokens = (chars: number): number => Math.ceil(Math.max(0, chars) / 4);

export async function runCouncilAdvisors(
  models: readonly string[],
  brief: { system: string; user: string },
  priceOf: (spec: string) => { in: number | null; out: number | null },
  deps: Pick<FrontierCouncilDeps, 'callAdvisor' | 'unknownPrice' | 'now'>,
  o: { timeoutMs: number; maxTokens: number; effortCap: 'low' | 'medium' | 'high'; userId?: string },
): Promise<AdvisorCall[]> {
  const promptChars = brief.system.length + brief.user.length;
  return Promise.all(models.map(async (model): Promise<AdvisorCall> => {
    const t0 = deps.now();
    let text = '';
    let error: string | undefined;
    let inRep: number | undefined;
    let outRep: number | undefined;
    try {
      const HARD = Symbol('council-hard-timeout');
      const r = await Promise.race([
        deps.callAdvisor(model, brief, o),
        new Promise<typeof HARD>((res) => { const t = setTimeout(() => res(HARD), o.timeoutMs + 5_000); (t as any)?.unref?.(); }),
      ]);
      if (r === HARD) error = `timeout after ${secs(o.timeoutMs)}`;
      else {
        text = String(r?.text ?? '').trim();
        inRep = r?.inTokens; outRep = r?.outTokens;
        if (!text) error = 'empty answer';
      }
    } catch (err: any) {
      const status = err?.response?.status;
      error = /timeout|ECONNABORTED/i.test(String(err?.code ?? err?.message ?? '')) ? `timeout after ${secs(o.timeoutMs)}` : `${status ? `HTTP ${status}: ` : ''}${oneLine(err?.message ?? err, 140)}`;
    }
    const ms = deps.now() - t0;
    const tokensEstimated = typeof inRep !== 'number';
    const inTokens = typeof inRep === 'number' ? inRep : estTokens(promptChars);
    const outTokens = typeof outRep === 'number' ? outRep : estTokens(text.length);
    const p = priceOf(model);
    const priced = p.in !== null || p.out !== null;
    const pin = p.in ?? (priced ? 0 : deps.unknownPrice.in);
    const pout = p.out ?? (priced ? 0 : deps.unknownPrice.out);
    const usd = Number(((inTokens * pin + outTokens * pout) / 1_000_000).toFixed(6));
    return { model, ok: !error && !!text, text, ms, inTokens, outTokens, tokensEstimated, usd, priced, ...(error ? { error } : {}) };
  }));
}

// ── The run controller ────────────────────────────────────────────────────────

export interface CouncilStepState {
  step: number;
  maxSteps: number;
  lastStep?: boolean;
  /** The agent's newest prose (lastAssistantText). */
  latestText: string;
  receipts?: ReadonlyArray<Pick<ToolReceipt, 'tool' | 'ok' | 'ids'>>;
}

export interface FrontierCouncilRunConfig {
  sessionId: string;
  runId?: string;
  /** GOAL-PRIORITY-SPEND (2026-10-20): the run's attributed goal — stamped meta.goalId on the council's run_spend rows. */
  goalId?: string;
  userId?: string;
  runGoal: string;
  machine: boolean;
  /** Live events (subagent_start / subagent_end / progress). */
  emit?: (type: string, data: any) => void;
  /** Push one transcript part (the caller stamps it). */
  pushPart?: (part: { type: 'subagent'; title: string; role: string; summary: string; [k: string]: unknown }) => void;
  deps?: Partial<FrontierCouncilDeps>;
  env?: Env;
}

export interface FrontierCouncilRun {
  /** A derail-breaker trip. Returns true when THIS trip escalates to the council (the caller skips the Double-Checker consult). */
  noteStreakTrip(e: { tool: string; texts: string[]; args?: string[]; perma: boolean; shape?: string; intended?: string | null; step: number; terminal?: boolean }): boolean;
  /** A red verify chain (the `verify` tool or the harness auto-verify). Returns true when it escalates. */
  noteVerifyRed(e: { stage: string; tail: string; step: number; auto: boolean }): boolean;
  /** An evidence-guard reject-back of the final answer. Returns true when it escalates. */
  noteGuardRejectBack(e: { round: number; summary?: string; kinds?: string[]; step: number }): boolean;
  /** Top of a step: the reflect note when the trigger just armed, the harness auto-run when the agent ignored it, else null. */
  beforeStep(s: CouncilStepState): Promise<string | null>;
  /** The trigger window is open (the tool is offered). */
  offered(): boolean;
  toolSchema(): ReturnType<typeof councilToolSchema>;
  executeTool(args: any, s: CouncilStepState): Promise<string>;
  /** The run is stopping with the trigger met: the harness convenes the council (null = nothing ran). */
  escalateAtRunEnd(s: CouncilStepState & { reason: string }): Promise<{ text: string; compact: string } | null>;
  readonly councilsRun: number;
}

// Test hook: the agent loop creates the controller itself, so its suites swap the I/O defaults here.
let testDeps: Partial<FrontierCouncilDeps> | null = null;
export function __setFrontierCouncilDepsForTests(d: Partial<FrontierCouncilDeps> | null): void { testDeps = d; }

export function createFrontierCouncilRun(cfg: FrontierCouncilRunConfig): FrontierCouncilRun | null {
  const env = cfg.env ?? process.env;
  if (frontierCouncilDisabled(env)) return null;
  const deps: FrontierCouncilDeps = { ...realDeps, ...(testDeps ?? {}), ...(cfg.deps ?? {}) };
  const maxPerRun = councilMaxPerRun(env);
  const ignoreSteps = councilIgnoreSteps(env);
  const failures: CouncilFailure[] = [];
  const counts: CouncilCounts = { streakTrips: 0, verifyReds: 0, rejectBacks: 0, priorConsecutiveFailed: 0, priorRunTroubled: false };
  let councilsRun = 0;
  let inFlight = false;
  /** The trigger crossed; the next beforeStep arms the window (reflect note). */
  let pendingArm = false;
  let windowOpen = false;
  let armedAtStep: number | null = null;
  let lastTrigger: CouncilTrigger | null = null;
  /** A window has been opened this run; a NEW one needs 2 more counted failures than `consumedAt`. */
  let armedOnce = false;
  /** Counted failures when the last window opened / the last council ran. */
  let consumedAt = 0;
  let noModelsNoted = false;
  let models: CouncilModelsView | null = null;
  let modelsP: Promise<CouncilModelsView> | null = null;
  const loadModels = (): Promise<CouncilModelsView> => {
    if (!modelsP) {
      modelsP = withTimeout(deps.models(), 5_000, { candidates: [], defaults: [] }).then((m) => { models = m; return m; });
    }
    return modelsP;
  };
  const metric = (meta: Record<string, unknown>, value?: number) => {
    try { deps.recordMetric({ kind: FRONTIER_COUNCIL_METRIC, sessionId: cfg.sessionId, ...(cfg.runId ? { runId: cfg.runId } : {}), ...(typeof value === 'number' ? { value } : {}), meta: { machine: cfg.machine, ...meta } }); } catch { /* telemetry never breaks a run */ }
  };

  // Run-start reads (never awaited by the loop — every step re-evaluates, so a late answer still counts).
  void withTimeout(deps.consumeTripMarker(cfg.sessionId), 3_000, false).then((tripped) => {
    if (!tripped) return;
    counts.priorRunTroubled = true;
    failures.unshift({ kind: 'prior_run_tripped', step: null, title: 'the previous run on this session tripped a tool-failure streak', texts: [] });
  });
  if (cfg.runId) {
    void withTimeout(deps.priorRuns(cfg.sessionId, cfg.runId), 5_000, { consecutiveFailed: 0, failed: [] }).then((p) => {
      counts.priorConsecutiveFailed = p.consecutiveFailed;
      if (p.consecutiveFailed > 0) counts.priorRunTroubled = true;
      const entries: CouncilFailure[] = p.failed.slice(0, 5).reverse().map((r) => ({ kind: 'prior_run_failed', step: null, title: 'a previous run on this session failed', texts: [r.error], runId: r.id }));
      failures.unshift(...entries);
      if (p.consecutiveFailed >= 2) void loadModels();
    });
  }

  /** Does the trigger hold for a NEW window? Sets pendingArm; returns true when the escalation is (or will be) the council. */
  const evaluate = (): boolean => {
    if (councilsRun >= maxPerRun) return false;
    if (windowOpen || inFlight) return true; // a window is already open / a council is running — the council owns this
    const t = councilTrigger(counts);
    if (!t) return false;
    if (armedOnce && countedFailures(counts) - consumedAt < 2) return false; // the last window consumed these failures
    lastTrigger = t.trigger;
    pendingArm = true;
    return !!models && models.candidates.length > 0;
  };

  const note = (f: CouncilFailure): boolean => {
    failures.push(f);
    void loadModels();
    return evaluate();
  };

  const goalNow = async (): Promise<CouncilGoal> => {
    const [plan, charter] = await Promise.all([
      withTimeout(deps.plan(cfg.sessionId), 1_500, null),
      withTimeout(deps.charter(cfg.sessionId), 1_500, null),
    ]);
    return { runGoal: cfg.runGoal, plan, charterGoal: charter?.charterGoal ?? null, charterTodo: charter?.charterTodo ?? null };
  };
  const whereNow = (s: CouncilStepState): CouncilWhere => ({ step: s.step, maxSteps: s.maxSteps, receipts: s.receipts, councilsUsed: councilsRun, councilsMax: maxPerRun });

  /** Convene the council. Returns the formatted result, or a refusal string when it could not run (never throws). */
  const convene = async (i: { models: string[]; reflection: string; question: string; chosenBy: 'agent' | 'harness'; s: CouncilStepState; autoReason?: string }): Promise<{ ran: boolean; text: string; compact?: string }> => {
    if (inFlight) return { ran: false, text: `${FRONTIER_COUNCIL_TOOL}: a council is already running for this run — wait for its answer.` };
    inFlight = true;
    try {
      const cap = councilSessionDailyCap(env);
      const today = await withTimeout(deps.dailyCount(cfg.sessionId), 1_500, null);
      if (typeof today === 'number' && today >= cap) {
        metric({ phase: 'refused', reason: 'daily_cap', trigger: lastTrigger, chosenBy: i.chosenBy, today, cap });
        return { ran: false, text: `${FRONTIER_COUNCIL_TOOL} refused: this session already convened ${today} frontier council(s) today (cap ${cap}). Continue on your own evidence and say plainly what is still failing.` };
      }
      const m = models ?? await loadModels();
      const priceOf = (spec: string) => { const c = m.candidates.find((x) => x.spec === spec); return { in: c?.priceIn ?? null, out: c?.priceOut ?? null }; };
      const goal = await goalNow();
      const where = whereNow(i.s);
      const trigger = lastTrigger ?? councilTrigger(counts)?.trigger ?? 'mixed';
      const brief = buildCouncilBrief({ reflection: i.reflection, question: i.question, chosenBy: i.chosenBy, trigger, failures, goal, where });
      let redactions = 0;
      const red = (t: string) => { try { const r = deps.redact(t); redactions += r.count; return r.text; } catch { return t; } };
      const outbound = { system: red(brief.system), user: red(brief.user) };
      councilsRun += 1;
      armedOnce = true;
      consumedAt = countedFailures(counts);
      windowOpen = false;
      armedAtStep = null;
      pendingArm = false;
      void withTimeout(deps.bumpDaily(cfg.sessionId), 1_500, undefined);
      const councilId = Math.random().toString(16).slice(2, 10);
      const title = FRONTIER_COUNCIL_TITLE;
      try { cfg.emit?.('subagent_start', { title, role: FRONTIER_COUNCIL_ROLE, model: i.models.join(', '), persona: title }); } catch { /* live view is best-effort */ }
      try { cfg.emit?.('progress', { message: `Frontier council convened (${i.models.join(', ')}) — ${i.chosenBy === 'agent' ? 'chosen by the agent' : 'harness auto-run'}`, stage: 'reflection-council' }); } catch { /* best-effort */ }
      const t0 = deps.now();
      const calls = await runCouncilAdvisors(i.models, outbound, priceOf, deps, {
        timeoutMs: councilTimeoutMs(env), maxTokens: councilMaxTokens(env), effortCap: councilEffortCap(env), ...(cfg.userId ? { userId: cfg.userId } : {}),
      });
      const latencyMs = deps.now() - t0;
      const text = formatCouncilResult({ calls, chosenBy: i.chosenBy, latencyMs, ...(i.autoReason ? { autoReason: i.autoReason } : {}) });
      const usdEst = Number(calls.reduce((s, c) => s + c.usd, 0).toFixed(6));
      // One run_spend (+ token) row per advisor call.
      try {
        const rows: Parameters<FrontierCouncilDeps['recordRows']>[0] = [];
        calls.forEach((c, idx) => {
          const runId = `fc-${councilId}-${idx}`;
          const p = priceOf(c.model);
          const common = {
            model: c.model, provider: c.model.includes(':') ? c.model.slice(0, c.model.indexOf(':')) : undefined,
            profile: FRONTIER_COUNCIL_SPEND_PROFILE, councilId, trigger, chosenBy: i.chosenBy, ok: c.ok,
            estimated: c.tokensEstimated || !c.priced, ...(cfg.runId ? { agentRunId: cfg.runId } : {}),
            ...(cfg.goalId ? { goalId: cfg.goalId } : {}),
          };
          if (c.inTokens > 0) rows.push({ kind: 'run_tokens_in', sessionId: cfg.sessionId, runId, value: c.inTokens, unit: 'tokens', meta: { ...common } });
          if (c.outTokens > 0) rows.push({ kind: 'run_tokens_out', sessionId: cfg.sessionId, runId, value: c.outTokens, unit: 'tokens', meta: { ...common } });
          rows.push({
            kind: 'run_spend', sessionId: cfg.sessionId, runId, value: c.usd, unit: 'usd',
            meta: {
              ...common, models: [c.model], turns: 1, inTokens: c.inTokens, outTokens: c.outTokens, ms: c.ms,
              usdPerMTokIn: p.in ?? deps.unknownPrice.in, usdPerMTokOut: p.out ?? deps.unknownPrice.out,
              priceSource: c.priced ? 'registry' : 'unknown_frontier_estimate', ...(c.priced ? {} : { priceEstimated: true }),
              ...(c.error ? { error: oneLine(c.error, 160) } : {}),
            },
          });
        });
        deps.recordRows(rows);
      } catch { /* spend rows never break a run */ }
      metric({
        phase: 'run', councilId, trigger, models: i.models, chosenBy: i.chosenBy,
        ok: Object.fromEntries(calls.map((c) => [c.model, c.ok])), latencyMs, usdEst, failures: failures.length, redactions,
        agreement: agreementLine(calls.filter((c) => c.ok).map((c) => ({ model: c.model, text: c.text }))).slice(0, 200),
        ...(i.autoReason ? { autoReason: i.autoReason } : {}),
      }, usdEst);
      try { cfg.pushPart?.({ type: 'subagent', title, role: FRONTIER_COUNCIL_ROLE, summary: text, council: { councilId, models: i.models, chosenBy: i.chosenBy, trigger } }); } catch { /* transcript is best-effort */ }
      try { cfg.emit?.('subagent_end', { title, role: FRONTIER_COUNCIL_ROLE, summary: text, model: i.models.join(', '), persona: title, cardKey: FRONTIER_COUNCIL_CARD_KEY, time: latencyMs }); } catch { /* best-effort */ }
      return { ran: true, text, compact: compactCouncilResult({ calls, ...(i.autoReason ? { reason: i.autoReason } : {}) }) };
    } catch (err: any) {
      metric({ phase: 'refused', reason: 'error', error: oneLine(err?.message ?? err, 160), chosenBy: i.chosenBy });
      return { ran: false, text: `${FRONTIER_COUNCIL_TOOL} failed before any advisor answered (${oneLine(err?.message ?? err, 120)}) — continue on your own evidence.` };
    } finally {
      inFlight = false;
    }
  };

  const harnessRun = async (s: CouncilStepState, autoReason: string): Promise<{ text: string; compact: string } | null> => {
    const m = models ?? await loadModels();
    const pick = (m.defaults.length ? m.defaults : m.candidates.slice(0, 3).map((c) => c.spec)).slice(0, 3);
    if (!pick.length) return null;
    const reflection = (s.latestText || '').trim().slice(0, REFLECTION_CHARS) || '(the agent wrote no reflection)';
    const r = await convene({ models: pick, reflection, question: HARNESS_COUNCIL_QUESTION, chosenBy: 'harness', s, autoReason });
    return r.ran ? { text: r.text, compact: r.compact ?? r.text } : null;
  };

  return {
    get councilsRun() { return councilsRun; },

    noteStreakTrip(e) {
      try {
        void withTimeout(deps.setTripMarker(cfg.sessionId), 1_500, undefined);
        counts.streakTrips += 1;
        const nth = counts.streakTrips;
        const shape = e.shape === 'success_intent' ? '5 successful calls while your reasoning named another tool (wrong-tool loop)' : '3-failure streak';
        return note({
          kind: 'streak', step: e.step,
          title: `tool ${e.tool} — ${shape}${nth > 1 ? `, trip ${nth} this run` : ''}${e.perma ? ' (withheld for the rest of the run)' : ''}${e.terminal ? ' — the run was ended by the breaker' : ''}${e.intended && e.intended !== e.tool ? `; the reasoning named ${e.intended}` : ''}`,
          texts: (e.texts ?? []).slice(0, 3), args: (e.args ?? []).slice(0, 3),
        });
      } catch { return false; }
    },

    noteVerifyRed(e) {
      try {
        counts.verifyReds += 1;
        return note({ kind: 'verify_red', step: e.step, title: `verify chain red at stage "${e.stage || 'unknown'}" (${e.auto ? 'harness auto-verify' : 'verify tool'})`, texts: [e.tail] });
      } catch { return false; }
    },

    noteGuardRejectBack(e) {
      try {
        counts.rejectBacks += 1;
        return note({ kind: 'guard_reject_back', step: e.step, title: `the evidence guard rejected the final answer (round ${e.round})${e.kinds?.length ? ` — ${e.kinds.slice(0, 4).join(', ')}` : ''}`, texts: e.summary ? [e.summary] : [] });
      } catch { return false; }
    },

    async beforeStep(s) {
      try {
        if (s.lastStep || inFlight) return null;
        // The run-start reads (previous run tripped / failed runs) land asynchronously — re-evaluate every step.
        if (!windowOpen && !pendingArm) evaluate();
        // AUTO-RUN: the window is open and the agent ignored the note for `ignoreSteps` steps.
        if (windowOpen && armedAtStep !== null && s.step - armedAtStep >= ignoreSteps && councilsRun < maxPerRun) {
          const r = await harnessRun(s, `you did not consult within ${ignoreSteps} steps of the reflect note`);
          if (r) return `${r.text}\n[harness note — not typed by the user: you did not call ${FRONTIER_COUNCIL_TOOL} within ${ignoreSteps} steps of the reflect note, so the harness convened the default advisors with your latest text as the reflection.]`;
          windowOpen = false; armedAtStep = null;
          return null;
        }
        if (!pendingArm || windowOpen || councilsRun >= maxPerRun) return null;
        const m = models ?? await withTimeout(loadModels(), 3_000, { candidates: [], defaults: [] });
        if (!m.candidates.length) {
          pendingArm = false;
          if (!noModelsNoted) { noModelsNoted = true; metric({ phase: 'no_models', trigger: lastTrigger }); }
          return null;
        }
        pendingArm = false;
        windowOpen = true;
        armedAtStep = s.step;
        armedOnce = true;
        consumedAt = countedFailures(counts);
        const trigger = lastTrigger ?? 'mixed';
        const goal = await goalNow();
        metric({ phase: 'armed', trigger, failures: failures.length, step: s.step, defaults: m.defaults });
        return buildReflectNote({
          trigger, counted: Math.max(countedFailures(counts), counts.priorConsecutiveFailed), failures, goal, where: whereNow(s),
          models: m.candidates, defaults: m.defaults, ignoreSteps, unknownPrice: deps.unknownPrice,
        });
      } catch {
        return null;
      }
    },

    offered() {
      return windowOpen && councilsRun < maxPerRun && !!models && models.candidates.length > 0;
    },

    toolSchema() {
      return councilToolSchema(models?.candidates ?? [], deps.unknownPrice);
    },

    async executeTool(args, s) {
      try {
        const counted = countedFailures(counts);
        if (!windowOpen && counted < 2 && counts.priorConsecutiveFailed < 2) {
          metric({ phase: 'refused', reason: 'no_trigger', counted });
          return `${FRONTIER_COUNCIL_TOOL} refused: the frontier council is for REPEATED failures — it opens after the harness posts its ${REFLECT_NOTE_PREFIX}] note (this run counted ${counted} failure(s); it needs 2). Keep working with your own tools.`;
        }
        if (councilsRun >= maxPerRun) {
          metric({ phase: 'refused', reason: 'run_cap', councilsRun });
          return `${FRONTIER_COUNCIL_TOOL} refused: this run already convened ${councilsRun} frontier council(s) (cap ${maxPerRun}). Act on the advice you have, or finish and say plainly what is still failing.`;
        }
        if (!windowOpen && armedOnce && counted - consumedAt < 2) {
          metric({ phase: 'refused', reason: 'window_consumed', counted, consumedAt });
          return `${FRONTIER_COUNCIL_TOOL} refused: the council already answered these failures — act on its advice; a new council opens only after two more failures.`;
        }
        const m = models ?? await withTimeout(loadModels(), 3_000, { candidates: [], defaults: [] });
        if (!m.candidates.length) {
          metric({ phase: 'refused', reason: 'no_models' });
          return `${FRONTIER_COUNCIL_TOOL}: no frontier-class model is configured on this instance (Account → Admin → Endpoints). Continue on your own evidence.`;
        }
        const v = validateCouncilArgs(args, m.candidates, deps.unknownPrice);
        if (!v.ok) {
          metric({ phase: 'refused', reason: v.reason });
          return v.message;
        }
        if (!lastTrigger) lastTrigger = councilTrigger(counts)?.trigger ?? 'mixed';
        return (await convene({ models: v.models, reflection: v.reflection, question: v.question, chosenBy: 'agent', s })).text;
      } catch (err: any) {
        return `${FRONTIER_COUNCIL_TOOL} failed (${oneLine(err?.message ?? err, 120)}) — continue on your own evidence.`;
      }
    },

    async escalateAtRunEnd(s) {
      try {
        if (inFlight || councilsRun >= maxPerRun) return null;
        const t = councilTrigger(counts);
        if (!t && !windowOpen) return null;
        const counted = countedFailures(counts);
        if (!windowOpen && armedOnce && counted - consumedAt < 2) return null;
        if (t) lastTrigger = t.trigger;
        const m = models ?? await withTimeout(loadModels(), 3_000, { candidates: [], defaults: [] });
        if (!m.candidates.length) return null;
        return await harnessRun(s, s.reason);
      } catch {
        return null;
      }
    },
  };
}

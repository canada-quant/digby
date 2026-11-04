/**
 * TASK KIND — what JOB a human turn is (2026-10-20, owner: "make sure the decision model is … choosing the best models
 * for the job"). The real-user audit (docs/AUDIT_2026-10-20_REAL_USER.md) showed the per-turn model pick ranking a
 * birthday poem, a cover letter, a logo and a Python function byte-identically: its evidence was keyed (model, lane)
 * only. This leaf is the ONE vocabulary for the job type — the decision-gate purpose `task_kind` classifies the turn
 * into it, the bench files its rows under it (scripts/e2e/model-bench.py KINDS is the pinned Python twin), the bench
 * scorecard buckets quality by it and the pick reads (model, kind) quality before (model, lane).
 *
 * The ask is its OWN purpose, never a question inside the turn_plan batch: that batch is in act fleet-wide and its
 * readiness is partitioned by questionsHash, so adding a question would reset it (decision-gate-fit.ts readiness).
 * turn-plan.ts fires it in the same tick as the turn_plan ask (TurnPlanDeps.taskKind) and never waits past its own
 * budget for it.
 *
 * Questions (text pinned — a rewording resets comparability):
 *   kind / kind_rev  ONE choice over TASK_KINDS asked in both option orders (typed decision models are position- and
 *                    name-sensitive — the turn_plan lane pattern); the probabilities are averaged.
 *   harm             a noul with the compute_policy STAKES statement + criteria, asked here so its separation can be
 *                    compared with turn_plan's criteria-less "Could a wrong answer cost…" stakes (which read 0.6–0.73
 *                    on weather / trip planning / business naming) WITHOUT re-keying the turn_plan partition. Telemetry
 *                    only until a readout moves a consumer onto it.
 *
 * Usable = an answer, mode ≠ off, a calibrated backend, a winning kind with p ≥ TASK_KIND_MIN_P. Anything else is
 * kind null ⇒ the pick keeps today's (model, lane) evidence. Pure except decideTaskKind (one decide()). Never throws.
 */

import type { DecisionAnswer, DecisionQuestion, DecideResult } from './decision-gate';

export const TASK_KIND_PURPOSE = 'task_kind' as const;

export type TaskKind = 'writing' | 'code' | 'analysis' | 'lookup' | 'advice' | 'planning' | 'explain';
/** Order is part of the pinned contract (the Python twin KINDS in scripts/e2e/model-bench.py must equal it). */
export const TASK_KINDS: readonly TaskKind[] = ['writing', 'code', 'analysis', 'lookup', 'advice', 'planning', 'explain'];

export function isTaskKind(v: unknown): v is TaskKind {
  return typeof v === 'string' && (TASK_KINDS as readonly string[]).includes(v);
}

/** A kind is used only when its averaged probability reaches this. */
export const TASK_KIND_MIN_P = 0.5;

export const TASK_KIND_CRITERIA: Readonly<Record<TaskKind, string>> = {
  writing: 'WRITING & CREATIVE — create or edit text or a creative piece: a poem, story, email, cover letter, post, name or slogan ideas, a logo or image idea, rewriting, summarizing given text, grammar fixes, translation.',
  code: 'CODE — programming: write, explain, fix or convert code, a query, a regex, a script, technical configuration.',
  analysis: 'ANALYSIS — reasoning over facts or numbers: math and calculations, weighing a debated question, comparing perspectives or arguments, a structured analysis of a topic.',
  lookup: 'LOOKUP — find a fact or current information: weather, prices, scores, news, dates, places, a simple factual question.',
  advice: "ADVICE — a recommendation for the user's own situation: health, money, legal, relationships, choosing between products or options.",
  planning: 'PLANNING — build a plan or schedule: a trip or itinerary, a meal plan, a workout, a study or project plan, a step-by-step program.',
  explain: 'EXPLAIN — teach how something works or how to do it: a concept, how-to steps, homework help, a recipe or cooking help.',
};

const KIND_INSTRUCTIONS = 'What kind of job is this message asking for? Pick the ONE kind that best describes the main deliverable.';

/** The harm noul — the compute_policy STAKES wording + criteria (compute-policy-gate.ts), kept verbatim on purpose. */
export const TASK_KIND_HARM_QUESTION: DecisionQuestion = {
  type: 'noul',
  instructions: 'Acting on a wrong answer to this message would cost the user real money, health, legal standing, or something irreversible.',
  criteria: {
    true: 'The user is about to make a financial, medical, legal, safety or irreversible decision on the answer',
    false: 'A wrong answer is cheap to notice and cheap to undo — curiosity, drafting, explanation, casual planning',
  },
};

export function taskKindQuestions(): Record<string, DecisionQuestion> {
  const forward: Record<string, string> = {};
  for (const k of TASK_KINDS) forward[k] = TASK_KIND_CRITERIA[k];
  const reversed: Record<string, string> = {};
  for (const k of [...TASK_KINDS].reverse()) reversed[k] = TASK_KIND_CRITERIA[k];
  return {
    kind: { type: 'choice', instructions: KIND_INSTRUCTIONS, criteria: forward },
    kind_rev: { type: 'choice', instructions: KIND_INSTRUCTIONS, criteria: reversed },
    harm: TASK_KIND_HARM_QUESTION,
  };
}

export interface TaskKindClass {
  /** The winning kind, or null when no kind reaches TASK_KIND_MIN_P. */
  kind: TaskKind | null;
  /** The winning kind's averaged probability (also when it falls short of TASK_KIND_MIN_P). */
  p: number;
  /** The argmax kind even when below the bar (telemetry). */
  top: TaskKind;
  probs: Record<TaskKind, number>;
  /** Both orderings answered (position-bias averaging applied). */
  averaged: boolean;
  /** The harm noul (null when unanswered / NaN). */
  harm: number | null;
}

function kindProbsOf(a: DecisionAnswer | undefined): Record<TaskKind, number> | null {
  if (!a || a.type !== 'choice' || !a.probabilities) return null;
  const out = {} as Record<TaskKind, number>;
  let sum = 0;
  for (const k of TASK_KINDS) { const p = Number(a.probabilities[k]); out[k] = Number.isFinite(p) && p > 0 ? p : 0; sum += out[k]; }
  if (sum <= 0) return null;
  for (const k of TASK_KINDS) out[k] = out[k] / sum;
  return out;
}

/** Answers → the kind class (pure). null when neither ordering answered. */
export function classifyTaskKind(answers: Record<string, DecisionAnswer> | null | undefined, minP: number = TASK_KIND_MIN_P): TaskKindClass | null {
  if (!answers) return null;
  const a = kindProbsOf(answers.kind);
  const b = kindProbsOf(answers.kind_rev);
  if (!a && !b) return null;
  const probs = {} as Record<TaskKind, number>;
  for (const k of TASK_KINDS) probs[k] = a && b ? (a[k] + b[k]) / 2 : (a ?? b)![k];
  const top = TASK_KINDS.reduce((best, k) => (probs[k] > probs[best] ? k : best), TASK_KINDS[0]);
  const h = answers.harm;
  const harm = h && h.type === 'noul' && Number.isFinite(h.noul) ? h.noul : null;
  return { kind: probs[top] >= minP ? top : null, p: probs[top], top, probs, averaged: !!(a && b), harm };
}

export function taskKindDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const s = String(env.TASK_KIND_DISABLED ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
}

export interface TaskKindResult {
  cls: TaskKindClass | null;
  /** The decision itself (for the stash / metadata); null when not asked or unanswered. */
  decision: DecideResult | null;
  /** The kind the pick may use: cls.kind when the decision is usable, else null. */
  usableKind: TaskKind | null;
}

/** A decision is usable for evidence keying: answered, not off, calibrated, a kind over the bar. Pure. */
export function usableTaskKind(decision: Pick<DecideResult, 'mode' | 'calibrated'> | null | undefined, cls: TaskKindClass | null): TaskKind | null {
  if (!decision || !cls || !cls.kind) return null;
  if (decision.mode === 'off' || decision.calibrated === false) return null;
  return cls.kind;
}

/**
 * Ask the task_kind purpose over the SAME decision state the turn_plan ask sees (turn-plan.ts turnPlanState — no tool
 * output, no documents). Fail-open: any error, kill switch or unanswered ask ⇒ {cls:null, decision:null, usableKind:null}.
 */
export async function decideTaskKind(
  state: Record<string, unknown>,
  opts: { timeoutMs: number; sessionId?: string; segment?: string },
): Promise<TaskKindResult> {
  const none: TaskKindResult = { cls: null, decision: null, usableKind: null };
  if (taskKindDisabled()) return none;
  try {
    const { decide } = await import('./decision-gate');
    const r = await decide(state, taskKindQuestions(), {
      purpose: TASK_KIND_PURPOSE, timeoutMs: opts.timeoutMs, sessionId: opts.sessionId, ...(opts.segment ? { segment: opts.segment } : {}),
      // No shadow challenger per human turn: nothing reads a task_kind challenger pairing yet (2026-10-20 review).
      challengers: false,
    });
    if (!r) return none;
    const cls = classifyTaskKind(r.answers);
    return { cls, decision: r, usableKind: usableTaskKind(r, cls) };
  } catch {
    return none;
  }
}

/**
 * The bench's question GROUP → kind map (human_corpus.py groups + the bench-only corpora). The Python twin is
 * scripts/e2e/model-bench.py GROUP_KIND; a jest pin compares them. A corpus entry's own `kind=<k>` flag overrides its
 * group's kind (model-bench.py question_kind — a mixed group, or an entry a blind classification vote re-filed); the
 * bench writes the result into the chat title's `k:<kind>` token, which is all the ingest reads.
 */
export const BENCH_GROUP_KIND: Readonly<Record<string, TaskKind>> = {
  writing: 'writing', paste: 'writing', lang: 'writing',
  code: 'code',
  math: 'analysis', opinion: 'analysis', complex: 'analysis',
  lookup: 'lookup', trivia: 'lookup', news: 'lookup', local: 'lookup', shopping: 'lookup', tools: 'lookup',
  health: 'advice', money: 'advice', advice: 'advice', compare: 'advice',
  plan: 'planning',
  explain: 'explain', howto: 'explain', homework: 'explain', cooking: 'explain',
};

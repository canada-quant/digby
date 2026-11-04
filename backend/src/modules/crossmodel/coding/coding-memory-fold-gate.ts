/**
 * Coding-memory fold gate — decision-gate purpose `coding_memory_fold`
 * (N3, docs/DECISION_MODEL_ENHANCEMENTS_2026-09-25.md §5; shipped SHADOW).
 *
 * WHY: `updateCodingMemoryAsync` fires after EVERY coding run (≈388/day):
 * a session-summary rewrite (30 s), the project fold (60 s, thinking on),
 * the user-preference rewrite (30 s) — and `writeRunJournalEntryAsync`
 * distils every terminal run (45 s). The chat `memory_extract` gate covers
 * none of it. Most machine runs carry nothing durable, yet every leg still
 * spends a utility-seat call to rewrite an unchanged doc. The gate asks ONE
 * prefill of per-leg nouls BEFORE the legs, over the same ≤ 800-char slices
 * the prompts themselves use (plus heads of the EXISTING memory so "new" is
 * judged against what is already stored):
 *   session_state_change — the session's goal or state moved;
 *   project_fact         — a new command / path / convention / decision worth
 *                          folding into project memory;
 *   user_preference      — a durable, cross-project developer preference;
 *   journal_worthy       — the run did / decided / observed something a
 *                          future run in this chat should know.
 *
 * MODES (decisionMode('coding_memory_fold'); default shadow, NODE_ENV=test off):
 *   shadow — every leg runs exactly as before; each leg records an outcome
 *            row whose `actual` is HARNESS-MEASURED: did the leg's extractor
 *            actually change the stored doc (content diff non-empty ⇒ true,
 *            identical ⇒ false, LLM / parse failure ⇒ null — evidences
 *            nothing about the question).
 *   act    — DESIGNED, NOT ENABLED: a leg whose noul is confidently false
 *            (≤ 1 − DECISION_GATE_THRESHOLD_CODING_MEMORY_FOLD, default 0.8)
 *            is SKIPPED (acted:true, no utility call, the stored doc is left
 *            untouched). Keyed on the RESULT's mode (E2) — never decisionMode().
 * Fail-open everywhere: a thrown anything, a null gate answer, a timeout ⇒
 * every leg runs. Kill switches: the gate-wide switches. Background path only (fire-and-forget after
 * finalize). Shadow NEVER waits on the gate (it rides alongside the legs;
 * labels land via the promise); only act waits, ≤ 3 s, off any user path.
 *
 * CAVEAT (label quality): the session leg is a rolling PARAPHRASE — its text
 * diff is non-empty on nearly every run, so `session_state_change` labels
 * will read ≈ always-true; the informative legs are project / user / journal.
 *
 * LEAF: imports decision-gate only (coding-memory.service and
 * run-journal.service import this; it must never import them back).
 */

import logger from '../../../utils/logger';
import {
  decide, decisionMode, decisionThreshold, recordDecisionOutcome,
  type DecideResult, type DecisionQuestion,
} from '../platform/decision-gate';

export type CodingMemoryLeg = 'session' | 'project' | 'user' | 'journal';
export const CODING_MEMORY_LEGS: readonly CodingMemoryLeg[] = ['session', 'project', 'user', 'journal'];

/** Question key per leg (the vocabulary the telemetry rows carry). */
export const CODING_MEMORY_FOLD_QUESTION: Record<CodingMemoryLeg, string> = {
  session: 'session_state_change',
  project: 'project_fact',
  user: 'user_preference',
  journal: 'journal_worthy',
};

const LEG_QUESTIONS: Record<CodingMemoryLeg, DecisionQuestion> = {
  session: {
    type: 'noul',
    instructions: 'The latest exchange changes what this coding session has built or is now trying to do — the rolling session summary would read differently after it.',
    criteria: {
      true: 'the run built, changed, fixed or decided something, or the goal moved (new task, new scope, a blocker found or cleared)',
      false: 'a no-op or idle run, a status echo, a failed call with nothing done, or a repeat of what the summary already says',
    },
  },
  project: {
    type: 'noul',
    instructions: 'The latest exchange reveals a NEW durable fact about this codebase worth folding into project memory: a working build/test/lint/run command, a file path or module that matters, an architecture convention, a gotcha, or a decision — and it is not already in the current project memory.',
    criteria: {
      true: 'a command that worked (or failed for a reusable reason), a discovered path/convention/gotcha, or a durable decision that is absent from the current memory',
      false: 'transient task state, a status report, a no-op run, or facts the current project memory already holds',
    },
  },
  user: {
    type: 'noul',
    instructions: 'The latest exchange reveals a standing, CROSS-PROJECT preference of the developer (tooling choice, code style, commit/PR convention, how they want the assistant to behave) that is not already in the current preferences.',
    criteria: {
      true: 'the user stated or clearly implied a durable preference that applies beyond this one codebase and task',
      false: 'nothing personal or standing was revealed — a machine-triggered run, a task-specific instruction, or a preference already stored',
    },
  },
  journal: {
    type: 'noul',
    instructions: 'A future run in this chat would benefit from a journal entry about this run: it did, decided, changed, failed at, or OBSERVED something concrete (a result, a file, a metric, a status) rather than closing as a no-op.',
    criteria: {
      true: 'completed or partial work, a decision, a failure, files touched, or concrete observed state (counts, statuses, versions)',
      false: 'an idle or no-op run with nothing produced, decided, failed or observed',
    },
  },
};

/**
 * backlog E14 (2026-09-28): 0.8 → 0.9. On the 2026-09-28 readiness stamp the
 * act band at τ 0.8 held 719/1,035 (precision 0.695, Wilson LB 0.666 < 0.9) and
 * AUROC 0.751 — the second-largest Jev consumer (2,635 decisions / 7 d) with a
 * 26 % false-label share. A higher cutoff shrinks the band to the confident
 * tail; decision-gate-fit ACT_POLICIES.coding_memory_fold.defaultThreshold
 * moved in lockstep so the ruler measures the same band the consumer acts on.
 * DECISION_GATE_THRESHOLD_CODING_MEMORY_FOLD=0.8 restores the old cutoff (site
 * and ruler). The fitted Jev temperature is the readiness job's opt-in autofit
 * (DECISION_GATE_TEMP_AUTOFIT_ENABLED=1) or `npm run decision-gate:fit`.
 */
export const CODING_MEMORY_FOLD_DEFAULT_THRESHOLD = 0.9;
/** Gate deadline — a background path, but the legs should not wait long on it. */
export const CODING_MEMORY_FOLD_TIMEOUT_MS = 3000;
/** State slices mirror the prompts (user 800 / assistant 800 / final 1500). */
export const FOLD_STATE_USER_CHARS = 800;
export const FOLD_STATE_ASSISTANT_CHARS = 800;
export const FOLD_STATE_FINAL_CHARS = 1500;
export const FOLD_STATE_EXISTING_ITEMS = 6;
export const FOLD_STATE_EXISTING_ITEM_CHARS = 120;
export const FOLD_STATE_SESSION_HEAD_CHARS = 300;

/**
 * ACT scheduling only (never acting): when the purpose is armed the legs must
 * wait for the gate's answer BEFORE they run (a leg can only be skipped up
 * front). In shadow / off the gate rides ALONGSIDE the legs — started first,
 * never awaited before a leg, so the shadow path's timing is byte-identical to
 * the pre-gate path (review 2026-09-25). Acting itself keys on the RESULT's
 * mode inside consultCodingMemoryFoldGate (E2).
 */
export function codingMemoryFoldGateWaitsFirst(): boolean {
  try {
    return decisionMode('coding_memory_fold') === 'act';
  } catch { return false; }
}

export interface CodingMemoryFoldGateInput {
  /** Which legs would run (each gets its own noul in the one prefill). */
  legs: readonly CodingMemoryLeg[];
  userMessage: string;
  /** What the agent did (the fold's `assistantSummary`) or the run's final (the journal). */
  assistantSummary: string;
  toolsUsed: readonly string[];
  /** Stamped on the telemetry rows (the chat / session id). */
  sessionId?: string;
  /** Journal leg: the run's trigger kind (user / machine / hook …). */
  trigger?: string;
  /** Heads of the EXISTING docs so "new" is judged against what is stored. */
  existing?: {
    sessionSummary?: string | null;
    projectCommands?: readonly string[];
    projectNotes?: readonly string[];
    userPreferences?: readonly string[];
    /** backlog E14 (2026-09-28): when each stored doc last changed (ISO) — the state carries the age in minutes. */
    sessionUpdatedAt?: string | null;
    projectUpdatedAt?: string | null;
    userUpdatedAt?: string | null;
  };
  /** backlog E14: the clock the fold-age facts are measured against (tests; default now). */
  now?: Date;
}

/** backlog E14: the harness facts the fold gate's state gains — sizes of the stored docs + the age of their last change. Pure. */
export function codingMemoryFoldStateFacts(input: Pick<CodingMemoryFoldGateInput, 'existing' | 'now' | 'assistantSummary' | 'toolsUsed'>): Record<string, number> {
  const nowMs = (input.now ?? new Date()).getTime();
  const ageMin = (iso: string | null | undefined): number | undefined => {
    if (!iso) return undefined;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 60_000)) : undefined;
  };
  const chars = (v: unknown): number => (typeof v === 'string' ? v.length : Array.isArray(v) ? v.reduce((n: number, s) => n + String(s ?? '').length, 0) : 0);
  const e = input.existing;
  const out: Record<string, number | undefined> = {
    existing_session_summary_chars: chars(e?.sessionSummary),
    existing_project_doc_chars: chars(e?.projectCommands) + chars(e?.projectNotes),
    existing_project_items: (e?.projectCommands?.length ?? 0) + (e?.projectNotes?.length ?? 0),
    existing_user_preference_items: e?.userPreferences?.length ?? 0,
    session_fold_age_min: ageMin(e?.sessionUpdatedAt),
    project_fold_age_min: ageMin(e?.projectUpdatedAt),
    user_fold_age_min: ageMin(e?.userUpdatedAt),
    assistant_did_chars: String(input.assistantSummary ?? '').length,
    tools_used_count: input.toolsUsed.length,
  };
  const facts: Record<string, number> = {};
  for (const [k, v] of Object.entries(out)) if (typeof v === 'number') facts[k] = v;
  return facts;
}

export interface CodingMemoryFoldGateResult {
  gate: DecideResult | null;
  /** Legs the gate says to drop — act mode only; always all-false in shadow/off. */
  skip: Record<CodingMemoryLeg, boolean>;
}

const noSkips = (): Record<CodingMemoryLeg, boolean> => ({ session: false, project: false, user: false, journal: false });

const clip = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const heads = (items: readonly string[] | undefined): string[] | undefined => {
  if (!items || !items.length) return undefined;
  return items.slice(0, FOLD_STATE_EXISTING_ITEMS).map((s) => clip(s, FOLD_STATE_EXISTING_ITEM_CHARS)).filter(Boolean);
};

/** The gate state — the prompts' own slices, counts first, prose last. Pure. */
export function buildCodingMemoryFoldState(input: CodingMemoryFoldGateInput): Record<string, unknown> {
  const journalOnly = input.legs.length === 1 && input.legs[0] === 'journal';
  const state: Record<string, unknown> = {
    legs_asked: input.legs.join(', '),
    trigger: input.trigger,
    // backlog E14 (2026-09-28): the harness facts first (counts before prose) — doc sizes + last-fold age per leg.
    ...codingMemoryFoldStateFacts(input),
    tools_used: input.toolsUsed.slice(0, 20).join(', ') || 'none',
    existing_session_summary_head: input.existing?.sessionSummary ? clip(input.existing.sessionSummary, FOLD_STATE_SESSION_HEAD_CHARS) : undefined,
    existing_project_commands: heads(input.existing?.projectCommands),
    existing_project_notes: heads(input.existing?.projectNotes),
    existing_user_preferences: heads(input.existing?.userPreferences),
    user_message: clip(input.userMessage, FOLD_STATE_USER_CHARS) || '(machine-triggered run — no user message)',
    [journalOnly ? 'run_final_output' : 'assistant_did']: clip(input.assistantSummary, journalOnly ? FOLD_STATE_FINAL_CHARS : FOLD_STATE_ASSISTANT_CHARS) || '(nothing)',
  };
  for (const k of Object.keys(state)) if (state[k] === undefined) delete state[k];
  return state;
}

/**
 * ONE decide() over the legs' questions. shadow → skip nothing; act → skip a
 * leg whose noul is confidently false (≤ 1 − threshold). Never throws: any
 * failure means skip nothing (the gate can only remove work, never add risk).
 */
export async function consultCodingMemoryFoldGate(input: CodingMemoryFoldGateInput): Promise<CodingMemoryFoldGateResult> {
  const result: CodingMemoryFoldGateResult = { gate: null, skip: noSkips() };
  try {
    if (!input.legs.length) return result;
    if (decisionMode('coding_memory_fold') === 'off') return result;
    const questions: Record<string, DecisionQuestion> = {};
    for (const leg of input.legs) questions[CODING_MEMORY_FOLD_QUESTION[leg]] = LEG_QUESTIONS[leg];
    result.gate = await decide(buildCodingMemoryFoldState(input), questions, {
      purpose: 'coding_memory_fold', timeoutMs: CODING_MEMORY_FOLD_TIMEOUT_MS, ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
    // E2 (2026-09-25): the RESULT's mode gates acting — an uncalibrated backend answers as 'shadow'.
    if (!result.gate || result.gate.mode !== 'act') return result;
    // + 1e-9: 1 − 0.8 is 0.19999999999999996 in floating point (memory.graph precedent).
    const cutoff = 1 - decisionThreshold('coding_memory_fold', CODING_MEMORY_FOLD_DEFAULT_THRESHOLD) + 1e-9;
    for (const leg of input.legs) {
      const a = result.gate.answers[CODING_MEMORY_FOLD_QUESTION[leg]];
      if (a && a.type === 'noul' && a.noul <= cutoff) result.skip[leg] = true;
    }
  } catch (err: any) {
    logger.debug(`coding-memory-fold-gate: failed open (non-fatal): ${err?.message ?? err}`);
    result.gate = result.gate ?? null;
    result.skip = noSkips();
  }
  return result;
}

/** What a leg measurably did: its stored doc changed / stayed identical /
 *  the leg was skipped by the gate / the extractor failed (LLM, parse, empty). */
export type CodingMemoryLegOutcome = 'changed' | 'noop' | 'skipped' | 'failed';

/**
 * Content-only comparison (updatedAt excluded) — the "diff non-empty" label. Pure.
 *
 * KEY-ORDER INDEPENDENT (review 2026-09-25): the `before` doc comes back from
 * the `store` table's JSONB column, and Postgres jsonb returns object keys
 * sorted by (length, bytes) — a project doc reads back as {notes, commands,
 * overview, updatedAt} while the code builds `after` as {overview, commands,
 * notes, updatedAt}. A plain JSON.stringify compare therefore read "changed"
 * on every fold with identical content (a constant-true label). Objects are
 * canonicalised (keys sorted recursively) before the compare; arrays keep
 * their order (an item reordering IS a content change).
 */
export function memoryDocChanged(before: unknown, after: unknown): boolean {
  try { return canonicalJson(before, true) !== canonicalJson(after, true); } catch { return true; }
}

/** Deterministic JSON: object keys sorted recursively; `updatedAt` dropped at the top level only. */
function canonicalJson(v: unknown, top: boolean): string {
  return JSON.stringify(canonicalize(v, top));
}
function canonicalize(v: unknown, top: boolean): unknown {
  if (v === undefined) return null;
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => canonicalize(x, false));
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    if (top && k === 'updatedAt') continue;
    const val = (v as Record<string, unknown>)[k];
    if (val === undefined) continue; // JSON.stringify drops undefined members — mirror it
    o[k] = canonicalize(val, false);
  }
  return o;
}

/**
 * One outcome row for one leg. A skipped leg is `acted:true` (actual null —
 * the extractor did not run); a leg that ran is `acted:false` with the
 * harness-measured actual (changed ⇒ true, noop ⇒ false, failed ⇒ null).
 * Fire-and-forget; never throws.
 */
export function recordCodingMemoryFoldOutcome(
  gated: CodingMemoryFoldGateResult | null | undefined,
  leg: CodingMemoryLeg,
  outcome: CodingMemoryLegOutcome,
  sessionId?: string,
  detail?: string,
): void {
  try {
    if (!gated?.gate) return;
    const question = CODING_MEMORY_FOLD_QUESTION[leg];
    const tail = detail ? ` ${detail}` : '';
    if (outcome === 'skipped') {
      recordDecisionOutcome(gated.gate, 'coding_memory_fold', { question, actual: null, acted: true, sessionId, note: `skipped by gate${tail}` });
      return;
    }
    const actual = outcome === 'changed' ? true : outcome === 'noop' ? false : null;
    recordDecisionOutcome(gated.gate, 'coding_memory_fold', {
      question, actual, acted: false, sessionId,
      note: outcome === 'failed' ? `ran: failed — outcome unknown${tail}` : `ran: ${outcome}${tail}`,
    });
  } catch { /* telemetry never breaks memory */ }
}

/**
 * The same outcome row, keyed on the gate PROMISE — the legs never await the
 * gate for a label (shadow rides alongside; the row lands whenever the gate
 * answers, or never when it failed open). Fire-and-forget; never throws.
 */
export function labelCodingMemoryFold(
  gateP: Promise<CodingMemoryFoldGateResult> | null | undefined,
  leg: CodingMemoryLeg,
  outcome: CodingMemoryLegOutcome,
  sessionId?: string,
  detail?: string,
): void {
  if (!gateP) return;
  void gateP.then((g) => recordCodingMemoryFoldOutcome(g, leg, outcome, sessionId, detail)).catch(() => { /* fail-open */ });
}

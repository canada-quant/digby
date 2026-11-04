/**
 * Nightly guard-strike adjudication (remediation P8, item N6 second half —
 * P0 shipped the write half, `adjudicateStrike` in platform/loop-metrics):
 * every guard_strike row from the last 24h lacking `meta.adjudication` gets a
 * verdict — true_positive | false_positive | unclear — so the guard's own
 * precision becomes chartable instead of anecdotal.
 *
 * Two passes, CHEAP first:
 *   1. DETERMINISTIC heuristics (no LLM):
 *      · construction-class seams (tool_derail_break, tool_repeat_break,
 *        tool_preflight, transcript_repair, zero_tool_prefinal) fire on
 *        mechanically-verifiable conditions — the condition holding IS the
 *        ground truth ⇒ true_positive by construction.
 *      · an in-loop reject_back strike whose run's SAME runId later recorded a
 *        finalize guard_miss ⇒ the model corrected under the guard's pressure
 *        and the accepted final passed clean ⇒ true_positive.
 *      · a machine_wake_reject_back strike with citationRetry 'clean' (the
 *        bounced chat wake self-corrected) ⇒ true_positive.
 *      · a FINALIZE-seam strike (no meta.seam, meta.kinds only) whose SAME
 *        runId later recorded a guard_miss ⇒ the re-finalized run delivered
 *        the guard-clean final with the claims verified/receipted ⇒
 *        false_positive (the earlier conviction didn't survive re-evaluation).
 *   2. The AMBIGUOUS remainder (cap ADJUDICATION_LLM_CAP/night, newest first):
 *      ONE utilityChat batch call classifying each strike from its meta + the
 *      run's journal entry + the agent_runs status. Overflow waits for the
 *      next night (rows stay unadjudicated, re-picked then).
 *
 * G17 SUBSTITUTION (recorded here because the worker has no repo checkout, so
 * the brief's "count fabrication-flavored commit subjects via git log" is
 * impossible on the box): the fabrication metric is instead the count of
 * last-24h guard_strike rows in FABRICATION-CLASS shapes (reject_back /
 * machine_wake_reject_back / machine_wake_citation_enforce / outbound_claim
 * seams, plus seam-less finalize
 * strikes — those exist only when the claims verdict found fabrication-class
 * findings; numeric_provenance was dropped from the class 2026-09-11 — default
 * off, 23/24 adjudicated FP). Logged + returned in the summary string; the
 * rows themselves stay queryable (fleet-status.sql §2/§8).
 *
 * Job posture: durable cron `strike-adjudication` (worker.ts, 86400 s).
 * Kill-switch: STRIKE_ADJUDICATION_DISABLED=1 (checked in the worker handler
 * AND here — the MEMORY_DREAM_DISABLED pattern, belt included). Per-row
 * isolation: one failed adjudicateStrike write never kills the pass.
 *
 * DECISION GATE — purpose `guard_strike` (N1, docs/DECISION_MODEL_ENHANCEMENTS
 * _2026-09-25.md §5): the ONE purpose with a labelled corpus on day one. After
 * both passes above have produced their verdicts, every strike adjudicated
 * TONIGHT (deterministic + LLM, newest first, capped by
 * DECISION_GATE_GUARD_STRIKE_NIGHTLY_CAP) is ALSO put to the decision seat as
 * a Choice {true_positive, false_positive, unclear} over the strike's
 * metadata (numeric facts pre-computed in code — never the verdict) + the
 * run's status/journal + the later-clean-finalize flag, and the pass's own
 * verdict is recorded as the outcome label (recordDecisionOutcome: `agreed`
 * = gate choice == verdict). SHADOW changes nothing. ACT (designed; the mode
 * is shadow by default and NODE_ENV=test is off): the gate adjudicates the
 * AMBIGUOUS OVER-CAP remainder — strikes the 30/night reasoning batch could
 * not reach — writing a confident (≥ DECISION_GATE_THRESHOLD_GUARD_STRIKE,
 * default 0.9) true_positive / false_positive; `unclear` is never written,
 * and rows already labelled tonight are never re-written by the gate.
 * Fail-open everywhere: a gate error changes nothing about adjudication.
 * Kill switches: the gate-wide DECISION_GATE_DISABLED=1 /
 * DECISION_GATE_MODE_GUARD_STRIKE=off.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { adjudicateStrike } from '../platform/loop-metrics.service';
import { utilityChat } from '../../../utils/utility-llm';
import {
  decide, decisionMode, decisionThreshold, confidenceOf, recordDecisionOutcome,
  type DecideResult, type DecisionQuestion,
} from '../platform/decision-gate';

// ── Tunables ──────────────────────────────────────────────────────────────────

export const ADJUDICATION_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Bound on rows read per night (newest first; a bigger backlog drains nightly). */
export const ADJUDICATION_FETCH_CAP = 2000;
/** Ambiguous strikes sent to the ONE utilityChat batch call per night. */
export const ADJUDICATION_LLM_CAP = 30;

export type StrikeVerdict = 'true_positive' | 'false_positive' | 'unclear';

/** Seams that are true_positive BY CONSTRUCTION — each fires on a condition
 *  the harness verified mechanically (derail/repeat breakers, tool pre-flight
 *  refusals, malformed-transcript repair). Gate flip 2026-09-11: the
 *  zero-evidence-tool gate is OBSERVE-ONLY (rows carry outcome 'observed'), so
 *  it is no longer stamped true_positive by construction — an observed
 *  tool-less answer can be perfectly correct and must be able to read as FP. */
export const CONSTRUCTION_TRUE_POSITIVE_SEAMS: ReadonlySet<string> = new Set([
  'tool_derail_break',
  'tool_repeat_break',
  'tool_preflight',
  'transcript_repair',
]);

/** Fabrication-class strike seams (the G17 substitute metric's vocabulary).
 *  Gate flip 2026-09-11: numeric_provenance is default-OFF and 23/24 of its
 *  adjudicated strikes were false positives — it no longer counts as
 *  fabrication-class, so historical rows stop feeding the G17 metric.
 *  Hardening review 2026-09-14: machine_wake_citation_enforce added — a
 *  citation-class machine-wake strike (fabricated evidence ids, the
 *  always-on deterministic lane, ticket b216475a) now writes ONLY its
 *  'enforced' row (chat-agent no longer also writes a mislabeled 'observed'
 *  machine_wake_reject_back row for it), so without this seam a
 *  citation-class strike with no reject-back armed would vanish from G17. */
export const FABRICATION_CLASS_SEAMS: ReadonlySet<string> = new Set([
  'reject_back',
  'machine_wake_reject_back',
  'machine_wake_citation_enforce',
  'outbound_claim',
]);

/** Observe-only TELEMETRY seams the nightly pass SKIPS entirely (review fix
 *  2026-09-27): their rows are counters the owner reads by kind + strike, not
 *  fabrication verdicts — the deterministic pass has no rule for them and the
 *  bounded LLM batch would spend its ADJUDICATION_LLM_CAP judging a seam whose
 *  packed state carries none of the fields the strike rests on. The
 *  production-state lane (platform/action-verifier.ts, strike
 *  production_state_unread) is the first: it observes a supervisor's
 *  serving / deployed / banked sentence against this run's reads, delivers the
 *  note unmodified, and must never mint an adjudication nor feed the G17 metric. */
export const ADJUDICATION_SKIPPED_SEAMS: ReadonlySet<string> = new Set([
  'machine_wake_production_state',
  // Related to ticket 4c7aebf7 part (c) (2026-10-21, chat-agent/computer-task-claims.ts COMPUTER_TASK_CLAIM_SEAM): a
  // supervisor machine note's on-screen INPUT claims vs the run's computer_task results (observe-only / busy /
  // unavailable / no call) — written only under the opt-in COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1, a deterministic
  // observe-only annotation, never a fabrication verdict, never G17.
  'machine_wake_computer_task_claim',
]);

// ── Pure classification helpers (exported for tests) ─────────────────────────

export interface DeterministicStrikeInput {
  /** meta.seam ('' = the seam-less finalize strike, meta.kinds only). */
  seam: string;
  /** meta.citationRetry (machine_wake_reject_back rows: 'clean'|'still_dirty'). */
  citationRetry?: string;
  /** The row carries claim-verdict finding kinds (meta.kinds non-empty). */
  hasFindingKinds: boolean;
  /** A guard_miss row exists for the SAME runId created AFTER this strike. */
  laterCleanFinalize: boolean;
}

/**
 * The deterministic pass for one strike. Returns a verdict, or null when the
 * strike is ambiguous (goes to the bounded LLM batch). Pure.
 */
export function classifyStrikeDeterministic(s: DeterministicStrikeInput): StrikeVerdict | null {
  if (CONSTRUCTION_TRUE_POSITIVE_SEAMS.has(s.seam)) return 'true_positive';
  if (s.seam === 'reject_back' && s.laterCleanFinalize) return 'true_positive';
  if (s.seam === 'machine_wake_reject_back' && s.citationRetry === 'clean') return 'true_positive';
  if (!s.seam && s.hasFindingKinds && s.laterCleanFinalize) return 'false_positive';
  return null;
}

/** G17 substitute predicate: is this strike row fabrication-class? Pure. */
export function isFabricationClassStrike(meta: any): boolean {
  const seam = typeof meta?.seam === 'string' ? meta.seam : '';
  if (FABRICATION_CLASS_SEAMS.has(seam)) return true;
  // Seam-less finalize strikes exist ONLY when the claims/guard verdict found
  // fabrication-class findings (run-executor's finalize telemetry row).
  return !seam && Array.isArray(meta?.kinds) && meta.kinds.length > 0;
}

/** Tolerant parse of the LLM batch answer: a JSON array of {i, v}. Returns a
 *  1-based-index → verdict map; malformed entries are dropped. Pure. */
export function parseAdjudicationVerdicts(raw: string, count: number): Map<number, StrikeVerdict> {
  const out = new Map<number, StrikeVerdict>();
  try {
    const cleaned = String(raw ?? '').replace(/```json\n?|\n?```/g, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start < 0 || end <= start) return out;
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(arr)) return out;
    for (const e of arr) {
      const i = Number(e?.i);
      const v = String(e?.v ?? '').trim();
      if (!Number.isInteger(i) || i < 1 || i > count) continue;
      if (v !== 'true_positive' && v !== 'false_positive' && v !== 'unclear') continue;
      if (!out.has(i)) out.set(i, v);
    }
  } catch { /* malformed answer → empty map (rows stay for the next night) */ }
  return out;
}

// ── Decision gate — guard-strike adjudication (N1, 2026-09-25) ───────────────

/** The question key on every guard_strike decision/outcome row. */
export const GUARD_STRIKE_GATE_QUESTION = 'verdict';
/** Gate calls per night (labelled strikes first, newest first; then, in ACT
 *  mode only, the over-cap ambiguous remainder). Env DECISION_GATE_GUARD_STRIKE_NIGHTLY_CAP. */
export const GUARD_STRIKE_GATE_DEFAULT_CAP = 200;
/** Parallel gate calls in flight (a nightly job — latency is not the bound, the vendor's rate is). */
export const GUARD_STRIKE_GATE_CONCURRENCY = 4;
/** Per-call deadline; the seat chain's own per-leg bound applies inside it. */
export const GUARD_STRIKE_GATE_TIMEOUT_MS = 3000;
/** Acting confidence for the over-cap write (DECISION_GATE_THRESHOLD_GUARD_STRIKE overrides). */
export const GUARD_STRIKE_GATE_DEFAULT_THRESHOLD = 0.9;

/** Nightly gate-call cap (env override, clamped 0..2000; 0 = no calls). */
export function guardStrikeGateCap(): number {
  const raw = Number(process.env.DECISION_GATE_GUARD_STRIKE_NIGHTLY_CAP);
  const v = Number.isFinite(raw) ? Math.floor(raw) : GUARD_STRIKE_GATE_DEFAULT_CAP;
  return Math.min(2000, Math.max(0, v));
}

/** The typed question — the same three-way vocabulary the LLM batch answers,
 *  so the pass's verdict IS the label. Criteria mirror the batch prompt. */
export const GUARD_STRIKE_GATE_QUESTIONS: Record<string, DecisionQuestion> = {
  [GUARD_STRIKE_GATE_QUESTION]: {
    type: 'choice',
    instructions: "A harness guard flagged (\"struck\") an autonomous model run. From the strike metadata, the run's status and journal, and whether the same run later delivered a guard-clean final, judge whether the guard was right.",
    criteria: {
      true_positive: 'the model really made an unevidenced or fabricated claim, cited a phantom id/receipt, invented a number, or genuinely derailed — the guard was right',
      false_positive: 'the flagged output was legitimate and evidenced (the claim, number or citation was real) — the guard misfired',
      unclear: 'the facts given cannot settle whether the guard was right',
    },
  },
};

export interface StrikeGateFacts {
  /** agent_runs.status of the struck run (absent when the run row is gone). */
  runStatus?: string | null;
  /** The run's journal entry (goal / outcome / failures), when one exists. */
  journal?: { goal?: unknown; outcome?: unknown; failures?: unknown } | null;
  /** A guard_miss row exists for the SAME runId created AFTER this strike (the deterministic pass's signal). */
  laterCleanFinalize: boolean;
}

const str = (v: unknown, max: number): string | undefined => {
  if (v == null) return undefined;
  const t = String(v).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
};
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : Array.isArray(v) ? v.length : undefined);

/**
 * The CODE-COMPUTED state for one strike — the strike's own metadata with the
 * numeric facts pre-computed (jaggedness #2: a small model reads counts, not
 * arrays), the run's status + journal, and the later-clean-finalize flag.
 * NEVER carries the adjudication fields (the label must not leak into the
 * state) nor the model/provider (the verdict must not learn a vendor prior).
 * Bounded ≈2.5k chars. Pure.
 */
export function buildStrikeGateState(meta: any, facts: StrikeGateFacts): Record<string, unknown> {
  const m = meta && typeof meta === 'object' ? meta : {};
  const kinds = Array.isArray(m.kinds) ? m.kinds.slice(0, 6).map((k: unknown) => str(k, 40)).filter(Boolean) : [];
  const tokens = Array.isArray(m.tokens) ? m.tokens.slice(0, 6).map((k: unknown) => str(k, 60)).filter(Boolean) : [];
  const clockHits = Array.isArray(m.clockHits) ? m.clockHits : [];
  const firstClock = clockHits[0] && typeof clockHits[0] === 'object' ? clockHits[0] : null;
  const j = facts.journal && typeof facts.journal === 'object' ? facts.journal : null;
  const failures = Array.isArray(j?.failures) ? j!.failures.slice(0, 2).map((f: unknown) => str(f, 120)).filter(Boolean).join('; ') : undefined;
  const state: Record<string, unknown> = {
    seam: str(m.seam, 60) ?? 'finalize',
    guard: str(m.guard, 60),
    outcome: str(m.outcome, 40),
    strike: str(m.strike, 40),
    findings: kinds.length ? kinds : undefined,
    citation_retry: str(m.citationRetry, 20),
    supervisor_scope: str(m.supervisorScope, 20),
    trigger_kind: str(m.triggerKind, 20),
    profile: str(m.profile, 20),
    tool: str(m.tool, 60),
    intended_tool: str(m.intended, 60),
    reason: str(m.reason, 80),
    matched: str(m.matched, 120),
    shape: str(m.shape, 40),
    phantom_ids: num(m.phantoms),
    cited_ids: num(m.ids),
    marked_lines: num(m.markedLines),
    observed_lines: num(m.observedLines),
    numeric_tokens: tokens.length ? tokens : undefined,
    clock_hits: clockHits.length || undefined,
    first_clock_hit: firstClock ? { line: str(firstClock.line, 300), token: str(firstClock.token, 30), minutes_ahead: num(firstClock.minutesAhead) } : undefined,
    run_status: str(facts.runStatus, 20),
    later_clean_finalize: facts.laterCleanFinalize,
    journal_goal: str(j?.goal, 240),
    journal_outcome: str(j?.outcome, 400),
    journal_failures: failures || undefined,
  };
  for (const k of Object.keys(state)) if (state[k] === undefined) delete state[k];
  return state;
}

/** One strike put to the gate: the row, its label tonight (null = over-cap
 *  ambiguous, unlabelled), and where the label came from. */
export interface StrikeGateItem {
  row: { id: string; runId: string | null; sessionId: string | null; createdAt: Date; meta: any };
  verdict: StrikeVerdict | null;
  source: 'deterministic' | 'llm' | 'none';
  facts: StrikeGateFacts;
}

export interface StrikeGateSummary {
  mode: 'off' | 'shadow' | 'act';
  asked: number;
  labelled: number;
  agreed: number;
  /** ACT only: over-cap strikes the gate adjudicated. */
  wrote: number;
  errors: number;
}

/**
 * Put tonight's strikes to the decision seat (bounded concurrency, per-item
 * isolation). Labelled items record the pass's verdict as the outcome;
 * unlabelled items exist ONLY in act mode (the over-cap remainder) and a
 * confident non-unclear answer is written through adjudicateStrike. Never
 * throws; a null/throwing gate leaves adjudication exactly as it was.
 */
export async function gateStrikes(items: StrikeGateItem[], opts?: { mode?: 'off' | 'shadow' | 'act'; cap?: number; concurrency?: number }): Promise<StrikeGateSummary> {
  const mode = opts?.mode ?? decisionMode('guard_strike');
  const out: StrikeGateSummary = { mode, asked: 0, labelled: 0, agreed: 0, wrote: 0, errors: 0 };
  if (mode === 'off') return out;
  const cap = opts?.cap ?? guardStrikeGateCap();
  // Labelled first (the calibration corpus), newest first; over-cap ambiguous
  // rows only in ACT mode (a shadow call on them would have no label).
  const queue = items
    .filter((it) => it.verdict !== null || mode === 'act')
    .sort((a, b) => (a.verdict === null ? 1 : 0) - (b.verdict === null ? 1 : 0) || b.row.createdAt.getTime() - a.row.createdAt.getTime())
    .slice(0, cap);
  const threshold = decisionThreshold('guard_strike', GUARD_STRIKE_GATE_DEFAULT_THRESHOLD);
  const workers = Math.max(1, Math.min(GUARD_STRIKE_GATE_CONCURRENCY, opts?.concurrency ?? GUARD_STRIKE_GATE_CONCURRENCY));
  let cursor = 0;
  const runOne = async (it: StrikeGateItem): Promise<void> => {
    const seam = typeof it.row.meta?.seam === 'string' && it.row.meta.seam ? it.row.meta.seam : 'finalize';
    let decision: DecideResult | null = null;
    try {
      decision = await decide(buildStrikeGateState(it.row.meta, it.facts), GUARD_STRIKE_GATE_QUESTIONS, {
        purpose: 'guard_strike', timeoutMs: GUARD_STRIKE_GATE_TIMEOUT_MS, ...(it.row.sessionId ? { sessionId: it.row.sessionId } : {}),
      });
    } catch { decision = null; }
    if (!decision) { out.errors += 1; return; }
    out.asked += 1;
    const a = decision.answers[GUARD_STRIKE_GATE_QUESTION];
    const choice = a && a.type === 'choice' ? a.choice : null;
    if (it.verdict !== null) {
      out.labelled += 1;
      if (choice === it.verdict) out.agreed += 1;
      recordDecisionOutcome(decision, 'guard_strike', {
        question: GUARD_STRIKE_GATE_QUESTION, actual: it.verdict, acted: false,
        ...(it.row.sessionId ? { sessionId: it.row.sessionId } : {}),
        note: `label:${it.source} seam=${seam}`,
      });
      return;
    }
    // Over-cap ambiguous strike (ACT only): write a confident, non-unclear verdict.
    // E2 (2026-09-25): the RESULT's mode gates acting — an uncalibrated backend answers as 'shadow'.
    const confident = decision.mode === 'act' && choice !== null && choice !== 'unclear' && confidenceOf(a) >= threshold;
    if (confident && (choice === 'true_positive' || choice === 'false_positive')) {
      try {
        const ok = await adjudicateStrike(it.row.id, choice);
        if (ok) out.wrote += 1;
        recordDecisionOutcome(decision, 'guard_strike', {
          question: GUARD_STRIKE_GATE_QUESTION, actual: null, acted: ok,
          ...(it.row.sessionId ? { sessionId: it.row.sessionId } : {}),
          note: `over-cap ${ok ? 'adjudicated by gate' : 'write failed'} seam=${seam}`,
        });
      } catch (err: any) {
        out.errors += 1;
        logger.warn(`strike-adjudication: gate write failed for ${it.row.id.slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
      }
      return;
    }
    recordDecisionOutcome(decision, 'guard_strike', {
      question: GUARD_STRIKE_GATE_QUESTION, actual: null, acted: false,
      ...(it.row.sessionId ? { sessionId: it.row.sessionId } : {}),
      note: `over-cap: below threshold or unclear (${choice ?? 'none'} ${confidenceOf(a).toFixed(2)}) seam=${seam}`,
    });
  };
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < queue.length) {
      const it = queue[cursor++];
      try { await runOne(it); } catch { out.errors += 1; }
    }
  }));
  return out;
}

// ── The nightly job ───────────────────────────────────────────────────────────

interface StrikeRow {
  id: string;
  runId: string | null;
  sessionId: string | null;
  createdAt: Date;
  meta: any;
}

/**
 * One adjudication pass. Returns a one-line summary (the worker logs it; the
 * cron row's lastStatus stays the loop's own 'ok'). Never throws — every
 * failure degrades to "fewer rows adjudicated tonight".
 */
export async function runStrikeAdjudicationOnce(opts?: { now?: Date }): Promise<string> {
  try {
    if (process.env.STRIKE_ADJUDICATION_DISABLED === '1') return 'disabled (STRIKE_ADJUDICATION_DISABLED=1)';
    const now = opts?.now ?? new Date();
    const rows: StrikeRow[] = await prisma.loopMetric.findMany({
      where: { kind: 'guard_strike', createdAt: { gte: new Date(now.getTime() - ADJUDICATION_LOOKBACK_MS) } },
      orderBy: { createdAt: 'desc' },
      take: ADJUDICATION_FETCH_CAP,
      select: { id: true, runId: true, sessionId: true, createdAt: true, meta: true },
    });

    // G17 substitute metric — over EVERY fetched row (adjudicated or not).
    const fabricationCount = rows.filter((r) => isFabricationClassStrike(r.meta)).length;

    // Observe-only telemetry seams never enter either pass (ADJUDICATION_SKIPPED_SEAMS).
    const skipped = rows.filter((r) => ADJUDICATION_SKIPPED_SEAMS.has(String((r.meta as any)?.seam ?? ''))).length;
    const pending = rows.filter((r) => !(r.meta as any)?.adjudication && !ADJUDICATION_SKIPPED_SEAMS.has(String((r.meta as any)?.seam ?? '')));

    // Batch the later-clean-finalize lookup: guard_miss rows for the involved runs.
    const runIds = [...new Set(pending.map((r) => r.runId).filter(Boolean) as string[])];
    const lastMissByRun = new Map<string, number>();
    if (runIds.length) {
      const misses = await prisma.loopMetric.findMany({
        where: { kind: 'guard_miss', runId: { in: runIds } },
        select: { runId: true, createdAt: true },
      });
      for (const m of misses ?? []) {
        if (!m.runId) continue;
        const t = m.createdAt.getTime();
        if (t > (lastMissByRun.get(m.runId) ?? 0)) lastMissByRun.set(m.runId, t);
      }
    }

    // Pass 1 — deterministic.
    let detTp = 0;
    let detFp = 0;
    let writeFailures = 0;
    const ambiguous: StrikeRow[] = [];
    // Decision gate (N1): tonight's labels, in the order they were produced.
    // The gate runs AFTER both passes; the label never enters the state.
    const gateItems: StrikeGateItem[] = [];
    const laterClean = (r: StrikeRow): boolean => !!(r.runId && (lastMissByRun.get(r.runId) ?? 0) > r.createdAt.getTime());
    for (const r of pending) {
      const meta = r.meta ?? {};
      const verdict = classifyStrikeDeterministic({
        seam: typeof meta.seam === 'string' ? meta.seam : '',
        citationRetry: typeof meta.citationRetry === 'string' ? meta.citationRetry : undefined,
        hasFindingKinds: Array.isArray(meta.kinds) && meta.kinds.length > 0,
        laterCleanFinalize: laterClean(r),
      });
      if (!verdict) {
        ambiguous.push(r);
        continue;
      }
      try {
        await adjudicateStrike(r.id, verdict);
        if (verdict === 'true_positive') detTp += 1;
        else detFp += 1;
        gateItems.push({ row: r, verdict, source: 'deterministic', facts: { laterCleanFinalize: laterClean(r) } });
      } catch (err: any) {
        writeFailures += 1;
        logger.warn(`strike-adjudication: write failed for ${r.id.slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
      }
    }

    // Pass 2 — ONE bounded utilityChat batch for the ambiguous remainder.
    const batch = ambiguous.slice(0, ADJUDICATION_LLM_CAP);
    const overCap = ambiguous.length - batch.length;
    let llmTp = 0;
    let llmFp = 0;
    let llmUnclear = 0;
    // The gate's run-context lookups ride the batch's own queries: the batch
    // rows + (ACT only) the over-cap remainder up to the nightly cap.
    const gateMode = decisionMode('guard_strike');
    const overCapForGate: StrikeRow[] = gateMode === 'act' ? ambiguous.slice(ADJUDICATION_LLM_CAP, ADJUDICATION_LLM_CAP + guardStrikeGateCap()) : [];
    let journalByRun = new Map<string, any>();
    let statusByRun = new Map<string, any>();
    if (batch.length || overCapForGate.length) {
      try {
        const batchRunIds = [...new Set([...batch, ...overCapForGate].map((b) => b.runId).filter(Boolean) as string[])];
        const [journals, runRows] = await Promise.all([
          batchRunIds.length
            ? prisma.runJournalEntry.findMany({
                where: { runId: { in: batchRunIds } },
                select: { runId: true, goal: true, outcome: true, failures: true },
              })
            : Promise.resolve([] as any[]),
          batchRunIds.length
            ? prisma.agentRun.findMany({
                where: { id: { in: batchRunIds } },
                select: { id: true, status: true },
              })
            : Promise.resolve([] as any[]),
        ]);
        journalByRun = new Map((journals ?? []).map((j: any) => [j.runId, j]));
        statusByRun = new Map((runRows ?? []).map((r: any) => [r.id, r.status]));
      } catch (err: any) {
        logger.warn(`strike-adjudication: run-context lookup failed (batch runs without journals): ${err?.message ?? err}`);
      }
    }
    if (batch.length) {
      try {
        const lines = batch.map((r, idx) => {
          const meta = r.meta ?? {};
          const j: any = r.runId ? journalByRun.get(r.runId) : undefined;
          const status = r.runId ? statusByRun.get(r.runId) : undefined;
          const facts = [
            `seam=${meta.seam || 'finalize'}`,
            Array.isArray(meta.kinds) && meta.kinds.length ? `findings=${meta.kinds.slice(0, 6).join(',')}` : '',
            meta.outcome ? `outcome=${meta.outcome}` : '',
            meta.citationRetry ? `citationRetry=${meta.citationRetry}` : '',
            status ? `runStatus=${status}` : '',
          ].filter(Boolean).join(' ');
          const journal = j
            ? ` | journal: goal="${String(j.goal ?? '').slice(0, 160)}" outcome="${String(j.outcome ?? '').slice(0, 240)}"${Array.isArray(j.failures) && j.failures.length ? ` failures="${j.failures.slice(0, 2).join('; ').slice(0, 160)}"` : ''}`
            : '';
          return `${idx + 1}. ${facts}${journal}`;
        });
        const prompt = `You audit an autonomous coding fleet's guard strikes. A "strike" means a harness guard flagged a model run (an unevidenced/fabricated completion claim, an unverified number, a phantom citation, ...). For EACH strike below, judge from its metadata and the run's journal whether the guard was RIGHT:
- "true_positive": the model really made an unevidenced or fabricated claim (or genuinely derailed).
- "false_positive": the flagged output was legitimate and evidenced — the guard misfired.
- "unclear": the evidence given cannot settle it.

Strikes:
${lines.join('\n')}

Return ONLY a JSON array, one entry per strike, no prose:
[{"i": 1, "v": "true_positive"}, {"i": 2, "v": "unclear"}, ...]`;
        const raw = await utilityChat([{ role: 'user', content: prompt }], {
          maxTokens: 1200, temperature: 0, timeout: 60_000, retryNotFound: true,
        });
        const verdicts = parseAdjudicationVerdicts(raw, batch.length);
        for (const [i, v] of verdicts) {
          const row = batch[i - 1];
          try {
            await adjudicateStrike(row.id, v);
            if (v === 'true_positive') llmTp += 1;
            else if (v === 'false_positive') llmFp += 1;
            else llmUnclear += 1;
            gateItems.push({
              row, verdict: v, source: 'llm',
              facts: { runStatus: row.runId ? statusByRun.get(row.runId) : undefined, journal: row.runId ? journalByRun.get(row.runId) : undefined, laterCleanFinalize: laterClean(row) },
            });
          } catch (err: any) {
            writeFailures += 1;
            logger.warn(`strike-adjudication: llm write failed for ${row.id.slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
          }
        }
      } catch (err: any) {
        logger.warn(`strike-adjudication: llm batch failed (rows stay for the next night): ${err?.message ?? err}`);
      }
    }

    // Pass 3 — the decision gate (N1): shadow-judge tonight's labelled strikes
    // (agreement = the calibration signal); in ACT mode also adjudicate the
    // over-cap remainder. Isolated: a gate failure never changes the summary's
    // adjudication numbers.
    let gate: StrikeGateSummary = { mode: gateMode, asked: 0, labelled: 0, agreed: 0, wrote: 0, errors: 0 };
    if (gateMode !== 'off') {
      try {
        for (const row of overCapForGate) {
          gateItems.push({
            row, verdict: null, source: 'none',
            facts: { runStatus: row.runId ? statusByRun.get(row.runId) : undefined, journal: row.runId ? journalByRun.get(row.runId) : undefined, laterCleanFinalize: laterClean(row) },
          });
        }
        gate = await gateStrikes(gateItems, { mode: gateMode });
      } catch (err: any) {
        logger.warn(`strike-adjudication: decision gate pass failed open (adjudication unchanged): ${err?.message ?? err}`);
      }
    }

    const det = detTp + detFp;
    const llm = llmTp + llmFp + llmUnclear;
    const summary =
      `adjudicated ${det + llm}/${pending.length} strikes ` +
      `(deterministic ${det}: tp ${detTp}, fp ${detFp}; llm ${llm}/${batch.length}: tp ${llmTp}, fp ${llmFp}, unclear ${llmUnclear})` +
      `${overCap > 0 ? `; ${overCap} ambiguous over the ${ADJUDICATION_LLM_CAP}/night cap` : ''}` +
      `${writeFailures ? `; ${writeFailures} write failure(s)` : ''}` +
      `${skipped ? `; ${skipped} observe-only row(s) skipped` : ''}` +
      `${gateMode !== 'off' ? `; decision gate (${gate.mode}): asked ${gate.asked}, agreed ${gate.agreed}/${gate.labelled} labelled${gate.wrote ? `, wrote ${gate.wrote} over-cap` : ''}${gate.errors ? `, ${gate.errors} error(s)` : ''}` : ''}` +
      `; fabrication-class strikes 24h: ${fabricationCount} (G17 commit-subject substitute)`;
    logger.info(`strike-adjudication: ${summary}`);
    return summary;
  } catch (err: any) {
    const msg = `pass failed (non-fatal): ${err?.message ?? err}`;
    try { logger.warn(`strike-adjudication: ${msg}`); } catch { /* never throws */ }
    return msg;
  }
}

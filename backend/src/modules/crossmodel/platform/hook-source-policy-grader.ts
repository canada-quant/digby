import type {
  HookSourceDecision,
  HookSourcePolicyDecision,
  SuppressionLaterLabel,
  SuppressionVerdict,
} from './hook-source-policy';
import { attributeSuppression, canonicalBatchKey, suppressionPrecision } from './hook-source-policy';

/**
 * SAA-1.1 GATE TOOLING — THE BATCH-DEDUPLICATING SUPPRESSION GRADER (todo 347e1fca).
 *
 * WHY THIS EXISTS. `attributeSuppression()` and `suppressionPrecision()` had no
 * production caller: every gate read joined `hook_source_policy_observe` ids to
 * `wakeActed()` BY HAND. That is both unscalable and — as the 2026-11-02T22:50Z
 * read discovered — WRONG BY A LARGE FACTOR, because the emitted rows are not
 * one-per-batch.
 *
 * THE DEFECT THIS DEDUPES. The policy block
 * (`hooks.service.ts`, immediately before `decisionMode('wake_triage')`) runs
 * BEFORE the busy-park/triage handling. `parkAlarmRows`' plain path leaves the
 * row `status:'pending'` with NO `retryAt` (attempts deliberately not
 * incremented), so every sweep re-claims and re-admits the SAME batch and
 * writes a FRESH observe row for it. Measured on the live emitter: one
 * single-row batch (hook `83b3cd9d`, ids `["5c198d8c"]`) was admitted 33 times
 * in ~5 minutes; 56 rows in the 22:00Z bucket resolved to 7 batches.
 *
 * Consequence, and the reason this module refuses to count rows: joining raw
 * rows to `wakeActed()` attributes ONE batch to MANY finalising runs, which
 * inflates `would_hold` AND `would_lose` — and because a re-admitted batch is
 * usually re-admitted into a quiet fleet, the inflation lands on the
 * flattering side. Precision computed over rows is not a measurement.
 *
 * THE BATCH KEY IS (hookId, ids). `ids` is the emitted join key — the batch's
 * first 3 row ids, 8 chars each (`hookSourcePolicyMetricMeta`), never a count.
 * Two admissions carrying the same key are the SAME batch.
 */

/** The subset of an emitted `hook_source_policy_observe` row this grader reads. */
export interface ObserveRowLike {
  /** Row creation time — Date from Prisma, string from JSON. */
  createdAt: Date | string;
  /** The target chat the wake would have gone to (loop_metrics.sessionId). */
  sessionId?: string | null;
  meta?: {
    hookId?: unknown;
    decision?: unknown;
    reason?: unknown;
    rows?: unknown;
    sources?: unknown;
    ids?: unknown;
    kinds?: unknown;
  } | null;
}

/** One DISTINCT batch, with every admission of it collapsed. */
export interface PolicyBatch {
  /** The batch key: (hookId, ids). */
  key: string;
  hookId: string;
  ids: string[];
  decision: HookSourceDecision;
  reason: string;
  /** Events the batch carried — the LARGEST count seen across admissions (a
   *  re-admission can see a grown batch; the max is the batch at its fullest). */
  rows: number;
  sources: number;
  /** How many observe rows this ONE batch produced (the duplicate factor). */
  admissions: number;
  firstSeen: number;
  lastSeen: number;
  /** The chat the wake targeted (last non-empty seen). */
  targetChatId: string | null;
}

/** The verdict for one batch, plus the material needed to audit it. */
export interface GradedBatch {
  batch: PolicyBatch;
  verdict: SuppressionVerdict;
  /** The label the caller resolved, or null when it could not resolve one. */
  label: SuppressionLaterLabel | null;
}

export interface SuppressionGrade {
  /** Emitted observe rows examined. */
  rows: number;
  /** Distinct batches after dedupe — the ONLY legitimate denominator. */
  batches: number;
  /** rows / batches; null when there are no batches (never 0, never Infinity). */
  duplicateFactor: number | null;
  /** Batches the policy would have SUPPRESSED (decision 'ignore'). */
  wouldSuppress: number;
  /** Of those: the wake did not act (suppression would have been correct). */
  wouldHold: number;
  /** Of those: the wake acted (suppression would have been WRONG). */
  wouldLose: number;
  /** Of those: no run/label could be resolved — proves nothing either way. */
  unresolved: number;
  /**
   * wouldHold / (wouldHold + wouldLose). NULL when nothing resolved — never 1.0
   * and never 0. Never computed over `rows`.
   */
  precision: number | null;
  /** Every graded would-suppress batch, in first-seen order. */
  graded: GradedBatch[];
  /** Rows that could not be keyed (no hookId or no ids) and were NOT counted
   *  as batches. Reported so a shortfall is visible rather than implied. */
  droppedRows?: number;
}

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v ?? '')).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function idsOf(meta: ObserveRowLike['meta']): string[] {
  const raw = meta?.ids;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
}

function numOf(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The batch key. `ids` is order-insensitive for identity: the same batch
 * re-admitted can surface its ids in a different order once it grows.
 *
 * DELEGATES to `canonicalBatchKey` — the stamp side's function — instead of
 * re-implementing the `${hookId}|${ids}` shape here. Two hand-kept-in-sync
 * copies is how this join broke twice already (arrival-order vs sorted, then
 * truncation vs no truncation). One function, called by both sides, is the only
 * version of this that cannot drift.
 */
export function batchKeyOf(hookId: unknown, ids: readonly string[]): string {
  return canonicalBatchKey(hookId, ids);
}

/**
 * Collapse emitted observe rows into DISTINCT batches.
 *
 * A row missing hookId or ids cannot be keyed and is DROPPED rather than
 * counted as its own batch — silently inventing a batch from an unkeyable row
 * is exactly the row-counting error this module exists to prevent. `dropped`
 * reports how many, so the shortfall is visible instead of implied.
 */
export function dedupePolicyBatches(rows: readonly ObserveRowLike[]): { batches: PolicyBatch[]; dropped: number } {
  const byKey = new Map<string, PolicyBatch>();
  let dropped = 0;

  for (const r of rows) {
    const meta = r?.meta ?? null;
    const hookId = String((meta as any)?.hookId ?? '').trim();
    const ids = idsOf(meta);
    if (!hookId || !ids.length) { dropped += 1; continue; }

    const key = batchKeyOf(hookId, ids);
    const at = toMs(r?.createdAt);
    const decisionRaw = String((meta as any)?.decision ?? '');
    const decision: HookSourceDecision =
      decisionRaw === 'ignore' || decisionRaw === 'respond' || decisionRaw === 'candidate' ? decisionRaw : 'candidate';
    const reason = String((meta as any)?.reason ?? 'unclassified');
    const rowsN = numOf((meta as any)?.rows, ids.length);
    const sources = numOf((meta as any)?.sources, 0);
    const chat = typeof r?.sessionId === 'string' && r.sessionId ? r.sessionId : null;

    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        key, hookId, ids, decision, reason,
        rows: rowsN, sources, admissions: 1,
        firstSeen: Number.isFinite(at) ? at : 0,
        lastSeen: Number.isFinite(at) ? at : 0,
        targetChatId: chat,
      });
    } else {
      prev.admissions += 1;
      // The batch at its fullest: a re-admission may carry more events.
      prev.rows = Math.max(prev.rows, rowsN);
      prev.sources = Math.max(prev.sources, sources);
      if (Number.isFinite(at)) {
        prev.firstSeen = Math.min(prev.firstSeen, at);
        prev.lastSeen = Math.max(prev.lastSeen, at);
      }
      if (chat) prev.targetChatId = chat;
      // A batch that was EVER refused (respond) must not be graded as a
      // would-suppress batch just because a later admission saw a quieter
      // slice of it: suppression is a claim about the batch, and the strongest
      // signal on the path is the most conservative one.
      if (prev.decision === 'candidate' && decision !== 'candidate') prev.decision = decision;
      else if (prev.decision === 'ignore' && decision === 'respond') prev.decision = 'respond';
    }
  }

  const batches = [...byKey.values()].sort((a, b) => a.firstSeen - b.firstSeen);
  return { batches, dropped };
}

/**
 * Grade a window: dedupe to batches, then apply the caller's label resolver to
 * each batch the policy would have SUPPRESSED. The resolver returns null when
 * it cannot join the batch to a finalising run (→ `unresolved`, excluded).
 *
 * ONLY 'ignore' batches are graded. A `respond` batch is not a suppression
 * claim, so counting it would pad the denominator with batches on which the
 * policy never expressed an opinion.
 */
export function gradeSuppression(
  rows: readonly ObserveRowLike[],
  resolveLabel: (batch: PolicyBatch) => SuppressionLaterLabel | null,
): SuppressionGrade {
  const { batches, dropped } = dedupePolicyBatches(rows);
  const wouldSuppressBatches = batches.filter((b) => b.decision === 'ignore');

  const graded: GradedBatch[] = [];
  for (const batch of wouldSuppressBatches) {
    let label: SuppressionLaterLabel | null = null;
    try { label = resolveLabel(batch) ?? null; } catch { label = null; }
    graded.push({ batch, verdict: attributeSuppression(label), label });
  }

  const verdicts = graded.map((g) => g.verdict);
  return {
    rows: rows.length,
    batches: batches.length,
    duplicateFactor: batches.length ? rows.length / batches.length : null,
    wouldSuppress: wouldSuppressBatches.length,
    wouldHold: verdicts.filter((v) => v === 'would_hold').length,
    wouldLose: verdicts.filter((v) => v === 'would_lose').length,
    unresolved: verdicts.filter((v) => v === 'unresolved').length,
    precision: suppressionPrecision(verdicts),
    graded,
    ...(dropped ? { droppedRows: dropped } : {}),
  };
}

/** Operators-facing one-liner. Never prints a precision it does not have. */
export function gradeSummary(g: SuppressionGrade): string {
  const df = g.duplicateFactor === null ? 'n/a' : g.duplicateFactor.toFixed(2);
  const p = g.precision === null ? 'null (nothing resolved)' : g.precision.toFixed(3);
  return `${g.rows} rows -> ${g.batches} batches (dup x${df}); would-suppress ${g.wouldSuppress}; ` +
    `would_hold ${g.wouldHold} / would_lose ${g.wouldLose} / unresolved ${g.unresolved}; precision ${p}`;
}

/** The batch's policy decision, re-derived from a replayed batch (see below). */
export interface ReplayBatchInput {
  hookId: string;
  targetChatId: string | null;
  rows: ReadonlyArray<{ id?: unknown; eventType?: unknown; payload?: unknown; createdAt?: unknown }>;
  /** Replay at BATCH TIME so staleness is measured as it was at admission. */
  at: number;
}

/**
 * RE-ASSEMBLE RECORDED EVENTS INTO BATCHES for a replay.
 *
 * The daemon's real grouping (window drain + sibling drain, bounded by
 * SIBLING_DRAIN_CAP) is not recorded anywhere, so a replay over `hook_events`
 * must reconstruct it. This uses the ONLY signal the rows carry: arrival order
 * and time. Consecutive rows of ONE hook closer together than `gapMs` are one
 * sweep and therefore one batch. That is an ASSUMPTION, and a replay built on
 * it must SAY SO — it is a reconstruction of the grouping, never the grouping
 * itself. Where recorded observe rows exist, prefer them: they ARE the real
 * grouping.
 */
export function reassembleBatches(
  rows: ReadonlyArray<{ hookId: string; targetChatId: string | null; id?: unknown; eventType?: unknown; payload?: unknown; createdAt?: unknown }>,
  gapMs: number,
): ReplayBatchInput[] {
  const sorted = [...rows].sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
  // Mutable accumulator — ReplayBatchInput.rows is readonly to CALLERS, but the
  // grouping still has to append while it walks the window.
  const out: Array<ReplayBatchInput & { rows: ReplayBatchInput['rows'][number][] }> = [];
  let cur: (ReplayBatchInput & { rows: ReplayBatchInput['rows'][number][] }) | null = null;
  let lastHook = '';
  let lastAt = NaN;

  for (const r of sorted) {
    const at = toMs(r.createdAt);
    const sameSweep = cur !== null && r.hookId === lastHook && Number.isFinite(at) && Number.isFinite(lastAt) && at - lastAt <= gapMs;
    if (!sameSweep) {
      cur = { hookId: r.hookId, targetChatId: r.targetChatId, rows: [], at };
      out.push(cur);
    }
    cur!.rows.push({ id: r.id, eventType: r.eventType, payload: r.payload, createdAt: r.createdAt });
    cur!.at = at; // the batch is stamped at its LAST admission
    lastHook = r.hookId;
    lastAt = at;
  }
  return out;
}

/** Narrow an ObserveRow-like set to the shape gradSuppression wants. */
export function observeRowsFromMetrics(
  rows: ReadonlyArray<{ createdAt: Date | string; sessionId?: string | null; meta?: unknown }>,
): ObserveRowLike[] {
  return rows.map((r) => ({ createdAt: r.createdAt, sessionId: r.sessionId ?? null, meta: (r.meta ?? null) as ObserveRowLike['meta'] }));
}

/** Re-exported so a caller needs ONE import for the whole gate read. */
export type { HookSourcePolicyDecision, SuppressionLaterLabel, SuppressionVerdict };

/**
 * THE DURABLE-KEY JOIN (todo 03bcf00f) — replaces the temporal heuristic.
 *
 * Before Phase 1a, a batch could only be tied to the run that finalised it by
 * guessing inside a time window, because the label side carried no batch
 * identity. Measured on 2026-11-03: that resolved 4 of 1,909 would-suppress
 * batches (0.21%) — the join, not the traffic, was the binding constraint.
 *
 * Phase 1a stamps ONE string (`hookBatchKey(hookId, ids)`) on both sides:
 *   - `wake_delivered` metric meta → the delivery
 *   - the wake_triage decision stash `extra` → the run-outcome row `meta`
 * so this index is exact: key === key, no window, no proximity, no borrowing
 * a neighbour's label.
 *
 * LIMITS, stated because they bound what the number means:
 *  - Rows emitted BEFORE Phase 1a carry no key and can NEVER join here. They
 *    are not backfilled: there is no deterministic lossless mapping from a
 *    historical outcome row back to its batch (the ids were never written), and
 *    inventing one would be exactly the fabrication the label exists to
 *    prevent. A replay over pre-instrumentation data therefore reports near-zero
 *    coverage — that is the honest answer, not a regression.
 *  - A batch whose wake never produced a run has no label row, so it stays
 *    `unresolved` forever. That population is proof of nothing either way.
 */
export function buildDurableLabelIndex(
  labelRows: ReadonlyArray<{ createdAt?: Date | string; meta?: unknown }>,
): Map<string, SuppressionLaterLabel> {
  const out = new Map<string, SuppressionLaterLabel>();
  for (const r of labelRows) {
    const m = (r?.meta ?? null) as Record<string, unknown> | null;
    if (!m || typeof m !== 'object') continue;
    const key = typeof m.hookBatch === 'string' ? m.hookBatch.trim() : '';
    if (!key) continue;
    // `delivered` defaults TRUE for a row that exists: the row is only written
    // when a run finalised, so its existence IS the delivery. An explicit
    // delivered:false is honoured (a caller may stamp it to withhold the label).
    const delivered = m.delivered === false ? false : true;
    // WHICH FIELD IS THE VERDICT — `actual`, never `acted`.
    // In labelOneMachineRunOutcome (decision-outcome-labels.ts) the two mean
    // DIFFERENT things: `actual` is `deriveMachineRunActual(...)` = wakeActed()
    // for wake_triage — the harness's own later label, which is exactly what
    // attributeSuppression consumes — while `acted` is merely `run.acted === true`,
    // a weaker, different fact (that is the W6-3 distinction the harness label
    // exists to draw). Preferring `acted` inverted the verdict on the PARK path:
    // a parked batch writes { actual: null, acted: true } (hooks.service.ts), so
    // an `acted`-first read would have scored every park as would_lose — the exact
    // direction that inflates a policy's failure and suppresses nothing wrongly.
    let acted: boolean | null = null;
    if (typeof m.actual === 'boolean') acted = m.actual;
    else if (typeof m.actual === 'string') {
      if (m.actual === 'true') acted = true;
      else if (m.actual === 'false') acted = false;
      // Any other vocabulary (a choice label, 'act_now', …) is NOT a
      // needs-turn-now boolean: leave it unreadable rather than coerce it.
    }
    // No verdict on this row (park, failed run, foreign question): skip it. A
    // later row for the same batch — the one written when the parked batch
    // finally rode a wake — supplies the real label, because skipped rows do not
    // claim the key.
    if (acted === null) {
      if (!delivered) out.set(key, { delivered: false, acted: false });
      continue;
    }
    // A later row for the same batch must not overwrite an earlier verdict with
    // a weaker one: first-wins keeps the index deterministic.
    if (!out.has(key)) out.set(key, { delivered, acted });
  }
  return out;
}

/**
 * Grade a window using the DURABLE key. Same arithmetic and the same hard rules
 * as `gradeSuppression` (null precision when nothing resolves, only 'ignore'
 * batches graded, each batch one vote) — the only difference is that the label
 * comes from an exact key lookup instead of a caller-supplied heuristic.
 */
export function gradeSuppressionByKey(
  rows: readonly ObserveRowLike[],
  labelIndex: ReadonlyMap<string, SuppressionLaterLabel>,
): SuppressionGrade {
  return gradeSuppression(rows, (batch) => labelIndex.get(batch.key) ?? null);
}
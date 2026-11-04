/**
 * Decision-gate spend READ side (2026-09-28, owner: "add jev to api costs").
 *
 * Feeds two admin surfaces from loop_metrics:
 *   - Account → Admin → API costs — the "Decision gate" block: calls, input
 *     tokens, USD per backend and per purpose, p50 latency, and a "what it
 *     replaced" ESTIMATE for the act purposes that remove work;
 *   - GET /admin/model-roles/decision-registry — `calls24h` / `costUsd24h` per
 *     purpose next to the mode.
 *
 * Sources (all in the requested window):
 *   - `decision_gate` rows, phase 'decision', ok, NOT memo hits → calls, input
 *     tokens the backend reported (meta.inputTokens), p50 of `value` (ms);
 *   - `run_spend` rows with meta.profile = 'decision' (decision-gate-pricing.ts
 *     write side + the backfill) → USD and how many calls are PRICED (the gap
 *     between calls and priced calls is the un-backfilled history — the panel
 *     says so instead of showing a smaller number silently);
 *   - the avoided-work rows the act consumers mint: `wake_parked` reason
 *     'triage' (wake_triage), `schedule_sweep_skip` (sweep_triage),
 *     `wake_parked` reason 'turn_noop' (supervisor_turn_noop) × the mean
 *     run_spend of the same kind of run in the window (triggerKind hook /
 *     schedule) — labelled an estimate, never a saving claim.
 *
 * The SQL is thin; `composeDecisionSpendSummary` is pure and tested.
 */
import logger from '../../../utils/logger';

/** Prisma is loaded at CALL time (never at import): the admin controllers import this module and their unit
 *  suites boot no database — the same lazy pattern decision-gate.ts uses for the registry lookup. */
async function db(): Promise<any> {
  const mod = await import('../../../config/database');
  return (mod as any).default ?? mod;
}
import { DECISION_SPEND_PROFILE, DECISION_GATE_SYNTHETIC_SESSION, typesafePrice, TYPESAFE_PRICE_SOURCE_URL, TYPESAFE_PRICE_ENV_IN, TYPESAFE_PRICE_ENV_OUT } from './decision-gate-pricing';

export interface DecisionCallAgg {
  key: string;
  calls: number;
  inputTokens: number;
  p50Ms: number | null;
}
export interface DecisionSpendAgg {
  key: string;
  pricedCalls: number;
  usd: number;
  inTokens: number;
  /** The price source the rows carried (last seen) — 'list' | 'env' | 'registry' | 'self_hosted' | 'unpriced'. */
  priceSource: string | null;
  unpriced: boolean;
  model: string | null;
}
export interface AvoidedRow {
  purpose: 'wake_triage' | 'sweep_triage' | 'supervisor_turn_noop';
  avoided: number;
}
export interface RunMeanRow {
  triggerKind: string;
  meanUsd: number | null;
  runs: number;
}

export interface DecisionSpendBackendRow {
  backend: string;
  model: string | null;
  calls: number;
  pricedCalls: number;
  inputTokens: number;
  usd: number;
  p50Ms: number | null;
  priceSource: string | null;
  unpriced: boolean;
}
export interface DecisionSpendPurposeRow {
  purpose: string;
  calls: number;
  pricedCalls: number;
  inputTokens: number;
  usd: number;
  p50Ms: number | null;
}
export interface DecisionReplacedRow {
  purpose: string;
  /** What one avoided unit is ('parked hook wake', 'skipped sweep firing', 'skipped supervisor turn'). */
  unit: string;
  avoided: number;
  /** Mean run_spend of the run kind it stands in for (null = no such runs in the window). */
  meanRunUsd: number | null;
  runsSampled: number;
  /** avoided × meanRunUsd — an ESTIMATE (labelled so in the panel). */
  estimateUsd: number | null;
  basis: string;
}
export interface DecisionSpendSummary {
  windowDays: number;
  since: string;
  totals: { calls: number; pricedCalls: number; memoHits: number; inputTokens: number; usd: number };
  byBackend: DecisionSpendBackendRow[];
  byPurpose: DecisionSpendPurposeRow[];
  replaced: DecisionReplacedRow[];
  pricing: {
    typesafe: { usdPerMTokIn: number; usdPerMTokOut: number; source: string; note: string; url: string };
    envIn: string;
    envOut: string;
  };
}

/** The avoided-work purposes and the run kind whose mean cost stands in for one avoided unit. */
export const REPLACED_BASIS: Record<AvoidedRow['purpose'], { unit: string; triggerKind: string; basis: string }> = {
  wake_triage: { unit: 'parked hook wake', triggerKind: 'hook', basis: 'wake_parked reason=triage × mean run_spend of hook-triggered runs in the window' },
  sweep_triage: { unit: 'skipped sweep firing', triggerKind: 'schedule', basis: 'schedule_sweep_skip × mean run_spend of schedule-triggered runs in the window' },
  supervisor_turn_noop: { unit: 'skipped supervisor turn', triggerKind: 'schedule', basis: 'wake_parked reason=turn_noop × mean run_spend of schedule-triggered runs in the window' },
};

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Pure: join the per-key aggregates into the panel shape. Exported for the tests. */
export function composeDecisionSpendSummary(input: {
  windowDays: number;
  since: Date;
  callsByBackend: DecisionCallAgg[];
  callsByPurpose: DecisionCallAgg[];
  spendByBackend: DecisionSpendAgg[];
  spendByPurpose: DecisionSpendAgg[];
  memoHits: number;
  avoided: AvoidedRow[];
  runMeans: RunMeanRow[];
}): DecisionSpendSummary {
  const spendB = new Map(input.spendByBackend.map(r => [r.key, r]));
  const spendP = new Map(input.spendByPurpose.map(r => [r.key, r]));
  const callB = new Map(input.callsByBackend.map(r => [r.key, r]));
  const callP = new Map(input.callsByPurpose.map(r => [r.key, r]));
  const backendKeys = [...new Set([...callB.keys(), ...spendB.keys()])];
  const purposeKeys = [...new Set([...callP.keys(), ...spendP.keys()])];
  const byBackend: DecisionSpendBackendRow[] = backendKeys.map(k => {
    const c = callB.get(k); const s = spendB.get(k);
    return {
      backend: k,
      model: s?.model ?? null,
      calls: c?.calls ?? 0,
      pricedCalls: s?.pricedCalls ?? 0,
      inputTokens: Math.max(c?.inputTokens ?? 0, s?.inTokens ?? 0),
      usd: round4(s?.usd ?? 0),
      p50Ms: c?.p50Ms ?? null,
      priceSource: s?.priceSource ?? null,
      unpriced: s?.unpriced ?? false,
    };
  }).sort((a, b) => b.calls - a.calls);
  const byPurpose: DecisionSpendPurposeRow[] = purposeKeys.map(k => {
    const c = callP.get(k); const s = spendP.get(k);
    return {
      purpose: k,
      calls: c?.calls ?? 0,
      pricedCalls: s?.pricedCalls ?? 0,
      inputTokens: Math.max(c?.inputTokens ?? 0, s?.inTokens ?? 0),
      usd: round4(s?.usd ?? 0),
      p50Ms: c?.p50Ms ?? null,
    };
  }).sort((a, b) => b.calls - a.calls);
  const means = new Map(input.runMeans.map(r => [r.triggerKind, r]));
  const replaced: DecisionReplacedRow[] = input.avoided
    .filter(a => a.avoided > 0 && REPLACED_BASIS[a.purpose])
    .map(a => {
      const basis = REPLACED_BASIS[a.purpose];
      const m = means.get(basis.triggerKind);
      const meanRunUsd = m && typeof m.meanUsd === 'number' && Number.isFinite(m.meanUsd) ? round4(m.meanUsd) : null;
      return {
        purpose: a.purpose,
        unit: basis.unit,
        avoided: a.avoided,
        meanRunUsd,
        runsSampled: m?.runs ?? 0,
        estimateUsd: meanRunUsd === null ? null : round4(a.avoided * meanRunUsd),
        basis: basis.basis,
      };
    });
  const totals = {
    calls: byBackend.reduce((s, r) => s + r.calls, 0),
    pricedCalls: byBackend.reduce((s, r) => s + r.pricedCalls, 0),
    memoHits: input.memoHits,
    inputTokens: byPurpose.reduce((s, r) => s + r.inputTokens, 0),
    usd: round4(byBackend.reduce((s, r) => s + r.usd, 0)),
  };
  const ts = typesafePrice();
  return {
    windowDays: input.windowDays,
    since: input.since.toISOString(),
    totals,
    byBackend,
    byPurpose,
    replaced,
    pricing: {
      typesafe: { usdPerMTokIn: ts.in, usdPerMTokOut: ts.out, source: ts.source, note: ts.note, url: TYPESAFE_PRICE_SOURCE_URL },
      envIn: TYPESAFE_PRICE_ENV_IN,
      envOut: TYPESAFE_PRICE_ENV_OUT,
    },
  };
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** The window's summary from loop_metrics. Never throws — a DB error yields an empty summary (the panel still renders). */
export async function decisionSpendSummary(opts: { since: Date; windowDays: number }): Promise<DecisionSpendSummary> {
  const { since, windowDays } = opts;
  const empty = () => composeDecisionSpendSummary({ windowDays, since, callsByBackend: [], callsByPurpose: [], spendByBackend: [], spendByPurpose: [], memoHits: 0, avoided: [], runMeans: [] });
  try {
    const prisma = await db();
    const [callsB, callsP, memo, spendB, spendP, avoidedRows, means] = await Promise.all([
      prisma.$queryRaw<Array<{ key: string | null; calls: number | bigint; input_tokens: number | null; p50: number | null }>>`
        SELECT COALESCE(lm."meta"->>'backend', '?') AS key, COUNT(*)::int AS calls,
               SUM(COALESCE((lm."meta"->>'inputTokens')::float, 0))::float AS input_tokens,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY lm."value")::float AS p50
        FROM "loop_metrics" lm
        WHERE lm."kind" = 'decision_gate' AND lm."createdAt" >= ${since}
          AND lm."meta"->>'phase' = 'decision' AND lm."meta"->>'ok' = 'true' AND (lm."meta"->>'cached') IS NULL
        GROUP BY 1`,
      prisma.$queryRaw<Array<{ key: string | null; calls: number | bigint; input_tokens: number | null; p50: number | null }>>`
        SELECT COALESCE(lm."meta"->>'purpose', '?') AS key, COUNT(*)::int AS calls,
               SUM(COALESCE((lm."meta"->>'inputTokens')::float, 0))::float AS input_tokens,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY lm."value")::float AS p50
        FROM "loop_metrics" lm
        WHERE lm."kind" = 'decision_gate' AND lm."createdAt" >= ${since}
          AND lm."meta"->>'phase' = 'decision' AND lm."meta"->>'ok' = 'true' AND (lm."meta"->>'cached') IS NULL
        GROUP BY 1`,
      prisma.$queryRaw<Array<{ n: number | bigint }>>`
        SELECT COUNT(*)::int AS n FROM "loop_metrics" lm
        WHERE lm."kind" = 'decision_gate' AND lm."createdAt" >= ${since}
          AND lm."meta"->>'phase' = 'decision' AND lm."meta"->>'cached' = 'true'`,
      prisma.$queryRaw<Array<{ key: string | null; priced: number | bigint; usd: number | null; in_tokens: number | null; price_source: string | null; unpriced: boolean | null; model: string | null }>>`
        SELECT COALESCE(lm."meta"->>'backend', '?') AS key, COUNT(*)::int AS priced, SUM(lm."value")::float AS usd,
               SUM(COALESCE((lm."meta"->>'inTokens')::float, 0))::float AS in_tokens,
               MAX(lm."meta"->>'priceSource') AS price_source,
               BOOL_OR(COALESCE((lm."meta"->>'unpriced')::boolean, false)) AS unpriced,
               MAX(lm."meta"->>'model') AS model
        FROM "loop_metrics" lm
        WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${since} AND lm."meta"->>'profile' = ${DECISION_SPEND_PROFILE}
        GROUP BY 1`,
      prisma.$queryRaw<Array<{ key: string | null; priced: number | bigint; usd: number | null; in_tokens: number | null; price_source: string | null; unpriced: boolean | null; model: string | null }>>`
        SELECT COALESCE(lm."meta"->>'purpose', '?') AS key, COUNT(*)::int AS priced, SUM(lm."value")::float AS usd,
               SUM(COALESCE((lm."meta"->>'inTokens')::float, 0))::float AS in_tokens,
               MAX(lm."meta"->>'priceSource') AS price_source,
               BOOL_OR(COALESCE((lm."meta"->>'unpriced')::boolean, false)) AS unpriced,
               MAX(lm."meta"->>'model') AS model
        FROM "loop_metrics" lm
        WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${since} AND lm."meta"->>'profile' = ${DECISION_SPEND_PROFILE}
        GROUP BY 1`,
      prisma.$queryRaw<Array<{ purpose: string; n: number | bigint }>>`
        SELECT purpose, COUNT(*)::int AS n FROM (
          SELECT CASE WHEN lm."kind" = 'schedule_sweep_skip' THEN 'sweep_triage'
                      WHEN lm."meta"->>'reason' = 'turn_noop' THEN 'supervisor_turn_noop'
                      ELSE 'wake_triage' END AS purpose
          FROM "loop_metrics" lm
          WHERE lm."createdAt" >= ${since}
            AND ((lm."kind" = 'wake_parked' AND lm."meta"->>'reason' IN ('triage', 'turn_noop')) OR lm."kind" = 'schedule_sweep_skip')
        ) x GROUP BY 1`,
      prisma.$queryRaw<Array<{ trigger_kind: string; mean_usd: number | null; runs: number | bigint }>>`
        SELECT lm."meta"->>'triggerKind' AS trigger_kind, AVG(lm."value")::float AS mean_usd, COUNT(*)::int AS runs
        FROM "loop_metrics" lm
        WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${since}
          AND lm."meta"->>'triggerKind' IN ('hook', 'schedule')
          AND COALESCE(lm."meta"->>'profile', '') <> ${DECISION_SPEND_PROFILE}
          AND COALESCE(lm."sessionId", '') <> ${DECISION_GATE_SYNTHETIC_SESSION}
        GROUP BY 1`,
    ]);
    const callAgg = (rows: Array<{ key: string | null; calls: number | bigint; input_tokens: number | null; p50: number | null }>): DecisionCallAgg[] =>
      rows.map(r => ({ key: r.key ?? '?', calls: num(r.calls), inputTokens: Math.round(num(r.input_tokens)), p50Ms: r.p50 === null || r.p50 === undefined ? null : Math.round(num(r.p50)) }));
    const spendAgg = (rows: Array<{ key: string | null; priced: number | bigint; usd: number | null; in_tokens: number | null; price_source: string | null; unpriced: boolean | null; model: string | null }>): DecisionSpendAgg[] =>
      rows.map(r => ({ key: r.key ?? '?', pricedCalls: num(r.priced), usd: num(r.usd), inTokens: Math.round(num(r.in_tokens)), priceSource: r.price_source ?? null, unpriced: r.unpriced === true, model: r.model ?? null }));
    return composeDecisionSpendSummary({
      windowDays, since,
      callsByBackend: callAgg(callsB), callsByPurpose: callAgg(callsP),
      spendByBackend: spendAgg(spendB), spendByPurpose: spendAgg(spendP),
      memoHits: num(memo[0]?.n),
      avoided: (avoidedRows as Array<{ purpose: string; n: number | bigint }>).map(r => ({ purpose: r.purpose as AvoidedRow['purpose'], avoided: num(r.n) })),
      runMeans: (means as Array<{ trigger_kind: string; mean_usd: number | null; runs: number | bigint }>).map(r => ({ triggerKind: r.trigger_kind, meanUsd: r.mean_usd === null ? null : num(r.mean_usd), runs: num(r.runs) })),
    });
  } catch (err: any) {
    logger.warn(`decision-gate-spend: summary query failed (${err?.message}) — rendering an empty block`);
    return empty();
  }
}

export interface DecisionPurposeSpend24h { calls24h: number; costUsd24h: number; pricedCalls24h: number }

/** Per-purpose calls (decision rows, no memo hits) + USD (run_spend profile=decision) over the last 24 h. Never throws. */
export async function decisionSpendByPurpose24h(now: Date = new Date()): Promise<Map<string, DecisionPurposeSpend24h>> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const out = new Map<string, DecisionPurposeSpend24h>();
  try {
    const prisma = await db();
    const [calls, spend] = await Promise.all([
      prisma.$queryRaw<Array<{ purpose: string | null; n: number | bigint }>>`
        SELECT lm."meta"->>'purpose' AS purpose, COUNT(*)::int AS n FROM "loop_metrics" lm
        WHERE lm."kind" = 'decision_gate' AND lm."createdAt" >= ${since}
          AND lm."meta"->>'phase' = 'decision' AND lm."meta"->>'ok' = 'true' AND (lm."meta"->>'cached') IS NULL
        GROUP BY 1`,
      prisma.$queryRaw<Array<{ purpose: string | null; n: number | bigint; usd: number | null }>>`
        SELECT lm."meta"->>'purpose' AS purpose, COUNT(*)::int AS n, SUM(lm."value")::float AS usd FROM "loop_metrics" lm
        WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${since} AND lm."meta"->>'profile' = ${DECISION_SPEND_PROFILE}
        GROUP BY 1`,
    ]);
    for (const r of calls) if (r.purpose) out.set(r.purpose, { calls24h: num(r.n), costUsd24h: 0, pricedCalls24h: 0 });
    for (const r of spend) {
      if (!r.purpose) continue;
      const e = out.get(r.purpose) ?? { calls24h: 0, costUsd24h: 0, pricedCalls24h: 0 };
      e.costUsd24h = round4(num(r.usd));
      e.pricedCalls24h = num(r.n);
      out.set(r.purpose, e);
    }
  } catch (err: any) {
    logger.warn(`decision-gate-spend: 24 h per-purpose query failed (${err?.message})`);
  }
  return out;
}

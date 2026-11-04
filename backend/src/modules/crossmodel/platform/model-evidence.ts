/**
 * Evidence per model per lane for the per-turn model pick (model-pick.ts; owner 2026-10-04).
 *
 * Two sources, merged per (spec, lane):
 *   BENCH  — the offline benchmark scorecard (scripts/e2e/model-bench.py → scripts/framework-audit/model-bench-ingest.js
 *            → context store ['instance','model-bench'] / 'scorecard'): the same realistic questions run on every
 *            candidate through the real chat pipeline on the test account, judged 1–5. The ONLY source of quality
 *            (owner: no live exploration on real users).
 *   PROD   — real human turns: loop_metrics `ux_ttft` (time to first word, `meta.leadModel`, lane / preset), last
 *            PROD_WINDOW_DAYS. Latency from real traffic wins once it has PROD_LATENCY_MIN_N turns on that lane.
 * Lane of a prod row: `meta.lane` when it is a turn-plan lane, else the preset (single_thinking → standard,
 * thinking → checked, deep_research → research).
 *
 * V2 — evidence that predicts REAL turns (roster 2026-10-06 C-2; readiness report problem 1: the pick chose glm-5.3
 * expecting ~11 s from the bench, real plain turns took ~96 s because they make 1–3 web calls before the first word):
 *   - GUESTS count (their `anon-` sessions were dropped), and SUPERVISOR chats do NOT (owner turns on a supervisor
 *     chat run the supervisor seat under the supervisor doctrine — the bulk of the old "prod" rows);
 *   - prod latency overrides the bench at PROD_LATENCY_MIN_N_V2 (10) real turns per (model, lane) instead of 20 —
 *     safe because prod only ever replaces LATENCY (quality stays bench-only) and a 10-turn p50 of real, tool-using
 *     turns predicts a real turn better than any bench number;
 *   - TOOL-AWARE bench latency: each row's web calls (ux_ttft `meta.webToolCalls`, else the same run's
 *     chat_search_usage row) give the lane's real tool rate k (mean web calls per turn, every model, at least
 *     LANE_TOOL_RATE_MIN_N rows, else DEFAULT_LANE_TOOL_RATE). Every web call costs one more model step plus the
 *     tool itself, so a bench number measured with t_b calls predicts  b0 · (1 + k) + k · TOOL_EXEC_MS  with
 *     b0 = (bench − t_b · TOOL_EXEC_MS) / (1 + t_b)  — calibrated on prod 14 d (2026-10-06): first word p50 by web
 *     calls 0 / 1 / 2 / 3 = 46 / 101 / 177 / 217 s on thinking leads, 13 / 37 / 66 / 144 s on the Quick lane.
 *   MODEL_EVIDENCE_V2_DISABLED=1 restores the previous evidence (signed-in only, supervisor rows in, 20 turns, raw
 *   bench latency).
 *
 * KIND-KEYED QUALITY (2026-10-20, task-aware pick; docs/AUDIT_2026-10-20_REAL_USER.md: a birthday poem, a cover letter,
 * a logo and a Python function ranked byte-identically because evidence was keyed (model, lane) only). The bench also
 * files every judged answer under its JOB TYPE (task-kind.ts TASK_KINDS) — scorecard models[spec].kinds[kind], the same
 * stats shape as a lane bucket. When the caller names the turn's kind, QUALITY comes from that bucket once it has
 * BENCH_KIND_MIN_N judged answers, SHRUNK toward the (spec, lane | all) quality the pick used before:
 *     q̂ = (n_k · q_k + KIND_PRIOR_N · q_base) / (n_k + KIND_PRIOR_N)
 * — the bench's quality is a within-question RANK (K = 3 ⇒ 5 / 3 / 1, sd ≈ 1.6), so a 8-answer bucket is a noisy mean;
 * the prior keeps one lucky run from crowning a model. LATENCY and failRate stay (spec, lane) exactly as before (prod /
 * recency / tool-aware rules untouched): a per-kind latency would be bench-only for the candidates and prod for the
 * seat — an asymmetry that biases toward switching. `qualityKey` says which bucket the quality came from ('kind' |
 * 'lane' | 'all'); `qualityN` is that bucket's judged count. MODEL_EVIDENCE_KIND_DISABLED=1 ignores kind buckets.
 *
 * Loaded once per CACHE_MS per process (stale-while-revalidate); the turn plan reads a snapshot and never waits more
 * than its own budget. Never throws.
 */
import type { ModelEvidence, PickLane } from './model-pick';
import { MODEL_BENCH_ACCOUNT_EMAIL } from './model-bench-scorecard';
import type { TaskKind } from './task-kind';

export const MODEL_BENCH_NS = ['instance', 'model-bench'];
export const MODEL_BENCH_KEY = 'scorecard';
export const PROD_WINDOW_DAYS = 14;
export const PROD_LATENCY_MIN_N = 20;
/** V2: real turns per (model, lane) before prod latency replaces the bench's (roster 2026-10-06 C-2). */
export const PROD_LATENCY_MIN_N_V2 = 10;
/** V2: one web tool call's own execution time (SERP / scrape), beside the extra model step it costs. */
export const TOOL_EXEC_MS = 8_000;
/** V2: prod rows with a known web-call count a lane needs before its measured tool rate replaces the default. */
export const LANE_TOOL_RATE_MIN_N = 20;
/** V2: web calls per real turn by lane until prod measures them (prod 14 d, 2026-10-06: Quick 2.1, plain checked-
 *  preset leads 1.1–2.2, single-preset 0.7; research asks fan out). */
export const DEFAULT_LANE_TOOL_RATE: Readonly<Record<PickLane, number>> = { quick: 1.5, standard: 0.8, checked: 1.5, research: 3 };
/** A bench lane bucket is trusted only once it has this many answers; below it the model's overall ('all')
 *  numbers stand in (P1.2, owner handoff 2026-10-05 — mb1005b left n=1 'checked' rows per model). */
export const BENCH_LANE_MIN_N = 5;
/** 2026-10-20: judged answers a (spec, kind) bucket needs before it keys the quality (rank-based quality sd ≈ 1.6 ⇒
 *  a mean SE ≈ 0.57 at 8 — still noisy, hence the shrinkage below and the SE-scaled switch margin in model-pick.ts). */
export const BENCH_KIND_MIN_N = 8;
/** 2026-10-20: pseudo-answers at the (spec, lane | all) quality the kind mean is shrunk toward. */
export const KIND_PRIOR_N = 8;
const CACHE_MS = 10 * 60_000;

export interface BenchLaneStats {
  n: number;
  ttftP50Ms: number | null;
  ttftP90Ms: number | null;
  doneP50Ms?: number | null;
  failRate: number | null;
  quality: number | null;
  qualityN: number;
  /** Mean web tool calls per measured bench answer (model-bench-scorecard.ts; absent on buckets before 2026-10-06). */
  webToolsMean?: number | null;
}
/** 2026-10-20: a (spec, kind) bucket — the lane shape plus where its ranks were measured (model-bench-scorecard.ts). */
export interface BenchKindStats extends BenchLaneStats {
  /** Distinct specs measured for this kind in the run (the K of its within-question ranks). */
  fieldSize?: number | null;
  runId?: string;
  at?: string;
}
/** `lanes` may be absent on a model the bench measured only by kind (the scorecard keeps such a model). */
export interface BenchScorecard { models: Record<string, { lanes?: Record<string, BenchLaneStats>; kinds?: Record<string, BenchKindStats> }> }

export interface ProdLaneStats {
  n: number; ttftP50Ms: number | null; ttftP90Ms: number | null; noAnswer: number;
  /** V2: rows with a known web-call count, and their mean. */
  toolN?: number; toolMean?: number | null;
}
export type ProdLatency = Record<string, Partial<Record<PickLane, ProdLaneStats>>>;

const LANES: readonly PickLane[] = ['quick', 'standard', 'checked', 'research'];

/** A ux_ttft row's lane. Pure. */
export function laneOfTtftRow(lane: unknown, preset: unknown): PickLane | null {
  if (typeof lane === 'string' && (LANES as readonly string[]).includes(lane)) return lane as PickLane;
  const p = String(lane ?? preset ?? '');
  if (p === 'single_thinking' || p === 'single' || p === 'fast') return 'standard';
  if (p === 'thinking') return 'checked';
  if (p === 'deep_research' || p === 'deep_research_all') return 'research';
  if (p === 'quick') return 'quick';
  return null;
}

export function modelEvidenceV2Disabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.MODEL_EVIDENCE_V2_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** 2026-10-20: MODEL_EVIDENCE_KIND_DISABLED=1 ⇒ evidenceFrom ignores the turn's kind (quality keyed (spec, lane) only). */
export function modelEvidenceKindDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.MODEL_EVIDENCE_KIND_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** V2 options for mergeEvidence: the 10-turn prod override + the lane's real web-call rate. */
export interface MergeOptions {
  v2?: boolean;
  /** Mean web calls per real turn on this lane (laneToolRates). null = no tool adjustment. */
  laneToolRate?: number | null;
  /** 2026-10-20: the turn's job type — QUALITY keys on its bench bucket when that is deep enough (see the header). */
  kind?: TaskKind | null;
}

/** A kind bucket deep enough to key quality on, or null. Pure. */
function usableKindBucket(bench: BenchScorecard | null, spec: string, kind: TaskKind | null | undefined): BenchKindStats | null {
  if (!kind) return null;
  const k = bench?.models?.[spec]?.kinds?.[kind] ?? null;
  if (!k || typeof k.quality !== 'number' || !Number.isFinite(k.quality)) return null;
  return (Number(k.qualityN) || 0) >= BENCH_KIND_MIN_N ? k : null;
}

/** With no lane / overall quality on record, a kind mean is shrunk toward the MIDPOINT of the rank scale (1..5) — never
 *  used raw, or a model whose base buckets were re-ingested without a judge would be compared unshrunk against peers
 *  that are shrunk (2026-10-20 review). */
export const KIND_PRIOR_FALLBACK_QUALITY = 3;

/** The kind mean shrunk toward the model's lane / overall quality (no base ⇒ toward KIND_PRIOR_FALLBACK_QUALITY). Pure. */
export function shrinkKindQuality(kindQ: number, kindN: number, baseQ: number | null | undefined): number {
  const base = typeof baseQ === 'number' && Number.isFinite(baseQ) ? baseQ : KIND_PRIOR_FALLBACK_QUALITY;
  const n = Math.max(0, kindN);
  return (n * kindQ + KIND_PRIOR_N * base) / (n + KIND_PRIOR_N);
}

/** Bench first-word time re-predicted for a lane's real tool use (see the header). Pure. */
export function toolAwareMs(benchMs: number | null, laneRate: number | null | undefined, benchTools: number | null | undefined): number | null {
  if (benchMs === null || laneRate === null || laneRate === undefined || !Number.isFinite(laneRate)) return benchMs;
  const tb = typeof benchTools === 'number' && Number.isFinite(benchTools) ? Math.max(0, benchTools) : 0;
  const k = Math.max(0, laneRate);
  const b0 = Math.max(0, benchMs - tb * TOOL_EXEC_MS) / (1 + tb);
  return Math.round(b0 * (1 + k) + k * TOOL_EXEC_MS);
}

export type LaneToolRates = Record<PickLane, { rate: number; n: number; measured: boolean }>;

/** The real web-call rate per lane from the prod rows (every model), else the default. Pure. */
export function laneToolRates(prod: ProdLatency | null): LaneToolRates {
  const out = {} as LaneToolRates;
  for (const lane of LANES) {
    let n = 0;
    let sum = 0;
    for (const byLane of Object.values(prod ?? {})) {
      const st = byLane?.[lane];
      if (st && st.toolN && st.toolN > 0 && typeof st.toolMean === 'number' && Number.isFinite(st.toolMean)) { n += st.toolN; sum += st.toolMean * st.toolN; }
    }
    out[lane] = n >= LANE_TOOL_RATE_MIN_N ? { rate: Number((sum / n).toFixed(2)), n, measured: true } : { rate: DEFAULT_LANE_TOOL_RATE[lane], n, measured: false };
  }
  return out;
}

/** Merge both sources into the evidence for one (spec, lane). Pure. */
export function mergeEvidence(spec: string, lane: PickLane, bench: BenchScorecard | null, prod: ProdLatency | null, opts: MergeOptions = {}): ModelEvidence | null {
  const laneBucket = bench?.models?.[spec]?.lanes?.[lane] ?? null;
  const allBucket = bench?.models?.[spec]?.lanes?.all ?? null;
  // Thin lane bucket = noise, not evidence: use it only once it has BENCH_LANE_MIN_N answers, else the model's
  // overall ('all') numbers. The thin lane stays as a last resort when the model has no 'all' bucket, so this
  // never leaves a lane with LESS evidence than before (P1.2, owner handoff 2026-10-05).
  const b = (laneBucket && laneBucket.n >= BENCH_LANE_MIN_N ? laneBucket : null) ?? allBucket ?? laneBucket;
  const p = prod?.[spec]?.[lane] ?? null;
  if (!b && !p) return null;
  const minProd = opts.v2 ? PROD_LATENCY_MIN_N_V2 : PROD_LATENCY_MIN_N;
  const prodWins = !!p && p.n >= minProd && p.ttftP50Ms !== null;
  // V2: a bench latency (not prod's) is re-predicted for the lane's real tool use.
  const adjust = !!opts.v2 && !prodWins && !!b && b.ttftP50Ms !== null && typeof opts.laneToolRate === 'number';
  const benchP50 = adjust ? toolAwareMs(b!.ttftP50Ms, opts.laneToolRate, b!.webToolsMean) : (b?.ttftP50Ms ?? null);
  const benchP90 = adjust ? toolAwareMs(b!.ttftP90Ms ?? null, opts.laneToolRate, b!.webToolsMean) : (b?.ttftP90Ms ?? null);
  const ttftP50Ms = prodWins ? p!.ttftP50Ms : (benchP50 ?? p?.ttftP50Ms ?? null);
  const ttftP90Ms = prodWins ? p!.ttftP90Ms : (benchP90 ?? p?.ttftP90Ms ?? null);
  const failRate = b?.failRate ?? (p && p.n > 0 ? p.noAnswer / p.n : null);
  // 2026-10-20: QUALITY from the turn's kind bucket when it is deep enough, shrunk toward the lane / overall quality;
  // n, latency and failRate above are untouched (the (spec, lane) rules stand).
  const kb = usableKindBucket(bench, spec, opts.kind);
  const baseQuality = b?.quality ?? null;
  const quality = kb ? Number(shrinkKindQuality(kb.quality!, kb.qualityN, baseQuality).toFixed(3)) : baseQuality;
  const qualityKey: 'kind' | 'lane' | 'all' = kb ? 'kind' : (b && b === allBucket ? 'all' : 'lane');
  const parts = [
    b ? `bench n${b.n}${adjust ? ` (tool-adjusted, k ${opts.laneToolRate})` : ''}` : '',
    p ? `prod n${p.n}${prodWins ? ' (latency)' : ''}` : '',
    kb ? `kind ${opts.kind} n${kb.qualityN} q ${kb.quality!.toFixed(2)}${baseQuality !== null ? ` → ${quality!.toFixed(2)} (shrunk toward ${baseQuality.toFixed(2)})` : ''}` : '',
  ].filter(Boolean);
  return {
    n: (b?.n ?? 0) + (p?.n ?? 0),
    ttftP50Ms, ttftP90Ms, failRate,
    quality,
    qualityN: kb ? kb.qualityN : (b?.qualityN ?? 0),
    qualityKey,
    // The bench run the kind quality was ranked in — rank-based quality compares only within one run's field.
    ...(kb && typeof kb.runId === 'string' && kb.runId ? { qualityRunId: kb.runId } : {}),
    source: parts.join(' + '),
  };
}

/** Prod rows (spec, lane / preset, n, p50, p90, noAnswer[, tool_n, tool_mean]) → ProdLatency. Pure. */
export function prodLatencyFromRows(rows: ReadonlyArray<{ model: unknown; lane: unknown; preset: unknown; n: unknown; p50: unknown; p90: unknown; no_answer?: unknown; tool_n?: unknown; tool_mean?: unknown }>): ProdLatency {
  const out: ProdLatency = {};
  for (const r of rows) {
    const spec = typeof r.model === 'string' ? r.model : '';
    const lane = laneOfTtftRow(r.lane, r.preset);
    if (!spec || !lane) continue;
    const n = Number(r.n) || 0;
    const prev = out[spec]?.[lane];
    const toolN = Number(r.tool_n) || 0;
    const cur: ProdLaneStats = {
      n, ttftP50Ms: r.p50 == null ? null : Number(r.p50), ttftP90Ms: r.p90 == null ? null : Number(r.p90), noAnswer: Number(r.no_answer) || 0,
      ...(r.tool_n !== undefined ? { toolN, toolMean: toolN > 0 && r.tool_mean != null && Number.isFinite(Number(r.tool_mean)) ? Number(r.tool_mean) : null } : {}),
    };
    // Two raw rows can fold into one lane (lane + preset spellings) — keep the bigger sample.
    if (!prev || cur.n > prev.n) (out[spec] ??= {})[lane] = cur;
  }
  return out;
}

export interface EvidenceSnapshot {
  bench: BenchScorecard | null;
  prod: ProdLatency | null;
  at: number;
  /** V2 (roster 2026-10-06 C-2): the snapshot was loaded with the v2 query; its lanes' real web-call rates. */
  v2?: boolean;
  laneToolRates?: LaneToolRates;
  /** Ticket 4e74f0bb: the RECENCY_WINDOW_HOURS trailing read of the same population (null = the arm is off / failed). */
  recent?: ProdLatency | null;
}

/**
 * The v2 prod query (roster 2026-10-06 C-2): guests in, supervisor chats out, and each row's web-call count —
 * `meta.webToolCalls` on the ux_ttft row (written since 2026-10-06) else the same run's chat_search_usage row
 * (same sessionId, ±20 s — loop_metrics is indexed on sessionId + createdAt). $1 = window days, $2 = bench email.
 * Ran read-only on prod 2026-10-06 (14 d): 60 real turns over 6 (model, lane) groups, every row with a tool count.
 */
export const PROD_EVIDENCE_SQL_V2 = `SELECT u.meta->>'leadModel' AS model, u.meta->>'lane' AS lane, u.meta->>'preset' AS preset, count(*)::int AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY u.value)::int AS p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY u.value)::int AS p90,
       count(*) FILTER (WHERE (u.meta->>'noChunk')::boolean)::int AS no_answer,
       count(w.web)::int AS tool_n,
       avg(w.web)::float AS tool_mean
  FROM loop_metrics u
  LEFT JOIN LATERAL (
    SELECT coalesce((u.meta->>'webToolCalls')::int, (
      SELECT (s.meta->>'webToolCalls')::int FROM loop_metrics s
       WHERE s."sessionId" = u."sessionId" AND s.kind = 'chat_search_usage'
         AND s."createdAt" BETWEEN u."createdAt" - interval '20 seconds' AND u."createdAt" + interval '20 seconds'
       ORDER BY abs(extract(epoch from (s."createdAt" - u."createdAt"))) LIMIT 1)) AS web
  ) w ON true
 WHERE u.kind = 'ux_ttft' AND u."createdAt" > now() - ($1 || ' days')::interval
   AND u.meta->>'leadModel' IS NOT NULL
   AND coalesce((u.meta->>'synthetic')::boolean, false) = false
   AND (
     u."sessionId" LIKE 'anon-%'
     OR u."sessionId" LIKE 'chatless-%'
     OR EXISTS (
       SELECT 1 FROM crossmodel_chats c JOIN users uu ON uu.id = c."userId"
        WHERE c.id = u."sessionId" AND uu.email <> $2
          AND coalesce(c."isSupervisor", false) = false AND coalesce(c."isProjectSupervisor", false) = false)
   )
 GROUP BY 1, 2, 3`;

/**
 * audit 2026-10-08 W4-1b: every human ux_ttft row now carries a lane (chat-agent ttftLaneStamp), so one model's rows on
 * one lane arrive under several presets (lane standard × preset thinking / single_thinking, plus older rows keyed by
 * preset alone). prodLatencyFromRows folds such groups by keeping the BIGGER sample — it threw the rest away, exactly
 * the starvation the stamp fixes. This variant resolves the lane IN SQL (meta.lane, else the preset alias —
 * laneOfTtftRow's mapping) and groups on it, so every turn of a (model, lane) lands in ONE percentile.
 * MODEL_EVIDENCE_LANE_MERGE_DISABLED=1 restores PROD_EVIDENCE_SQL_V2 (grouped by lane + preset).
 */
export const PROD_EVIDENCE_LANE_SQL = `CASE WHEN u.meta->>'lane' IN ('quick','standard','checked','research') THEN u.meta->>'lane'
            WHEN u.meta->>'preset' IN ('single_thinking','single','fast') THEN 'standard'
            WHEN u.meta->>'preset' = 'thinking' THEN 'checked'
            WHEN u.meta->>'preset' IN ('deep_research','deep_research_all') THEN 'research' END`;
export const PROD_EVIDENCE_SQL_V2_LANES = PROD_EVIDENCE_SQL_V2
  .replace("u.meta->>'lane' AS lane, u.meta->>'preset' AS preset,", `${PROD_EVIDENCE_LANE_SQL} AS lane, NULL::text AS preset,`)
  .replace(/GROUP BY 1, 2, 3$/, 'GROUP BY 1, 2');
export function modelEvidenceLaneMergeDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.MODEL_EVIDENCE_LANE_MERGE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

let snapshot: EvidenceSnapshot | null = null;
let inflight: Promise<EvidenceSnapshot> | null = null;

// ── Recency (ticket 4e74f0bb, 2026-10-09): the outage the 14-day window cannot see ─────────────────────────────
// Prod shape that filed the ticket: every cql-litellm:api-* gateway route degraded from 2026-10-07 ~13:00Z (HTTP
// 502 seat_fallback rows + slow/hung streams — the pick LED 22 standard/checked turns onto routes measuring
// 81–471 s p50 while the direct glm-5.3 seat held 8–25 s). PROD_WINDOW_DAYS = 14 dilutes a multi-hour outage to
// noise: at steady state the gateway routes' 14-day p50s (80–162 s standard) were already tolerated by the utility
// math, and once the outage started nothing moved for hours. The recency arm re-reads the SAME population over a
// short trailing window and — only when a (model, lane) is MATERIALLY WORSE recently than its long-window p50 —
// lets the recent numbers stand in for the latency the model is ranked on. One direction only: thin recent data
// can DEMOTE a model, never promote it (an idle model has no recent rows and keeps its long-window evidence).
export const RECENCY_WINDOW_HOURS = 6;
/** Recent turns a (model, lane) needs before its window can override the long one. */
export const RECENCY_MIN_N = 3;
/** A model is only demoted when its recent p50 exceeds RECENCY_WORSE_RATIO × the long-window p50. */
export const RECENCY_WORSE_RATIO = 1.5;

export function modelEvidenceRecencyDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.MODEL_EVIDENCE_RECENCY_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * The recency read: same population as PROD_EVIDENCE_SQL_V2_LANES over RECENCY_WINDOW_HOURS — no tool-count
 * LATERAL (the recency arm compares latency only). $1 = window hours, $2 = bench email.
 */
export const PROD_EVIDENCE_RECENCY_SQL = `SELECT u.meta->>'leadModel' AS model, ${PROD_EVIDENCE_LANE_SQL} AS lane, count(*)::int AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY u.value)::int AS p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY u.value)::int AS p90,
       count(*) FILTER (WHERE (u.meta->>'noChunk')::boolean)::int AS no_answer
  FROM loop_metrics u
 WHERE u.kind = 'ux_ttft' AND u."createdAt" > now() - ($1 || ' hours')::interval
   AND u.meta->>'leadModel' IS NOT NULL
   AND coalesce((u.meta->>'synthetic')::boolean, false) = false
   AND (
     u."sessionId" LIKE 'anon-%'
     OR u."sessionId" LIKE 'chatless-%'
     OR EXISTS (
       SELECT 1 FROM crossmodel_chats c JOIN users uu ON uu.id = c."userId"
        WHERE c.id = u."sessionId" AND uu.email <> $2
          AND coalesce(c."isSupervisor", false) = false AND coalesce(c."isProjectSupervisor", false) = false))
 GROUP BY 1, 2`;

/**
 * A materially-worse recent window overrides the latency the model is ranked on. Pure; one direction (demote only):
 * a recent p50 at or under RECENCY_WORSE_RATIO × the long-window p50 changes nothing, and no recent rows at all
 * (the idle-model case) changes nothing. p90 rides along when the recent window has one.
 */
export function applyRecentLatency(ev: ModelEvidence, recent: ProdLaneStats | null | undefined): ModelEvidence {
  if (!recent || recent.n < RECENCY_MIN_N || recent.ttftP50Ms === null) return ev;
  const base = ev.ttftP50Ms;
  if (base === null || recent.ttftP50Ms <= RECENCY_WORSE_RATIO * base) return ev;
  return {
    ...ev,
    ttftP50Ms: recent.ttftP50Ms,
    // The p90 rides along CLAMPED (adversarial review F-A, ticket 4e74f0bb): expectedWaitMs ranks on
    // mean(p50, p90), so an unguarded substitution could LOWER a degraded route's expected wait when
    // the long-window p90 is outlier-inflated and the recent window is tight-but-slow — promoting the
    // route the arm exists to route around. max() keeps every outcome a strict demotion.
    ttftP90Ms: recent.ttftP90Ms === null ? ev.ttftP90Ms : Math.max(recent.ttftP90Ms, ev.ttftP90Ms ?? 0),
    source: `${ev.source} + recent n${recent.n} p50 ${Math.round(recent.ttftP50Ms / 1000)}s (worse)`,
  };
}

/** Test hook. */
export function __resetModelEvidenceForTests(s: EvidenceSnapshot | null = null): void { snapshot = s; inflight = null; }

async function loadFresh(): Promise<EvidenceSnapshot> {
  let bench: BenchScorecard | null = null;
  let prod: ProdLatency | null = null;
  let recent: ProdLatency | null = null;
  const v2 = !modelEvidenceV2Disabled();
  try {
    const { storeGet } = await import('../memory/context-store');
    const v = await storeGet<BenchScorecard>(MODEL_BENCH_NS, MODEL_BENCH_KEY);
    bench = v && typeof v === 'object' && v.models && typeof v.models === 'object' ? v : null;
  } catch { /* no bench yet */ }
  try {
    const prisma = (await import('../../../config/database')).default;
    const rows = v2
      ? await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(modelEvidenceLaneMergeDisabled() ? PROD_EVIDENCE_SQL_V2 : PROD_EVIDENCE_SQL_V2_LANES, String(PROD_WINDOW_DAYS), MODEL_BENCH_ACCOUNT_EMAIL)
      : await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT meta->>'leadModel' AS model, meta->>'lane' AS lane, meta->>'preset' AS preset, count(*)::int AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY value)::int AS p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY value)::int AS p90,
              count(*) FILTER (WHERE (meta->>'noChunk')::boolean)::int AS no_answer
         FROM loop_metrics
        WHERE kind = 'ux_ttft' AND "createdAt" > now() - ($1 || ' days')::interval
          AND meta->>'leadModel' IS NOT NULL AND coalesce((meta->>'guest')::boolean, false) = false
          AND coalesce((meta->>'synthetic')::boolean, false) = false
          -- The chat itself must be live and not the bench account's. Two arms, one predicate:
          --  • a live chat owned by the bench account (MODEL_BENCH_ACCOUNT_EMAIL) = a bench /
          --    suite turn — synthetic, flagged (above) for new rows and by account here for
          --    rows written before the flag existed (P1.1, owner handoff 2026-10-05);
          --  • a UUID sessionId with NO chat row = an orphaned run whose chat was deleted
          --    (the ephemeral e2e query suites — ~1/3 of a 600-row 2026-10-05 sample). The
          --    by-account arm cannot see those anymore, so they are dropped here instead of
          --    riding out PROD_WINDOW_DAYS. 'chatless-' prefixes are signed-in chatless
          --    sends (Telegram humans — chat-agent.service.ts runSessionId) — KEPT; 'anon-'
          --    guests are already gone via the guest arm.
          AND (
            loop_metrics."sessionId" LIKE 'chatless-%'
            OR EXISTS (
              SELECT 1 FROM crossmodel_chats c JOIN users u ON u.id = c."userId"
               WHERE c.id = loop_metrics."sessionId" AND u.email <> $2)
          )
        GROUP BY 1, 2, 3`,
      String(PROD_WINDOW_DAYS),
      MODEL_BENCH_ACCOUNT_EMAIL,
    );
    prod = prodLatencyFromRows(rows as any);
  } catch { /* prod latency unavailable — bench only */ }
  // Ticket 4e74f0bb: the recency arm — the same population over RECENCY_WINDOW_HOURS, applied one-directionally
  // (demote only) in evidenceFrom. Fail-open: a failed read changes nothing, and the arm is off under
  // MODEL_EVIDENCE_RECENCY_DISABLED=1 (or MODEL_EVIDENCE_V2_DISABLED=1, which selects the v1 path entirely).
  if (v2 && !modelEvidenceRecencyDisabled()) {
    try {
      const prismaRecent = (await import('../../../config/database')).default;
      const recentRows = await prismaRecent.$queryRawUnsafe<Array<Record<string, unknown>>>(PROD_EVIDENCE_RECENCY_SQL, String(RECENCY_WINDOW_HOURS), MODEL_BENCH_ACCOUNT_EMAIL);
      recent = prodLatencyFromRows(recentRows as any);
    } catch { /* fail-open: no recent evidence */ }
  }
  return { bench, prod, at: Date.now(), ...(v2 ? { v2: true, laneToolRates: laneToolRates(prod) } : {}), ...(recent ? { recent } : {}) };
}

/** The current evidence. Returns the cached snapshot at once when fresh; otherwise loads (deduped). Never throws. */
export async function loadModelEvidence(now: number = Date.now()): Promise<EvidenceSnapshot> {
  if (snapshot && now - snapshot.at < CACHE_MS) return snapshot;
  if (!inflight) {
    inflight = loadFresh().then((s) => { snapshot = s; return s; }).finally(() => { inflight = null; });
  }
  // Stale-while-revalidate: a stale snapshot answers now; the refresh lands for the next turn.
  if (snapshot) return snapshot;
  return inflight;
}

/** The evidence function model-pick.ts reads, bound to one snapshot. Pure over the snapshot (a v2 snapshot merges
 *  with the 10-turn prod override + tool-aware bench latency; MODEL_EVIDENCE_V2_DISABLED=1 is read at load time).
 *  Ticket 4e74f0bb: a materially-worse RECENCY_WINDOW_HOURS window on a (model, lane) stands in for the latency
 *  the model is ranked on (applyRecentLatency — demote only).
 *  2026-10-20: the optional third argument is the turn's job type — quality keys on its bench bucket (mergeEvidence);
 *  MODEL_EVIDENCE_KIND_DISABLED=1 (read once per binding) drops it, so every call is the (spec, lane) evidence. */
export function evidenceFrom(s: EvidenceSnapshot | null): (spec: string, lane: PickLane, kind?: TaskKind | null) => ModelEvidence | null {
  const v2 = !!s?.v2;
  const rates = v2 ? (s?.laneToolRates ?? laneToolRates(s?.prod ?? null)) : null;
  const kindOff = modelEvidenceKindDisabled();
  return (spec, lane, kind) => {
    const opts: MergeOptions = { ...(v2 ? { v2: true, laneToolRate: rates?.[lane]?.rate ?? null } : {}), ...(kind && !kindOff ? { kind } : {}) };
    const merged = mergeEvidence(spec, lane, s?.bench ?? null, s?.prod ?? null, opts);
    return merged ? applyRecentLatency(merged, s?.recent?.[spec]?.[lane]) : null;
  };
}

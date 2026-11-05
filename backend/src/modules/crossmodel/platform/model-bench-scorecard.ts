/**
 * MODEL BENCH SCORECARD — what each open lead model measured OFFLINE on the canonical test account (2026-10-04).
 *
 * Owner rule (dynamic roster): the decision model may pick ANY open model per task instead of the fixed Digby seat,
 * but there is NO live exploration on real users — models are measured by replaying realistic questions
 * (scripts/e2e/human_corpus.py) through the REAL production chat pipeline on the canonical prod test account, one
 * chat per (question, model) with the per-chat lead override (`crossmodel_chats.leadModel`). The pipeline:
 *
 *   scripts/e2e/model-bench.py            — runs the benchmark (chat title `model-bench <runId> q<idx> <spec>[ k:<kind>]`)
 *   scripts/framework-audit/model-bench-ingest.js (in the backend container via prodq.sh)
 *                                         — reads the run's chats, ranks each question's answers BLIND +
 *                                           COMPARATIVELY (judge v2 since 2026-10-20: a family-excluding judge
 *                                           panel's Latin-square ballots, pairwise win rates onto 1..5, buckets stamped
 *                                           `qualityJudge`; `--judge-version v1`: one judge's rank → 1..5, the
 *                                           absolute QUALITY_RUBRIC only as a fallback), aggregates with THIS leaf,
 *                                           writes the store row
 *   the picker                            — readModelBenchScorecard() + the types below
 *
 * Store contract: ONE context-store row at [MODEL_BENCH_STORE_NS] / MODEL_BENCH_STORE_KEY, shape
 *   { updatedAt, updatedBy, runs: [runId…],
 *     models: { [spec]: { lanes: { [lane]: ModelBenchLaneStats }, kinds?: { [kind]: ModelBenchKindStats } } } }
 * `lane` is the turn-plan lane the question's answer recorded (quick / standard / checked / research, 'none' when
 * no turn plan ran) plus the 'all' bucket. A newer run REPLACES the same spec + lane bucket (mergeScorecards) — but
 * a bucket with NO judged quality never erases a stored judged quality (2026-10-20 review: an unjudged refresh keeps
 * the old quality + qualityN and takes the newer latency / n / failRate).
 *
 * TASK KINDS (2026-10-20, the task-aware pick — platform/task-kind.ts is the ONE vocabulary). The real-user audit
 * saw the pick rank a poem, a cover letter and a Python function byte-identically because quality was keyed
 * (model, lane) only. So a row also carries a KIND: the bench writes it into the title as an optional strict
 * trailing token (`model-bench <runId> q<idx> <spec> k:<kind>` — the question's kind: its corpus entry's kind=<k> flag,
 * else its group's, the Python GROUP_KIND twin of BENCH_GROUP_KIND), and the answer row's own classification (metadata.depth.turnPlan.taskKind
 * .kind, the task_kind decision) rides as `planKind`. The bucket key is the TITLE kind (deterministic, and the same
 * for every model's chat of one question — the comparative ranks share one bucket), else planKind, else no kind
 * bucket at all. `kinds` is ABSENT on a model with no kind rows (every pre-kind card stays byte-identical) and each
 * kind bucket records `fieldSize` — how many specs were MEASURED on that kind in the run: quality is a comparative
 * RANK within the run's field (the ingest's rankToQuality), so a 3-model bucket and an 8-model bucket are not on
 * one scale and the reader can see which it holds. normalize / merge carry kinds (the same newer-`at` rule per kind
 * bucket, plus: a THIN incoming kind bucket — < KIND_BUCKET_KEEP_MIN_N judged — never replaces a DEEP stored one) —
 * an older image that ingests once DROPS them (it rebuilds models[spec] = {lanes}); re-ingest the kind run. The bench
 * writes the title token only on a KIND run (--kinds / --per-kind, 2026-10-20 review): a routine run's titles are
 * plain, its rows still file under their classified planKind, and the keep floor stops those thin buckets replacing
 * a dedicated kind run's deep ones.
 *
 * Attribution (attributeBenchRow): a row MEASURES its spec only when the spec actually led (modelUsed === spec).
 * A Quick-lane diversion (the turn plan sent a quick question to the Quick answers seat) and an answer whose leading
 * model is unknown are excluded; a missing / empty / errored answer and a seat FAILOVER (another model finished the
 * turn) count against the spec in `failRate` but never feed its latency or quality.
 *
 * Pure except readModelBenchScorecard (one store read, cached, never throws). No prisma import at module load (the
 * task-kind leaf it imports is pure at load too — the ingest requires this module from /app/dist).
 */

import { isTaskKind, TaskKind } from './task-kind';

export const MODEL_BENCH_STORE_NS: string[] = ['instance', 'model-bench'];
export const MODEL_BENCH_STORE_KEY = 'scorecard';
/** Chat-title prefix the bench writes and the ingest selects on: `model-bench <runId> q<idx> <spec>[ k:<kind>]`. */
export const MODEL_BENCH_TITLE_PREFIX = 'model-bench';
/** The one account the bench may run on (AGENTS.md "Canonical prod test account" — never a real user). */
export const MODEL_BENCH_ACCOUNT_EMAIL = 'claudebot@digby.ai';
export const MODEL_BENCH_ALL_LANE = 'all';
export const MODEL_BENCH_NO_LANE = 'none';
export const MODEL_BENCH_UPDATED_BY = 'model-bench-ingest';
/** The scorecard keeps at most this many run ids (oldest dropped first). */
export const MODEL_BENCH_MAX_RUNS = 100;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
// The title shape. The `k:` token is OPTIONAL and STRICT (`k:` + lowercase letters only): a spec can never contain a
// space, so 'model-bench r1 q1 glm 5.3' still fails to parse (the 'extra words' refusal both twins pin).
const TITLE_RE = /^model-bench (\S+) q(\d+) (\S+)(?: k:([a-z]+))?$/;
// A stored kind-bucket key: any short lowercase word, not only today's TASK_KINDS — normalize must not drop buckets a
// later vocabulary wrote (a rollback that ingests once already loses them; a read never should).
const KIND_KEY_RE = /^[a-z]{1,32}$/;
// Rows that are NOT a turn's answer — mirrors live-chat-audit.ts SIDE_KINDS and the query suite's SIDE_KINDS /
// SIDE_ORIGINS (a late Double Checker addendum, Deeper findings, a hand-off, a control note, a verifier row).
const SIDE_KINDS = new Set(['deeper_findings', 'continuation_result', 'deliverable_handoff', 'control_note', 'check_addendum', 'council_addendum']);
const SIDE_ORIGINS = new Set(['machine', 'agent', 'deliverable_handoff',
  // Ticket 9ecabc73: a background tool result posted at/after run end is a harness
  // report about a call, never a turn's answer. (`background_worker` — its sibling —
  // has the same gap; listed here too so neither can be picked as a bench answer.)
  'background_tool', 'background_worker']);
/**
 * Web tools whose calls happen BEFORE the first answer word on a real turn (roster 2026-10-06 C-2): the bench counts
 * them per answer so the picker's tool-aware latency model (model-evidence.ts) can subtract the tool use a bench
 * bucket already contains. The Python twin is scripts/e2e/model-bench.py WEB_TOOL_NAMES.
 */
export const BENCH_WEB_TOOL_NAMES: ReadonlySet<string> = new Set([
  'search_engine', 'scrape_as_markdown', 'scrape_as_html', 'scrape_batch', 'browser_task', 'web_pipe', 'youtube_pipe',
]);

export interface ModelBenchLaneStats {
  /** Attempts attributed to the spec in this lane (measured + failed + failover). */
  n: number;
  /** Server-side time to the first answer chunk (metadata.ux.ttftMs) over MEASURED rows; null when none. */
  ttftP50Ms: number | null;
  ttftP90Ms: number | null;
  /** Server-side completion time (metadata.ux.completionMs) over MEASURED rows. */
  doneP50Ms: number | null;
  /** (failed + failover) / n, 0..1 (4 decimals). */
  failRate: number;
  /** Mean quality 1..5 over judged MEASURED rows (2 decimals; a comparative rank mapped onto 1..5 — see the ingest); null when none judged. */
  quality: number | null;
  qualityN: number;
  /** Mean web tool calls per MEASURED answer (2 decimals) over rows whose parts were read (roster 2026-10-06 C-2).
   *  ABSENT on buckets ingested before the count existed (and when no measured row carried one) — the picker then
   *  assumes the bench made no web calls. */
  webToolsMean?: number | null;
  /** Median answer length (chars of the answer row's text) over MEASURED rows whose length was read (judge v2,
   *  2026-10-20 — the scorecard can show the length a bucket's quality was earned at). ABSENT on buckets ingested
   *  before the length existed (and when no measured row carried one). */
  answerCharsP50?: number | null;
  /** Which judge ranked this bucket's quality — e.g. 'v2:2xK' (judge v2: a 2-judge family-excluding panel × K
   *  position-rotated ballots for K answers — a cyclic Latin square; '+lc' = length-controlled). ABSENT = the single
   *  v1 judge (or an older ingest), and on a bucket with no judged quality. */
  qualityJudge?: string;
  /** The bench run this bucket was measured in. */
  runId: string;
  /** When it was measured (the newest answer in the bucket), ISO. */
  at: string;
}

/** A per-task-kind bucket: the lane stats over the rows of that kind + the run's field size for that kind. */
export interface ModelBenchKindStats extends ModelBenchLaneStats {
  /** Distinct specs MEASURED on this kind in the run that produced the bucket (the comparative judge's field — rank
   *  quality from a K-model field is only comparable within the same field). null on a stored bucket without it. */
  fieldSize: number | null;
}

export interface ModelBenchModelCard {
  lanes: Record<string, ModelBenchLaneStats>;
  /** Per task kind (platform/task-kind.ts TASK_KINDS); ABSENT when the spec has no kind rows. */
  kinds?: Record<string, ModelBenchKindStats>;
}

export interface ModelBenchScorecard {
  updatedAt: string;
  updatedBy: string;
  runs: string[];
  models: Record<string, ModelBenchModelCard>;
}

/** One (question, model) chat of a bench run, as the ingest read it. */
export interface ModelBenchRow {
  runId: string;
  spec: string;
  questionIdx: number;
  chatId?: string;
  /** metadata.depth.turnPlan.lane of the answer (null = no turn plan / no answer). */
  lane: string | null;
  /** metadata.depth.plan.lane — 'quick' when the Quick lane RAN the turn. */
  planLane: string | null;
  /** metadata.models.digby.modelUsed — the model that actually led. */
  modelUsed: string | null;
  ttftMs: number | null;
  completionMs: number | null;
  /** An answer row exists for the bench question. */
  answered: boolean;
  empty: boolean;
  leadError: string | null;
  /** Quality 1..5 (the comparative rank mapped onto 1..5, or the absolute fallback score; null = not judged). */
  quality: number | null;
  qualityIssue?: string | null;
  /** Web tool calls in the answer row's parts (BENCH_WEB_TOOL_NAMES); null when the row's parts were not read /
   *  not an array (legacy ingest). roster 2026-10-06 C-2. */
  webToolCalls?: number | null;
  /** The answer row's text length in chars (what the judge read, before its review cut) — judge v2's length
   *  diagnostics (2026-10-20). Present only when an answer row exists. */
  answerChars?: number;
  /** The answer row's createdAt, ISO. */
  at?: string | null;
  /** The bench's intended task kind (the title's `k:<kind>` token). Present only when the title carried one. */
  kind?: TaskKind | null;
  /** The answer's classified task kind (metadata.depth.turnPlan.taskKind.kind). Present only when stamped. */
  planKind?: TaskKind | null;
}

export type ModelBenchAttribution = 'measured' | 'failed' | 'failover' | 'diverted' | 'unverified';

/** A parsed bench title. `kind` is present ONLY when the title carried a known `k:<kind>` token. */
export interface ParsedBenchTitle { runId: string; questionIdx: number; spec: string; kind?: TaskKind }

interface MessageLike { id?: string; role?: string | null; content?: string | null; metadata?: unknown; parts?: unknown; createdAt?: Date | string | null }

const asRecord = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});
const num = (v: unknown): number | null => (v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function isValidBenchRunId(runId: unknown): runId is string {
  return typeof runId === 'string' && RUN_ID_RE.test(runId);
}

/** The bench chat title (scripts/e2e/model-bench.py `bench_title` is its twin); the `k:<kind>` token only for a
 *  known task kind (anything else writes no token). Pure. */
export function benchTitle(runId: string, questionIdx: number, spec: string, kind?: string | null): string {
  return `${MODEL_BENCH_TITLE_PREFIX} ${runId} q${questionIdx} ${spec}${isTaskKind(kind) ? ` k:${kind}` : ''}`;
}

/**
 * `model-bench <runId> q<idx> <spec>[ k:<kind>]` → its parts, or null for any other title. An UNKNOWN kind token
 * (a later vocabulary) parses with no `kind` — the row still counts by lane, never dropped. Pure.
 */
export function parseBenchTitle(title: unknown): ParsedBenchTitle | null {
  const m = String(title ?? '').match(TITLE_RE);
  if (!m || !isValidBenchRunId(m[1])) return null;
  const questionIdx = Number(m[2]);
  if (!Number.isSafeInteger(questionIdx) || questionIdx < 1) return null;
  return { runId: m[1], questionIdx, spec: m[3], ...(isTaskKind(m[4]) ? { kind: m[4] } : {}) };
}

/** The kind bucket a row files under: the title kind, else the answer's classified kind, else none. Pure. */
export function benchRowKind(row: Pick<ModelBenchRow, 'kind' | 'planKind'>): TaskKind | null {
  if (isTaskKind(row?.kind)) return row.kind;
  if (isTaskKind(row?.planKind)) return row.planKind;
  return null;
}

/** Whether an assistant row is a SIDE row (never a turn's answer). Pure. */
export function isBenchSideRow(metadata: unknown): boolean {
  const md = asRecord(metadata);
  return SIDE_KINDS.has(String(md.kind ?? '')) || !!md.verifier || SIDE_ORIGINS.has(String(md.origin ?? ''));
}

/**
 * The bench question and its answer: the FIRST user row and the first non-side assistant row after it (rows in
 * createdAt order). null when no user row exists (the question was never sent). Pure.
 */
export function pickBenchTurn<T extends MessageLike>(messages: T[]): { user: T; answer: T | null } | null {
  const rows = Array.isArray(messages) ? messages : [];
  const u = rows.findIndex((m) => m?.role === 'user');
  if (u < 0) return null;
  const answer = rows.slice(u + 1).find((m) => m?.role === 'assistant' && !isBenchSideRow(m.metadata)) ?? null;
  return { user: rows[u], answer };
}

/** Web tool calls in a message's `parts` (type 'tool_call', name in BENCH_WEB_TOOL_NAMES); null when parts is not an
 *  array — the row was read without parts, or predates the agent engine (roster 2026-10-06 C-2). Pure. */
export function countBenchWebToolCalls(parts: unknown): number | null {
  if (!Array.isArray(parts)) return null;
  return parts.filter((p: any) => p && p.type === 'tool_call' && BENCH_WEB_TOOL_NAMES.has(String(p.name ?? ''))).length;
}

/** One bench chat (its parsed title + its picked turn) → a ModelBenchRow (quality unset). Pure. */
export function benchRowFromTurn(
  title: ParsedBenchTitle & { chatId?: string },
  turn: { user: MessageLike; answer: MessageLike | null },
): ModelBenchRow {
  const a = turn.answer;
  const md = asRecord(a?.metadata);
  const depth = asRecord(md.depth);
  const lead = asRecord(asRecord(md.models).digby);
  const ux = asRecord(md.ux);
  const content = typeof a?.content === 'string' ? a.content : '';
  const created = a?.createdAt ? new Date(a.createdAt as any) : null;
  const planKind = asRecord(asRecord(depth.turnPlan).taskKind).kind;
  return {
    runId: title.runId,
    spec: title.spec,
    questionIdx: title.questionIdx,
    ...(title.chatId ? { chatId: title.chatId } : {}),
    lane: str(asRecord(depth.turnPlan).lane),
    planLane: str(asRecord(depth.plan).lane),
    modelUsed: str(lead.modelUsed),
    ttftMs: num(ux.ttftMs),
    completionMs: num(ux.completionMs),
    answered: !!a,
    empty: !content.trim(),
    leadError: str(lead.error),
    quality: null,
    webToolCalls: a ? countBenchWebToolCalls(a.parts) : null,
    // judge v2 (2026-10-20): the answer's length — present only when an answer row exists.
    ...(a ? { answerChars: content.length } : {}),
    at: created && Number.isFinite(created.getTime()) ? created.toISOString() : null,
    // 2026-10-20 task kinds: each key only when present, so a kind-less row is byte-identical to before.
    ...(isTaskKind(title.kind) ? { kind: title.kind } : {}),
    ...(isTaskKind(planKind) ? { planKind } : {}),
  };
}

/** How a row counts for its spec (see the header). Pure. */
export function attributeBenchRow(row: ModelBenchRow): ModelBenchAttribution {
  if (row.modelUsed && row.modelUsed !== row.spec && row.planLane === 'quick') return 'diverted';
  if (!row.answered || row.empty || row.leadError) return 'failed';
  if (!row.modelUsed) return 'unverified';
  return row.modelUsed === row.spec ? 'measured' : 'failover';
}

/** Nearest-rank percentile — the same rule as live-chat-audit.ts percentile. Pure. */
export function benchPercentile(xs: Array<number | null | undefined>, q: number): number | null {
  const a = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))];
}

const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;

/** Shape of a qualityJudge stamp (judge v2: 'v2:<judges>xK[+lc]'; any short token a later ingest writes). */
const QUALITY_JUDGE_RE = /^[A-Za-z0-9:+._-]{1,64}$/;

function laneStats(rows: ModelBenchRow[], opts: { runId?: string; at?: string; qualityJudge?: string }): ModelBenchLaneStats {
  const measured = rows.filter((r) => attributeBenchRow(r) === 'measured');
  const failures = rows.length - measured.length;
  const judged = measured.map((r) => r.quality).filter((q): q is number => typeof q === 'number' && Number.isFinite(q));
  const runIds = [...new Set(rows.map((r) => r.runId))].sort();
  const ats = rows.map((r) => r.at).filter((x): x is string => !!x && Number.isFinite(Date.parse(x))).sort();
  const ms = (x: number | null) => (x === null ? null : Math.round(x));
  // roster 2026-10-06 C-2: mean web calls per measured answer, only when some row's parts were read (an old ingest's
  // rows carry none — the key stays absent so the stored bucket shape is unchanged).
  const toolCounts = measured.map((r) => r.webToolCalls).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  // judge v2 (2026-10-20): the median answer length over measured rows that carry one, and the judge stamp on a
  // bucket that holds judged quality — each key only when present (an older ingest's buckets keep their shape).
  const charsP50 = benchPercentile(measured.map((r) => r.answerChars), 0.5);
  const stamp = typeof opts.qualityJudge === 'string' && QUALITY_JUDGE_RE.test(opts.qualityJudge) && judged.length ? opts.qualityJudge : null;
  return {
    n: rows.length,
    ttftP50Ms: ms(benchPercentile(measured.map((r) => r.ttftMs), 0.5)),
    ttftP90Ms: ms(benchPercentile(measured.map((r) => r.ttftMs), 0.9)),
    doneP50Ms: ms(benchPercentile(measured.map((r) => r.completionMs), 0.5)),
    failRate: rows.length ? round(failures / rows.length, 4) : 0,
    quality: judged.length ? round(judged.reduce((s, q) => s + q, 0) / judged.length, 2) : null,
    qualityN: judged.length,
    ...(toolCounts.length ? { webToolsMean: round(toolCounts.reduce((sum, x) => sum + x, 0) / toolCounts.length, 2) } : {}),
    ...(charsP50 !== null ? { answerCharsP50: Math.round(charsP50) } : {}),
    ...(stamp ? { qualityJudge: stamp } : {}),
    runId: opts.runId ?? runIds.join('+'),
    at: opts.at ?? ats[ats.length - 1] ?? new Date().toISOString(),
  };
}

/** A model card with `kinds` only when it holds one (a kind-less card keeps the pre-kind shape exactly). Pure. */
function cardOf(lanes: Record<string, ModelBenchLaneStats>, kinds: Record<string, ModelBenchKindStats>): ModelBenchModelCard {
  return Object.keys(kinds).length ? { lanes, kinds } : { lanes };
}

/**
 * Bench rows → a scorecard: per spec, per lane (the answer's turn-plan lane, 'none' when absent) + 'all', and per
 * task kind (benchRowKind — `kinds` only on a spec that has kind rows; each bucket with the kind's field size).
 * Diverted and unverified rows are left out; a spec with nothing attributable is omitted. `opts.qualityJudge` (judge
 * v2) stamps every bucket that holds judged quality. Pure (opts.now pins updatedAt).
 */
export function aggregateBenchRows(
  rows: ModelBenchRow[],
  opts: { runId?: string; at?: string; updatedBy?: string; now?: Date; qualityJudge?: string } = {},
): ModelBenchScorecard {
  const counted = (Array.isArray(rows) ? rows : []).filter((r) => r && r.spec && !['diverted', 'unverified'].includes(attributeBenchRow(r)));
  const bySpec = new Map<string, ModelBenchRow[]>();
  for (const r of counted) bySpec.set(r.spec, [...(bySpec.get(r.spec) ?? []), r]);
  // The field per kind: distinct specs with at least one MEASURED row of that kind (the comparative judge ranked at
  // most that many answers per question — the reader needs it to compare rank-scale buckets fairly).
  const field = new Map<TaskKind, Set<string>>();
  for (const r of counted) {
    const k = benchRowKind(r);
    if (k && attributeBenchRow(r) === 'measured') field.set(k, (field.get(k) ?? new Set<string>()).add(r.spec));
  }
  const models: Record<string, ModelBenchModelCard> = {};
  for (const [spec, specRows] of [...bySpec.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const byLane = new Map<string, ModelBenchRow[]>();
    const byKind = new Map<TaskKind, ModelBenchRow[]>();
    for (const r of specRows) {
      const lane = r.lane || MODEL_BENCH_NO_LANE;
      byLane.set(lane, [...(byLane.get(lane) ?? []), r]);
      const k = benchRowKind(r);
      if (k) byKind.set(k, [...(byKind.get(k) ?? []), r]);
    }
    const lanes: Record<string, ModelBenchLaneStats> = { [MODEL_BENCH_ALL_LANE]: laneStats(specRows, opts) };
    for (const [lane, laneRows] of [...byLane.entries()].sort(([a], [b]) => a.localeCompare(b))) lanes[lane] = laneStats(laneRows, opts);
    const kinds: Record<string, ModelBenchKindStats> = {};
    for (const [k, kindRows] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      kinds[k] = { ...laneStats(kindRows, opts), fieldSize: field.get(k)?.size ?? 0 };
    }
    models[spec] = cardOf(lanes, kinds);
  }
  const runs = [...new Set((Array.isArray(rows) ? rows : []).map((r) => r?.runId).filter(isValidBenchRunId))];
  return {
    updatedAt: (opts.now ?? new Date()).toISOString(),
    updatedBy: opts.updatedBy ?? MODEL_BENCH_UPDATED_BY,
    runs: opts.runId && !runs.includes(opts.runId) ? [...runs, opts.runId] : runs,
    models,
  };
}

function normalizeLaneStats(v: unknown): ModelBenchLaneStats | null {
  const s = asRecord(v);
  const n = num(s.n);
  const failRate = num(s.failRate);
  if (n === null || n < 0 || failRate === null || typeof s.runId !== 'string' || typeof s.at !== 'string') return null;
  return {
    n,
    ttftP50Ms: num(s.ttftP50Ms),
    ttftP90Ms: num(s.ttftP90Ms),
    doneP50Ms: num(s.doneP50Ms),
    failRate,
    quality: num(s.quality),
    qualityN: num(s.qualityN) ?? 0,
    // roster 2026-10-06 C-2: kept only when stored (old buckets stay byte-identical through a merge).
    ...(s.webToolsMean !== undefined ? { webToolsMean: num(s.webToolsMean) } : {}),
    // judge v2 (2026-10-20): the same rule — present only when stored (a malformed stamp is dropped).
    ...(s.answerCharsP50 !== undefined ? { answerCharsP50: num(s.answerCharsP50) } : {}),
    ...(typeof s.qualityJudge === 'string' && QUALITY_JUDGE_RE.test(s.qualityJudge) ? { qualityJudge: s.qualityJudge } : {}),
    runId: s.runId,
    at: s.at,
  };
}

function normalizeKindStats(v: unknown): ModelBenchKindStats | null {
  const base = normalizeLaneStats(v);
  if (!base) return null;
  const fieldSize = num(asRecord(v).fieldSize);
  return { ...base, fieldSize: fieldSize !== null && fieldSize >= 0 ? fieldSize : null };
}

/**
 * A stored value → a well-formed scorecard (malformed buckets dropped), or null when it is not one. A model is kept
 * when it has lane OR kind buckets (2026-10-20: `kinds` is carried — a normalize that rebuilt {lanes} only would
 * erase every kind bucket on the next merge). Pure.
 */
export function normalizeScorecard(v: unknown): ModelBenchScorecard | null {
  const s = asRecord(v);
  const rawModels = asRecord(s.models);
  if (!s.models || typeof s.models !== 'object') return null;
  const models: Record<string, ModelBenchModelCard> = {};
  for (const [spec, card] of Object.entries(rawModels)) {
    const lanes: Record<string, ModelBenchLaneStats> = {};
    for (const [lane, stats] of Object.entries(asRecord(asRecord(card).lanes))) {
      const ok = normalizeLaneStats(stats);
      if (ok) lanes[lane] = ok;
    }
    const kinds: Record<string, ModelBenchKindStats> = {};
    for (const [kind, stats] of Object.entries(asRecord(asRecord(card).kinds))) {
      const ok = KIND_KEY_RE.test(kind) ? normalizeKindStats(stats) : null;
      if (ok) kinds[kind] = ok;
    }
    if (Object.keys(lanes).length || Object.keys(kinds).length) models[spec] = cardOf(lanes, kinds);
  }
  return {
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : '',
    updatedBy: typeof s.updatedBy === 'string' ? s.updatedBy : '',
    runs: Array.isArray(s.runs) ? s.runs.filter((r: unknown): r is string => typeof r === 'string') : [],
    models,
  };
}

/**
 * A kind bucket this deep (JUDGED answers) is never replaced by a thinner one (2026-10-20 review). MIRRORS
 * model-evidence.ts BENCH_KIND_MIN_N — the picker's usable-bucket floor (below it the pick ignores a kind bucket and
 * falls back to lane evidence); model-evidence imports this module, so the value is mirrored here, never imported,
 * and the backend jest pins KIND_BUCKET_KEEP_MIN_N === BENCH_KIND_MIN_N. Why: a routine refresh run files 1–4 rows
 * per (spec, kind) (the answer's classified kind keys a bucket even with no title token), and newer-`at`-wins let
 * that thin bucket REPLACE the ≥ 8-answer bucket a dedicated paid kind run built — the pick then lost its kind
 * evidence until the next kind run.
 */
export const KIND_BUCKET_KEEP_MIN_N = 8;

const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Judged answers behind a bucket's quality: qualityN when the quality is a finite number, else 0 (a stored row
 *  carrying a count but no score is not judged — the same test the picker's usableKindBucket applies). Pure. */
function judgedN(b: { quality: number | null; qualityN: number }): number {
  return finiteNum(b.quality) ? Math.max(0, Number(b.qualityN) || 0) : 0;
}

/**
 * ONE bucket merge — `next` (the run being ingested) over `old` (the stored bucket), never throws. Pure. In order:
 *  1. newer-`at` wins: `old` stays when it was measured LATER (a re-ingest of an older run never clobbers it);
 *  2. KIND buckets only (`keepDeepMinN` set): a DEEP stored bucket (≥ keepDeepMinN judged) is kept WHOLE against a
 *     THIN incoming one (< keepDeepMinN judged) — the picker could not use the thin one, and only quality is read
 *     from a kind bucket (latency / failRate stay (spec, lane)), so nothing the pick reads goes stale. A thin bucket
 *     is still dropped when the stored one is deep, even from a dedicated kind run: ask ≥ 8 per kind to refresh one;
 *  3. judged quality is never erased: an incoming bucket with NO judged quality (quality not a finite number, or
 *     qualityN 0 — a `--no-judge` ingest, singletons left unjudged, every judge call lost) keeps the stored bucket's
 *     quality + qualityN (and its qualityJudge stamp, judge v2) and takes the newer n / latency / failRate /
 *     webToolsMean / answerCharsP50 / runId / at as before. Before, an
 *     unattended run whose questions were all singletons wiped the judged quality and the pick read "seat
 *     unmeasured" and stopped switching. Note the bucket's runId / at then name the newer (latency) run while its
 *     quality was ranked in an older one; on a KIND bucket that only happens below the keep floor (rule 2 keeps a
 *     deep one whole), where the pick reads neither the kind quality nor its run id (model-evidence qualityRunId);
 *  4. otherwise `next` replaces `old`.
 */
function mergeBucket<T extends ModelBenchLaneStats>(old: T | undefined, next: T, keepDeepMinN: number | null): T {
  if (!old) return next;
  if (Date.parse(old.at) > Date.parse(next.at)) return old;
  if (keepDeepMinN && judgedN(old) >= keepDeepMinN && judgedN(next) < keepDeepMinN) return old;
  // The kept quality keeps the stamp of the judge that ranked it (judge v2) — never the unjudged run's (it has none).
  if (!(finiteNum(next.quality) && next.qualityN > 0) && finiteNum(old.quality)) {
    const { qualityJudge: _unjudgedStamp, ...rest } = next;
    return { ...rest, quality: old.quality, qualityN: old.qualityN, ...(old.qualityJudge ? { qualityJudge: old.qualityJudge } : {}) } as T;
  }
  return next;
}

/** `from`'s buckets merged over `into`'s one by one (mergeBucket — `keepDeepMinN` for kind buckets only). Mutates +
 *  returns `into`. */
function mergeNewer<T extends ModelBenchLaneStats>(into: Record<string, T>, from: Record<string, T>, keepDeepMinN: number | null = null): Record<string, T> {
  for (const [key, stats] of Object.entries(from)) into[key] = mergeBucket(into[key], stats, keepDeepMinN);
  return into;
}

/**
 * prev ⊕ next: next's buckets REPLACE prev's for the same spec + lane (and the same spec + kind) unless prev's
 * bucket was measured LATER (a re-ingest of an older run never clobbers a newer measurement); a bucket with no judged
 * quality never erases a stored judged quality; a THIN kind bucket never replaces a DEEP one (mergeBucket,
 * KIND_BUCKET_KEEP_MIN_N); other buckets are kept; runs are unioned (oldest first, capped at MODEL_BENCH_MAX_RUNS).
 * Pure.
 */
export function mergeScorecards(prev: ModelBenchScorecard | null | undefined, next: ModelBenchScorecard): ModelBenchScorecard {
  const p = normalizeScorecard(prev);
  const n = normalizeScorecard(next) ?? { updatedAt: next?.updatedAt ?? '', updatedBy: next?.updatedBy ?? '', runs: [], models: {} };
  const models: Record<string, ModelBenchModelCard> = {};
  for (const [spec, card] of Object.entries(p?.models ?? {})) models[spec] = cardOf({ ...card.lanes }, { ...(card.kinds ?? {}) });
  for (const [spec, card] of Object.entries(n.models)) {
    models[spec] = cardOf(
      mergeNewer({ ...(models[spec]?.lanes ?? {}) }, card.lanes),
      mergeNewer({ ...(models[spec]?.kinds ?? {}) }, card.kinds ?? {}, KIND_BUCKET_KEEP_MIN_N),
    );
  }
  const runs = [...new Set([...(p?.runs ?? []), ...n.runs])];
  return {
    updatedAt: n.updatedAt || new Date().toISOString(),
    updatedBy: n.updatedBy || MODEL_BENCH_UPDATED_BY,
    runs: runs.slice(Math.max(0, runs.length - MODEL_BENCH_MAX_RUNS)),
    models,
  };
}

const READ_CACHE_MS = 60_000;
let readCache: { at: number; value: ModelBenchScorecard | null } | null = null;

/** Drop the read cache (tests; the ingest reads with `fresh`). */
export function clearModelBenchScorecardCache(): void { readCache = null; }

/**
 * The stored scorecard (normalized), or null when absent / unreadable. Never throws. Cached 60 s per process
 * (the picker may ask on every human turn); `fresh: true` bypasses the cache.
 */
export async function readModelBenchScorecard(opts: { fresh?: boolean } = {}): Promise<ModelBenchScorecard | null> {
  if (!opts.fresh && readCache && Date.now() - readCache.at < READ_CACHE_MS) return readCache.value;
  try {
    const { storeGet } = await import('../memory/context-store');
    const raw = await storeGet<unknown>(MODEL_BENCH_STORE_NS, MODEL_BENCH_STORE_KEY);
    const value = raw ? normalizeScorecard(raw) : null;
    readCache = { at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}

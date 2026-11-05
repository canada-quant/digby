#!/usr/bin/env node
/**
 * model-bench-ingest.js — turn ONE offline model-bench run into the per-model SCORECARD the picker reads (2026-10-04).
 *
 * scripts/e2e/model-bench.py ran the same human-corpus questions on several lead models through the real chat
 * pipeline on the canonical test account, one chat per (question, model), titled `model-bench <runId> q<idx> <spec>`
 * (+ an optional trailing `k:<kind>` task-kind token since 2026-10-20).
 * This script runs INSIDE the backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   1. finds that account's chats of the run (title prefix `model-bench <runId> `), parses spec + question idx (+ the
 *      title's task kind — the leaf's parseBenchTitle);
 *   2. per chat: the first user row + the answer row after it (side rows skipped — a late check addendum, Deeper
 *      findings, a hand-off, a control note, a machine / agent row); metadata.ux.ttftMs / completionMs,
 *      metadata.models.digby.modelUsed (who ACTUALLY led), metadata.depth.turnPlan.lane and the answer's classified
 *      task kind (metadata.depth.turnPlan.taskKind.kind → planKind: the row's kind bucket when the title has none);
 *   3. judges every MEASURED answer (the spec led) BLIND + COMPARATIVELY. JUDGE V2 (2026-10-20, the DEFAULT — owner:
 *      "fix the model benchmarks"; the single qwen judge rewarded LENGTH: the scorecard put the longest-answering model
 *      first in every kind, a blind two-pass re-judge did not): a PANEL of judges (--judge-panel, default
 *      DEFAULT_JUDGE_PANEL — open, non-frontier, distinct families, safe as NON-STREAMING calls) ranks each question
 *      group on the length-blind COMPARATIVE_RUBRIC_V2 (live-chat-audit.ts — a cut answer is marked, never read as
 *      unfinished). SELF-FAMILY EXCLUSION: each judge ranks only the answers whose model family differs from its own
 *      (a judge left with < 2 answers sits the question out), so no judge ever ranks its own family. Each judge casts
 *      K ballots per question, K = the answers it ranks: a CYCLIC LATIN SQUARE of a seeded shuffle (ballot o = the
 *      shuffle rotated by o), relabelled A/B/C… by position per ballot — every answer sits in every slot exactly once,
 *      so ANY position bias (first, last, middle) averages out per answer (a forward + reverse pair left the middle
 *      answer of an odd K in place, under the same label, on both ballots). A ballot must rank EVERY label exactly once
 *      (a partial ranking is a failed ballot, retried up to --judge-attempts — v1 filled the missing labels in by
 *      presentation position). Aggregation is PAIRWISE: an answer's win rate against each other answer of the group,
 *      over the ballots that ranked both, averaged over its opponents; quality = round2(1 + 4 · that mean) (the same
 *      1..5 scale, mean 3 — on complete ballots it equals the mean of (k − r)/(k − 1), so one ballot of K = 3 is v1's
 *      5/3/1). A ballot that left out its judge's family therefore only speaks for the pairs it holds, so an answer's
 *      score never depends on which rows another ballot left out (a plain mean of per-ballot scores over ballots of
 *      different sizes tilted the judge family's own candidate). QUORUM: every answer of a group needs --min-ballots
 *      (default 2) successful ballots. A group in which some answer CANNOT get that many from this panel (every judge
 *      that could rank it sits out — decided from the ballot plan, before any call) is UNRANKABLE: left unjudged like
 *      a singleton, no judge call made, never refused on its own. A rankable group whose ballots then FAILED below the
 *      quorum is a failed comparative group (its answers carry no quality — v2 never mixes the absolute scale in; an
 *      UNATTENDED run refuses exactly as below). Optional --length-control removes the panel's remaining length slope
 *      (the pooled OLS of each answer's pairwise score on its mean ln(answer chars) gap to its opponents; each pair
 *      outcome then becomes w' = clamp(w − β·Δ, 0, 1), Δ = the pair's ln-length gap).
 *      The RESULT carries the diagnostics (numbers only): position consistency per judge (the mean Kendall τ between
 *      its re-ordered ballots of one question, and how often they agree on the top answer), the per-group Spearman ρ
 *      of ln(length) vs score, how often the longest answer won, the ballots cast / failed, the unrankable groups and,
 *      with --per-question, each question's scores and answer lengths per spec (no text) — for a comparison against an
 *      external gold ranking. Every judged bucket is stamped qualityJudge 'v2:<judges>xK'.
 *      `--judge-version v1` restores the single judge below EXACTLY (calls, scores, log, RESULT):
 *      V1 (P1.3, 2026-10-06): rows are grouped
 *      per question (same questionIdx), anonymized to labels A/B/C… with a seeded shuffle, and each group is
 *      ranked best-first by the nightly live-chat audit's comparative judge (live-chat-audit.ts
 *      defaultComparativeJudge: COMPARATIVE_RUBRIC on the Utility seat, thinking on) → rank 1..K mapped onto
 *      the scorecard's 1..5 quality scale. A SINGLETON group (only one model measured on that question — the
 *      others failed, failed over or were diverted) is left UNJUDGED (2026-10-20): a lone answer has no rank, and
 *      an absolute score would mix scales on the comparative scorecard; it still counts in n / latency / failRate.
 *      A judge-family conflict with a candidate, a missing comparative judge, or a failed judge call falls back to
 *      per-answer absolute scoring (defaultQualityJudge: QUALITY_RUBRIC — same family risk disclosed by the ⚠
 *      warnings) — ATTENDED runs only: an UNATTENDED run (no tty — systemd-run / prodq.sh docker exec / CI;
 *      28d9e351) REFUSES instead (exit 1, nothing written) so absolute-scale rows can never land silently on a
 *      comparative scorecard (singletons no longer trip it — one failed model must not sink a whole unattended run;
 *      but an ALL-singleton run — answers measured, 0 comparative groups — is a broken run, not a refresh, and an
 *      unattended ingest REFUSES it too: allSingletonRun, 2026-10-20 review);
 *   4. aggregates per spec per lane (+ 'all') and per task kind (models[spec].kinds, each bucket with the kind's
 *      field size) with the compiled leaf model-bench-scorecard.ts (aggregateBenchRows — no logic duplicated here)
 *      and prints the summary + a kind-agreement line (the title's kind vs the answer's classified kind, counts only —
 *      a free calibration readout for the task_kind decision);
 *   5. with --apply: MERGES into the context-store row ['instance','model-bench'] / 'scorecard' (mergeScorecards — a
 *      newer run replaces the same spec + lane bucket and the same spec + kind bucket, except that a quality-null
 *      bucket never erases judged quality and a thin kind bucket never replaces a deep one); with --cleanup (needs
 *      --apply): deletes the run's chats through crossModelService.deleteChat (the canonical delete path).
 *
 * Usage (prodq.sh does NOT forward the caller's environment into the container — pass flags):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh model-bench-ingest.js --run-id mb1004a                 # dry run
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh model-bench-ingest.js --run-id mb1004a --apply         # write
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh model-bench-ingest.js --run-id mb1004a --apply --cleanup
 * Flags: --run-id <id> (required) · --apply · --cleanup · --no-judge · --judge-version v2|v1 (default v2) ·
 *   --judge-panel a,b[,c] (v2: pin the panel — specs of DISTINCT model families; default DEFAULT_JUDGE_PANEL) ·
 *   --min-ballots N (v2 quorum per answer, default 2, ≤ 12) · --length-control (v2) · --per-question (v2: the
 *   per-question scores + lengths in RESULT) · --judge-model <spec> (v1, P1.5: pin the comparative judge to one model —
 *   a built-in id or '<label>:<modelId>'; without it, a Utility seat that shares a family with a bench candidate
 *   auto-picks a conflict-free judge from the model catalog; under v2 it pins a ONE-judge panel) · --judge-concurrency
 *   N (≤ 8; v1 default 4 question groups = 4 calls; v2 counts judge CALLS, default 8) · --judge-attempts N (default 3,
 *   ≤ 5; per call) · --verbose
 *   · --unattended (28d9e351: acknowledge the no-tty refuse — systemd-run / CI / docker-exec contexts that NEED to
 *   run judgeless-with-fallback pin --judge-model or pass --unattended --no-judge explicitly; --no-judge never writes
 *   quality, so it never triggers the refuse)
 * Env twins (for `docker exec -e` / local runs): RUN_ID, APPLY=1, CLEANUP=1, NO_JUDGE=1, JUDGE_CONCURRENCY, JUDGE_MODEL,
 *   JUDGE_ATTEMPTS, JUDGE_VERSION, JUDGE_PANEL, MIN_BALLOTS, LENGTH_CONTROL=1, PER_QUESTION=1, UNATTENDED=1.
 * Judging N × M answers takes minutes (≤ 120 s a call; v1 one call per question group, 4 at a time; v2 K calls per
 * panel judge per group — ≈ 5 × the calls with the default panel on a 3-model bench, 8 at a time): run it DETACHED for a big run
 * (`systemd-run --collect …` — the ec2-ops ssh session broken-pipes on long-silent streams).
 * Output: human-readable lines, then ONE `RESULT {json}` line (aggregates only — never question or answer text).
 * Exit: 0 ok · 1 runtime error (nothing written) · 2 usage · 3 runtime modules unavailable.
 */
'use strict';

const DIST = process.env.MODEL_BENCH_DIST || '/app/dist';
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());

// 28d9e351: the DEFAULT judge spec an UNATTENDED comparative ingest pins itself to when --judge-model is absent —
// the family-conflict auto-pick once chose a route the gateway had retired but the endpoint registry still listed
// (cql-litellm:api-cohere-command-a-plus, every call 400), and 95 absolute-scale rows landed on the comparative
// scorecard before anyone looked. A pinned known-good default beats re-deriving the pick on every unattended run;
// keep it conflict-free with the bench's usual LEAD candidates (glm/kimi/deepseek) and re-pin when the route changes.
// 2026-10-20: re-pinned from cql-litellm:spark-mimo-v26-flash-rl (the gateway mimo route left the catalog) to the
// built-in qwen3.6-27b — a bench that includes a qwen candidate must pass --judge-model (the family guard refuses).
const DEFAULT_UNATTENDED_JUDGE = 'qwen3.6-27b';

// Judge v2 (2026-10-20): the DEFAULT panel (attended and unattended alike; --judge-panel pins another). Every member is
// open (non-frontier — the owner's frontier rule), servable on a built-in key, of a DISTINCT family, and safe as a
// NON-STREAMING call through runHelperCompletion: qwen3.6-27b is the proven v1 judge (mbk1020a: 135 groups, 0 failed);
// deepseek-flash has its thinking forced OFF by helper-completion. NOT kimi-k3 (it always reasons and must STREAM —
// a non-streaming call waits 100+ s for the reasoning) and NOT glm-5.3 (its reasoning cannot be turned off and runs at
// max effort); glm-5.3-flash (reasoning 'low', cannot be disabled — it reasons before every answer) is the candidate
// third member once a run proves its 4,000-token judge budget holds — pin it with --judge-panel until then. Self-family
// exclusion means a candidate of a judge's family is simply ranked by the OTHER judges.
const DEFAULT_JUDGE_PANEL = Object.freeze(['qwen3.6-27b', 'deepseek-flash']);
/**
 * v2: the ballots per judge per question group — K of them, K = the answers the judge ranks: a cyclic Latin square of
 * a seeded shuffle, so every answer sits in every slot once (the 2026-10-20 review: a shuffle + its exact reverse left
 * the middle answer of an odd K in the same slot, under the same label, on both ballots). RESULT `ballotDesign`.
 */
const JUDGE_V2_BALLOT_DESIGN = 'cyclic-latin-square';
/** v2: judge CALLS in flight when --judge-concurrency is not given (v1's 4 groups were 4 calls; v2 makes ≈ 5 × them). */
const JUDGE_V2_DEFAULT_CONCURRENCY = 8;
const PANEL_SPEC_RE = /^[A-Za-z0-9._:/@+-]{1,120}$/;
const PANEL_MAX = 6;
// Built-in ids that are NOT safe as a non-streaming judge (a pinned panel may still name them — said in a ⚠ line).
const NON_STREAMING_UNSAFE = Object.freeze({
  'kimi-k3': 'always reasons and must STREAM — a non-streaming judge call waits 100+ s for the reasoning',
  'kimi-k2.6': 'a reasoning model that must stream',
  'glm-5.3': 'its reasoning cannot be turned off and runs at max effort on a non-streaming call',
});
// The closed frontier families (familyOf) — frontier models are reflection-only by owner rule; a pinned judge may be one.
const FRONTIER_FAMILIES = new Set(['claude', 'gpt', 'grok', 'gemini']);

/**
 * Is this invocation UNATTENDED — no human watching the log (28d9e351)? True when stdin is not a tty (the
 * systemd-run / prodq.sh `docker exec -w /app <c> node /tmp/x.js` shape — the CI ingest job, an ec2-ops
 * one-shot, the Framework Operator's run-on-box.sh) or systemd has injected its transient-unit environment
 * ($INVOCATION_ID / $MANAGED_BY=systemd). An explicit flag/env override wins either way:
 * --unattended / UNATTENDED=1 forces it ON, --attended / UNATTENDED=0 (or any falsy value) forces it OFF.
 * Pure (takes the raw pieces; run() passes the real ones).
 */
function unattendedContext({ argv = [], env = {}, isTTY = true } = {}) {
  if (argv.includes('--unattended')) return true;
  if (argv.includes('--attended')) return false;
  const e = String(env.UNATTENDED ?? '').trim().toLowerCase();
  if (e) return truthy(e);
  if (String(env.MANAGED_BY ?? '').trim() === 'systemd' || String(env.INVOCATION_ID ?? '').trim()) return true;
  return !isTTY;
}

function parseArgs(argv, env = {}) {
  const val = (name) => { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] == null ? '' : argv[i + 1]) : null; };
  const runId = (val('--run-id') ?? env.RUN_ID ?? '').trim();
  const concRaw = val('--judge-concurrency') ?? env.JUDGE_CONCURRENCY ?? '4';
  const conc = Number.parseInt(concRaw, 10);
  // 2026-10-20: a failed comparative call is RETRIED before the group falls back to absolute scoring — one transient
  // judge failure (a 120 s timeout, an unparseable ranking) otherwise sank a whole UNATTENDED ingest (the 28d9e351
  // refuse) of a 140-group, 2-wave kind run.
  const attemptsRaw = val('--judge-attempts') ?? env.JUDGE_ATTEMPTS ?? '3';
  const attempts = Number.parseInt(attemptsRaw, 10);
  // Judge v2 (2026-10-20): the version (default v2; v1 = the single judge exactly as before), the panel, the quorum.
  const versionRaw = String(val('--judge-version') ?? env.JUDGE_VERSION ?? 'v2').trim().toLowerCase();
  const panelRaw = String(val('--judge-panel') ?? env.JUDGE_PANEL ?? '').trim();
  const panel = panelRaw ? [...new Set(panelRaw.split(',').map((x) => x.trim()).filter(Boolean))] : null;
  const minBallotsRaw = val('--min-ballots') ?? env.MIN_BALLOTS ?? '2';
  const minBallots = Number.parseInt(minBallotsRaw, 10);
  const lengthControl = argv.includes('--length-control') || truthy(env.LENGTH_CONTROL);
  const perQuestion = argv.includes('--per-question') || truthy(env.PER_QUESTION);
  const out = {
    runId,
    apply: argv.includes('--apply') || truthy(env.APPLY),
    cleanup: argv.includes('--cleanup') || truthy(env.CLEANUP),
    judge: !(argv.includes('--no-judge') || truthy(env.NO_JUDGE)),
    // P1.5: pin the comparative judge to ONE model spec (a built-in id or '<label>:<modelId>') — the
    // family-diversity lever when the Utility seat shares a family with bench candidates.
    judgeModel: (val('--judge-model') ?? env.JUDGE_MODEL ?? '').trim() || null,
    judgeConcurrency: Number.isFinite(conc) ? Math.min(8, Math.max(1, conc)) : 4,
    // v2 counts judge CALLS and defaults higher (JUDGE_V2_DEFAULT_CONCURRENCY) — only an explicit value overrides it.
    judgeConcurrencySet: (val('--judge-concurrency') ?? env.JUDGE_CONCURRENCY ?? null) !== null,
    judgeAttempts: Number.isFinite(attempts) ? Math.min(5, Math.max(1, attempts)) : 3,
    judgeVersion: versionRaw,
    judgePanel: panel && panel.length ? panel : null,
    minBallots: Number.isFinite(minBallots) ? Math.min(12, Math.max(1, minBallots)) : 2,
    lengthControl,
    perQuestion,
    verbose: argv.includes('--verbose'),
    error: '',
  };
  const v2Flags = [out.judgePanel ? '--judge-panel' : null, lengthControl ? '--length-control' : null, perQuestion ? '--per-question' : null,
    (val('--min-ballots') ?? env.MIN_BALLOTS ?? null) !== null ? '--min-ballots' : null].filter(Boolean);
  const panelFamilies = (out.judgePanel || []).map(familyOf);
  if (!runId) out.error = 'usage: model-bench-ingest.js --run-id <runId> [--apply] [--cleanup] [--no-judge] [--judge-version v2|v1] [--judge-panel a,b] [--min-ballots N] [--length-control] [--per-question] [--judge-model <spec>] [--judge-concurrency N] [--judge-attempts N]';
  else if (!RUN_ID_RE.test(runId)) out.error = `bad run id ${JSON.stringify(runId)} (letters, digits, . _ - only)`;
  else if (out.cleanup && !out.apply) out.error = '--cleanup deletes the run\'s chats only AFTER the scorecard is written — pass --apply too';
  else if (versionRaw !== 'v1' && versionRaw !== 'v2') out.error = `--judge-version must be v1 or v2 (got ${JSON.stringify(versionRaw.slice(0, 20))})`;
  else if (versionRaw === 'v1' && v2Flags.length) out.error = `${v2Flags.join(' / ')} belong${v2Flags.length === 1 ? 's' : ''} to judge v2 — --judge-version v1 is the single judge exactly as before (drop ${v2Flags.length === 1 ? 'it' : 'them'}, or run v2)`;
  else if (out.judgePanel && out.judgePanel.some((s) => !PANEL_SPEC_RE.test(s))) out.error = '--judge-panel takes comma-separated model specs (built-in ids or <label>:<modelId>; letters, digits, . _ : / @ + -)';
  else if (out.judgePanel && out.judgePanel.length > PANEL_MAX) out.error = `--judge-panel takes at most ${PANEL_MAX} judges`;
  else if (out.judgePanel && new Set(panelFamilies).size !== panelFamilies.length) out.error = `--judge-panel needs judges of DISTINCT model families (families: ${panelFamilies.join(', ')}) — two judges of one family double-count that family's taste`;
  else if (panelFamilies.includes('decision')) out.error = '--judge-panel cannot name a decision model (Laya / Jev / Kev) — they answer typed decisions, not answer rankings';
  return out;
}

/** Run `fn` over `items`, at most `n` at a time. */
async function pool(items, n, fn) {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(n, items.length || 1)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(lanes);
}

// roster 2026-10-06 C-2 + P1.5: the closed frontier families too (claude / gpt / grok / gemini) — the owner opened
// automatic picks to "any and all models", so a frontier candidate must get the judge-family guard like an open one.
const FAMILY_RULES = [
  [/glm|zhipu|z-?ai\b/, 'glm'],
  [/kimi|moonshot/, 'kimi'],
  [/deepseek/, 'deepseek'],
  [/qwen|qwq|dashscope|alibaba/, 'qwen'],
  [/mimo|xiaomi/, 'mimo'],
  [/claude|anthropic/, 'claude'],
  // roster 2026-10-06 C-2: gpt-oss stays its OWN family (ahead of gpt) so the open-weight line keeps its own
  // family — the guard treats a gpt-oss judge as non-conflicting with gpt candidates, by design.
  [/gpt-oss/, 'gpt-oss'],
  [/gpt|openai|\bo[134]\b/, 'gpt'],
  [/grok|xai\b/, 'grok'],
  [/gemini|gemma/, 'gemini'],
  [/llama|meta-/, 'llama'],
  [/mistral|mixtral|codestral/, 'mistral'],
  [/command|cohere/, 'cohere'],
  [/laya|jev|kev\b/, 'decision'],
];
/**
 * The model FAMILY of a spec (a proxy's `<label>:` and vendor prefixes ignored) — the SAME rule set as the
 * platform catalog's modelFamily (model-endpoints/model-catalog.ts FAMILY_RULES), so the ingest's family guard
 * and the catalog's family field agree on what a family is (P1.5: mb1006a's judge picked from the catalog must
 * be vetted against candidates with the identical vocabulary). Deliberate divergence (roster C-2): gpt-oss stays
 * its OWN family ahead of gpt, so the open-weight line keeps its own family; unknown → 'other'.
 */
function familyOf(spec) {
  const id = String(spec || '').toLowerCase().split(':').pop();
  // Proxy routing prefixes name the HOSTING vendor, not the model line ("api-optimize-alibaba-deepseek-…" is
  // DeepSeek served by Alibaba) — strip them first, mirroring model-catalog.ts modelFamily.
  const core = id
    .replace(/^(?:api-)?(?:optimize-)?(?:alibaba|fireworks|together|azure|bedrock|vertex|openrouter|groq|cerebras)-(?=.)/, '')
    .replace(/^(?:api|tt|spark|agx)-/, '');
  for (const [re, fam] of FAMILY_RULES) if (re.test(core)) return fam;
  for (const [re, fam] of FAMILY_RULES) if (re.test(id)) return fam;
  return 'other';
}

/**
 * Pick a conflict-free comparative judge spec from the model catalog (P1.5): a servable chat model whose family
 * matches NO candidate family, preferring open (non-frontier) models per the owner's 2026-10-03 automatic-picks
 * rule, then the strongest tier available, then deterministic spec order. 'other'/'decision' families are never
 * picked — an unrecognized family cannot be vetted for conflicts, and decision seats are not answer judges.
 * Hard skip (28d9e351): a card marked unservable/retired (servable !== true, whatever the field spelling — the
 * registry's retired-entry flag renders servable:false) is NEVER a candidate even if it sorts first — the incident
 * auto-pick was exactly a listed-but-retired route whose every call 400'd. Pure; returns null when nothing qualifies.
 */
function pickConflictFreeJudge(cards, candidateSpecs) {
  const fams = new Set((candidateSpecs || []).map(familyOf));
  const tierRank = { strong: 0, standard: 1, fast: 2 };
  const eligible = (cards || []).filter((c) => c && c.spec && c.servable === true && c.unservable !== true
    && c.family && c.family !== 'other' && c.family !== 'decision' && !fams.has(c.family));
  eligible.sort((a, b) => ((a.autoEligible === b.autoEligible) ? 0 : a.autoEligible ? -1 : 1)
    || ((tierRank[a.tier] ?? 1) - (tierRank[b.tier] ?? 1))
    || String(a.spec).localeCompare(String(b.spec)));
  return eligible.length ? eligible[0].spec : null;
}

/** Specs that share the judge's family (self-preference risk — say so next to the quality numbers). */
function judgeBiasWarnings(judgeModel, specs) {
  const jf = familyOf(judgeModel);
  if (!jf) return [];
  return specs.filter((s) => familyOf(s) === jf).map((s) => `${s} shares the judge's family (${jf}) — its quality score may be inflated by self-preference`);
}

// ---- blind comparative judging (P1.3): group candidates per question, anonymize, rank, map back ----

const ANON_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const ANON_SEED_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** mulberry32 — a tiny deterministic PRNG so the anonymizing shuffle is reproducible (unit-testable). */
function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a (32-bit) of a string — the shuffle seeds (v1's per-question seed, v2's per-question-per-judge seed). Pure. */
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** A stable integer seed for the shuffle from (runId, questionIdx) — same run+question ⇒ same shuffle. */
function anonSeedFor(runId, questionIdx) {
  return fnv1a(`${runId}|q${questionIdx}`);
}

/** A seeded Fisher-Yates permutation of 0..n−1 (same seed ⇒ same order — the anonymizing shuffle of both judges). Pure. */
function seededOrder(n, seed) {
  const rng = seededRng(seed);
  const order = Array.from({ length: Math.max(0, n) }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { // Fisher-Yates with the seeded RNG
    const j = Math.floor(rng() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  return order;
}

/**
 * Group MEASURED bench rows by questionIdx (each group = one question asked of several candidate models).
 * Rows without a questionIdx (null/undefined) land in their own singleton group so they still get scored.
 */
function groupByQuestion(rows) {
  const groups = [];
  const byKey = new Map();
  for (const r of rows) {
    const key = r.questionIdx == null ? `@${r.chatId || groups.length}` : `q${r.questionIdx}`;
    let g = byKey.get(key);
    if (!g) { g = { questionIdx: r.questionIdx, rows: [] }; byKey.set(key, g); groups.push(g); }
    g.rows.push(r);
  }
  return groups;
}

/**
 * Anonymize one group's answers for the judge: labels A/B/C/…, a seeded Fisher-Yates shuffle so neither
 * model identity nor presentation order can anchor the judge. Returns { pairs, labelToRow } where pairs are
 * in shuffled presentation order.
 */
function anonymizeGroup(group, runId) {
  const rows = group.rows;
  const order = seededOrder(rows.length, anonSeedFor(String(runId || ''), group.questionIdx == null ? -1 : group.questionIdx));
  const pairs = order.map((idx, pos) => ({ label: ANON_LABELS[pos] || `A${pos}`, row: rows[idx] }));
  const labelToRow = new Map(pairs.map((p) => [p.label, p.row]));
  return { pairs, labelToRow };
}

/** The question text shared by a group (every row of a group answered the SAME question). */
function groupQuestion(group, texts) {
  const t = texts.get(group.rows[0].chatId);
  return t ? t.question : '';
}

/** True when the judge's family matches ANY candidate's family in the group — comparative scoring is skipped. */
function judgeFamilyConflicts(judgeModel, group) {
  const jf = familyOf(judgeModel);
  if (!jf) return false;
  return group.rows.some((r) => familyOf(r.spec) === jf);
}

/**
 * Map a judge-returned comparative ranking back to models. `ranking` is an ordered array of anonymized labels
 * (best first) or a { ranking: [...] } / { order: [...] } object. Returns [{ spec, rank, label }] in ranking
 * order; labels missing from the ranking are appended (shared rank = size of the ranking) so no candidate loses
 * its quality slot. Returns null when the payload carries no usable labels.
 * `opts.requireComplete` (judge v2, 2026-10-20): the ranking must name EVERY label exactly once and nothing else —
 * a partial ('RANKING: B' — v1 appended A and C by presentation position, a direct position-bias leak), duplicated or
 * unknown-label ranking returns null, so the caller retries the ballot instead of filling it in.
 */
function mapRankingToModels(ranking, labelToRow, opts = {}) {
  let labels = null;
  if (Array.isArray(ranking)) labels = ranking;
  else if (ranking && typeof ranking === 'object' && Array.isArray(ranking.ranking)) labels = ranking.ranking;
  else if (ranking && typeof ranking === 'object' && Array.isArray(ranking.order)) labels = ranking.order;
  if (!labels || !labels.length) return null;
  if (opts && opts.requireComplete) {
    const norm = labels.map((raw) => String(raw).trim().toUpperCase());
    if (norm.length !== labelToRow.size || new Set(norm).size !== norm.length || norm.some((l) => !labelToRow.has(l))) return null;
    return norm.map((label, i) => ({ spec: labelToRow.get(label).spec, rank: i + 1, label }));
  }
  const seen = new Set();
  const mapped = [];
  for (const raw of labels) {
    const label = String(raw).trim().toUpperCase();
    const row = labelToRow.get(label);
    if (!row || seen.has(label)) continue;
    seen.add(label);
    mapped.push({ spec: row.spec, rank: mapped.length + 1, label });
  }
  if (!mapped.length) return null;
  for (const [label, row] of labelToRow) {
    if (!seen.has(label)) mapped.push({ spec: row.spec, rank: mapped.length + 1, label });
  }
  return mapped;
}

/**
 * Map a comparative rank (1 = best of K) onto the 1..5 quality scale the scorecard already averages:
 * best → 5, worst → 1, linear between (K=2 → 5/1, K=3 → 5/3/1, K=4 → 5/4/2/1, K=5 → 5..1). K=1 → 5
 * (a lone candidate is trivially best — though singleton groups take the absolute path). Pure.
 */
function rankToQuality(rank, k) {
  const K = Math.max(1, Math.round(Number(k) || 0));
  if (K < 2) return 5;
  const r = Math.min(Math.max(Math.round(Number(rank) || 1), 1), K);
  return Math.round(1 + (4 * (K - r)) / (K - 1));
}

// ---- judge v2 (2026-10-20): a family-excluding panel, Latin-square ballots, pairwise scores, length diagnostics ----

const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;

/**
 * Judge v2's ballot plan for ONE question group. Per panel judge: the rows whose model family differs from the judge's
 * (SELF-FAMILY EXCLUSION — a judge never ranks an answer of its own family, so self-preference cannot enter the
 * score); a judge left with fewer than 2 rows sits the question out (`skipped`). Per judge K ballots, K = its rows: a
 * CYCLIC LATIN SQUARE — ballot o is the seeded shuffle (seed: run + question + judge — reproducible) rotated by o, so
 * every answer sits in every slot exactly once and any position bias (first, last, middle) averages out per answer
 * (K = 2 is the shuffle + its reverse). Every ballot is RELABELLED A, B, C… by position, so a label never carries over
 * between ballots. Pure.
 * → { ballots: [{ judge, order, pairs: [{ label, row }], labelToRow }], skipped: [judge…] }
 */
function ballotsFor(group, panel, { runId = '' } = {}) {
  const ballots = [];
  const skipped = [];
  const idx = group.questionIdx == null ? -1 : group.questionIdx;
  for (const judge of panel || []) {
    const jf = familyOf(judge);
    const rows = group.rows.filter((r) => familyOf(r.spec) !== jf);
    if (rows.length < 2) { skipped.push(judge); continue; }
    const base = seededOrder(rows.length, fnv1a(`${String(runId || '')}|q${idx}|${judge}`));
    for (let o = 0; o < rows.length; o += 1) {
      const order = base.slice(o).concat(base.slice(0, o));
      const pairs = order.map((i, pos) => ({ label: ANON_LABELS[pos] || `A${pos}`, row: rows[i] }));
      ballots.push({ judge, order: o, pairs, labelToRow: new Map(pairs.map((p) => [p.label, p.row])) });
    }
  }
  return { ballots, skipped };
}

/** How many ballots a plan (ballotsFor().ballots) gives each row, keyed by rowKey — the quorum, before any call. Pure. */
function plannedBallotCounts(ballots) {
  const n = new Map();
  for (const b of ballots || []) for (const p of b.pairs || []) n.set(rowKey(p.row), (n.get(rowKey(p.row)) || 0) + 1);
  return n;
}

/** An id's answer length from a Map or a plain object (0 when unknown). */
function charsLookup(charsById, id) {
  const v = charsById instanceof Map ? charsById.get(id) : (charsById || {})[id];
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

/**
 * Judge v2's aggregation — PAIRWISE. Each successful ballot ranks k ids best-first, i.e. k(k − 1)/2 pair outcomes; an
 * id's score is its win rate against EACH other id over the ballots that ranked both, averaged over its opponents, and
 * its quality = round2(1 + 4 · that mean): the scorecard's 1..5 scale with mean 3. On complete ballots this is exactly
 * the mean of (k − r)/(k − 1), so ONE ballot of K = 3 reproduces v1's 5 / 3 / 1 (K = 4 → 5 / 3.67 / 2.33 / 1, unrounded
 * — v1 rounded to 5/4/2/1). A ballot that left out its judge's own family only speaks for the pairs it holds, so an id's
 * score never depends on which rows ANOTHER ballot left out (2026-10-20 review: a plain mean of per-ballot scores over
 * ballots of different sizes gave a judge family's own candidate a compressed scale — equal true quality, unequal
 * scores). Ballots that disagree average a pair toward ½ — the usual tie treatment. Position: over ONE judge's
 * Latin square an answer's score is position-free exactly (its mean over the square); pooled with another judge's
 * smaller ballots a small per-question residual is left whose sign follows the seeded shuffle (zero-mean across
 * questions — a pair outcome alone is not balanced by a cyclic square). With `beta` (length control) each
 * pair outcome w (1 = ranked above) is adjusted first: w' = clamp(w − β·Δ, 0, 1), Δ = ln(its chars) − ln(the
 * opponent's), so the two sides of a pair still sum to 1. Pure.
 * ballots: [{ ranked: [id best first…] }] · opts { charsById?: Map | object, beta?: number }
 * → { [id]: { ballots, opponents, winRate, quality } }
 */
function aggregateBallots(ballots, opts = {}) {
  const { nBallots, pairs } = pairTable(ballots, opts);
  const out = {};
  for (const [id, m] of pairs) {
    const rates = [...m.values()].map((c) => c.w / c.n);
    const rate = rates.reduce((s, x) => s + x, 0) / rates.length;
    out[id] = { ballots: nBallots.get(id) || 0, opponents: rates.length, winRate: round4(rate), quality: round2(1 + 4 * rate) };
  }
  return out;
}

/**
 * The pair table aggregateBallots and lengthSlope read: per id, per opponent it shared a ballot with, { n: ballots
 * holding both, w: the summed (length-adjusted when `beta`) outcomes of the id }, plus each id's ballot count. Pure.
 */
function pairTable(ballots, { charsById = null, beta = 0 } = {}) {
  const nBallots = new Map();
  const pairs = new Map(); // id → Map(opponent → { n, w })
  const cell = (a, b) => {
    let m = pairs.get(a);
    if (!m) { m = new Map(); pairs.set(a, m); }
    let c = m.get(b);
    if (!c) { c = { n: 0, w: 0 }; m.set(b, c); }
    return c;
  };
  for (const b of ballots || []) {
    const ids = Array.isArray(b && b.ranked) ? b.ranked : [];
    if (ids.length < 2) continue;
    const ln = beta ? ids.map((id) => Math.log(Math.max(1, charsLookup(charsById, id)))) : null;
    for (const id of ids) nBallots.set(id, (nBallots.get(id) || 0) + 1);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) { // ids[i] is ranked above ids[j]
        const w = ln ? Math.min(1, Math.max(0, 1 - beta * (ln[i] - ln[j]))) : 1;
        const up = cell(ids[i], ids[j]); up.n += 1; up.w += w;
        const down = cell(ids[j], ids[i]); down.n += 1; down.w += 1 - w;
      }
    }
  }
  return { nBallots, pairs };
}

/**
 * --length-control's slope, fitted on exactly what aggregateBallots' adjustment subtracts. Per question group (an
 * array of its successful ballots) and per id: its raw pairwise score r (aggregateBallots' win rate) and G = its mean
 * ln(answer chars) gap to the opponents it was ranked against. Since w' = w − β·Δ per pair moves that score by exactly
 * −β·G (before the clamp), the pooled through-origin OLS β = Σ G·(r − ½) / Σ G² removes the scores' linear dependence
 * on length (one ballot of lengths e⁰ < e¹ < e² ranked longest first: β = 1/3, and every answer then scores 3).
 * β > 0 = the panel still rewards length. 0 with no length spread. Pure.
 * groups: [[{ ranked }…] per question group] · charsById: Map | object → β
 */
function lengthSlope(groups, charsById) {
  const ln = (id) => Math.log(Math.max(1, charsLookup(charsById, id)));
  let sxy = 0, sxx = 0;
  for (const ballots of groups || []) {
    for (const [id, m] of pairTable(ballots).pairs) {
      const cells = [...m.entries()];
      const r = cells.reduce((s, [, c]) => s + c.w / c.n, 0) / cells.length;
      const g = cells.reduce((s, [opp]) => s + ln(id) - ln(opp), 0) / cells.length;
      sxy += g * (r - 0.5); sxx += g * g;
    }
  }
  return sxx > 1e-12 ? sxy / sxx : 0;
}

/** Average ranks (1-based; ties share their mean rank). Pure. */
function averageRanks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
    for (let t = i; t <= j; t += 1) r[idx[t][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

/** Spearman's ρ (Pearson on average ranks); null with < 2 points or no spread on either side. Pure. */
function spearman(xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length < 2) return null;
  const rx = averageRanks(xs), ry = averageRanks(ys);
  const mx = rx.reduce((s, x) => s + x, 0) / rx.length, my = ry.reduce((s, x) => s + x, 0) / ry.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < rx.length; i += 1) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/**
 * The length diagnostics over judged groups (each `[{ chars, score }]`, one entry per answer). lengthRho = the mean
 * per-group Spearman ρ of ln(answer chars) vs score (> 0 = longer answers scored higher; groups with no length or no
 * score spread are left out); longestWonRate = how often the group's single longest answer scored highest (a share of
 * a tie at the top; a group tied for longest is left out) beside longestWonBaseline = the chance rate (mean 1/K over
 * the same groups). Numbers only. Pure.
 */
function lengthDiagnostics(groups) {
  const rhos = [];
  let won = 0, wonN = 0, base = 0;
  for (const g of groups || []) {
    const pts = (g || []).filter((p) => p && Number.isFinite(p.chars) && Number.isFinite(p.score));
    if (pts.length < 2) continue;
    const rho = spearman(pts.map((p) => Math.log(Math.max(1, p.chars))), pts.map((p) => p.score));
    if (rho !== null) rhos.push(rho);
    const maxChars = Math.max(...pts.map((p) => p.chars));
    const longest = pts.filter((p) => p.chars === maxChars);
    if (longest.length !== 1) continue;
    const maxScore = Math.max(...pts.map((p) => p.score));
    const top = pts.filter((p) => p.score === maxScore).length;
    won += longest[0].score === maxScore ? 1 / top : 0;
    wonN += 1;
    base += 1 / pts.length;
  }
  return {
    lengthRho: rhos.length ? round4(rhos.reduce((s, x) => s + x, 0) / rhos.length) : null,
    lengthRhoGroups: rhos.length,
    longestWonRate: wonN ? round4(won / wonN) : null,
    longestWonBaseline: wonN ? round4(base / wonN) : null,
    longestWonGroups: wonN,
  };
}

/** Kendall's τ between two best-first rankings, over the ids both hold; null with fewer than 2 common ids. Pure. */
function kendallTau(a, b) {
  const pos = new Map((b || []).map((id, i) => [id, i]));
  const common = (a || []).filter((id) => pos.has(id));
  const n = common.length;
  if (n < 2) return null;
  let s = 0;
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) s += pos.get(common[i]) < pos.get(common[j]) ? 1 : -1;
  return s / ((n * (n - 1)) / 2);
}

/**
 * Position consistency per judge: over every pair of ONE judge's successful ballots of one question (the same answers,
 * re-ordered by the Latin square), the mean Kendall τ between the two rankings (1 = it ranked every answer the same
 * wherever it sat; a purely positional judge reads −1/(K − 1)) and `top1` = how often the pair put the same answer
 * first. τ reads every answer's rank, not just the winner's (2026-10-20 review: the forward/reverse top-1 readout rated
 * a purely positional judge 1.0 when the reverse left an odd K's middle answer in place). `ballotSets`: [[{ judge,
 * order, ranked }…] per group]. → { [judge]: { pairs, tau, top1 } } (tau / top1 null with no pair). Pure.
 */
function positionConsistency(ballotSets, panel) {
  const acc = new Map();
  const at = (j) => {
    let a = acc.get(j);
    if (!a) { a = { pairs: 0, tau: 0, top1: 0 }; acc.set(j, a); }
    return a;
  };
  for (const j of panel || []) at(j);
  for (const set of ballotSets || []) {
    const byJudge = new Map();
    for (const b of set || []) {
      if (!b || !Array.isArray(b.ranked) || b.ranked.length < 2) continue;
      if (!byJudge.has(b.judge)) byJudge.set(b.judge, []);
      byJudge.get(b.judge).push(b.ranked);
    }
    for (const [j, rankings] of byJudge) {
      for (let x = 0; x < rankings.length; x += 1) {
        for (let y = x + 1; y < rankings.length; y += 1) {
          const tau = kendallTau(rankings[x], rankings[y]);
          if (tau === null) continue;
          const a = at(j);
          a.pairs += 1; a.tau += tau;
          if (rankings[x][0] === rankings[y][0]) a.top1 += 1;
        }
      }
    }
  }
  const out = {};
  for (const [j, a] of acc) out[j] = { pairs: a.pairs, tau: a.pairs ? round4(a.tau / a.pairs) : null, top1: a.pairs ? round4(a.top1 / a.pairs) : null };
  return out;
}

/**
 * The judge-v2 stamp the scorecard buckets carry: 'v2:<judges>xK' — K ballots per judge per question, the Latin square
 * (+ '+lc' when length-controlled) — e.g. 'v2:2xK' for the default panel. Pure.
 */
function qualityJudgeStamp(panel, lengthControl = false) {
  return `v2:${(panel || []).length}xK${lengthControl ? '+lc' : ''}`;
}

/**
 * Pre-flight lines for a panel against the run's candidates (judge v2): a non-streaming-unsafe built-in judge, a
 * frontier judge, and every shape the panel can NEVER rank — decided by the same ballot plan judgeV2 casts
 * (ballotsFor on a synthetic group, plannedBallotCounts vs the quorum): first the whole field (a candidate whose
 * family every judge shares), then every PAIR of candidates (2026-10-20 review: two specs whose families together
 * cover every judge's family — the default panel's qwen + deepseek — leave both judges sitting out a question only
 * they answered, which a per-spec check missed). A group can only lose rows, never gain them, so these two passes cover
 * every unrankable group: such a group is left unjudged (no judge call). Pure.
 */
function panelWarnings(panel, specs, { minBallots = 2 } = {}) {
  const lines = [];
  for (const j of panel || []) {
    if (NON_STREAMING_UNSAFE[j]) lines.push(`judge ${j} ${NON_STREAMING_UNSAFE[j]} — expect timeouts / empty answers (failed ballots); the default panel avoids it`);
    if (FRONTIER_FAMILIES.has(familyOf(j))) lines.push(`judge ${j} is a frontier model (${familyOf(j)}) — the default panel is open models only (owner rule: frontier only by reflection); pinned by hand`);
  }
  const uniq = [...new Set(specs || [])];
  const shortOf = (list) => {
    const group = { questionIdx: 0, rows: list.map((spec, i) => ({ spec, chatId: `pw${i}` })) };
    const counts = plannedBallotCounts(ballotsFor(group, panel).ballots);
    return group.rows.map((r) => ({ spec: r.spec, n: counts.get(rowKey(r)) || 0 })).filter((x) => x.n < minBallots);
  };
  const flagged = new Set();
  if (uniq.length >= 2) {
    for (const { spec, n } of shortOf(uniq)) {
      flagged.add(spec);
      lines.push(`${spec} (${familyOf(spec)}) can get at most ${n} ballot(s) — ${n ? 'below' : 'every panel judge shares its family, so none may rank it; below'} the quorum of ${minBallots}: every question it answered is UNRANKABLE (left unjudged, no judge call) — add a judge of another family to --judge-panel`);
    }
  }
  for (let i = 0; i < uniq.length; i += 1) {
    for (let k = i + 1; k < uniq.length; k += 1) {
      if (flagged.has(uniq[i]) || flagged.has(uniq[k])) continue; // already said for the whole field
      const short = shortOf([uniq[i], uniq[k]]);
      if (!short.length) continue;
      const n = Math.min(...short.map((x) => x.n));
      lines.push(`a question only ${uniq[i]} and ${uniq[k]} answered is UNRANKABLE: ${n ? `at most ${n} ballot(s), below the quorum of ${minBallots}` : 'every panel judge shares a family with one of them'} — such a group is left unjudged (no judge call; a run where every group is unrankable refuses unattended) — add a judge of another family to --judge-panel`);
    }
  }
  return lines;
}

/**
 * The ALL-SINGLETON shape (2026-10-20 review): answers were measured, yet NOT ONE question had two measured models —
 * no comparative group ranked, and every measured answer was a singleton left unjudged. That is a broken run (a
 * model failed / failed over / was diverted on every question, or a two-model run lost one model), not a refresh:
 * merged, it would write quality-null buckets on top of the judged ones. An unattended ingest REFUSES it; an attended
 * one says so in a ⚠ line. A MIXED run (≥ 1 comparative group beside its singletons) is a normal run and writes.
 * Judge v2 passes `unrankableGroups` too: groups its panel can never rank are the same "nothing ranked" shape when no
 * other group was ranked (v1 never passes it — its check is unchanged). Pure (takes the judging pass's counts).
 */
function allSingletonRun({ measured = 0, comparativeGroups = 0, singletonsUnjudged = 0, unrankableGroups = 0 } = {}) {
  return measured > 0 && comparativeGroups === 0 && (singletonsUnjudged > 0 || unrankableGroups > 0);
}

/** Judge v2's unattended refusal when nothing was ranked and the panel could not rank some groups (unrankable). */
function noRankableGroupRefusal(measured, unrankableGroups, singletonsUnjudged, minBallots) {
  return `unattended ingest measured ${measured} answer(s) but no question group could be ranked (0 comparative groups: ${unrankableGroups} group(s) UNRANKABLE by this panel — it cannot give every answer ${minBallots} ballot(s), each judge sitting out its own family — and ${singletonsUnjudged} singleton(s)) — a run with nothing ranked is not a refresh; REFUSING, nothing written (no judge call was made for those groups). Add a judge of another model family with --judge-panel (the ⚠ panel lines above name the shapes), or — once reviewed — pass --no-judge to record only its latency / failRate`;
}

/** Judge v2's attended ⚠ line when nothing was ranked and some groups were unrankable. */
function noRankableGroupWarning(measured, unrankableGroups) {
  return `  ⚠ nothing ranked: ${measured} measured answer(s), 0 comparative groups — ${unrankableGroups} group(s) UNRANKABLE by this panel (an unattended ingest refuses this shape); its buckets carry no quality (the merge keeps any stored judged quality)`;
}

/** The unattended refusal of an all-singleton run (both judge versions). */
function allSingletonRefusal(measured, singletonsUnjudged) {
  return `unattended ingest measured ${measured} answer(s) but no question had two measured models (0 comparative groups, ${singletonsUnjudged} singleton(s) unjudged) — an all-singleton run is a BROKEN run (a model failed, failed over or was diverted on every question), not a refresh; REFUSING, nothing written. Check the attribution above and re-run the bench, or — once reviewed — pass --no-judge to record only its latency / failRate (the merge never lets a quality-null bucket erase judged quality)`;
}

/** The attended ⚠ line of an all-singleton run (both judge versions). */
function allSingletonWarning(measured) {
  return `  ⚠ all-singleton run: ${measured} measured answer(s), 0 comparative groups — no question had two measured models, so nothing was ranked (an unattended ingest refuses this shape); its buckets carry no quality (the merge keeps any stored judged quality)`;
}

function fmt(v) { return v === null || v === undefined ? '-' : String(v); }

/**
 * The title's task kind vs the answer's classified kind (2026-10-20), counts only: over rows whose title carried a
 * kind — agree / differ / unstamped (no classified kind on the answer) — plus rows with no title kind. Pure.
 */
function kindAgreement(rows) {
  const out = { agree: 0, differ: 0, unstamped: 0, noTitleKind: 0 };
  for (const r of rows || []) {
    if (!r || !r.kind) { out.noTitleKind += 1; continue; }
    if (!r.planKind) out.unstamped += 1;
    else if (r.planKind === r.kind) out.agree += 1;
    else out.differ += 1;
  }
  return out;
}

/** The per-model per-lane (+ per task kind) summary lines (aggregates only). */
function summaryLines(card, attribution) {
  const lines = [];
  for (const [spec, mc] of Object.entries(card.models || {})) {
    const a = attribution[spec] || {};
    lines.push(`${spec}  (measured ${a.measured || 0} · failed ${a.failed || 0} · failover ${a.failover || 0} · diverted ${a.diverted || 0} · unverified ${a.unverified || 0})`);
    for (const [lane, s] of Object.entries(mc.lanes)) {
      lines.push(`  ${lane.padEnd(9)} n ${String(s.n).padStart(3)} · ttft p50 ${fmt(s.ttftP50Ms)} ms p90 ${fmt(s.ttftP90Ms)} ms · done p50 ${fmt(s.doneP50Ms)} ms · fail ${s.failRate} · quality ${fmt(s.quality)} (${s.qualityN}) · web tools ${fmt(s.webToolsMean)}`);
    }
    // 2026-10-20: the per-task-kind buckets (the title kind, else the answer's classified kind) + the kind's field.
    for (const [kind, s] of Object.entries(mc.kinds || {})) {
      lines.push(`  k:${kind.padEnd(9)} n ${String(s.n).padStart(3)} · ttft p50 ${fmt(s.ttftP50Ms)} ms p90 ${fmt(s.ttftP90Ms)} ms · done p50 ${fmt(s.doneP50Ms)} ms · fail ${s.failRate} · quality ${fmt(s.quality)} (${s.qualityN}) · field ${fmt(s.fieldSize)}`);
    }
  }
  for (const [spec, a] of Object.entries(attribution)) {
    if (!(card.models || {})[spec]) lines.push(`${spec}  — nothing attributable (diverted ${a.diverted || 0} · unverified ${a.unverified || 0}); no scorecard entry`);
  }
  return lines;
}

/** The id a v2 ballot ranks a row by: its chat id (one chat per question × model). */
function rowKey(r) {
  return r && r.chatId ? String(r.chatId) : `${r && r.spec}#${r && r.questionIdx}`;
}

/** A measured row's answer length: the leaf's answerChars, else the answer text this ingest holds (an older leaf). */
function answerCharsOf(r, texts) {
  if (r && Number.isFinite(r.answerChars)) return r.answerChars;
  const t = texts && r ? texts.get(r.chatId) : null;
  return t ? String(t.answer || '').length : 0;
}

/**
 * JUDGE V2 over one run's rows (see the header, step 3): plan the ballots (ballotsFor), cast them through
 * deps.judgeComparativeOnModel(question, answers, judgeSpec, { rubric: 'v2' }) — complete rankings only, each ballot
 * retried up to --judge-attempts, at most `concurrency` judge CALLS in flight — then aggregate per question group
 * (aggregateBallots; --length-control first fits lengthSlope over every group's successful ballots), enforce the quorum, write
 * row.quality, and compute the diagnostics. A group whose PLAN cannot give every answer the quorum (plannedBallotCounts
 * — the panel's judges sit out its families) is UNRANKABLE: no call is made and its answers stay unjudged, like a
 * singleton. A rankable group that loses quorum to failed ballots leaves its answers UNJUDGED too (no absolute
 * fallback: v2 never mixes scales). Returns { counts, result, qualityJudge } or { error } (an UNATTENDED refusal —
 * nothing is written).
 */
async function judgeV2({ args, deps, log, rows, texts, runId, unattended }) {
  const { leaf } = deps;
  const counts = { judged: 0, judgedComparative: 0, comparativeGroups: 0, comparativeFailedGroups: 0, comparativeRetries: 0, singletonsUnjudged: 0 };
  let ballotsCast = 0, ballotsFailed = 0, judgeSkips = 0, unrankableGroups = 0, unrankableAnswers = 0;
  const panel = args.judgePanel || (args.judgeModel ? [args.judgeModel] : [...DEFAULT_JUDGE_PANEL]);
  const concurrency = args.judgeConcurrencySet ? args.judgeConcurrency : JUDGE_V2_DEFAULT_CONCURRENCY;
  const targets = rows.filter((r) => leaf.attributeBenchRow(r) === 'measured');
  const source = args.judgePanel
    ? `--judge-panel${args.judgeModel ? `; --judge-model ${args.judgeModel} ignored` : ''}`
    : args.judgeModel ? '--judge-model: a ONE-judge panel — pass --judge-panel a,b for a panel' : 'the default panel';
  log(`judge: v2 — panel ${panel.join(' + ')} (${source}) · COMPARATIVE_RUBRIC_V2 (length-blind) · each judge ranks only the answers of OTHER model families · K ballots per judge per question, K = the answers it ranks (a cyclic Latin square of a seeded shuffle — every answer once in every slot, relabelled A/B/C… per ballot) · pairwise win rates per opponent · complete rankings only (${args.judgeAttempts} attempt(s) per ballot) · quorum ${args.minBallots} ballot(s) per answer${args.lengthControl ? ' · length-controlled' : ''} · ${concurrency} judge call(s) at a time`);
  for (const w of panelWarnings(panel, targets.map((r) => r.spec), { minBallots: args.minBallots })) log(`  ⚠ ${w}`);
  const t0 = Date.now();
  const groups = groupByQuestion(targets);
  const plan = [];
  for (const group of groups) {
    // A question only ONE model answered has no rank — unjudged, exactly as under v1 (2026-10-20 singleton hardening).
    if (group.rows.length < 2) { counts.singletonsUnjudged += group.rows.length; continue; }
    const { ballots, skipped } = ballotsFor(group, panel, { runId });
    judgeSkips += skipped.length;
    // 2026-10-20 review: a group whose PLAN cannot give every answer the quorum (each judge that could rank one of its
    // answers sits out its own family — e.g. a question only qwen + deepseek answered, under the qwen + deepseek
    // panel) is UNRANKABLE, decided here before any call: unjudged like a singleton, never a lost quorum that would
    // refuse an unattended run blaming ballots that were never cast.
    const planned = plannedBallotCounts(ballots);
    if (group.rows.some((r) => (planned.get(rowKey(r)) || 0) < args.minBallots)) { unrankableGroups += 1; unrankableAnswers += group.rows.length; continue; }
    plan.push({ group, question: groupQuestion(group, texts), ballots });
  }
  const tasks = [];
  for (const p of plan) for (const b of p.ballots) tasks.push({ p, b });
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  await pool(tasks, concurrency, async ({ p, b }) => {
    const answers = b.pairs.map((x) => ({ label: x.label, answer: String((texts.get(x.row.chatId) || {}).answer || '') }));
    let mapped = null;
    for (let attempt = 1; attempt <= (args.judgeAttempts || 1) && !mapped; attempt += 1) {
      if (attempt > 1) { counts.comparativeRetries += 1; await sleep(2000 * (attempt - 1)); }
      const ranking = await Promise.resolve().then(() => deps.judgeComparativeOnModel(p.question, answers, b.judge, { rubric: 'v2' })).catch(() => null);
      mapped = ranking ? mapRankingToModels(ranking, b.labelToRow, { requireComplete: true }) : null;
    }
    if (!mapped) { ballotsFailed += 1; return; } // a failed ballot — the quorum decides whether it sinks the group
    b.ranked = mapped.map((m) => rowKey(b.labelToRow.get(m.label)));
    ballotsCast += 1;
  });
  const charsById = new Map(targets.map((r) => [rowKey(r), answerCharsOf(r, texts)]));
  const okBallots = (p) => p.ballots.filter((b) => Array.isArray(b.ranked));
  const lengthBeta = args.lengthControl ? lengthSlope(plan.map(okBallots), charsById) : null;
  const kindOf = (r) => (typeof leaf.benchRowKind === 'function' ? leaf.benchRowKind(r) : (r.kind || r.planKind || null));
  const diag = [], diagRaw = [], perQuestion = [];
  for (const p of plan) {
    const ok = okBallots(p);
    const agg = aggregateBallots(ok, { charsById, beta: lengthBeta || 0 });
    if (!p.group.rows.every((r) => ((agg[rowKey(r)] || {}).ballots || 0) >= args.minBallots)) { counts.comparativeFailedGroups += 1; continue; }
    counts.comparativeGroups += 1;
    for (const r of p.group.rows) { r.quality = agg[rowKey(r)].quality; counts.judged += 1; counts.judgedComparative += 1; }
    diag.push(p.group.rows.map((r) => ({ chars: charsById.get(rowKey(r)), score: r.quality })));
    if (args.lengthControl) {
      const raw = aggregateBallots(ok, { charsById });
      diagRaw.push(p.group.rows.map((r) => ({ chars: charsById.get(rowKey(r)), score: raw[rowKey(r)].quality })));
    }
    if (args.perQuestion) {
      const scores = {}, chars = {};
      for (const r of p.group.rows) { scores[r.spec] = r.quality; chars[r.spec] = charsById.get(rowKey(r)); }
      perQuestion.push({ q: p.group.questionIdx, kind: p.group.rows.map(kindOf).find(Boolean) || null, scores, chars });
    }
  }
  const consistency = positionConsistency(plan.map((p) => p.ballots), panel);
  const lengthDiag = lengthDiagnostics(diag);
  const rawDiag = args.lengthControl ? lengthDiagnostics(diagRaw) : null;
  log(`judged ${counts.judged}/${targets.length} measured answer(s) over ${groups.length} group(s) in ${Math.round((Date.now() - t0) / 1000)} s — judge v2: ${counts.comparativeGroups} ranked group(s) (${counts.judgedComparative} row(s)) · ballots ${ballotsCast} cast, ${ballotsFailed} failed${counts.comparativeRetries ? `, ${counts.comparativeRetries} retr${counts.comparativeRetries === 1 ? 'y' : 'ies'}` : ''}${judgeSkips ? ` · ${judgeSkips} judge sit-out(s) (fewer than 2 answers of another family)` : ''}${counts.comparativeFailedGroups ? ` · ${counts.comparativeFailedGroups} group(s) LOST QUORUM (an answer had < ${args.minBallots} ballot(s)) — their answers carry no quality` : ''}`);
  const pc = Object.entries(consistency).map(([j, o]) => `${j} τ ${fmt(o.tau)} · top-1 ${fmt(o.top1)} (n ${o.pairs})`).join(' · ');
  log(`judge v2 diagnostics: position consistency (Kendall τ between a judge's re-ordered ballots of one question · top-1 agreement) ${pc || '-'} · length ρ (ln chars vs score, mean per group) ${fmt(lengthDiag.lengthRho)} over ${lengthDiag.lengthRhoGroups} group(s) · longest answer won ${fmt(lengthDiag.longestWonRate)} (chance ${fmt(lengthDiag.longestWonBaseline)}, ${lengthDiag.longestWonGroups} group(s))${args.lengthControl ? ` · length control β ${round4(lengthBeta)} (before it: ρ ${fmt(rawDiag.lengthRho)}, longest won ${fmt(rawDiag.longestWonRate)})` : ''}`);
  if (counts.singletonsUnjudged) log(`singletons unjudged: ${counts.singletonsUnjudged} — question(s) only one model answered (the others failed, failed over or were diverted); a lone answer has no comparative rank, so it carries no quality (it still counts in n, latency and failRate)`);
  if (unrankableGroups) log(`unrankable: ${unrankableGroups} group(s) (${unrankableAnswers} answer(s)) — this panel cannot give every answer ${args.minBallots} ballot(s) (each judge sits out its own family; the ⚠ panel lines name the shapes); left unjudged like a singleton — no judge call, never a lost quorum (they still count in n, latency and failRate)`);
  // The 28d9e351 refuse, v2 shape: an UNATTENDED run that lost ANY group's quorum stops here — exit 1, nothing written
  // (those answers would land unjudged beside judged ones, a silently partial run). A failed ballot that kept the
  // quorum is counted (ballotsFailed) and does not refuse. Attended runs write with the ⚠ above.
  if (unattended && counts.comparativeFailedGroups > 0) {
    return { error: `unattended ingest: ${counts.comparativeFailedGroups} question group(s) lost quorum (an answer had fewer than ${args.minBallots} successful ballot(s) from judges of other families; ${ballotsFailed} ballot(s) failed after ${args.judgeAttempts} attempt(s) each) — REFUSING, nothing written, so a partially judged run never lands on the comparative scorecard (28d9e351); check the panel's routes (pin working judges with --judge-panel) and re-run, or pass --no-judge for a judgeless ingest that writes no quality` };
  }
  if (counts.comparativeFailedGroups) log(`  ⚠ ${counts.comparativeFailedGroups} question group(s) lost quorum — their answers carry NO quality (judge v2 never falls back to the absolute scale); an unattended ingest refuses this run`);
  // Nothing ranked at all is a broken run, not a refresh — all singletons (as under v1) or, v2, groups the panel can
  // never rank (an unrankable group alone, beside ranked ones, writes like a singleton).
  if (allSingletonRun({ measured: targets.length, comparativeGroups: counts.comparativeGroups, singletonsUnjudged: counts.singletonsUnjudged, unrankableGroups })) {
    if (unattended) return { error: unrankableGroups ? noRankableGroupRefusal(targets.length, unrankableGroups, counts.singletonsUnjudged, args.minBallots) : allSingletonRefusal(targets.length, counts.singletonsUnjudged) };
    log(unrankableGroups ? noRankableGroupWarning(targets.length, unrankableGroups) : allSingletonWarning(targets.length));
  }
  const result = {
    judgeVersion: 'v2', panel, ballotDesign: JUDGE_V2_BALLOT_DESIGN, minBallots: args.minBallots,
    ballots: ballotsCast, ballotsFailed, judgeSkips, unrankableGroups, unrankableAnswers, positionConsistency: consistency, ...lengthDiag,
    ...(args.lengthControl ? { lengthBeta: round4(lengthBeta), lengthRhoRaw: rawDiag.lengthRho, longestWonRateRaw: rawDiag.longestWonRate } : {}),
    ...(args.perQuestion ? { perQuestion } : {}),
  };
  return { counts, result, qualityJudge: counts.comparativeGroups ? qualityJudgeStamp(panel, args.lengthControl) : null };
}

/**
 * The ingest over injected dependencies (testable offline — backend/src/scripts/model-bench-ingest.test.ts drives it
 * with the REAL leaf and a mocked Prisma / store / judge). deps: { leaf, prisma, store: { storeGet, storePut },
 * judge?: (question, answer) → {score, issue} | null, judgeModel?: () → string | null,
 * judgeComparative?: (question, answers) → labels | null, judgeComparativeOnModel?: (question, answers, spec) → labels | null,
 * listCatalog?: () → ModelCard[] (the conflict-free auto-pick source), deleteChat?: (chatId, userId) }.
 * Returns { exitCode, error?, result? }; `log` receives the human-readable lines (aggregates only, never text).
 */
async function run({ argv = [], env = {}, deps, log = console.log }) {
  const args = parseArgs(argv, env);
  if (args.error) return { exitCode: 2, error: args.error };
  const { leaf, prisma, store } = deps;
  // 28d9e351 fail-safe: an UNATTENDED judging run without a pinned --judge-model must never silently fall back to
  // absolute-scale rows on the comparative scorecard (the mb-open-b2-20261006 contamination). Auto-pinning the
  // manifest's conflict-free default judge keeps the unattended path COMPARATIVE; the refuse below is the backstop
  // for the remaining silent-absolute shapes (auto-pick found nothing, a comparative call fails, the family guard).
  // A singleton group is NOT one of them since 2026-10-20 — it is left unjudged, never absolute-scored.
  const unattended = unattendedContext({ argv, env, isTTY: deps.isTTY === undefined ? true : !!deps.isTTY });
  // Judge v2 (2026-10-20) is the default; everything v1 below runs only under --judge-version v1, exactly as before.
  const v2 = args.judge && args.judgeVersion === 'v2';
  if (args.judge && !v2 && unattended && !args.judgeModel) {
    log(`judge: unattended run (no tty / systemd context) without --judge-model — pinning the comparative judge to the default ${DEFAULT_UNATTENDED_JUDGE} (pass --judge-model <spec> to override, or --unattended --no-judge for a judgeless ingest that writes no quality)`);
    args.judgeModel = DEFAULT_UNATTENDED_JUDGE;
  }
  if (args.judge && !v2 && typeof deps.judge !== 'function') {
    return { exitCode: 3, error: 'live-chat-audit.defaultQualityJudge is not exported by this build — deploy first or pass --no-judge' };
  }
  // v2 needs the spec-pinned judge AND the v2 rubric in the deployed build: an older comparativeJudgeOnModel ignores the
  // rubric option and would rank on the length-rewarding v1 rubric under a 'v2' stamp — refuse rather than mislabel.
  if (v2 && (typeof deps.judgeComparativeOnModel !== 'function' || deps.rubricV2 === false)) {
    return { exitCode: 3, error: 'judge v2 needs live-chat-audit.comparativeJudgeOnModel with COMPARATIVE_RUBRIC_V2 — this build predates it: deploy first, or pass --judge-version v1 (the single judge, as before) or --no-judge' };
  }
  const { runId } = args;
  const user = await prisma.user.findUnique({ where: { email: leaf.MODEL_BENCH_ACCOUNT_EMAIL }, select: { id: true } });
  if (!user) return { exitCode: 2, error: `the bench account ${leaf.MODEL_BENCH_ACCOUNT_EMAIL} does not exist` };
  const chats = await prisma.crossModelChat.findMany({
    where: { userId: user.id, title: { startsWith: `${leaf.MODEL_BENCH_TITLE_PREFIX} ${runId} ` } },
    select: { id: true, title: true, leadModel: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const rows = [];
  const texts = new Map(); // chatId → { question, answer } — kept in memory for the judge only, never printed
  const skipped = { otherTitle: 0, unsent: 0 };
  let unparsedKindTitles = 0;
  for (const chat of chats) {
    const parsed = leaf.parseBenchTitle(chat.title);
    if (!parsed || parsed.runId !== runId) { // the preflight chat, a renamed row
      skipped.otherTitle += 1;
      // A `… k:<kind>` title only an older leaf fails to parse (2026-10-20 deploy order) — said out loud below.
      if (!parsed && / q\d+ \S+ k:[a-z]+$/.test(String(chat.title || ''))) unparsedKindTitles += 1;
      continue;
    }
    const msgs = await prisma.crossModelMessage.findMany({
      where: { chatId: chat.id }, orderBy: { createdAt: 'asc' },
      // parts: the answer's tool calls → the bench row's web tool count (roster 2026-10-06 C-2, the picker's tool-aware latency).
      select: { id: true, role: true, content: true, metadata: true, parts: true, createdAt: true },
    });
    const turn = leaf.pickBenchTurn(msgs);
    if (!turn) { skipped.unsent += 1; continue; } // the lead pick was refused, or the stream never started
    rows.push(leaf.benchRowFromTurn({ ...parsed, chatId: chat.id }, turn));
    texts.set(chat.id, { question: String(turn.user.content || ''), answer: String((turn.answer && turn.answer.content) || '') });
  }
  log(`run ${runId}: ${chats.length} chat(s), ${rows.length} bench row(s) (skipped: ${skipped.otherTitle} other title, ${skipped.unsent} never sent)`);
  if (unparsedKindTitles) log(`  ⚠ ${unparsedKindTitles} chat title(s) carry a \`k:<kind>\` task-kind token this box's scorecard leaf cannot parse — it predates 2026-10-20: deploy first, then re-run this ingest (nothing from those chats is counted)`);

  const attribution = {};
  for (const r of rows) {
    const a = leaf.attributeBenchRow(r);
    attribution[r.spec] = attribution[r.spec] || {};
    attribution[r.spec][a] = (attribution[r.spec][a] || 0) + 1;
  }

  let judged = 0, judgeFailed = 0, judgeModel = null, judgeSpec = null;
  let judgedComparative = 0, judgedAbsolute = 0, comparativeGroups = 0, familyGuardGroups = 0, comparativeFailedGroups = 0;
  let singletonsUnjudged = 0, comparativeRetries = 0;
  let v2Result = null, qualityJudge = null; // judge v2's RESULT diagnostics + the bucket stamp (both null under v1)
  if (v2) {
    const judging = await judgeV2({ args, deps, log, rows, texts, runId, unattended });
    if (judging.error) return { exitCode: 1, error: judging.error };
    ({ judged, judgedComparative, comparativeGroups, comparativeFailedGroups, comparativeRetries, singletonsUnjudged } = judging.counts);
    v2Result = judging.result;
    qualityJudge = judging.qualityJudge;
  } else if (args.judge) {
    judgeModel = deps.judgeModel ? await Promise.resolve().then(() => deps.judgeModel()).catch(() => null) : null;
    const hasComparative = typeof deps.judgeComparative === 'function';
    const hasComparativeOnModel = typeof deps.judgeComparativeOnModel === 'function';
    const targets = rows.filter((r) => leaf.attributeBenchRow(r) === 'measured');
    const specs = Object.keys(attribution);
    // P1.5 (2026-10-06): the comparative judge's spec — pinned by --judge-model, else auto-picked from the model
    // catalog when the Utility seat shares a family with a bench candidate (mb1006a: the qwen3.8-flash Utility
    // seat judging 3 qwen candidates forced ALL 29 question groups to absolute). The absolute fallback judge
    // stays on the Utility seat either way; only the comparative ranking moves.
    if (args.judgeModel) {
      if (!hasComparativeOnModel) {
        log(`  ⚠ --judge-model ${args.judgeModel} ignored — this build does not export live-chat-audit.comparativeJudgeOnModel (deploy first); the Utility seat judges${unattended ? ' — and this UNATTENDED run will REFUSE (exit 1, nothing written) the moment any absolute fallback or judge failure occurs (28d9e351)' : ''}`);
      } else {
        judgeSpec = args.judgeModel;
        log(`judge: comparative judge PINNED to ${judgeSpec} (--judge-model)`);
      }
    } else if (hasComparativeOnModel && judgeModel && targets.some((r) => familyOf(r.spec) === familyOf(judgeModel))) {
      const cards = deps.listCatalog ? await Promise.resolve().then(() => deps.listCatalog()).catch(() => null) : null;
      judgeSpec = pickConflictFreeJudge(cards, specs);
      if (judgeSpec) log(`judge: Utility seat ${judgeModel} shares a family with a bench candidate — comparative judge auto-picked from the model catalog: ${judgeSpec} (open/non-frontier preferred)`);
      else log(`  ⚠ Utility seat ${judgeModel} shares a family with a bench candidate and no conflict-free catalog model was found — every group falls back to absolute scoring (pass --judge-model <spec> to pin one)`);
    }
    const effectiveJudge = judgeSpec || judgeModel; // the family guard vets the judge that actually RANKS
    log(`judge: live-chat-audit ${hasComparative || judgeSpec ? 'COMPARATIVE_RUBRIC — blind: answers grouped per question, labels A/B/C…, presentation order seeded-shuffled' : 'QUALITY_RUBRIC — comparative judge unavailable, absolute per-answer'}${judgeSpec ? ` on ${judgeSpec}` : ` on the Utility seat (${judgeModel || 'unresolved'}; thinking on)`}`);
    for (const w of judgeBiasWarnings(effectiveJudge, specs)) log(`  ⚠ ${w}`);
    const groups = groupByQuestion(targets);
    const t0 = Date.now();
    // Per-answer absolute scoring for one group's rows: the family guard hit, comparative unavailable, or a
    // comparative judge failure (defaultComparativeJudge → null).
    const absoluteFor = async (group) => {
      for (const r of group.rows) {
        const t = texts.get(r.chatId) || { question: '', answer: '' };
        const q = await Promise.resolve().then(() => deps.judge(t.question, t.answer)).catch(() => null);
        if (q && typeof q.score === 'number') { r.quality = q.score; r.qualityIssue = q.issue; judged += 1; judgedAbsolute += 1; } else { judgeFailed += 1; }
      }
    };
    await pool(groups, args.judgeConcurrency, async (group) => {
      // No comparative judge in this build at all: every row is scored absolute — one scale for the whole run.
      if (!judgeSpec && !hasComparative) { await absoluteFor(group); return; }
      // 2026-10-20 singleton hardening: a question only ONE model answered (the others failed / failed over / were
      // diverted) has no rank — it stays UNJUDGED (quality null; n, latency and failRate still count) instead of an
      // absolute score on the comparative scale. Before this, any singleton made an UNATTENDED ingest refuse, so one
      // failed model sank a whole kind run (≈ 80 % odds on a 3-model × 70-question run at a 10 % fail rate).
      if (group.rows.length < 2) { singletonsUnjudged += group.rows.length; return; }
      if (judgeFamilyConflicts(effectiveJudge, group)) { familyGuardGroups += 1; await absoluteFor(group); return; } // disclosed by the ⚠ warnings above
      const { pairs, labelToRow } = anonymizeGroup(group, runId);
      const question = groupQuestion(group, texts);
      const answers = pairs.map((p) => ({ label: p.label, answer: String((texts.get(p.row.chatId) || {}).answer || '') }));
      let mapped = null;
      for (let attempt = 1; attempt <= (args.judgeAttempts || 1) && !mapped; attempt += 1) {
        if (attempt > 1) {
          comparativeRetries += 1;
          await (deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(2000 * (attempt - 1));
        }
        const ranking = judgeSpec
          ? await Promise.resolve().then(() => deps.judgeComparativeOnModel(question, answers, judgeSpec)).catch(() => null)
          : await Promise.resolve().then(() => deps.judgeComparative(question, answers)).catch(() => null);
        mapped = ranking ? mapRankingToModels(ranking, labelToRow) : null;
      }
      if (!mapped) { judgeFailed += 1; comparativeFailedGroups += 1; await absoluteFor(group); return; } // every attempt failed → absolute fallback
      comparativeGroups += 1;
      for (const m of mapped) {
        const row = labelToRow.get(m.label);
        if (!row) continue;
        row.quality = rankToQuality(m.rank, group.rows.length);
        judged += 1; judgedComparative += 1;
      }
    });
    log(`judged ${judged}/${targets.length} measured answer(s) over ${groups.length} group(s) in ${Math.round((Date.now() - t0) / 1000)} s — ${comparativeGroups} comparative group(s) (${judgedComparative} row(s)), ${judgedAbsolute} absolute row(s)${familyGuardGroups ? `, ${familyGuardGroups} family-guard group(s) fell back absolute` : ''}${comparativeFailedGroups ? `, ${comparativeFailedGroups} comparative call(s) failed → absolute` : ''}${judgeFailed ? ` (${judgeFailed} judge call(s) failed — those rows carry no quality)` : ''}${comparativeRetries ? ` · ${comparativeRetries} comparative retr${comparativeRetries === 1 ? 'y' : 'ies'}` : ''}`);
    if (singletonsUnjudged) log(`singletons unjudged: ${singletonsUnjudged} — question(s) only one model answered (the others failed, failed over or were diverted); a lone answer has no comparative rank, so it carries no quality (it still counts in n, latency and failRate)`);
    // 28d9e351 fail-safe (the refuse): an UNATTENDED run that produced ANY absolute-scale row, lost ANY comparative
    // call, or lost ANY judge call at all stops here — exit 1, nothing written, a terminal {"error":…} line the CI
    // ingest job greps red. Those rows are exactly the silent contamination class (mb-open-b2-20261006: 95 absolute
    // rows on the comparative scorecard after every auto-picked judge call 400'd) — including the quality-less shape
    // (reviewer F1: every absolute judge call failing writes rows with NO quality and exit 0, the same degradation).
    // Attended runs keep the disclosed ⚠ + absolute fallback — a human is reading the log and can re-judge.
    if (unattended && (judgedAbsolute > 0 || comparativeFailedGroups > 0 || judgeFailed > 0)) {
      return { exitCode: 1, error: `unattended ingest would write ${judgedAbsolute} absolute-scale row(s) (${familyGuardGroups} family-guard group(s), ${comparativeFailedGroups} failed comparative call(s), ${judgeFailed} failed judge call(s)) — REFUSING so the comparative scorecard is never silently contaminated; pin a working conflict-free judge with --judge-model, or pass --no-judge for a judgeless ingest that writes no quality (28d9e351)` };
    }
    // 2026-10-20 review: the singleton hardening let an ALL-singleton run through (nothing absolute, nothing failed) —
    // a broken run whose quality-null buckets used to wipe the judged ones on --apply (the leaf's merge now keeps
    // judged quality too; this stops the broken run before it rewrites latency / failRate as a "refresh").
    if (allSingletonRun({ measured: targets.length, comparativeGroups, singletonsUnjudged })) {
      if (unattended) return { exitCode: 1, error: allSingletonRefusal(targets.length, singletonsUnjudged) };
      log(allSingletonWarning(targets.length));
    }
  }

  const card = leaf.aggregateBenchRows(rows, { runId, updatedBy: leaf.MODEL_BENCH_UPDATED_BY, ...(qualityJudge ? { qualityJudge } : {}) });
  for (const line of summaryLines(card, attribution)) log(line);
  const agreement = kindAgreement(rows);
  if (agreement.agree + agreement.differ + agreement.unstamped) {
    log(`kind agreement (the title's k:<kind> vs the answer's classified task kind): agree ${agreement.agree} · differ ${agreement.differ} · unstamped ${agreement.unstamped}${agreement.noTitleKind ? ` · no title kind ${agreement.noTitleKind}` : ''}`);
  }
  for (const [spec, a] of Object.entries(attribution)) {
    // (The old hint named CHAT_LEAD_MODEL_OVERRIDE_DISABLED — that switch was deleted 2026-10-08; the per-chat lead
    // column is always honoured on plain chats.)
    if (!a.measured) log(`  ⚠ ${spec}: no answer was led by the spec itself — check that the server stored the per-chat lead pin (the bench's preflight; chat-agent/chat-lead-model.ts resolveChatLeadPick) and the seat fallback (a failover = another model finished the turn)`);
  }

  let applied = false, deleted = 0;
  if (args.apply) {
    // Read the RAW row (storeGet throws on a DB error): a transient read failure must never be merged as "no row"
    // and overwrite every other model's buckets.
    const prevRaw = await store.storeGet(leaf.MODEL_BENCH_STORE_NS, leaf.MODEL_BENCH_STORE_KEY);
    const prev = prevRaw ? leaf.normalizeScorecard(prevRaw) : null;
    const merged = leaf.mergeScorecards(prev, card);
    await store.storePut(leaf.MODEL_BENCH_STORE_NS, leaf.MODEL_BENCH_STORE_KEY, merged);
    applied = true;
    log(`scorecard written: [${leaf.MODEL_BENCH_STORE_NS.join(',')}] / ${leaf.MODEL_BENCH_STORE_KEY} — ${Object.keys(merged.models).length} model(s), runs ${merged.runs.join(', ')}`);
    if (args.cleanup) {
      for (const chat of chats) {
        try { await deps.deleteChat(chat.id, user.id); deleted += 1; } catch (err) { log(`  delete ${chat.id} failed: ${String((err && err.message) || err).slice(0, 120)}`); }
      }
      log(`cleanup: deleted ${deleted}/${chats.length} chat(s) of run ${runId}`);
    }
  } else {
    log('dry run — nothing written (pass --apply to merge this run into the scorecard)');
  }
  return { exitCode: 0, result: { runId, chats: chats.length, rows: rows.length, skipped, attribution, judged, judgedComparative, judgedAbsolute, comparativeGroups, familyGuardGroups, comparativeFailedGroups, comparativeRetries, judgeFailed, singletonsUnjudged, kindAgreement: agreement, judgeModel, judgeSpec, applied, deleted, scorecard: card, ...(v2Result || {}) } };
}

/** The container entry: wires /app/dist (or MODEL_BENCH_DIST) into run() and prints `RESULT {json}`. */
async function main() {
  const argv = process.argv.slice(2);
  const pre = parseArgs(argv, process.env);
  if (pre.error) { console.log(JSON.stringify({ error: pre.error })); process.exit(2); }
  let deps;
  try {
    if (!pre.verbose) { try { require(`${DIST}/utils/logger`).default.silent = true; } catch { /* a missing logger never blocks the ingest */ } }
    const leaf = require(`${DIST}/modules/crossmodel/platform/model-bench-scorecard`);
    const prisma = require(`${DIST}/config/database`).default;
    const store = require(`${DIST}/modules/crossmodel/memory/context-store`);
    const audit = pre.judge ? require(`${DIST}/modules/crossmodel/platform/live-chat-audit`) : null;
    let catalog = null;
    try { catalog = require(`${DIST}/modules/crossmodel/model-endpoints/model-catalog`); } catch { /* optional — the auto-pick no-ops without it */ }
    deps = {
      leaf, prisma, store,
      ...(audit && typeof audit.defaultQualityJudge === 'function' ? { judge: (q, a) => audit.defaultQualityJudge(q, a, []) } : {}),
      ...(audit && typeof audit.defaultComparativeJudge === 'function' ? { judgeComparative: (q, answers) => audit.defaultComparativeJudge(q, answers) } : {}),
      // judge v2 passes { rubric: 'v2' } as the 4th arg; v1 calls with three, exactly as before.
      ...(audit && typeof audit.comparativeJudgeOnModel === 'function' ? { judgeComparativeOnModel: (q, answers, spec, ...opts) => audit.comparativeJudgeOnModel(q, answers, spec, ...opts) } : {}),
      // An older build's comparativeJudgeOnModel ignores the rubric option — judge v2 refuses to run on it (exit 3).
      ...(audit ? { rubricV2: typeof audit.COMPARATIVE_RUBRIC_V2 === 'string' } : {}),
      ...(catalog ? { listCatalog: () => catalog.listChatModelCatalog() } : {}),
      judgeModel: async () => {
        const roles = require(`${DIST}/modules/crossmodel/model-endpoints/model-roles.service`);
        return (await roles.resolveRoleModel('utility')) || 'deepseek-flash'; // '' = the built-in DeepSeek → DashScope chain
      },
      deleteChat: (chatId, userId) => require(`${DIST}/modules/crossmodel/crossmodel.service`).default.deleteChat(chatId, userId),
      // 28d9e351: the real unattended signal — docker exec (prodq.sh) and systemd-run both leave stdin a pipe.
      isTTY: !!process.stdin.isTTY,
    };
  } catch (err) {
    console.log(JSON.stringify({ error: `runtime modules unavailable (${err && err.message}) — is model-bench-scorecard deployed on this box?` }));
    process.exit(3);
  }
  const out = await run({ argv, env: process.env, deps });
  if (out.error) { console.log(JSON.stringify({ error: out.error })); process.exit(out.exitCode); }
  console.log('RESULT ' + JSON.stringify(out.result));
}

if (require.main === module) {
  main()
    .then(async () => { try { await require(`${DIST}/config/database`).default.$disconnect(); } catch { /* ignore */ } process.exit(0); })
    .catch((err) => { console.log(JSON.stringify({ error: String((err && err.message) || err).slice(0, 300) })); process.exit(1); });
}

module.exports = {
  run, parseArgs, pool, familyOf, judgeBiasWarnings, pickConflictFreeJudge, summaryLines, kindAgreement, allSingletonRun, seededRng, anonSeedFor, groupByQuestion, anonymizeGroup, groupQuestion, judgeFamilyConflicts, mapRankingToModels, rankToQuality, unattendedContext, DEFAULT_UNATTENDED_JUDGE,
  // judge v2 (2026-10-20)
  DEFAULT_JUDGE_PANEL, JUDGE_V2_BALLOT_DESIGN, JUDGE_V2_DEFAULT_CONCURRENCY, fnv1a, seededOrder, ballotsFor, plannedBallotCounts, aggregateBallots, lengthSlope, kendallTau, spearman, lengthDiagnostics, positionConsistency, qualityJudgeStamp, panelWarnings,
};

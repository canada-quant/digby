#!/usr/bin/env node
/**
 * backfill-decision-gate-spend.js — ONE-SHOT WRITE (owner 2026-09-28: "did you make
 * sure to add jev to api costs as well" — it had not been: 13,743 decision_gate rows
 * / 12.27M input tokens in 24 h and ZERO run_spend / run_tokens_* rows for any
 * decision backend, so Account → Admin → API costs showed nothing for Jev).
 *
 * Mints the MISSING spend rows for the decision-gate calls already recorded:
 * every `decision_gate` row of the last 14 days (`--days N` overrides) that is a
 * real answered call — phase 'decision', ok, NOT a memo hit — and carries the
 * backend's reported `meta.inputTokens` gets
 *     run_tokens_in  (value = inputTokens, meta.model / profile 'decision' / purpose / backend / decisionId)
 *     run_spend      (value = USD at the decision price table, meta.priceSource, meta.backfill = <run id>)
 * with `createdAt` = the decision row's own createdAt, `runId` = `dg-<decisionId>`
 * and `sessionId` = the row's sessionId (else the synthetic `decision-gate`), so the
 * explorer's per-day / per-window history is honest. Rows WITHOUT inputTokens are
 * skipped and counted (`skippedNoUsage`) — the live gate estimates those from the
 * prefill it holds, but the stored row has no prompt size to estimate from. No
 * run_tokens_out rows are minted (the readout's per-question output is not on the
 * stored row; Jev's is 0).
 *
 * IDEMPOTENT via meta.decisionId: a decision id that already has a run_spend row
 * (from the live gate since the 2026-09-28 deploy, or an earlier run of this script)
 * is skipped (`skippedExisting`). Re-running is safe.
 *
 * PRICES come from the SAME module the live gate uses (decision-gate-pricing:
 * Jev list $0.042/M in, $0 out — or the TYPESAFE_USD_PER_MTOK_IN/_OUT env in the
 * container; deepseek-flash list; a registry spec at $0 self_hosted — the script does
 * not resolve registry prices; re-price on read handles those once set).
 *
 * DRY RUN BY DEFAULT (prints counts per backend / purpose and the USD it WOULD mint; writes nothing):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-decision-gate-spend.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-decision-gate-spend.js --apply
 * Options: --days N (window, default 14, max 30 — loop_metrics retention), --batch N (rows per createMany, default 500),
 *          --limit N (cap the decision rows minted this invocation; re-run to continue), --run <id> (stamp; default a timestamp).
 *
 * NOTE on prodq.sh: its header says probes must stay read-only. This file is a deliberate
 * owner-directed write one-shot (the same exception as backfill-chat-mode-auto.js) — every
 * write sits behind `--apply`; without it the script is a read-only probe like the others.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it from /app):
 * `require('/app/dist/config/database')` is the backend's own Prisma client and
 * `require('/app/dist/modules/crossmodel/platform/decision-gate-pricing')` the live price table.
 * Testable offline: `module.exports.run({ prisma, pricing, argv })` takes mocked modules
 * (backend/src/scripts/backfill-decision-gate-spend.test.ts).
 *
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 */
'use strict';

const DEFAULT_DAYS = 14;
const MAX_DAYS = 30;
const DEFAULT_BATCH = 500;
const PROFILE = 'decision';
const SYNTHETIC_SESSION = 'decision-gate';
const PRICING_MODULE_CANDIDATES = ['/app/dist/modules/crossmodel/platform/decision-gate-pricing', '/app/dist/src/modules/crossmodel/platform/decision-gate-pricing'];

function parseArgs(argv) {
  const out = { apply: false, days: DEFAULT_DAYS, batch: DEFAULT_BATCH, limit: null, run: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a.startsWith('--days=')) out.days = Number(a.slice('--days='.length));
    else if (a === '--batch') out.batch = Number(argv[++i]);
    else if (a.startsWith('--batch=')) out.batch = Number(a.slice('--batch='.length));
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a === '--run') out.run = String(argv[++i] || '');
    else if (a.startsWith('--run=')) out.run = a.slice('--run='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(out.days) || out.days <= 0) throw new Error('--days must be a positive number');
  out.days = Math.min(MAX_DAYS, out.days);
  if (!Number.isFinite(out.batch) || out.batch <= 0) throw new Error('--batch must be a positive number');
  if (out.limit !== null && (!Number.isFinite(out.limit) || out.limit <= 0)) throw new Error('--limit must be a positive number');
  return out;
}

/** The live price table from the container's dist/, or an injected one (tests). */
function loadPricing(injected) {
  if (injected) return injected;
  for (const c of PRICING_MODULE_CANDIDATES) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error(`decision-gate-pricing module not found in ${PRICING_MODULE_CANDIDATES.join(', ')} — run inside the backend container (prodq.sh)`);
}

/** The model id the rows are priced under — the same rule as decision-gate.ts spendModelFor. */
function spendModelOf(meta, pricing) {
  const spec = String(meta.backendSpec || '');
  const modelId = typeof meta.modelId === 'string' ? meta.modelId : '';
  if (spec.includes(':')) return spec;
  if (spec === 'jev' || (!spec && modelId && pricing.isJevModelId(modelId))) return modelId && pricing.isJevModelId(modelId) ? modelId : 'jev-1.13.0';
  if (spec === 'deepseek-flash') return 'deepseek-flash';
  // Pre-2026-09-26 rows carry no backendSpec — fall back to the label / reported id.
  const backend = String(meta.backend || '');
  if (/typesafe jev/i.test(backend)) return modelId && pricing.isJevModelId(modelId) ? modelId : 'jev-1.13.0';
  if (/deepseek/i.test(backend)) return 'deepseek-flash';
  return modelId || spec || '';
}

/** Is this decision_gate row a real, answered, non-memo call with reported usage? */
function isMintable(row) {
  const m = row && row.meta && typeof row.meta === 'object' ? row.meta : null;
  if (!m) return false;
  if (m.phase !== 'decision' || m.ok !== true || m.cached === true) return false;
  if (typeof m.id !== 'string' || !m.id) return false;
  const tokens = Number(m.inputTokens);
  return Number.isFinite(tokens) && tokens > 0;
}

/** The two rows one decision mints (pure; exported for the test). */
function rowsFor(row, pricing, runId) {
  const m = row.meta;
  const model = spendModelOf(m, pricing);
  if (!model) return null;
  const inTokens = Math.floor(Number(m.inputTokens));
  const price = pricing.decisionPriceFor(model);
  const usd = pricing.decisionCallUsd(price, inTokens, 0);
  const provider = pricing.decisionProviderOf(model, m.backendSpec);
  const sessionId = row.sessionId && String(row.sessionId).trim() ? String(row.sessionId).trim() : SYNTHETIC_SESSION;
  const common = {
    model, ...(provider ? { provider } : {}), profile: PROFILE, purpose: String(m.purpose || '?'), backend: String(m.backend || '?'),
    ...(m.backendSpec ? { backendSpec: m.backendSpec } : {}), ...(m.backendKind ? { backendKind: m.backendKind } : {}),
    decisionId: m.id, ...(m.challenger === true ? { challenger: true } : {}), estimated: false, backfill: runId,
  };
  const base = { sessionId, runId: `dg-${m.id}`, createdAt: row.createdAt };
  return [
    { ...base, kind: 'run_tokens_in', value: inTokens, unit: 'tokens', meta: { ...common } },
    { ...base, kind: 'run_spend', value: usd, unit: 'usd', meta: { ...common, models: [model], turns: 1, inTokens, outTokens: 0, priceSource: price.source, usdPerMTokIn: price.in, usdPerMTokOut: price.out, ...(price.source === 'unpriced' || price.source === 'self_hosted' ? { unpriced: true } : {}), ...(typeof row.value === 'number' ? { ms: Math.round(row.value) } : {}) } },
  ];
}

async function selectDecisionRows(client, since, limit) {
  return client.loopMetric.findMany({
    where: { kind: 'decision_gate', createdAt: { gte: since } },
    select: { id: true, sessionId: true, value: true, meta: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    ...(limit ? { take: limit } : {}),
  });
}

async function selectExistingDecisionIds(client, since) {
  const rows = await client.loopMetric.findMany({
    where: { kind: 'run_spend', createdAt: { gte: since } },
    select: { meta: true },
  });
  const ids = new Set();
  for (const r of rows) {
    const m = r && r.meta && typeof r.meta === 'object' ? r.meta : null;
    if (m && m.profile === PROFILE && typeof m.decisionId === 'string' && m.decisionId) ids.add(m.decisionId);
  }
  return ids;
}

function countBy(rows, keyOf) {
  const out = {};
  for (const r of rows) { const k = keyOf(r); out[k] = (out[k] || 0) + 1; }
  return out;
}

async function run(opts = {}) {
  const argv = opts.argv || process.argv.slice(2);
  const print = !!opts.print;
  const parsed = parseArgs(argv);
  if (parsed.help) {
    const text = 'usage: backfill-decision-gate-spend.js [--apply] [--days N] [--batch N] [--limit N] [--run <id>]';
    if (print) console.log(text);
    return { help: text };
  }
  const client = opts.prisma || require('/app/dist/config/database').default;
  const pricing = loadPricing(opts.pricing);
  const now = opts.now ? new Date(opts.now) : new Date();
  const since = new Date(now.getTime() - parsed.days * 24 * 60 * 60 * 1000);
  const runId = parsed.run || `dg-spend-${now.toISOString().replace(/[:.]/g, '-')}`;
  const report = { script: 'backfill-decision-gate-spend', run: runId, at: now.toISOString(), since: since.toISOString(), days: parsed.days, apply: parsed.apply, dryRun: !parsed.apply };

  const [decisionRows, existing] = await Promise.all([selectDecisionRows(client, since, parsed.limit), selectExistingDecisionIds(client, since)]);
  report.decisionRows = decisionRows.length;
  let skippedNoUsage = 0, skippedExisting = 0, skippedNoModel = 0;
  const plan = [];
  for (const row of decisionRows) {
    if (!isMintable(row)) { skippedNoUsage++; continue; }
    if (existing.has(row.meta.id)) { skippedExisting++; continue; }
    const rows = rowsFor(row, pricing, runId);
    if (!rows) { skippedNoModel++; continue; }
    plan.push({ decisionId: row.meta.id, rows });
  }
  report.skippedNoUsage = skippedNoUsage;
  report.skippedExisting = skippedExisting;
  report.skippedNoModel = skippedNoModel;
  report.toMint = plan.length;
  const spendRows = plan.map((p) => p.rows[1]);
  report.byBackend = countBy(spendRows, (r) => r.meta.backend);
  report.byPurpose = countBy(spendRows, (r) => r.meta.purpose);
  report.byModel = countBy(spendRows, (r) => r.meta.model);
  report.inputTokens = spendRows.reduce((s, r) => s + (r.meta.inTokens || 0), 0);
  report.usd = Math.round(spendRows.reduce((s, r) => s + r.value, 0) * 1e6) / 1e6;
  report.unpricedRows = spendRows.filter((r) => r.meta.unpriced).length;
  if (!parsed.apply) {
    report.wouldInsert = plan.length * 2;
    if (print) console.log(JSON.stringify(report, null, 2));
    return report;
  }
  let inserted = 0;
  const all = plan.flatMap((p) => p.rows);
  for (let i = 0; i < all.length; i += parsed.batch) {
    const chunk = all.slice(i, i + parsed.batch);
    const res = await client.loopMetric.createMany({ data: chunk });
    inserted += res && typeof res.count === 'number' ? res.count : chunk.length;
  }
  report.inserted = inserted;
  if (print) console.log(JSON.stringify(report, null, 2));
  return report;
}

module.exports = { run, parseArgs, rowsFor, isMintable, spendModelOf, selectDecisionRows, selectExistingDecisionIds, PROFILE, SYNTHETIC_SESSION, DEFAULT_DAYS, MAX_DAYS, DEFAULT_BATCH, PRICING_MODULE_CANDIDATES };

if (require.main === module) {
  run({ print: true })
    .then(() => process.exit(0))
    .catch((err) => {
      const usage = /unknown argument|--days must|--batch must|--limit must/.test(String(err && err.message));
      console.error(`backfill-decision-gate-spend: ${err && err.message ? err.message : err}`);
      process.exit(usage ? 2 : 1);
    });
}

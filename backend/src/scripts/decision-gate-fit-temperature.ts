/**
 * Decision gate — the FLIP-READINESS report + the readout temperature fit
 * (WI-I 2026-09-25 → E1 2026-09-25, docs/DECISION_MODEL_ENHANCEMENTS_2026-09-25.md §4/§6).
 *
 * Reads loop_metrics kind='decision_gate' rows for the window and prints TWO
 * things:
 *
 * 1. READINESS, per (backend, purpose) — the ONLY numbers that can justify an
 *    act flip. Pairs EVERY labelled outcome row (meta.actual not null) with its
 *    decision by meta.id — TypeSafe Jev / systemone rows via meta.answers,
 *    readout rows via meta.logits — dedupes by meta.stateHash (or sha256 of a
 *    stored state text; undedupable rows are counted), partitions by
 *    meta.questionsHash (the newest partition is judged), and reports n, span,
 *    accuracy, Brier, ECE, AUROC of (1 − confidence) as an error detector,
 *    coverage at ≤ 5 % error, precision inside the ACT BAND at the purpose's
 *    REAL cutoff (env DECISION_GATE_THRESHOLD_<PURPOSE> or the consumer's
 *    default — never 0.5), positives, and a frozen-policy threshold search
 *    (60/40 time split, sessions kept whole). Then READY / NOT READY against
 *    the §6 bars, every missed bar named.
 *
 *    --stamp writes the per-purpose verdict to the context store
 *    (['instance','decision-gate'] / 'readiness' → { <purpose>: { ready, at,
 *    metrics, … } }) so the admin flip can be admitted against it and the
 *    admin page (Model roles → Decision gate → readiness) shows it.
 *
 * 2. TEMPERATURE FIT (unchanged): one readout temperature per (backend,
 *    purpose) from meta.logits — the line to stage is
 *    DECISION_GATE_TEMP_<PURPOSE>=<T> on EVERY box that runs the purpose (A, B
 *    and C — docs/REMOTE_OPS.md); the runtime clamps to [0.7, 10]. Fewer than
 *    --min rows (default 50) → NOT READY, do not ship it.
 *
 * SINCE 2026-09-25 the same report is produced AUTOMATICALLY by the worker's
 * `decision-gate-readiness` cron job (platform/decision-gate-readiness.job.ts,
 * every DECISION_GATE_READINESS_INTERVAL_MIN — the stamp no longer waits for
 * a human); this CLI is the on-demand / ad-hoc-window / --json view of the
 * SAME builder (`buildReadinessArtifacts`). It lives under src/scripts/ so
 * `tsc` compiles it into dist/scripts/ and the PROD IMAGE can run it (the
 * image has no scripts/ dir and no tsx — the 2026-09-25 live defect).
 *
 * Usage (read-only unless --stamp; needs DATABASE_URL — the backend .env or the container env):
 *   cd backend && npm run decision-gate:fit -- [--days=14] [--purpose=wake_triage] [--min=50] [--json] [--stamp]
 *     (the npm script runs dist/scripts/decision-gate-fit-temperature.js when a build exists, else tsx over this file)
 *   inside the prod image:  docker exec admin-worker-<color> node dist/scripts/decision-gate-fit-temperature.js --days=14 --stamp
 *   from the repo root:     npx tsx scripts/decision-gate-fit-temperature.ts …
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ACT_POLICIES, READINESS_BARS,
  type DecisionGateRow, type ReadinessEntry, type ReadinessRow,
} from '../modules/crossmodel/platform/decision-gate-fit';
import { buildReadinessArtifacts, type FitReportEntry, type ReadinessStamp } from '../modules/crossmodel/platform/decision-gate-readiness';

export type { FitReportEntry };

interface Args { days: number; purpose: string | null; min: number; json: boolean; stamp: boolean }

export function parseArgs(argv: string[]): Args {
  const args: Args = { days: 14, purpose: null, min: 50, json: false, stamp: false };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'days') args.days = Math.max(1, Number(v) || 14);
    else if (k === 'purpose') args.purpose = (v || '').trim() || null;
    else if (k === 'min') args.min = Math.max(1, Number(v) || 50);
    else if (k === 'json') args.json = true;
    else if (k === 'stamp') args.stamp = true;
  }
  return args;
}

/** Pure: rows → per-(backend, purpose) temperature fits (the job's builder, narrowed — exported for the harness test). */
export function buildReport(rows: DecisionGateRow[], opts: { purpose?: string | null; min: number }): FitReportEntry[] {
  return buildReadinessArtifacts(rows as ReadinessRow[], { days: 0, purpose: opts.purpose, min: opts.min }).fits;
}

/**
 * Pure: rows → readiness entries + the stamp the --stamp flag would write —
 * byte-identical to what the worker job stores (same builder). Without
 * --purpose every ACT_POLICIES purpose appears (unlabelled ones NOT READY,
 * "no labelled outcomes in the window" first).
 */
export function buildReadiness(rows: ReadinessRow[], opts: { purpose?: string | null; days: number; env?: Record<string, string | undefined>; now?: Date }): { report: ReadinessEntry[]; stamp: ReadinessStamp } {
  const art = buildReadinessArtifacts(rows, { days: opts.days, purpose: opts.purpose, env: opts.env, now: opts.now });
  return { report: art.entries, stamp: art.stamp };
}

function fmt(n: number, d = 4): string { return Number.isFinite(n) ? n.toFixed(d) : 'n/a'; }
function pct(n: number): string { return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : 'n/a'; }

export function printReadiness(report: ReadinessEntry[], stamp: ReadinessStamp, args: Args, totalRows: number): void {
  console.log(`decision-gate FLIP READINESS — ${totalRows} decision_gate rows in the last ${args.days} day(s)${args.purpose ? `, purpose=${args.purpose}` : ''}`);
  console.log(`bars: labels ≥ ${READINESS_BARS.minLabels} over ≥ ${READINESS_BARS.minDays} d (deduped, newest question partition); act-band precision ≥ ${READINESS_BARS.minActBandPrecision} (Wilson 95% LOWER bound ≥ bar, R&D exp #6) on ≥ ${READINESS_BARS.minActBandN} band rows at the REAL cutoff; AUROC(1−conf → error) ≥ ${READINESS_BARS.minAuroc}; coverage@≤5% error ≥ ${READINESS_BARS.minCoverageAt5}; calibrated backend; imessage_send positives ≥ ${READINESS_BARS.imessageMinPositives}`);
  if (!report.length) {
    console.log('No (backend, purpose) group has a labelled outcome row (meta.actual not null, acted:false) paired with a decision. Nothing to judge yet.');
  }
  for (const r of report) {
    const m = r.metrics;
    const policy = ACT_POLICIES[r.purpose];
    console.log('');
    console.log(`── ${r.purpose} · ${r.backend}${r.calibrated ? '' : ' (UNCALIBRATED readout)'} — ${r.ready ? 'READY' : 'NOT READY'}`);
    console.log(`   labels n=${m.n} over ${m.days.toFixed(1)} d (deduped ${m.deduped}, undedupable ${m.undedupable}; partitions ${Object.entries(m.partitions).map(([k, v]) => `${k || '(none)'}:${v}`).join(', ')})`);
    console.log(`   accuracy@0.5 ${fmt(m.accuracy)}   Brier ${fmt(m.brier)}   ECE ${fmt(m.ece)}   positives ${m.positives} / negatives ${m.negatives}`);
    console.log(`   AUROC(1−confidence vs disagreement) ${fmt(m.auroc, 3)}   coverage@≤5% error ${pct(m.coverageAt5.coverage)} (cut ≥ ${m.coverageAt5.threshold ?? 'n/a'}, ${m.coverageAt5.n} rows, ${m.coverageAt5.errors} errors)`);
    console.log(`   act band at REAL cutoff τ=${m.actBand.threshold}${policy ? ` (${policy.kind === 'noul_low' ? `noul ≤ ${(1 - m.actBand.threshold).toFixed(2)}` : `confidence ≥ ${m.actBand.threshold}`} — ${policy.consumer})` : ''}: n=${m.actBand.n}, correct ${m.actBand.correct}, precision ${fmt(m.actBand.precision, 3)}, would shed ${pct(m.actBand.coverage)}`);
    if (m.suggestedThreshold) {
      const s = m.suggestedThreshold;
      console.log(`   threshold search (frozen policy, 60/40 by time, sessions whole): τ=${s.threshold} → selection precision ${fmt(s.selection.band.precision, 3)} / coverage ${pct(s.selection.band.coverage)} (n=${s.selection.n}); HELD-OUT precision ${fmt(s.holdout.band.precision, 3)} / coverage ${pct(s.holdout.band.coverage)} (n=${s.holdout.n}) — a suggestion, not applied`);
    } else {
      console.log('   threshold search: no τ clears the precision bar with ≥ 10 band rows on the selection set');
    }
    if (!r.ready) for (const reason of r.reasons) console.log(`   ✗ ${reason}`);
  }
  console.log('');
  console.log('VERDICT per purpose (the backend with the most labelled rows):');
  const purposes = Object.keys(stamp).sort();
  if (!purposes.length) console.log('   (none)');
  for (const p of purposes) console.log(`   ${stamp[p].ready ? 'READY     ' : 'NOT READY '} ${p} · ${stamp[p].backend}${stamp[p].ready ? '' : ` — ${stamp[p].reasons[0] ?? ''}${stamp[p].reasons.length > 1 ? ` (+${stamp[p].reasons.length - 1} more)` : ''}`}`);
}

function printReport(report: FitReportEntry[], args: Args, totalRows: number): void {
  console.log('');
  console.log(`decision-gate temperature fit — ${totalRows} decision_gate rows in the last ${args.days} day(s)${args.purpose ? `, purpose=${args.purpose}` : ''}`);
  if (!report.length) {
    console.log('No (backend, purpose) group has paired READOUT rows: readout decision rows need meta.logits (persisted since WI-I) AND an outcome row with a non-null actual (WI-C for wake_triage / delta_material / self_audit). Nothing to fit yet (systemone / Jev rows are calibrated server-side and need no temperature).');
    return;
  }
  for (const r of report) {
    console.log('');
    console.log(`── ${r.purpose} · ${r.backend} — n=${r.n}${r.skipped ? ` (skipped ${r.skipped} with the actual outside the top-k)` : ''} ${r.ready ? '' : `— NOT READY (< ${args.min} rows)`}`);
    console.log(`   accuracy (argmax)   ${fmt(r.accuracy)}`);
    console.log(`   NLL    T=1 ${fmt(r.nllAt1)}  →  T=${r.temperature} ${fmt(r.nllAtT)}`);
    console.log(`   Brier  T=1 ${fmt(r.brierAt1)}  →  T=${r.temperature} ${fmt(r.brierAtT)}`);
    console.log(`   ECE    T=1 ${fmt(r.eceAt1)}  →  T=${r.temperature} ${fmt(r.eceAtT)}`);
    console.log(`   ${r.ready ? 'suggested' : 'would be'}: ${r.envLine}`);
  }
  const perPurpose = new Map<string, FitReportEntry[]>();
  for (const r of report) perPurpose.set(r.purpose, [...(perPurpose.get(r.purpose) ?? []), r]);
  for (const [purpose, entries] of perPurpose) {
    if (entries.length > 1) {
      console.log('');
      console.log(`NOTE: ${purpose} was served by ${entries.length} readout backends; DECISION_GATE_TEMP_<PURPOSE> is per PURPOSE — the line above from the backend with the most rows (${entries[0].backend}) is the one to ship, and the other backend's readout will be slightly off until it has its own seat.`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set (run from backend/ with its .env, or export it).');
    process.exit(2);
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false } }),
  });
  try {
    const since = new Date(Date.now() - args.days * 24 * 3600 * 1000);
    const rows = await prisma.loopMetric.findMany({
      where: { kind: 'decision_gate', createdAt: { gte: since } },
      select: { meta: true, createdAt: true, sessionId: true },
      orderBy: { createdAt: 'asc' },
    });
    const readiness = buildReadiness(rows as ReadinessRow[], { purpose: args.purpose, days: args.days, env: process.env });
    const report = buildReport(rows as DecisionGateRow[], { purpose: args.purpose, min: args.min });
    if (args.json) {
      console.log(JSON.stringify({ rows: rows.length, days: args.days, readiness: readiness.report, stamp: readiness.stamp, report }, null, 2));
    } else {
      printReadiness(readiness.report, readiness.stamp, args, rows.length);
      printReport(report, args, rows.length);
    }
    if (args.stamp) {
      const { writeReadinessStamp } = await import('../modules/crossmodel/platform/decision-gate-readiness');
      if (args.purpose) {
        // A single-purpose run must not erase the other purposes' verdicts.
        const { readReadinessStamp } = await import('../modules/crossmodel/platform/decision-gate-readiness');
        const existing = (await readReadinessStamp()) ?? {};
        await writeReadinessStamp({ ...existing, ...readiness.stamp });
      } else {
        await writeReadinessStamp(readiness.stamp);
      }
      if (!args.json) console.log(`\nstamped instance:decision-gate/readiness for ${Object.keys(readiness.stamp).length} purpose(s) at ${new Date().toISOString()}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err?.message || err);
    process.exit(1);
  });
}

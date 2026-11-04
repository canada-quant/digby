/**
 * Decision gate — the sampled-state EXPORT (Laya follow-up, 2026-09-26).
 *
 * Prints laya-evals JSONL to stdout: one line per SAMPLED decision state
 * (loop_metrics kind 'decision_gate_state' — written when
 * DECISION_GATE_STATE_SAMPLE_RATE[_<PURPOSE>] draws an ask) paired with the
 * primary's LABELLED outcome rows for the same decision id:
 *   { state, questions, expected: { <question>: <actual key> }, tags: [purpose, backendSpec] }
 * (+ id / stateChars / questionsHash / sampledAt for provenance). A state
 * with no labelled outcome is skipped unless --unlabelled (expected: {}).
 * Read-only. Pure pairing in buildExportRecords (unit-tested).
 *
 * Usage (needs DATABASE_URL — the backend .env or the container env):
 *   cd backend && npm run decision-gate:export -- --purpose=wake_triage --days=28 [--limit=5000] [--unlabelled] > wake_triage.jsonl
 *   inside the prod image:  node dist/scripts/decision-gate-export.js --purpose=wake_triage --days=28
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { actualToKey, outcomeLabelEntersFit, type DecisionGateRow } from '../modules/crossmodel/platform/decision-gate-fit';

export interface ExportArgs { days: number; purpose: string | null; limit: number; unlabelled: boolean }

export function parseArgs(argv: string[]): ExportArgs {
  const args: ExportArgs = { days: 28, purpose: null, limit: 0, unlabelled: false };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'days') args.days = Math.max(1, Number(v) || 28);
    else if (k === 'purpose') args.purpose = (v || '').trim() || null;
    else if (k === 'limit') args.limit = Math.max(0, Math.floor(Number(v) || 0));
    else if (k === 'unlabelled') args.unlabelled = true;
  }
  return args;
}

export interface ExportRecord {
  state: string;
  questions: Record<string, unknown>;
  /** question → the reasoning path's actual, in the outcome vocabulary ('yes' / 'no' / choice key / level). */
  expected: Record<string, string>;
  tags: string[];
  id: string;
  stateChars: number;
  questionsHash?: string;
  sampledAt?: string;
  /** The stored state was cut at DECISION_GATE_STATE_SAMPLE_MAX_CHARS. */
  stateTruncated?: boolean;
}

/**
 * Pure: sampled-state rows + decision_gate rows (only their PRIMARY outcome
 * rows are read: phase 'outcome', challenger !== true, acted:false, actual !==
 * null, OUTCOME_LABEL_FOR_FIT) → export records in state-row order.
 */
export function buildExportRecords(stateRows: DecisionGateRow[], outcomeRows: DecisionGateRow[], opts: { purpose?: string | null; unlabelled?: boolean; limit?: number } = {}): ExportRecord[] {
  const labels = new Map<string, Record<string, string>>();
  for (const r of outcomeRows) {
    const m = r?.meta;
    if (!m || m.phase !== 'outcome' || !m.id || !m.question) continue;
    if (m.challenger === true || m.acted === true) continue;
    const actual = actualToKey(m.actual);
    if (actual === null) continue;
    if (!outcomeLabelEntersFit(String(m.purpose || ''), m.label)) continue;
    const byQ = labels.get(String(m.id)) ?? {};
    if (!(String(m.question) in byQ)) byQ[String(m.question)] = actual;
    labels.set(String(m.id), byQ);
  }
  const out: ExportRecord[] = [];
  for (const r of stateRows) {
    const m = r?.meta;
    if (!m || typeof m.id !== 'string' || typeof m.state !== 'string') continue;
    const purpose = String(m.purpose || '');
    if (opts.purpose && purpose !== opts.purpose) continue;
    const expected = labels.get(m.id) ?? {};
    if (!Object.keys(expected).length && !opts.unlabelled) continue;
    const questions = m.questions && typeof m.questions === 'object' && !Array.isArray(m.questions) ? (m.questions as Record<string, unknown>) : {};
    const tags = [purpose, ...(typeof m.backendSpec === 'string' && m.backendSpec ? [m.backendSpec] : [])];
    out.push({
      state: m.state, questions, expected, tags, id: m.id,
      stateChars: typeof m.stateChars === 'number' ? m.stateChars : m.state.length,
      ...(typeof m.questionsHash === 'string' ? { questionsHash: m.questionsHash } : {}),
      ...(r.createdAt ? { sampledAt: new Date(r.createdAt).toISOString() } : {}),
      ...(m.stateSampleTruncated === true ? { stateTruncated: true } : {}),
    });
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/** One JSONL line per record (no trailing newline on the last). */
export function toJsonl(records: ReadonlyArray<ExportRecord>): string {
  return records.map(r => JSON.stringify(r)).join('\n');
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
    const stateRows = await prisma.loopMetric.findMany({
      where: { kind: 'decision_gate_state', createdAt: { gte: since } },
      select: { meta: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const outcomeRows = await prisma.loopMetric.findMany({
      where: { kind: 'decision_gate', createdAt: { gte: since } },
      select: { meta: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const records = buildExportRecords(stateRows as DecisionGateRow[], outcomeRows as DecisionGateRow[], { purpose: args.purpose, unlabelled: args.unlabelled, limit: args.limit });
    if (records.length) process.stdout.write(`${toJsonl(records)}\n`);
    console.error(`${records.length} record(s) from ${stateRows.length} sampled state(s) and ${outcomeRows.length} decision_gate row(s) in the last ${args.days} day(s)${args.purpose ? ` for ${args.purpose}` : ''}${args.unlabelled ? ' (unlabelled included)' : ''}`);
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

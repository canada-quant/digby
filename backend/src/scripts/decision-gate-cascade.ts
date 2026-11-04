/**
 * Decision gate — the OFFLINE cascade curve CLI (Laya follow-up, 2026-09-26).
 *
 * Pairs the window's primary ↔ challenger ↔ outcome rows for ONE purpose and
 * prints, for τ on 0.50 … 0.99, what a cascade "first leg answers when
 * confident at τ, else the primary" would cover and whether it holds the
 * Learn-then-Test bar (α 0.10 risk, δ 0.05 level, fixed-sequence strict →
 * loose) and the non-inferiority margin on Δ. Pure math lives in
 * platform/decision-gate-cascade.ts (unit-tested); this file only reads rows
 * and prints. NO act-path cascade exists — this is the ruler.
 *
 * Usage (read-only; needs DATABASE_URL — the backend .env or the container env):
 *   cd backend && npm run decision-gate:cascade -- --days=14 --purpose=wake_triage --first='cql:agx-laya' --margin=0.03 [--alpha=0.10] [--delta=0.05] [--json]
 *   inside the prod image:  node dist/scripts/decision-gate-cascade.js --days=14 --purpose=wake_triage --first=cql:agx-laya
 * The per-(spec, purpose) temperatures come from the store row
 * instance:decision-gate/backends `temps` (read directly through prisma — no
 * config/env boot); --no-temps ignores them.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { DecisionGateRow } from '../modules/crossmodel/platform/decision-gate-fit';
import {
  CASCADE_ALPHA_DEFAULT, CASCADE_DELTA_DEFAULT, CASCADE_MARGIN_DEFAULT, cascadeCurve, formatCascadeTable, pairCascadeRows,
  type CascadeCurve,
} from '../modules/crossmodel/platform/decision-gate-cascade';

export interface CascadeArgs { days: number; purpose: string | null; first: string | null; margin: number; alpha: number; delta: number; json: boolean; temps: boolean }

export function parseArgs(argv: string[]): CascadeArgs {
  const args: CascadeArgs = { days: 14, purpose: null, first: null, margin: CASCADE_MARGIN_DEFAULT, alpha: CASCADE_ALPHA_DEFAULT, delta: CASCADE_DELTA_DEFAULT, json: false, temps: true };
  const num = (v: string | undefined, fallback: number, lo: number, hi: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
  };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'days') args.days = Math.max(1, Number(v) || 14);
    else if (k === 'purpose') args.purpose = (v || '').trim() || null;
    else if (k === 'first') args.first = (v || '').trim().replace(/^['"]|['"]$/g, '') || null;
    else if (k === 'margin') args.margin = num(v, CASCADE_MARGIN_DEFAULT, 0, 0.5);
    else if (k === 'alpha') args.alpha = num(v, CASCADE_ALPHA_DEFAULT, 0.001, 0.5);
    else if (k === 'delta') args.delta = num(v, CASCADE_DELTA_DEFAULT, 0.001, 0.5);
    else if (k === 'json') args.json = true;
    else if (k === 'no-temps') args.temps = false;
  }
  return args;
}

/** Pure: rows → the curve for (purpose, first). Exported for the harness test. */
export function buildCascade(rows: DecisionGateRow[], opts: { purpose: string; first: string; margin?: number; alpha?: number; delta?: number; temps?: Record<string, number>; env?: Record<string, string | undefined> }): CascadeCurve {
  const { pairs, stats } = pairCascadeRows(rows, { purpose: opts.purpose, first: opts.first, temps: opts.temps });
  return cascadeCurve(pairs, { purpose: opts.purpose, first: opts.first, margin: opts.margin, alpha: opts.alpha, delta: opts.delta, env: opts.env, stats });
}

/** Pure: the backends store row → its finite positive temps (the readiness module's rule, mirrored). */
export function tempsOfRow(row: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const temps = row && typeof row === 'object' ? (row as { temps?: unknown }).temps : undefined;
  if (!temps || typeof temps !== 'object' || Array.isArray(temps)) return out;
  for (const [k, v] of Object.entries(temps as Record<string, unknown>)) {
    const n = Number(v);
    if (k.includes('|') && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.purpose || !args.first) {
    console.error('usage: decision-gate:cascade -- --purpose=<purpose> --first=<backend spec> [--days=14] [--margin=0.03] [--alpha=0.10] [--delta=0.05] [--json] [--no-temps]');
    process.exit(2);
  }
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
      select: { meta: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    let temps: Record<string, number> = {};
    if (args.temps) {
      try {
        const row = await prisma.contextStoreEntry.findUnique({ where: { namespacePath_key: { namespacePath: 'instance:decision-gate', key: 'backends' } }, select: { value: true } });
        temps = tempsOfRow(row?.value);
      } catch (err: any) {
        console.error(`(temps unreadable — ${err?.message || err}; continuing with T = 1)`);
      }
    }
    const curve = buildCascade(rows as DecisionGateRow[], { purpose: args.purpose, first: args.first, margin: args.margin, alpha: args.alpha, delta: args.delta, temps, env: process.env as Record<string, string | undefined> });
    if (args.json) {
      console.log(JSON.stringify({ rows: rows.length, days: args.days, temps, curve }, null, 2));
    } else {
      console.log(`${rows.length} decision_gate rows in the last ${args.days} day(s); temps in force: ${Object.keys(temps).length ? Object.entries(temps).map(([k, v]) => `${k}=${v}`).join(', ') : 'none'}`);
      console.log(formatCascadeTable(curve));
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

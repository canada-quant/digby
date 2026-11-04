/**
 * `npm run switches:check` / `npm run switches:sync` / `npm run switches:report` — build
 * 2026-10-08 S-1. The CLI over the switch registry
 * (src/modules/crossmodel/platform/switch-registry.ts) and the scanner (scripts/switch-scan.ts).
 *
 *   check  — print every registry violation (the same checks the CI test runs); exit 1 on any.
 *   sync   — rewrite the SWITCHES block: add a row for every switch the code reads that has
 *            none (kind by suffix, added = today, release expiry = today + RELEASE_LIFETIME_DAYS),
 *            drop rows no longer read, keep every hand-edited field, sort. When the only change
 *            is removals it appends the SWITCH_COUNT_LEDGER line itself; a raise needs YOUR
 *            justification line (printed as a template). Never writes a notForwarded marker.
 *   report — counts by kind / forwarding + the release switches expiring in the next 14 days.
 *
 * Env: SWITCH_REGISTRY_TODAY=YYYY-MM-DD overrides today (rehearse an expiry date).
 */
import * as fs from 'fs';
import * as path from 'path';
import { scanRepo, areaFor, repoRoot } from './switch-scan';
import {
  SWITCHES, SWITCH_COUNT_LEDGER, RELEASE_LIFETIME_DAYS, NF_INERT, NF_INERT_OPT_IN, NF_PENDING_FORWARD, NF_EDGE_ONLY, NF_BENCH_ONLY,
  addDays, defaultKindFor, expiringSoon, staleForwards, switchRegistrySummary, switchRegistryViolations, type SwitchSpec,
} from '../src/modules/crossmodel/platform/switch-registry';

export const REGISTRY_FILE = path.join(repoRoot(), 'backend', 'src', 'modules', 'crossmodel', 'platform', 'switch-registry.ts');

export function todayIso(env: NodeJS.ProcessEnv = process.env): string {
  const o = (env.SWITCH_REGISTRY_TODAY || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(o) ? o : new Date().toISOString().slice(0, 10);
}

const NF_CONSTS: Record<string, string> = { NF_INERT, NF_INERT_OPT_IN, NF_PENDING_FORWARD, NF_EDGE_ONLY, NF_BENCH_ONLY };

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** One registry row as its source line. */
export function rowLine(s: SwitchSpec): string {
  const parts = [`name: ${q(s.name)}`, `area: ${q(s.area)}`, `kind: ${q(s.kind)}`, `added: ${q(s.added)}`];
  if (s.expires) parts.push(`expires: ${q(s.expires)}`);
  if (s.side) parts.push(`side: ${q(s.side)}`);
  if (s.notForwarded !== undefined) {
    const c = Object.entries(NF_CONSTS).find(([, v]) => v === s.notForwarded);
    parts.push(`notForwarded: ${c ? c[0] : q(s.notForwarded)}`);
  }
  return `  { ${parts.join(', ')} },`;
}

/** Replace the SWITCHES block of the registry source with `rows`. */
export function renderRegistrySource(src: string, rows: readonly SwitchSpec[]): string {
  const start = src.indexOf('export const SWITCHES: readonly SwitchSpec[] = [');
  const end = src.indexOf('];\n// END SWITCHES', start);
  if (start < 0 || end < 0) throw new Error('switch-registry.ts: SWITCHES block markers not found');
  const head = src.slice(0, start) + 'export const SWITCHES: readonly SwitchSpec[] = [\n';
  return head + rows.map(rowLine).join('\n') + (rows.length ? '\n' : '') + src.slice(end);
}

/** Append one ledger line to the registry source. */
export function appendLedgerLine(src: string, line: { on: string; count: number; why: string }): string {
  const start = src.indexOf('export const SWITCH_COUNT_LEDGER: readonly SwitchCountLine[] = [');
  const end = src.indexOf('\n];', start);
  if (start < 0 || end < 0) throw new Error('switch-registry.ts: SWITCH_COUNT_LEDGER block not found');
  return src.slice(0, end) + `\n  { on: ${q(line.on)}, count: ${line.count}, why: ${q(line.why)} },` + src.slice(end);
}

export interface SyncPlan { rows: SwitchSpec[]; added: SwitchSpec[]; removed: string[] }

/** The synced row list (pure given the scan). */
export function planSync(current: readonly SwitchSpec[], scan: ReturnType<typeof scanRepo>, today: string): SyncPlan {
  const read = new Map<string, { side?: 'frontend'; files: string[] }>();
  for (const [n, files] of scan.backend) read.set(n, { files });
  for (const [n, files] of scan.frontend) if (!read.has(n)) read.set(n, { side: 'frontend', files });
  const keep = current.filter(s => read.has(s.name));
  const removed = current.filter(s => !read.has(s.name)).map(s => s.name);
  const have = new Set(keep.map(s => s.name));
  const added: SwitchSpec[] = [];
  for (const [name, r] of read) {
    if (have.has(name)) continue;
    const kind = defaultKindFor(name);
    const row: SwitchSpec = { name, area: r.side === 'frontend' ? 'frontend' : areaFor(r.files), kind, added: today };
    if (kind === 'release') row.expires = addDays(today, RELEASE_LIFETIME_DAYS);
    if (r.side) row.side = r.side;
    added.push(row);
  }
  const rows = [...keep, ...added].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { rows, added, removed };
}

function main(argv: string[]): number {
  const cmd = argv[0] || 'check';
  const today = todayIso();
  const scan = scanRepo();
  if (cmd === 'check') {
    const v = switchRegistryViolations(scan, today);
    for (const x of v) console.log(`✗ [${x.kind}] ${x.message}`);
    const stale = staleForwards(scan);
    if (stale.length) console.log(`⚠ docker-compose.app.yml still forwards ${stale.length} switch(es) no code reads (drop the lines): ${stale.join(', ')}`);
    console.log(v.length ? `\n${v.length} switch-registry violation(s).` : `switch registry OK (${SWITCHES.length} switches).`);
    return v.length ? 1 : 0;
  }
  if (cmd === 'sync') {
    const plan = planSync(SWITCHES, scan, today);
    let src = renderRegistrySource(fs.readFileSync(REGISTRY_FILE, 'utf8'), plan.rows);
    const last = SWITCH_COUNT_LEDGER[SWITCH_COUNT_LEDGER.length - 1];
    if (plan.removed.length && !plan.added.length && last && last.count !== plan.rows.length) {
      src = appendLedgerLine(src, { on: today, count: plan.rows.length, why: `removed: ${plan.removed.join(', ')}` });
    }
    fs.writeFileSync(REGISTRY_FILE, src);
    for (const s of plan.added) console.log(`+ ${s.name} (${s.kind}, area ${s.area})`);
    for (const n of plan.removed) console.log(`- ${n}`);
    if (plan.added.length) {
      console.log(`\nNow, for each added switch: forward it in docker-compose.app.yml (backend + worker; frontend: build arg + Dockerfile ARG) or set notForwarded to why prod never needs it, re-classify ops kill switches, and append a ledger line:\n  { on: '${today}', count: ${plan.rows.length}, why: '<the new switch(es) and why each needs a switch, not an eval case>' },`);
    }
    if (!plan.added.length && !plan.removed.length) console.log('switch registry already in sync.');
    return 0;
  }
  if (cmd === 'report') {
    const sum = switchRegistrySummary();
    console.log(JSON.stringify(sum, null, 2));
    const soon = expiringSoon(today, 14);
    console.log(`\n${soon.length} release switch(es) expire within 14 days:`);
    for (const s of soon) console.log(`  ${s.expires}  ${s.name} (${s.area})`);
    return 0;
  }
  console.error('usage: switches.ts check | sync | report');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

/**
 * DEPTH-BUDGET CONSUMER PIN (H2, audit 2026-09-26 — finding tests-gaps-4).
 *
 * Why: `DepthBudget.maxBackgroundMs` was produced by depth-budget.ts, copied
 * into the compute_policy telemetry row and metadata.depth on every human
 * turn, documented as a "hard rail the harness enforces" — and read by NO
 * code path. The 17-min research council of 2026-09-26 20:51Z ran past the
 * 15-min budget it recorded. A budget field the row claims but nothing
 * enforces misleads every later readout that trusts the row.
 *
 * Contract (the doctrine-coverage pattern): the set of DepthBudget keys with
 * NO enforcing read outside depth-budget.ts must EQUAL the explicit allowlist
 * below. An "enforcing read" is a `budget.<key>` / `budget?.<key>` access in a
 * non-test source file that is not a COPIER line (`<key>: budget.<key>` — the
 * telemetry / metadata copy idiom) and not a comment. Adding a field to
 * DepthBudget without a consumer fails here; so does adding a consumer for
 * an allowlisted key without removing it from the allowlist (the allowlist
 * is a statement of fact, not a permission).
 */
import * as fs from 'fs';
import * as path from 'path';

const CROSSMODEL_DIR = path.resolve(__dirname, '..');
const BUDGET_FILE = path.join(CROSSMODEL_DIR, 'platform', 'depth-budget.ts');

/**
 * Keys with NO enforcing read today, each with the reason it is honest to
 * leave them so. Remove a key from here the moment a consumer lands.
 */
const ALLOWLIST: Record<string, string> = {
  checker: 'enforced BY CONSTRUCTION through the plan it was derived from: shouldSpawnChecker reads plan.spawnChecker / plan.checkerWaitMs (compute-policy-wiring), not the budget; budgetVerdict has no harness caller yet',
  checkerEffort: "derived from plan.leadEffort / the stakes wait; the lead's effort override keys on plan.leadEffort (chat-agent.service), not the budget",
  council: 'enforced BY CONSTRUCTION through mode/plan: isCouncil keys on mode===deep_research (the controller sets it for the research rung); nothing consumes a gate-acted council:background yet',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full, out); continue; }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
    if (full === BUDGET_FILE) continue;
    out.push(full);
  }
  return out;
}

function depthBudgetKeys(): string[] {
  const src = fs.readFileSync(BUDGET_FILE, 'utf8');
  const m = src.match(/export interface DepthBudget \{([\s\S]*?)\n\}/);
  if (!m) throw new Error('DepthBudget interface not found in depth-budget.ts');
  return m[1].split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('/') && !l.startsWith('*'))
    .map(l => l.replace(/[?]?:.*$/, '').trim()).filter(Boolean);
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
const isCopier = (key: string, line: string) => new RegExp(`\\b${key}\\s*:\\s*budget\\??\\.${key}\\b`).test(line);
const isRead = (key: string, line: string) => new RegExp(`\\bbudget\\??\\.${key}\\b`).test(line);

function enforcingReads(key: string, files: string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isComment(line) || isCopier(key, line) || !isRead(key, line)) return;
      hits.push(`${path.relative(CROSSMODEL_DIR, f)}:${i + 1}`);
    });
  }
  return hits;
}

describe('DepthBudget consumer pin — every budget key the row records has an enforcing read, or is allowlisted with a reason', () => {
  const files = walk(CROSSMODEL_DIR);
  const keys = depthBudgetKeys();

  it('reads the interface (sanity: the four keys are present; maxUsd is GONE — owner 2026-09-27, no hidden cost caps)', () => {
    expect(keys).toEqual(expect.arrayContaining(['checker', 'checkerEffort', 'council', 'maxBackgroundMs']));
    expect(keys).not.toContain('maxUsd');
    expect(files.length).toBeGreaterThan(50);
  });

  it('REGRESSION PIN (no cap when no project cap is set): no non-test source reads a `budget.maxUsd` — nothing can refuse a rung or force a final turn on USD', () => {
    expect(enforcingReads('maxUsd', files)).toEqual([]);
  });

  it('keys with no enforcing read EQUAL the allowlist', () => {
    const unread = keys.filter(k => enforcingReads(k, files).length === 0).sort();
    const allow = Object.keys(ALLOWLIST).sort();
    const missing = unread.filter(k => !allow.includes(k));
    const stale = allow.filter(k => !unread.includes(k));
    expect({ missingConsumer: missing, staleAllowlist: stale }).toEqual({ missingConsumer: [], staleAllowlist: [] });
  });

  it('maxBackgroundMs is enforced by researchRungDeadlineMs (H2) in chat-agent/compute-policy-wiring.ts', () => {
    expect(enforcingReads('maxBackgroundMs', files).some(h => h.startsWith('chat-agent/compute-policy-wiring.ts:'))).toBe(true);
  });

  it('the copier idiom is recognised (a telemetry copy is not an enforcing read) and a plain read is', () => {
    expect(isCopier('maxBackgroundMs', '  budget: { checker: budget.checker, maxBackgroundMs: budget.maxBackgroundMs },')).toBe(true);
    expect(isRead('maxBackgroundMs', '  const max = Number(budget?.maxBackgroundMs);')).toBe(true);
    expect(isCopier('maxBackgroundMs', '  const max = Number(budget?.maxBackgroundMs);')).toBe(false);
    expect(isComment(' * run — DEPTH_BUDGET_MAX_BACKGROUND_MS, default 15 min')).toBe(true);
  });
});

/**
 * Research-rung wording pins (audit/research-rung-dig-deeper, 2026-09-26,
 * finding docs-drift-1). The Dig-deeper research rung runs INLINE on the
 * tapper's own SSE stream: crossmodel.controller.ts rewrites `mode` to
 * `deep_research` on the SAME request and falls through to the ordinary
 * pipeline, chat-agent.service.ts sets `plan = escalationPlan(rung)`, and the
 * "Deeper findings" row + notify_user are written by that same run. Nothing
 * queues it at start (a deploy drain requeues it as an escalation — the
 * SIGTERM ritual), and since the same audit wave `maxBackgroundMs` IS enforced
 * on that rung (compute-policy-wiring researchRungDeadlineMs) and on the
 * checker / late-check bound (depth-budget backgroundBoundMs) — the consumer
 * set below pins exactly those. The user-facing help, CLAUDE.md, the server progress
 * line and two engineer comments used to say "background" / "detached"; these
 * pins keep every surface honest and make a future enforcer update the
 * wording in the same change. The plan LABEL `council:'background'` is
 * deliberately unchanged (depth-ux-contract.test.ts pins it; the budget reads
 * the rung, nextRungForPlan reads the label to suppress a second chip).
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate', COMPUTE_POLICY: 'compute_policy', UX_TTFT: 'ux_ttft' },
  recordLoopMetric: jest.fn(),
}));
jest.mock('../platform/supervisor.service', () => ({ __esModule: true, classifySupervisorNote: () => 'supervisor_note' }));
import * as fs from 'fs';
import * as path from 'path';
import { PROGRESS_LINES, escalationPlan } from './compute-policy-wiring';
import { isExportTree, readDroppedFile } from '../../../utils/export-mode';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const read = (abs: string) => fs.readFileSync(abs, 'utf8');
const norm = (s: string) => s.replace(/\s+/g, ' ');

// CLAUDE.md is DROPPED-PRIVATE doctrine: a public export does not ship it, so
// the clause pin below cannot run there. `readDroppedFile` returns null in a
// genuine export (licensing the skip) and THROWS when the file is missing from
// any other kind of tree — a damaged private checkout keeps failing loudly.
const CLAUDE: string | null = readDroppedFile('CLAUDE.md', REPO_ROOT);
const IN_EXPORT = isExportTree(REPO_ROOT);

/** Every non-test .ts file under backend/src that mentions maxBackgroundMs, repo-relative. */
function filesMentioning(needle: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(abs); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
      if (read(abs).includes(needle)) out.push(path.relative(REPO_ROOT, abs));
    }
  };
  walk(path.resolve(REPO_ROOT, 'backend/src'));
  return out.sort();
}

describe('research rung — the wording matches the inline run (docs-drift-1)', () => {
  it('the server progress line for deeper_findings_started no longer claims a background job', () => {
    expect(PROGRESS_LINES.deeper_findings_started).not.toMatch(/background|detach|queue/i);
    expect(PROGRESS_LINES.deeper_findings_started).toContain('Deeper findings');
  });

  it('the plan shape is untouched — council:"background" stays the label the budget flag and chip suppressor read', () => {
    expect(escalationPlan('research', 1).council).toBe('background');
    expect(escalationPlan('research', 1).rung).toBe('research');
  });

  it('the escalation runs on the same request: the controller rewrites mode and falls through (no queue, no worker)', () => {
    const controller = read(path.resolve(REPO_ROOT, 'backend/src/modules/crossmodel/crossmodel.controller.ts'));
    // unify-routing (same audit wave): the controller derives the run MODE from the ONE escalation resolver's preset.
    expect(controller).toContain('mode = escalationPlan(rung, 0).preset;');
    expect(controller).toContain('escalation = { ofMessageId: row.id, rung };');
    const service = read(path.resolve(__dirname, 'chat-agent.service.ts'));
    expect(service).toContain('plan = escalationPlan(args.escalation.rung, STAKES_WAIT_MS);');
  });

  it('engineer comments describe the inline run, not a detached one', () => {
    const service = read(path.resolve(__dirname, 'chat-agent.service.ts'));
    expect(service).not.toMatch(/the council, run detached/);
    expect(service).toMatch(/run INLINE on this same stream/);
    const budget = read(path.resolve(__dirname, '../platform/depth-budget.ts'));
    expect(budget).not.toMatch(/longest a background job/);
    // The H2 enforcer landed in the same audit wave: the header is the honest ENFORCED inventory. Since 2026-10-20
    // (deep research has no wall clock) the bound is the Double Checker's / late reconcile's only — the rung runs
    // unclocked, and budgeted again only under RESEARCH_NO_WALL_CLOCK_DISABLED=1.
    expect(budget).toMatch(/maxBackgroundMs\s+ENFORCED on the Double Checker \/ late reconcile only/);
    expect(budget).toMatch(/NO LONGER bounds the Dig-deeper\s+\*\s+RESEARCH rung/);
    expect(budget).toMatch(/runs INLINE on the tapper's stream/);
    expect(budget).toMatch(/RESEARCH_NO_WALL_CLOCK_DISABLED=1/);
  });

  it('maxBackgroundMs has exactly its enforcing consumers (audit H2 + settings-switches-5): the research-rung rail + the checker / late-check bound — the budget leaf, the telemetry row and the metrics doc comment', () => {
    // If this set changes, a consumer landed or left: update depth-budget.ts's header + the
    // help copy (a council that a cap can end is a different promise) in the same change.
    expect(filesMentioning('maxBackgroundMs')).toEqual([
      'backend/src/modules/crossmodel/chat-agent/chat-agent.service.ts',
      'backend/src/modules/crossmodel/chat-agent/compute-policy-wiring.ts',
      'backend/src/modules/crossmodel/chat-agent/late-crosscheck.ts',
      'backend/src/modules/crossmodel/platform/compute-policy-gate.ts',
      'backend/src/modules/crossmodel/platform/decision-outcome-labels.ts', // the facts row's backgroundDeadlineHit doc names the bound (telemetry, not an enforcer)
      'backend/src/modules/crossmodel/platform/depth-budget.ts',
      // loop-metric-kinds.ts (not the service): the registry moved to the
      // import-free leaf (6665fff6 A8) and its doc comment still names the bound.
      'backend/src/modules/crossmodel/platform/loop-metric-kinds.ts',
    ]);
  });

  it('the user-facing help and CLAUDE.md say the run continues on this turn (and the served twin is in sync)', () => {
    const help = read(path.resolve(REPO_ROOT, 'docs/DEPTH_AND_DIG_DEEPER.md'));
    expect(norm(help)).not.toMatch(/runs it in the background/);
    expect(norm(help)).toMatch(/you can navigate away or close the tab/);
    expect(read(path.resolve(REPO_ROOT, 'frontend/content/help/depth.md'))).toBe(help);
    // The help doc is PUBLIC (asserted above); the CLAUDE.md clause is private
    // doctrine. In an export the file's ABSENCE is the expected fact — assert it
    // rather than silently skipping, so the skip is itself a verified claim.
    if (CLAUDE === null) {
      expect(IN_EXPORT).toBe(true);
      expect(fs.existsSync(path.resolve(REPO_ROOT, 'CLAUDE.md'))).toBe(false);
      return;
    }
    expect(CLAUDE).not.toMatch(/a council is a background job/);
    expect(CLAUDE).toMatch(/runs on the tapper's own SSE stream/);
  });
});

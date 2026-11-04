/**
 * Framework facts — the DECISION GATE ROLL-OUT line (rollout self-governance,
 * 2026-09-27): every supervisor prompt names which purposes are act / shadow /
 * off / parked / capped RIGHT NOW, the tier rule, recent automaton actions and
 * the one self-knowledge sentence; the block still fits its cap with every
 * purpose in act and passes the hygiene lint.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import * as fs from 'fs';
import * as path from 'path';
import { frameworkFactsBlock, gateRolloutFactsSync, FRAMEWORK_FACTS_MAX_CHARS, GATE_SELF_KNOWLEDGE_SENTENCE } from './framework-facts';
import { DECISION_PURPOSES } from './decision-gate-modes';
import { ROLLOUT_TIER_RULE } from './decision-gate-registry';
import { emptyRolloutState, primeRolloutStateCache, clearRolloutStateCache } from './decision-gate-rollout';
import { lintPromptText, type AllowlistEntry } from './prompt-hygiene';
import { LAYER_BUDGETS } from './prompt-layers';

const ALL = DECISION_PURPOSES.map(p => p.purpose);
const allow = (JSON.parse(fs.readFileSync(path.join(__dirname, 'prompt-hygiene.allow.json'), 'utf8')) as { entries: AllowlistEntry[] }).entries;
const projects = (JSON.parse(fs.readFileSync(path.join(__dirname, 'prompt-hygiene.projects.json'), 'utf8')) as { names: string[] }).names;

afterEach(() => clearRolloutStateCache());

describe('framework facts — the roll-out line', () => {
  it('names shadow / off / parked / capped, the tier rule, recent actions and the self-knowledge sentence', () => {
    const state = emptyRolloutState();
    state.parked.browser_driver = { until: new Date(Date.now() + 86_400_000).toISOString(), reason: 'r', demotedAt: [] };
    state.actions = [{ at: new Date(Date.now() - 2 * 3_600_000).toISOString(), purpose: 'wake_triage', from: 'shadow', to: 'act', reason: 'flipped' }];
    state.lastSummary = 'flipped 1';
    primeRolloutStateCache(state);
    // NODE_ENV=test resolves every purpose to 'off' on this process, so the lists are passed the way prod composes them.
    const shadow = ALL.filter(p => !['wake_triage', 'sweep_triage', 'tool_intent', 'browser_driver'].includes(p));
    const f = frameworkFactsBlock({ actPurposes: ['wake_triage', 'sweep_triage'], rollout: { shadow, off: ['tool_intent'] }, asOf: new Date('2026-09-27T00:00:00Z') });
    const line = f.split('\n').find(l => l.startsWith('- DECISION GATE ROLL-OUT'))!;
    expect(line).toBeDefined();
    expect(line).toMatch(/shadow: [a-z_, ]*auto_route[a-z_, ]*;/);
    expect(line).not.toMatch(/shadow: [^;]*wake_triage/);
    expect(line).toMatch(/off: tool_intent;/);
    expect(line).toMatch(/parked \(auto-demoted twice, held a week\): browser_driver;/);
    expect(line).toMatch(/capped at shadow in code: drain_triage, self_audit, task_kind, tool_intent\./); // backlog E13 (2026-09-28): tool_intent retired ⇒ capped too
    expect(line).toContain('Auto-rollout is on: ' + ROLLOUT_TIER_RULE);
    expect(line).toContain('Recent: wake_triage shadow → act (2 h ago).');
    expect(line).toContain(GATE_SELF_KNOWLEDGE_SENTENCE);
    expect(line).toContain('get_decision_gate_status');
    // ONE date in the whole block — the header.
    expect(f.match(/\b20\d\d-\d\d-\d\d\b/g)).toEqual(['2026-09-27']);
  });

  it('reads the live facts on this process (nothing primed): every purpose shadow / off from env, auto-rollout unknown', () => {
    const r = gateRolloutFactsSync([]);
    expect(r.parked).toEqual([]);
    expect(r.autoRollout).toBeNull();
    expect(r.recent).toBeNull();
    expect([...r.shadow, ...r.off].sort()).toEqual([...ALL].sort());
    expect(r.capped).toEqual(['drain_triage', 'self_audit', 'task_kind', 'tool_intent']); // backlog E13 (2026-09-28) + task_kind (task-aware pick 2026-10-20: a pure evidence key)
    const f = frameworkFactsBlock({ actPurposes: [] });
    expect(f).toContain('Auto-rollout state unknown on this process');
  });

  it('fits the cap with EVERY purpose in act (bounds → names → counts degrade before the clip) and the layer budget agrees', () => {
    const f = frameworkFactsBlock({ actPurposes: ALL, asOf: new Date('2026-09-27T00:00:00Z') });
    expect(f.length).toBeLessThanOrEqual(FRAMEWORK_FACTS_MAX_CHARS);
    expect(f).not.toMatch(/…$/);
    for (const p of ALL) expect(f).toContain(p);
    expect(LAYER_BUDGETS.facts).toBe(FRAMEWORK_FACTS_MAX_CHARS);
    // A pathological roll-out input still degrades to counts instead of clipping mid-sentence.
    const long = frameworkFactsBlock({ actPurposes: ALL, rollout: { recent: 'x'.repeat(900) } });
    expect(long.length).toBeLessThanOrEqual(FRAMEWORK_FACTS_MAX_CHARS);
  });

  it('passes the prompt-hygiene lint with the live roll-out facts (no dates beyond the header, no env toggles, no model ids)', () => {
    const state = emptyRolloutState();
    state.actions = [{ at: new Date(Date.now() - 30 * 3_600_000).toISOString(), purpose: 'auto_route', from: 'shadow', to: 'act', reason: 'flipped' }];
    state.lastSummary = 'DRY RUN: flipped 0';
    primeRolloutStateCache(state);
    const facts = frameworkFactsBlock({ actPurposes: ['wake_triage', 'sweep_triage', 'imessage_send', 'auto_route'] });
    expect(facts).toContain('Auto-rollout is on (dry run)');
    const findings = lintPromptText({ source: 'facts', text: facts, layer: 'facts', datedHeaderAllowed: true, projectNames: projects, allow });
    expect(findings).toEqual([]);
  });
});

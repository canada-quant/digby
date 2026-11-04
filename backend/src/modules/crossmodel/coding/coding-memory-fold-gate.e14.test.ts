/**
 * coding-memory-fold-gate.ts — backlog E14 (2026-09-28):
 *   - the act cutoff moved 0.8 → 0.9 (site constant + ACT_POLICIES in lockstep;
 *     a leg at noul 0.15 — skippable at 0.8 — now RUNS, 0.05 still skips);
 *   - the gate state gains harness facts (doc sizes, last-fold ages, counts)
 *     ahead of the prose.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS: { MEMORY_SHRUNK: 'memory_shrunk', DECISION_GATE: 'decision_gate' } }));
const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

import {
  CODING_MEMORY_FOLD_DEFAULT_THRESHOLD, CODING_MEMORY_FOLD_QUESTION, buildCodingMemoryFoldState, codingMemoryFoldStateFacts, consultCodingMemoryFoldGate,
  type CodingMemoryFoldGateInput,
} from './coding-memory-fold-gate';
import { ACT_POLICIES } from '../platform/decision-gate-fit';

const NOW = new Date('2026-09-28T12:00:00Z');
const INPUT: CodingMemoryFoldGateInput = {
  legs: ['session', 'project', 'user'], userMessage: 'add a CI step', assistantSummary: 'ran npm run lint; added the CI step', toolsUsed: ['run_command', 'edit_file'], sessionId: 's1', now: NOW,
  existing: {
    sessionSummary: 'Session is wiring CI.', projectCommands: ['npm test'], projectNotes: ['uses pnpm', 'node 22'], userPreferences: ['use pnpm'],
    sessionUpdatedAt: '2026-09-28T11:30:00Z', projectUpdatedAt: '2026-09-27T12:00:00Z', userUpdatedAt: 'not-a-date',
  },
};
const gateAnswer = (mode: 'act' | 'shadow', nouls: Record<string, number>) => ({
  id: 'g1', mode, backend: 'TypeSafe Jev', ms: 3,
  answers: Object.fromEntries(Object.entries(nouls).map(([k, v]) => [k, { type: 'noul', noul: v }])),
});

beforeEach(() => { jest.clearAllMocks(); mockMode.mockReturnValue('off'); });

describe('E14 — cutoff 0.9', () => {
  it('the site constant and ACT_POLICIES agree at 0.9', () => {
    expect(CODING_MEMORY_FOLD_DEFAULT_THRESHOLD).toBe(0.9);
    expect(ACT_POLICIES.coding_memory_fold.defaultThreshold).toBe(0.9);
  });
  it('act: a leg at 0.05 skips, a leg at 0.15 (skippable at the old 0.8 cutoff) RUNS, a leg at exactly 0.1 skips', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gateAnswer('act', { [CODING_MEMORY_FOLD_QUESTION.session]: 0.05, [CODING_MEMORY_FOLD_QUESTION.project]: 0.15, [CODING_MEMORY_FOLD_QUESTION.user]: 0.1 }));
    const r = await consultCodingMemoryFoldGate(INPUT);
    expect(r.skip).toEqual({ session: true, project: false, user: true, journal: false });
  });
});

describe('E14 — harness facts in the gate state', () => {
  it('codingMemoryFoldStateFacts: doc chars / item counts / fold ages in minutes (an unparsable clock is dropped) / assistant chars / tool count', () => {
    expect(codingMemoryFoldStateFacts(INPUT)).toEqual({
      existing_session_summary_chars: 'Session is wiring CI.'.length,
      existing_project_doc_chars: 'npm test'.length + 'uses pnpm'.length + 'node 22'.length,
      existing_project_items: 3,
      existing_user_preference_items: 1,
      session_fold_age_min: 30,
      project_fold_age_min: 24 * 60,
      assistant_did_chars: INPUT.assistantSummary.length,
      tools_used_count: 2,
    });
    expect(codingMemoryFoldStateFacts({ legs: ['journal'], userMessage: '', assistantSummary: '', toolsUsed: [] } as any)).toMatchObject({ existing_session_summary_chars: 0, existing_project_items: 0, tools_used_count: 0 });
  });
  it('buildCodingMemoryFoldState carries the facts BEFORE the prose', () => {
    const state = buildCodingMemoryFoldState(INPUT);
    const keys = Object.keys(state);
    expect(state.session_fold_age_min).toBe(30);
    expect(state.existing_project_doc_chars).toBe(24);
    expect(keys.indexOf('existing_project_doc_chars')).toBeLessThan(keys.indexOf('tools_used'));
    expect(keys.indexOf('tools_used')).toBeLessThan(keys.indexOf('assistant_did'));
  });
});

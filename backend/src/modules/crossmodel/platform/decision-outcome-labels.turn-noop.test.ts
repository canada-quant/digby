/**
 * decision-outcome-labels — supervisor_turn_noop (agent-decisions 2026-09-27):
 *  - the will_act label is HARNESS-derived: a mutating platform tool call in the
 *    transcript ⇒ acted. The model's own "ACTIONS TAKEN" marker is a CLAIM, not
 *    evidence (fixer 2026-09-27) — a final that narrates actions with zero
 *    mutating tool calls labels FALSE; the note kind rides the note only;
 *  - the stash's `extra` ({ origin, control, pinned, pins }) rides the outcome
 *    row; a PINNED turn's row is excludeFromFit (the band mirrors the act rule);
 *  - SIBLING stashes (DecisionStash.also) are each labelled from the same run;
 *  - a failed run labels nothing (actual:null) but still pairs.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// loop-metrics pulls prisma → config/env (parseEnv exits a keyless jest process) — mocked like decision-outcome-labels.test.ts.
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  recordLoopMetrics: jest.fn(),
  LOOP_METRIC_KINDS: new Proxy({}, { get: (_t, k) => String(k).toLowerCase() }),
}));
jest.mock('./supervisor.service', () => ({
  __esModule: true,
  classifySupervisorNote: (c: unknown) => (/no-op/i.test(String(c)) ? 'supervisor_noop' : /ACTIONS TAKEN/.test(String(c)) ? 'supervisor_action' : 'supervisor_note'),
}));

const mockRecord: jest.Mock = jest.fn();
jest.mock('./decision-gate', () => ({
  __esModule: true,
  ...jest.requireActual('./decision-gate'),
  recordDecisionOutcome: (...a: any[]) => mockRecord(...a),
}));

import { deriveMachineRunActual, labelMachineRunOutcome, PURPOSE_QUESTION } from './decision-outcome-labels';
import { stashDecision, stashExtra, stashSiblings } from './decision-gate';

const decision = (id: string, purpose: string, willAct: number): any => ({
  id, purpose, mode: 'shadow', backend: 'TypeSafe Jev', ms: 100,
  answers: { will_act: { type: 'noul', noul: willAct }, needs_turn_now: { type: 'noul', noul: willAct } },
});

beforeEach(() => mockRecord.mockClear());

describe('supervisor_turn_noop label', () => {
  it('is registered on will_act; acted ⇔ a mutating platform tool call — the model\'s ACTIONS TAKEN claim alone is NOT evidence (fixer 2026-09-27)', () => {
    expect(PURPOSE_QUESTION.supervisor_turn_noop).toBe('will_act');
    expect(deriveMachineRunActual('supervisor_turn_noop', { toolNames: ['send_chat_message'], noteKind: 'supervisor_noop' })).toBe(true);
    // A receipt-minting control / coordination mutation is harness evidence too (RECEIPT_TOOLS ⊂ PLATFORM_MUTATING_TOOLS).
    expect(deriveMachineRunActual('supervisor_turn_noop', { toolNames: ['get_chat_status', 'pause_schedule'], noteKind: 'supervisor_note' })).toBe(true);
    // 'ACTIONS TAKEN' final, zero mutating tools ⇒ actual:false — since W6-3 (audit 2026-10-08) for wake_triage too;
    // WAKE_TRIAGE_HARNESS_LABEL_DISABLED=1 restores the older purposes' marker clause.
    expect(deriveMachineRunActual('supervisor_turn_noop', { toolNames: ['get_chat_status'], noteKind: 'supervisor_action' })).toBe(false);
    expect(deriveMachineRunActual('wake_triage', { toolNames: ['get_chat_status'], noteKind: 'supervisor_action' })).toBe(false);
    process.env.WAKE_TRIAGE_HARNESS_LABEL_DISABLED = '1';
    try {
      expect(deriveMachineRunActual('wake_triage', { toolNames: ['get_chat_status'], noteKind: 'supervisor_action' })).toBe(true);
      expect(deriveMachineRunActual('supervisor_turn_noop', { toolNames: ['get_chat_status'], noteKind: 'supervisor_action' })).toBe(false);
    } finally { delete process.env.WAKE_TRIAGE_HARNESS_LABEL_DISABLED; }
    expect(deriveMachineRunActual('supervisor_turn_noop', { toolNames: ['get_chat_status', 'update_supervisor_state'], noteKind: 'supervisor_note' })).toBe(false);
    expect(deriveMachineRunActual('supervisor_turn_noop', { toolNames: [], noteKind: 'supervisor_noop' })).toBe(false);
  });

  it('an ACTIONS TAKEN final with no mutating tool call labels actual:false through the finalize; a PINNED stash stamps excludeFromFit on its row', async () => {
    const claimed = stashDecision(decision('d5', 'supervisor_turn_noop', 0.1), 'supervisor_turn_noop', { extra: { origin: 'sweep', control: false } })!;
    await labelMachineRunOutcome(claimed, { parts: [{ type: 'tool_call', name: 'get_chat_status' }, { type: 'tool_call', name: 'update_supervisor_state' }], finalText: 'ACTIONS TAKEN\n1. nudged the lane (no receipt)', sessionId: 'sup' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'will_act', actual: false, note: expect.stringContaining('finalized: supervisor_action; mutating 0') });
    expect(mockRecord.mock.calls[0][2].excludeFromFit).toBeUndefined();
    mockRecord.mockClear();
    const pinned = stashDecision(decision('d6', 'supervisor_turn_noop', 0.05), 'supervisor_turn_noop', { extra: { origin: 'drain', control: false, pinned: true, pins: 'new_input' } })!;
    await labelMachineRunOutcome(pinned, { parts: [{ type: 'tool_call', name: 'send_chat_message' }], finalText: 'ACTIONS TAKEN\n1. steered', sessionId: 'sup' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'will_act', actual: true, excludeFromFit: true, extra: { pinned: true, pins: 'new_input' } });
    mockRecord.mockClear();
    await labelMachineRunOutcome(pinned, { parts: [], finalText: '', sessionId: 'sup', failed: true });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: null, excludeFromFit: true });
  });

  it('stashDecision carries a compacted extra; stashExtra / stashSiblings read them back tolerant of garbage', () => {
    const s = stashDecision(decision('d1', 'supervisor_turn_noop', 0.1), 'supervisor_turn_noop', { extra: { origin: 'sweep', control: true, floor: true } })!;
    expect(s.extra).toEqual({ origin: 'sweep', control: true, floor: true });
    expect(stashExtra(s)).toEqual({ origin: 'sweep', control: true, floor: true });
    expect(stashExtra(null)).toEqual({});
    expect(stashExtra({ extra: 'nope' })).toEqual({});
    expect(stashDecision(decision('d2', 'sweep_triage', 0.1), 'sweep_triage')!.extra).toBeUndefined();
    const rider = { ...stashDecision(decision('d2', 'sweep_triage', 0.1), 'sweep_triage')!, also: [s, { junk: true }, null] };
    expect(stashSiblings(rider).map((x) => x.id)).toEqual(['d1']);
    expect(stashSiblings(null)).toEqual([]);
  });

  it('labelMachineRunOutcome labels the sibling AND the rider from one run, stamping the sibling extra + control on its row', async () => {
    const sibling = stashDecision(decision('d1', 'supervisor_turn_noop', 0.1), 'supervisor_turn_noop', { extra: { origin: 'sweep', control: true } })!;
    const rider = { ...stashDecision(decision('d2', 'sweep_triage', 0.1), 'sweep_triage')!, also: [sibling] };
    await labelMachineRunOutcome(rider, { parts: [{ type: 'tool_call', name: 'send_chat_message' }], finalText: 'ACTIONS TAKEN\n1. nudged the lane', sessionId: 'sup' });
    const rows = mockRecord.mock.calls.map((c) => ({ id: c[0].id, purpose: c[1], ...c[2] }));
    expect(rows).toHaveLength(2);
    const tn = rows.find((r) => r.purpose === 'supervisor_turn_noop')!;
    expect(tn).toMatchObject({ id: 'd1', question: 'will_act', actual: true, acted: false, sessionId: 'sup', extra: { origin: 'sweep', control: true } });
    const st = rows.find((r) => r.purpose === 'sweep_triage')!;
    expect(st).toMatchObject({ id: 'd2', question: 'needs_turn_now', actual: true });
    // agent-decisions prerequisite 1 (2026-09-27): the rider carried no consumer extra of its own; the
    // only key on its row is the harness fact `harnessActed` (a mutating tool backed this turn).
    // W6-3 (audit 2026-10-08): plus which label produced `actual` and the legacy label beside it.
    expect(st.extra).toEqual({ harnessActed: true, labelSource: 'harness_v2', legacyActed: true });
    expect(st.excludeFromFit).toBeUndefined();
  });

  it('a no-op turn labels false; a failed run labels null but still pairs and keeps the extra', async () => {
    const s = stashDecision(decision('d3', 'supervisor_turn_noop', 0.05), 'supervisor_turn_noop', { extra: { origin: 'drain', control: false } })!;
    await labelMachineRunOutcome(s, { parts: [{ type: 'tool_call', name: 'get_chat_status' }], finalText: 'WAKE: no-op — nothing to do', sessionId: 'sup' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'will_act', actual: false, extra: { origin: 'drain', control: false } });
    mockRecord.mockClear();
    await labelMachineRunOutcome(s, { parts: [], finalText: '', sessionId: 'sup', failed: true });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'will_act', actual: null, extra: { origin: 'drain', control: false } });
  });
});

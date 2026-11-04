/**
 * decision-outcome-labels.ts (WI-C, 2026-09-25) — the harness-derived `actual`
 * for wake_triage / delta_material, recorded against the stashed decision at
 * the finalize of the run that carried it.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: jest.fn(),
}));
// supervisor.service pulls prisma + the platform graph — the label module
// imports it DYNAMICALLY; here the classifier is the real precedence in miniature.
const mockClassify = jest.fn((content: unknown): 'supervisor_noop' | 'supervisor_action' | 'supervisor_note' => {
  const text = String(content ?? '').trim();
  if (/\b(?:SWEEP|WAKE):\s*no-op\b/i.test(text)) return 'supervisor_noop';
  if (/\bACTIONS?\s+TAKEN\b/i.test(text)) return 'supervisor_action';
  return text.length <= 200 ? 'supervisor_noop' : 'supervisor_note';
});
// wake-cadence-5 (fixer 2026-09-27): the report-up target the label site resolves — null = not a project-supervisor session.
const mockReportUpTarget = jest.fn(async (_sessionId: string): Promise<string | null> => null);
jest.mock('./supervisor.service', () => ({
  __esModule: true,
  classifySupervisorNote: (...a: any[]) => mockClassify(...(a as [unknown])),
  reportUpTargetForSession: (...a: any[]) => mockReportUpTarget(...(a as [string])),
}));

import { recordLoopMetric } from './loop-metrics.service';
import { stashDecision } from './decision-gate';
import {
  WAKE_ACTION_EXEMPT_TOOLS, WAKE_OWNER_ESCALATION_TOOLS, deriveMachineRunActual, deriveWakeTriageV2Actuals, evidenceToolCallCount,
  labelMachineRunOutcome, toolNamesCalled, tookPlatformAction, wakeDispositionAgreed, wakeEffortAgreed,
  PURPOSE_CHOICE_LABELS, choiceLabelFor,
  deriveWakeEffortHarnessActual, deriveWakeEffortLegacyActual, machineRunLabelExtras, WAKE_EFFORT_HARNESS_MIN_EVIDENCE_CALLS,
  partsAreReportUpOnly, wakeActed, runReportUpOnly, REPORT_UP_LABELLED_PURPOSES,
} from './decision-outcome-labels';

const parts = (...names: string[]) => names.map((name) => ({ type: 'tool_call', name }));
const LONG_NOTE = 'x'.repeat(400);

beforeEach(() => { (recordLoopMetric as jest.Mock).mockReset(); mockClassify.mockClear(); mockReportUpTarget.mockReset().mockResolvedValue(null); delete process.env.SUPERVISOR_REPORT_UP_IS_ACTION; });

describe('pure derivations', () => {
  it('toolNamesCalled reads tool_call parts only (every call, duplicates kept); bad input → []', () => {
    expect(toolNamesCalled([{ type: 'text', text: 'hi' }, ...parts('todo_list', 'send_chat_message', 'todo_list'), { type: 'tool_call' }])).toEqual(['todo_list', 'send_chat_message', 'todo_list']);
    expect(toolNamesCalled(null)).toEqual([]);
    expect(toolNamesCalled('x')).toEqual([]);
  });

  it('tookPlatformAction: a mutating platform tool counts; reads and the supervisor state-ledger write do not', () => {
    expect(tookPlatformAction(['todo_list', 'get_chat_status'])).toBe(false);
    expect(tookPlatformAction(['update_supervisor_state'])).toBe(false);
    expect(WAKE_ACTION_EXEMPT_TOOLS.has('update_supervisor_state')).toBe(true);
    for (const t of ['send_chat_message', 'dispatch_platform_task', 'schedule_message', 'flag_owner_question', 'todo_update']) {
      expect(tookPlatformAction(['todo_list', t])).toBe(true);
    }
    expect(tookPlatformAction(['run_command'])).toBe(false); // a coding tool is not a PLATFORM action
  });

  it('evidenceToolCallCount uses the zero-tool gate vocabulary (update_plan / search_memory / ask_user are not evidence)', () => {
    expect(evidenceToolCallCount(['update_plan', 'search_memory', 'ask_user'])).toBe(0);
    expect(evidenceToolCallCount(['update_plan', 'run_command', 'todo_list'])).toBe(2);
  });

  it('wake_triage actual: acted ⇔ a REAL mutating action (W6-3, audit 2026-10-08: the ACTIONS TAKEN note no longer counts; WAKE_TRIAGE_HARNESS_LABEL_DISABLED=1 restores it)', () => {
    expect(deriveMachineRunActual('wake_triage', { toolNames: ['todo_list', 'update_supervisor_state'], noteKind: 'supervisor_noop' })).toBe(false);
    expect(deriveMachineRunActual('wake_triage', { toolNames: ['todo_list'], noteKind: 'supervisor_note' })).toBe(false);
    expect(deriveMachineRunActual('wake_triage', { toolNames: ['todo_list', 'send_chat_message'], noteKind: 'supervisor_noop' })).toBe(true);
    expect(deriveMachineRunActual('wake_triage', { toolNames: [], noteKind: 'supervisor_action' })).toBe(false);
    expect(deriveMachineRunActual('wake_triage', { toolNames: [], noteKind: null })).toBe(false);
    process.env.WAKE_TRIAGE_HARNESS_LABEL_DISABLED = '1';
    try {
      expect(deriveMachineRunActual('wake_triage', { toolNames: [], noteKind: 'supervisor_action' })).toBe(true);
    } finally { delete process.env.WAKE_TRIAGE_HARNESS_LABEL_DISABLED; }
  });

  it('delta_material actual: material ⇔ ≥1 evidence-bearing call AND a non-noop final', () => {
    expect(deriveMachineRunActual('delta_material', { toolNames: ['run_command'], noteKind: 'supervisor_note' })).toBe(true);
    expect(deriveMachineRunActual('delta_material', { toolNames: ['run_command'], noteKind: 'supervisor_noop' })).toBe(false);
    expect(deriveMachineRunActual('delta_material', { toolNames: ['update_plan'], noteKind: 'supervisor_note' })).toBe(false);
    expect(deriveMachineRunActual('delta_material', { toolNames: ['run_command'], noteKind: null })).toBe(true);
  });

  it('other purposes are not labelled here', () => {
    expect(deriveMachineRunActual('self_audit', { toolNames: ['run_command'], noteKind: null })).toBeNull();
    expect(deriveMachineRunActual('auto_route', { toolNames: [], noteKind: null })).toBeNull();
    expect(deriveMachineRunActual('guard_strike', { toolNames: [], noteKind: null })).toBeNull(); // labelled by the adjudicator itself (N1)
  });

  it('sweep_triage actual (N2): the wake_triage derivation — a mutating tool or an ACTIONS TAKEN note means the sweep needed its turn', () => {
    expect(deriveMachineRunActual('sweep_triage', { toolNames: ['todo_list', 'update_supervisor_state'], noteKind: 'supervisor_noop' })).toBe(false);
    expect(deriveMachineRunActual('sweep_triage', { toolNames: ['get_chat_status'], noteKind: 'supervisor_note' })).toBe(false);
    expect(deriveMachineRunActual('sweep_triage', { toolNames: ['send_chat_message'], noteKind: 'supervisor_noop' })).toBe(true);
    // W6-3 (audit 2026-10-08): the note's own ACTIONS TAKEN text never labels "needed a turn".
    expect(deriveMachineRunActual('sweep_triage', { toolNames: [], noteKind: 'supervisor_action' })).toBe(false);
  });
});

describe('firing_superseded (N7) — boolean run label onto a Choice vocabulary', () => {
  const outcomeRow = () => (recordLoopMetric as jest.Mock).mock.calls.map((c) => c[0]).find((r) => r?.meta?.phase === 'outcome');
  const parked = (choice: string, confidence = 0.93) => stashDecision({ id: 'f1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 9, answers: { disposition: { type: 'choice', choice, confidence, probabilities: { fire: 1 - confidence, [choice]: confidence } } } }, 'firing_superseded');

  it('deriveMachineRunActual: real work = a mutating platform tool OR an evidenced non-noop final; a no-op is false', () => {
    expect(deriveMachineRunActual('firing_superseded', { toolNames: ['send_chat_message'], noteKind: 'supervisor_noop' })).toBe(true);
    expect(deriveMachineRunActual('firing_superseded', { toolNames: ['read_file', 'run_command'], noteKind: 'supervisor_note' })).toBe(true);
    expect(deriveMachineRunActual('firing_superseded', { toolNames: ['read_file'], noteKind: 'supervisor_noop' })).toBe(false);
    expect(deriveMachineRunActual('firing_superseded', { toolNames: [], noteKind: 'supervisor_note' })).toBe(false);
  });

  it('choiceLabelFor maps true→fire / false→drop_superseded; merge_into_next agrees with a false label; unknown purpose → null', () => {
    expect(PURPOSE_CHOICE_LABELS.firing_superseded?.positive).toBe('fire');
    expect(choiceLabelFor('firing_superseded', 'fire', true)).toEqual({ actualKey: 'fire', agreed: true });
    expect(choiceLabelFor('firing_superseded', 'fire', false)).toEqual({ actualKey: 'drop_superseded', agreed: false });
    expect(choiceLabelFor('firing_superseded', 'drop_superseded', false)).toEqual({ actualKey: 'drop_superseded', agreed: true });
    expect(choiceLabelFor('firing_superseded', 'merge_into_next', false)).toEqual({ actualKey: 'drop_superseded', agreed: true });
    expect(choiceLabelFor('firing_superseded', 'merge_into_next', true)).toEqual({ actualKey: 'fire', agreed: false });
    expect(choiceLabelFor('firing_superseded', null, true)).toEqual({ actualKey: 'fire' });
    expect(choiceLabelFor('wake_triage', 'x', true)).toBeNull();
  });

  it('a parked firing predicted drop_superseded whose run then closed as a no-op labels actual=drop_superseded, agreed=true', async () => {
    await labelMachineRunOutcome(JSON.parse(JSON.stringify(parked('drop_superseded'))), { parts: parts('read_file'), finalText: 'WAKE: no-op — nothing to do.', sessionId: 'c-lane' });
    const row = outcomeRow();
    expect(row.meta).toMatchObject({ purpose: 'firing_superseded', question: 'disposition', actual: 'drop_superseded', agreed: true, predicted: { choice: 'drop_superseded' } });
    expect(row.value).toBe(1);
  });

  it('a parked firing predicted merge_into_next whose run did real work labels actual=fire, agreed=false', async () => {
    await labelMachineRunOutcome(parked('merge_into_next'), { parts: parts('run_command', 'send_chat_message'), finalText: LONG_NOTE, sessionId: 'c-lane' });
    const row = outcomeRow();
    expect(row.meta).toMatchObject({ purpose: 'firing_superseded', actual: 'fire', agreed: false });
    expect(row.value).toBe(0);
  });

  it('a failed run labels actual:null (unlabelled close)', async () => {
    await labelMachineRunOutcome(parked('fire'), { parts: [], finalText: '', sessionId: 'c-lane', failed: true });
    expect(outcomeRow().meta).toMatchObject({ purpose: 'firing_superseded', actual: null });
  });
});

describe('wake_effort — HARNESS-counted deliberation label (agent-decisions prerequisite 1, 2026-09-27; N9 proxy kept as legacyLabel)', () => {
  it('deriveWakeEffortHarnessActual: 2 ⇔ ≥ 3 evidence calls OR a mutating platform tool; 1 ⇔ 1–2 evidence calls; 0 ⇔ none — the note is never read', () => {
    expect(WAKE_EFFORT_HARNESS_MIN_EVIDENCE_CALLS).toBe(3);
    expect(deriveWakeEffortHarnessActual({ toolNames: [], noteKind: 'supervisor_action' })).toBe(0); // "ACTIONS TAKEN" with zero calls is a claim
    expect(deriveWakeEffortHarnessActual({ toolNames: ['get_chat_status'], noteKind: 'supervisor_note' })).toBe(1);
    expect(deriveWakeEffortHarnessActual({ toolNames: ['get_chat_status', 'update_supervisor_state'], noteKind: 'supervisor_noop' })).toBe(1);
    expect(deriveWakeEffortHarnessActual({ toolNames: ['get_chat_status', 'todo_list', 'get_chat_messages'], noteKind: 'supervisor_noop' })).toBe(2);
    expect(deriveWakeEffortHarnessActual({ toolNames: ['send_chat_message'], noteKind: 'supervisor_noop' })).toBe(2);
    expect(deriveWakeEffortHarnessActual({ toolNames: ['flag_owner_question'], noteKind: 'supervisor_note' })).toBe(2);
    expect(deriveWakeEffortHarnessActual({ toolNames: ['update_plan', 'search_memory', 'ask_user'], noteKind: 'supervisor_action' })).toBe(0); // non-evidence names
    expect(deriveWakeEffortHarnessActual({ toolNames: [], noteKind: null })).toBe(0);
  });

  it('deriveMachineRunActual labels from the harness; the N9 noteKind proxy (2 acted / ACTIONS TAKEN, 1 note, 0 no-op) is kept as deriveWakeEffortLegacyActual', () => {
    expect(deriveMachineRunActual('wake_effort', { toolNames: [], noteKind: 'supervisor_action' })).toBe(0);
    expect(deriveMachineRunActual('wake_effort', { toolNames: ['get_chat_status', 'update_supervisor_state'], noteKind: 'supervisor_noop' })).toBe(1);
    expect(deriveWakeEffortLegacyActual({ toolNames: [], noteKind: 'supervisor_action' })).toBe(2);
    expect(deriveWakeEffortLegacyActual({ toolNames: ['get_chat_status'], noteKind: 'supervisor_note' })).toBe(1);
  });

  it('machineRunLabelExtras: wake_effort rows carry labelSource / legacyLabel / evidenceCalls; the three triage purposes carry harnessActed only (their acting label is unchanged); others nothing', () => {
    expect(machineRunLabelExtras('wake_effort', { toolNames: ['get_chat_status'], noteKind: 'supervisor_action' })).toEqual({ labelSource: 'harness', legacyLabel: 2, evidenceCalls: 1 });
    for (const p of ['wake_triage', 'sweep_triage', 'drain_triage'] as const) {
      // W6-3 (audit 2026-10-08): the rows also say which label produced `actual` and carry the old label beside it.
      expect(machineRunLabelExtras(p, { toolNames: ['todo_list'], noteKind: 'supervisor_action' })).toEqual({ harnessActed: false, labelSource: 'harness_v2', legacyActed: true });
      expect(machineRunLabelExtras(p, { toolNames: ['send_chat_message'], noteKind: 'supervisor_noop' })).toEqual({ harnessActed: true, labelSource: 'harness_v2', legacyActed: true });
      // The marker clause no longer labels (W6-3); the kill switch restores it.
      expect(deriveMachineRunActual(p, { toolNames: [], noteKind: 'supervisor_action' })).toBe(false);
      process.env.WAKE_TRIAGE_HARNESS_LABEL_DISABLED = '1';
      try {
        expect(deriveMachineRunActual(p, { toolNames: [], noteKind: 'supervisor_action' })).toBe(true);
        expect(machineRunLabelExtras(p, { toolNames: ['todo_list'], noteKind: 'supervisor_action' })).toEqual({ harnessActed: false, labelSource: 'legacy', legacyActed: true });
      } finally { delete process.env.WAKE_TRIAGE_HARNESS_LABEL_DISABLED; }
    }
    expect(machineRunLabelExtras('delta_material', { toolNames: ['send_chat_message'], noteKind: null })).toEqual({});
  });

  it("wakeEffortAgreed is the consumer's BINARY call (≤ 1 ⇒ 'high' suffices), not exact-level equality", () => {
    expect(wakeEffortAgreed({ type: 'score', score: 0.2 }, 1)).toBe(true);
    expect(wakeEffortAgreed({ type: 'score', score: 1.4 }, 2)).toBe(false);
    expect(wakeEffortAgreed({ type: 'score', score: 1.6 }, 2)).toBe(true);
    expect(wakeEffortAgreed({ type: 'noul', noul: 0.1 } as any, 1)).toBeUndefined();
    expect(wakeEffortAgreed(undefined, 1)).toBeUndefined();
  });

  const effort = () => stashDecision({ id: 'e1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 9, answers: { deliberation: { type: 'score', score: 0.3, probabilities: { '0': 0.7, '1': 0.2, '2': 0.1 }, confidence: 0.7 } } }, 'wake_effort');
  const outcomeRow = () => (recordLoopMetric as jest.Mock).mock.calls.map((c) => c[0]).find((r) => r?.meta?.phase === 'outcome');

  it('a read-only no-op wake labels actual=1 from its two reads (agreed with a low score) and stamps labelSource:harness + legacyLabel:0 + evidenceCalls:2; acted/extraNote ride the row', async () => {
    await labelMachineRunOutcome(JSON.parse(JSON.stringify(effort())), { parts: parts('get_chat_status', 'update_supervisor_state'), finalText: 'SWEEP: no-op — nothing moved.', sessionId: 'c-sup', acted: false, extraNote: 'run 42s $0.0100 3 turns kept max' });
    const row = outcomeRow();
    expect(row).toMatchObject({ kind: 'decision_gate', value: 1, meta: { phase: 'outcome', id: 'e1', purpose: 'wake_effort', question: 'deliberation', actual: 1, acted: false, agreed: true, labelSource: 'harness', legacyLabel: 0, evidenceCalls: 2 } });
    expect(String(row.meta.note)).toContain('run 42s $0.0100 3 turns kept max');
  });

  it('a wake that acted labels actual=2 (disagreeing with the low score); an ACTIONS TAKEN note with ZERO calls labels 0 — the old 2 survives only as legacyLabel', async () => {
    await labelMachineRunOutcome(effort(), { parts: parts('dispatch_platform_task'), finalText: LONG_NOTE, sessionId: 'c-sup', acted: true });
    expect(outcomeRow()).toMatchObject({ value: 0, meta: { id: 'e1', purpose: 'wake_effort', actual: 2, acted: true, agreed: false, labelSource: 'harness', legacyLabel: 2, evidenceCalls: 1 } });
    (recordLoopMetric as jest.Mock).mockClear();
    await labelMachineRunOutcome(effort(), { parts: parts('get_chat_status'), finalText: LONG_NOTE, sessionId: 'c-sup' });
    expect(outcomeRow()).toMatchObject({ value: 1, meta: { id: 'e1', purpose: 'wake_effort', actual: 1, acted: false, agreed: true } });
    (recordLoopMetric as jest.Mock).mockClear();
    await labelMachineRunOutcome(effort(), { parts: [], finalText: 'ACTIONS TAKEN: relayed the owner answer (msg 1234abcd)', sessionId: 'c-sup' });
    expect(outcomeRow()).toMatchObject({ value: 1, meta: { id: 'e1', purpose: 'wake_effort', actual: 0, agreed: true, labelSource: 'harness', legacyLabel: 2, evidenceCalls: 0 } });
  });
});

describe('labelMachineRunOutcome — sweep_triage (N2)', () => {
  const sweep = () => stashDecision({ id: 's1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 9, answers: { needs_turn_now: { type: 'noul', noul: 0.12 } } }, 'sweep_triage');
  const outcomeRow = () => (recordLoopMetric as jest.Mock).mock.calls.map((c) => c[0]).find((r) => r?.meta?.phase === 'outcome');

  it("a sweep that closed 'SWEEP: no-op' after reads labels actual=false — agreeing with a quiet answer", async () => {
    await labelMachineRunOutcome(JSON.parse(JSON.stringify(sweep())), { parts: parts('get_chat_status', 'update_supervisor_state'), finalText: 'SWEEP: no-op — nothing moved.', sessionId: 'c-sup' });
    expect(outcomeRow()).toMatchObject({ kind: 'decision_gate', value: 1, meta: { phase: 'outcome', id: 's1', purpose: 'sweep_triage', question: 'needs_turn_now', actual: false, acted: false, agreed: true } });
  });

  it('a sweep that dispatched labels actual=true — disagreeing with the quiet answer', async () => {
    await labelMachineRunOutcome(sweep(), { parts: parts('dispatch_platform_task'), finalText: LONG_NOTE, sessionId: 'c-sup' });
    expect(outcomeRow()).toMatchObject({ value: 0, meta: { id: 's1', purpose: 'sweep_triage', actual: true, agreed: false } });
  });
});

// ── wake-cadence-5 (fixer 2026-09-27): a report-up is not an action for the labels the act gates learn from ──
describe('report-up ≠ action in the decision-outcome labels (wake-cadence-5, fixer 2026-09-27)', () => {
  const FLEET = 'fleet-chat-1';
  const send = (chatId: string) => ({ type: 'tool_call', name: 'send_chat_message', args: { chatId, message: 'WHAT MOVED: …' } });
  const ledger = { type: 'tool_call', name: 'update_supervisor_state', args: { state: {} } };
  const read = { type: 'tool_call', name: 'get_chat_status', args: { chatId: 'lane-1' } };
  const outcomeRow = () => (recordLoopMetric as jest.Mock).mock.calls.map((c) => c[0]).find((r) => r?.meta?.phase === 'outcome');
  const sweep = () => stashDecision({ id: 's9', mode: 'act', backend: 'TypeSafe Jev', ms: 9, answers: { needs_turn_now: { type: 'noul', noul: 0.91 } } }, 'sweep_triage');
  const wake = () => stashDecision({ id: 'w9', mode: 'act', backend: 'TypeSafe Jev', ms: 9, answers: { needs_turn_now: { type: 'noul', noul: 0.91 } } }, 'wake_triage');

  it('partsAreReportUpOnly (pure): only sends to the fleet chat (+ reads + the ledger write) ⇒ true; a lane send, any other mutation, a send with no readable target, or no send ⇒ false', () => {
    expect(partsAreReportUpOnly([read, send(FLEET), ledger], FLEET)).toBe(true);
    expect(partsAreReportUpOnly([send(FLEET), send(FLEET)], FLEET)).toBe(true);
    expect(partsAreReportUpOnly([send(FLEET), send('lane-1')], FLEET)).toBe(false);
    expect(partsAreReportUpOnly([send(FLEET), { type: 'tool_call', name: 'todo_update', args: { id: 't1' } }], FLEET)).toBe(false);
    expect(partsAreReportUpOnly([{ type: 'tool_call', name: 'send_chat_message' }], FLEET)).toBe(false);
    expect(partsAreReportUpOnly([read, ledger], FLEET)).toBe(false);
    expect(partsAreReportUpOnly([send(FLEET)], '')).toBe(false);
    expect(partsAreReportUpOnly('nope', FLEET)).toBe(false);
  });

  it('wakeActed / deriveMachineRunActual: reportUpOnly overrides both the mutating-tool clause and the ACTIONS TAKEN note for wake_triage, sweep_triage, drain_triage and supervisor_turn_noop; the v2 disposition reads ack', () => {
    const ev = { toolNames: ['send_chat_message', 'update_supervisor_state'], noteKind: 'supervisor_action' as const, reportUpOnly: true };
    expect(wakeActed(ev)).toBe(false);
    for (const p of ['wake_triage', 'sweep_triage', 'drain_triage', 'supervisor_turn_noop'] as const) {
      expect(REPORT_UP_LABELLED_PURPOSES.has(p)).toBe(true);
      expect(deriveMachineRunActual(p, ev)).toBe(false);
      expect(deriveMachineRunActual(p, { ...ev, reportUpOnly: false })).toBe(true);
      expect(deriveMachineRunActual(p, { toolNames: ev.toolNames, noteKind: ev.noteKind })).toBe(true); // not evaluated ⇒ the old label
    }
    expect(deriveWakeTriageV2Actuals(ev)).toEqual({ disposition: 'ack', urgency: 0 });
    expect(machineRunLabelExtras('sweep_triage', ev)).toEqual({ harnessActed: true, reportUpOnly: true, labelSource: 'harness_v2', legacyActed: false });
    expect(machineRunLabelExtras('supervisor_turn_noop', ev)).toEqual({ reportUpOnly: true, labelSource: 'harness_v2' });
  });

  it('THE tt-rd shape at the finalize: a project-supervisor sweep whose only mutation was a send to the Fleet Supervisor + an ACTIONS TAKEN note labels actual=false (meta.reportUpOnly, note "report-up only") — disagreeing with the 0.91 act answer', async () => {
    mockReportUpTarget.mockResolvedValue(FLEET);
    await labelMachineRunOutcome(sweep(), { parts: [read, send(FLEET), ledger], finalText: 'ACTIONS TAKEN: reported WHAT MOVED to the Fleet Supervisor (msg 1234abcd)', sessionId: 'psup-1' });
    expect(mockReportUpTarget).toHaveBeenCalledWith('psup-1');
    const row = outcomeRow();
    expect(row).toMatchObject({ value: 0, meta: { id: 's9', purpose: 'sweep_triage', actual: false, agreed: false, harnessActed: true, reportUpOnly: true } });
    expect(String(row.meta.note)).toContain('report-up only');
  });

  it('a wake that ALSO steered a lane keeps actual=true; a non-project-supervisor session (no target) keeps the old label; a run with no mutation never pays the lookup', async () => {
    mockReportUpTarget.mockResolvedValue(FLEET);
    await labelMachineRunOutcome(wake(), { parts: [send(FLEET), send('lane-1')], finalText: LONG_NOTE, sessionId: 'psup-1' });
    expect(outcomeRow()).toMatchObject({ meta: { id: 'w9', actual: true, harnessActed: true } });
    expect(outcomeRow().meta.reportUpOnly).toBeUndefined();
    (recordLoopMetric as jest.Mock).mockReset(); mockReportUpTarget.mockResolvedValue(null);
    await labelMachineRunOutcome(wake(), { parts: [send(FLEET)], finalText: LONG_NOTE, sessionId: 'worker-lane' });
    expect(outcomeRow()).toMatchObject({ meta: { id: 'w9', actual: true } });
    (recordLoopMetric as jest.Mock).mockReset(); mockReportUpTarget.mockClear();
    await labelMachineRunOutcome(wake(), { parts: [read, ledger], finalText: 'WAKE: no-op', sessionId: 'psup-1' });
    expect(mockReportUpTarget).not.toHaveBeenCalled();
    expect(outcomeRow()).toMatchObject({ meta: { id: 'w9', actual: false } });
  });

  it('SUPERVISOR_REPORT_UP_IS_ACTION=1 restores the old label (the lookup is skipped); a resolver failure fails toward the old label', async () => {
    process.env.SUPERVISOR_REPORT_UP_IS_ACTION = '1';
    mockReportUpTarget.mockResolvedValue(FLEET);
    await labelMachineRunOutcome(sweep(), { parts: [send(FLEET)], finalText: LONG_NOTE, sessionId: 'psup-1' });
    expect(mockReportUpTarget).not.toHaveBeenCalled();
    expect(outcomeRow()).toMatchObject({ meta: { id: 's9', actual: true } });
    delete process.env.SUPERVISOR_REPORT_UP_IS_ACTION;
    (recordLoopMetric as jest.Mock).mockReset();
    mockReportUpTarget.mockRejectedValue(new Error('db down'));
    expect(await runReportUpOnly({ parts: [send(FLEET)], sessionId: 'psup-1' })).toBe(false);
    await labelMachineRunOutcome(sweep(), { parts: [send(FLEET)], finalText: LONG_NOTE, sessionId: 'psup-1' });
    expect(outcomeRow()).toMatchObject({ meta: { id: 's9', actual: true } });
  });
});

describe('labelMachineRunOutcome — drain_triage (N6)', () => {
  const drain = (choice: 'ack_only' | 'coalesce' | 'act_now') => stashDecision({
    id: 'd1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 9,
    answers: { disposition: { type: 'choice', choice, probabilities: { ack_only: 0.1, coalesce: 0.1, act_now: 0.8 }, confidence: 0.8 } },
  }, 'drain_triage');
  const outcomeRow = () => (recordLoopMetric as jest.Mock).mock.calls.map((c) => c[0]).find((r) => r?.meta?.phase === 'outcome');

  it('deriveMachineRunActual: the wake vocabulary — a REAL mutating action means the drained turn acted (W6-3: the ACTIONS TAKEN note alone does not)', () => {
    expect(deriveMachineRunActual('drain_triage', { toolNames: ['get_chat_status', 'update_supervisor_state'], noteKind: 'supervisor_noop' })).toBe(false);
    expect(deriveMachineRunActual('drain_triage', { toolNames: ['send_chat_message'], noteKind: 'supervisor_noop' })).toBe(true);
    expect(deriveMachineRunActual('drain_triage', { toolNames: [], noteKind: 'supervisor_action' })).toBe(false);
  });

  it('a drained turn that acted labels act_now — agreeing with an act_now prediction — and stamps harnessActed:true (prerequisite 1: the marker-only share becomes measurable)', async () => {
    await labelMachineRunOutcome(JSON.parse(JSON.stringify(drain('act_now'))), { parts: parts('send_chat_message'), finalText: LONG_NOTE, sessionId: 'c-sup' });
    expect(outcomeRow()).toMatchObject({ kind: 'decision_gate', value: 1, meta: { phase: 'outcome', id: 'd1', purpose: 'drain_triage', question: 'disposition', actual: 'act_now', acted: false, agreed: true, harnessActed: true } });
    (recordLoopMetric as jest.Mock).mockReset();
    // W6-3 (audit 2026-10-08): the marker clause no longer labels act_now — harnessActed:false, legacyActed:true record the old reading.
    await labelMachineRunOutcome(drain('act_now'), { parts: parts('get_chat_status'), finalText: 'ACTIONS TAKEN: replied to the lane', sessionId: 'c-sup' });
    expect(outcomeRow()).toMatchObject({ value: 0, meta: { actual: 'ack_only', agreed: false, harnessActed: false, legacyActed: true, labelSource: 'harness_v2' } });
  });

  it('a quiet drained turn labels ack_only — an ack_only prediction agrees, a coalesce prediction ALSO agrees, act_now disagrees', async () => {
    await labelMachineRunOutcome(drain('ack_only'), { parts: parts('get_chat_status', 'update_supervisor_state'), finalText: 'WAKE: no-op', sessionId: 'c-sup' });
    expect(outcomeRow()).toMatchObject({ value: 1, meta: { purpose: 'drain_triage', actual: 'ack_only', agreed: true } });
    (recordLoopMetric as jest.Mock).mockReset();
    await labelMachineRunOutcome(drain('coalesce'), { parts: parts('get_chat_status'), finalText: 'WAKE: no-op', sessionId: 'c-sup' });
    expect(outcomeRow()).toMatchObject({ value: 1, meta: { actual: 'ack_only', agreed: true } });
    (recordLoopMetric as jest.Mock).mockReset();
    await labelMachineRunOutcome(drain('act_now'), { parts: parts('get_chat_status'), finalText: 'WAKE: no-op', sessionId: 'c-sup' });
    expect(outcomeRow()).toMatchObject({ value: 0, meta: { actual: 'ack_only', agreed: false } });
  });

  it('a FAILED drained run closes the row unlabelled', async () => {
    await labelMachineRunOutcome(drain('ack_only'), { parts: [], finalText: '', sessionId: 'c-sup', failed: true });
    expect(outcomeRow()).toMatchObject({ meta: { purpose: 'drain_triage', question: 'disposition', actual: null } });
  });
});

describe('labelMachineRunOutcome', () => {
  const triage = () => stashDecision({ id: 'w1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 9, answers: { needs_turn_now: { type: 'noul', noul: 0.07 } } }, 'wake_triage');
  const delta = () => stashDecision({ id: 'm1', mode: 'shadow', backend: 'DeepSeek logprob readout', ms: 9, answers: { material: { type: 'noul', noul: 0.96 } } }, 'delta_material');
  const outcomeRow = () => (recordLoopMetric as jest.Mock).mock.calls.map((c) => c[0]).find((r) => r?.meta?.phase === 'outcome');

  it('a woken run that dispatched (mutating tool) labels actual=true — disagreeing with a "no turn needed" answer, agreed computed', async () => {
    await labelMachineRunOutcome(JSON.parse(JSON.stringify(triage())), { parts: parts('todo_list', 'dispatch_platform_task'), finalText: LONG_NOTE, sessionId: 'c-sup' });
    const row = outcomeRow();
    expect(row).toMatchObject({ kind: 'decision_gate', sessionId: 'c-sup', value: 0, meta: { phase: 'outcome', id: 'w1', purpose: 'wake_triage', question: 'needs_turn_now', actual: true, acted: false, agreed: false } });
    expect(String(row.meta.note)).toContain('mutating 1 (dispatch_platform_task)');
  });

  it('a woken run that only read and wrote "WAKE: no-op" labels actual=false — agreeing with the answer', async () => {
    await labelMachineRunOutcome(triage(), { parts: parts('todo_list', 'update_supervisor_state'), finalText: 'WAKE: no-op — nothing needs me.', sessionId: 'c-sup' });
    expect(outcomeRow()).toMatchObject({ value: 1, meta: { phase: 'outcome', id: 'w1', actual: false, agreed: true } });
    expect(mockClassify).toHaveBeenCalledWith('WAKE: no-op — nothing needs me.');
  });

  it('W6-3 (audit 2026-10-08): an ACTIONS TAKEN note with no mutating tool labels actual=FALSE (the claim is not evidence); WAKE_TRIAGE_HARNESS_LABEL_DISABLED=1 restores actual=true', async () => {
    await labelMachineRunOutcome(triage(), { parts: parts('todo_list'), finalText: 'ACTIONS TAKEN: relayed the owner answer (msg 1234abcd)', sessionId: 'c-sup' });
    expect(outcomeRow()).toMatchObject({ meta: { actual: false, agreed: true, legacyActed: true } });
    (recordLoopMetric as jest.Mock).mockReset();
    process.env.WAKE_TRIAGE_HARNESS_LABEL_DISABLED = '1';
    try {
      await labelMachineRunOutcome(triage(), { parts: parts('todo_list'), finalText: 'ACTIONS TAKEN: relayed the owner answer (msg 1234abcd)', sessionId: 'c-sup' });
      expect(outcomeRow()).toMatchObject({ meta: { actual: true, agreed: false, labelSource: 'legacy' } });
    } finally { delete process.env.WAKE_TRIAGE_HARNESS_LABEL_DISABLED; }
  });

  it('delta_material: a fired run with evidence calls and a real final is material (agreed with 0.96)', async () => {
    await labelMachineRunOutcome(delta(), { parts: parts('run_command', 'update_plan'), finalText: LONG_NOTE, sessionId: 'lane' });
    expect(outcomeRow()).toMatchObject({ value: 1, meta: { phase: 'outcome', id: 'm1', purpose: 'delta_material', question: 'material', actual: true, agreed: true } });
  });

  it('a FAILED run records the paired outcome with actual null (unknown), no agreed', async () => {
    await labelMachineRunOutcome(triage(), { parts: [], finalText: '', sessionId: 'c-sup', failed: true });
    const row = outcomeRow();
    expect(row).toMatchObject({ meta: { phase: 'outcome', id: 'w1', actual: null, acted: false, note: 'run failed — outcome unknown' } });
    expect(row.meta.agreed).toBeUndefined();
    expect(row.value).toBeUndefined();
  });

  it('a malformed or unlabelled-purpose stash records nothing and never throws', async () => {
    await expect(labelMachineRunOutcome({ id: 'x' }, { parts: [], finalText: '' })).resolves.toBeUndefined();
    await expect(labelMachineRunOutcome(stashDecision({ id: 'a', mode: 'shadow', backend: 'b', ms: 1, answers: { unevidenced: { type: 'noul', noul: 0.2 } } }, 'self_audit'), { parts: [], finalText: 'x' })).resolves.toBeUndefined();
    expect(recordLoopMetric).not.toHaveBeenCalled();
  });

  it('a classifier failure degrades to tool-only evidence (note unclassified) instead of dropping the label', async () => {
    mockClassify.mockImplementationOnce(() => { throw new Error('boom'); });
    await labelMachineRunOutcome(triage(), { parts: parts('send_chat_message'), finalText: 'x', sessionId: 'c-sup' });
    const row = outcomeRow();
    expect(row).toMatchObject({ meta: { actual: true } });
    expect(String(row.meta.note)).toContain('unclassified');
  });
});

/* E7 (2026-09-25): the wake_triage v2 fan-out's run-derived labels — one
 * outcome row per answered question (needs_turn_now + disposition + urgency);
 * a v1 stash still yields exactly one row. */
describe('wake_triage v2 labels (E7)', () => {
  const v2 = (disposition: string) => stashDecision({
    id: 'w2', mode: 'shadow', backend: 'TypeSafe Jev', ms: 9,
    answers: {
      needs_turn_now: { type: 'noul', noul: 0.07 },
      disposition: { type: 'choice', choice: disposition, probabilities: { ack: 0.1, coalesce: 0.1, act_now: 0.1, escalate_owner: 0.1, [disposition]: 0.7 }, confidence: 0.7 },
      addressed_to_supervisor: { type: 'noul', noul: 0.2 },
      contains_failure_or_block: { type: 'noul', noul: 0.1 },
      urgency: { type: 'score', score: 0.4, probabilities: { '0': 0.6, '1': 0.4, '2': 0, '3': 0 }, confidence: 0.6 },
    },
  }, 'wake_triage');
  const outcomeRows = () => (recordLoopMetric as jest.Mock).mock.calls.map((c) => c[0]).filter((r) => r?.meta?.phase === 'outcome');

  it('deriveWakeTriageV2Actuals: owner escalation > action > note > no-op; wakeDispositionAgreed treats coalesce as ack', () => {
    expect(WAKE_OWNER_ESCALATION_TOOLS.has('flag_owner_question')).toBe(true);
    expect(deriveWakeTriageV2Actuals({ toolNames: ['todo_list', 'notify_user'], noteKind: 'supervisor_noop' })).toEqual({ disposition: 'escalate_owner', urgency: 3 });
    expect(deriveWakeTriageV2Actuals({ toolNames: ['dispatch_platform_task'], noteKind: 'supervisor_noop' })).toEqual({ disposition: 'act_now', urgency: 2 });
    // W6-3 (audit 2026-10-08): the note's ACTIONS TAKEN text alone is not an action.
    expect(deriveWakeTriageV2Actuals({ toolNames: [], noteKind: 'supervisor_action' })).toEqual({ disposition: 'ack', urgency: 0 });
    expect(deriveWakeTriageV2Actuals({ toolNames: ['todo_list'], noteKind: 'supervisor_note' })).toEqual({ disposition: 'ack', urgency: 1 });
    expect(deriveWakeTriageV2Actuals({ toolNames: ['update_supervisor_state'], noteKind: 'supervisor_noop' })).toEqual({ disposition: 'ack', urgency: 0 });
    expect(wakeDispositionAgreed('ack', 'ack')).toBe(true);
    expect(wakeDispositionAgreed('coalesce', 'ack')).toBe(true);
    expect(wakeDispositionAgreed('coalesce', 'act_now')).toBe(false);
    expect(wakeDispositionAgreed('act_now', 'act_now')).toBe(true);
    expect(wakeDispositionAgreed('escalate_owner', 'act_now')).toBe(false);
  });

  it('a v2 stash on a run that escalated to the owner records three rows: needs_turn_now true, disposition escalate_owner (disagreed with ack), urgency 3', async () => {
    await labelMachineRunOutcome(JSON.parse(JSON.stringify(v2('ack'))), { parts: parts('todo_list', 'flag_owner_question'), finalText: LONG_NOTE, sessionId: 'c-sup' });
    const rows = outcomeRows();
    expect(rows.map((r) => r.meta.question)).toEqual(['needs_turn_now', 'disposition', 'urgency']);
    expect(rows[0]).toMatchObject({ value: 0, meta: { id: 'w2', purpose: 'wake_triage', actual: true, agreed: false } });
    expect(rows[1]).toMatchObject({ value: 0, meta: { id: 'w2', question: 'disposition', actual: 'escalate_owner', agreed: false, predicted: { choice: 'ack' } } });
    expect(rows[2]).toMatchObject({ value: 0, meta: { id: 'w2', question: 'urgency', actual: 3, agreed: false } });
    expect(String(rows[1].meta.note)).toContain('mutating 1 (flag_owner_question)');
  });

  it('a coalesce prediction on a no-op run agrees (both "no turn now"); a v1 stash records exactly one row', async () => {
    await labelMachineRunOutcome(v2('coalesce'), { parts: parts('todo_list', 'update_supervisor_state'), finalText: 'WAKE: no-op', sessionId: 'c-sup' });
    let rows = outcomeRows();
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ value: 1, meta: { question: 'disposition', actual: 'ack', agreed: true } });
    expect(rows[2]).toMatchObject({ value: 1, meta: { question: 'urgency', actual: 0, agreed: true } }); // round(0.4) = 0
    (recordLoopMetric as jest.Mock).mockReset();
    await labelMachineRunOutcome(stashDecision({ id: 'w1', mode: 'shadow', backend: 'b', ms: 1, answers: { needs_turn_now: { type: 'noul', noul: 0.07 } } }, 'wake_triage'), { parts: [], finalText: 'WAKE: no-op', sessionId: 'c-sup' });
    rows = outcomeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.question).toBe('needs_turn_now');
  });

  it('a FAILED run closes only the primary question (unlabelled) — the v2 rows are not fabricated', async () => {
    await labelMachineRunOutcome(v2('ack'), { parts: [], finalText: '', sessionId: 'c-sup', failed: true });
    const rows = outcomeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ meta: { question: 'needs_turn_now', actual: null } });
  });
});

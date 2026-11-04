/**
 * wake-effort.ts — decision-gate purpose 'wake_effort' (N9, 2026-09-25).
 *
 *  - the kill switch and mode 'off' never touch the seat (null handle);
 *  - the state is code flags first, the wake head (≤ 2 KB) last, alarm
 *    markers counted in code;
 *  - shadow → the decision runs concurrently; resolveActEffort() is null
 *    WITHOUT waiting for it; the finalize label carries acted:false and the
 *    run length / cost note;
 *  - act is DOUBLE-LOCKED: result.mode 'act' alone changes nothing; the owner
 *    switch alone changes nothing; both + a confident low score + no alarm
 *    marker ⇒ 'high'; alarm wakes and score 2 stay at the seat's effort;
 *  - every failure (rejected decide, throw) fails OPEN.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockRecord: jest.Mock = jest.fn();
jest.mock('./decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  confidenceOf: (a: any) => (a ? (a.type === 'noul' ? Math.max(a.noul, 1 - a.noul) : a.confidence ?? 0) : 0),
  stashDecision: (d: any, purpose: string) => (d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'now' } : null),
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

const mockLabel: jest.Mock = jest.fn(async (..._a: any[]) => undefined);
jest.mock('./decision-outcome-labels', () => ({
  __esModule: true,
  labelMachineRunOutcome: (...a: any[]) => mockLabel(...a),
}));

import {
  buildWakeEffortState, countAlarmMarkers, startWakeEffortGate, wakeEffortActVerdict, wakeEffortActEnabled, wakeEffortActHardDisabled,
  WAKE_EFFORT_HEAD_CHARS, WAKE_EFFORT_QUESTION, WAKE_EFFORT_QUESTIONS, type WakeEffortInput,
} from './wake-effort';

const ENV = ['DECISION_GATE_WAKE_EFFORT_ACT_ENABLED'];
const saved: Record<string, string | undefined> = {};

const input = (over: Partial<WakeEffortInput> = {}): WakeEffortInput => ({
  message: 'Fleet event from chat "canlaw-bench" (run_completed): lane finished step 3, nothing blocked.',
  origin: 'hook', chatKind: 'fleet_supervisor', historyMessages: 24, hasImages: false, model: 'glm-5.3', sessionId: 'sup-1', ...over,
});
const scoreAnswer = (score: number, confidence: number, mode: 'shadow' | 'act' = 'shadow') => ({
  id: 'd1', mode, backend: 'TypeSafe Jev', ms: 120, calibrated: mode === 'act',
  answers: { [WAKE_EFFORT_QUESTION]: { type: 'score', score, confidence, probabilities: { '0': 0.1, '1': 0.1, '2': 0.8 } } },
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  mockMode.mockReturnValue('shadow');
  mockDecide.mockResolvedValue(null);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('pure pieces', () => {
  it('the question is a 3-level score under the deliberation key', () => {
    const q = WAKE_EFFORT_QUESTIONS[WAKE_EFFORT_QUESTION] as any;
    expect(WAKE_EFFORT_QUESTION).toBe('deliberation');
    expect(q.type).toBe('score');
    expect(q.criteria).toHaveLength(3);
  });

  it('countAlarmMarkers reads the rendered alarm event types and the alert banners; routine events count 0', () => {
    expect(countAlarmMarkers('- [run_completed] 10:02Z lane finished\n- [run_failed] 10:05Z verify died')).toBe(1);
    expect(countAlarmMarkers('Fleet event from chat "x" (goal_blocked): stuck')).toBe(1);
    expect(countAlarmMarkers('[INFRA ALERT — disk 91% on box C] playbook: …')).toBe(1);
    expect(countAlarmMarkers('Fleet event from chat "x" (run_completed): done')).toBe(0);
    expect(countAlarmMarkers('')).toBe(0);
  });

  it('buildWakeEffortState: code flags first, the head LAST and clipped to 2 KB, alarm markers counted', () => {
    const long = `- [run_failed] boom ${'x'.repeat(5000)}`;
    const state = buildWakeEffortState(input({ message: long, origin: 'schedule', chatKind: 'lane', hasImages: true }));
    const keys = Object.keys(state);
    expect(keys[keys.length - 1]).toBe('wake_head');
    expect(String(state.wake_head).length).toBe(WAKE_EFFORT_HEAD_CHARS);
    expect(state).toMatchObject({ wake_origin: 'schedule', chat_kind: 'lane', orchestrator_model: 'glm-5.3', has_image_attachments: true, alarm_markers_in_wake: 1, wake_head_truncated: true, wake_chars_total: long.length });
  });

  it('wakeEffortActVerdict: act mode + score ≤ 1 + confidence ≥ τ + no alarm ⇒ apply; every other combination keeps max', () => {
    expect(wakeEffortActVerdict(scoreAnswer(0.4, 0.95, 'act') as any, 0, 0.9)).toMatchObject({ apply: true, score: 0 });
    expect(wakeEffortActVerdict(scoreAnswer(1.2, 0.95, 'act') as any, 0, 0.9)).toMatchObject({ apply: true, score: 1 });
    expect(wakeEffortActVerdict(scoreAnswer(0.4, 0.95, 'shadow') as any, 0, 0.9)).toMatchObject({ apply: false, reason: 'mode shadow' });
    expect(wakeEffortActVerdict(scoreAnswer(0.4, 0.95, 'act') as any, 2, 0.9).apply).toBe(false);
    expect(wakeEffortActVerdict(scoreAnswer(1.6, 0.95, 'act') as any, 0, 0.9)).toMatchObject({ apply: false, score: 2 });
    expect(wakeEffortActVerdict(scoreAnswer(0.4, 0.8, 'act') as any, 0, 0.9).apply).toBe(false);
    expect(wakeEffortActVerdict(null, 0, 0.9)).toMatchObject({ apply: false, reason: 'no decision' });
    expect(wakeEffortActVerdict({ id: 'x', mode: 'act', backend: 'b', ms: 1, answers: { deliberation: { type: 'noul', noul: 0.2 } } } as any, 0, 0.9).apply).toBe(false);
  });

  it('the switches: the act path is ALLOWED by default (owner lock lifted 2026-09-26) and only 0/false/off hard-disables it', () => {
    expect(wakeEffortActEnabled()).toBe(true);
    expect(wakeEffortActHardDisabled()).toBe(false);
    for (const v of ['0', 'false', 'off', ' OFF ']) {
      process.env.DECISION_GATE_WAKE_EFFORT_ACT_ENABLED = v;
      expect(wakeEffortActEnabled()).toBe(false);
      expect(wakeEffortActHardDisabled()).toBe(true);
    }
    for (const v of ['1', 'true', 'on', '']) {
      process.env.DECISION_GATE_WAKE_EFFORT_ACT_ENABLED = v;
      expect(wakeEffortActEnabled()).toBe(true);
      expect(wakeEffortActHardDisabled()).toBe(false);
    }
  });
});

describe('startWakeEffortGate', () => {
  it('mode off returns null without calling the seat', () => {
    mockMode.mockReturnValue('off');
    expect(startWakeEffortGate(input())).toBeNull();
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('SHADOW: decide() is called with the state + purpose; resolveActEffort() is null WITHOUT awaiting the decision; the finalize label rides the stash with acted:false and the cost note', async () => {
    let resolveDecide: (v: any) => void = () => {};
    mockDecide.mockImplementation(() => new Promise((r) => { resolveDecide = r; }));
    const gate = startWakeEffortGate(input());
    expect(gate).not.toBeNull();
    expect(mockDecide).toHaveBeenCalledTimes(1);
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(state.wake_origin).toBe('hook');
    expect(questions).toBe(WAKE_EFFORT_QUESTIONS);
    expect(opts).toMatchObject({ purpose: 'wake_effort', sessionId: 'sup-1' });
    // Not awaited: the decision is still pending and the act path already answered null.
    await expect(gate!.resolveActEffort()).resolves.toBeNull();
    resolveDecide(scoreAnswer(0.2, 0.97, 'shadow'));
    await gate!.label({ parts: [{ type: 'tool_call', name: 'get_chat_status' }], finalText: 'SWEEP: no-op', sessionId: 'sup-1', runMs: 41_500, costUsd: 0.0123, turns: 3 });
    expect(mockLabel).toHaveBeenCalledTimes(1);
    const [stash, run] = mockLabel.mock.calls[0];
    expect(stash).toMatchObject({ id: 'd1', purpose: 'wake_effort' });
    expect(run).toMatchObject({ finalText: 'SWEEP: no-op', sessionId: 'sup-1', acted: false });
    expect(run.extraNote).toBe('run 42s $0.0123 3 turns kept max');
    // A second label call is a no-op (one row per wake).
    await gate!.label({ parts: [], finalText: 'again' });
    expect(mockLabel).toHaveBeenCalledTimes(1);
  });

  it("ACT under the env HARD DISABLE (DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=0) changes nothing: result.mode 'act' + confident low score still resolves null (recorded as kept max)", async () => {
    process.env.DECISION_GATE_WAKE_EFFORT_ACT_ENABLED = '0';
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(scoreAnswer(0.1, 0.98, 'act'));
    const gate = startWakeEffortGate(input())!;
    await expect(gate.resolveActEffort()).resolves.toBeNull();
    await gate.label({ parts: [], finalText: 'ok', runMs: 1000 });
    expect(mockLabel.mock.calls[0][1]).toMatchObject({ acted: false, extraNote: 'run 1s kept max' });
  });

  it("ACT with the env UNSET (owner lock lifted 2026-09-26): result.mode 'act' + score ≤ 1 at ≥ τ ⇒ 'high' through the normal store mode alone; a configured SHADOW purpose still answers null without awaiting", async () => {
    delete process.env.DECISION_GATE_WAKE_EFFORT_ACT_ENABLED;
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(scoreAnswer(0.6, 0.95, 'act'));
    const gate = startWakeEffortGate(input())!;
    await expect(gate.resolveActEffort()).resolves.toBe('high');
    await gate.label({ parts: [], finalText: 'noted', runMs: 2000 });
    expect(mockLabel.mock.calls[0][1]).toMatchObject({ acted: true, extraNote: 'run 2s effort=high' });

    jest.clearAllMocks();
    mockMode.mockReturnValue('shadow');
    mockDecide.mockImplementation(() => new Promise(() => {})); // never resolves — shadow must not wait on it
    const shadow = startWakeEffortGate(input())!;
    await expect(shadow.resolveActEffort()).resolves.toBeNull();
  });

  it("ACT with the owner switch: result.mode 'act' + score ≤ 1 at ≥ τ ⇒ 'high' and the label carries acted:true; an uncalibrated (shadow-mode) answer still keeps max", async () => {
    process.env.DECISION_GATE_WAKE_EFFORT_ACT_ENABLED = '1';
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(scoreAnswer(0.8, 0.93, 'act'));
    const gate = startWakeEffortGate(input())!;
    await expect(gate.resolveActEffort()).resolves.toBe('high');
    await gate.label({ parts: [{ type: 'tool_call', name: 'send_chat_message' }], finalText: 'ACTIONS TAKEN: replied', runMs: 90_000, costUsd: 0.2, turns: 5 });
    expect(mockLabel.mock.calls[0][1]).toMatchObject({ acted: true, extraNote: 'run 90s $0.2000 5 turns effort=high' });

    jest.clearAllMocks();
    mockDecide.mockResolvedValue(scoreAnswer(0.8, 0.93, 'shadow')); // E2 downgrade: the RESULT says shadow
    const gate2 = startWakeEffortGate(input())!;
    await expect(gate2.resolveActEffort()).resolves.toBeNull();
  });

  it('ACT with the owner switch: an alarm wake and a score-2 wake are pinned to max', async () => {
    process.env.DECISION_GATE_WAKE_EFFORT_ACT_ENABLED = '1';
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(scoreAnswer(0.1, 0.99, 'act'));
    const alarm = startWakeEffortGate(input({ message: '- [run_failed] 10:05Z verify died in lane x' }))!;
    await expect(alarm.resolveActEffort()).resolves.toBeNull();
    await alarm.label({ parts: [], finalText: 'x' });
    expect(String(mockLabel.mock.calls[0][1].extraNote)).toContain('alarm 1');

    mockDecide.mockResolvedValue(scoreAnswer(1.7, 0.99, 'act'));
    const hard = startWakeEffortGate(input())!;
    await expect(hard.resolveActEffort()).resolves.toBeNull();
  });

  it('a null decision records nothing', async () => {
    mockDecide.mockResolvedValue(null);
    const none = startWakeEffortGate(input())!;
    await none.label({ parts: [], finalText: 'x' });
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockLabel).not.toHaveBeenCalled();
  });

  it('fails OPEN: a rejected decide() resolves null everywhere (no effort change, no label); a throwing decide() returns a null handle', async () => {
    process.env.DECISION_GATE_WAKE_EFFORT_ACT_ENABLED = '1';
    mockMode.mockReturnValue('act');
    mockDecide.mockRejectedValue(new Error('jev down'));
    const gate = startWakeEffortGate(input())!;
    await expect(gate.decision).resolves.toBeNull();
    await expect(gate.resolveActEffort()).resolves.toBeNull();
    await gate.label({ parts: [], finalText: 'x' });
    expect(mockLabel).not.toHaveBeenCalled();

    mockDecide.mockImplementation(() => { throw new Error('sync boom'); });
    expect(startWakeEffortGate(input())).toBeNull();
  });
});

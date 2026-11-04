/**
 * wake_triage ACT CONTROL SAMPLE (2026-10-04) — the label path end to end.
 *
 * In act a confident-quiet wake_triage verdict PARKS the wake; a park writes
 * an acted:true row with actual:null and is never labelled, so the act band
 * held ZERO act-period labels (prod probe 2026-10-04) and neither auto-demote
 * window could judge the purpose. hooks.service now lets one confident park in
 * N deliver as a CONTROL whose stash carries extra {control:true}. Pins:
 *   - the rate / draw / kill switch (wake-triage-request.ts, pure);
 *   - a control stash labelled at the woken run's finalize (the REAL
 *     stashDecision → labelMachineRunOutcome → recordDecisionOutcome path)
 *     writes an outcome row with mode 'act', inActBand true, acted false, a
 *     boolean `agreed` and meta.control — which the DURABLE window
 *     (durableActBandWindows) admits and the in-memory E12 window
 *     (noteActBandOutcome) counts;
 *   - the parked row (acted:true, actual:null) is admitted by neither — the
 *     reason the purpose was un-demotable before the control sample.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: jest.fn(),
}));
// The label module imports supervisor.service DYNAMICALLY (prisma + the platform graph) — the classifier in miniature.
jest.mock('./supervisor.service', () => ({
  __esModule: true,
  classifySupervisorNote: (content: unknown) => (/\bWAKE:\s*no-op\b/i.test(String(content ?? '')) ? 'supervisor_noop' : 'supervisor_note'),
  reportUpTargetForSession: async () => null,
}));

import { recordLoopMetric } from './loop-metrics.service';
import { recordDecisionOutcome, stashDecision, type DecideResult } from './decision-gate';
import { labelMachineRunOutcome } from './decision-outcome-labels';
import { durableActBandWindows } from './decision-gate-durable-demote';
import { actBandWindow, clearActBandWindows } from './decision-gate-modes';
import {
  WAKE_TRIAGE_CONTROL_EXTRA, WAKE_TRIAGE_CONTROL_SAMPLE_DEFAULT_N, drawWakeTriageControl, setWakeTriageControlSampler,
  wakeTriageControlSampleDisabled, wakeTriageControlSampleRate,
} from './wake-triage-request';

const ENV = ['DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE', 'WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED', 'DECISION_GATE_THRESHOLD_WAKE_TRIAGE', 'DECISION_GATE_AUTO_DEMOTE_EXEMPT', 'SUPERVISOR_REPORT_UP_IS_ACTION'];
const saved: Record<string, string | undefined> = {};

const QUIET_ACT: DecideResult = { id: 'wt-ctl-1', mode: 'act', backend: 'TypeSafe Jev', ms: 7, answers: { needs_turn_now: { type: 'noul', noul: 0.06 } } } as DecideResult;
const parts = (...names: string[]) => names.map((name) => ({ type: 'tool_call', name }));
const outcomeRows = () => (recordLoopMetric as jest.Mock).mock.calls.map((c) => c[0]).filter((r) => r?.meta?.phase === 'outcome');
/** A captured recordLoopMetric payload as the readiness job reads it back (loop_metrics row: createdAt + meta). */
const asRow = (r: any) => ({ createdAt: new Date('2026-10-04T12:00:00Z'), meta: r.meta });

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  (recordLoopMetric as jest.Mock).mockReset();
  clearActBandWindows();
});
afterEach(() => {
  setWakeTriageControlSampler(null);
  clearActBandWindows();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('control rate + draw (pure)', () => {
  it('default 1/10; env DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE (clamped 0..1, blank / garbage ⇒ default); the draw reads the injected sampler', () => {
    expect(WAKE_TRIAGE_CONTROL_SAMPLE_DEFAULT_N).toBe(10);
    expect(wakeTriageControlSampleRate()).toBeCloseTo(0.1, 9);
    setWakeTriageControlSampler(() => 0.099);
    expect(drawWakeTriageControl()).toBe(true);
    setWakeTriageControlSampler(() => 0.1);
    expect(drawWakeTriageControl()).toBe(false);
    process.env.DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE = '0.25';
    expect(wakeTriageControlSampleRate()).toBe(0.25);
    setWakeTriageControlSampler(() => 0.2);
    expect(drawWakeTriageControl()).toBe(true);
    process.env.DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE = '9';
    expect(wakeTriageControlSampleRate()).toBe(1);
    setWakeTriageControlSampler(() => 0.999);
    expect(drawWakeTriageControl()).toBe(true);
    process.env.DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE = '-1';
    expect(wakeTriageControlSampleRate()).toBe(0);
    setWakeTriageControlSampler(() => 0);
    expect(drawWakeTriageControl()).toBe(false);
    process.env.DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE = '  ';
    expect(wakeTriageControlSampleRate()).toBeCloseTo(0.1, 9);
    process.env.DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE = 'often';
    expect(wakeTriageControlSampleRate()).toBeCloseTo(0.1, 9);
  });

  it('fires at roughly the configured rate over many draws (deterministic sampler sweep)', () => {
    let i = 0;
    setWakeTriageControlSampler(() => ((i++ % 1000) + 0.5) / 1000);
    let hits = 0;
    for (let n = 0; n < 1000; n++) if (drawWakeTriageControl()) hits += 1;
    expect(hits).toBe(100);
  });

  it('kill switch WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED=1 (1 / true / on) ⇒ rate 0 and the draw never hits, whatever the rate env says', () => {
    for (const v of ['1', 'true', 'on']) {
      process.env.WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED = v;
      process.env.DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE = '1';
      expect(wakeTriageControlSampleDisabled()).toBe(true);
      expect(wakeTriageControlSampleRate()).toBe(0);
      setWakeTriageControlSampler(() => 0);
      expect(drawWakeTriageControl()).toBe(false);
    }
    process.env.WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED = '0';
    expect(wakeTriageControlSampleDisabled()).toBe(false);
  });

  it('the control extra is the sweep_triage shape {control:true, controlReason:"sample"} and cannot be mutated', () => {
    expect(WAKE_TRIAGE_CONTROL_EXTRA).toEqual({ control: true, controlReason: 'sample' });
    expect(Object.isFrozen(WAKE_TRIAGE_CONTROL_EXTRA)).toBe(true);
  });
});

describe('a control wake is labelled INSIDE the act band at the finalize — both auto-demote windows admit it', () => {
  const controlStash = () => stashDecision(QUIET_ACT, 'wake_triage', { extra: { ...WAKE_TRIAGE_CONTROL_EXTRA } });

  it('the stash carries mode act + the control extra (what hooks.service hands fireScheduleTarget)', () => {
    expect(controlStash()).toMatchObject({ id: 'wt-ctl-1', purpose: 'wake_triage', mode: 'act', extra: { control: true, controlReason: 'sample' } });
  });

  it('a QUIET control run (no mutation, WAKE: no-op) ⇒ outcome row {mode act, inActBand, acted false, actual false, agreed true, control} — admitted by durableActBandWindows and counted by the in-memory E12 window', async () => {
    await labelMachineRunOutcome(controlStash(), { parts: parts('get_chat_status'), finalText: 'WAKE: no-op — nothing to do.', sessionId: 'sup-1' });
    const rows = outcomeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'decision_gate', sessionId: 'sup-1', value: 1,
      meta: { phase: 'outcome', id: 'wt-ctl-1', purpose: 'wake_triage', mode: 'act', question: 'needs_turn_now', actual: false, acted: false, agreed: true, inActBand: true, control: true, controlReason: 'sample', harnessActed: false },
    });
    expect(rows[0].meta.challenger).toBeUndefined();
    expect(rows[0].meta.excludeFromFit).toBeUndefined();
    expect(durableActBandWindows([asRow(rows[0])] as any, new Set(['wake_triage'])).get('wake_triage')).toEqual({ n: 1, k: 1, since: '2026-10-04T12:00:00.000Z' });
    expect(actBandWindow('wake_triage')).toMatchObject({ n: 1, precision: 1 });
  });

  it('a control run that ACTED (a mutating platform tool) ⇒ actual true, agreed false — the miss the windows exist to count', async () => {
    await labelMachineRunOutcome(controlStash(), { parts: parts('get_chat_status', 'send_chat_message'), finalText: 'Steered the lane.', sessionId: 'sup-1' });
    const rows = outcomeRows();
    expect(rows[0]).toMatchObject({ value: 0, meta: { mode: 'act', inActBand: true, acted: false, actual: true, agreed: false, control: true, harnessActed: true } });
    expect(durableActBandWindows([asRow(rows[0])] as any, new Set(['wake_triage'])).get('wake_triage')).toMatchObject({ n: 1, k: 0 });
    expect(actBandWindow('wake_triage')).toMatchObject({ n: 1, precision: 0 });
  });

  it('a FAILED control run evidences nothing (actual null, no agreed) — admitted by neither window', async () => {
    await labelMachineRunOutcome(controlStash(), { parts: [], finalText: '', sessionId: 'sup-1', failed: true });
    const rows = outcomeRows();
    expect(rows[0].meta).toMatchObject({ mode: 'act', actual: null, control: true });
    expect(rows[0].meta.agreed).toBeUndefined();
    expect(durableActBandWindows([asRow(rows[0])] as any, new Set(['wake_triage'])).has('wake_triage')).toBe(false);
    expect(actBandWindow('wake_triage').n).toBe(0);
  });

  it('THE pre-change shape: the PARK row (acted true, actual null) and a fired non-quiet act wake (outside the band) are admitted by neither window — why the act band stayed empty', async () => {
    recordDecisionOutcome(QUIET_ACT, 'wake_triage', { question: 'needs_turn_now', actual: null, acted: true, sessionId: 'sup-1', note: 'parked 1 row(s) for 30 min' });
    const fired: DecideResult = { ...QUIET_ACT, id: 'wt-fired', answers: { needs_turn_now: { type: 'noul', noul: 0.55 } } } as DecideResult;
    await labelMachineRunOutcome(stashDecision(fired, 'wake_triage'), { parts: parts('send_chat_message'), finalText: 'Steered the lane.', sessionId: 'sup-1' });
    const rows = outcomeRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].meta).toMatchObject({ acted: true, actual: null, inActBand: true });
    expect(rows[1].meta).toMatchObject({ mode: 'act', acted: false, inActBand: false, agreed: true });
    expect(durableActBandWindows(rows.map(asRow) as any, new Set(['wake_triage'])).has('wake_triage')).toBe(false);
    expect(actBandWindow('wake_triage').n).toBe(0);
  });

  it('a SHADOW-era quiet row (mode shadow) never enters the act-period windows, control stamp or not', async () => {
    const shadowStash = stashDecision({ ...QUIET_ACT, mode: 'shadow' } as DecideResult, 'wake_triage', { extra: { ...WAKE_TRIAGE_CONTROL_EXTRA } });
    await labelMachineRunOutcome(shadowStash, { parts: parts('get_chat_status'), finalText: 'WAKE: no-op', sessionId: 'sup-1' });
    const rows = outcomeRows();
    expect(rows[0].meta).toMatchObject({ mode: 'shadow', inActBand: true, agreed: true });
    expect(durableActBandWindows(rows.map(asRow) as any, new Set(['wake_triage'])).has('wake_triage')).toBe(false);
    expect(actBandWindow('wake_triage').n).toBe(0);
  });
});

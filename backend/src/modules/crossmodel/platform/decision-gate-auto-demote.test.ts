/**
 * E12 auto-demotion — the ACT-PERIOD window + the Wilson upper-bound rule
 * (decision-gate-modes.ts). Incident 2026-09-26 00:24:40Z: the owner flipped
 * wake_triage to act at 00:20:54Z and four minutes later the window demoted it
 * on n=47 / precision 0.894 — 47 labels that had accrued in SHADOW over the
 * previous hours (the window never looked at the decision's mode) and a point
 * estimate one label under the 0.9 bar. Pins:
 *   - shadow-period labels never count; a fresh flip with 47 historical labels does not demote;
 *   - the rule: n_act ≥ MIN_N AND wilsonUpper95(k, n_act) < bar − margin — 23/30 demotes once,
 *     24/30 / 29/30 / 42/47 / 45/47 do not, 38/47 does;
 *   - the window resets on an effective-mode move (store refresh, admin PUT, demotion), not on a failed read;
 *   - per-purpose bar env, the margin env, the kill switch, the row + log-line shape (act-period, n_act, bounds).
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockStoreGet = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockStorePut = jest.fn(async (..._a: any[]): Promise<void> => undefined);
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));
class FakeAppError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
jest.mock('../../../middleware/error-handler', () => ({ AppError: FakeAppError }));
const mockRecordLoopMetric = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import logger from '../../../utils/logger';
import { wilsonInterval } from './decision-gate-math';
import {
  ACT_BAND_WINDOW,
  AUTO_DEMOTE_MARGIN_DEFAULT,
  AUTO_DEMOTE_MIN_N_DEFAULT,
  AUTO_DEMOTE_MIN_PRECISION_DEFAULT,
  actBandBreachVerdict,
  actBandWindow,
  autoDemoteMargin,
  autoDemoteMinN,
  autoDemoteMinPrecision,
  clearActBandWindows,
  clearDecisionModeCache,
  noteActBandOutcome,
  refreshDecisionModes,
  resetActBandWindow,
  updateDecisionModes,
} from './decision-gate-modes';
import type { DecisionMode, DecisionPurpose } from './decision-gate';

const ENV_KEYS = ['DECISION_GATE_DISABLED', 'DECISION_GATE_DEFAULT_MODE', 'DECISION_GATE_MODE_WAKE_TRIAGE', 'DECISION_GATE_MODE_SELF_AUDIT', 
  'DECISION_GATE_ADMISSION_DISABLED', 'DECISION_GATE_AUTO_DEMOTE_MIN_N', 'DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION',
  'DECISION_GATE_AUTO_DEMOTE_MARGIN', 'DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_WAKE_TRIAGE', 'DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_SELF_AUDIT'];
const saved: Record<string, string | undefined> = {};
let modesRow: any = null;
let readinessRow: any = null;
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  modesRow = null;
  readinessRow = null;
  mockStoreGet.mockReset();
  mockStoreGet.mockImplementation(async (_ns: string[], key: string) => (key === 'modes' ? modesRow : key === 'readiness' ? readinessRow : null));
  mockStorePut.mockReset();
  mockStorePut.mockImplementation(async (_ns: string[], key: string, value: any) => { if (key === 'modes') modesRow = value; else if (key === 'readiness') readinessRow = value; });
  mockRecordLoopMetric.mockReset();
  for (const fn of Object.values(logger as unknown as Record<string, jest.Mock>)) fn.mockClear?.();
  clearDecisionModeCache();
  clearActBandWindows();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const flush = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
/** Feed k AGREED labels then n − k DISAGREED ones (agreements first, so a breach can only fire on the LAST label — every
 *  intermediate window is at least as precise). Returns the last call's result. */
const feed = (purpose: DecisionPurpose, k: number, n: number, mode: DecisionMode | null | undefined = 'act') => {
  let last: ReturnType<typeof noteActBandOutcome> = null;
  for (let i = 0; i < n; i++) last = noteActBandOutcome(purpose, i < k, mode);
  return last;
};
const r3 = (x: number) => Number(x.toFixed(3));
const warnLines = () => ((logger as any).warn as jest.Mock).mock.calls.map((c: any[]) => String(c[0]));

describe('wilsonInterval (z = 1.96)', () => {
  it('pins the boundaries the rule is documented with', () => {
    const at = (k: number, n: number) => { const w = wilsonInterval(k, n); return [r3(w.lower), r3(w.upper)]; };
    expect(at(42, 47)).toEqual([0.774, 0.954]); // the incident's numbers — inside the noise of the 0.9 bar
    expect(at(45, 47)).toEqual([0.858, 0.988]);
    expect(at(38, 47)).toEqual([0.675, 0.896]);
    expect(at(39, 47)).toEqual([0.699, 0.911]);
    expect(at(23, 30)).toEqual([0.591, 0.882]);
    expect(at(24, 30)).toEqual([0.627, 0.905]);
    expect(at(29, 30)).toEqual([0.833, 0.994]); // ONE miss in 30 — a lower-bound rule at 0.85 would have demoted this
    expect(at(30, 30)).toEqual([0.886, 1]);
    expect(at(84, 100)).toEqual([0.756, 0.899]);
    expect(at(85, 100)).toEqual([0.767, 0.907]);
    expect(wilsonInterval(0, 0)).toMatchObject({ lower: 0, upper: 1 });
    expect(wilsonInterval(0, -1)).toMatchObject({ lower: 0, upper: 1 });
    expect(wilsonInterval(7, 5).pHat).toBe(1); // k clamped to n
    expect(wilsonInterval(-2, 5).pHat).toBe(0);
    expect(wilsonInterval(5, 10, 1.645).upper).toBeLessThan(wilsonInterval(5, 10).upper); // smaller z → tighter
  });
});

describe('actBandBreachVerdict — demote iff n ≥ minN AND wilsonUpper95(k, n) < bar − margin', () => {
  const D = { minN: 30, bar: 0.9, margin: 0 };
  it('boundaries at the defaults (bar 0.9, margin 0, minN 30)', () => {
    expect(actBandBreachVerdict(23, 30, D).breach).toBe(true);   // upper 0.882
    expect(actBandBreachVerdict(24, 30, D).breach).toBe(false);  // upper 0.905
    expect(actBandBreachVerdict(29, 30, D).breach).toBe(false);  // one miss in 30 keeps
    expect(actBandBreachVerdict(38, 47, D).breach).toBe(true);   // upper 0.896
    expect(actBandBreachVerdict(39, 47, D).breach).toBe(false);  // upper 0.911
    expect(actBandBreachVerdict(42, 47, D)).toMatchObject({ breach: false, precision: 42 / 47 }); // the incident: not confidently below
    expect(actBandBreachVerdict(45, 47, D).breach).toBe(false);
    expect(actBandBreachVerdict(84, 100, D).breach).toBe(true);  // upper 0.899
    expect(actBandBreachVerdict(85, 100, D).breach).toBe(false); // upper 0.907
    expect(actBandBreachVerdict(0, 29, D).breach).toBe(false);   // below minN: never, whatever the precision
    expect(actBandBreachVerdict(0, 30, D).breach).toBe(true);
    expect(actBandBreachVerdict(0, 0, D)).toMatchObject({ breach: false, precision: NaN, lowerBound: 0, upperBound: 1 });
  });
  it('the margin lowers the line the upper bound must fall under; the bar moves it', () => {
    expect(actBandBreachVerdict(23, 30, { ...D, margin: 0.05 }).breach).toBe(false); // 0.882 ≥ 0.85
    expect(actBandBreachVerdict(20, 30, { ...D, margin: 0.05 }).breach).toBe(true);  // 0.808 < 0.85
    expect(actBandBreachVerdict(23, 30, { ...D, bar: 0.85 }).breach).toBe(false);
    expect(actBandBreachVerdict(24, 30, { ...D, bar: 0.95 }).breach).toBe(true);     // 0.905 < 0.95
  });
});

describe('E12 auto-demotion — the act-period window (incident 2026-09-26 00:24:40Z)', () => {
  it('shadow-period labels never count: shadow / off / unknown-mode decisions leave the window empty and write nothing', async () => {
    modesRow = { modes: { wake_triage: 'shadow' } };
    await refreshDecisionModes();
    expect(feed('wake_triage', 42, 47, 'shadow')).toBeNull();
    expect(noteActBandOutcome('wake_triage', false, 'off')).toBeNull();
    expect(noteActBandOutcome('wake_triage', false, null)).toBeNull();
    expect(noteActBandOutcome('wake_triage', false, undefined)).toBeNull();
    expect(actBandWindow('wake_triage')).toEqual({ n: 0, precision: NaN, lowerBound: 0, upperBound: 1, since: null });
    await flush();
    expect(mockStorePut).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('a fresh flip with 47 historical (shadow) labels does NOT demote: the flip starts the window at zero and only act-period labels count', async () => {
    modesRow = { modes: { wake_triage: 'shadow' } };
    await refreshDecisionModes();
    feed('wake_triage', 42, 47, 'shadow'); // the incident's 47 shadow-era labels (42 agreed)
    expect(actBandWindow('wake_triage').n).toBe(0);
    modesRow = { modes: { wake_triage: 'act' } };
    await refreshDecisionModes(); // the flip reaches this process
    expect(actBandWindow('wake_triage')).toMatchObject({ n: 0, since: null });
    // Four minutes of act: a handful of act-period labels — even all disagreed — cannot breach (n_act < MIN_N).
    expect(feed('wake_triage', 0, 5)).toBeNull();
    expect(actBandWindow('wake_triage')).toMatchObject({ n: 5, precision: 0, since: expect.any(String) });
    await flush();
    expect(mockStorePut).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('30 act-period labels at 23/30 (upper 0.882 < 0.9) demote ONCE: store → shadow; the row + log line say act-period, n_act and the bounds; the window restarts', async () => {
    modesRow = { modes: { wake_triage: 'act' } };
    await refreshDecisionModes();
    expect(actBandWindow('wake_triage').since).toBeNull();
    const breach = feed('wake_triage', 23, 30)!;
    expect(breach).toMatchObject({ n: 30, bar: 0.9, margin: 0, windowSince: expect.any(String) });
    expect(breach.precision).toBeCloseTo(23 / 30, 6);
    expect(breach.upperBound).toBeCloseTo(0.882, 3);
    expect(breach.lowerBound).toBeCloseTo(0.591, 3);
    expect(actBandWindow('wake_triage')).toMatchObject({ n: 0, since: null });
    await flush();
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    expect(mockStorePut.mock.calls[0][2]).toMatchObject({
      modes: { wake_triage: 'shadow' }, updatedBy: 'auto-demote',
      demoted: { purpose: 'wake_triage', n: 30, nAct: 30, precision: 0.767, lowerBound: 0.591, upperBound: 0.882, bar: 0.9, margin: 0, windowScope: 'act_period', windowSince: breach.windowSince },
    });
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric.mock.calls[0][0]).toMatchObject({
      kind: 'decision_gate_demoted', value: 0.767,
      meta: { purpose: 'wake_triage', n: 30, nAct: 30, precision: 0.767, lowerBound: 0.591, upperBound: 0.882, bar: 0.9, margin: 0, window: ACT_BAND_WINDOW, windowScope: 'act_period', windowSince: breach.windowSince, previousStoreMode: 'act', effectiveBefore: 'act', outcome: 'demoted' },
    });
    const line = warnLines().find(s => s.includes('AUTO-DEMOTED wake_triage'));
    expect(line).toBeDefined();
    expect(line).toMatch(/act-period act-band precision 0\.767 over n_act=30 labelled act-mode outcomes/);
    expect(line).toMatch(/Wilson 95% \[0\.591, 0\.882\]; upper bound < bar 0\.9;/);
    expect(line).toContain(`window since ${breach.windowSince}`);
    // ONCE: the purpose is shadow now — a late act-period breach finds nothing to demote (no second write, no second row).
    expect(feed('wake_triage', 0, 30)).toMatchObject({ n: 30 });
    await flush();
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
  });

  it('42/47 and 45/47 in the act period do NOT demote (upper 0.954 / 0.988 ≥ 0.9); 38/47 (upper 0.896) does', async () => {
    modesRow = { modes: { wake_triage: 'act' } };
    await refreshDecisionModes();
    expect(feed('wake_triage', 42, 47)).toBeNull(); // the incident's numbers, now genuinely act-period: inside the noise
    expect(actBandWindow('wake_triage')).toMatchObject({ n: 47 });
    expect(actBandWindow('wake_triage').precision).toBeCloseTo(42 / 47, 6);
    expect(actBandWindow('wake_triage').upperBound).toBeCloseTo(0.954, 3);
    resetActBandWindow('wake_triage', 'test');
    expect(feed('wake_triage', 45, 47)).toBeNull();
    resetActBandWindow('wake_triage', 'test');
    const breach = feed('wake_triage', 38, 47)!;
    expect(breach).toMatchObject({ n: 47 });
    expect(breach.upperBound).toBeCloseTo(0.896, 3);
    await flush();
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    expect(mockStorePut.mock.calls[0][2].demoted).toMatchObject({ nAct: 47, precision: 0.809, upperBound: 0.896, windowScope: 'act_period' });
  });

  it('the window resets on an effective-mode move — store refresh (a flip on any box), the admin PUT, "" clearing the row — and NOT on a failed read or a no-op PUT', async () => {
    modesRow = { modes: { wake_triage: 'act' } };
    await refreshDecisionModes();
    feed('wake_triage', 10, 10);
    expect(actBandWindow('wake_triage').n).toBe(10);
    // A failed store read keeps the window (fail-open — never "every purpose cleared").
    mockStoreGet.mockImplementationOnce(async () => { throw new Error('db blip'); });
    await refreshDecisionModes();
    expect(actBandWindow('wake_triage').n).toBe(10);
    // A refresh that sees the same row: no reset.
    await refreshDecisionModes();
    expect(actBandWindow('wake_triage').n).toBe(10);
    // The store moved act → shadow on another box: the next refresh here resets.
    modesRow = { modes: { wake_triage: 'shadow' } };
    await refreshDecisionModes();
    expect(actBandWindow('wake_triage')).toMatchObject({ n: 0, since: null });
    // Back to act via the admin PUT (fresh READY stamp): a real move resets at once; a no-op PUT keeps the window.
    readinessRow = { wake_triage: { ready: true, at: new Date().toISOString(), metrics: { n: 240 } } };
    await updateDecisionModes({ wake_triage: 'act' }, 'admin-1');
    feed('wake_triage', 3, 3);
    expect(actBandWindow('wake_triage').n).toBe(3);
    await updateDecisionModes({ wake_triage: 'act' }, 'admin-1'); // unchanged
    expect(actBandWindow('wake_triage').n).toBe(3);
    await updateDecisionModes({ wake_triage: 'shadow' }, 'admin-1');
    expect(actBandWindow('wake_triage').n).toBe(0);
    await updateDecisionModes({ wake_triage: 'act' }, 'admin-1');
    feed('wake_triage', 2, 2);
    await updateDecisionModes({ wake_triage: '' }, 'admin-1'); // cleared → env: a move too
    expect(actBandWindow('wake_triage').n).toBe(0);
    // An env-only act seen before the first store read, then a store row saying shadow: the first read is a move too.
    clearActBandWindows();
    clearDecisionModeCache();
    process.env.DECISION_GATE_MODE_SELF_AUDIT = 'act';
    feed('self_audit', 4, 4);
    modesRow = { modes: { self_audit: 'shadow' } };
    await refreshDecisionModes();
    expect(actBandWindow('self_audit').n).toBe(0);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('per-purpose bar: DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_<PURPOSE> wins over the global env for THAT purpose only', async () => {
    expect(autoDemoteMinPrecision('wake_triage')).toBe(AUTO_DEMOTE_MIN_PRECISION_DEFAULT);
    process.env.DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION = '0.95';
    process.env.DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_WAKE_TRIAGE = '0.85';
    expect(autoDemoteMinPrecision('wake_triage')).toBe(0.85);
    expect(autoDemoteMinPrecision('self_audit')).toBe(0.95);
    expect(autoDemoteMinPrecision()).toBe(0.95);
    process.env.DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_WAKE_TRIAGE = '1.5'; // invalid → falls through to the global
    expect(autoDemoteMinPrecision('wake_triage')).toBe(0.95);
    process.env.DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_WAKE_TRIAGE = '0.85';
    modesRow = { modes: { wake_triage: 'act', self_audit: 'act' } };
    await refreshDecisionModes();
    expect(feed('wake_triage', 23, 30)).toBeNull(); // upper 0.882 ≥ 0.85: keeps under wake_triage's own bar
    resetActBandWindow('wake_triage', 'test');
    expect(feed('wake_triage', 20, 30)).toMatchObject({ n: 30, bar: 0.85 }); // upper 0.808 < 0.85
    expect(feed('self_audit', 24, 30)).toMatchObject({ n: 30, bar: 0.95 });  // upper 0.905 < the global 0.95
    await flush();
    expect(mockStorePut).toHaveBeenCalledTimes(2);
    expect(mockStorePut.mock.calls[0][2].demoted).toMatchObject({ purpose: 'wake_triage', bar: 0.85, upperBound: 0.808 });
    expect(mockStorePut.mock.calls[1][2].demoted).toMatchObject({ purpose: 'self_audit', bar: 0.95, upperBound: 0.905 });
    expect(modesRow.modes).toEqual({ wake_triage: 'shadow', self_audit: 'shadow' });
  });

  it('DECISION_GATE_AUTO_DEMOTE_MARGIN: extra tolerance below the bar (default 0; out-of-range values fall back)', async () => {
    expect(AUTO_DEMOTE_MARGIN_DEFAULT).toBe(0);
    expect(autoDemoteMargin()).toBe(0);
    process.env.DECISION_GATE_AUTO_DEMOTE_MARGIN = '0.7';
    expect(autoDemoteMargin()).toBe(0);
    process.env.DECISION_GATE_AUTO_DEMOTE_MARGIN = '-0.1';
    expect(autoDemoteMargin()).toBe(0);
    process.env.DECISION_GATE_AUTO_DEMOTE_MARGIN = '0.05';
    expect(autoDemoteMargin()).toBe(0.05);
    modesRow = { modes: { wake_triage: 'act' } };
    await refreshDecisionModes();
    expect(feed('wake_triage', 23, 30)).toBeNull(); // 0.882 ≥ 0.9 − 0.05
    resetActBandWindow('wake_triage', 'test');
    const breach = feed('wake_triage', 20, 30)!;   // 0.808 < 0.85
    expect(breach).toMatchObject({ n: 30, bar: 0.9, margin: 0.05 });
    await flush();
    expect(mockStorePut.mock.calls[0][2].demoted).toMatchObject({ bar: 0.9, margin: 0.05, upperBound: 0.808 });
    expect(warnLines().find(s => s.includes('AUTO-DEMOTED wake_triage'))).toMatch(/upper bound < bar 0\.9 − margin 0\.05;/);
  });

  it('MIN_N honours DECISION_GATE_AUTO_DEMOTE_MIN_N (floor 5, cap 100); the window keeps the last 100 act-period labels', () => {
    expect(AUTO_DEMOTE_MIN_N_DEFAULT).toBe(30);
    expect(autoDemoteMinN()).toBe(30);
    process.env.DECISION_GATE_AUTO_DEMOTE_MIN_N = '3';
    expect(autoDemoteMinN()).toBe(30);
    process.env.DECISION_GATE_AUTO_DEMOTE_MIN_N = '250';
    expect(autoDemoteMinN()).toBe(100);
    process.env.DECISION_GATE_AUTO_DEMOTE_MIN_N = '5';
    expect(autoDemoteMinN()).toBe(5);
    process.env.DECISION_GATE_AUTO_DEMOTE_MIN_N = '1000'; // never breaches below the cap in this test
    feed('wake_triage', 120, 120);
    expect(actBandWindow('wake_triage')).toMatchObject({ n: ACT_BAND_WINDOW, precision: 1 });
  });
});

/**
 * decision-gate-readiness.job.ts — the in-process E1 ruler (2026-09-25):
 * synthetic decision_gate rows → the stamp for EVERY ACT_POLICIES purpose
 * (ready ONLY when every bar holds), the stored report (computedAt), one
 * decision_gate_readiness row per purpose; the kill switch; NO store write on
 * failure; the stamp kill switch keeps the report but not the stamp.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
// Laya follow-up (2026-09-26): the pass also prunes sampled-state rows with ONE deleteMany (kind + createdAt).
const mockDeleteMany = jest.fn(async (..._a: any[]): Promise<{ count: number }> => ({ count: 0 }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: { loopMetric: { findMany: (...a: any[]) => mockFindMany(...a), deleteMany: (...a: any[]) => mockDeleteMany(...a) } } }));
const mockStoreGet = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockStorePut = jest.fn(async (..._a: any[]): Promise<void> => undefined);
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));
const mockRecordLoopMetrics = jest.fn((_rows: any[]) => undefined);
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetrics: (...a: any[]) => mockRecordLoopMetrics(a[0]),
  recordLoopMetric: jest.fn(),
}));

import logger from '../../../utils/logger';
import { ACT_POLICIES, type ReadinessRow } from './decision-gate-fit';
import { BACKENDS_STORE_KEY, READINESS_REPORT_STORE_KEY, READINESS_STORE_KEY, READINESS_STORE_NS } from './decision-gate-readiness';
import { setDecisionPrimaryResolver } from './decision-gate-modes';
import {
  DECISION_GATE_STATE_KIND, READINESS_METRIC_KIND, READINESS_ROW_CAP, pruneDecisionGateStateRows, readinessMetricRow, readinessMetricRowsForEntries, runDecisionGateReadinessOnce,
  stateRetentionDays,
} from './decision-gate-readiness.job';

const ENVS = ['DECISION_GATE_READINESS_JOB_DISABLED', 'DECISION_GATE_READINESS_WINDOW_DAYS', 'DECISION_GATE_TEMP_AUTOFIT_DISABLED', 'DECISION_GATE_TEMP_AUTOFIT_ENABLED',
  'DECISION_GATE_STATE_RETENTION_DAYS'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
  mockFindMany.mockReset(); mockFindMany.mockResolvedValue([]);
  mockDeleteMany.mockReset(); mockDeleteMany.mockResolvedValue({ count: 0 });
  mockStoreGet.mockReset(); mockStoreGet.mockResolvedValue(null);
  mockStorePut.mockReset(); mockStorePut.mockResolvedValue(undefined);
  mockRecordLoopMetrics.mockReset();
  (logger.warn as jest.Mock).mockClear();
  setDecisionPrimaryResolver(null);
});
afterEach(() => { for (const k of ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } setDecisionPrimaryResolver(null); });

// ── synthetic rows (the fit test's readyShaped() as loop_metrics-shaped rows) ──
const decisionRow = (id: string, purpose: string, backend: string, answers: any, extra: any, at: string, sessionId?: string): ReadinessRow =>
  ({ meta: { phase: 'decision', id, purpose, backend, answers, ...extra }, createdAt: new Date(at), ...(sessionId ? { sessionId } : {}) });
const outcomeRow = (id: string, purpose: string, question: string, actual: any): ReadinessRow =>
  ({ meta: { phase: 'outcome', id, purpose, question, actual, acted: false }, createdAt: new Date('2026-09-21T00:00:00Z') });

/** 300 wake_triage labels over 5 days on TypeSafe Jev: 150 confident-no (5 wrong), 100 confident-yes (3 wrong), 50 unsure. Every bar holds. */
function readyRows(purpose = 'wake_triage', question = 'needs_turn_now'): ReadinessRow[] {
  const t0 = Date.parse('2026-09-20T00:00:00Z');
  const rows: ReadinessRow[] = [];
  let k = 0;
  const push = (noul: number, actual: 'yes' | 'no', i: number) => {
    const at = new Date(t0 + Math.floor((k / 300) * 5 * 86_400_000)).toISOString();
    const id = `s${k}`;
    rows.push(decisionRow(id, purpose, 'TypeSafe Jev', { [question]: { noul } }, { stateHash: `h${k}`, questionsHash: 'q1' }, at, `chat-${i % 10}`));
    rows.push(outcomeRow(id, purpose, question, actual === 'yes'));
    k += 1;
  };
  for (let i = 0; i < 150; i++) push(0.05, i < 5 ? 'yes' : 'no', i);
  for (let i = 0; i < 100; i++) push(0.95, i < 3 ? 'no' : 'yes', i);
  for (let i = 0; i < 50; i++) push(0.4, i < 25 ? 'yes' : 'no', i);
  return rows;
}

/** 30 self_audit labels in one day — too few, too short: NOT READY with the bars named. */
function fewRows(): ReadinessRow[] {
  const rows: ReadinessRow[] = [];
  for (let i = 0; i < 30; i++) {
    const id = `f${i}`;
    rows.push(decisionRow(id, 'self_audit', 'TypeSafe Jev', { unevidenced: { noul: i % 2 ? 0.9 : 0.1 } }, { stateHash: `fh${i}`, questionsHash: 'q1' }, `2026-09-24T0${i % 10}:00:00Z`));
    rows.push(outcomeRow(id, 'self_audit', 'unevidenced', i % 2 === 1));
  }
  return rows;
}

const NOW = new Date('2026-09-25T12:00:00Z');
const stampWrite = () => mockStorePut.mock.calls.find(c => c[1] === READINESS_STORE_KEY);
const reportWrite = () => mockStorePut.mock.calls.find(c => c[1] === READINESS_REPORT_STORE_KEY);

describe('runDecisionGateReadinessOnce', () => {
  it('computes the report from the window rows and stamps EVERY purpose: READY only when every bar holds, the rest NOT READY with reasons', async () => {
    mockFindMany.mockResolvedValue([...readyRows(), ...fewRows()]);
    const summary = await runDecisionGateReadinessOnce({ now: NOW, windowDays: 14, workerId: 'worker-test-1' });

    // The query is the CLI's: decision_gate rows in the window, ascending, bounded.
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    const q = mockFindMany.mock.calls[0][0];
    expect(q.where).toEqual({ kind: 'decision_gate', createdAt: { gte: new Date('2026-09-11T12:00:00Z'), lte: NOW } });
    expect(q.orderBy).toEqual({ createdAt: 'asc' });
    expect(q.take).toBe(READINESS_ROW_CAP);

    // The stamp: 24 purposes (all of ACT_POLICIES; 17 + the three compute-policy purposes of 2026-09-26 + supervisor_turn_noop + session_topology of 2026-09-27 + turn_plan of 2026-10-03 + task_kind of 2026-10-20), purpose keys only.
    const sw = stampWrite();
    expect(sw).toBeDefined();
    expect(sw![0]).toEqual(READINESS_STORE_NS);
    const stamp = sw![2] as Record<string, any>;
    expect(Object.keys(stamp).sort()).toEqual(Object.keys(ACT_POLICIES).sort());
    expect(Object.keys(stamp)).toHaveLength(24);
    expect(stamp.wake_triage).toMatchObject({ ready: true, backend: 'TypeSafe Jev', reasons: [], windowDays: 14, partition: 'q1', at: NOW.toISOString() });
    expect(stamp.wake_triage.metrics.n).toBe(300);
    expect(stamp.self_audit.ready).toBe(false);
    expect(stamp.self_audit.backend).toBe('TypeSafe Jev');
    expect(stamp.self_audit.reasons.some((r: string) => r.startsWith('labels 30 < 200'))).toBe(true);
    expect(stamp.self_audit.reasons.some((r: string) => r.startsWith('span '))).toBe(true);
    // A purpose with no labelled rows at all is NOT READY, first reason "no labelled outcomes", every bar named after it.
    for (const p of Object.keys(ACT_POLICIES).filter(p => p !== 'wake_triage' && p !== 'self_audit')) {
      expect(stamp[p]).toMatchObject({ ready: false, backend: 'none', windowDays: 14, partition: '' });
      expect(stamp[p].reasons[0]).toBe('no labelled outcomes in the window');
      expect(stamp[p].reasons.some((r: string) => r.startsWith('labels 0 < 200'))).toBe(true);
      expect(stamp[p].metrics.n).toBe(0);
    }
    expect(Object.values(stamp).filter((e: any) => e.ready)).toHaveLength(1);

    // The report: computedAt + every entry + fits + the worker id — JSON-safe (NaN → null).
    const rw = reportWrite();
    expect(rw).toBeDefined();
    const report = rw![2] as Record<string, any>;
    expect(report).toMatchObject({ computedAt: NOW.toISOString(), windowDays: 14, rows: 660, stampWritten: true, workerId: 'worker-test-1' });
    expect(report.entries.map((e: any) => e.purpose).sort()).toEqual(Object.keys(ACT_POLICIES).sort());
    expect(report.entries.find((e: any) => e.purpose === 'wake_triage')).toMatchObject({ backend: 'TypeSafe Jev', ready: true, calibrated: true });
    // 2026-09-26: systemone rows are fitted from their answers (log p) too — the built-in jev's fit is REPORTED but never autofitted (it is the calibrated reference).
    expect(report.fits.map((f: any) => `${f.backendSpec}/${f.purpose}/${f.ready}/${f.autofit}`)).toEqual(['jev/self_audit/false/false', 'jev/wake_triage/true/false']);
    expect(report).toMatchObject({ temps: {}, tempsChanged: [], tempsWritten: false, autofitEnabled: false, primaryByPurpose: {} });
    expect(JSON.stringify(report)).not.toContain('NaN');
    // Stamp before report (the admission read lands first).
    expect(mockStorePut.mock.calls.map(c => c[1])).toEqual([READINESS_STORE_KEY, READINESS_REPORT_STORE_KEY]);

    // One decision_gate_readiness row per purpose, the agreed meta shape.
    expect(mockRecordLoopMetrics).toHaveBeenCalledTimes(1);
    const rows = mockRecordLoopMetrics.mock.calls[0][0] as any[];
    expect(rows).toHaveLength(24);
    expect(rows.every(r => r.kind === READINESS_METRIC_KIND)).toBe(true);
    expect(rows.map(r => r.meta.purpose)).toEqual(Object.keys(ACT_POLICIES).sort());
    const wt = rows.find(r => r.meta.purpose === 'wake_triage');
    expect(wt.value).toBe(1);
    expect(wt.meta).toMatchObject({ purpose: 'wake_triage', backend: 'TypeSafe Jev', ready: true, labels: 300, bandN: 150, reasons: [] });
    expect(wt.meta.spanDays).toBeGreaterThan(3);
    expect(wt.meta.auroc).toBeGreaterThanOrEqual(0.8);
    expect(wt.meta.coverage5).toBeGreaterThanOrEqual(0.6);
    expect(wt.meta.bandPrecision).toBeGreaterThanOrEqual(0.9);
    const empty = rows.find(r => r.meta.purpose === 'imessage_send');
    expect(empty.value).toBe(0);
    expect(empty.meta).toMatchObject({ backend: 'none', ready: false, labels: 0, bandN: 0, auroc: null, bandPrecision: null, coverage5: 0 });
    expect(empty.meta.reasons[0]).toBe('no labelled outcomes in the window');

    expect(summary).toMatch(/^rows 660, purposes 24, ready 1 \(wake_triage\), stamped, 14 d window, \d+ ms$/);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('an empty window still stamps all 24 purposes NOT READY (the live-verify shape after deploy)', async () => {
    const summary = await runDecisionGateReadinessOnce({ now: NOW });
    const stamp = stampWrite()![2] as Record<string, any>;
    expect(Object.keys(stamp)).toHaveLength(24);
    expect(Object.values(stamp).every((e: any) => e.ready === false && e.reasons.length > 0)).toBe(true);
    expect((reportWrite()![2] as any).rows).toBe(0);
    expect(mockRecordLoopMetrics.mock.calls[0][0]).toHaveLength(24);
    expect(summary).toMatch(/^rows 0, purposes 24, ready 0, stamped, 14 d window/);
  });

  it('DECISION_GATE_READINESS_JOB_DISABLED=1: no query, no write, no row', async () => {
    process.env.DECISION_GATE_READINESS_JOB_DISABLED = '1';
    const summary = await runDecisionGateReadinessOnce({ now: NOW });
    expect(summary).toContain('disabled');
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockStorePut).not.toHaveBeenCalled();
    expect(mockRecordLoopMetrics).not.toHaveBeenCalled();
  });

  it('a failing query writes NOTHING — no stamp, no report, no rows — and never throws', async () => {
    mockFindMany.mockRejectedValue(new Error('connection reset'));
    const summary = await runDecisionGateReadinessOnce({ now: NOW });
    expect(summary).toBe('failed: connection reset');
    expect(mockStorePut).not.toHaveBeenCalled();
    expect(mockRecordLoopMetrics).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('nothing written (connection reset)'));
  });

  it('a failing stamp write leaves the report unwritten and records no rows (write-on-success is all-or-nothing)', async () => {
    mockFindMany.mockResolvedValue(readyRows());
    mockStorePut.mockRejectedValueOnce(new Error('store down'));
    const summary = await runDecisionGateReadinessOnce({ now: NOW });
    expect(summary).toBe('failed: store down');
    expect(mockStorePut).toHaveBeenCalledTimes(1); // the stamp attempt only
    expect(reportWrite()).toBeUndefined();
    expect(mockRecordLoopMetrics).not.toHaveBeenCalled();
  });

  it('DECISION_GATE_READINESS_WINDOW_DAYS sets the query window (clamped) and the stamp windowDays', async () => {
    process.env.DECISION_GATE_READINESS_WINDOW_DAYS = '3';
    await runDecisionGateReadinessOnce({ now: NOW });
    expect(mockFindMany.mock.calls[0][0].where.createdAt.gte).toEqual(new Date('2026-09-22T12:00:00Z'));
    expect((stampWrite()![2] as any).wake_triage.windowDays).toBe(3);
    expect((reportWrite()![2] as any).windowDays).toBe(3);
  });
});

describe('readinessMetricRow', () => {
  it('maps a stamp entry to the agreed meta shape with NaN metrics as null', () => {
    const row = readinessMetricRow('wake_triage', {
      ready: false, at: NOW.toISOString(), backend: 'DeepSeek logprob readout', reasons: ['a', 'b'], windowDays: 14, partition: 'q1',
      metrics: { n: 12, days: 1.5, accuracy: NaN, brier: NaN, ece: NaN, auroc: NaN, coverageAt5: { coverage: 0.25, threshold: 0.9, n: 3, errors: 0 }, actBand: { n: 2, correct: 2, precision: 1, lower95: 0.342, coverage: 0.1, threshold: 0.85 }, positives: 1, negatives: 11, deduped: 0, undedupable: 0, partitions: { q1: 12 }, partition: 'q1', suggestedThreshold: null, calls: 14, fails: 2, failRate: 2 / 14, p50Ms: 90, p95Ms: 410 },
    });
    expect(row).toEqual({
      kind: READINESS_METRIC_KIND, value: 0,
      meta: { purpose: 'wake_triage', backend: 'DeepSeek logprob readout', ready: false, labels: 12, spanDays: 1.5, auroc: null, coverage5: 0.25, bandN: 2, bandPrecision: 1, bandLower95: 0.342, calls: 14, fails: 2, failRate: 2 / 14, p50Ms: 90, p95Ms: 410, reasons: ['a', 'b'], windowDays: 14, partition: 'q1' },
    });
  });
});

/* 2026-09-26 (open-weight decision backends, plan D / E): one metric row per
 * REPORT ENTRY (purpose × backendSpec, with its role and the comparison
 * numbers), the stamp following the configured primary, and the temps autofit
 * written to the backends row after the stamp + report (kill-switched). */
describe('2026-09-26 — per-backend rows, the primary pin, the temps autofit', () => {
  const tempsWrite = () => mockStorePut.mock.calls.find(c => c[1] === BACKENDS_STORE_KEY);

  /** 60 labelled readout rows (logits) for wake_triage — enough for a ready fit (min 50). */
  function readoutRows(): ReadinessRow[] {
    const t0 = Date.parse('2026-09-20T00:00:00Z');
    const rows: ReadinessRow[] = [];
    for (let i = 0; i < 60; i++) {
      const at = new Date(t0 + i * 3_600_000);
      const actual = i % 3 === 0;
      rows.push({ meta: { phase: 'decision', id: `rd${i}`, purpose: 'wake_triage', backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', backendKind: 'logit', calibrated: false, logits: { needs_turn_now: actual ? { no: -2.3, yes: -0.1 } : { no: -0.1, yes: -2.3 } }, stateHash: `rdh${i}`, questionsHash: 'q1' }, createdAt: at, value: 650 + i });
      rows.push({ meta: { phase: 'outcome', id: `rd${i}`, purpose: 'wake_triage', question: 'needs_turn_now', actual, acted: false }, createdAt: at });
    }
    return rows;
  }

  it('DECISION_GATE_TEMP_AUTOFIT_ENABLED=1 (the opt-in): the query selects `value` (latency); the report carries the autofit result; the backends row gets ONLY the readout\'s fit (jev excluded) BEFORE the stamp + report (so the stamp never claims a calibration not in force); one metric row per entry with role / backendSpec / calls / p50', async () => {
    process.env.DECISION_GATE_TEMP_AUTOFIT_ENABLED = '1';
    mockFindMany.mockResolvedValue([...readyRows(), ...readoutRows()]);
    mockStoreGet.mockImplementation(async (_ns: string[], key: string) => (key === BACKENDS_STORE_KEY ? { purposes: { wake_triage: { challengers: ['laya:typed-decisions'] } }, temps: { 'old|x': 1.2 } } : null));
    const summary = await runDecisionGateReadinessOnce({ now: NOW, windowDays: 14, workerId: 'worker-test-2' });
    expect(mockFindMany.mock.calls[0][0].select).toEqual({ meta: true, createdAt: true, sessionId: true, value: true });
    // Write order: temps, stamp, report.
    expect(mockStorePut.mock.calls.map(c => c[1])).toEqual([BACKENDS_STORE_KEY, READINESS_STORE_KEY, READINESS_REPORT_STORE_KEY]);
    const stamp = stampWrite()![2] as Record<string, any>;
    expect(stamp.wake_triage).toMatchObject({ ready: true, backend: 'TypeSafe Jev', backendSpec: 'jev' }); // most rows (300 vs 60), no primary configured
    const report = reportWrite()![2] as Record<string, any>;
    expect(report.fits.map((f: any) => `${f.backendSpec}:${f.ready}:${f.autofit}`).sort()).toEqual(['deepseek-flash:true:true', 'jev:true:false']);
    expect(report.tempsChanged).toEqual(['deepseek-flash|wake_triage']);
    expect(report).toMatchObject({ tempsWritten: true, autofitEnabled: true });
    expect(report.tempsWriteError).toBeUndefined();
    expect(report.temps['old|x']).toBe(1.2);
    expect(report.temps['deepseek-flash|wake_triage']).toBeGreaterThan(0);
    expect(report.primaryByPurpose).toEqual({});
    const tw = tempsWrite()![2] as Record<string, any>;
    expect(tw.purposes).toEqual({ wake_triage: { challengers: ['laya:typed-decisions'] } }); // the row's other fields survive
    expect(tw.temps).toEqual({ 'old|x': 1.2, 'deepseek-flash|wake_triage': report.temps['deepseek-flash|wake_triage'] });
    expect(tw.tempsUpdatedBy).toBe('readiness-autofit');
    // The readout is CALIBRATED in the same pass (its fit is in the merged temps).
    const entries = report.entries as any[];
    const wt = entries.filter(e => e.purpose === 'wake_triage');
    expect(wt.map(e => `${e.backendSpec}:${e.role}:${e.calibrated}`)).toEqual(['jev:primary:true', 'deepseek-flash:fallback:true']);
    expect(wt[1].metrics).toMatchObject({ calls: 60, fails: 0, failRate: 0, p50Ms: 679, p95Ms: 706 }); // nearest rank over 650..709
    // One metric row per ENTRY: 23 empty purposes + wake_triage twice (jev + readout) = 25 rows — no longer one per purpose.
    const rows = mockRecordLoopMetrics.mock.calls[0][0] as any[];
    expect(rows).toHaveLength(25);
    expect(rows.filter(r => r.meta.purpose === 'wake_triage').map(r => `${r.meta.backendSpec}:${r.meta.role}`)).toEqual(['jev:primary', 'deepseek-flash:fallback']);
    const rd = rows.find(r => r.meta.backendSpec === 'deepseek-flash');
    expect(rd.meta).toMatchObject({ purpose: 'wake_triage', backend: 'DeepSeek logprob readout', kind: 'logit', calibrated: true, calls: 60, fails: 0, failRate: 0, p50Ms: 679, p95Ms: 706, labels: 60 });
    expect(rows.find(r => r.meta.purpose === 'imessage_send').meta).toMatchObject({ backend: 'none', backendSpec: 'none', role: 'primary', calls: 0 });
    expect(summary).toMatch(/temps fitted 1/);
  });

  it('DECISION_GATE_TEMP_AUTOFIT_DISABLED=1 (the hard kill switch, wins over ENABLED=1): the fits are reported (tempsWritten:false, temps unchanged in the store), no backends write; the summary names the switch', async () => {
    process.env.DECISION_GATE_TEMP_AUTOFIT_DISABLED = '1';
    process.env.DECISION_GATE_TEMP_AUTOFIT_ENABLED = '1';
    mockFindMany.mockResolvedValue([...readyRows(), ...readoutRows()]);
    const summary = await runDecisionGateReadinessOnce({ now: NOW, windowDays: 14 });
    expect(mockStorePut.mock.calls.map(c => c[1])).toEqual([READINESS_STORE_KEY, READINESS_REPORT_STORE_KEY]);
    const report = reportWrite()![2] as Record<string, any>;
    expect(report).toMatchObject({ tempsWritten: false, autofitEnabled: false, tempsChanged: [], temps: {} });
    expect(report.fits.find((f: any) => f.backendSpec === 'deepseek-flash')).toMatchObject({ ready: true, autofit: true });
    expect((report.entries as any[]).find(e => e.backendSpec === 'deepseek-flash').calibrated).toBe(false); // nothing merged → still uncalibrated
    expect(summary).toMatch(/autofit off \(1 ready fit\(s\) reported, not stored — DECISION_GATE_TEMP_AUTOFIT_DISABLED\)/);
  });

  it('DEFAULT — nothing set (review 2026-09-26: the autofit is OPT-IN): the fits are reported (autofit:true = would write) but never stored, the readout stays UNCALIBRATED in the entries and the metric rows, no backends write; the summary names the switch to set', async () => {
    mockFindMany.mockResolvedValue([...readyRows(), ...readoutRows()]);
    const summary = await runDecisionGateReadinessOnce({ now: NOW, windowDays: 14 });
    expect(mockStorePut.mock.calls.map(c => c[1])).toEqual([READINESS_STORE_KEY, READINESS_REPORT_STORE_KEY]);
    const report = reportWrite()![2] as Record<string, any>;
    expect(report).toMatchObject({ tempsWritten: false, autofitEnabled: false, tempsChanged: [], temps: {} });
    expect(report.fits.find((f: any) => f.backendSpec === 'deepseek-flash')).toMatchObject({ ready: true, autofit: true });
    expect((report.entries as any[]).find(e => e.backendSpec === 'deepseek-flash').calibrated).toBe(false);
    const rd = (mockRecordLoopMetrics.mock.calls[0][0] as any[]).find(r => r.meta.backendSpec === 'deepseek-flash');
    expect(rd.meta.calibrated).toBe(false);
    expect(summary).toMatch(/autofit off \(1 ready fit\(s\) reported, not stored — set DECISION_GATE_TEMP_AUTOFIT_ENABLED=1\)/);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('ENABLED=1 but the backends row READ fails: the temps write is skipped (never a blind read-modify-write), the artifacts are rebuilt WITHOUT the merge, the stamp + report still land (tempsWritten:false, tempsWriteError, the readout uncalibrated), the rows are recorded, the pass does not fail', async () => {
    process.env.DECISION_GATE_TEMP_AUTOFIT_ENABLED = '1';
    mockFindMany.mockResolvedValue([...readyRows(), ...readoutRows()]);
    mockStoreGet.mockImplementation(async (_ns: string[], key: string) => { if (key === BACKENDS_STORE_KEY) throw new Error('db blip'); return null; });
    const summary = await runDecisionGateReadinessOnce({ now: NOW, windowDays: 14 });
    expect(mockStorePut.mock.calls.map(c => c[1])).toEqual([READINESS_STORE_KEY, READINESS_REPORT_STORE_KEY]);
    const report = reportWrite()![2] as Record<string, any>;
    expect(report).toMatchObject({ tempsWritten: false, autofitEnabled: true, tempsChanged: ['deepseek-flash|wake_triage'], temps: {} });
    expect(report.tempsWriteError).toMatch(/backends row read failed \(db blip\)/);
    expect((report.entries as any[]).find(e => e.backendSpec === 'deepseek-flash').calibrated).toBe(false); // the merge was rolled back with the failed write
    expect((stampWrite()![2] as any).wake_triage).toMatchObject({ ready: true, backendSpec: 'jev' });
    expect(mockRecordLoopMetrics).toHaveBeenCalledTimes(1);
    expect((mockRecordLoopMetrics.mock.calls[0][0] as any[]).find(r => r.meta.backendSpec === 'deepseek-flash').meta.calibrated).toBe(false);
    expect(summary).toMatch(/^rows 720, purposes 24, ready 1 \(wake_triage\), stamped, temps write FAILED \(backends row read failed/);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('temps autofit write failed'));
  });

  it('rows of the admin Test button (purpose "probe") never become a stamp key, a report entry or a metric row (review 2026-09-26)', async () => {
    mockFindMany.mockResolvedValue([
      ...readyRows(),
      decisionRow('p1', 'probe', 'laya (systemone)', { refund: { noul: 0.9 }, team: { choice: 'billing', confidence: 0.8 } }, { backendSpec: 'laya:typed-decisions', backendKind: 'systemone', ok: true, calibrated: false }, '2026-09-25T10:00:00Z'),
    ]);
    await runDecisionGateReadinessOnce({ now: NOW, windowDays: 14, primaryByPurpose: { probe: 'laya:typed-decisions' } });
    const stamp = stampWrite()![2] as Record<string, any>;
    expect(Object.keys(stamp)).toHaveLength(24);
    expect(stamp.probe).toBeUndefined();
    const report = reportWrite()![2] as Record<string, any>;
    expect((report.entries as any[]).some(e => e.purpose === 'probe' || e.backendSpec === 'laya:typed-decisions')).toBe(false);
    const rows = mockRecordLoopMetrics.mock.calls[0][0] as any[];
    expect(rows).toHaveLength(24);
    expect(rows.some(r => r.meta.purpose === 'probe')).toBe(false);
  });

  it('the configured primary (opts.primaryByPurpose, else the resolver registered in decision-gate-modes) drives the stamp + the roles; a failing resolver is fail-open', async () => {
    mockFindMany.mockResolvedValue([...readyRows(), ...readoutRows()]);
    await runDecisionGateReadinessOnce({ now: NOW, windowDays: 14, primaryByPurpose: { wake_triage: 'deepseek-flash' } });
    expect((stampWrite()![2] as any).wake_triage).toMatchObject({ backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', ready: false });
    expect((reportWrite()![2] as any).primaryByPurpose).toEqual({ wake_triage: 'deepseek-flash' });
    expect((mockRecordLoopMetrics.mock.calls[0][0] as any[]).filter(r => r.meta.purpose === 'wake_triage').map(r => `${r.meta.backendSpec}:${r.meta.role}`)).toEqual(['deepseek-flash:primary', 'jev:fallback']);
    // The registered resolver (the backends module's seam).
    mockStorePut.mockClear(); mockRecordLoopMetrics.mockClear();
    setDecisionPrimaryResolver(async (p) => (p === 'wake_triage' ? 'jev' : p === 'self_audit' ? 'laya:typed-decisions' : undefined));
    await runDecisionGateReadinessOnce({ now: NOW, windowDays: 14 });
    expect((stampWrite()![2] as any).wake_triage.backendSpec).toBe('jev');
    expect((reportWrite()![2] as any).primaryByPurpose).toEqual({ wake_triage: 'jev', self_audit: 'laya:typed-decisions' });
    // A primary with no rows: the stamp falls back to the most rows; the empty entry is not the primary.
    expect((stampWrite()![2] as any).self_audit).toMatchObject({ backend: 'none' });
    expect((mockRecordLoopMetrics.mock.calls[0][0] as any[]).find(r => r.meta.purpose === 'self_audit').meta.role).toBe('fallback');
    mockStorePut.mockClear();
    setDecisionPrimaryResolver(() => { throw new Error('resolver down'); });
    const summary = await runDecisionGateReadinessOnce({ now: NOW, windowDays: 14 });
    expect(summary).toMatch(/^rows /);
    expect((reportWrite()![2] as any).primaryByPurpose).toEqual({});
  });

  it('readinessMetricRowsForEntries: primary first, then challengers, then fallbacks by labels; entries without the E numbers emit no calls keys', () => {
    const m = (n: number): any => ({ n, days: 1, accuracy: 1, brier: 0, ece: 0, auroc: 1, coverageAt5: { coverage: 1, threshold: 0.9, n, errors: 0 }, actBand: { n, correct: n, precision: 1, lower95: 0.9, coverage: 1, threshold: 0.85 }, positives: 1, negatives: 0, deduped: 0, undedupable: 0, partitions: {}, partition: '', suggestedThreshold: null });
    const rows = readinessMetricRowsForEntries([
      { purpose: 'wake_triage', backend: 'b', backendSpec: 'deepseek-flash', calibrated: false, metrics: { ...m(5), calls: 5, fails: 1, failRate: 0.2, p50Ms: 10, p95Ms: 20 }, ready: false, reasons: [], role: 'fallback' },
      { purpose: 'wake_triage', backend: 'c', backendSpec: 'laya:typed-decisions', calibrated: false, metrics: { ...m(9), calls: 9, fails: 0, failRate: 0, p50Ms: 1, p95Ms: 2 }, ready: false, reasons: [], role: 'challenger' },
      { purpose: 'wake_triage', backend: 'a', backendSpec: 'jev', calibrated: true, metrics: m(2), ready: true, reasons: [], role: 'primary' },
      { purpose: 'auto_route', backend: 'a', backendSpec: 'jev', calibrated: true, metrics: m(1), ready: false, reasons: ['x'], role: 'primary' },
    ], 14, new Date('2026-09-26T06:00:00Z'));
    expect(rows.map(r => `${r.meta!.purpose}/${r.meta!.backendSpec}/${r.meta!.role}`)).toEqual(['auto_route/jev/primary', 'wake_triage/jev/primary', 'wake_triage/laya:typed-decisions/challenger', 'wake_triage/deepseek-flash/fallback']);
    expect(rows[1].meta).not.toHaveProperty('calls');
    expect(rows[3].meta).toMatchObject({ calls: 5, fails: 1, failRate: 0.2, p50Ms: 10, p95Ms: 20, calibrated: false });
    expect(rows[1].value).toBe(1);
  });
});

describe('Laya follow-up (2026-09-26) — the sampled-state prune rides the readiness pass', () => {
  it('every pass deletes decision_gate_state rows older than DECISION_GATE_STATE_RETENTION_DAYS (default 28) with ONE indexed deleteMany; a non-zero count lands in the summary', async () => {
    mockFindMany.mockResolvedValue(readyRows());
    mockDeleteMany.mockResolvedValue({ count: 12 });
    const summary = await runDecisionGateReadinessOnce({ now: NOW, windowDays: 14, workerId: 'w' });
    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    expect(mockDeleteMany.mock.calls[0][0]).toEqual({ where: { kind: DECISION_GATE_STATE_KIND, createdAt: { lt: new Date(NOW.getTime() - 28 * 86_400_000) } } });
    expect(summary).toMatch(/, pruned 12 state rows$/);
    // The readiness query itself is unchanged (still exactly one findMany).
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(stampWrite()).toBeDefined();
  });

  it('DECISION_GATE_STATE_RETENTION_DAYS sets the cutoff (clamped 1..365); a failing delete is logged and never fails the pass', async () => {
    process.env.DECISION_GATE_STATE_RETENTION_DAYS = '7';
    expect(stateRetentionDays()).toBe(7);
    process.env.DECISION_GATE_STATE_RETENTION_DAYS = '9999';
    expect(stateRetentionDays()).toBe(365);
    process.env.DECISION_GATE_STATE_RETENTION_DAYS = 'x';
    expect(stateRetentionDays()).toBe(28);
    process.env.DECISION_GATE_STATE_RETENTION_DAYS = '7';
    expect(await pruneDecisionGateStateRows(NOW)).toBe(0);
    expect(mockDeleteMany.mock.calls[0][0].where.createdAt.lt).toEqual(new Date(NOW.getTime() - 7 * 86_400_000));
    mockDeleteMany.mockRejectedValueOnce(new Error('lock timeout'));
    mockFindMany.mockResolvedValue(readyRows());
    const summary = await runDecisionGateReadinessOnce({ now: NOW, windowDays: 14, workerId: 'w' });
    expect(summary).toMatch(/^rows 600, purposes 24, ready 1 \(wake_triage\), stamped, 14 d window, \d+ ms$/);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sampled-state prune failed'));
    expect(stampWrite()).toBeDefined();
  });

  it('a disabled job prunes nothing', async () => {
    process.env.DECISION_GATE_READINESS_JOB_DISABLED = '1';
    await runDecisionGateReadinessOnce({ now: NOW });
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});

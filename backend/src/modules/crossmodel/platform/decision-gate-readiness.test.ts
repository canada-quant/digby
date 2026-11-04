/**
 * decision-gate-readiness.ts — the flip-readiness STAMP (E1, 2026-09-25):
 * report → per-purpose stamp (most-rows backend wins), the store write + its
 * kill switch, fail-closed reads, and the admin view.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockStoreGet = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockStorePut = jest.fn(async (..._a: any[]): Promise<void> => undefined);
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));

import { ACT_POLICIES, type ReadinessEntry, type ReadinessMetrics, type ReadinessRow } from './decision-gate-fit';
import {
  READINESS_JOB_ID, READINESS_REPORT_STORE_KEY, READINESS_STORE_KEY, READINESS_STORE_NS,
  buildReadinessArtifacts, getDecisionReadinessView, isPurposeStampedReady, normalizeReadinessStamp, readReadinessStamp, readinessIntervalMin, readinessIntervalSec,
  readinessJobDisabled, readinessStampFromReport, readinessWindowDays, writeReadinessStamp,
  // 2026-09-26 — open-weight decision backends (plan D / E + the temps autofit)
  BACKENDS_STORE_KEY, TEMP_AUTOFIT_EXCLUDED_SPECS, assignReadinessRoles, mergeAutofitTemps, normalizeStoredTemps, readStoredBackendTemps, tempAutofitDisabled, tempAutofitEnabled, writeStoredBackendTemps,
} from './decision-gate-readiness';

const metrics = (n: number): ReadinessMetrics => ({
  n, days: 4, accuracy: 0.9, brier: 0.1, ece: 0.05, auroc: 0.85,
  coverageAt5: { coverage: 0.7, threshold: 0.8, n: Math.round(n * 0.7), errors: 1 },
  actBand: { n: 40, correct: 38, precision: 0.95, lower95: 0.835, coverage: 0.4, threshold: 0.85 },
  positives: 10, negatives: n - 10, deduped: 3, undedupable: 0, partitions: { h1: n }, partition: 'h1', suggestedThreshold: null,
  calls: n, fails: 0, failRate: 0, p50Ms: 120, p95Ms: 300,
});

/** A report entry; `backendSpec` defaults to the built-in label's spec (2026-09-26), so the pre-change fixtures read as the built-ins. */
const entry = (purpose: string, backend: string, n: number, ready: boolean, extra: Partial<ReadinessEntry> = {}): ReadinessEntry => ({
  purpose, backend, backendSpec: backend === 'TypeSafe Jev' ? 'jev' : backend === 'DeepSeek logprob readout' ? 'deepseek-flash' : backend,
  calibrated: true, metrics: metrics(n), ready, reasons: ready ? [] : ['labels too few'], ...extra,
});

beforeEach(() => {
  mockStoreGet.mockReset();
  mockStoreGet.mockResolvedValue(null);
  mockStorePut.mockReset();
});

describe('readinessStampFromReport', () => {
  it('one entry per purpose — the backend with the MOST labelled rows decides the verdict', () => {
    const at = new Date('2026-09-25T20:00:00Z');
    const stamp = readinessStampFromReport([
      entry('wake_triage', 'DeepSeek logprob readout', 400, true),   // more rows but…
      entry('wake_triage', 'TypeSafe Jev', 30, false),
      entry('imessage_send', 'TypeSafe Jev', 45, false),
    ], at, 14);
    expect(Object.keys(stamp).sort()).toEqual(['imessage_send', 'wake_triage']);
    expect(stamp.wake_triage).toMatchObject({ ready: true, backend: 'DeepSeek logprob readout', at: at.toISOString(), windowDays: 14, partition: 'h1', reasons: [] });
    expect(stamp.imessage_send).toMatchObject({ ready: false, backend: 'TypeSafe Jev', reasons: ['labels too few'] });
    expect(stamp.wake_triage.metrics.n).toBe(400);
  });

  it('budgets-cost-6 (2026-09-26): the stamp carries per-purpose `health` — the degradation counters SUMMED over the purpose\'s non-challenger backends (the stamped Jev entry alone would hide the readout\'s downgraded asks); normalizeReadinessStamp keeps a well-formed health and drops a malformed one', () => {
    const at = new Date('2026-09-26T18:00:00Z');
    const stamp = readinessStampFromReport([
      entry('sweep_triage', 'TypeSafe Jev', 60, true, { metrics: { ...metrics(60), calls: 80, fails: 20, downgraded: 0, fellThrough: 0, latched: 12 } }),
      entry('sweep_triage', 'DeepSeek logprob readout', 5, false, { metrics: { ...metrics(5), calls: 20, fails: 1, downgraded: 4, fellThrough: 19, latched: 0 } }),
      // A challenger's numbers never enter the purpose's health.
      entry('sweep_triage', 'laya (systemone)', 3, false, { role: 'challenger', metrics: { ...metrics(3), calls: 90, fails: 40, downgraded: 9, fellThrough: 9, latched: 9 } }),
      // Pre-change metrics (no counters) → health still present with the counters read as 0.
      entry('wake_triage', 'TypeSafe Jev', 30, false),
    ], at, 14, { sweep_triage: 'jev' });
    expect(stamp.sweep_triage).toMatchObject({ backend: 'TypeSafe Jev', health: { calls: 100, fails: 21, downgraded: 4, fellThrough: 19, latched: 12 } });
    expect(stamp.wake_triage.health).toEqual({ calls: 30, fails: 0, downgraded: 0, fellThrough: 0, latched: 0 });
    const norm = normalizeReadinessStamp({
      sweep_triage: { ready: true, at: at.toISOString(), metrics: metrics(5), health: { calls: 100, fails: 21, downgraded: 4, fellThrough: 19, latched: 12 } },
      wake_triage: { ready: true, at: at.toISOString(), metrics: metrics(5), health: { calls: 'x' } },
      auto_route: { ready: true, at: at.toISOString(), metrics: metrics(5) },
    });
    expect(norm.sweep_triage.health).toEqual({ calls: 100, fails: 21, downgraded: 4, fellThrough: 19, latched: 12 });
    expect(norm.wake_triage.health).toBeUndefined();
    expect(norm.auto_route.health).toBeUndefined();
  });
});

describe('normalizeReadinessStamp', () => {
  it('keeps well-formed purpose entries only and fills defaults', () => {
    const out = normalizeReadinessStamp({
      wake_triage: { ready: true, at: '2026-09-25T00:00:00Z', metrics: metrics(5) },
      junk: 'no', bad: { ready: 'yes' }, alsoBad: { ready: true, at: 1, metrics: {} },
      // Well-formed but NOT an ACT_POLICIES purpose (the admin Test button's rows) — dropped (review 2026-09-26).
      probe: { ready: true, at: '2026-09-25T00:00:00Z', metrics: metrics(5), backend: 'laya (systemone)' },
    });
    expect(Object.keys(out)).toEqual(['wake_triage']);
    expect(out.wake_triage).toMatchObject({ ready: true, backend: 'unknown', reasons: [], windowDays: 0, partition: '' });
    expect(normalizeReadinessStamp(null)).toEqual({});
    expect(normalizeReadinessStamp('x')).toEqual({});
  });
});

describe('store write / read', () => {
  it('writeReadinessStamp puts the normalised stamp under instance:decision-gate/readiness (purpose keys only)', async () => {
    const stamp = readinessStampFromReport([entry('self_audit', 'TypeSafe Jev', 12, false)], new Date('2026-09-25T21:00:00Z'), 7);
    await writeReadinessStamp(stamp);
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    const [ns, key, value] = mockStorePut.mock.calls[0];
    expect(ns).toEqual(READINESS_STORE_NS);
    expect(key).toBe(READINESS_STORE_KEY);
    expect(Object.keys(value)).toEqual(['self_audit']);
    expect(value.self_audit).toMatchObject({ ready: false, at: '2026-09-25T21:00:00.000Z', backend: 'TypeSafe Jev', windowDays: 7 });
  });

  it('readReadinessStamp: null when nothing is stored; normalised entries otherwise; null (logged) on a store error', async () => {
    expect(await readReadinessStamp()).toBeNull();
    mockStoreGet.mockResolvedValue({ wake_triage: { ready: true, at: '2026-09-25T00:00:00Z', metrics: metrics(300), backend: 'TypeSafe Jev', reasons: [], windowDays: 14, partition: '' }, nope: 1 });
    const stamp = await readReadinessStamp();
    expect(Object.keys(stamp!)).toEqual(['wake_triage']);
    mockStoreGet.mockRejectedValue(new Error('db down'));
    expect(await readReadinessStamp()).toBeNull();
  });

  it('isPurposeStampedReady fails CLOSED: missing stamp, unknown purpose, not-ready entry and store errors are all false', async () => {
    expect(await isPurposeStampedReady('wake_triage')).toBe(false);
    mockStoreGet.mockResolvedValue({ wake_triage: { ready: false, at: 'x', metrics: metrics(1) }, imessage_send: { ready: true, at: 'x', metrics: metrics(1) } });
    expect(await isPurposeStampedReady('wake_triage')).toBe(false);
    expect(await isPurposeStampedReady('imessage_send')).toBe(true);
    expect(await isPurposeStampedReady('auto_route')).toBe(false);
    mockStoreGet.mockRejectedValue(new Error('db down'));
    expect(await isPurposeStampedReady('imessage_send')).toBe(false);
  });

  it('getDecisionReadinessView carries the stamp, the newest at, the bars, stampDisabled:false and the how-to', async () => {
    const empty = await getDecisionReadinessView();
    expect(empty).toMatchObject({ purposes: null, stampedAt: null, stampDisabled: false });
    expect(empty.bars.minLabels).toBe(200);
    expect(empty.howTo).toContain('--stamp');
    mockStoreGet.mockResolvedValue({
      wake_triage: { ready: false, at: '2026-09-25T10:00:00.000Z', metrics: metrics(20) },
      self_audit: { ready: false, at: '2026-09-25T12:00:00.000Z', metrics: metrics(9) },
    });
    const view = await getDecisionReadinessView();
    expect(view.stampedAt).toBe('2026-09-25T12:00:00.000Z');
    expect(Object.keys(view.purposes!).sort()).toEqual(['self_audit', 'wake_triage']);
    expect(view.stampDisabled).toBe(false);
  });

  it('getDecisionReadinessView returns the worker job\'s latest STORED report (computedAt) and the job config — never a recompute', async () => {
    const storedReport = {
      computedAt: '2026-09-25T18:00:00.000Z', windowDays: 14, rows: 1234, durationMs: 80, stampWritten: true, workerId: 'worker-a-1',
      entries: [entry('wake_triage', 'TypeSafe Jev', 300, true)], fits: [],
    };
    mockStoreGet.mockImplementation(async (_ns: string[], key: string) => (key === READINESS_REPORT_STORE_KEY ? storedReport : key === READINESS_STORE_KEY ? { wake_triage: { ready: true, at: '2026-09-25T18:00:00.000Z', metrics: metrics(300) } } : null));
    const view = await getDecisionReadinessView();
    expect(view.computedAt).toBe('2026-09-25T18:00:00.000Z');
    expect(view.report).toMatchObject({ computedAt: '2026-09-25T18:00:00.000Z', rows: 1234, stampWritten: true, workerId: 'worker-a-1' });
    expect(view.report!.entries).toHaveLength(1);
    expect(view.job).toEqual({ id: READINESS_JOB_ID, intervalMin: 360, windowDays: 14, disabled: false });
    expect(view.howTo).toContain(READINESS_JOB_ID);
    expect(view.howTo).toContain('node dist/scripts/decision-gate-fit-temperature.js');
    // Both keys were READ; nothing was written.
    expect(mockStoreGet.mock.calls.map(c => c[1]).sort()).toEqual([READINESS_STORE_KEY, READINESS_REPORT_STORE_KEY].sort());
    expect(mockStorePut).not.toHaveBeenCalled();
    // A malformed / missing report → null computedAt (the job has not run).
    mockStoreGet.mockImplementation(async (_ns: string[], key: string) => (key === READINESS_REPORT_STORE_KEY ? { junk: true } : null));
    const none = await getDecisionReadinessView();
    expect(none.computedAt).toBeNull();
    expect(none.report).toBeNull();
    // A store error on the report read is logged and fail-open (null), never thrown.
    mockStoreGet.mockRejectedValue(new Error('db down'));
    expect((await getDecisionReadinessView()).computedAt).toBeNull();
  });
});

describe('job knobs (worker registration reads these)', () => {
  it('DECISION_GATE_READINESS_INTERVAL_MIN: default 360, clamped 15..10080, garbage → default; seconds for cron_jobs', () => {
    expect(readinessIntervalMin({})).toBe(360);
    expect(readinessIntervalSec({})).toBe(21600);
    expect(readinessIntervalMin({ DECISION_GATE_READINESS_INTERVAL_MIN: '60' })).toBe(60);
    expect(readinessIntervalMin({ DECISION_GATE_READINESS_INTERVAL_MIN: '1' })).toBe(15);
    expect(readinessIntervalMin({ DECISION_GATE_READINESS_INTERVAL_MIN: '999999' })).toBe(10080);
    expect(readinessIntervalMin({ DECISION_GATE_READINESS_INTERVAL_MIN: 'soon' })).toBe(360);
    expect(readinessIntervalMin({ DECISION_GATE_READINESS_INTERVAL_MIN: '-5' })).toBe(360);
  });

  it('DECISION_GATE_READINESS_WINDOW_DAYS: default 14, clamped 1..90; DECISION_GATE_READINESS_JOB_DISABLED honours 1/true/on', () => {
    expect(readinessWindowDays({})).toBe(14);
    expect(readinessWindowDays({ DECISION_GATE_READINESS_WINDOW_DAYS: '7' })).toBe(7);
    expect(readinessWindowDays({ DECISION_GATE_READINESS_WINDOW_DAYS: '0' })).toBe(14);
    expect(readinessWindowDays({ DECISION_GATE_READINESS_WINDOW_DAYS: '400' })).toBe(90);
    expect(readinessJobDisabled({})).toBe(false);
    expect(readinessJobDisabled({ DECISION_GATE_READINESS_JOB_DISABLED: '1' })).toBe(true);
    expect(readinessJobDisabled({ DECISION_GATE_READINESS_JOB_DISABLED: 'true' })).toBe(true);
    expect(readinessJobDisabled({ DECISION_GATE_READINESS_JOB_DISABLED: '0' })).toBe(false);
  });

  it('buildReadinessArtifacts: one builder for the job and the CLI — every ACT_POLICIES purpose stamped, a labelled group READY only when every bar holds', () => {
    const at = new Date('2026-09-25T20:00:00Z');
    const art = buildReadinessArtifacts([], { days: 14, now: at });
    expect(Object.keys(art.stamp).sort()).toEqual(Object.keys(ACT_POLICIES).sort());
    expect(art.entries.every(e => e.backend === 'none' && !e.ready && !e.calibrated && e.reasons[0] === 'no labelled outcomes in the window')).toBe(true);
    expect(art.entries.every(e => e.metrics.n === 0 && e.metrics.partition === '')).toBe(true);
    expect(art.fits).toEqual([]);
    expect(art.stamp.wake_triage).toMatchObject({ ready: false, backend: 'none', at: at.toISOString(), windowDays: 14, partition: '' });
    // The empty entry is JSON-safe for the store (NaN → null) and normalizes back as a valid entry.
    const roundTrip = normalizeReadinessStamp(JSON.parse(JSON.stringify(art.stamp)));
    expect(Object.keys(roundTrip)).toHaveLength(Object.keys(ACT_POLICIES).length);
    // A single-purpose build adds no empties.
    expect(buildReadinessArtifacts([], { days: 14, purpose: 'wake_triage' })).toEqual({ entries: [], stamp: {}, fits: [], temps: {}, tempsChanged: [] });
  });
});

/* 2026-09-26 (open-weight decision backends, plan D / E): the stamp follows the
 * CONFIGURED primary when the job knows it (else the most labelled rows,
 * challengers excluded) and carries backendSpec; every entry gets a role; the
 * readiness job AUTOFITS one temperature per (backend, purpose) into the
 * backends row's `temps` (the built-in jev excluded) and judges calibration
 * with the merged map in the same pass. */
describe('2026-09-26 — stamp follows the primary, roles, the temps autofit', () => {
  const AUTOFIT_ENVS = ['DECISION_GATE_TEMP_AUTOFIT_DISABLED', 'DECISION_GATE_TEMP_AUTOFIT_ENABLED'] as const;
  const savedAutofit: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of AUTOFIT_ENVS) { savedAutofit[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of AUTOFIT_ENVS) { if (savedAutofit[k] === undefined) delete process.env[k]; else process.env[k] = savedAutofit[k]; } });

  it('readinessStampFromReport: the configured primary\'s entry when given and present (even with fewer rows / NOT READY); else the most labelled rows with challengers excluded; the stamp carries backendSpec', () => {
    const at = new Date('2026-09-26T06:00:00Z');
    const report = [
      entry('wake_triage', 'TypeSafe Jev', 30, false),
      entry('wake_triage', 'DeepSeek logprob readout', 400, true),
      entry('wake_triage', 'laya (systemone)', 500, true, { backendSpec: 'laya:typed-decisions', role: 'challenger' }),
      entry('imessage_send', 'TypeSafe Jev', 45, false),
      entry('probe', 'laya (systemone)', 0, false, { backendSpec: 'laya:typed-decisions' }), // the admin Test button's purpose — never a stamp key (review 2026-09-26)
    ];
    const byRows = readinessStampFromReport(report, at, 14);
    expect(Object.keys(byRows).sort()).toEqual(['imessage_send', 'wake_triage']);
    expect(Object.keys(readinessStampFromReport(report, at, 14, { probe: 'laya:typed-decisions' })).sort()).toEqual(['imessage_send', 'wake_triage']); // not even as a configured primary
    expect(byRows.wake_triage).toMatchObject({ ready: true, backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash' }); // the 500-row challenger never wins
    expect(byRows.imessage_send).toMatchObject({ ready: false, backend: 'TypeSafe Jev', backendSpec: 'jev' });
    const pinned = readinessStampFromReport(report, at, 14, { wake_triage: 'jev' });
    expect(pinned.wake_triage).toMatchObject({ ready: false, backend: 'TypeSafe Jev', backendSpec: 'jev', reasons: ['labels too few'] });
    expect(pinned.wake_triage.metrics.n).toBe(30);
    // A configured primary with NO rows in the window falls back to the most-rows rule.
    expect(readinessStampFromReport(report, at, 14, { wake_triage: 'jevk5:4b' }).wake_triage.backendSpec).toBe('deepseek-flash');
    // A primary for one purpose never touches another.
    expect(readinessStampFromReport(report, at, 14, { imessage_send: 'jev' }).wake_triage.backendSpec).toBe('deepseek-flash');
    // Round trip: normalizeReadinessStamp keeps backendSpec.
    expect(normalizeReadinessStamp(JSON.parse(JSON.stringify(pinned))).wake_triage.backendSpec).toBe('jev');
    expect(normalizeReadinessStamp({ wake_triage: { ready: true, at: at.toISOString(), metrics: {} } }).wake_triage.backendSpec).toBeUndefined();
  });

  it('assignReadinessRoles: challenger rows keep their role; with a configured primary the matching spec is primary and the rest fallback; without one the STAMPED entry is primary', () => {
    const at = new Date('2026-09-26T06:00:00Z');
    const report = [
      entry('wake_triage', 'TypeSafe Jev', 30, false),
      entry('wake_triage', 'DeepSeek logprob readout', 400, true),
      entry('wake_triage', 'laya (systemone)', 500, true, { backendSpec: 'laya:typed-decisions', role: 'challenger' }),
    ];
    const stamp = readinessStampFromReport(report, at, 14);
    expect(assignReadinessRoles(report, stamp).map(e => `${e.backendSpec}:${e.role}`)).toEqual(['jev:fallback', 'deepseek-flash:primary', 'laya:typed-decisions:challenger']);
    const pinnedStamp = readinessStampFromReport(report, at, 14, { wake_triage: 'jev' });
    expect(assignReadinessRoles(report, pinnedStamp, { wake_triage: 'jev' }).map(e => `${e.backendSpec}:${e.role}`)).toEqual(['jev:primary', 'deepseek-flash:fallback', 'laya:typed-decisions:challenger']);
    // A configured primary that has no entry: nothing is primary (the stamp fell back, but the configured pin still names the truth).
    expect(assignReadinessRoles(report, readinessStampFromReport(report, at, 14, { wake_triage: 'jevk5:4b' }), { wake_triage: 'jevk5:4b' }).map(e => e.role)).toEqual(['fallback', 'fallback', 'challenger']);
    // Review 2026-09-26: the CONFIGURED primary wins over the challenger flag — after a promotion the new primary's
    // group still carries challenger-era rows (its entry may say role 'challenger' from the bare report) for the rest
    // of the window; the stamp follows the configured spec and the role agrees with it. The demoted backend reads as
    // the challenger only through its own newest row (buildReadinessReport), never through the stamp.
    const promoted = readinessStampFromReport(report, at, 14, { wake_triage: 'laya:typed-decisions' });
    expect(promoted.wake_triage).toMatchObject({ backendSpec: 'laya:typed-decisions', ready: true });
    expect(assignReadinessRoles(report, promoted, { wake_triage: 'laya:typed-decisions' }).map(e => `${e.backendSpec}:${e.role}`)).toEqual(['jev:fallback', 'deepseek-flash:fallback', 'laya:typed-decisions:primary']);
  });

  it('mergeAutofitTemps / normalizeStoredTemps / tempAutofitDisabled: only ready, non-excluded fits move a key; the input map is preserved; the built-in jev is excluded', () => {
    expect(TEMP_AUTOFIT_EXCLUDED_SPECS.has('jev')).toBe(true);
    const fit = (backendSpec: string, purpose: string, temperature: number, autofit: boolean) => ({
      backend: backendSpec, backendSpec, purpose, n: 60, temperature, nllAt1: 1, nllAtT: 0.5, brierAt1: 0.3, brierAtT: 0.2, eceAt1: 0.4, eceAtT: 0.1, accuracy: 0.9, skipped: 0,
      ready: autofit, envLine: `DECISION_GATE_TEMP_${purpose.toUpperCase()}=${temperature}`, storeKey: `${backendSpec}|${purpose}`, autofit,
    });
    const merged = mergeAutofitTemps({ 'old|x': 1.2, 'deepseek-flash|wake_triage': 2.1 }, [fit('deepseek-flash', 'wake_triage', 2.1, true), fit('laya:typed-decisions', 'wake_triage', 1.7, true), fit('jev', 'wake_triage', 1.3, false), fit('vllm:q', 'auto_route', 3, false)]);
    expect(merged.temps).toEqual({ 'old|x': 1.2, 'deepseek-flash|wake_triage': 2.1, 'laya:typed-decisions|wake_triage': 1.7 });
    expect(merged.changed).toEqual(['laya:typed-decisions|wake_triage']); // an unchanged value is not a change
    expect(normalizeStoredTemps({ temps: { 'a|b': '1.5', 'c|d': -1, bad: 2, 'e|f': 'x' } })).toEqual({ 'a|b': 1.5 });
    expect(normalizeStoredTemps({ temps: [1] })).toEqual({});
    expect(tempAutofitDisabled({ DECISION_GATE_TEMP_AUTOFIT_DISABLED: '1' })).toBe(true);
    expect(tempAutofitDisabled({})).toBe(false);
    // The autofit is OPT-IN (review 2026-09-26): unset = off; ENABLED turns it on; DISABLED wins over ENABLED.
    expect(tempAutofitEnabled({})).toBe(false);
    expect(tempAutofitEnabled({ DECISION_GATE_TEMP_AUTOFIT_ENABLED: '1' })).toBe(true);
    expect(tempAutofitEnabled({ DECISION_GATE_TEMP_AUTOFIT_ENABLED: 'true', DECISION_GATE_TEMP_AUTOFIT_DISABLED: '1' })).toBe(false);
  });

  /** n readout rows (logits) + n Laya systemone rows (answers) + n Jev rows, all labelled, for one purpose. */
  function fittableRows(n: number, purpose = 'wake_triage', question = 'needs_turn_now'): ReadinessRow[] {
    const t0 = Date.parse('2026-09-20T00:00:00Z');
    const rows: ReadinessRow[] = [];
    for (let i = 0; i < n; i++) {
      const at = new Date(t0 + i * 3_600_000);
      const actual = i % 4 === 0;
      const noul = actual ? 0.9 : 0.1;
      rows.push({ meta: { phase: 'decision', id: `r${i}`, purpose, backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', backendKind: 'logit', calibrated: false, logits: { [question]: actual ? { no: -2.3, yes: -0.1 } : { no: -0.1, yes: -2.3 } }, stateHash: `rh${i}`, questionsHash: 'q1' }, createdAt: at, value: 700 });
      rows.push({ meta: { phase: 'outcome', id: `r${i}`, purpose, question, actual, acted: false }, createdAt: at });
      rows.push({ meta: { phase: 'decision', id: `l${i}`, purpose, backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions', backendKind: 'systemone', calibrated: false, answers: { [question]: { noul } }, stateHash: `lh${i}`, questionsHash: 'q1' }, createdAt: at, value: 40 });
      rows.push({ meta: { phase: 'outcome', id: `l${i}`, purpose, question, actual, acted: false }, createdAt: at });
      rows.push({ meta: { phase: 'decision', id: `j${i}`, purpose, backend: 'TypeSafe Jev', backendSpec: 'jev', backendKind: 'systemone', calibrated: true, answers: { [question]: { noul } }, stateHash: `jh${i}`, questionsHash: 'q1' }, createdAt: at, value: 300 });
      rows.push({ meta: { phase: 'outcome', id: `j${i}`, purpose, question, actual, acted: false }, createdAt: at });
    }
    // Five extra Jev labels so Jev is unambiguously the most-rows backend (no tie-break by fixture order).
    for (let i = 0; i < 5; i++) {
      const at = new Date(t0 + (n + i) * 3_600_000);
      rows.push({ meta: { phase: 'decision', id: `jx${i}`, purpose, backend: 'TypeSafe Jev', backendSpec: 'jev', backendKind: 'systemone', calibrated: true, answers: { [question]: { noul: 0.1 } }, stateHash: `jxh${i}`, questionsHash: 'q1' }, createdAt: at, value: 300 });
      rows.push({ meta: { phase: 'outcome', id: `jx${i}`, purpose, question, actual: false, acted: false }, createdAt: at });
    }
    return rows;
  }

  it('buildReadinessArtifacts: with autofit:true (the opt-in) every ready non-jev fit merges into `temps` (input keys preserved), names tempsChanged, and the fitted backends are judged CALIBRATED in the same pass; the DEFAULT is OFF and leaves temps as given; roles + the E numbers ride the entries; primaryByPurpose drives the stamp', () => {
    const at = new Date('2026-09-26T06:00:00Z');
    const rows = fittableRows(60);
    const art = buildReadinessArtifacts(rows, { days: 14, now: at, temps: { 'old|x': 1.1 }, autofit: true });
    expect(art.fits.map(f => `${f.backendSpec}:${f.n}:${f.ready}:${f.autofit}`).sort()).toEqual(['deepseek-flash:60:true:true', 'jev:65:true:false', 'laya:typed-decisions:60:true:true']);
    expect(Object.keys(art.temps).sort()).toEqual(['deepseek-flash|wake_triage', 'laya:typed-decisions|wake_triage', 'old|x']);
    expect(art.tempsChanged.sort()).toEqual(['deepseek-flash|wake_triage', 'laya:typed-decisions|wake_triage']);
    expect(art.temps['old|x']).toBe(1.1);
    const wt = art.entries.filter(e => e.purpose === 'wake_triage');
    expect(wt.map(e => `${e.backendSpec}:${e.calibrated}:${e.role}:${e.metrics.calls}:${e.metrics.p50Ms}`).sort()).toEqual(['deepseek-flash:true:fallback:60:700', 'jev:true:primary:65:300', 'laya:typed-decisions:true:fallback:60:40']);
    expect(art.stamp.wake_triage).toMatchObject({ backend: 'TypeSafe Jev', backendSpec: 'jev' }); // the most labelled rows (65) — no primary configured
    // No autofit — the DEFAULT (opt-in, review 2026-09-26): the input temps stand and the un-fitted backends stay uncalibrated, exactly as the runtime judges them.
    const off = buildReadinessArtifacts(rows, { days: 14, now: at, temps: { 'old|x': 1.1 } });
    expect(buildReadinessArtifacts(rows, { days: 14, now: at, temps: { 'old|x': 1.1 }, autofit: false })).toEqual(off);
    expect(off.temps).toEqual({ 'old|x': 1.1 });
    expect(off.tempsChanged).toEqual([]);
    expect(off.entries.filter(e => e.purpose === 'wake_triage').map(e => `${e.backendSpec}:${e.calibrated}`).sort()).toEqual(['deepseek-flash:false', 'jev:true', 'laya:typed-decisions:false']);
    expect(off.fits.map(f => f.autofit).sort()).toEqual([false, true, true]); // the fits themselves are still reported
    // A configured primary drives the stamp + the roles.
    const pinned = buildReadinessArtifacts(rows, { days: 14, now: at, primaryByPurpose: { wake_triage: 'laya:typed-decisions' } });
    expect(pinned.stamp.wake_triage).toMatchObject({ backend: 'laya (systemone)', backendSpec: 'laya:typed-decisions' });
    expect(pinned.entries.filter(e => e.purpose === 'wake_triage').map(e => `${e.backendSpec}:${e.role}`).sort()).toEqual(['deepseek-flash:fallback', 'jev:fallback', 'laya:typed-decisions:primary']);
    // Empty entries carry the identity fields too (JSON-safe, roles assigned).
    const empty = pinned.entries.find(e => e.purpose === 'self_audit')!;
    expect(empty).toMatchObject({ backend: 'none', backendSpec: 'none', role: 'primary', metrics: { calls: 0, fails: 0, p50Ms: null } });
    expect(JSON.stringify(pinned)).not.toContain('NaN');
  });

  it('readStoredBackendTemps / writeStoredBackendTemps: reads the backends row\'s temps (fail-open {}); the write is opt-in, writes ONLY the temps field (the row\'s other fields carried over), refuses on a failed read, and the kill switch refuses with an explicit error', async () => {
    mockStoreGet.mockImplementation(async (_ns: string[], key: string) => (key === BACKENDS_STORE_KEY ? { purposes: { wake_triage: { primary: 'jev' } }, temps: { 'a|b': 1.5, bad: 2 }, updatedBy: 'admin' } : null));
    expect(await readStoredBackendTemps()).toEqual({ 'a|b': 1.5 });
    // Opt-in (review 2026-09-26): without DECISION_GATE_TEMP_AUTOFIT_ENABLED the write refuses with an explicit error.
    await expect(writeStoredBackendTemps({ 'a|b': 2 }, { changed: ['a|b'], at: new Date() })).rejects.toThrow(/DECISION_GATE_TEMP_AUTOFIT_ENABLED is not set/);
    expect(mockStorePut).not.toHaveBeenCalled();
    process.env.DECISION_GATE_TEMP_AUTOFIT_ENABLED = '1';
    await writeStoredBackendTemps({ 'a|b': 1.5, 'laya:typed-decisions|wake_triage': 1.7, 'x|y': 0 }, { changed: ['laya:typed-decisions|wake_triage'], at: new Date('2026-09-26T06:00:00Z') });
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    const [ns, key, value] = mockStorePut.mock.calls[0];
    expect(ns).toEqual(READINESS_STORE_NS);
    expect(key).toBe(BACKENDS_STORE_KEY);
    expect(value).toMatchObject({ purposes: { wake_triage: { primary: 'jev' } }, updatedBy: 'admin', temps: { 'a|b': 1.5, 'laya:typed-decisions|wake_triage': 1.7 }, tempsUpdatedAt: '2026-09-26T06:00:00.000Z', tempsUpdatedBy: 'readiness-autofit', tempsChanged: ['laya:typed-decisions|wake_triage'] });
    expect((value as any).temps['x|y']).toBeUndefined();
    // The READ helper is fail-open ({}), but the WRITE never proceeds on a failed read (review 2026-09-26): a blind
    // read-modify-write would replace the shared backends row with a temps-only one and wipe the primary /
    // challenger config. The pass skips the write; the next one retries.
    mockStoreGet.mockRejectedValue(new Error('db down'));
    expect(await readStoredBackendTemps()).toEqual({});
    mockStorePut.mockClear();
    await expect(writeStoredBackendTemps({ 'a|b': 2 }, { changed: ['a|b'], at: new Date() })).rejects.toThrow(/backends row read failed \(db down\)/);
    expect(mockStorePut).not.toHaveBeenCalled();
    // Kill switch (wins over the opt-in).
    process.env.DECISION_GATE_TEMP_AUTOFIT_DISABLED = '1';
    mockStorePut.mockClear();
    await expect(writeStoredBackendTemps({ 'a|b': 2 }, { changed: ['a|b'], at: new Date() })).rejects.toThrow(/DECISION_GATE_TEMP_AUTOFIT_DISABLED/);
    expect(mockStorePut).not.toHaveBeenCalled();
  });
});

describe('2026-09-26 (audit) — a non-human segment entry never decides the stamp and never reads primary', () => {
  it('readinessStampFromReport skips segment entries (more rows / the configured primary spec notwithstanding); assignReadinessRoles marks them fallback', () => {
    const at = new Date('2026-09-26T20:00:00Z');
    const report = [
      entry('compute_policy', 'TypeSafe Jev', 500, true, { segment: 'supervisor' }),
      entry('compute_policy', 'TypeSafe Jev', 40, false),
    ];
    const stamp = readinessStampFromReport(report, at, 14);
    expect(stamp.compute_policy).toMatchObject({ ready: false, backend: 'TypeSafe Jev' });
    expect(stamp.compute_policy.metrics.n).toBe(40);
    expect(readinessStampFromReport(report, at, 14, { compute_policy: 'jev' }).compute_policy.metrics.n).toBe(40);
    expect(readinessStampFromReport([report[0]], at, 14)).toEqual({});
    expect(readinessStampFromReport([report[0]], at, 14, { compute_policy: 'jev' })).toEqual({});
    const roles = assignReadinessRoles(report, stamp, { compute_policy: 'jev' });
    expect(roles.map(e => `${e.segment ?? 'human'}:${e.role}`)).toEqual(['supervisor:fallback', 'human:primary']);
    expect(assignReadinessRoles(report, stamp).map(e => e.role)).toEqual(['fallback', 'primary']);
  });
});

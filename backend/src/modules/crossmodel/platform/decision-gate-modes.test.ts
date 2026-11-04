/**
 * decision-gate-modes.ts — the store-backed, fleet-wide decision-gate mode
 * (WI-S, 2026-09-25): normalisation, the admin view, the PUT semantics, the
 * env fallback chain and the kill switch. The runtime precedence is pinned
 * in decision-gate.test.ts ('store-backed mode').
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
// E12: the auto-demotion records a telemetry row through loop-metrics (which boots env.ts) — mocked.
const mockRecordLoopMetric = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import {
  DECISION_PURPOSES,
  PURPOSE_ACT_CAPS,
  actCapLiftEnv,
  capDecisionMode,
  purposeActCap,
  actBandWindow,
  admissionVerdict,
  autoDemoteDecisionMode,
  clearActBandWindows,
  clearDecisionModeCache,
  envDecisionMode,
  getDecisionModeConfig,
  normalizeStoredDecisionModes,
  normalizeStoredReadiness,
  noteActBandOutcome,
  refreshDecisionModes,
  resolveDecisionPrimarySpec,
  setDecisionPrimaryResolver,
  storedDecisionModeSync,
  updateDecisionModes,
} from './decision-gate-modes';

const ENV_KEYS = ['DECISION_GATE_DISABLED', 'DECISION_GATE_DEFAULT_MODE', 'DECISION_GATE_MODE_WAKE_TRIAGE', 'DECISION_GATE_MODE_DELTA_MATERIAL',
  'DECISION_GATE_ADMISSION_DISABLED', 'DECISION_GATE_READINESS_MAX_AGE_DAYS', 'DECISION_GATE_AUTO_DEMOTE_MIN_N', 'DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION',
  'DECISION_GATE_AUTO_DEMOTE_MARGIN', 'DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_WAKE_TRIAGE', 'DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED',
  'SUPERVISOR_WAKE_LEDGER_IN_TEST', 'SUPERVISOR_MATERIAL_GATE_DISABLED'];
const saved: Record<string, string | undefined> = {};
/** Key-aware fake store: the 'modes' row and the E12 'readiness' row live under the same namespace. */
let modesRow: any = null;
let readinessRow: any = null;
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  modesRow = null;
  readinessRow = null;
  mockStoreGet.mockReset();
  mockStoreGet.mockImplementation(async (_ns: string[], key: string) => (key === 'modes' ? modesRow : key === 'readiness' ? readinessRow : null));
  mockStorePut.mockReset();
  // The fake store persists a put so the post-update read reflects it (as prisma would).
  mockStorePut.mockImplementation(async (_ns: string[], key: string, value: any) => { if (key === 'modes') modesRow = value; else if (key === 'readiness') readinessRow = value; });
  mockRecordLoopMetric.mockReset();
  clearDecisionModeCache();
  clearActBandWindows();
  setDecisionPrimaryResolver(null);
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setDecisionPrimaryResolver(null);
});

describe('decision-gate-modes', () => {
  it('lists every gated purpose (probe excluded) and normalises a stored row to valid entries only', () => {
    expect(DECISION_PURPOSES.map(p => p.purpose)).toEqual(['wake_triage', 'delta_material', 'auto_route', 'imessage_send', 'browser_driver', 'memory_extract', 'self_audit', 'guard_strike', 'sweep_triage', 'checker_route', 'coding_memory_fold', 'reflection_route', 'claim_evidenced', 'drain_triage', 'firing_superseded', 'tool_intent', 'wake_effort', 'compute_policy', 'drafts_agree', 'revision_material', 'supervisor_turn_noop', 'session_topology', 'task_kind', 'turn_plan']);
    expect(normalizeStoredDecisionModes({ modes: { wake_triage: 'ACT', self_audit: 'maybe', probe: 'off', nope: 'act' } })).toEqual({ wake_triage: 'act' });
    expect(normalizeStoredDecisionModes(null)).toEqual({});
  });

  it('envDecisionMode: per-purpose env → default env → bare default (off under test)', () => {
    expect(envDecisionMode('wake_triage')).toEqual({ mode: 'off', source: 'default' });
    process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
    expect(envDecisionMode('wake_triage')).toEqual({ mode: 'shadow', source: 'env_default' });
    process.env.DECISION_GATE_MODE_WAKE_TRIAGE = 'act';
    expect(envDecisionMode('wake_triage')).toEqual({ mode: 'act', source: 'env_purpose' });
  });

  it('storedDecisionModeSync: null on a cold cache and schedules NO read under NODE_ENV=test; the store value after a refresh', async () => {
    expect(storedDecisionModeSync('wake_triage')).toBeNull();
    expect(mockStoreGet).not.toHaveBeenCalled();
    modesRow = { modes: { wake_triage: 'act' } };
    await refreshDecisionModes();
    expect(storedDecisionModeSync('wake_triage')).toBe('act');
    expect(storedDecisionModeSync('probe')).toBeNull();
  });

  it('getDecisionModeConfig: store / env / effective + source per purpose, flags for the kill switches', async () => {
    process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
    modesRow = { modes: { wake_triage: 'act' } };
    const cfg = await getDecisionModeConfig();
    expect(cfg.gateDisabled).toBe(false);
    expect(cfg.admissionDisabled).toBe(false);
    const wt = cfg.purposes.find(p => p.purpose === 'wake_triage')!;
    expect(wt).toMatchObject({ storeMode: 'act', envMode: 'shadow', effective: 'act', effectiveSource: 'store', label: 'Supervisor wake triage' });
    // E12: no readiness row → every purpose reads "not ready" with the reason named.
    expect(wt.readiness).toBeNull();
    expect(wt.admission.admitted).toBe(false);
    expect(wt.admission.reason).toMatch(/no readiness stamp/);
    const sa = cfg.purposes.find(p => p.purpose === 'self_audit')!;
    expect(sa).toMatchObject({ storeMode: null, envMode: 'shadow', effective: 'shadow', effectiveSource: 'env_default' });
    process.env.DECISION_GATE_DISABLED = '1';
    const cfg3 = await getDecisionModeConfig();
    expect(cfg3.gateDisabled).toBe(true);
    expect(cfg3.purposes.every(p => p.effective === 'off' && p.effectiveSource === 'disabled')).toBe(true);
  });

  it('updateDecisionModes: read-modify-write of the one row; "" clears; unknown purpose / bad value 400; empty patch 400', async () => {
    modesRow = { modes: { wake_triage: 'act', self_audit: 'off' } };
    // E12: delta_material carries a fresh READY stamp, so act is admitted here.
    readinessRow = { delta_material: { ready: true, at: new Date().toISOString(), metrics: { n: 240, actBandPrecision: 0.94 } } };
    const cfg = await updateDecisionModes({ delta_material: 'act', self_audit: '' }, 'admin-1');
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    const [ns, key, value] = mockStorePut.mock.calls[0];
    expect(ns).toEqual(['instance', 'decision-gate']);
    expect(key).toBe('modes');
    expect(value.modes).toEqual({ wake_triage: 'act', delta_material: 'act' });
    expect(value.updatedBy).toBe('admin-1');
    expect(cfg.purposes.find(p => p.purpose === 'delta_material')!.storeMode).toBe('act');
    await expect(updateDecisionModes({ probe: 'act' })).rejects.toThrow(/Unknown decision-gate purpose "probe"/);
    await expect(updateDecisionModes({ wake_triage: 'maybe' })).rejects.toThrow(/Invalid mode "maybe"/);
    await expect(updateDecisionModes({})).rejects.toThrow(/No modes to update/);
    expect(mockStorePut).toHaveBeenCalledTimes(1);
  });
});

/* agent-decisions prerequisite 3 (2026-09-27): drain_triage acted at 43 %
 * agreement (20/46, 48 % act_now→ack_only over-acting) — capped at shadow in
 * CODE (a stored / env act runs shadow, source 'registry_cap'; the PUT refuses
 * act) until supervisor_turn_noop replaces it at the drain site. */
describe('registry ACT CAP — drain_triage runs shadow whatever the store says', () => {
  const fresh = () => new Date().toISOString();

  it('PURPOSE_ACT_CAPS names drain_triage + self_audit (tt-rd audit 2026-09-27: Jev AUROC 0.232 — the receipt rule supersedes it); purposeActCap carries the lift env and lifts under DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED=1', () => {
    // backlog E13 (2026-09-28): tool_intent is RETIRED — capped too, so an 'act' PUT is refused.
    // task-aware pick (2026-10-20): task_kind is a pure evidence key — capped (act refused) but NOT retired.
    expect(Object.keys(PURPOSE_ACT_CAPS)).toEqual(['drain_triage', 'self_audit', 'tool_intent', 'task_kind']);
    expect(purposeActCap('self_audit')).toMatchObject({ since: '2026-09-27', liftEnv: 'DECISION_GATE_SELF_AUDIT_ACT_CAP_DISABLED', why: expect.stringMatching(/AUROC 0\.232/) });
    expect(capDecisionMode('self_audit', { mode: 'act', source: 'store' })).toEqual({ mode: 'shadow', source: 'registry_cap' });
    expect(capDecisionMode('self_audit', { mode: 'shadow', source: 'store' })).toEqual({ mode: 'shadow', source: 'store' });
    expect(actCapLiftEnv('drain_triage')).toBe('DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED');
    expect(purposeActCap('drain_triage')).toMatchObject({ since: '2026-09-27', liftEnv: 'DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED', why: expect.stringMatching(/43 %/) });
    expect(purposeActCap('wake_triage')).toBeNull();
    process.env.DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED = '1';
    expect(purposeActCap('drain_triage')).toBeNull();
  });

  it('capDecisionMode: act → shadow (source registry_cap) for the capped purpose only; shadow / off and other purposes pass through; the lift env passes act through', () => {
    expect(capDecisionMode('drain_triage', { mode: 'act', source: 'store' })).toEqual({ mode: 'shadow', source: 'registry_cap' });
    expect(capDecisionMode('drain_triage', { mode: 'shadow', source: 'store' })).toEqual({ mode: 'shadow', source: 'store' });
    expect(capDecisionMode('drain_triage', { mode: 'off', source: 'env_purpose' })).toEqual({ mode: 'off', source: 'env_purpose' });
    expect(capDecisionMode('wake_triage', { mode: 'act', source: 'store' })).toEqual({ mode: 'act', source: 'store' });
    process.env.DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED = '1';
    expect(capDecisionMode('drain_triage', { mode: 'act', source: 'env_purpose' })).toEqual({ mode: 'act', source: 'env_purpose' });
  });

  it('the admin view reads a stored act as effective shadow / registry_cap with actCap + a refusing admission; the PUT refuses act (409) even with a fresh READY stamp; shadow stays writable; the lift env restores the normal path', async () => {
    modesRow = { modes: { drain_triage: 'act' } };
    readinessRow = { drain_triage: { ready: true, at: fresh(), metrics: { n: 300, actBandPrecision: 0.96 } } };
    const cfg = await getDecisionModeConfig();
    const dt = cfg.purposes.find(p => p.purpose === 'drain_triage')!;
    expect(dt).toMatchObject({ storeMode: 'act', effective: 'shadow', effectiveSource: 'registry_cap', admission: { admitted: false } });
    expect(dt.actCap).toMatchObject({ since: '2026-09-27', liftEnv: 'DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED' });
    expect(dt.admission.reason).toMatch(/capped at shadow in code since 2026-09-27/);
    expect(cfg.purposes.find(p => p.purpose === 'wake_triage')!.actCap).toBeUndefined();
    await expect(updateDecisionModes({ drain_triage: 'act' }, 'admin-1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Cannot set drain_triage to act — capped at shadow in code since 2026-09-27/) });
    expect(mockStorePut).not.toHaveBeenCalled();
    // The prod flip (set-mode.js FLIP=drain_triage MODE=shadow) is exactly this write — always admitted.
    const flipped = await updateDecisionModes({ drain_triage: 'shadow' }, 'admin-1');
    expect(modesRow.modes).toEqual({ drain_triage: 'shadow' });
    expect(flipped.purposes.find(p => p.purpose === 'drain_triage')).toMatchObject({ storeMode: 'shadow', effective: 'shadow', effectiveSource: 'store' });
    process.env.DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED = '1';
    const lifted = await updateDecisionModes({ drain_triage: 'act' }, 'admin-1');
    const dt2 = lifted.purposes.find(p => p.purpose === 'drain_triage')!;
    expect(dt2).toMatchObject({ storeMode: 'act', effective: 'act', effectiveSource: 'store' });
    expect(dt2.actCap).toBeUndefined();
  });
});

/* FS task f64b7c1e follow-up (2026-10-27): the W6 act cap is enforced AT THE PUT
 * BOUNDARY (updateDecisionModes refuses act with 409 "Lift the cap on every box
 * with SUPERVISOR_MATERIAL_GATE_DISABLED=1 first") — not only at mode resolution.
 * That refusal is an env read on the PROCESS serving the PUT, so a web box missing
 * the lift key refuses even when another box is lifted: the exact class the FS's
 * set_decision_gate_mode refusals hit (box B had never been staged — ec2-ops'
 * env_override dispatch input targets box A only). The lift is now the deploy.yml
 * fleet .env template (every web box folds both keys on its next wave). */
describe('W6 cap at the PUT boundary (f64b7c1e): refusal + env lift on the serving process', () => {
  it('updateDecisionModes refuses act (409, the exact refusal text) while the cap is live; shadow stays writable', async () => {
    readinessRow = { wake_triage: { ready: true, at: new Date().toISOString(), metrics: { n: 300, actBandPrecision: 0.97 } } };
    process.env.SUPERVISOR_WAKE_LEDGER_IN_TEST = '1';
    await expect(updateDecisionModes({ wake_triage: 'act' }, 'admin-1')).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/Cannot set wake_triage to act — capped at shadow in code.*Lift the cap on every box with SUPERVISOR_MATERIAL_GATE_DISABLED=1 first/),
    });
    expect(mockStorePut).not.toHaveBeenCalled();
    await updateDecisionModes({ wake_triage: 'shadow' }, 'admin-1'); // never refused
  });

  it('the lift on the SERVING process unblocks the same PUT (the stamp admits; without one the E12 path answers instead — not the cap)', async () => {
    readinessRow = { wake_triage: { ready: true, at: new Date().toISOString(), metrics: { n: 300, actBandPrecision: 0.97 } } };
    process.env.SUPERVISOR_WAKE_LEDGER_IN_TEST = '1';
    process.env.SUPERVISOR_MATERIAL_GATE_DISABLED = '1';
    const cfg = await updateDecisionModes({ wake_triage: 'act' }, 'admin-1');
    expect(cfg.purposes.find(p => p.purpose === 'wake_triage')).toMatchObject({ storeMode: 'act', effective: 'act', effectiveSource: 'store' });
    await updateDecisionModes({ wake_triage: '' }, 'admin-1'); // reset the store
    delete readinessRow.wake_triage;
    await expect(updateDecisionModes({ wake_triage: 'act' }, 'admin-1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/not ready: no readiness stamp/) });
  });
});

/* task-aware pick (2026-10-20): task_kind is a PURE evidence key — its answer
 * picks the model-pick quality bucket and the pick's own store flag
 * (modelPickKind) decides whether that leads. The gate mode can never be act
 * (capped), but the bare default must stay SHADOW (not retired) so the ask
 * runs in prod and the kind reaches metadata.depth.turnPlan. */
describe('task_kind — capped at shadow, never retired', () => {
  it('is a storable purpose labelled "Task kind", listed beside turn_plan', () => {
    const row = DECISION_PURPOSES.find(p => p.purpose === 'task_kind');
    expect(row).toMatchObject({ label: 'Task kind', description: expect.stringMatching(/no gate act consumer/) });
    expect(row!.description).toMatch(/modelPickKind/);
  });

  it('a stored / env act runs shadow (registry_cap) with the standard lift env; shadow and off pass through', () => {
    expect(purposeActCap('task_kind')).toMatchObject({ since: '2026-10-20', liftEnv: actCapLiftEnv('task_kind'), why: expect.stringMatching(/pure evidence key/) });
    expect(actCapLiftEnv('task_kind')).toBe('DECISION_GATE_TASK_KIND_ACT_CAP_DISABLED');
    expect(capDecisionMode('task_kind', { mode: 'act', source: 'store' })).toEqual({ mode: 'shadow', source: 'registry_cap' });
    expect(capDecisionMode('task_kind', { mode: 'shadow', source: 'store' })).toEqual({ mode: 'shadow', source: 'store' });
    expect(capDecisionMode('task_kind', { mode: 'off', source: 'env_purpose' })).toEqual({ mode: 'off', source: 'env_purpose' });
  });

  it('is NOT retired: outside tests the bare default is shadow (the ask runs), not the retired default off', () => {
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(envDecisionMode('task_kind')).toEqual({ mode: 'shadow', source: 'default' });
      expect(envDecisionMode('tool_intent')).toEqual({ mode: 'off', source: 'retired_default' }); // the contrast: a retired purpose
    } finally {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it('the PUT refuses act (409) even with a fresh READY stamp; shadow / off stay writable', async () => {
    readinessRow = { task_kind: { ready: true, at: new Date().toISOString(), metrics: { n: 300, actBandPrecision: 0.99 } } };
    await expect(updateDecisionModes({ task_kind: 'act' }, 'admin-1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Cannot set task_kind to act — capped at shadow in code since 2026-10-20/) });
    expect(mockStorePut).not.toHaveBeenCalled();
    const cfg = await updateDecisionModes({ task_kind: 'off' }, 'admin-1');
    expect(cfg.purposes.find(p => p.purpose === 'task_kind')).toMatchObject({ storeMode: 'off', effective: 'off' });
    await updateDecisionModes({ task_kind: 'shadow' }, 'admin-1');
    expect(modesRow.modes).toEqual({ task_kind: 'shadow' });
  });
});

/* E12 (2026-09-25): flip admission control — the PUT refuses `act` for a
 * purpose the flip-readiness report has not stamped READY (fresh) — and the
 * rolling act-band precision breach that demotes act → shadow automatically. */
describe('E12 — admission control (readiness stamp)', () => {
  const fresh = () => new Date().toISOString();
  const old = () => new Date(Date.now() - 30 * 86_400_000).toISOString();

  it('normalizeStoredReadiness keeps well-formed stamps for known purposes only', () => {
    const r = normalizeStoredReadiness({
      wake_triage: { ready: true, at: fresh(), metrics: { n: 240, actBandPrecision: 0.93 }, reasons: [] },
      self_audit: { ready: false, at: 'not-a-date', metrics: 'x', reasons: ['n=51 < 200', 7] },
      probe: { ready: true }, bogus: { ready: true }, delta_material: { ready: 'yes' }, auto_route: null,
    });
    expect(Object.keys(r).sort()).toEqual(['self_audit', 'wake_triage']);
    expect(r.wake_triage).toEqual({ ready: true, at: expect.any(String), metrics: { n: 240, actBandPrecision: 0.93 } });
    expect(r.self_audit).toEqual({ ready: false, at: null, metrics: {}, reasons: ['n=51 < 200'] });
    expect(normalizeStoredReadiness(null)).toEqual({});
    expect(normalizeStoredReadiness('nope')).toEqual({});
  });

  it('admissionVerdict: no stamp / NOT READY / stale → refused with the bar named; fresh READY → admitted; max age honours the env', () => {
    expect(admissionVerdict('wake_triage', {})).toMatchObject({ admitted: false, stale: false, reason: expect.stringMatching(/no readiness stamp/) });
    const notReady = admissionVerdict('wake_triage', { wake_triage: { ready: false, at: fresh(), metrics: { n: 16, actBandPrecision: 0.75 }, reasons: ['n=16 < 200'] } });
    expect(notReady.admitted).toBe(false);
    expect(notReady.reason).toMatch(/NOT READY/);
    expect(notReady.reason).toMatch(/n=16 < 200/);
    expect(notReady.reason).toMatch(/actBandPrecision=0\.750/);
    const stale = admissionVerdict('wake_triage', { wake_triage: { ready: true, at: old(), metrics: {} } });
    expect(stale).toMatchObject({ admitted: false, stale: true, reason: expect.stringMatching(/stale/) });
    expect(admissionVerdict('wake_triage', { wake_triage: { ready: true, at: null, metrics: {} } }).admitted).toBe(false); // no timestamp = infinitely old
    expect(admissionVerdict('wake_triage', { wake_triage: { ready: true, at: fresh(), metrics: { n: 240 } } })).toEqual({ admitted: true, stale: false });
    process.env.DECISION_GATE_READINESS_MAX_AGE_DAYS = '60';
    expect(admissionVerdict('wake_triage', { wake_triage: { ready: true, at: old(), metrics: {} } }).admitted).toBe(true);
  });

  it('PUT act on an unready purpose → 409 naming the missing bar, nothing written; shadow/off/"" never need a stamp', async () => {
    modesRow = { modes: {} };
    await expect(updateDecisionModes({ wake_triage: 'act' }, 'admin-1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Cannot set wake_triage to act — not ready: no readiness stamp/) });
    readinessRow = { wake_triage: { ready: false, at: fresh(), metrics: { n: 16, actBandPrecision: 0.75 } } };
    await expect(updateDecisionModes({ wake_triage: 'act' })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/NOT READY.*actBandPrecision=0\.750/) });
    readinessRow = { wake_triage: { ready: true, at: old(), metrics: {} } };
    await expect(updateDecisionModes({ wake_triage: 'act' })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/stale/) });
    expect(mockStorePut).not.toHaveBeenCalled();
    // A mixed patch is refused as a whole (no partial write).
    await expect(updateDecisionModes({ wake_triage: 'act', self_audit: 'shadow' })).rejects.toMatchObject({ statusCode: 409 });
    expect(mockStorePut).not.toHaveBeenCalled();
    const cfg = await updateDecisionModes({ wake_triage: 'shadow', self_audit: 'off', delta_material: '' });
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    expect(cfg.purposes.find(p => p.purpose === 'wake_triage')).toMatchObject({ storeMode: 'shadow', admission: { admitted: false } });
  });

  it('PUT act with a fresh READY stamp is admitted and the view carries the stamp; DECISION_GATE_ADMISSION_DISABLED=1 admits without one', async () => {
    modesRow = { modes: {} };
    readinessRow = { wake_triage: { ready: true, at: fresh(), metrics: { n: 240, actBandPrecision: 0.93, auroc: 0.84, coverageAt5pct: 0.66 } } };
    const cfg = await updateDecisionModes({ wake_triage: 'act' }, 'admin-1');
    expect(modesRow.modes).toEqual({ wake_triage: 'act' });
    const wt = cfg.purposes.find(p => p.purpose === 'wake_triage')!;
    expect(wt).toMatchObject({ storeMode: 'act', admission: { admitted: true } });
    expect(wt.readiness).toMatchObject({ ready: true, stale: false, metrics: { n: 240, actBandPrecision: 0.93 } });
    expect(cfg.purposes.find(p => p.purpose === 'self_audit')!.readiness).toBeNull();
    readinessRow = null;
    process.env.DECISION_GATE_ADMISSION_DISABLED = '1';
    // memory_extract stands in for self_audit here since 2026-09-27: self_audit
    // is registry ACT-CAPPED (tt-rd audit) and the PUT refuses act for it even
    // with admission disabled — pinned in the registry ACT CAP block below.
    const cfg2 = await updateDecisionModes({ memory_extract: 'act' });
    expect(modesRow.modes).toEqual({ wake_triage: 'act', memory_extract: 'act' });
    expect(cfg2.admissionDisabled).toBe(true);
    expect(cfg2.purposes.find(p => p.purpose === 'memory_extract')!.admission).toMatchObject({ admitted: true, reason: expect.stringMatching(/ADMISSION_DISABLED/) });
    await expect(updateDecisionModes({ self_audit: 'act' })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Cannot set self_audit to act — capped at shadow in code since 2026-09-27/) });
  });

  it('a readiness store read failure is fail-CLOSED for act (not ready) and never throws for the view', async () => {
    mockStoreGet.mockImplementation(async (_ns: string[], key: string) => { if (key === 'readiness') throw new Error('db down'); return modesRow; });
    const cfg = await getDecisionModeConfig();
    expect(cfg.purposes.every(p => p.readiness === null && p.admission.admitted === false)).toBe(true);
    await expect(updateDecisionModes({ wake_triage: 'act' })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('E12 — rolling act-band precision → automatic demotion', () => {
  it('confidently below the bar with ≥ MIN_N act-period labels: an effectively-act purpose is written back to shadow (store), a decision_gate_demoted row records why (act-period window, Wilson bounds), the window resets', async () => {
    process.env.DECISION_GATE_AUTO_DEMOTE_MIN_N = '10';
    modesRow = { modes: { wake_triage: 'act' } };
    await refreshDecisionModes();
    let breach: any = null;
    for (let i = 0; i < 9; i++) breach = noteActBandOutcome('wake_triage', i % 2 === 0, 'act'); // 5/9 agreed
    expect(breach).toBeNull(); // not enough labels yet
    breach = noteActBandOutcome('wake_triage', false, 'act'); // 10th: 5/10 — Wilson 95% upper 0.763 < 0.9
    expect(breach).toMatchObject({ n: 10, precision: 0.5, bar: 0.9, margin: 0, windowSince: expect.any(String) });
    expect(breach.upperBound).toBeCloseTo(0.763, 3);
    expect(breach.lowerBound).toBeCloseTo(0.237, 3);
    expect(actBandWindow('wake_triage')).toMatchObject({ n: 0, since: null });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    const [ns, key, value] = mockStorePut.mock.calls[0];
    expect(ns).toEqual(['instance', 'decision-gate']);
    expect(key).toBe('modes');
    expect(value.modes).toEqual({ wake_triage: 'shadow' });
    expect(value.updatedBy).toBe('auto-demote');
    expect(value.demoted).toMatchObject({ purpose: 'wake_triage', n: 10, nAct: 10, precision: 0.5, lowerBound: 0.237, upperBound: 0.763, bar: 0.9, margin: 0, windowScope: 'act_period', windowSince: breach.windowSince });
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric.mock.calls[0][0]).toMatchObject({ kind: 'decision_gate_demoted', value: 0.5, meta: { purpose: 'wake_triage', n: 10, nAct: 10, precision: 0.5, lowerBound: 0.237, upperBound: 0.763, bar: 0.9, margin: 0, window: 100, windowScope: 'act_period', windowSince: breach.windowSince, previousStoreMode: 'act', effectiveBefore: 'act', outcome: 'demoted' } });
    // The cache was dropped, so this process sees shadow at once.
    await refreshDecisionModes();
    expect(storedDecisionModeSync('wake_triage')).toBe('shadow');
  });

  it('an env-only act (no store row) is demoted too — the store row wins over env; a stale breach on a purpose that is no longer act only clears its window (no write, no row)', async () => {
    process.env.DECISION_GATE_AUTO_DEMOTE_MIN_N = '5';
    process.env.DECISION_GATE_MODE_WAKE_TRIAGE = 'act';
    modesRow = null;
    for (let i = 0; i < 5; i++) noteActBandOutcome('wake_triage', false, 'act');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    expect(mockStorePut.mock.calls[0][2].modes).toEqual({ wake_triage: 'shadow' });
    expect(mockRecordLoopMetric.mock.calls[0][0].meta).toMatchObject({ previousStoreMode: null, effectiveBefore: 'act', outcome: 'demoted' });
    // delta_material runs shadow (the suite default is off under test; set shadow explicitly). Labels whose DECISION was
    // made in act (a previous act period, landing late) still enter the window; the breach finds the purpose shadow →
    // nothing written, no row, window cleared.
    process.env.DECISION_GATE_MODE_DELTA_MATERIAL = 'shadow';
    for (let i = 0; i < 5; i++) noteActBandOutcome('delta_material', false, 'act');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(actBandWindow('delta_material').n).toBe(0);
  });

  it('precision confidently at or above the bar never fires (bar from env)', async () => {
    process.env.DECISION_GATE_AUTO_DEMOTE_MIN_N = '5';
    process.env.DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION = '0.5';
    for (let i = 0; i < 5; i++) expect(noteActBandOutcome('wake_triage', i !== 0, 'act')).toBeNull(); // 4/5 = 0.8, upper 0.964 ≥ 0.5
    expect(actBandWindow('wake_triage')).toMatchObject({ n: 5, precision: 0.8 });
    expect(noteActBandOutcome('probe', false, 'act')).toBeNull();
  });

  it('a store failure during demotion is fail-open: mode unchanged, no throw', async () => {
    modesRow = { modes: { wake_triage: 'act' } };
    mockStorePut.mockRejectedValue(new Error('db down'));
    await expect(autoDemoteDecisionMode('wake_triage', { n: 30, precision: 0.5 })).resolves.toBe('skipped');
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});

/* 2026-09-26 (open-weight decision backends, plan D): the READY stamp names the
 * backend it was measured on (backendSpec); when the purpose's effective
 * PRIMARY is known (the backends module's resolver, or a per-call override)
 * and differs, act is refused. Either side unknown = pre-change admission. */
describe('2026-09-26 — admission pin: the stamp\'s backendSpec must be the effective primary', () => {
  const fresh = () => new Date().toISOString();

  it('normalizeStoredReadiness keeps backendSpec (trimmed, bounded); admissionVerdict refuses only when BOTH the stamp\'s backendSpec and the primary are known and differ, naming both', () => {
    const r = normalizeStoredReadiness({ wake_triage: { ready: true, at: fresh(), metrics: { n: 240 }, backendSpec: '  jev ' }, self_audit: { ready: true, at: fresh(), metrics: {}, backendSpec: 7 } });
    expect(r.wake_triage!.backendSpec).toBe('jev');
    expect(r.self_audit!.backendSpec).toBeUndefined();
    const stamped = { wake_triage: { ready: true, at: fresh(), metrics: { n: 240 }, backendSpec: 'jev' } };
    expect(admissionVerdict('wake_triage', stamped)).toEqual({ admitted: true, stale: false });                                  // no primary known → pre-change
    expect(admissionVerdict('wake_triage', stamped, Date.now(), { primarySpec: 'jev' })).toEqual({ admitted: true, stale: false });
    expect(admissionVerdict('wake_triage', stamped, Date.now(), { primarySpec: '  ' })).toEqual({ admitted: true, stale: false });  // a blank primary is no pin
    const refused = admissionVerdict('wake_triage', stamped, Date.now(), { primarySpec: 'laya:typed-decisions' });
    expect(refused.admitted).toBe(false);
    expect(refused.stale).toBe(false);
    expect(refused.reason).toMatch(/readiness measured on jev, primary is laya:typed-decisions/);
    expect(refused.reason).toMatch(/n=240/);
    // An older stamp without backendSpec never pins.
    expect(admissionVerdict('wake_triage', { wake_triage: { ready: true, at: fresh(), metrics: {} } }, Date.now(), { primarySpec: 'laya:typed-decisions' })).toEqual({ admitted: true, stale: false });
    // NOT READY / stale still come first.
    expect(admissionVerdict('wake_triage', { wake_triage: { ready: false, at: fresh(), metrics: {}, backendSpec: 'jev' } }, Date.now(), { primarySpec: 'laya:x' }).reason).toMatch(/NOT READY/);
  });

  it('PUT act: the registered primary resolver refuses a stamp measured on another backend (409, nothing written) and admits a matching one; per-call primarySpecFor overrides; a failing resolver is fail-open; the view carries primarySpec', async () => {
    modesRow = { modes: {} };
    readinessRow = { wake_triage: { ready: true, at: fresh(), metrics: { n: 240 }, backendSpec: 'jev' } };
    // No resolver registered: pre-change admission.
    expect((await updateDecisionModes({ wake_triage: 'act' })).purposes.find(p => p.purpose === 'wake_triage')).toMatchObject({ storeMode: 'act', admission: { admitted: true } });
    expect(modesRow.modes).toEqual({ wake_triage: 'act' });
    await updateDecisionModes({ wake_triage: 'shadow' });
    mockStorePut.mockClear();
    // The backends module names the primary: a mismatch refuses.
    setDecisionPrimaryResolver(async (p) => (p === 'wake_triage' ? 'laya:typed-decisions' : undefined));
    expect(await resolveDecisionPrimarySpec('wake_triage')).toBe('laya:typed-decisions');
    expect(await resolveDecisionPrimarySpec('self_audit')).toBeUndefined();
    await expect(updateDecisionModes({ wake_triage: 'act' })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/readiness measured on jev, primary is laya:typed-decisions/) });
    expect(mockStorePut).not.toHaveBeenCalled();
    const view = await getDecisionModeConfig();
    const wt = view.purposes.find(p => p.purpose === 'wake_triage')!;
    expect(wt).toMatchObject({ primarySpec: 'laya:typed-decisions', admission: { admitted: false, reason: expect.stringMatching(/readiness measured on jev/) } });
    expect(view.purposes.find(p => p.purpose === 'self_audit')!.primarySpec).toBeUndefined();
    // A matching primary admits.
    setDecisionPrimaryResolver(async () => 'jev');
    const cfg = await updateDecisionModes({ wake_triage: 'act' }, 'admin-1');
    expect(modesRow.modes).toEqual({ wake_triage: 'act' });
    expect(cfg.purposes.find(p => p.purpose === 'wake_triage')).toMatchObject({ primarySpec: 'jev', admission: { admitted: true } });
    // Per-call override beats the registered resolver.
    await updateDecisionModes({ wake_triage: 'shadow' });
    await expect(updateDecisionModes({ wake_triage: 'act' }, 'admin-1', { primarySpecFor: () => 'jevk5:4b' })).rejects.toMatchObject({ statusCode: 409 });
    expect((await updateDecisionModes({ wake_triage: 'act' }, 'admin-1', { primarySpecFor: () => 'jev' })).purposes.find(p => p.purpose === 'wake_triage')!.admission.admitted).toBe(true);
    // A failing resolver never blocks (no pin) and never throws for the view.
    await updateDecisionModes({ wake_triage: 'shadow' });
    setDecisionPrimaryResolver(() => { throw new Error('resolver down'); });
    expect(await resolveDecisionPrimarySpec('wake_triage')).toBeUndefined();
    expect((await updateDecisionModes({ wake_triage: 'act' })).purposes.find(p => p.purpose === 'wake_triage')!.admission.admitted).toBe(true);
    expect((await getDecisionModeConfig()).purposes.find(p => p.purpose === 'wake_triage')!.primarySpec).toBeUndefined();
    // DECISION_GATE_ADMISSION_DISABLED still admits regardless of the pin.
    await updateDecisionModes({ wake_triage: 'shadow' });
    setDecisionPrimaryResolver(async () => 'laya:typed-decisions');
    process.env.DECISION_GATE_ADMISSION_DISABLED = '1';
    expect((await updateDecisionModes({ wake_triage: 'act' })).purposes.find(p => p.purpose === 'wake_triage')!.admission).toMatchObject({ admitted: true, reason: expect.stringMatching(/ADMISSION_DISABLED/) });
  });
});

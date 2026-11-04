/**
 * decision-gate-backends.ts — the store-backed per-purpose PRIMARY + CHALLENGER
 * backends (open-weight decision-model plan C / D / F, 2026-09-26):
 * normalisation, the pure chain / challenger selectors, the 30 s cache with
 * its hermeticity contract, the admin view, and the PUT semantics — spec
 * vetting through the decision seat's rule, backends row FIRST then the modes
 * row, act → shadow on a primary change, the documented "promote challenger"
 * shape, and zero behaviour change with no row configured. The runtime side
 * (the chain order decide() actually calls, the parallel challenger calls and
 * their rows) is pinned in decision-gate.test.ts.
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
// The decision seat (model-roles.service): the seat model / fallback the chain
// reads, and the seat's own assignability rule the PUT vets every spec with.
const mockResolveRoleModel = jest.fn(async (..._a: any[]): Promise<string> => 'jev');
const mockResolveRoleFallback = jest.fn(async (..._a: any[]): Promise<string> => '');
const mockAssertDecisionSpecAssignable = jest.fn(async (spec: string): Promise<void> => {
  if (spec === 'kimi-k3' || spec === 'nope:model') throw new FakeAppError(400, `"${spec}" is not offered for the "Decision gate" seat.`);
});
jest.mock('../model-endpoints/model-roles.service', () => ({
  resolveRoleModel: (...a: any[]) => mockResolveRoleModel(...a),
  resolveRoleFallback: (...a: any[]) => mockResolveRoleFallback(...a),
  assertDecisionSpecAssignable: (...a: any[]) => mockAssertDecisionSpecAssignable(...(a as [string])),
}));
// The registry (candidates): two enabled endpoints — a systemone Laya box and
// a logprobs vLLM box — plus a disabled one that must not be offered.
const mockListEndpoints = jest.fn(async (): Promise<any[]> => [
  // `calibrated: true` on ONE model (plan A endpoint flag): a systemone server is NOT presumed calibrated any more.
  { id: 'e1', label: 'laya', providerShape: 'systemone', baseUrl: 'http://laya:8000/v1', enabled: true, models: [{ id: 'typed-decisions', calibrated: true }, { id: 'multilingual' }] },
  { id: 'e2', label: 'vllm', providerShape: 'openai_chat', baseUrl: 'http://vllm:8001/v1', enabled: true, models: [{ id: 'Qwen/Qwen3-4B' }] },
  { id: 'e3', label: 'old', providerShape: 'systemone', baseUrl: 'http://old/v1', enabled: false, models: [{ id: 'x' }] },
]);
const mockResolveRegistryModel = jest.fn(async (spec: string): Promise<any> => (spec === 'laya:multilingual' ? null : { label: spec.split(':')[0], model: spec.split(':')[1] }));
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  listEndpoints: (...a: any[]) => mockListEndpoints(...(a as [])),
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...(a as [string])),
  // Ticket 2df5ed65: the candidates builder reads each model's kind through the
  // service's modelKindOf (single source of truth). A local pure re-implementation
  // (explicit kind > decision flag > the decision id heuristic > chat) — the real
  // module eagerly imports prisma, which this suite deliberately mocks away.
  modelKindOf: (m: any) => {
    if (!m?.id) return 'chat';
    if (m.kind === 'decision' || m.decision === 'systemone_chat') return 'decision';
    return /\bjev\b|\blaya\b|systemone|neohorse|\bkev\b/i.test(String(m.id)) ? 'decision' : 'chat';
  },
}));

import {
  CHALLENGER_GRACE_DEFAULT_MS, CHALLENGER_MAX_DEFAULT, CHALLENGER_TIMEOUT_DEFAULT_MS, challengerTimeoutMs,
  chainSpecsForPurpose, challengerGraceMs, challengerMax, challengerSpecsForPurpose, clearDecisionBackendsConfigCache, configuredChallengerSpecs,
  getDecisionBackendsConfig, normalizeStoredDecisionBackends, primarySpecForPurpose, refreshDecisionBackends, registerDecisionPrimaryResolver,
  resolveEffectivePrimarySpec, storedDecisionBackends, storedDecisionBackendsSync, storedPrimarySpecForPurpose, updateDecisionBackends,
} from './decision-gate-backends';
import { actBandWindow, clearActBandWindows, clearDecisionModeCache, noteActBandOutcome, refreshDecisionModes, storedDecisionModeSync } from './decision-gate-modes';
import { clearDecisionBackendCache } from './decision-gate';

const ENV_KEYS = ['DECISION_GATE_CHALLENGER_MAX', 'DECISION_GATE_CHALLENGER_GRACE_MS', 'DECISION_GATE_CHALLENGER_TIMEOUT_MS', 'DECISION_GATE_CHALLENGER_LONG_TIMEOUT_DISABLED',
  'DECISION_GATE_DEFAULT_MODE', 'DECISION_GATE_MODE_WAKE_TRIAGE', 'DECISION_GATE_MODE_SWEEP_TRIAGE', 'DECISION_GATE_DISABLED', 'TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY'];
const saved: Record<string, string | undefined> = {};
/** Key-aware fake store: 'backends' and 'modes' live under the same namespace. */
let backendsRow: any = null;
let modesRow: any = null;
const SEAT = { seatModel: 'jev', seatFallback: '', builtIns: ['jev', 'deepseek-flash'] as const };

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  backendsRow = null;
  modesRow = null;
  mockStoreGet.mockReset();
  mockStoreGet.mockImplementation(async (_ns: string[], key: string) => (key === 'backends' ? backendsRow : key === 'modes' ? modesRow : null));
  mockStorePut.mockReset();
  mockStorePut.mockImplementation(async (_ns: string[], key: string, value: any) => { if (key === 'backends') backendsRow = value; else if (key === 'modes') modesRow = value; });
  mockRecordLoopMetric.mockReset();
  mockResolveRoleModel.mockClear();
  mockResolveRoleModel.mockResolvedValue('jev');
  mockResolveRoleFallback.mockClear();
  mockResolveRoleFallback.mockResolvedValue('');
  mockAssertDecisionSpecAssignable.mockClear();
  mockListEndpoints.mockClear();
  mockResolveRegistryModel.mockClear();
  clearDecisionBackendsConfigCache();
  clearDecisionBackendCache();
  clearDecisionModeCache();
  clearActBandWindows();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('normalisation (pure)', () => {
  it('keeps known purposes with well-formed entries only; specs trimmed and deduped; temps positive numbers keyed "<spec>|<purpose>"; an empty / garbage row is an empty config', () => {
    const cfg = normalizeStoredDecisionBackends({
      purposes: {
        wake_triage: { primary: ' laya:typed-decisions ', challengers: ['jev', 'jev', ' deepseek-flash', 7, ''] },
        sweep_triage: { challengers: [] },                 // explicit NONE is kept (it overrides defaultChallengers)
        self_audit: { primary: '' },                        // nothing valid → dropped
        probe: { primary: 'jev' },                          // not storable
        nope: { primary: 'jev' },
        auto_route: 'jev',                                  // not an object
      },
      defaultChallengers: ['laya:typed-decisions', 'laya:typed-decisions'],
      temps: { 'laya:typed-decisions|wake_triage': 1.22, 'bad': 1, 'x|y': -1, 'jev|self_audit': '0.9' },
      updatedBy: 'u1', updatedAt: '2026-09-26T00:00:00.000Z',
    });
    expect(cfg).toEqual({
      purposes: {
        wake_triage: { primary: 'laya:typed-decisions', challengers: ['jev', 'deepseek-flash'] },
        sweep_triage: { challengers: [] },
      },
      defaultChallengers: ['laya:typed-decisions'],
      temps: { 'laya:typed-decisions|wake_triage': 1.22, 'jev|self_audit': 0.9 },
      updatedBy: 'u1', updatedAt: '2026-09-26T00:00:00.000Z',
    });
    expect(normalizeStoredDecisionBackends(null)).toEqual({ purposes: {} });
    expect(normalizeStoredDecisionBackends({ purposes: 'x' as any })).toEqual({ purposes: {} });
    expect(normalizeStoredDecisionBackends({ defaultChallengers: [] })).toEqual({ purposes: {} });
  });

  it('chainSpecsForPurpose: configured primary FIRST, then seat model, seat fallback, built-ins — deduped; with no row it is byte-identical to the global chain', () => {
    const global = chainSpecsForPurpose(null, 'wake_triage', SEAT);
    expect(global).toEqual(['jev', 'deepseek-flash']);
    expect(chainSpecsForPurpose({ purposes: {} }, 'wake_triage', SEAT)).toEqual(global);
    const cfg = normalizeStoredDecisionBackends({ purposes: { wake_triage: { primary: 'laya:typed-decisions' }, sweep_triage: { primary: 'deepseek-flash' } } });
    expect(chainSpecsForPurpose(cfg, 'wake_triage', SEAT)).toEqual(['laya:typed-decisions', 'jev', 'deepseek-flash']);
    // A primary equal to a built-in moves it to the front — no duplicate leg.
    expect(chainSpecsForPurpose(cfg, 'sweep_triage', SEAT)).toEqual(['deepseek-flash', 'jev']);
    // Other purposes keep the global chain.
    expect(chainSpecsForPurpose(cfg, 'auto_route', SEAT)).toEqual(global);
    // The seat's custom fallback slots between the seat model and the built-ins.
    expect(chainSpecsForPurpose(cfg, 'auto_route', { ...SEAT, seatModel: 'laya:multilingual', seatFallback: 'vllm:Qwen/Qwen3-4B' })).toEqual(['laya:multilingual', 'vllm:Qwen/Qwen3-4B', 'jev', 'deepseek-flash']);
    // The config-side read: the PUT's before/after and the plan-D pin see the stored primary.
    expect(storedPrimarySpecForPurpose(cfg, 'wake_triage')).toBe('laya:typed-decisions');
    expect(storedPrimarySpecForPurpose(cfg, 'auto_route')).toBeNull();
    expect(storedPrimarySpecForPurpose(cfg, 'probe')).toBeNull();
    expect(storedPrimarySpecForPurpose(null, 'wake_triage')).toBeNull();
  });

  it('challengerSpecsForPurpose: purposes[p].challengers ?? defaultChallengers, minus the leg expected to answer, capped by DECISION_GATE_CHALLENGER_MAX (default 2, ceiling 8); [] means none', () => {
    const cfg = normalizeStoredDecisionBackends({
      purposes: { wake_triage: { primary: 'laya:typed-decisions', challengers: ['jev', 'laya:typed-decisions', 'deepseek-flash', 'vllm:Qwen/Qwen3-4B'] }, sweep_triage: { challengers: [] } },
      defaultChallengers: ['laya:typed-decisions'],
    });
    expect(challengerMax()).toBe(CHALLENGER_MAX_DEFAULT);
    expect(challengerGraceMs()).toBe(CHALLENGER_GRACE_DEFAULT_MS);
    expect(configuredChallengerSpecs(cfg, 'wake_triage')).toEqual(['jev', 'laya:typed-decisions', 'deepseek-flash', 'vllm:Qwen/Qwen3-4B']);
    // The configured primary is the leg expected to answer → not its own challenger; the cap keeps the first 2.
    expect(challengerSpecsForPurpose(cfg, 'wake_triage', 'laya:typed-decisions')).toEqual(['jev', 'deepseek-flash']);
    process.env.DECISION_GATE_CHALLENGER_MAX = '3';
    expect(challengerSpecsForPurpose(cfg, 'wake_triage', 'laya:typed-decisions')).toEqual(['jev', 'deepseek-flash', 'vllm:Qwen/Qwen3-4B']);
    process.env.DECISION_GATE_CHALLENGER_MAX = '99';
    expect(challengerMax()).toBe(8);
    process.env.DECISION_GATE_CHALLENGER_MAX = '0';
    expect(challengerSpecsForPurpose(cfg, 'wake_triage', 'laya:typed-decisions')).toEqual([]);
    delete process.env.DECISION_GATE_CHALLENGER_MAX;
    // Explicit [] on a purpose overrides the defaults; an unset purpose inherits them (minus the answering leg).
    expect(challengerSpecsForPurpose(cfg, 'sweep_triage', 'jev')).toEqual([]);
    expect(challengerSpecsForPurpose(cfg, 'auto_route', 'jev')).toEqual(['laya:typed-decisions']);
    expect(challengerSpecsForPurpose(cfg, 'auto_route', 'laya:typed-decisions')).toEqual([]);
    expect(challengerSpecsForPurpose(null, 'auto_route', 'jev')).toEqual([]);
    expect(challengerSpecsForPurpose(cfg, 'probe', 'jev')).toEqual([]);
    process.env.DECISION_GATE_CHALLENGER_GRACE_MS = '50';
    expect(challengerGraceMs()).toBe(50);
    process.env.DECISION_GATE_CHALLENGER_GRACE_MS = '99999';
    expect(challengerGraceMs()).toBe(10_000);
    process.env.DECISION_GATE_CHALLENGER_GRACE_MS = 'x';
    expect(challengerGraceMs()).toBe(CHALLENGER_GRACE_DEFAULT_MS);
  });
});

describe('store-backed cache (30 s, sync read, async refresh, fail-open)', () => {
  it('cold cache: the sync read is null and schedules NO store read under NODE_ENV=test; the async read is an empty config; after refreshDecisionBackends() both serve the row', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(storedDecisionBackendsSync()).toBeNull();
    expect(await storedDecisionBackends()).toEqual({ purposes: {} });
    expect(mockStoreGet).not.toHaveBeenCalled();
    backendsRow = { purposes: { wake_triage: { primary: 'laya:typed-decisions' } }, defaultChallengers: ['jev'] };
    await refreshDecisionBackends();
    expect(mockStoreGet).toHaveBeenCalledWith(['instance', 'decision-gate'], 'backends');
    expect(storedDecisionBackendsSync()).toMatchObject({ purposes: { wake_triage: { primary: 'laya:typed-decisions' } }, defaultChallengers: ['jev'] });
    expect(await storedDecisionBackends()).toMatchObject({ defaultChallengers: ['jev'] });
    // Inside the TTL no further store read happens.
    await storedDecisionBackends();
    expect(mockStoreGet).toHaveBeenCalledTimes(1);
  });

  it('concurrent refreshes share one read; a store failure serves the LAST KNOWN row (fail-open) or an empty config when nothing was ever read; the cache clears on demand', async () => {
    backendsRow = { purposes: { wake_triage: { primary: 'laya:typed-decisions' } } };
    await Promise.all([refreshDecisionBackends(), refreshDecisionBackends(), refreshDecisionBackends()]);
    expect(mockStoreGet).toHaveBeenCalledTimes(1);
    // Warm cache + a failing read → the last known row keeps serving, nothing throws.
    mockStoreGet.mockRejectedValueOnce(new Error('db down'));
    expect(await refreshDecisionBackends()).toMatchObject({ purposes: { wake_triage: { primary: 'laya:typed-decisions' } } });
    expect(storedDecisionBackendsSync()).toMatchObject({ purposes: { wake_triage: { primary: 'laya:typed-decisions' } } });
    // Cleared cache + a failing read → an empty config (no per-purpose backends apply), never throws.
    clearDecisionBackendsConfigCache();
    expect(storedDecisionBackendsSync()).toBeNull();
    mockStoreGet.mockRejectedValueOnce(new Error('db down'));
    expect(await refreshDecisionBackends()).toEqual({ purposes: {} });
  });
});

describe('admin view (GET)', () => {
  it('lists the candidates (built-ins with their env-key servability + every ENABLED registry model with its kind and resolvability) and per purpose the stored / effective primary, challengers, chain order and fleet-effective mode', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
    backendsRow = { purposes: { wake_triage: { primary: 'laya:typed-decisions', challengers: ['jev'] } }, defaultChallengers: ['vllm:Qwen/Qwen3-4B'], updatedBy: 'u1', updatedAt: 't' };
    modesRow = { modes: { wake_triage: 'act' } };
    const view = await getDecisionBackendsConfig();
    expect(view.config).toMatchObject({ purposes: { wake_triage: { primary: 'laya:typed-decisions', challengers: ['jev'] } }, defaultChallengers: ['vllm:Qwen/Qwen3-4B'], updatedBy: 'u1' });
    expect(view.candidates).toEqual([
      { spec: 'jev', kind: 'systemone', label: 'TypeSafe Jev', calibrated: true, servable: true },
      { spec: 'deepseek-flash', kind: 'logit', label: 'DeepSeek logprob readout', calibrated: false, servable: false, unservableReason: expect.stringContaining('DEEPSEEK_API_KEY') },
      { spec: 'laya:typed-decisions', kind: 'systemone', label: 'laya (systemone)', calibrated: true, servable: true },
      { spec: 'laya:multilingual', kind: 'systemone', label: 'laya (systemone)', calibrated: false, servable: false, unservableReason: expect.stringContaining('does not resolve') },
      { spec: 'vllm:Qwen/Qwen3-4B', kind: 'logit', label: 'vllm logprob readout', calibrated: false, servable: true },
    ]);
    expect(view.seatModel).toBe('jev');
    // Laya follow-up (2026-09-26): challengers are DETACHED — the grace default is 0, a challenger runs under its own timeout (20 s since the 2026-10-06 audit T6-6).
    expect(view).toMatchObject({ challengerMax: 2, challengerGraceMs: 0, challengerTimeoutMs: 20_000, challengerDetached: true });
    const wt = view.purposes.find(p => p.purpose === 'wake_triage')!;
    expect(wt).toEqual({
      purpose: 'wake_triage', label: 'Supervisor wake triage', primary: 'laya:typed-decisions', challengers: ['jev'],
      effectivePrimary: 'laya:typed-decisions', effectiveChallengers: ['jev'], chain: ['laya:typed-decisions', 'jev', 'deepseek-flash'], mode: 'act',
    });
    const sa = view.purposes.find(p => p.purpose === 'self_audit')!;
    expect(sa).toEqual({
      purpose: 'self_audit', label: 'Coding self-audit gate', primary: null, challengers: null,
      effectivePrimary: 'jev', effectiveChallengers: ['vllm:Qwen/Qwen3-4B'], chain: ['jev', 'deepseek-flash'], mode: 'shadow',
    });
    expect(view.purposes.map(p => p.purpose)).toHaveLength(24); // + turn_plan (dynamic roster 2026-10-03) + task_kind (task-aware pick 2026-10-20)
  });

  it('with NO backends row every purpose runs the global chain with no challengers (zero behaviour change), and a registry outage still returns the built-ins', async () => {
    mockListEndpoints.mockRejectedValueOnce(new Error('db down'));
    const view = await getDecisionBackendsConfig();
    expect(view.config).toEqual({ purposes: {} });
    expect(view.candidates.map(c => c.spec)).toEqual(['jev', 'deepseek-flash']);
    for (const p of view.purposes) {
      expect(p).toMatchObject({ primary: null, challengers: null, effectivePrimary: 'jev', effectiveChallengers: [], chain: ['jev', 'deepseek-flash'] });
    }
  });

  // Review 3c18284e (condition 6): a spec the runtime LEARNED is typed-decision (guard 400 on its
  // logit leg) shows as the chat transport in the picker — matching what backendForSpec drives at
  // call time — instead of still advertising "logprob readout".
  it('a latched spec is offered as systemone_chat (typed decisions via chat completions), never "logprob readout"; unlatched, the same spec is the readout again (review 3c18284e)', async () => {
    const { latchTypedDecisionSpec, clearTypedDecisionLatch } = await import('./decision-gate');
    clearTypedDecisionLatch();
    latchTypedDecisionSpec('vllm:Qwen/Qwen3-4B'); // an UNFLAGGED openai_chat model — no flag, no kind, heuristic-missed id
    try {
      const view = await getDecisionBackendsConfig();
      const latched = view.candidates.find(c => c.spec === 'vllm:Qwen/Qwen3-4B')!;
      expect(latched).toMatchObject({ kind: 'systemone_chat', label: 'vllm (typed decisions via chat completions)', servable: true });
      expect(latched.kind).not.toBe('logit');
    } finally {
      clearTypedDecisionLatch();
    }
    // Unlatched: the same unflagged model is the plain readout candidate again.
    const view2 = await getDecisionBackendsConfig();
    expect(view2.candidates.find(c => c.spec === 'vllm:Qwen/Qwen3-4B')!).toMatchObject({ kind: 'logit', label: 'vllm logprob readout' });
  });
});

describe('PUT — validation', () => {
  it('empty patch 400; unknown purpose 400; a non-object purpose entry 400; an entry with neither field 400', async () => {
    await expect(updateDecisionBackends({}, 'u1')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Nothing to update') });
    await expect(updateDecisionBackends({ purposes: { probe: { primary: 'jev' } } }, 'u1')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Unknown decision-gate purpose "probe"') });
    await expect(updateDecisionBackends({ purposes: { wake_triage: 'jev' } }, 'u1')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('must be an object') });
    await expect(updateDecisionBackends({ purposes: { wake_triage: {} } }, 'u1')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('neither primary nor challengers') });
    expect(mockStorePut).not.toHaveBeenCalled();
  });

  it('every spec goes through the decision seat\'s assignability rule (a chat built-in / unresolvable spec 400s, nothing written); challenger lists beyond the ceiling 400', async () => {
    await expect(updateDecisionBackends({ purposes: { wake_triage: { primary: 'kimi-k3' } } }, 'u1')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('not offered') });
    await expect(updateDecisionBackends({ purposes: { wake_triage: { challengers: ['jev', 'nope:model'] } } }, 'u1')).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateDecisionBackends({ defaultChallengers: ['nope:model'] }, 'u1')).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateDecisionBackends({ purposes: { wake_triage: { primary: '   ' } } }, 'u1')).resolves.toBeTruthy(); // '' (blank) = clear, never vetted
    await expect(updateDecisionBackends({ purposes: { wake_triage: { challengers: Array.from({ length: 9 }, (_, i) => `laya:m${i}`) } } }, 'u1')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('ceiling') });
    expect(mockAssertDecisionSpecAssignable).toHaveBeenCalledWith('kimi-k3');
    expect(mockAssertDecisionSpecAssignable).toHaveBeenCalledWith('nope:model');
  });
});

describe('PUT — semantics', () => {
  it('read-modify-write of the ONE backends row: primary "" clears, challengers null clears (inherit), [] is explicit none, defaultChallengers [] clears; other purposes and temps are kept; the row carries updatedBy/updatedAt', async () => {
    backendsRow = { purposes: { sweep_triage: { primary: 'deepseek-flash' } }, temps: { 'jev|wake_triage': 1.1 } };
    const v1 = await updateDecisionBackends({ purposes: { wake_triage: { primary: 'laya:typed-decisions', challengers: ['jev', 'jev', 'deepseek-flash'] } }, defaultChallengers: ['vllm:Qwen/Qwen3-4B'] }, 'u1');
    expect(mockStorePut).toHaveBeenCalledWith(['instance', 'decision-gate'], 'backends', expect.objectContaining({
      purposes: { sweep_triage: { primary: 'deepseek-flash' }, wake_triage: { primary: 'laya:typed-decisions', challengers: ['jev', 'deepseek-flash'] } },
      defaultChallengers: ['vllm:Qwen/Qwen3-4B'], temps: { 'jev|wake_triage': 1.1 }, updatedBy: 'u1',
    }));
    expect(typeof backendsRow.updatedAt).toBe('string');
    expect(v1.purposes.find(p => p.purpose === 'wake_triage')).toMatchObject({ effectivePrimary: 'laya:typed-decisions', effectiveChallengers: ['jev', 'deepseek-flash'], chain: ['laya:typed-decisions', 'jev', 'deepseek-flash'] });
    // No purpose was act → no modes write.
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    const v2 = await updateDecisionBackends({ purposes: { wake_triage: { primary: '', challengers: null }, sweep_triage: { challengers: [] } }, defaultChallengers: [] }, 'u1');
    expect(backendsRow.purposes).toEqual({ sweep_triage: { primary: 'deepseek-flash', challengers: [] } });
    expect(backendsRow.defaultChallengers).toBeUndefined();
    expect(backendsRow.temps).toEqual({ 'jev|wake_triage': 1.1 });
    expect(v2.purposes.find(p => p.purpose === 'wake_triage')).toMatchObject({ primary: null, challengers: null, effectivePrimary: 'jev', effectiveChallengers: [], chain: ['jev', 'deepseek-flash'] });
    expect(v2.purposes.find(p => p.purpose === 'sweep_triage')).toMatchObject({ primary: 'deepseek-flash', challengers: [], effectiveChallengers: [] });
  });

  it('a PRIMARY change on a purpose whose fleet-effective mode is act: backends row FIRST, then modes[p]="shadow" (other purposes kept), the act-band window resets, and a decision_gate_backend_changed row names from/to/demotedToShadow', async () => {
    process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
    modesRow = { modes: { wake_triage: 'act', sweep_triage: 'act', auto_route: 'off' } };
    await refreshDecisionModes();
    // Two act-period labels sit in the wake_triage window before the change.
    noteActBandOutcome('wake_triage', true, 'act');
    noteActBandOutcome('wake_triage', false, 'act');
    expect(actBandWindow('wake_triage').n).toBe(2);
    const view = await updateDecisionBackends({ purposes: { wake_triage: { primary: 'laya:typed-decisions' }, auto_route: { primary: 'deepseek-flash' } } }, 'admin-1');
    // Write order: backends, then modes.
    expect(mockStorePut.mock.calls.map(c => c[1])).toEqual(['backends', 'modes']);
    expect(modesRow).toMatchObject({ modes: { wake_triage: 'shadow', sweep_triage: 'act', auto_route: 'off' }, updatedBy: 'backend-change:admin-1', backendChanged: [{ purpose: 'wake_triage', from: 'jev', to: 'laya:typed-decisions' }] });
    expect(actBandWindow('wake_triage').n).toBe(0);
    // The mode cache was dropped: this process sees shadow at once.
    await refreshDecisionModes();
    expect(storedDecisionModeSync('wake_triage')).toBe('shadow');
    expect(storedDecisionModeSync('sweep_triage')).toBe('act');
    expect(view.purposes.find(p => p.purpose === 'wake_triage')).toMatchObject({ effectivePrimary: 'laya:typed-decisions', mode: 'shadow' });
    // auto_route was off → its primary change demotes nothing but is still recorded.
    expect(view.purposes.find(p => p.purpose === 'auto_route')).toMatchObject({ effectivePrimary: 'deepseek-flash', mode: 'off' });
    const rows = mockRecordLoopMetric.mock.calls.map(c => c[0]).filter(r => r.kind === 'decision_gate_backend_changed');
    expect(rows).toEqual([
      expect.objectContaining({ value: 1, meta: expect.objectContaining({ field: 'primary', purpose: 'wake_triage', from: 'jev', to: 'laya:typed-decisions', demotedToShadow: true, updatedBy: 'admin-1' }) }),
      expect.objectContaining({ value: 0, meta: expect.objectContaining({ field: 'primary', purpose: 'auto_route', from: 'jev', to: 'deepseek-flash', demotedToShadow: false }) }),
    ]);
  });

  it('an env-only act (no store row) is demoted too — the store wins over env; a challenger-only change or a same-spec primary NEVER touches the modes row', async () => {
    process.env.DECISION_GATE_MODE_SWEEP_TRIAGE = 'act';
    await updateDecisionBackends({ purposes: { sweep_triage: { challengers: ['laya:typed-decisions'] } } }, 'u1');
    expect(mockStorePut.mock.calls.map(c => c[1])).toEqual(['backends']);
    expect(modesRow).toBeNull();
    const rows1 = mockRecordLoopMetric.mock.calls.map(c => c[0]);
    expect(rows1).toEqual([expect.objectContaining({ meta: expect.objectContaining({ field: 'challengers', purpose: 'sweep_triage', from: '', to: 'laya:typed-decisions', demotedToShadow: false }) })]);
    mockStorePut.mockClear();
    mockRecordLoopMetric.mockClear();
    // Re-stating the seat model as the primary is not a change.
    await updateDecisionBackends({ purposes: { sweep_triage: { primary: 'jev' } } }, 'u1');
    expect(mockStorePut.mock.calls.map(c => c[1])).toEqual(['backends']);
    expect(modesRow).toBeNull();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    mockStorePut.mockClear();
    // A real move under env-act writes the store row to shadow.
    await updateDecisionBackends({ purposes: { sweep_triage: { primary: 'deepseek-flash' } } }, 'u1');
    expect(mockStorePut.mock.calls.map(c => c[1])).toEqual(['backends', 'modes']);
    expect(modesRow.modes).toEqual({ sweep_triage: 'shadow' });
  });

  it('clearing a configured primary ("") on an act purpose is a primary change (back to the seat model) → demoted', async () => {
    backendsRow = { purposes: { wake_triage: { primary: 'laya:typed-decisions' } } };
    modesRow = { modes: { wake_triage: 'act' } };
    await updateDecisionBackends({ purposes: { wake_triage: { primary: '' } } }, 'u1');
    expect(modesRow.modes).toEqual({ wake_triage: 'shadow' });
    expect(modesRow.backendChanged).toEqual([{ purpose: 'wake_triage', from: 'laya:typed-decisions', to: 'jev' }]);
  });

  it('"promote challenger" is the documented PUT shape — primary ← the challenger, challengers ← (old − spec) ∪ [old primary]; act drops to shadow', async () => {
    backendsRow = { purposes: { wake_triage: { primary: 'jev', challengers: ['laya:typed-decisions', 'deepseek-flash'] } } };
    modesRow = { modes: { wake_triage: 'act' } };
    const old = normalizeStoredDecisionBackends(backendsRow).purposes.wake_triage!;
    const promoted = 'laya:typed-decisions';
    const view = await updateDecisionBackends({ purposes: { wake_triage: { primary: promoted, challengers: [...old.challengers!.filter(s => s !== promoted), old.primary!] } } }, 'u1');
    expect(backendsRow.purposes.wake_triage).toEqual({ primary: 'laya:typed-decisions', challengers: ['deepseek-flash', 'jev'] });
    expect(modesRow.modes).toEqual({ wake_triage: 'shadow' });
    const wt = view.purposes.find(p => p.purpose === 'wake_triage')!;
    expect(wt).toMatchObject({ effectivePrimary: 'laya:typed-decisions', effectiveChallengers: ['deepseek-flash', 'jev'], chain: ['laya:typed-decisions', 'jev', 'deepseek-flash'], mode: 'shadow' });
    // The old primary is now a challenger — the runtime subtracts the answering leg and caps at 2, so both still run.
    expect(challengerSpecsForPurpose(normalizeStoredDecisionBackends(backendsRow), 'wake_triage', 'laya:typed-decisions')).toEqual(['deepseek-flash', 'jev']);
  });

  it('when the modes row cannot be read on an act primary change, the backends row is still written and NO partial modes row is written (fail loudly, never drop other purposes\' modes)', async () => {
    process.env.DECISION_GATE_MODE_WAKE_TRIAGE = 'act';
    mockStoreGet.mockImplementation(async (_ns: string[], key: string) => { if (key === 'modes') throw new Error('db blip'); return key === 'backends' ? backendsRow : null; });
    await updateDecisionBackends({ purposes: { wake_triage: { primary: 'deepseek-flash' } } }, 'u1');
    expect(mockStorePut.mock.calls.map(c => c[1])).toEqual(['backends']);
    expect(backendsRow.purposes).toEqual({ wake_triage: { primary: 'deepseek-flash' } });
    const rows = mockRecordLoopMetric.mock.calls.map(c => c[0]);
    expect(rows).toEqual([expect.objectContaining({ meta: expect.objectContaining({ purpose: 'wake_triage', demotedToShadow: false }) })]);
  });
});

describe('plan D seam — resolveEffectivePrimarySpec + registerDecisionPrimaryResolver (the readiness stamp / admission pin)', () => {
  it('resolveEffectivePrimarySpec: the STORED primary (a fresh read) else the seat model; unknown purpose / no row / store failure → the seat model', async () => {
    backendsRow = { purposes: { wake_triage: { primary: 'laya:typed-decisions' } } };
    expect(await resolveEffectivePrimarySpec('wake_triage')).toBe('laya:typed-decisions');
    expect(await resolveEffectivePrimarySpec('auto_route')).toBe('jev');
    expect(await resolveEffectivePrimarySpec('probe')).toBe('jev');
    // A fresh read: a row change lands without a cache clear.
    backendsRow = { purposes: { wake_triage: { primary: 'deepseek-flash' } } };
    expect(await resolveEffectivePrimarySpec('wake_triage')).toBe('deepseek-flash');
    // The seat model when nothing is stored; a store failure fails open to it.
    mockResolveRoleModel.mockResolvedValue('deepseek-flash');
    backendsRow = null;
    expect(await resolveEffectivePrimarySpec('wake_triage')).toBe('deepseek-flash');
    clearDecisionBackendsConfigCache();
    mockStoreGet.mockImplementation(async () => { throw new Error('db down'); });
    expect(await resolveEffectivePrimarySpec('wake_triage')).toBe('deepseek-flash');
  });

  it('registerDecisionPrimaryResolver: hands resolveEffectivePrimarySpec to the hook (the core branch\'s decision-gate-modes setDecisionPrimaryResolver); the import-time probe is a no-op (false) while the modes module has no such export; a throwing hook never throws', async () => {
    const hook = jest.fn();
    expect(registerDecisionPrimaryResolver(hook)).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    const fn = hook.mock.calls[0][0] as (purpose: string) => Promise<string | undefined>;
    backendsRow = { purposes: { sweep_triage: { primary: 'vllm:Qwen/Qwen3-4B' } } };
    expect(await fn('sweep_triage')).toBe('vllm:Qwen/Qwen3-4B');
    expect(await fn('wake_triage')).toBe('jev');
    const modes = await import('./decision-gate-modes');
    const hookExists = typeof (modes as unknown as { setDecisionPrimaryResolver?: unknown }).setDecisionPrimaryResolver === 'function';
    expect(registerDecisionPrimaryResolver()).toBe(hookExists);
    expect(registerDecisionPrimaryResolver(() => { throw new Error('boom'); })).toBe(false);
  });
});

describe('Laya follow-up (2026-09-26) — detached challenger knobs', () => {
  it('grace defaults to 0 (detached); the timeout defaults to 20000 (audit 2026-10-06 T6-6; 5000 under DECISION_GATE_CHALLENGER_LONG_TIMEOUT_DISABLED=1) and clamps 500..60000', () => {
    expect(CHALLENGER_GRACE_DEFAULT_MS).toBe(0);
    expect(CHALLENGER_TIMEOUT_DEFAULT_MS).toBe(20_000);
    expect(challengerGraceMs()).toBe(0);
    expect(challengerTimeoutMs()).toBe(20_000);
    process.env.DECISION_GATE_CHALLENGER_LONG_TIMEOUT_DISABLED = '1';
    expect(challengerTimeoutMs()).toBe(5000);
    process.env.DECISION_GATE_CHALLENGER_TIMEOUT_MS = '7000';
    expect(challengerTimeoutMs()).toBe(7000); // an explicit value always wins
    delete process.env.DECISION_GATE_CHALLENGER_LONG_TIMEOUT_DISABLED;
    process.env.DECISION_GATE_CHALLENGER_TIMEOUT_MS = '2500';
    expect(challengerTimeoutMs()).toBe(2500);
    process.env.DECISION_GATE_CHALLENGER_TIMEOUT_MS = '10';
    expect(challengerTimeoutMs()).toBe(500);
    process.env.DECISION_GATE_CHALLENGER_TIMEOUT_MS = '1e9';
    expect(challengerTimeoutMs()).toBe(60_000);
    process.env.DECISION_GATE_CHALLENGER_TIMEOUT_MS = '-3';
    expect(challengerTimeoutMs()).toBe(20_000);
    process.env.DECISION_GATE_CHALLENGER_GRACE_MS = '75';
    expect(challengerGraceMs()).toBe(75);
  });
});

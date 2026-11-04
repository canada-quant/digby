/**
 * model-endpoints.controller — ADMIN gating for the Digby Edge registry REST
 * surface. Every handler must 403 a non-admin (or missing) user BEFORE
 * touching the service, and let an ADMIN through. Service layer is mocked.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockService = {
  listEndpoints: jest.fn(async () => []),
  getEndpoint: jest.fn(async (..._a: any[]): Promise<any> => null),
  createEndpoint: jest.fn(async (x: any) => ({ id: 'e1', ...x })),
  updateEndpoint: jest.fn(async (id: string) => ({ id })),
  deleteEndpoint: jest.fn(async () => true),
  testEndpointConnection: jest.fn(async () => ({ ok: true, models: [] })),
  probeEndpointModels: jest.fn(async () => ({ ok: true, models: [] })),
};
jest.mock('./model-endpoints.service', () => mockService);

const mockRolesService = {
  listModelRoles: jest.fn(async () => []),
  listProviderKeyStatus: jest.fn(() => []),
  listBuiltInModelInfo: jest.fn(async () => []),
  listFixedChains: jest.fn(() => []),
  updateModelRoles: jest.fn(async () => []),
  testModelRole: jest.fn(async () => ({ ok: true, target: 't', latencyMs: 1 })),
};
jest.mock('./model-roles.service', () => mockRolesService);

// Decision-gate mode store (WI-S, 2026-09-25) — same admin gate as the seats.
const mockDecisionModes = {
  getDecisionModeConfig: jest.fn(async () => ({ purposes: [], gateDisabled: false })),
  updateDecisionModes: jest.fn(async () => ({ purposes: [], gateDisabled: false })),
};
jest.mock('../platform/decision-gate-modes', () => mockDecisionModes);

// Flip-readiness stamp (E1, 2026-09-25) — read-only, same admin gate.
const mockDecisionReadiness = {
  getDecisionReadinessView: jest.fn(async () => ({ purposes: null, stampedAt: null, bars: { minLabels: 200 }, stampDisabled: false, howTo: 'x' })),
};
jest.mock('../platform/decision-gate-readiness', () => mockDecisionReadiness);

// DOI-17 (2026-09-28): the readiness GET composes the answering process's
// 401/403 auth-latch view from the gate core; mocked like its siblings (the
// real module boots axios + loop-metrics).
const latchView = { latches: [{ key: 'https://api.typesafe.ai::jev-1.13.0', spec: 'jev', backend: 'TypeSafe Jev', status: 403, since: '2026-09-28T10:00:00.000Z', at: '2026-09-28T10:00:00.000Z', until: '2026-09-28T10:01:30.000Z', holding: true, probing: false, relatches: 0, remainingMs: 60000 }], cooldownMs: 90000, scope: 'process', at: '2026-09-28T10:00:30.000Z' };
// Review 3c18284e (condition 6): the LEARNED typed-decision latch view + the unlatch write,
// mocked like the auth-latch view above.
const typedLatchView = { specs: [{ spec: 'cql-llm:agx-laya', firstSeenAt: '2026-10-20T22:00:00.000Z' }], max: 64, at: '2026-10-20T22:00:30.000Z' };
const mockDecisionGate = {
  decisionBackendLatchView: jest.fn((): any => latchView),
  typedDecisionLatchView: jest.fn((): any => typedLatchView),
  unlatchTypedDecisionSpec: jest.fn((_spec: string) => true),
  clearTypedDecisionLatch: jest.fn(),
  clearDecisionBackendCache: jest.fn(),
};
jest.mock('../platform/decision-gate', () => mockDecisionGate);

// Per-purpose primary + challenger backends (open-weight decision-model plan
// C/F, 2026-09-26) — same admin gate; the module boots loop-metrics/env lazily,
// but is mocked here like its siblings.
const backendsView = { config: { purposes: {} }, candidates: [{ spec: 'jev', kind: 'systemone', label: 'TypeSafe Jev', calibrated: true, servable: true }], purposes: [], seatModel: 'jev', seatFallback: '', challengerMax: 2, challengerGraceMs: 400 };
const mockDecisionBackends = {
  getDecisionBackendsConfig: jest.fn(async () => backendsView),
  updateDecisionBackends: jest.fn(async () => backendsView),
  // Integration seam (b): the controller hands this to the modes GET / PUT as `primarySpecFor`.
  resolveEffectivePrimarySpec: jest.fn(async (_purpose: string) => 'jev'),
};
jest.mock('../platform/decision-gate-backends', () => mockDecisionBackends);

// The verify handler's parse battery (2026-09-15). MUST be mocked: the real
// module eagerly imports model-roles.service's UNBOUNDED graph (error-handler
// → config/env, which process.exit(1)s in this env-less test process).
const mockVerifyEndpointModel = jest.fn(async (..._a: any[]): Promise<any> => ({ model: 'm', results: [] }));
jest.mock('./endpoint-verifier', () => ({
  __esModule: true,
  verifyEndpointModel: (...a: any[]) => mockVerifyEndpointModel(...a),
}));

// Auto pools (dynamic roster phase 1, 2026-10-03) — same admin gate; loaded lazily by the controller.
const poolsView = { pools: { quick: ['cql:tt-qwen3.8-27b'] } };
const mockAutoPools = {
  getAutoPoolsConfig: jest.fn(async () => poolsView),
  resolveEffectivePools: jest.fn(async () => ({ quick: { role: 'quick', models: ['cql:tt-qwen3.8-27b'], source: 'pool', dropped: [] } })),
  updateAutoPools: jest.fn(async () => poolsView),
  autoPoolsDisabled: jest.fn(() => false),
  POOL_ROLES: ['quick', 'lead', 'checker', 'colleague'],
  POOL_LABELS: { quick: 'Quick lane', lead: 'Lead', checker: 'Checker', colleague: 'Research colleagues' },
  POOL_SEATS: { quick: ['chat_quick'], lead: ['chat_orchestrator'], checker: ['double_checker'], colleague: ['double_checker', 'triple_checker'] },
  POOL_MAX_MODELS: 6,
};
jest.mock('./auto-pools.service', () => mockAutoPools);
const mockCatalog = { listChatModelCatalog: jest.fn(async () => [{ spec: 'cql:tt-qwen3.8-27b' }]) };
jest.mock('./model-catalog', () => mockCatalog);
// roster 2026-10-06 C-1: the GET carries the auto-pick policy.
jest.mock('../platform/roster-policy', () => ({ __esModule: true, autoPickPolicy: jest.fn(async () => 'all') }));
// F2 (2026-10-06 late): the reflection council's frontier list + default — same admin gate; loaded lazily.
const councilView = { config: { models: ['cql:api-xai-grok-5'] }, candidates: [{ spec: 'cql:api-xai-grok-5', family: 'grok', tier: 'standard', priceIn: null, priceOut: null }], defaults: ['cql:api-xai-grok-5'], source: 'admin', dropped: [] };
const mockCouncil = {
  resolveReflectionCouncil: jest.fn(async () => councilView),
  updateReflectionCouncil: jest.fn(async () => councilView.config),
  REFLECTION_COUNCIL_MAX: 3,
};
jest.mock('./reflection-council.service', () => mockCouncil);

import controller from './model-endpoints.controller';

const mkReq = (role?: string): any => ({
  user: role ? { id: 'u1', userId: 'u1', email: 'a@b.c', role } : undefined,
  params: { id: 'e1' },
  body: {},
});

const mkRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const next = jest.fn();

beforeEach(() => jest.clearAllMocks());

const handlers = ['list', 'create', 'update', 'remove', 'test', 'probe', 'verify', 'roles', 'updateRoles', 'testRole', 'decisionModes', 'updateDecisionModes', 'decisionReadiness', 'decisionBackends', 'updateDecisionBackends', 'autoPools', 'updateAutoPools', 'reflectionCouncil', 'updateReflectionCouncil'] as const;
const allServiceFns = () => [...Object.values(mockService), ...Object.values(mockRolesService), ...Object.values(mockDecisionModes), ...Object.values(mockDecisionReadiness), ...Object.values(mockDecisionBackends), mockAutoPools.getAutoPoolsConfig, mockAutoPools.resolveEffectivePools, mockAutoPools.updateAutoPools, mockCatalog.listChatModelCatalog, mockVerifyEndpointModel, mockCouncil.resolveReflectionCouncil, mockCouncil.updateReflectionCouncil];

describe('admin gating', () => {
  for (const h of handlers) {
    it(`${h}: 403 for a non-admin, service never called`, async () => {
      const res = mkRes();
      await (controller as any)[h](mkReq('USER'), res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden: admin access required' });
      expect(next).not.toHaveBeenCalled();
      for (const fn of allServiceFns()) expect(fn).not.toHaveBeenCalled();
    });

    it(`${h}: 403 when req.user is missing entirely`, async () => {
      const res = mkRes();
      await (controller as any)[h](mkReq(undefined), res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      for (const fn of allServiceFns()) expect(fn).not.toHaveBeenCalled();
    });
  }
});

describe('verify handler (per-model parse battery, 2026-09-15)', () => {
  const endpoint = { id: 'e1', label: 'nebius-b300', models: [{ id: 'Qwen/Qwen3-32B' }] };

  it('404s an unknown endpoint id — the verifier never runs', async () => {
    mockService.getEndpoint.mockResolvedValueOnce(null);
    const res = mkRes();
    const req = { ...mkReq('ADMIN'), body: { modelId: 'Qwen/Qwen3-32B' } };
    await (controller as any).verify(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Model endpoint not found' });
    expect(mockVerifyEndpointModel).not.toHaveBeenCalled();
  });

  it('400s a modelId that is not registered on the endpoint (and an empty one)', async () => {
    mockService.getEndpoint.mockResolvedValue(endpoint);
    const res = mkRes();
    const req = { ...mkReq('ADMIN'), body: { modelId: 'Qwen/Qwen3-Embedding-8B' } };
    await (controller as any).verify(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Model "Qwen/Qwen3-Embedding-8B" is not registered on endpoint "nebius-b300".' });
    expect(mockVerifyEndpointModel).not.toHaveBeenCalled();
    // An absent modelId 400s the same way (never builds a dangling spec).
    const res2 = mkRes();
    await (controller as any).verify({ ...mkReq('ADMIN'), body: {} }, res2, next);
    expect(res2.status).toHaveBeenCalledWith(400);
    expect(mockVerifyEndpointModel).not.toHaveBeenCalled();
  });

  it("runs the battery on '<label>:<modelId>' and returns the success envelope", async () => {
    mockService.getEndpoint.mockResolvedValue(endpoint);
    const battery = { model: 'nebius-b300:Qwen/Qwen3-32B', results: [{ shape: 'chat_stream', ok: true, latencyMs: 12 }] };
    mockVerifyEndpointModel.mockResolvedValueOnce(battery);
    const res = mkRes();
    const req = { ...mkReq('ADMIN'), body: { modelId: 'Qwen/Qwen3-32B' } };
    await (controller as any).verify(req, res, next);
    expect(mockService.getEndpoint).toHaveBeenCalledWith('e1');
    expect(mockVerifyEndpointModel).toHaveBeenCalledWith('nebius-b300:Qwen/Qwen3-32B');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: battery });
  });

  it('verifier errors (e.g. the AppError(400) for an unresolvable spec) flow to next(error)', async () => {
    mockService.getEndpoint.mockResolvedValue(endpoint);
    const err = new Error('does not resolve');
    mockVerifyEndpointModel.mockRejectedValueOnce(err);
    const res = mkRes();
    const req = { ...mkReq('ADMIN'), body: { modelId: 'Qwen/Qwen3-32B' } };
    await (controller as any).verify(req, res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('model roles handlers (ADMIN)', () => {
  it('roles returns the success envelope', async () => {
    const res = mkRes();
    await controller.roles(mkReq('ADMIN'), res, next);
    expect(mockRolesService.listModelRoles).toHaveBeenCalledWith('u1');
    // 2026-09-22: the envelope also carries the read-only model map (built-ins + fixed chains).
    // 2026-09-27 (audit E3 + review fixer): + the seat-governance flag — true by default
    // (observe-only); false only under the opt-in FRONTIER_SEATS_REFUSE=1.
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { roles: [], providerKeys: [], builtIns: [], chains: [], governance: { frontierSeatsAllowed: true } } });
  });

  it('updateRoles hands the body roles map to the service (09a03aef: plus the advisory save-warnings collector)', async () => {
    const res = mkRes();
    const req = mkReq('ADMIN');
    req.body = { roles: { coding_helper: 'my-ollama:qwen3:32b' } };
    await controller.updateRoles(req, res, next);
    expect(mockRolesService.updateModelRoles).toHaveBeenCalledWith({ coding_helper: 'my-ollama:qwen3:32b' }, 'u1', { fallbacks: {}, warnings: [] });
  });

  it('decisionModes returns the store/env/effective view; updateDecisionModes hands the modes map + admin id to the store (WI-S)', async () => {
    const res = mkRes();
    await controller.decisionModes(mkReq('ADMIN'), res, next);
    expect(mockDecisionModes.getDecisionModeConfig).toHaveBeenCalledTimes(1);
    // Integration seam (b) (2026-09-26): the GET / PUT carry the effective-primary resolver so admission
    // refuses act when the READY stamp was measured on another backend.
    const getOpts = (mockDecisionModes.getDecisionModeConfig as jest.Mock).mock.calls[0][0];
    expect(typeof getOpts?.primarySpecFor).toBe('function');
    await expect(getOpts.primarySpecFor('wake_triage')).resolves.toBe('jev');
    expect(mockDecisionBackends.resolveEffectivePrimarySpec).toHaveBeenCalledWith('wake_triage');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { purposes: [], gateDisabled: false } });
    const res2 = mkRes();
    const req = mkReq('ADMIN');
    req.body = { modes: { wake_triage: 'act', self_audit: '' } };
    await controller.updateDecisionModes(req, res2, next);
    expect(mockDecisionModes.updateDecisionModes).toHaveBeenCalledWith({ wake_triage: 'act', self_audit: '' }, 'u1', expect.objectContaining({ primarySpecFor: expect.any(Function) }));
    expect(res2.json).toHaveBeenCalledWith({ success: true, data: { purposes: [], gateDisabled: false } });
  });

  it('decisionReadiness returns the flip-readiness stamp view (E1) + the process latch view (DOI-17) + the LEARNED typed-decision latch view (3c18284e) — read-only, nothing else touched', async () => {
    const res = mkRes();
    await controller.decisionReadiness(mkReq('ADMIN'), res, next);
    expect(mockDecisionReadiness.getDecisionReadinessView).toHaveBeenCalledTimes(1);
    expect(mockDecisionGate.decisionBackendLatchView).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { purposes: null, stampedAt: null, bars: { minLabels: 200 }, stampDisabled: false, howTo: 'x', latches: latchView, typedDecisionLatched: typedLatchView } });
    for (const fn of [...Object.values(mockService), ...Object.values(mockRolesService), ...Object.values(mockDecisionModes)]) expect(fn).not.toHaveBeenCalled();
  });

  it('clearTypedDecisionLatch: { spec } unlatches ONE learned spec (cleared:true); {} forgets ALL (all:true) — both drop the cached chains and return the remaining view (3c18284e)', async () => {
    const res = mkRes();
    const req = mkReq('ADMIN');
    req.body = { spec: 'cql-llm:agx-laya' };
    await controller.clearTypedDecisionLatch(req, res, next);
    expect(mockDecisionGate.unlatchTypedDecisionSpec).toHaveBeenCalledWith('cql-llm:agx-laya');
    expect(mockDecisionGate.clearTypedDecisionLatch).not.toHaveBeenCalled();
    expect(mockDecisionGate.clearDecisionBackendCache).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { cleared: true, remaining: typedLatchView } });
    const res2 = mkRes();
    await controller.clearTypedDecisionLatch(mkReq('ADMIN'), res2, next);
    expect(mockDecisionGate.clearTypedDecisionLatch).toHaveBeenCalledTimes(1);
    expect(res2.json).toHaveBeenCalledWith({ success: true, data: { cleared: false, all: true, remaining: typedLatchView } });
  });

  it('decisionBackends returns the { config, candidates, purposes } view; updateDecisionBackends hands the body + admin id to the store; errors flow to next (plan C/F 2026-09-26)', async () => {
    const res = mkRes();
    await controller.decisionBackends(mkReq('ADMIN'), res, next);
    expect(mockDecisionBackends.getDecisionBackendsConfig).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: backendsView });
    expect(res.json.mock.calls[0][0].data).toEqual(expect.objectContaining({ config: expect.any(Object), candidates: expect.any(Array), purposes: expect.any(Array) }));
    const res2 = mkRes();
    const req = mkReq('ADMIN');
    // The documented "promote challenger" shape rides through untouched.
    req.body = { purposes: { wake_triage: { primary: 'laya:typed-decisions', challengers: ['deepseek-flash', 'jev'] } }, defaultChallengers: ['jev'] };
    await controller.updateDecisionBackends(req, res2, next);
    expect(mockDecisionBackends.updateDecisionBackends).toHaveBeenCalledWith(req.body, 'u1');
    expect(res2.json).toHaveBeenCalledWith({ success: true, data: backendsView });
    // A missing body is an empty patch (the service 400s it) — never a crash.
    const res3 = mkRes();
    const req3 = mkReq('ADMIN');
    req3.body = undefined;
    await controller.updateDecisionBackends(req3, res3, next);
    expect(mockDecisionBackends.updateDecisionBackends).toHaveBeenLastCalledWith({}, 'u1');
    const err = Object.assign(new Error('Unknown decision-gate purpose "nope"'), { statusCode: 400 });
    mockDecisionBackends.updateDecisionBackends.mockRejectedValueOnce(err);
    const res4 = mkRes();
    await controller.updateDecisionBackends(mkReq('ADMIN'), res4, next);
    expect(next).toHaveBeenCalledWith(err);
    for (const fn of [...Object.values(mockService), ...Object.values(mockRolesService), ...Object.values(mockDecisionModes), ...Object.values(mockDecisionReadiness)]) expect(fn).not.toHaveBeenCalled();
  });

  it('testRole passes role + candidate model through', async () => {
    const res = mkRes();
    const req = mkReq('ADMIN');
    req.body = { role: 'embeddings', model: 'my-ollama:nomic-embed' };
    await controller.testRole(req, res, next);
    expect(mockRolesService.testModelRole).toHaveBeenCalledWith('embeddings', 'my-ollama:nomic-embed', { fallback: false });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ok: true, target: 't', latencyMs: 1 } });
  });
});

describe('ADMIN passes through', () => {
  it('list returns the success envelope', async () => {
    const res = mkRes();
    await controller.list(mkReq('ADMIN'), res, next);
    expect(mockService.listEndpoints).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { endpoints: [] } });
  });

  it('create returns 201 + the created endpoint', async () => {
    const res = mkRes();
    await controller.create(mkReq('ADMIN'), res, next);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockService.createEndpoint).toHaveBeenCalledTimes(1);
  });

  it('remove 404s when the id does not exist', async () => {
    mockService.deleteEndpoint.mockResolvedValueOnce(false);
    const res = mkRes();
    await controller.remove(mkReq('ADMIN'), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('probe passes the draft body through to the service', async () => {
    const res = mkRes();
    const req = { ...mkReq('ADMIN'), body: { baseUrl: 'http://x/v1', endpointId: 'e1' } };
    await controller.probe(req, res, next);
    expect(mockService.probeEndpointModels).toHaveBeenCalledWith({ baseUrl: 'http://x/v1', endpointId: 'e1' });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { ok: true, models: [] } });
  });

  it('service errors flow to next(error)', async () => {
    const err = new Error('boom');
    mockService.listEndpoints.mockRejectedValueOnce(err);
    const res = mkRes();
    await controller.list(mkReq('ADMIN'), res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('reflection council (F2, owner 2026-10-06 late)', () => {
  it('GET returns the frontier candidates, the stored list, the effective default and the run bounds', async () => {
    const res = mkRes();
    await (controller as any).reflectionCouncil(mkReq('ADMIN'), res, next);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ config: councilView.config, defaults: ['cql:api-xai-grok-5'], source: 'admin', maxModels: 3, disabled: false, maxPerRun: 2, sessionDailyCap: 6 });
    expect(mockCouncil.resolveReflectionCouncil).toHaveBeenCalledWith([{ spec: 'cql:tt-qwen3.8-27b' }]);
  });
  it('PUT passes the list, the admin id and the catalog; a refused save flows to next(error)', async () => {
    const res = mkRes();
    await (controller as any).updateReflectionCouncil({ ...mkReq('ADMIN'), body: { models: ['cql:api-xai-grok-5'] } }, res, next);
    expect(mockCouncil.updateReflectionCouncil).toHaveBeenCalledWith(['cql:api-xai-grok-5'], 'u1', [{ spec: 'cql:tt-qwen3.8-27b' }]);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: true, data: { defaults: ['cql:api-xai-grok-5'] } });
    const err = Object.assign(new Error('Reflection council not saved: glm-5.3: not a frontier-class model'), { statusCode: 400 });
    mockCouncil.updateReflectionCouncil.mockRejectedValueOnce(err);
    await (controller as any).updateReflectionCouncil({ ...mkReq('ADMIN'), body: { models: ['glm-5.3'] } }, mkRes(), next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('auto pools (dynamic roster phase 1, 2026-10-03)', () => {
  it('GET returns the stored + effective pools, the catalog and the role table', async () => {
    const res = mkRes();
    await (controller as any).autoPools(mkReq('ADMIN'), res, next);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ config: poolsView, catalog: [{ spec: 'cql:tt-qwen3.8-27b' }], maxModels: 6, disabled: false, autoPickPolicy: 'all' });
    expect(body.data.roles.map((r: any) => r.role)).toEqual(['quick', 'lead', 'checker', 'colleague']);
    expect(body.data.effective.quick.source).toBe('pool');
  });
  it('PUT passes the pools patch, the admin id and the catalog to the service', async () => {
    const res = mkRes();
    const req = { ...mkReq('ADMIN'), body: { pools: { quick: ['cql:tt-qwen3.8-27b'] } } };
    await (controller as any).updateAutoPools(req, res, next);
    expect(mockAutoPools.updateAutoPools).toHaveBeenCalledWith({ quick: ['cql:tt-qwen3.8-27b'] }, 'u1', [{ spec: 'cql:tt-qwen3.8-27b' }]);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: true, data: { config: poolsView } });
  });
  it('a refused save (AppError 400) flows to next(error)', async () => {
    const err = Object.assign(new Error('Auto pools not saved: …'), { statusCode: 400 });
    mockAutoPools.updateAutoPools.mockRejectedValueOnce(err);
    const res = mkRes();
    await (controller as any).updateAutoPools({ ...mkReq('ADMIN'), body: { pools: { lead: ['x'] } } }, res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

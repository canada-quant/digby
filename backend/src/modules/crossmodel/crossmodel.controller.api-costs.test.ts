/**
 * GET /api/crossmodel/admin/api-costs (ticket e553c81b) — endpoint tests.
 *
 * The legacy panel counted chat-message meta.models entries at hardcoded flat
 * per-call prices and synthesized a `modelCounts['moonshot'] = totalMessages`
 * row the frontend labeled 'Synthesis (Claude)' — bogus on both ends (Claude
 * is used nowhere; the synthesis seat is Kimi K3) and blind to coding-session
 * spend entirely. The rewrite serves the REAL telemetry: loop_metrics
 * run_spend (recorded $ per finalized run) + run_tokens_in/out (recorded
 * tokens per model), aggregated per-model (list-price estimate via the coding
 * cost table), per-surface (meta.profile), per-trigger (meta.triggerKind) and
 * per-user (the proven sessionId → crossmodel_chats.userId join), with custom
 * Edge endpoints ('<label>:<modelId>') token-tracked and flagged. Chat query
 * volume (message counts) is kept — that part was always truthful.
 *
 * The controller's import graph is mocked exactly like
 * crossmodel.controller.loop-metrics.test.ts; prisma is a scripted boundary
 * (config/database mock). turnCostUsd runs REAL (leaf math module).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

const mockMsgFindMany = jest.fn();
const mockUserFindMany = jest.fn();
const mockQueryRaw = jest.fn();
// audit 2026-10-08 W3-4: the registry read behind the bare-id → spec fold.
const mockEndpointFindMany: jest.Mock = jest.fn(async () => []);
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelMessage: { findMany: (...a: any[]) => mockMsgFindMany(...a) },
    user: { findMany: (...a: any[]) => mockUserFindMany(...a) },
    modelEndpoint: { findMany: (...a: any[]) => mockEndpointFindMany(...a) },
    $queryRaw: (...a: any[]) => mockQueryRaw(...a),
  },
}));

jest.mock('./crossmodel.service', () => ({ __esModule: true, default: {} }));
// build 2026-10-08 Q-1: every custom spec's registry price is resolved (it wins over the family list price).
const mockResolveRegistryModel: jest.Mock = jest.fn(async () => null);
jest.mock('./model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(),
  combineAttachments: jest.fn(() => null),
}));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({
  streamKidResponse: jest.fn(),
  generateKidStatus: jest.fn(),
}));
jest.mock('./mcp-search', () => ({ searchWithBrightData: jest.fn() }));
jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: jest.fn(), mapAttachmentForAgent: jest.fn(),
  chatWriteAccessGranted: jest.fn(), chatReadAccessGranted: jest.fn(), streamAccessDeniedError: jest.fn(),
}));
jest.mock('./integration-context', () => ({ buildIntegrationContext: jest.fn(async () => ({ additionalContext: undefined, imessagePairedAgentId: null })), buildIntegrationContextBounded: jest.fn(async (build) => build()) }));
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(), reserveDeepResearchQuota: jest.fn(), getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
}));
jest.mock('./coding/coding-data.service', () => ({ getChatCapability: jest.fn() }));
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({
  attachRemoteChatRun: jest.fn(),
  replayFinishedRemoteRun: jest.fn(async () => false),
}));
jest.mock('./coding/coding-stream.controller', () => ({
  __esModule: true,
  default: { streamRun: jest.fn() },
}));
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  queryLoopMetrics: jest.fn(),
  summarizeLoopMetrics: jest.fn(),
}));

import controller from './crossmodel.controller';

const mkReq = (user: any, query: Record<string, string> = {}): any => ({ user, query });
const mkRes = (): any => {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    status: jest.fn((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn((b: any) => { res.body = b; return res; }),
  };
  return res;
};

const ADMIN = { id: 'u-admin', role: 'ADMIN', email: 'admin@digby.ai' };
const OWNER = { id: 'u-paul', role: 'USER', email: 'example-user@example.com' };
const MORTAL = { id: 'u-user', role: 'USER', email: 'user@digby.ai' };

/** The three canned $queryRaw result sets, in the endpoint's call order (Promise.all position).
 *  2026-09-28: the queue is RESET first (jest.clearAllMocks never drops queued once-values — the old
 *  arithmetic only balanced by accident) and every later $queryRaw (the decision-gate block's own
 *  seven queries, decision-gate-spend.ts) answers [] — an empty decision block, never a leftover seed. */
const seedRaw = (opts?: { empty?: boolean }) => {
  mockQueryRaw.mockReset();
  mockQueryRaw.mockResolvedValue([]);
  if (opts?.empty) {
    mockQueryRaw
      .mockResolvedValueOnce([])  // token rows
      .mockResolvedValueOnce([])  // spend split rows
      .mockResolvedValueOnce([]); // per-user rows
    return;
  }
  mockQueryRaw
    .mockResolvedValueOnce([
      { model: 'glm-5.3', kind: 'run_tokens_in', tokens: 1_000_000, estimated: false, runs: 3 },
      { model: 'glm-5.3', kind: 'run_tokens_out', tokens: 200_000, estimated: false, runs: 3 },
      { model: 'kimi-k3', kind: 'run_tokens_in', tokens: 500_000, estimated: true, runs: 2 },
      { model: 'kimi-k3', kind: 'run_tokens_out', tokens: 100_000, estimated: true, runs: 2 },
      { model: 'nebius-b300:glm-5.3', kind: 'run_tokens_in', tokens: 10_000, estimated: false, runs: 1 },
      { model: 'nebius-b300:glm-5.3', kind: 'run_tokens_out', tokens: 2_000, estimated: false, runs: 1 },
    ])
    .mockResolvedValueOnce([
      { profile: 'coding', trigger_kind: 'user', usd: 10.0 },
      { profile: 'chat', trigger_kind: 'user', usd: 2.5 },
      { profile: 'chat_research', trigger_kind: 'machine', usd: 0.5 },
      { profile: 'coding', trigger_kind: 'machine', usd: 1.0 },
      { profile: 'coding', trigger_kind: 'schedule', usd: 3.0 },
      { profile: 'coding', trigger_kind: 'hook', usd: 0.75 },
      { profile: 'coding', trigger_kind: 'bogus-unexpected', usd: 0.25 }, // unknown kinds default to user
    ])
    .mockResolvedValueOnce([
      { user_id: 'u1', profile: 'coding', usd: 9.0 },
      { user_id: 'u1', profile: 'chat', usd: 2.0 },
      { user_id: 'u2', profile: 'coding', usd: 2.0 },
      { user_id: null, profile: 'coding', usd: 1.0 }, // soft-ref orphan (deleted chat)
    ]);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMsgFindMany.mockResolvedValue([
    { metadata: { models: { digby: { response: 'x' } }, mode: 'thinking' }, createdAt: new Date('2026-09-20T10:00:00Z') },
    { metadata: { models: { digby: { response: 'y' }, double_checker: { response: 'z' } }, mode: 'fast' }, createdAt: new Date('2026-09-20T11:00:00Z') },
    { metadata: { models: { digby: { response: 'w' } }, mode: 'thinking' }, createdAt: new Date('2026-09-21T09:00:00Z') },
    { metadata: { noModels: true }, createdAt: new Date('2026-09-21T09:30:00Z') }, // skipped — no meta.models
  ]);
  mockUserFindMany.mockResolvedValue([
    { id: 'u1', email: 'alice@example.com', name: null },
    { id: 'u2', email: null, name: 'Bob' },
  ]);
  seedRaw();
});

describe('getAdminApiCosts — admin posture (mirrors /admin/loop-metrics)', () => {
  it('403s an anonymous request before touching the DB', async () => {
    const res = mkRes();
    await controller.getAdminApiCosts(mkReq(undefined), res);
    expect(res.statusCode).toBe(403);
    expect(mockMsgFindMany).not.toHaveBeenCalled();
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('403s a non-admin user', async () => {
    const res = mkRes();
    await controller.getAdminApiCosts(mkReq(MORTAL), res);
    expect(res.statusCode).toBe(403);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('admits role ADMIN and the owner email alike', async () => {
    for (const user of [ADMIN, OWNER]) {
      jest.clearAllMocks();
      mockMsgFindMany.mockResolvedValue([]);
      seedRaw({ empty: true });
      const res = mkRes();
      await controller.getAdminApiCosts(mkReq(user), res);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    }
  });
});

describe('getAdminApiCosts — real-spend contract (ticket e553c81b)', () => {
  it('aggregates recorded spend per-model / per-surface / per-trigger / per-user — no synthesized rows, no flat per-call prices', async () => {
    const res = mkRes();
    await controller.getAdminApiCosts(mkReq(ADMIN, { days: '60' }), res);
    expect(res.statusCode).toBe(200);
    const d = res.body.data;

    // The spend window clamps at the 30-day telemetry retention even when the
    // message-count window is longer.
    expect(d.days).toBe(60);
    expect(d.spendWindowDays).toBe(30);
    expect(d.spendRecordedSince).toBe('2026-09-13');

    // Headline total = the RECORDED run_spend sum; splits follow meta.profile
    // and meta.triggerKind — all FOUR stamped kinds bucket separately
    // (user/machine/schedule/hook); an unexpected kind defaults to user.
    expect(d.totalSpendUsd).toBe(18);
    // 2026-09-28: the decision gate's own bucket rides both splits (0 here — no profile 'decision' rows seeded).
    expect(d.surfaceSpend).toEqual({ coding: 15, chat: 3, chatResearch: 0.5, decision: 0 });
    expect(d.triggerSpend).toEqual({ user: 12.75, machine: 1.5, schedule: 3, hook: 0.75, decision: 0 });

    // Per-model rows carry RECORDED tokens (never call counts), a list-price
    // estimate, and the custom-endpoint flag — sorted by estimate desc.
    expect(d.models).toHaveLength(3);
    for (let i = 1; i < d.models.length; i++) {
      expect(d.models[i - 1].listCostUsd).toBeGreaterThanOrEqual(d.models[i].listCostUsd);
    }
    const byName: Record<string, any> = Object.fromEntries(d.models.map((m: any) => [m.model, m]));
    const glm = byName['glm-5.3'];
    const kimi = byName['kimi-k3'];
    const edge = byName['nebius-b300:glm-5.3'];
    expect(glm.model).toBe('glm-5.3');
    expect(glm.inTokens).toBe(1_000_000);
    expect(glm.outTokens).toBe(200_000);
    expect(glm.runs).toBe(3);
    expect(glm.custom).toBe(false);
    expect(glm.estimated).toBe(false);
    expect(glm.listCostUsd).toBeGreaterThan(0);
    expect(kimi.model).toBe('kimi-k3');
    expect(kimi.inTokens).toBe(500_000);
    expect(kimi.estimated).toBe(true); // one estimated turn flags the model
    expect(edge.model).toBe('nebius-b300:glm-5.3');
    expect(edge.custom).toBe(true); // '<label>:<modelId>' — token-tracked, generic price
    expect(edge.listCostUsd).toBeGreaterThan(0);
    // Orders-of-magnitude fewer tokens → the custom row is the cheapest.
    expect(edge.listCostUsd).toBeLessThan(glm.listCostUsd);
    expect(edge.listCostUsd).toBeLessThan(kimi.listCostUsd);

    // Per-user rollup: sorted by spend, email-resolved, orphan rows kept as an
    // explicit bucket, chat_research folded into chat.
    expect(d.perUser).toHaveLength(3);
    expect(d.perUser[0]).toEqual({ userId: 'u1', email: 'alice@example.com', totalUsd: 11, codingUsd: 9, chatUsd: 2 });
    expect(d.perUser[1]).toEqual({ userId: 'u2', email: 'Bob', totalUsd: 2, codingUsd: 2, chatUsd: 0 });
    expect(d.perUser[2]).toEqual({ userId: null, email: '(deleted chat)', totalUsd: 1, codingUsd: 1, chatUsd: 0 });

    // The legacy fabrications are GONE from the payload.
    expect(d).not.toHaveProperty('modelCounts');
    expect(d).not.toHaveProperty('costByModel');
    expect(d).not.toHaveProperty('totalEstimatedCost');
    expect(JSON.stringify(d)).not.toContain('Claude');
    expect(JSON.stringify(d.models)).not.toContain('moonshot');

    // Chat query volume stays truthful: messages WITH meta.models counted,
    // mode distribution + daily totals (no per-model keys anymore).
    expect(d.totalMessages).toBe(3);
    expect(d.modeCounts).toEqual({ fast: 1, thinking: 2, deep_research: 0, deep_research_all: 0 });
    expect(d.dailyTrend).toEqual([
      { date: '2026-09-20', total: 2 },
      { date: '2026-09-21', total: 1 },
    ]);
  });

  it('empty telemetry → zeroed spend sections, still 200', async () => {
    jest.clearAllMocks();
    mockMsgFindMany.mockResolvedValue([]);
    seedRaw({ empty: true });
    const res = mkRes();
    await controller.getAdminApiCosts(mkReq(ADMIN), res);
    expect(res.statusCode).toBe(200);
    const d = res.body.data;
    expect(d.days).toBe(30);
    expect(d.totalSpendUsd).toBe(0);
    expect(d.models).toEqual([]);
    expect(d.perUser).toEqual([]);
    expect(d.surfaceSpend).toEqual({ coding: 0, chat: 0, chatResearch: 0, decision: 0 });
    expect(d.triggerSpend).toEqual({ user: 0, machine: 0, schedule: 0, hook: 0, decision: 0 });
    // 2026-09-28: the decision-gate block is always present (empty here), with the Jev list price it prices at.
    expect(d.decisionGate).toMatchObject({ windowDays: 30, totals: { calls: 0, pricedCalls: 0, memoHits: 0, inputTokens: 0, usd: 0 }, byBackend: [], byPurpose: [], replaced: [] });
    expect(d.decisionGate.pricing.typesafe).toMatchObject({ usdPerMTokIn: 0.042, usdPerMTokOut: 0, source: 'list' });
    expect(d.totalMessages).toBe(0);
    expect(d.dailyTrend).toEqual([]);
  });

  it('a DB failure → 500 with the generic error (never a leak)', async () => {
    jest.clearAllMocks();
    mockMsgFindMany.mockRejectedValue(new Error('pg: connection reset by peer — secret conninfo'));
    const res = mkRes();
    await controller.getAdminApiCosts(mkReq(ADMIN), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to get API cost data' });
  });
});

describe('getAdminApiCosts — prompt cache + one model name (audit 2026-10-08 W3-2 / W3-4)', () => {
  afterEach(() => { delete process.env.SPEND_MODEL_KEY_NORMALIZE_DISABLED; mockEndpointFindMany.mockResolvedValue([]); });
  const seedGateway = () => {
    mockQueryRaw.mockReset();
    mockQueryRaw.mockResolvedValue([]);
    mockQueryRaw
      // REPLAY of the 10-08 shape: coding rows under the bare id, chat rows under the spec, cached share recorded.
      .mockResolvedValueOnce([
        { model: 'api-optimize-zai-glm-5.3', kind: 'run_tokens_in', tokens: 8_000_000, cached: 6_000_000, estimated: false, runs: 25 },
        { model: 'api-optimize-zai-glm-5.3', kind: 'run_tokens_out', tokens: 80_000, cached: 0, estimated: false, runs: 25 },
        { model: 'cql-litellm:api-optimize-zai-glm-5.3', kind: 'run_tokens_in', tokens: 2_000_000, cached: 1_000_000, estimated: false, runs: 38 },
        { model: 'cql-litellm:api-optimize-zai-glm-5.3', kind: 'run_tokens_out', tokens: 20_000, cached: 0, estimated: false, runs: 38 },
        { model: 'glm-5.3', kind: 'run_tokens_in', tokens: 1_000_000, cached: 0, estimated: false, runs: 3 },
      ])
      .mockResolvedValueOnce([{ profile: 'coding', trigger_kind: 'user', usd: 1 }])
      .mockResolvedValueOnce([]);
    // every later $queryRaw answers [] except the per-profile cache read (matched by its SQL text)
    mockQueryRaw.mockImplementation(async (strings: any) => {
      const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
      if (sql.includes("? 'inTokens'")) return [{ profile: 'coding', runs: 25, in_tokens: 8_000_000, cached: 6_000_000 }, { profile: 'chat', runs: 38, in_tokens: 2_000_000, cached: 1_000_000 }];
      return [];
    });
  };

  it('folds the bare id into the ONE endpoint spec that serves it, and reports the cache-hit % per model and per profile', async () => {
    seedGateway();
    mockEndpointFindMany.mockResolvedValue([{ label: 'cql-litellm', enabled: true, models: [{ id: 'api-optimize-zai-glm-5.3' }, { id: 'glm-5.3' }] }]);
    const res = mkRes();
    await controller.getAdminApiCosts(mkReq(ADMIN), res);
    expect(res.statusCode).toBe(200);
    const d = res.body.data;
    const names = d.models.map((m: any) => m.model).sort();
    expect(names).toEqual(['cql-litellm:api-optimize-zai-glm-5.3', 'glm-5.3']); // ONE line for the gateway model
    const gw = d.models.find((m: any) => m.model === 'cql-litellm:api-optimize-zai-glm-5.3');
    expect(gw).toMatchObject({ inTokens: 10_000_000, outTokens: 100_000, cachedTokens: 7_000_000, cacheHitPct: 70, runs: 63, custom: true });
    expect(d.models.find((m: any) => m.model === 'glm-5.3')).toMatchObject({ cacheHitPct: 0, runs: 3 }); // a built-in id is never folded
    expect(d.promptCacheByProfile).toEqual([
      { profile: 'coding', runs: 25, inTokens: 8_000_000, cachedTokens: 6_000_000, cacheHitPct: 75 },
      { profile: 'chat', runs: 38, inTokens: 2_000_000, cachedTokens: 1_000_000, cacheHitPct: 50 },
    ]);
  });

  it('build 2026-10-08 Q-1: the gateway row prices at its FAMILY list price, cache-aware, and says so; a registry price wins', async () => {
    seedGateway();
    mockEndpointFindMany.mockResolvedValue([{ label: 'cql-litellm', enabled: true, models: [{ id: 'api-optimize-zai-glm-5.3' }] }]);
    mockResolveRegistryModel.mockResolvedValue(null);
    let res = mkRes();
    await controller.getAdminApiCosts(mkReq(ADMIN), res);
    let gw = res.body.data.models.find((m: any) => m.model === 'cql-litellm:api-optimize-zai-glm-5.3');
    // 3M uncached × $1.40 + 7M cached × $0.26 + 0.1M out × $4.40 (Z.ai list) — was $6.24 at the $0.60 / $2.40 default, cache ignored
    expect(gw).toMatchObject({ priceSource: 'family:glm-5.3', listCostUsd: 6.46 });
    expect(mockResolveRegistryModel).toHaveBeenCalledWith('cql-litellm:api-optimize-zai-glm-5.3');
    expect(res.body.data.models.find((m: any) => m.model === 'glm-5.3')).toMatchObject({ priceSource: 'builtin', listCostUsd: 1.4 });
    seedGateway();
    mockResolveRegistryModel.mockResolvedValue({ usdPerMTokIn: 1, usdPerMTokOut: 2 });
    res = mkRes();
    await controller.getAdminApiCosts(mkReq(ADMIN), res);
    gw = res.body.data.models.find((m: any) => m.model === 'cql-litellm:api-optimize-zai-glm-5.3');
    expect(gw).toMatchObject({ priceSource: 'registry', listCostUsd: 10.2 });
    mockResolveRegistryModel.mockResolvedValue(null);
  });

  it('kill switch SPEND_MODEL_KEY_NORMALIZE_DISABLED=1: no fold (two lines, as recorded)', async () => {
    process.env.SPEND_MODEL_KEY_NORMALIZE_DISABLED = '1';
    seedGateway();
    mockEndpointFindMany.mockResolvedValue([{ label: 'cql-litellm', enabled: true, models: [{ id: 'api-optimize-zai-glm-5.3' }] }]);
    const res = mkRes();
    await controller.getAdminApiCosts(mkReq(ADMIN), res);
    const names = res.body.data.models.map((m: any) => m.model).sort();
    expect(names).toEqual(['api-optimize-zai-glm-5.3', 'cql-litellm:api-optimize-zai-glm-5.3', 'glm-5.3']);
  });
});


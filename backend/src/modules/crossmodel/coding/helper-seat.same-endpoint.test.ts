/**
 * audit 2026-10-06 T1-6 — a GATEWAY-level 5xx tries fallbacks OFF the failing
 * endpoint first.
 *
 * Fleet + litellm audits: on every gateway 502 the lead went
 * `cql-litellm:…glm-5.3` → `cql-litellm:…kimi-k3` (the admin's custom fallback,
 * SAME gateway — 502 again, same second) → built-in glm-5.3. On 502/503/504
 * from a custom spec, candidates on that spec's endpoint label are now tried
 * LAST (never dropped); other failure classes keep the admin's order; the kill
 * switch restores the order byte-for-byte.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));

const mockResolveRoleFallback = jest.fn(async (_k: string): Promise<string> => '');
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: jest.fn(async () => ''),
  resolveRoleFallback: (...a: any[]) => mockResolveRoleFallback(...(a as [string])),
}));

const GW = { url: 'https://llm.cql.ca/v1/chat/completions', apiKey: 'sk', label: 'cql-litellm', supportsVision: false, coding: true, chatCapable: true, thinkingOff: false };
const REGISTRY: Record<string, any> = {
  'cql-litellm:api-optimize-zai-glm-5.3': { ...GW, model: 'api-optimize-zai-glm-5.3' },
  'cql-litellm:api-optimize-moonshot-kimi-k3': { ...GW, model: 'api-optimize-moonshot-kimi-k3' },
  'spark:glm-5.3-fp8': { ...GW, url: 'http://spark:4000/v1/chat/completions', label: 'spark', model: 'glm-5.3-fp8' },
};
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: jest.fn(async (spec: string) => REGISTRY[spec] ?? null),
}));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, noteSeatFallback: jest.fn() }));

import { pickLeadFallback, orderFallbackCandidates, endpointLabelOfSpec, GATEWAY_LEVEL_5XX } from './helper-seat';

const PRIMARY = 'cql-litellm:api-optimize-zai-glm-5.3';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ZAI_API_KEY = 'zai';
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.SEAT_FALLBACK_SAME_ENDPOINT_LAST_DISABLED;
  mockResolveRoleFallback.mockImplementation(async () => 'cql-litellm:api-optimize-moonshot-kimi-k3');
});
afterEach(() => { delete process.env.ZAI_API_KEY; });

describe('orderFallbackCandidates — pure', () => {
  it('endpoint label parsing', () => {
    expect(endpointLabelOfSpec(PRIMARY)).toBe('cql-litellm');
    expect(endpointLabelOfSpec('glm-5.3')).toBeNull();
    expect([...GATEWAY_LEVEL_5XX]).toEqual([502, 503, 504]);
  });

  it.each([502, 503, 504])('HTTP %i: same-label candidates move to the end (stable), others keep their order', (st) => {
    const r = orderFallbackCandidates(['cql-litellm:kimi', 'spark:glm', 'glm-5.3', 'cql-litellm:ds'], PRIMARY, st);
    expect(r.order).toEqual(['spark:glm', 'glm-5.3', 'cql-litellm:kimi', 'cql-litellm:ds']);
    expect(r.deferred).toEqual(['cql-litellm:kimi', 'cql-litellm:ds']);
  });

  it.each([[429], [500], [400], [undefined]])('status %p keeps the admin order', (st) => {
    expect(orderFallbackCandidates(['cql-litellm:kimi', 'glm-5.3'], PRIMARY, st as any)).toEqual({ order: ['cql-litellm:kimi', 'glm-5.3'], deferred: [] });
  });

  it('a built-in primary has no endpoint to defer', () => {
    expect(orderFallbackCandidates(['cql-litellm:kimi', 'deepseek-flash'], 'glm-5.3', 502).deferred).toEqual([]);
  });

  it('kill switch SEAT_FALLBACK_SAME_ENDPOINT_LAST_DISABLED=1 keeps the order', () => {
    process.env.SEAT_FALLBACK_SAME_ENDPOINT_LAST_DISABLED = '1';
    expect(orderFallbackCandidates(['cql-litellm:kimi', 'glm-5.3'], PRIMARY, 502).order).toEqual(['cql-litellm:kimi', 'glm-5.3']);
  });
});

describe('pickLeadFallback — the gateway 502 the audits measured', () => {
  it('502 from the gateway glm: the built-in serves BEFORE the same-gateway kimi custom fallback', async () => {
    const pick = await pickLeadFallback(PRIMARY, 'api-optimize-zai-glm-5.3', 'u1', 'supervisor', { spec: PRIMARY, httpStatus: 502 });
    expect(pick).toMatchObject({ model: 'glm-5.3', custom: false, sameEndpointDeferred: ['cql-litellm:api-optimize-moonshot-kimi-k3'] });
  });

  it('429 from the gateway glm: the admin\'s custom fallback stays first (unchanged)', async () => {
    const pick = await pickLeadFallback(PRIMARY, 'api-optimize-zai-glm-5.3', 'u1', 'supervisor', { spec: PRIMARY, httpStatus: 429 });
    expect(pick).toMatchObject({ model: 'cql-litellm:api-optimize-moonshot-kimi-k3', custom: true });
    expect(pick!.sameEndpointDeferred).toBeUndefined();
  });

  it('a custom fallback on a DIFFERENT endpoint keeps its place on a 502', async () => {
    mockResolveRoleFallback.mockImplementation(async () => 'spark:glm-5.3-fp8');
    expect(await pickLeadFallback(PRIMARY, 'api-optimize-zai-glm-5.3', 'u1', 'supervisor', { spec: PRIMARY, httpStatus: 502 })).toMatchObject({ model: 'spark:glm-5.3-fp8', custom: true });
  });

  it('no off-endpoint candidate servable → the same-gateway fallback still runs (deferred, never dropped)', async () => {
    delete process.env.ZAI_API_KEY; // no built-in is servable here
    const pick = await pickLeadFallback(PRIMARY, 'api-optimize-zai-glm-5.3', 'u1', 'supervisor', { spec: PRIMARY, httpStatus: 503 });
    expect(pick).toMatchObject({ model: 'cql-litellm:api-optimize-moonshot-kimi-k3', custom: true });
  });

  it('omitting the failure context (every other call site) is byte-identical to before', async () => {
    const pick = await pickLeadFallback(PRIMARY, 'api-optimize-zai-glm-5.3', 'u1', 'supervisor');
    expect(pick).toMatchObject({ model: 'cql-litellm:api-optimize-moonshot-kimi-k3', custom: true });
    expect('sameEndpointDeferred' in pick!).toBe(false);
  });
});

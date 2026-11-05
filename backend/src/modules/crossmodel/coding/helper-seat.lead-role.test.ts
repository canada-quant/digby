/**
 * 2026-09-27 seat/provider limits — pickLeadFallback's two new behaviours:
 * (1) `seatRole` names WHOSE admin custom fallback is consulted (a supervisor
 * chat's 'supervisor' seat, not always coding_default's); (2) a candidate that
 * is LATCHED off by a deterministic invalid-request rejection is skipped like an
 * unservable one — a fallback that 400s deterministically is no fallback.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));

const mockResolveRoleFallback = jest.fn(async (_k: string): Promise<string> => '');
const mockResolveRoleModel = jest.fn(async (_k: string): Promise<string> => '');
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: (...a: any[]) => mockResolveRoleModel(...(a as [string])),
  resolveRoleFallback: (...a: any[]) => mockResolveRoleFallback(...(a as [string])),
}));

const REGISTRY: Record<string, any> = {
  'cql:astra': { url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk', model: 'api-openai-gpt-6-astra', label: 'cql', supportsVision: false, coding: true, chatCapable: true, thinkingOff: false },
  'cql:claude': { url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk', model: 'api-anthropic-claude-fable-5-1', label: 'cql', supportsVision: false, coding: true, chatCapable: true, thinkingOff: false },
};
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: jest.fn(async (spec: string) => REGISTRY[spec] ?? null),
}));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, noteSeatFallback: jest.fn() }));

import { pickLeadFallback, LEAD_SEAT_ROLE, QUICK_SEAT_ROLE } from './helper-seat';
import { classifyInvalidRequest, latchSeatInvalidRequest, __resetSeatInvalidRequestLatchesForTests } from './seat-invalid-request';

beforeEach(() => {
  jest.clearAllMocks();
  __resetSeatInvalidRequestLatchesForTests();
  process.env.ZAI_API_KEY = 'zai';
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  mockResolveRoleFallback.mockImplementation(async (k: string) => (k === 'supervisor' ? 'cql:claude' : ''));
});
afterEach(() => { delete process.env.ZAI_API_KEY; });

describe('pickLeadFallback — seat role + latched candidates', () => {
  it("consults the named seat's custom fallback; omitted = coding_default (byte-identical)", async () => {
    const sup = await pickLeadFallback('cql:astra', 'api-openai-gpt-6-astra', 'u1', 'supervisor');
    expect(mockResolveRoleFallback).toHaveBeenLastCalledWith('supervisor');
    expect(sup).toMatchObject({ model: 'cql:claude', custom: true });
    const def = await pickLeadFallback('cql:astra', 'api-openai-gpt-6-astra', 'u1');
    expect(mockResolveRoleFallback).toHaveBeenLastCalledWith(LEAD_SEAT_ROLE);
    expect(def).toMatchObject({ model: 'glm-5.3', custom: false });
  });

  it('skips a custom fallback that is latched off (deterministic 400) and names why; the built-in order follows', async () => {
    const cls = classifyInvalidRequest({ errorStatus: 400, providerError: 'Function tools with reasoning_effort are not supported' })!;
    latchSeatInvalidRequest('cql:claude', cls);
    const pick = await pickLeadFallback('cql:astra', 'api-openai-gpt-6-astra', 'u1', 'supervisor');
    expect(pick).toMatchObject({ model: 'glm-5.3', custom: false });
    expect(pick!.skipped).toEqual([expect.objectContaining({ to: 'cql:claude', reason: expect.stringMatching(/^latched off until \d{2}:\d{2}:\d{2}Z \(reasoning_effort_unsupported\)$/) })]);
    // the latch is honoured as before
    const skip = await pickLeadFallback('cql:astra', 'api-openai-gpt-6-astra', 'u1', 'supervisor');
    expect(skip).toMatchObject({ model: 'glm-5.3', custom: false });
  });
});

describe('pickLeadFallback — the Quick answers seat hands off to the Digby seat (dynamic roster 2026-10-03)', () => {
  it('no custom fallback on chat_quick: the Digby seat model is tried first, NOT marked custom', async () => {
    mockResolveRoleFallback.mockImplementation(async () => '');
    mockResolveRoleModel.mockImplementation(async (k: string) => (k === 'chat_orchestrator' ? 'cql:astra' : ''));
    const pick = await pickLeadFallback('cql:claude', 'api-anthropic-claude-fable-5-1', 'u1', QUICK_SEAT_ROLE);
    expect(pick).toMatchObject({ model: 'cql:astra', custom: false });
  });
  it('a custom fallback on chat_quick wins over the hand-off', async () => {
    mockResolveRoleFallback.mockImplementation(async (k: string) => (k === QUICK_SEAT_ROLE ? 'cql:claude' : ''));
    mockResolveRoleModel.mockImplementation(async () => 'cql:astra');
    const pick = await pickLeadFallback('qwen3.6-27b', 'qwen3.6-27b', 'u1', QUICK_SEAT_ROLE);
    expect(pick).toMatchObject({ model: 'cql:claude', custom: true });
  });
  it('other seats never consult the Digby seat', async () => {
    mockResolveRoleFallback.mockImplementation(async () => '');
    mockResolveRoleModel.mockImplementation(async () => 'cql:claude');
    const pick = await pickLeadFallback('cql:astra', 'api-openai-gpt-6-astra', 'u1', 'supervisor');
    expect(pick).toMatchObject({ model: 'glm-5.3', custom: false });
  });
});

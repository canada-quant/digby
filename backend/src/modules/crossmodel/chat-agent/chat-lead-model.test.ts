/**
 * Per-chat lead-seat override (WI-O #4c, 2026-09-25) — the pure pick
 * validator against the Digby seat's pick set (built-ins from
 * builtInOptionsFor('chat_orchestrator') + [coding]-flagged registry models,
 * legacy ids aliased forward) and the run-time override rule (never on
 * supervisor chats).
 */

const mockBuiltInOptionsFor = jest.fn((_key: string): string[] => ['kimi-k3', 'glm-5.3', 'deepseek-flash', 'qwen3.6-27b']);
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  builtInOptionsFor: (...a: any[]) => mockBuiltInOptionsFor(...(a as [string])),
}));
const mockResolveRegistryModel = jest.fn(async (_spec: string, _userId?: string): Promise<any> => null);
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...(a as [string, string?])),
}));

import { resolveChatLeadPick, chatLeadOverrideForRun, chatLeadBuiltInOptions } from './chat-lead-model';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveChatLeadPick — the Digby seat\'s own pick set', () => {
  it('accepts every built-in the seat offers and asks the SEAT list (chat_orchestrator), not a frontend list', async () => {
    expect(await resolveChatLeadPick('deepseek-flash', 'u1')).toBe('deepseek-flash');
    expect(await resolveChatLeadPick(' glm-5.3 ', 'u1')).toBe('glm-5.3');
    expect(mockBuiltInOptionsFor).toHaveBeenCalledWith('chat_orchestrator');
  });

  it('aliases legacy ids forward the way resolveOneCodingPick does', async () => {
    expect(await resolveChatLeadPick('kimi-k2.6')).toBe('kimi-k3');
    expect(await resolveChatLeadPick('glm-5.2')).toBe('glm-5.3');
    expect(await resolveChatLeadPick('deepseek-v4-pro')).toBe('deepseek-flash');
    expect(await resolveChatLeadPick('deepseek-v4-flash')).toBe('deepseek-flash');
  });

  it('refuses ids the seat does not offer (a utility model, a frontier id, garbage, empty)', async () => {
    expect(await resolveChatLeadPick('glm-5.3-flash')).toBeNull();
    expect(await resolveChatLeadPick('gpt-5.6-sol')).toBeNull();
    expect(await resolveChatLeadPick('not-a-model')).toBeNull();
    expect(await resolveChatLeadPick('')).toBeNull();
    expect(await resolveChatLeadPick(null)).toBeNull();
    expect(mockResolveRegistryModel).not.toHaveBeenCalled();
  });

  it('a "<label>:<modelId>" spec resolves ONLY to an enabled registry model flagged [coding] (assertAssignable\'s chat-seat rule)', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce({ coding: true });
    expect(await resolveChatLeadPick('ollama:llama4', 'u1')).toBe('ollama:llama4');
    expect(mockResolveRegistryModel).toHaveBeenCalledWith('ollama:llama4', 'u1');
    mockResolveRegistryModel.mockResolvedValueOnce({ coding: false });
    expect(await resolveChatLeadPick('ollama:embed-only', 'u1')).toBeNull();
    mockResolveRegistryModel.mockResolvedValueOnce(null);
    expect(await resolveChatLeadPick('gone:model', 'u1')).toBeNull();
    mockResolveRegistryModel.mockRejectedValueOnce(new Error('registry down'));
    expect(await resolveChatLeadPick('ollama:llama4', 'u1')).toBeNull(); // fail closed on a write
  });

  it('chatLeadBuiltInOptions mirrors the seat list (used in refusal messages)', async () => {
    expect(await chatLeadBuiltInOptions()).toEqual(['kimi-k3', 'glm-5.3', 'deepseek-flash', 'qwen3.6-27b']);
  });
});

describe('chatLeadOverrideForRun — what the run honours', () => {
  it('a stored pick on a plain chat is honoured; blank / missing / null rows are not', () => {
    expect(chatLeadOverrideForRun({ leadModel: 'deepseek-flash' })).toBe('deepseek-flash');
    expect(chatLeadOverrideForRun({ leadModel: '  ' })).toBeNull();
    expect(chatLeadOverrideForRun({ leadModel: null })).toBeNull();
    expect(chatLeadOverrideForRun({})).toBeNull();
    expect(chatLeadOverrideForRun(null)).toBeNull();
  });

  it('supervisor chats (fleet or project) NEVER honour the column — they resolve their own seats', () => {
    expect(chatLeadOverrideForRun({ leadModel: 'deepseek-flash', isSupervisor: true })).toBeNull();
    expect(chatLeadOverrideForRun({ leadModel: 'deepseek-flash', isProjectSupervisor: true })).toBeNull();
  });
});

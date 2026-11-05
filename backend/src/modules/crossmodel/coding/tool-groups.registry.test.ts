/**
 * Progressive tool disclosure — the REAL tool lists + the agent-loop wiring
 * (2026-09-27 late). Owner, on "Tool list trimmed to api-optimize-moonshot-
 * kimi-k3's 128-tool limit (196 → 128; dropped: connector writes, connector
 * reads, platform actions)": "this is not good from my pov it should be way
 * smarter than just trimming? or set a group of tools behind another tool".
 * Prod facts (coordinator, same day): that model NEVER returned a tools-too-
 * long 400 — the 128 was the b085607e blanket default, and the row said
 * "learned" for a cap nobody learned.
 *
 * Pins:
 *   (1) every tool the coding and chat assemblies offer belongs to exactly one
 *       group, and the core fits under CORE_MAX on BOTH real lists;
 *   (2) a proxy Kimi with no configured cap gets NO trim, NO note, NO row —
 *       the full list goes (unlimited);
 *   (3) a REAL cap (the registry's documented OpenAI 128) turns on progressive
 *       disclosure: core + hinted groups + the gateway pair fit the cap; a
 *       by-name call to a hidden tool auto-loads its group and executes;
 *       list_tool_groups / load_tools work; loaded groups persist across
 *       steps; ONE tool_groups row + AgentRunResult.toolGroupsLoaded;
 *   (4) TOOL_GROUPS_DISABLED=1 restores the priority trim with the HONEST
 *       source ('class', never 'learned');
 *   (5) TOOL_GROUPS_ALWAYS=1 applies the core + groups shape to a built-in.
 *
 * Scaffold mirrors agent-seat-invalid-request.test.ts (same mock set).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));
jest.mock('../github/github-mcp', () => ({
  __esModule: true, isGitHubMcpConfigured: jest.fn(() => false), callGitHubMcpTool: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  __esModule: true, isGoogleMcpConfigured: jest.fn(() => false), callGoogleMcpTool: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
}));

const mockRunModelTurn: jest.Mock = jest.fn();
// The loop hands runModelTurn its LIVE messages array and splices the transient
// per-turn notes out right after the turn — snapshot the system messages at
// call time, or the note is gone by the time an assertion reads the mock args.
const mockSystemAtCall: string[][] = [];
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return {
    ...actual,
    runModelTurn: (...a: any[]) => {
      mockSystemAtCall.push((a[1] ?? []).filter((m: any) => m?.role === 'system').map((m: any) => String(m.content)));
      return mockRunModelTurn(...a);
    },
  };
});

const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  noteSeatFallback: jest.fn(),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected', SEAT_FALLBACK: 'seat_fallback', PROVIDER_COOLDOWN: 'provider_cooldown', TOOL_LIST_TRIMMED: 'tool_list_trimmed', TOOL_GROUPS: 'tool_groups' },
}));
jest.mock('../feedback/feedback.service', () => {
  const actual = jest.requireActual('../feedback/feedback.service');
  return { ...actual, fileFeedbackTicket: jest.fn(async () => ({ id: 'ticket-1' })) };
});
const _store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  __esModule: true,
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn() }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

const REGISTRY: Record<string, any> = {
  // The owner's screen: a Kimi K3 behind the api-optimize LiteLLM proxy — NO cap anywhere.
  'api-optimize:api-optimize-moonshot-kimi-k3': {
    url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1',
    apiKey: 'sk-cql', model: 'api-optimize-moonshot-kimi-k3', label: 'api-optimize',
    coding: true, chatCapable: true, kind: 'chat', thinkingOff: false, supportsVision: false,
    providerClass: 'moonshot', maxToolsSource: 'none', reasoningEffort: 'auto',
  },
  // The incident seat: the OpenAI class's DOCUMENTED 128 on the registry entry.
  'cql-litellm:api-openai-gpt-6-astra': {
    url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1',
    apiKey: 'sk-cql', model: 'api-openai-gpt-6-astra', label: 'cql-litellm',
    coding: true, chatCapable: true, kind: 'chat', thinkingOff: false, supportsVision: false,
    providerClass: 'openai', maxTools: 128, maxToolsSource: 'class', reasoningEffort: 'auto',
  },
};
const mockResolveRegistryModel: jest.Mock = jest.fn();
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleFallback: jest.fn(async () => ''),
  resolveRoleModel: jest.fn(async () => ''),
}));

import { runCodingAgent, runToolSchemasForProbe, systemPrompt } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { groupForTool, TOOL_GROUP_IDS, CORE_MAX, TOOL_GROUP_META_TOOLS, type ToolGroupId, laneOnlyToolHint, laneOnlyToolsInQuery, laneOnlyToolHintDisabled } from './tool-groups';
import { __resetLearnedToolLimitsForTests } from './provider-limits';
import { __resetSeatInvalidRequestLatchesForTests } from './seat-invalid-request';
import { __resetProviderCooldownForTests } from './provider-cooldown';

const PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 90_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const KIMI = 'api-optimize:api-optimize-moonshot-kimi-k3';
const ASTRA = 'cql-litellm:api-openai-gpt-6-astra';
const makeInput = (extra?: Partial<AgentRunInput>): AgentRunInput => ({
  worktree: '/tmp/tool-groups',
  sessionId: 'sess-groups',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: KIMI,
  seatRole: 'supervisor',
  projectName: 'test',
  branch: 'chat',
  profile: PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [] as any,
  userMessage: 'sweep the fleet',
  emit: jest.fn(),
  ...extra,
});

const FINAL = { content: 'SWEEP: no-op — nothing needs me.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const call = (n: string, name: string, args: any = {}) => ({ content: '', reasoning: '', toolCalls: [{ id: n, name, arguments: JSON.stringify(args) }], finishReason: 'tool_calls' });
const toolNames = (c: any[]): string[] => (c[2] ?? []).map((t: any) => t?.function?.name);
const systemNotes = (i: number): string[] => mockSystemAtCall[i] ?? [];
const NOTE = '[HARNESS NOTE — TOOL';
const rows = (kind: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === kind);

beforeEach(() => {
  jest.clearAllMocks();
  mockSystemAtCall.length = 0;
  _store.clear();
  __resetSeatInvalidRequestLatchesForTests();
  __resetLearnedToolLimitsForTests();
  __resetProviderCooldownForTests();
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
  process.env.ZAI_API_KEY = 'test-zai-key';
  for (const k of ['TOOL_GROUPS_DISABLED', 'TOOL_GROUPS_ALWAYS', 'CUSTOM_ENDPOINT_TOOLS_MAX']) delete process.env[k];
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
  mockResolveRegistryModel.mockImplementation(async (spec: string) => REGISTRY[spec] ?? null);
});
afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
  delete process.env.ZAI_API_KEY;
  for (const k of ['TOOL_GROUPS_DISABLED', 'TOOL_GROUPS_ALWAYS']) delete process.env[k];
});

describe('(1) the REAL registries: total grouping, core under CORE_MAX', () => {
  const table = (schemas: any[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const t of schemas) { const g = groupForTool(t.function.name); out[g] = (out[g] ?? 0) + 1; }
    return out;
  };
  it('coding assembly (every schema + delegates + the legacy meta-tool)', () => {
    const schemas = runToolSchemasForProbe({ kind: 'coding', supervisorTools: true });
    expect(schemas.length).toBeGreaterThan(150);
    const t = table(schemas);
    for (const g of Object.keys(t)) expect(TOOL_GROUP_IDS).toContain(g as ToolGroupId);
    expect(t.core).toBeLessThanOrEqual(CORE_MAX);
    expect(t.core).toBeGreaterThan(60);
    // eslint-disable-next-line no-console
    console.log('[tool-groups] coding assembly', schemas.length, JSON.stringify(t));
  });
  it('chat assembly (CHAT_ORCH_TOOLS + delegates) — the supervisor seat sends ~195', () => {
    const schemas = runToolSchemasForProbe({ kind: 'chat', supervisorTools: true, allowSubagents: true });
    expect(schemas.length).toBeGreaterThan(150);
    const t = table(schemas);
    for (const g of Object.keys(t)) expect(TOOL_GROUP_IDS).toContain(g as ToolGroupId);
    expect(t.core).toBeLessThanOrEqual(CORE_MAX);
    // eslint-disable-next-line no-console
    console.log('[tool-groups] chat assembly', schemas.length, JSON.stringify(t));
  });
});

describe('(2) a proxy Kimi with NO configured cap: unlimited — no trim, no note, no row', () => {
  it('sends the FULL list, pushes no tool-limit / tool-groups note, records no tool_list_trimmed or tool_groups row, emits no tool-limit progress', async () => {
    mockRunModelTurn.mockResolvedValue(FINAL);
    const emit = jest.fn();
    const result = await runCodingAgent(makeInput({ emit }));
    expect(result.modelErrored ?? false).toBe(false);
    const first = mockRunModelTurn.mock.calls[0];
    expect(first[0].model).toBe('api-optimize-moonshot-kimi-k3');
    expect(first[2].length).toBeGreaterThan(128);
    expect(toolNames(first)).not.toContain('list_tool_groups');
    expect(systemNotes(0).some((n) => n.startsWith(NOTE))).toBe(false);
    expect(rows('tool_list_trimmed')).toEqual([]);
    expect(rows('tool_groups')).toEqual([]);
    expect(emit.mock.calls.some((c) => c[0] === 'progress' && /tool-limit|tool-groups/.test(String(c[1]?.stage)))).toBe(false);
    expect(result.toolsTrimmed).toBeUndefined();
    expect(result.toolGroupsLoaded).toBeUndefined();
  });
});

describe('(3) a REAL cap turns on progressive disclosure', () => {
  it('core + hinted groups + the gateway fit the cap; a hidden tool called by name auto-loads and executes; load_tools / list_tool_groups work; state persists; one tool_groups row', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(call('c1', 'get_platform_network_info'))               // hidden (platform_reads) → auto-load + execute
      .mockResolvedValueOnce(call('c2', 'list_tool_groups'))
      .mockResolvedValueOnce(call('c3', 'load_tools', { group: 'connector_slack' }))
      .mockResolvedValueOnce(call('c4', 'load_tools', { query: 'asana task' }))
      .mockResolvedValue(FINAL);
    const emit = jest.fn();
    const result = await runCodingAgent(makeInput({ model: ASTRA, userMessage: 'Check my Gmail for the Acme thread, then sweep the fleet', emit }));
    expect(result.modelErrored ?? false).toBe(false);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(5);

    // turn 1: ≤128 tools — core, the gateway, the hinted Google group; no connector_slack, no platform_actions
    const t1 = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(t1.length).toBeLessThanOrEqual(128);
    expect(t1).toEqual(expect.arrayContaining(['read_file', 'run_command', 'send_chat_message', 'gmail_search', 'drive_search', ...TOOL_GROUP_META_TOOLS]));
    expect(t1).not.toContain('slack_search');
    expect(t1).not.toContain('get_platform_network_info');
    expect(t1).not.toContain('load_tool_group'); // the legacy meta-tool is superseded by the gateway pair
    const note1 = systemNotes(0).find((n) => n.startsWith('[HARNESS NOTE — TOOL GROUPS'))!;
    expect(note1).toBeTruthy();
    expect(note1).toContain('core + connector_google');
    expect(note1).toContain('list_tool_groups');
    expect(systemNotes(0).some((n) => n.startsWith('[HARNESS NOTE — TOOL LIMIT'))).toBe(false);
    expect(rows('tool_list_trimmed')).toEqual([]);

    // the transient note never accumulates in the transcript (spliced after every turn)
    expect(systemNotes(4).filter((n) => n.startsWith('[HARNESS NOTE — TOOL GROUPS'))).toHaveLength(1);
    expect(systemNotes(4).find((n) => n.startsWith('[HARNESS NOTE — TOOL GROUPS'))).toContain('connector_slack');

    // get_platform_network_info executed (auto-loaded, never refused as not-offered) and its group is in view from turn 2
    expect(mockExecuteCodingTool).toHaveBeenCalledWith(expect.anything(), 'get_platform_network_info', expect.anything());
    expect(rows('guard_strike').filter((r) => r.meta?.reason === 'tool_not_offered')).toEqual([]);
    const t2 = toolNames(mockRunModelTurn.mock.calls[1]);
    expect(t2).toContain('get_platform_network_info');
    expect(t2).toContain('get_fleet_telemetry'); // the whole platform_reads group came along (it fit)
    expect(t2.length).toBeLessThanOrEqual(128);

    // list_tool_groups answered with the groups, the cap and the headroom (a tool RESULT, no executor call)
    const listing = JSON.parse(String(mockRunModelTurn.mock.calls[2][1].find((m: any) => m?.role === 'tool' && m?.tool_call_id === 'c2')?.content ?? '{}'));
    expect(listing).toMatchObject({ ok: true, tool: 'list_tool_groups', cap: 128 });
    expect(listing.groups.map((g: any) => g.group)).toEqual(expect.arrayContaining(['connector_slack', 'connector_asana', 'account']));
    // MERGE-INTENT-AWAIT (2026-10-20): await_condition grew the core to 89, so the turn-1 auto-load of
    // platform_reads no longer fits beside Google under 128 — the LRU (never-used) Google group is evicted THERE.
    expect(listing.groups.find((g: any) => g.group === 'connector_google')).toMatchObject({ loaded: 'no' });
    expect(mockExecuteCodingTool).not.toHaveBeenCalledWith(expect.anything(), 'list_tool_groups', expect.anything());

    // load_tools({group}) then load_tools({query}) — in view from the next round
    const loaded = JSON.parse(String(mockRunModelTurn.mock.calls[3][1].find((m: any) => m?.role === 'tool' && m?.tool_call_id === 'c3')?.content ?? '{}'));
    expect(loaded).toMatchObject({ ok: true, group: 'connector_slack' });
    expect(loaded.loaded).toContain('slack_search');
    expect(toolNames(mockRunModelTurn.mock.calls[3])).toContain('slack_search');
    const q = JSON.parse(String(mockRunModelTurn.mock.calls[4][1].find((m: any) => m?.role === 'tool' && m?.tool_call_id === 'c4')?.content ?? '{}'));
    expect(q.ok).toBe(true);
    expect(q.loaded).toEqual(expect.arrayContaining(['asana_create_task', 'asana_update_task']));
    expect(toolNames(mockRunModelTurn.mock.calls[4])).toContain('asana_create_task');
    // every turn stayed under the cap (LRU eviction when needed)
    for (const c of mockRunModelTurn.mock.calls) expect(toolNames(c).length).toBeLessThanOrEqual(128);

    // ONE tool_groups row + the result field; the live-run status line reads "Tool groups: core + …"
    const tg = rows('tool_groups');
    expect(tg).toHaveLength(1);
    expect(tg[0].meta).toMatchObject({ cap: 128, model: 'api-openai-gpt-6-astra', autoLoads: 1 });
    // the first load that did not fit beside Google + platform reads under 128 evicted the LRU
    // (never-used) Google group, exactly once. WHICH load depends on the core's size: a later one
    // (Slack or "asana task") while the core was ≤ 88 (delegate_status joined it with background
    // delegation), the turn-1 platform_reads auto-load since await_condition made it 89 — so the
    // explicit loads after it evict nothing.
    expect(tg[0].meta.loaded).toEqual(expect.arrayContaining(['platform_reads', 'connector_slack', 'connector_asana']));
    expect(tg[0].meta.evicted).toEqual(['connector_google']);
    expect(toolNames(mockRunModelTurn.mock.calls[4])).not.toContain('gmail_search');
    const q4 = JSON.parse(String(mockRunModelTurn.mock.calls[4][1].find((m: any) => m?.role === 'tool' && m?.tool_call_id === 'c4')?.content ?? '{}'));
    const evictedAt = [loaded, q4].filter((r: any) => Array.isArray(r.evicted) && r.evicted.length);
    expect(evictedAt).toHaveLength(0);
    expect(toolNames(mockRunModelTurn.mock.calls[1])).not.toContain('gmail_search'); // gone from the turn-2 view already
    expect(tg[0].meta.core).toBeLessThanOrEqual(CORE_MAX);
    expect(result.toolGroupsLoaded).toEqual(tg[0].meta.loaded);
    expect(result.toolsTrimmed).toBeUndefined();
    const statusLines = emit.mock.calls.filter((c) => c[0] === 'progress' && c[1]?.stage === 'tool-groups').map((c) => String(c[1].message));
    expect(statusLines.length).toBeGreaterThanOrEqual(2);
    expect(statusLines[0]).toMatch(/^Tool groups: core \+ connector_google \(\d+\/128 tools\); \d+ more on demand$/);
    expect(emit.mock.calls.some((c) => c[0] === 'progress' && c[1]?.stage === 'tool-limit')).toBe(false);
  });
});

describe('(4) TOOL_GROUPS_DISABLED=1 restores the priority trim — with the HONEST source', () => {
  it('trims 128 by tier, pushes the TOOL LIMIT note, records tool_list_trimmed {source:"class", mode:"priority"} — never "learned"', async () => {
    process.env.TOOL_GROUPS_DISABLED = '1';
    mockRunModelTurn.mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput({ model: ASTRA }));
    const first = mockRunModelTurn.mock.calls[0];
    expect(first[2]).toHaveLength(128);
    expect(toolNames(first)).not.toContain('list_tool_groups');
    expect(systemNotes(0).some((n) => n.startsWith('[HARNESS NOTE — TOOL LIMIT'))).toBe(true);
    expect(systemNotes(0).some((n) => n.startsWith('[HARNESS NOTE — TOOL GROUPS'))).toBe(false);
    const trim = rows('tool_list_trimmed');
    expect(trim).toHaveLength(1);
    expect(trim[0].meta).toMatchObject({ limit: 128, to: 128, source: 'class', mode: 'priority' });
    expect(rows('tool_groups')).toEqual([]);
    expect(result.toolsTrimmed).toMatchObject({ to: 128 });
    expect(result.toolGroupsLoaded).toBeUndefined();
  });
});

describe('(5) TOOL_GROUPS_ALWAYS=1: universal progressive disclosure on a built-in (no cap)', () => {
  it('sends the core + gateway only, no cap, one tool_groups row with cap null', async () => {
    process.env.TOOL_GROUPS_ALWAYS = '1';
    mockRunModelTurn.mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput({ model: 'glm-5.3' }));
    const first = mockRunModelTurn.mock.calls[0];
    expect(first[0].model).toBe('glm-5.3');
    expect(first[2].length).toBeLessThanOrEqual(CORE_MAX);
    expect(toolNames(first)).toEqual(expect.arrayContaining([...TOOL_GROUP_META_TOOLS, 'read_file']));
    expect(toolNames(first)).not.toContain('gmail_search');
    const tg = rows('tool_groups');
    expect(tg).toHaveLength(1);
    expect(tg[0].meta).toMatchObject({ cap: null, loaded: [] });
    expect(result.toolGroupsLoaded).toEqual([]);
  });
});

describe('(6) view_image (2026-10-01): in the coding assembly + core, out of chat, gone under VIEW_IMAGE_TOOL_DISABLED=1', () => {
  afterEach(() => { delete process.env.VIEW_IMAGE_TOOL_DISABLED; });
  const names = (s: any[]) => s.map((t) => t.function.name);
  it('the coding assembly offers it (core group); the chat assembly does not (no workspace)', () => {
    expect(names(runToolSchemasForProbe({ kind: 'coding' }))).toContain('view_image');
    expect(groupForTool('view_image')).toBe('core');
    expect(names(runToolSchemasForProbe({ kind: 'chat', allowSubagents: true }))).not.toContain('view_image');
  });
  it('the kill switch drops the schema from the probe list AND from a real run, and the prompt line goes with it', async () => {
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ model: 'glm-5.3' }));
    expect(toolNames(mockRunModelTurn.mock.calls[0])).toContain('view_image');
    expect(systemPrompt(makeInput(), '', '', '', '')).toContain("view_image(path, question) — LOOK at an image file (PNG/JPG/GIF/WebP) through a vision model; use it instead of pixel heuristics whenever a task depends on what an image shows; ask a precise question (e.g. 'list every piece and its square').");

    process.env.VIEW_IMAGE_TOOL_DISABLED = '1';
    mockRunModelTurn.mockClear();
    expect(names(runToolSchemasForProbe({ kind: 'coding' }))).not.toContain('view_image');
    await runCodingAgent(makeInput({ model: 'glm-5.3' }));
    expect(toolNames(mockRunModelTurn.mock.calls[0])).not.toContain('view_image');
    expect(toolNames(mockRunModelTurn.mock.calls[0])).toContain('read_file');
    expect(systemPrompt(makeInput(), '', '', '', '')).not.toContain('view_image');
  });
});

// audit 2026-10-06 T5-7 (schooltime F5): a supervisor hunted 34 min for
// merge_pull_request — a coding-lane tool its profile never carries. A by-name
// call now answers AT ONCE with where the tool lives.
describe('(7) audit 2026-10-06 T5-7 — a lane-only tool called on a CHAT / supervisor profile', () => {
  const CHAT_PROFILE: AgentProfile = { ...PROFILE, kind: 'chat', memorySource: 'chat', supervisorTools: true };
  /** What the model saw about the refused call on the next turn: the pruned-slip notice (or, unpruned, the tool result). */
  const seenAboutCall = (turn: number, id: string): string =>
    (mockRunModelTurn.mock.calls[turn][1] as any[])
      .filter((m: any) => (m?.role === 'tool' && m?.tool_call_id === id) || (m?.role === 'user' && /SLIP REMOVED|NOT EXECUTED/.test(String(m?.content))))
      .map((m: any) => String(m.content)).join('\n');
  afterEach(() => { delete process.env.LANE_ONLY_TOOL_HINT_DISABLED; });

  it('merge_pull_request on a supervisor chat run: refused at once with the LANE-ONLY hint (never executed), one laneOnly guard row', async () => {
    mockRunModelTurn.mockResolvedValueOnce(call('m1', 'merge_pull_request', { prNumber: 12 })).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ profile: CHAT_PROFILE }));
    const res = seenAboutCall(1, 'm1');
    expect(res).toMatch(/did not execute|NOT EXECUTED/);
    expect(res).toContain('merge_pull_request is a LANE-ONLY tool');
    expect(res).toContain('send_chat_message');
    expect(mockExecuteCodingTool).not.toHaveBeenCalledWith(expect.anything(), 'merge_pull_request', expect.anything());
    expect(rows('guard_strike').filter((r) => r.meta?.reason === 'tool_not_offered' && r.meta?.laneOnly === true)).toHaveLength(1);
  });

  it('a coding profile never gets the hint (it carries the tool); LANE_ONLY_TOOL_HINT_DISABLED=1 restores the generic refusal', async () => {
    process.env.LANE_ONLY_TOOL_HINT_DISABLED = '1';
    expect(laneOnlyToolHintDisabled()).toBe(true);
    mockRunModelTurn.mockResolvedValueOnce(call('m1', 'merge_pull_request', { prNumber: 12 })).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ profile: CHAT_PROFILE }));
    const res = seenAboutCall(1, 'm1');
    expect(res).toMatch(/did not execute|NOT EXECUTED/);
    expect(res).not.toContain('LANE-ONLY');
  });

  it('the pure helpers: the hint names the way out; a load_tools query naming a lane-only tool is detected', () => {
    expect(laneOnlyToolHint('open_pull_request')).toMatch(/open_pull_request is a LANE-ONLY tool.*no tool group can load it.*start_coding_session/);
    expect(laneOnlyToolsInQuery('merge_pull_request parameters', ['merge_pull_request', 'run_command'])).toEqual(['merge_pull_request']);
    expect(laneOnlyToolsInQuery('gmail', ['merge_pull_request'])).toEqual([]);
  });
});

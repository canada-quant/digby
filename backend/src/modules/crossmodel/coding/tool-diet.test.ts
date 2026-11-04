/**
 * TOOL DIET (build 2026-10-08 A2; audit 2026-10-08 architecture.md item A) — replay
 * tests from the measured prod shapes:
 *   - a guest turn was sent the whole 208-tool chat roster (~49k tokens) while guests
 *     called a platform tool in 1 of 59 turns → A2-1 guest subset;
 *   - progressive disclosure (tool-groups.ts) ran 0 times in prod since it shipped —
 *     no built-in seat carries a tool cap and TOOL_GROUPS_ALWAYS was never forwarded
 *     by compose → A2-2 turns it on BY PROFILE for signed-in human plain-chat turns:
 *     shadow (would-miss) for everyone, act on the owner canary / store mode 'act';
 *   - the per-segment prompt-token drop (guest / signed-in human chat / supervisor).
 *
 * Measured at build time (o200k tool-schema tokens per model call; the test below prints the live figures):
 *   segment                   before (main 1f628029)        after A2 (diet + subset / core-first view)
 *   guest                     48,881 (208 tools)            4,510 (16 tools)         −91 %
 *   signed-in human chat      48,881 (208 tools)            23,077 (89 tools) acting −53 %; 41,255 full list in shadow −16 %
 *   supervisor                50,180 (212 tools)            42,469 (212 tools)       −15 % (description diet only)
 *   coding lane               54,574 (236 tools)            46,102 (236 tools)       −16 % (description diet only)
 *

 * Scaffold mirrors tool-groups.registry.test.ts (same mock set).
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
const mockStoreGet: jest.Mock = jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null);
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => mockStoreGet(...a),
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
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: jest.fn(async () => null),
}));
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleFallback: jest.fn(async () => ''),
  resolveRoleModel: jest.fn(async () => ''),
}));
jest.mock('../user-mcp/user-mcp.service', () => ({ __esModule: true, loadUserMcpRunTools: jest.fn(async () => null) }));

import { runCodingAgent, runToolSchemasForProbe } from './agent';
import type { AgentRunInput } from './agent';
import { chatProfile, supervisorProfile } from './agent-profiles';
import {
  GUEST_TOOL_NAMES, CHAT_PRELOAD_TOOLS, TOOL_DIET_CANARY_DEFAULT_USER_IDS, __resetToolDietConfigForTests,
  toolDietConfigFrom, decideChatToolGroups, isHumanPlainChatRun, chatToolGroupsInitialView, wouldMissTools,
  calledToolNames, guestToolSubset, schemaChars,
} from './tool-diet';
import { TOOL_GROUP_META_TOOLS, ToolGroupSession, groupForTool } from './tool-groups';
import { __resetLearnedToolLimitsForTests } from './provider-limits';
import { __resetSeatInvalidRequestLatchesForTests } from './seat-invalid-request';
import { __resetProviderCooldownForTests } from './provider-cooldown';

const OWNER = TOOL_DIET_CANARY_DEFAULT_USER_IDS[0];
const MEMBER = '5b0c1d2e-0000-4000-8000-00000000abcd';
const DIET_NS = 'instance/tool-diet::config';

const makeInput = (extra?: Partial<AgentRunInput>): AgentRunInput => ({
  worktree: '',
  sessionId: '7d1f0e2a-1111-4222-8333-444455556666',
  projectId: 'chat',
  userId: MEMBER,
  permissionMode: 'auto',
  model: 'glm-5.3',
  projectName: 'chat',
  branch: 'chat',
  profile: chatProfile('thinking', false),
  doctrineOverride: 'You are Digby.',
  history: [] as any,
  userMessage: 'make a new project called Garden and put this chat in it',
  userTurnAt: new Date('2026-10-08T12:00:00Z'),
  machineTriggered: false,
  emit: jest.fn(),
  ...extra,
});

const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const call = (n: string, name: string, args: any = {}) => ({ content: '', reasoning: '', toolCalls: [{ id: n, name, arguments: JSON.stringify(args) }], finishReason: 'tool_calls' });
const toolNames = (c: any[]): string[] => (c[2] ?? []).map((t: any) => t?.function?.name);
const rows = (kind: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === kind);

beforeEach(() => {
  jest.clearAllMocks();
  mockSystemAtCall.length = 0;
  _store.clear();
  __resetToolDietConfigForTests();
  __resetSeatInvalidRequestLatchesForTests();
  __resetLearnedToolLimitsForTests();
  __resetProviderCooldownForTests();
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
  process.env.ZAI_API_KEY = 'test-zai-key';
  for (const k of ['TOOL_GROUPS_DISABLED', 'TOOL_GROUPS_ALWAYS', 'GUEST_TOOL_SUBSET_DISABLED', 'CHAT_TOOL_GROUPS_DISABLED', 'CUSTOM_ENDPOINT_TOOLS_MAX']) delete process.env[k];
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
});
afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
  delete process.env.ZAI_API_KEY;
  for (const k of ['TOOL_GROUPS_DISABLED', 'TOOL_GROUPS_ALWAYS', 'GUEST_TOOL_SUBSET_DISABLED', 'CHAT_TOOL_GROUPS_DISABLED']) delete process.env[k];
});

describe('pure pieces', () => {
  it('the store row → config: absent = shadow + the owner canary; malformed values fall back', () => {
    // (+ the build 2026-10-08 A2b lane fields, defaults: shadow / 0.1 — pinned in tool-diet-lanes.test.ts)
    expect(toolDietConfigFrom(null)).toMatchObject({ chatToolGroups: 'shadow', canaryUserIds: [OWNER], canaryDefault: true });
    expect(toolDietConfigFrom({ chatToolGroups: 'act', canaryUserIds: [] })).toMatchObject({ chatToolGroups: 'act', canaryUserIds: [], canaryDefault: false });
    expect(toolDietConfigFrom({ chatToolGroups: 'bogus', canaryUserIds: ['a', ' a ', 3, ''] })).toMatchObject({ chatToolGroups: 'shadow', canaryUserIds: ['a'], canaryDefault: false });
  });
  it('the decision: shadow acts for the canary only; act for everyone; off for nobody', () => {
    const shadow = toolDietConfigFrom(null);
    expect(decideChatToolGroups(shadow, OWNER)).toEqual({ mode: 'shadow', acts: true, canary: true });
    expect(decideChatToolGroups(shadow, MEMBER)).toEqual({ mode: 'shadow', acts: false, canary: false });
    expect(decideChatToolGroups(toolDietConfigFrom({ chatToolGroups: 'act' }), MEMBER).acts).toBe(true);
    expect(decideChatToolGroups(toolDietConfigFrom({ chatToolGroups: 'off' }), OWNER).acts).toBe(false);
  });
  it('eligibility: a signed-in human plain-chat top-level run only', () => {
    const base = { profileKind: 'chat', sessionId: 'c1', machineTriggered: false, userId: MEMBER };
    expect(isHumanPlainChatRun(base)).toBe(true);
    expect(isHumanPlainChatRun({ ...base, supervisorTools: true })).toBe(false);
    expect(isHumanPlainChatRun({ ...base, machineTriggered: true })).toBe(false);
    expect(isHumanPlainChatRun({ ...base, role: 'cross_checker' })).toBe(false);
    expect(isHumanPlainChatRun({ ...base, profileKind: 'coding' })).toBe(false);
    expect(isHumanPlainChatRun({ ...base, sessionId: 'anon-x', userId: null })).toBe(false);
  });
  it('the initial view = core + account + preload + gateway; text hints add their group; wouldMiss counts only non-core misses', () => {
    const names = runToolSchemasForProbe({ kind: 'chat' }).map((t: any) => t.function.name);
    const view = chatToolGroupsInitialView(names, { text: 'hello', triage: false });
    for (const n of ['search_engine', 'start_coding_session', 'remember_fact', 'notify_user', ...CHAT_PRELOAD_TOOLS, ...TOOL_GROUP_META_TOOLS]) expect(view.has(n)).toBe(true);
    for (const n of ['create_project', 'gmail_search', 'get_fleet_telemetry', 'list_feedback']) expect(view.has(n)).toBe(false);
    expect(chatToolGroupsInitialView(names, { text: 'check my gmail for the invoice', triage: false }).has('gmail_search')).toBe(true);
    expect(wouldMissTools(['search_engine', 'create_project', 'call_in'], new Set(names), view)).toEqual(['create_project']);
    expect(calledToolNames([{ type: 'tool_call', name: 'a' }, { type: 'text' }, { type: 'tool_call', name: 'a' }, { type: 'tool_call', name: 'b' }])).toEqual(['a', 'b']);
  });
  it('ToolGroupSession.loadTools: single tools, no whole group, no eviction, stops at the cap', () => {
    const s = new ToolGroupSession(['search_engine', 'create_canvas', 'create_project', 'gmail_search']);
    expect(s.loadTools(['create_canvas', 'search_engine', 'nope'])).toEqual(['create_canvas']);
    expect(s.isVisible('create_canvas')).toBe(true);
    expect(s.isVisible('create_project')).toBe(false); // same group, not loaded
    const capped = new ToolGroupSession(['search_engine', 'create_canvas', 'create_project'], 2);
    expect(capped.loadTools(['create_canvas', 'create_project'])).toEqual(['create_canvas']);
  });
});

describe('A2-1 guest subset (prod: a guest turn was sent 208 tools; 1 platform call in 59 guest turns)', () => {
  const guest = (extra?: Partial<AgentRunInput>) => makeInput({ sessionId: 'anon-2f9c', userId: undefined, userTurnAt: undefined, userMessage: "what's bitcoin at right now, and remind me tomorrow", ...extra });

  it('offers only the guest tools; a by-name call to a removed account tool is refused, never executed; one tool_diet row', async () => {
    mockRunModelTurn.mockResolvedValueOnce(call('c1', 'schedule_message', { prompt: 'bitcoin price', delayMinutes: 1440 })).mockResolvedValue(FINAL);
    await runCodingAgent(guest());
    const offered = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(offered.length).toBeLessThanOrEqual(GUEST_TOOL_NAMES.size);
    for (const n of offered) expect(GUEST_TOOL_NAMES.has(n)).toBe(true);
    expect(offered).toEqual(expect.arrayContaining(['search_engine', 'scrape_as_markdown', 'web_pipe', 'create_document', 'delegate']));
    expect(offered).not.toContain('ask_user');
    expect(mockExecuteCodingTool).not.toHaveBeenCalledWith(expect.anything(), 'schedule_message', expect.anything());
    expect(rows('guard_strike').some((r) => r.meta?.reason === 'tool_not_offered' && r.meta?.tool === 'schedule_message')).toBe(true);
    const diet = rows('tool_diet');
    expect(diet).toHaveLength(1);
    expect(diet[0].meta).toMatchObject({ segment: 'guest', acted: true, offeredTools: offered.length, called: ['schedule_message'] });
    expect(diet[0].meta.fullTools).toBeGreaterThan(150);
    expect(diet[0].meta.offeredChars / diet[0].meta.fullChars).toBeLessThan(0.15);
    // no tool-diet store read for a guest
    expect(mockStoreGet.mock.calls.some((c) => (c[0] as string[]).join('/') === 'instance/tool-diet')).toBe(false);
  });

  it('GUEST_TOOL_SUBSET_DISABLED=1 restores the full chat roster and records no row', async () => {
    process.env.GUEST_TOOL_SUBSET_DISABLED = '1';
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(guest());
    const offered = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(offered.length).toBeGreaterThan(150);
    expect(offered).toContain('schedule_message');
    expect(rows('tool_diet')).toEqual([]);
  });

  it('a guest run never gets progressive disclosure (no gateway pair)', async () => {
    _store.set(DIET_NS, { chatToolGroups: 'act' });
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(guest());
    expect(toolNames(mockRunModelTurn.mock.calls[0])).not.toContain('list_tool_groups');
  });
});

describe('A2-2 progressive disclosure on human chat turns', () => {
  it('SHADOW (default) for a member: full list, the call executes, one would-miss row', async () => {
    mockRunModelTurn.mockResolvedValueOnce(call('c1', 'create_project', { name: 'Garden' })).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    const t1 = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(t1.length).toBeGreaterThan(150);
    expect(t1).toContain('create_project');
    expect(t1).not.toContain('list_tool_groups');
    expect(mockExecuteCodingTool).toHaveBeenCalledWith(expect.anything(), 'create_project', expect.anything());
    expect(rows('tool_groups')).toEqual([]);
    const diet = rows('tool_diet');
    expect(diet).toHaveLength(1);
    expect(diet[0].meta).toMatchObject({ segment: 'human_chat', mode: 'shadow', acted: false, canary: false, called: ['create_project'], wouldMiss: ['create_project'] });
    expect(diet[0].value).toBe(1);
    expect(diet[0].meta.offeredChars).toBeLessThan(diet[0].meta.fullChars * 0.65);
    expect(systemNotesAny('[HARNESS NOTE — TOOL GROUPS')).toBe(false);
  });

  it('the OWNER canary ACTS: core-first view, a hidden tool called by name auto-loads and executes, the group stays (add-only), one row', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(call('c1', 'create_project', { name: 'Garden' }))
      .mockResolvedValueOnce(call('c2', 'create_canvas', { title: 'Plan', content: 'x' }))
      .mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput({ userId: OWNER }));
    const t1 = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(t1).toEqual(expect.arrayContaining(['search_engine', 'start_coding_session', 'remember_fact', 'create_canvas', 'topology_check', ...TOOL_GROUP_META_TOOLS]));
    expect(t1).not.toContain('create_project');
    expect(t1).not.toContain('gmail_search');
    expect(t1.length).toBeLessThan(110);
    // auto-loaded and executed — never a tool_not_offered refusal
    expect(mockExecuteCodingTool).toHaveBeenCalledWith(expect.anything(), 'create_project', expect.anything());
    expect(rows('guard_strike').filter((r) => r.meta?.reason === 'tool_not_offered')).toEqual([]);
    const t2 = toolNames(mockRunModelTurn.mock.calls[1]);
    expect(t2).toEqual(expect.arrayContaining(['create_project', 'rename_chat', 'move_chat'])); // the whole group, no cap
    const t3 = toolNames(mockRunModelTurn.mock.calls[2]);
    expect(t3).toEqual(expect.arrayContaining(t2)); // add-only: nothing evicted
    expect(mockSystemAtCall[0].some((n) => n.startsWith('[HARNESS NOTE — TOOL GROUPS'))).toBe(true);
    const diet = rows('tool_diet');
    expect(diet).toHaveLength(1);
    expect(diet[0].meta).toMatchObject({ segment: 'human_chat', mode: 'shadow', acted: true, canary: true, wouldMiss: ['create_project'], autoLoads: 1 });
    const tg = rows('tool_groups');
    expect(tg).toHaveLength(1);
    expect(tg[0].meta).toMatchObject({ cap: null, evicted: [] });
    expect(result.toolGroupsLoaded).toEqual(expect.arrayContaining(['account', 'platform_actions']));
  });

  it('a text hint preloads its connector group on turn 1 (owner: "check my gmail")', async () => {
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ userId: OWNER, userMessage: 'check my gmail for the Acme invoice' }));
    expect(toolNames(mockRunModelTurn.mock.calls[0])).toContain('gmail_search');
  });

  it("store mode 'act' widens to every member; 'off' acts for nobody but still records the would-miss", async () => {
    _store.set(DIET_NS, { chatToolGroups: 'act' });
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(toolNames(mockRunModelTurn.mock.calls[0])).toContain('list_tool_groups');
    expect(rows('tool_diet')[0].meta).toMatchObject({ mode: 'act', acted: true, canary: false });

    jest.clearAllMocks();
    __resetToolDietConfigForTests();
    _store.set(DIET_NS, { chatToolGroups: 'off' });
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ userId: OWNER }));
    expect(toolNames(mockRunModelTurn.mock.calls[0])).not.toContain('list_tool_groups');
    expect(rows('tool_diet')[0].meta).toMatchObject({ mode: 'off', acted: false, canary: true });
  });

  it('never a supervisor turn, a machine wake or a worker — full list, no row, no store read', async () => {
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ userId: OWNER, profile: supervisorProfile() }));
    expect(toolNames(mockRunModelTurn.mock.calls[0])).toContain('create_project');
    expect(toolNames(mockRunModelTurn.mock.calls[0])).not.toContain('list_tool_groups');
    await runCodingAgent(makeInput({ userId: OWNER, machineTriggered: true, userTurnAt: undefined }));
    expect(toolNames(mockRunModelTurn.mock.calls[1])).not.toContain('list_tool_groups');
    expect(rows('tool_diet')).toEqual([]);
    expect(mockStoreGet.mock.calls.some((c) => (c[0] as string[]).join('/') === 'instance/tool-diet')).toBe(false);
  });

  it('CHAT_TOOL_GROUPS_DISABLED=1 = today: the owner gets the full list, no row, no store read', async () => {
    process.env.CHAT_TOOL_GROUPS_DISABLED = '1';
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ userId: OWNER }));
    expect(toolNames(mockRunModelTurn.mock.calls[0])).not.toContain('list_tool_groups');
    expect(toolNames(mockRunModelTurn.mock.calls[0])).toContain('create_project');
    expect(rows('tool_diet')).toEqual([]);
    expect(mockStoreGet.mock.calls.some((c) => (c[0] as string[]).join('/') === 'instance/tool-diet')).toBe(false);
  });

  it('the global TOOL_GROUPS_DISABLED=1 also keeps the canary on the full list (no row — nothing acted)', async () => {
    process.env.TOOL_GROUPS_DISABLED = '1';
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ userId: OWNER }));
    expect(toolNames(mockRunModelTurn.mock.calls[0])).not.toContain('list_tool_groups');
    expect(rows('tool_diet')).toEqual([]);
  });

  it('a store read failure = the defaults (shadow + owner canary) — nothing widens', async () => {
    mockStoreGet.mockRejectedValueOnce(new Error('db down'));
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(toolNames(mockRunModelTurn.mock.calls[0])).not.toContain('list_tool_groups');
    expect(rows('tool_diet')[0].meta).toMatchObject({ mode: 'shadow', acted: false });
  });
});

function systemNotesAny(prefix: string): boolean {
  return mockSystemAtCall.some((notes) => notes.some((n) => n.startsWith(prefix)));
}

describe('the prompt-token drop per turn type (tool schemas; o200k when js-tiktoken is present)', () => {
  const tok = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getEncoding } = require('js-tiktoken');
      const enc = getEncoding('o200k_base');
      return (s: string) => enc.encode(s).length as number;
    } catch { return null; }
  })();
  it('guest ≤ 15 % of the full chat roster; a signed-in human chat turn starts ≤ 65 %; the supervisor keeps its full roster', () => {
    const chat = runToolSchemasForProbe({ kind: 'chat' });
    const names = chat.map((t: any) => t.function.name);
    const guest = guestToolSubset(chat.filter((t: any) => t.function.name !== 'ask_user'));
    const view = chatToolGroupsInitialView(names, { text: 'hello', triage: false });
    const human = chat.filter((t: any) => view.has(t.function.name));
    const sup = runToolSchemasForProbe({ kind: 'chat', supervisorTools: true });
    const full = schemaChars(chat);
    const report = {
      full: { tools: chat.length, chars: full, tokens: tok?.(JSON.stringify(chat)) ?? null },
      guest: { tools: guest.length, chars: schemaChars(guest), tokens: tok?.(JSON.stringify(guest)) ?? null },
      human_chat_initial: { tools: human.length + TOOL_GROUP_META_TOOLS.length, chars: schemaChars(human), tokens: tok?.(JSON.stringify(human)) ?? null },
      supervisor: { tools: sup.length, chars: schemaChars(sup), tokens: tok?.(JSON.stringify(sup)) ?? null },
    };
    // eslint-disable-next-line no-console
    console.log('[tool-diet] per-turn-type tool schema size', JSON.stringify(report));
    expect(report.guest.chars / full).toBeLessThan(0.15);
    expect(report.human_chat_initial.chars / full).toBeLessThan(0.65);
    expect(sup.length).toBeGreaterThan(chat.length); // supervisors keep everything (+ their own tools)
    // every guest tool is a chat tool, and no guest tool is an account / platform write
    for (const t of guest) expect(['core']).toContain(groupForTool(t.function.name));
  });
});

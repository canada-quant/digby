/**
 * LANE-AWARE STARTING TOOL SETS (build 2026-10-08 A2b; coding/tool-diet.ts) — owner 2026-10-08: "is this properly
 * configured with the jev / laya decision model? i thought that stopped a lot of unnecessary tools". The turn_plan
 * purpose classifies every human turn into a lane, but no tool set depended on it. These tests pin:
 *   - the pure pieces (plan → hint, the lane views, the decision, the row fields);
 *   - the agent loop: an ACTING lane starts from its own view, a held-back / unloaded tool called by name auto-loads
 *     and executes (never a tool_not_offered refusal), shadow records the lane's would-miss, 'late' plans never act,
 *     the kill switch never reads the hint;
 *   - the REPLAY: 627 real human-chat turns (14 d to 2026-10-08, coding/__fixtures__/turn-plan-lane-tools-2026-10-08.json
 *     — lane + needs_live_web from metadata.depth.turnPlan joined to the same answer row's tool calls): every tool a
 *     lane's turns really called is in the lane's view or auto-loadable, the per-lane would-miss rates, and the
 *     per-lane schema-token drop.
 *
 * Scaffold mirrors tool-diet.test.ts (same mock set).
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
// Web tools resolve through the run's ToolCache — answered offline here (no network, no open handles).
const mockWebCall: jest.Mock = jest.fn(async () => 'web result: ok');
jest.mock('../tool-executor', () => {
  const actual = jest.requireActual('../tool-executor');
  class FakeToolCache { getOrExecute(...a: any[]) { return mockWebCall(...a); } setRunContext() { /* no-op */ } }
  return { ...actual, ToolCache: FakeToolCache };
});

import * as fs from 'fs';
import * as path from 'path';
import { runCodingAgent, runToolSchemasForProbe } from './agent';
import type { AgentRunInput } from './agent';
import { chatProfile } from './agent-profiles';
import {
  TOOL_DIET_CANARY_DEFAULT_USER_IDS, __resetToolDietConfigForTests, toolDietConfigFrom, chatToolGroupsInitialView, schemaChars,
  toolLaneHintFromPlan, readToolLaneHint, laneToolView, laneWouldMissTools, decideLaneToolSets, chatLaneDiet, laneDietMeta,
  QUICK_LANE_TOOL_NAMES, CHECKED_LANE_TOOLS, RESEARCH_LANE_TOOLS, WEB_LANE_TOOLS, LANE_WEB_DROP_BELOW_DEFAULT,
  type ToolLane, type ToolLaneHint,
} from './tool-diet';
import { TOOL_GROUP_META_TOOLS, ToolGroupSession, ACCOUNT_GROUP_TOOLS } from './tool-groups';
import { __resetLearnedToolLimitsForTests } from './provider-limits';
import { __resetSeatInvalidRequestLatchesForTests } from './seat-invalid-request';
import { __resetProviderCooldownForTests } from './provider-cooldown';

const OWNER = TOOL_DIET_CANARY_DEFAULT_USER_IDS[0];
const MEMBER = '5b0c1d2e-0000-4000-8000-00000000abcd';
const DIET_NS = 'instance/tool-diet::config';

const CHAT = runToolSchemasForProbe({ kind: 'chat' });
const NAMES: string[] = CHAT.map((t: any) => t.function.name);
const FULL = new Set(NAMES);
const hint = (lane: ToolLane, needsLiveWeb: number | null = 0.5): ToolLaneHint => ({ lane, needsLiveWeb });
const view = (lane: ToolLane, text = 'hello', needsLiveWeb: number | null = 0.5, extra: Partial<Parameters<typeof laneToolView>[1]> = {}) =>
  laneToolView(NAMES, { text, triage: false, hint: hint(lane, needsLiveWeb), ...extra });

const makeInput = (extra?: Partial<AgentRunInput>): AgentRunInput => ({
  worktree: '',
  sessionId: '7d1f0e2a-1111-4222-8333-444455556666',
  projectId: 'chat',
  userId: OWNER,
  permissionMode: 'auto',
  model: 'glm-5.3',
  projectName: 'chat',
  branch: 'chat',
  profile: chatProfile('thinking', false),
  doctrineOverride: 'You are Digby.',
  history: [] as any,
  userMessage: "what's the weather in Lisbon tomorrow?",
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
  mockRunModelTurn.mockReset();
  mockWebCall.mockResolvedValue('web result: ok');
});
afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
  delete process.env.ZAI_API_KEY;
  for (const k of ['TOOL_GROUPS_DISABLED', 'TOOL_GROUPS_ALWAYS', 'GUEST_TOOL_SUBSET_DISABLED', 'CHAT_TOOL_GROUPS_DISABLED']) delete process.env[k];
});

describe('pure pieces', () => {
  it('the store row: laneToolSets defaults to shadow, laneWebDropBelow to 0.05 (a number in 0..1 only)', () => {
    expect(LANE_WEB_DROP_BELOW_DEFAULT).toBe(0.05);
    expect(toolDietConfigFrom(null)).toEqual({ chatToolGroups: 'shadow', canaryUserIds: [OWNER], canaryDefault: true, laneToolSets: 'shadow', laneWebDropBelow: 0.05 });
    expect(toolDietConfigFrom({ laneToolSets: 'act', laneWebDropBelow: 0 })).toMatchObject({ laneToolSets: 'act', laneWebDropBelow: 0 });
    expect(toolDietConfigFrom({ laneToolSets: 'bogus', laneWebDropBelow: 3 })).toMatchObject({ laneToolSets: 'shadow', laneWebDropBelow: 0.05 });
    expect(toolDietConfigFrom({ laneToolSets: 'off', laneWebDropBelow: '0.5' })).toMatchObject({ laneToolSets: 'off', laneWebDropBelow: 0.05 });
  });

  it('plan → hint: only a CLASSIFIED plan counts (the preset fallback lane is not a classification); the getter never throws', () => {
    expect(toolLaneHintFromPlan({ lane: 'quick', cls: { needsLiveWeb: 0.93 } })).toEqual({ lane: 'quick', needsLiveWeb: 0.93 });
    expect(toolLaneHintFromPlan({ lane: 'checked', cls: { needsLiveWeb: null } })).toEqual({ lane: 'checked', needsLiveWeb: null });
    expect(toolLaneHintFromPlan({ lane: 'standard', cls: null })).toBeNull(); // decideTurnPlan's quiet() / no-answer plan
    expect(toolLaneHintFromPlan({ lane: 'bogus', cls: { needsLiveWeb: 0.1 } })).toBeNull();
    expect(toolLaneHintFromPlan(null)).toBeNull();
    expect(readToolLaneHint(() => { throw new Error('boom'); })).toBeNull();
    expect(readToolLaneHint(undefined)).toBeNull();
    expect(readToolLaneHint(() => ({ lane: 'research', needsLiveWeb: NaN }))).toEqual({ lane: 'research', needsLiveWeb: null });
  });

  it('the decision: a lane set acts only where A2 acts — shadow ⇒ the canary; act ⇒ everyone A2 acts for; off ⇒ nobody', () => {
    const cfg = (laneToolSets: string) => toolDietConfigFrom({ laneToolSets });
    expect(decideLaneToolSets(cfg('shadow'), OWNER, true)).toEqual({ mode: 'shadow', acts: true, canary: true });
    expect(decideLaneToolSets(cfg('shadow'), OWNER, false)).toEqual({ mode: 'shadow', acts: false, canary: true });
    expect(decideLaneToolSets(cfg('shadow'), MEMBER, true)).toEqual({ mode: 'shadow', acts: false, canary: false });
    expect(decideLaneToolSets(cfg('act'), MEMBER, true).acts).toBe(true);
    expect(decideLaneToolSets(cfg('act'), MEMBER, false).acts).toBe(false);
    expect(decideLaneToolSets(cfg('off'), OWNER, true).acts).toBe(false);
  });

  it('QUICK: web reads + the minimal read set + the gateway pair — no platform / connector / coding / fleet tools', () => {
    const q = view('quick', "what's the weather in Lisbon tomorrow?", 0.95).view;
    const expected = new Set([...QUICK_LANE_TOOL_NAMES.filter((n) => FULL.has(n)), ...TOOL_GROUP_META_TOOLS]);
    expect([...q].sort()).toEqual([...expected].sort());
    for (const n of ['start_coding_session', 'goal_create', 'schedule_message', 'remember_fact', 'create_project', 'gmail_search', 'delegate', 'create_document', 'ask_user']) expect(q.has(n)).toBe(false);
    expect(q.size).toBeLessThanOrEqual(14);
  });

  it('QUICK: what the TEXT names comes along — hint-rule groups, cue tools, a verbatim tool name', () => {
    expect(view('quick', 'remember that I take my coffee black').view.has('remember_fact')).toBe(true); // account hint rule
    for (const n of ACCOUNT_GROUP_TOOLS) if (FULL.has(n)) expect(view('quick', 'remember that I take my coffee black').view.has(n)).toBe(true);
    expect(view('quick', 'check my gmail for the invoice').view.has('gmail_search')).toBe(true);
    expect(view('quick', 'remind me tomorrow at 9 to call mom').view.has('schedule_message')).toBe(true);
    expect(view('quick', 'draw me a picture of a fox').view.has('generate_image')).toBe(true);
    expect(view('quick', 'turn this into a pdf').view.has('create_document')).toBe(true);
    expect(view('quick', 'the upload button is broken').view.has('file_feedback')).toBe(true);
    expect(view('quick', 'run goal_list for me').view.has('goal_list')).toBe(true);
    // the habitual account group is NOT a quick turn's default
    expect(view('quick', 'what is 15% of 80').view.has('remember_fact')).toBe(false);
  });

  it("STANDARD = A2's view exactly; CHECKED adds the uploads; RESEARCH adds uploads + connector search reads", () => {
    const a2 = chatToolGroupsInitialView(NAMES, { text: 'explain recursion', triage: false });
    expect([...view('standard', 'explain recursion').view].sort()).toEqual([...a2].sort());
    const c = view('checked', 'explain recursion').view;
    expect([...c].sort()).toEqual([...new Set([...a2, ...CHECKED_LANE_TOOLS.filter((n) => FULL.has(n))])].sort());
    const r = view('research', 'explain recursion').view;
    expect([...r].sort()).toEqual([...new Set([...a2, ...RESEARCH_LANE_TOOLS.filter((n) => FULL.has(n))])].sort());
    expect(r.has('github_search_code')).toBe(true);
  });

  it('WEB DROP: needs_live_web below the bar holds the web tools back on quick / standard only, unless the text asks for the web', () => {
    const s = view('standard', 'explain how recursion works', 0.04);
    expect(s.webDropped).toBe(true);
    for (const n of WEB_LANE_TOOLS) expect(s.view.has(n)).toBe(false);
    expect(view('quick', 'what is 15% of 80', 0.02).view.has('search_engine')).toBe(false);
    expect(view('standard', 'explain recursion', 0.5).webDropped).toBe(false);
    expect(view('standard', 'search the web for recursion explainers', 0.04).webDropped).toBe(false); // a web cue keeps them
    expect(view('standard', 'explain https://example.com/post', 0.04).webDropped).toBe(false);
    expect(view('checked', 'explain recursion', 0.01).webDropped).toBe(false); // never on checked / research
    expect(view('research', 'explain recursion', 0.01).webDropped).toBe(false);
    expect(view('standard', 'explain recursion', 0.04, { webDropBelow: 0 }).webDropped).toBe(false); // store laneWebDropBelow 0 = never
    expect(view('standard', 'explain recursion', null).webDropped).toBe(false); // no noul answer = no drop
    expect(view('standard', 'call web_pipe on it', 0.04).view.has('web_pipe')).toBe(true); // a verbatim name survives the drop
  });

  it('harness extras (keep) are always in view; the would-miss counts held-back core tools but never the gateway pair', () => {
    expect(view('quick', 'hi', 0.5, { keep: ['call_in', 'not_in_list'] }).view.has('not_in_list')).toBe(false);
    const v = view('quick', 'hi', 0.5).view;
    expect(laneWouldMissTools(['search_engine', 'goal_create', 'load_tools', 'not_a_tool'], FULL, v)).toEqual(['goal_create']);
  });

  it('chatLaneDiet + laneDietMeta: offered size from the real schemas; a late record never acts; no hint ⇒ no fields', () => {
    const decision = { mode: 'shadow' as const, acts: true, canary: true };
    const base = { text: 'what is the capital of Peru', triage: false, webDropBelow: 0.1, decision };
    const start = chatLaneDiet(hint('quick', 0.6), CHAT, { ...base, source: 'start' })!;
    expect(start).toMatchObject({ lane: 'quick', acts: true, source: 'start', webDropped: false });
    expect(start.offeredChars).toBeGreaterThan(0);
    expect(start.offeredChars / schemaChars(CHAT)).toBeLessThan(0.1);
    expect(chatLaneDiet(hint('quick', 0.6), CHAT, { ...base, source: 'late' })!.acts).toBe(false);
    expect(chatLaneDiet(null, CHAT, { ...base, source: 'start' })).toBeNull();
    expect(laneDietMeta(null, ['x'], FULL)).toEqual({});
    expect(laneDietMeta(start, ['search_engine', 'create_project'], FULL)).toMatchObject({
      lane: 'quick', needsLiveWeb: 0.6, laneMode: 'shadow', laneActed: true, laneCanary: true, laneSource: 'start', webDropped: false,
      laneOfferedTools: start.offeredTools, laneWouldMiss: ['create_project'],
    });
  });
});

describe('the agent loop', () => {
  const quickHint = jest.fn((): ToolLaneHint | null => ({ lane: 'quick', needsLiveWeb: 0.95 }));

  it('the OWNER canary ACTS on a quick turn: lane view only; a held-back core tool and an unloaded platform tool called by name auto-load and execute', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(call('c1', 'search_engine', { query: 'Lisbon weather tomorrow' }))
      .mockResolvedValueOnce(call('c2', 'goal_create', { title: 'Trip' }))
      .mockResolvedValueOnce(call('c3', 'create_project', { name: 'Trip' }))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ toolLaneHint: quickHint }));
    const t1 = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(t1).toEqual(expect.arrayContaining(['search_engine', 'scrape_as_markdown', 'web_pipe', 'search_memory', ...TOOL_GROUP_META_TOOLS]));
    for (const n of ['goal_create', 'create_project', 'start_coding_session', 'remember_fact', 'delegate']) expect(t1).not.toContain(n);
    expect(t1.length).toBeLessThanOrEqual(16);
    // never a refusal: the offered web search and both auto-loaded tools executed
    expect(mockWebCall).toHaveBeenCalledWith('search_engine', expect.anything());
    expect(mockExecuteCodingTool).toHaveBeenCalledWith(expect.anything(), 'goal_create', expect.anything());
    expect(mockExecuteCodingTool).toHaveBeenCalledWith(expect.anything(), 'create_project', expect.anything());
    expect(rows('guard_strike').filter((r) => r.meta?.reason === 'tool_not_offered')).toEqual([]);
    expect(toolNames(mockRunModelTurn.mock.calls[2])).toContain('goal_create'); // add-only: it stays
    expect(mockSystemAtCall[0].some((n) => n.startsWith('[HARNESS NOTE — TOOL GROUPS') && n.includes('held back for this turn'))).toBe(true);
    const diet = rows('tool_diet');
    expect(diet).toHaveLength(1);
    expect(diet[0].meta).toMatchObject({
      segment: 'human_chat', acted: true, lane: 'quick', laneMode: 'shadow', laneActed: true, laneCanary: true, laneSource: 'start',
      webDropped: false, laneWouldMiss: ['goal_create', 'create_project'],
    });
    expect(diet[0].meta.laneOfferedChars / diet[0].meta.fullChars).toBeLessThan(0.1);
    expect(rows('tool_groups')[0].meta).toMatchObject({ autoLoads: 2 });
  });

  it('a MEMBER in shadow: the full list, nothing withheld; the row records the quick lane would-miss', async () => {
    mockRunModelTurn.mockResolvedValueOnce(call('c1', 'goal_create', { title: 'Trip' })).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ userId: MEMBER, toolLaneHint: quickHint }));
    const t1 = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(t1).toContain('goal_create');
    expect(t1).not.toContain('list_tool_groups');
    expect(rows('tool_diet')[0].meta).toMatchObject({ acted: false, lane: 'quick', laneActed: false, laneCanary: false, laneSource: 'start', laneWouldMiss: ['goal_create'], wouldMiss: [] });
  });

  it("store laneToolSets 'off': the owner keeps A2's core-first view (the lane does not act) and the row still records the lane", async () => {
    _store.set(DIET_NS, { laneToolSets: 'off' });
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ toolLaneHint: quickHint }));
    const t1 = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(t1).toContain('list_tool_groups');
    expect(t1).toContain('start_coding_session'); // A2 core
    expect(rows('tool_diet')[0].meta).toMatchObject({ acted: true, lane: 'quick', laneMode: 'off', laneActed: false });
  });

  it('a plan that arrives only after run start is recorded as a LATE shadow row and never acts', async () => {
    let calls = 0;
    const late = jest.fn((): ToolLaneHint | null => (++calls === 1 ? null : { lane: 'quick', needsLiveWeb: 0.9 }));
    mockRunModelTurn.mockResolvedValueOnce(call('c1', 'goal_list')).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ toolLaneHint: late }));
    expect(toolNames(mockRunModelTurn.mock.calls[0])).toContain('goal_list'); // A2 view (core)
    expect(rows('tool_diet')[0].meta).toMatchObject({ acted: true, lane: 'quick', laneActed: false, laneSource: 'late', laneWouldMiss: ['goal_list'] });
  });

  it('WEB DROP acting: a standard turn with needs_live_web 0.03 starts without the web tools; a search by name still runs', async () => {
    mockRunModelTurn.mockResolvedValueOnce(call('c1', 'search_engine', { query: 'recursion' })).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ userMessage: 'explain how recursion works', toolLaneHint: () => ({ lane: 'standard', needsLiveWeb: 0.03 }) }));
    const t1 = toolNames(mockRunModelTurn.mock.calls[0]);
    for (const n of WEB_LANE_TOOLS) expect(t1).not.toContain(n);
    expect(t1).toContain('start_coding_session'); // the rest of A2's view
    expect(mockWebCall).toHaveBeenCalledWith('search_engine', expect.anything());
    expect(rows('guard_strike').filter((r) => r.meta?.reason === 'tool_not_offered')).toEqual([]);
    expect(toolNames(mockRunModelTurn.mock.calls[1])).toContain('search_engine');
    expect(rows('tool_diet')[0].meta).toMatchObject({ lane: 'standard', laneActed: true, webDropped: true, laneWouldMiss: ['search_engine'] });
  });

  it('a STANDARD lane that acts offers exactly what A2 offers', async () => {
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ userMessage: 'explain recursion', toolLaneHint: () => ({ lane: 'standard', needsLiveWeb: 0.5 }) }));
    const withLane = toolNames(mockRunModelTurn.mock.calls[0]).sort();
    jest.clearAllMocks();
    __resetToolDietConfigForTests();
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ userMessage: 'explain recursion' }));
    expect(toolNames(mockRunModelTurn.mock.calls[0]).sort()).toEqual(withLane);
    expect(rows('tool_diet')[0].meta.lane).toBeUndefined(); // no hint ⇒ no lane fields
  });

  it('CHAT_TOOL_GROUPS_DISABLED=1: the hint is never read, no row; a supervisor / machine run never reads it either', async () => {
    process.env.CHAT_TOOL_GROUPS_DISABLED = '1';
    const getter = jest.fn((): ToolLaneHint | null => ({ lane: 'quick', needsLiveWeb: 0.9 }));
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ toolLaneHint: getter }));
    expect(toolNames(mockRunModelTurn.mock.calls[0])).toContain('start_coding_session');
    expect(getter).not.toHaveBeenCalled();
    expect(rows('tool_diet')).toEqual([]);
    delete process.env.CHAT_TOOL_GROUPS_DISABLED;
    await runCodingAgent(makeInput({ toolLaneHint: getter, machineTriggered: true, userTurnAt: undefined }));
    expect(getter).not.toHaveBeenCalled();
  });

  it('a throwing getter = no lane (A2 behaviour), never a failed run', async () => {
    mockRunModelTurn.mockResolvedValue(FINAL);
    const r = await runCodingAgent(makeInput({ toolLaneHint: () => { throw new Error('plan exploded'); } }));
    expect(r.finalText).toBe('Done.');
    expect(rows('tool_diet')[0].meta).toMatchObject({ acted: true });
    expect(rows('tool_diet')[0].meta.lane).toBeUndefined();
  });
});

// ── REPLAY: the real lanes' real tool calls (prod, 14 d to 2026-10-08) ───────────────────────────────────────────
type FixtureRow = { lane: ToolLane; needsLiveWeb: number | null; tools: string[]; n: number };
const FIXTURE: { turns: number; rows: FixtureRow[] } = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'turn-plan-lane-tools-2026-10-08.json'), 'utf8'));

describe('replay — 627 real human-chat turns: every called tool is offered or auto-loads; per-lane would-miss + schema drop', () => {
  const tok = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getEncoding } = require('js-tiktoken');
      const enc = getEncoding('o200k_base');
      return (s: string) => enc.encode(s).length as number;
    } catch { return null; }
  })();
  const fullChars = schemaChars(CHAT);
  const fullTokens = tok?.(JSON.stringify(CHAT)) ?? null;
  const a2View = chatToolGroupsInitialView(NAMES, { text: '', triage: false });
  const a2Chars = schemaChars(CHAT.filter((t: any) => a2View.has(t.function.name)));

  it('every tool each lane really called is in its view or auto-loads by name (no text cues — the worst case)', () => {
    expect(FIXTURE.turns).toBe(627);
    for (const r of FIXTURE.rows) {
      const lv = laneToolView(NAMES, { text: '', triage: false, hint: { lane: r.lane, needsLiveWeb: r.needsLiveWeb } });
      const s = new ToolGroupSession(NAMES);
      s.seedView(lv.view);
      for (const n of r.tools.filter((x) => FULL.has(x))) {
        if (lv.view.has(n)) { expect(s.isVisible(n)).toBe(true); continue; }
        expect(s.ensureLoadedFor(n)).toMatchObject({ ok: true });
        expect(s.isVisible(n)).toBe(true);
      }
    }
  });

  it('per-lane would-miss rates and schema size (printed; pinned with margin)', () => {
    const report: Record<string, any> = {};
    // Schema size per distinct view (rows of a lane share at most two views: web kept / held back).
    const sizeCache = new Map<string, { chars: number; tokens: number }>();
    const sizeOf = (lane: ToolLane, v: Set<string>) => {
      const key = `${lane}|${[...v].sort().join(',')}`;
      let s = sizeCache.get(key);
      if (!s) {
        const offered = CHAT.filter((t: any) => v.has(t.function.name));
        s = { chars: schemaChars(offered), tokens: tok ? tok(JSON.stringify(offered)) : 0 };
        sizeCache.set(key, s);
      }
      return s;
    };
    for (const lane of ['quick', 'standard', 'checked'] as ToolLane[]) {
      const rs = FIXTURE.rows.filter((r) => r.lane === lane);
      let turns = 0; let missTurns = 0; let a2MissTurns = 0; let chars = 0; let tokens = 0; let dropped = 0;
      const missed: Record<string, number> = {};
      for (const r of rs) {
        const lv = laneToolView(NAMES, { text: '', triage: false, hint: { lane, needsLiveWeb: r.needsLiveWeb } });
        const size = sizeOf(lane, lv.view);
        const miss = laneWouldMissTools(r.tools, FULL, lv.view);
        turns += r.n;
        if (miss.length) missTurns += r.n;
        if (laneWouldMissTools(r.tools, FULL, a2View).length) a2MissTurns += r.n;
        if (lv.webDropped) dropped += r.n;
        for (const m of miss) missed[m] = (missed[m] ?? 0) + r.n;
        chars += size.chars * r.n;
        tokens += size.tokens * r.n;
      }
      report[lane] = {
        turns, laneMissRate: +(missTurns / turns).toFixed(4), a2MissRate: +(a2MissTurns / turns).toFixed(4), webDroppedTurns: dropped,
        meanOfferedChars: Math.round(chars / turns), meanOfferedTokens: tok ? Math.round(tokens / turns) : null,
        vsFull: +(chars / turns / fullChars).toFixed(3), vsA2: +(chars / turns / a2Chars).toFixed(3), missed,
      };
    }
    // eslint-disable-next-line no-console
    console.log('[tool-diet A2b] replay per lane', JSON.stringify({ fullChars, fullTokens, a2Chars, a2Tokens: tok?.(JSON.stringify(CHAT.filter((t: any) => a2View.has(t.function.name)))) ?? null, ...report }));
    // Measured at build time with NO text cues (the worst case — the live rows carry the turn's text, so the account
    // hint ("remember …"), the feedback / browser cues etc. only lower these): quick 3.6 % (web drop 1.5 % + a browser
    // task ×2, a feedback ticket ×1, a memory write ×1), standard 1.4 % (A2's own 0.8 % + the web drop 0.5 %),
    // checked 0 %. The quick lane offers ~4 % of the full roster's schema bytes.
    expect(report.quick.vsFull).toBeLessThan(0.06);
    expect(report.quick.laneMissRate).toBeLessThanOrEqual(0.04);
    expect(report.standard.laneMissRate).toBeLessThanOrEqual(0.015);
    expect(report.standard.vsA2).toBeLessThan(1);
    expect(report.checked.vsA2).toBeGreaterThan(1);
    expect(report.checked.laneMissRate).toBeLessThanOrEqual(report.checked.a2MissRate);
  });
});

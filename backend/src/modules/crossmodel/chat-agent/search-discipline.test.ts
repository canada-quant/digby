/**
 * Search-force removal + full-peer cross-checker (owner 2026-09-03).
 *
 * Replaces serp-async.test.ts (ticket 62761c89), whose contract — an eager
 * harness B1 SERP fired at run start and injected via injectSystem — is GONE:
 *   (a) NO harness search fires for any chat run (searchWithBrightData is
 *       never called by the chat lane); the orchestrator and the checker
 *       both start immediately;
 *   (b) the chat doctrine carries the search-discipline paragraph instead of
 *       the parallel-SERP note;
 *   (c) the L2 checker is a FULL autonomous peer: role-default 8-step tool
 *       loop (no maxSteps:1 override), web tools ON (no noWebTools), DeepSeek
 *       providerExtra { reasoning_effort:'max', thinking:{type:'enabled'} },
 *       an autonomy doctrine (no "a search was already run" wording), and the
 *       raised CROSS_CHECK_SOFT_MS deadline;
 *   (d) a router-classified SIMPLE question still stops waiting on the
 *       checker draft (soft cap) and skips the step-0 reconcile wait;
 *   (e) machineWake is unchanged: no search, NO checker, preamble-prefixed
 *       prompt;
 *   (f) finalize records ONE 'chat_search_usage' loop metric with the run's
 *       real web-tool call count;
 *   (g) capability doctrine (2026-09-08 agentic expansion): the orchestrator
 *       doctrine carries the platform playbook ("Doing things for the user"),
 *       the proactive-offer block ("Offer the next step") and THIS chat's id;
 *       the old "follow-up questions inside a" line is gone; machine wakes
 *       share the playbook (notify_user is findable); finalize records ONE
 *       'chat_platform_usage' metric with the run's platform-tool count,
 *       distinct tool names and action-chip count.
 *
 * Harness mirrors crosscheck-reconcile.test.ts: real in-memory live-runs
 * registry, everything else mocked at the module boundary.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelMessage: {
    create: jest.fn(async () => ({})),
    count: jest.fn(async ({ where }: any) => (where?.OR ? 0 : 2)),
  },
  crossModelChat: {
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUnique: jest.fn(async () => ({ title: 'A proper existing title' })),
  },
  pendingChatMessage: { findFirst: jest.fn(async () => null), delete: jest.fn(async () => ({})) },
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && redisStore.has(k)) return null;
      redisStore.set(k, v);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
    exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
    mGet: jest.fn(async (keys: string[]) => keys.map((k) => redisStore.get(k) ?? null)),
  },
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// Seat pre-flight (2026-09-04): the REAL seatUnservableReason reads provider
// env keys, and this jest env is keyless — every run would fail fast with
// SeatUnservableError before reaching the mocked workers. Keep the rest of
// coding-model REAL (resolveRoleModelForRun etc. are exercised).
jest.mock('../coding/coding-model', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/coding-model'),
  seatUnservableReason: jest.fn(async () => null),
}));

jest.mock('../coding/agent', () => ({
  runCodingAgent: jest.fn(async () => ({ finalText: 'A'.repeat(500) })),
  runChatWorker: jest.fn(async () => ({ finalText: '' })),
}));
// The chat lane must never call this again (kid path + agent tools still do —
// both outside this module). Mocked so any regression is a hard assert.
jest.mock('../mcp-search', () => ({
  searchWithBrightData: jest.fn(async () => ''),
  SEARCH_UNAVAILABLE_NOTE: '[search unavailable]',
}));
// Shared vision hop — text-only peer image parity is pinned in its own suite
// (chat-agent.service.test.ts); here it just must not fire without images.
const mockDescribeImage = jest.fn(async (..._a: any[]) => 'a described image');
jest.mock('../image-describe', () => ({
  __esModule: true,
  describeImageWithVision: (...a: any[]) => mockDescribeImage(...a),
  VISION_UTILITY_MODEL: 'glm-5.3-flash',
}));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { CHAT_SEARCH_USAGE: 'chat_search_usage', CHAT_PLATFORM_USAGE: 'chat_platform_usage', CHAT_PHANTOM_WEB_CLAIM: 'chat_phantom_web_claim' },
}));
jest.mock('../langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: { saveToSessionHistory: jest.fn(async () => {}) },
}));
jest.mock('../integrations/moonshot.integration', () => ({
  __esModule: true,
  default: { generateTitle: jest.fn(async () => 'A Generated Title') },
}));
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  clearHookDepth: jest.fn(async () => {}),
  stampHookDepth: jest.fn(async () => {}),
}));
// The wake preamble is prepended by startDetachedChatRun OUTSIDE the mocked
// chat-context — keep it a leaf so the machineWake test can assert the
// persisted prompt without pulling the real module's shape into this harness.
jest.mock('./machine-wake', () => ({
  __esModule: true,
  machineWakePreamble: jest.fn(() => '[MOCK-WAKE-PREAMBLE]\n'),
}));
jest.mock('./chat-context', () => ({
  // queryMessage passes the caller's message THROUGH — the per-question simple
  // classification reads ctx.queryMessage, so a test's message must reach it.
  buildChatQueryContext: jest.fn(async (args: any) => ({
    queryMessage: String(args?.message ?? 'the question'),
    systemContext: '',
    conversationHistory: [{ role: 'user', content: 'earlier' }],
    projectId: null,
  })),
  persistAndEmitCanvases: jest.fn(async () => []),
}));

import { startDetachedChatRun, countWebToolCalls, countPlatformToolCalls, platformToolNamesCalled } from './chat-agent.service';
import { runCodingAgent, runChatWorker } from '../coding/agent';
import { searchWithBrightData } from '../mcp-search';
import { isRunActive, subscribeRun } from '../coding/live-runs';
import { CROSS_CHECK_SOFT_MS } from '../coding/agent-profiles';

const mockRunCodingAgent = runCodingAgent as jest.Mock;
const mockRunChatWorker = runChatWorker as jest.Mock;
const mockSearch = searchWithBrightData as jest.Mock;

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for run events');
}

function persistedAssistantContent(chatId: string): string | null {
  const call = mockPrisma.crossModelMessage.create.mock.calls.find(
    ([arg]: any[]) => arg?.data?.chatId === chatId && arg?.data?.role === 'assistant',
  );
  return call ? String(call[0].data.content) : null;
}

function persistedUserContent(chatId: string): string | null {
  const call = mockPrisma.crossModelMessage.create.mock.calls.find(
    ([arg]: any[]) => arg?.data?.chatId === chatId && arg?.data?.role === 'user',
  );
  return call ? String(call[0].data.content) : null;
}

beforeEach(() => {
  jest.clearAllMocks(); // clears call history only — re-establish defaults below
  redisStore.clear();
  mockRunCodingAgent.mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
  mockRunChatWorker.mockImplementation(async () => ({ finalText: '' }));
  mockSearch.mockImplementation(async () => '');
  mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
});

describe('search-force removal (owner 2026-09-03)', () => {
  // Real-async integration suite on real timers — same 30s harness budget the
  // predecessor suite carried (jest's 5s default races parallel workers).
  jest.setTimeout(30000);

  it('(a) NO harness search fires — orchestrator and checker start immediately, run completes', async () => {
    const t0 = Date.now();
    const key = await startDetachedChatRun({ message: 'the question', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-sd-a', sessionId: null });
    expect(key).toBe('chat:chat-sd-a');
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));

    await waitFor(() => mockRunCodingAgent.mock.calls.length > 0);
    await waitFor(() => mockRunChatWorker.mock.calls.length > 0);
    expect(Date.now() - t0).toBeLessThan(5000); // nothing serialized behind any search
    await waitFor(() => !isRunActive(key!), 20000);
    await new Promise(r => setTimeout(r, 50)); // let stray fire-and-forgets settle
    expect(mockSearch).not.toHaveBeenCalled(); // the chat lane owns no harness search anymore
    expect(events.some(e => e.type === 'complete')).toBe(true);
    expect(persistedAssistantContent('chat-sd-a')).toContain('A'.repeat(100));
  });

  it('(b) the chat doctrine carries the search-discipline paragraph, not the parallel-SERP note', async () => {
    const key = await startDetachedChatRun({ message: 'the question', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-sd-b', sessionId: null });
    await waitFor(() => !isRunActive(key!), 20000);
    const doctrine = String(mockRunCodingAgent.mock.calls.at(-1)?.[0]?.doctrineOverride ?? '');
    expect(doctrine).toContain('Search discipline');
    expect(doctrine).toContain('time-sensitive');
    expect(doctrine).toContain('training cutoff');
    expect(doctrine).toContain('stable, indisputable facts');
    expect(doctrine).not.toContain('WEB SEARCH RUNNING IN PARALLEL');
    expect(doctrine).not.toContain('[search unavailable]');
  });

  it('(g1) the chat doctrine carries the capability playbook + offer block + THIS chat id, and not the old follow-up line', async () => {
    const key = await startDetachedChatRun({ message: 'the question', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-sd-g1', sessionId: null });
    await waitFor(() => !isRunActive(key!), 20000);
    const doctrine = String(mockRunCodingAgent.mock.calls.at(-1)?.[0]?.doctrineOverride ?? '');
    expect(doctrine).toContain('## Doing things for the user (you operate Digby)');
    expect(doctrine).toContain('## Offer the next step');
    // The run's chat id is the "This chat" anchor (with the mocked row's REAL
    // title; the mocked ctx has no project → "not in a project").
    expect(doctrine).toContain('This chat: id chat-sd-g1 — title "A proper existing title"; not in a project.');
    // Signed-in variant: the account tools are described by exact name.
    for (const t of ['notify_user', 'remember_fact', 'add_knowledge_url', 'create_feed', 'create_share_link', 'telegram_connect_link', 'set_chat_instructions', 'get_account_overview']) {
      expect(doctrine).toContain(t);
    }
    // The follow-ups line is the new one — same [FOLLOWUPS] markup shape
    // (uppercase + LITERAL backslash-n), action-chip guidance, old line gone.
    expect(doctrine).toContain('[FOLLOWUPS]\\n- q1\\n- q2\\n[/FOLLOWUPS]');
    expect(doctrine).toContain('ONE action chip');
    expect(doctrine).not.toContain('follow-up questions inside a');
    // Order: the playbook sits after the connected-apps block and before the cross-check note.
    const apps = doctrine.indexOf('## Your connected apps');
    const playbook = doctrine.indexOf('## Doing things for the user');
    const offers = doctrine.indexOf('## Offer the next step');
    const crossCheck = doctrine.indexOf('[PARALLEL CROSS-CHECK IN PROGRESS]');
    expect(apps).toBeGreaterThan(-1);
    expect(playbook).toBeGreaterThan(apps);
    expect(offers).toBeGreaterThan(playbook);
    expect(crossCheck).toBeGreaterThan(offers);
  });

  it('(g2) an ANONYMOUS run gets the no-account-tools variants (never pretends to save/schedule/remember)', async () => {
    const key = await startDetachedChatRun({ message: 'the question', mode: 'single_thinking' as const, userId: null, chatId: null, sessionId: 'anon-sess-g2' });
    expect(key).toBe('chat:session:anon-sess-g2');
    await waitFor(() => !isRunActive(key!), 20000);
    const doctrine = String(mockRunCodingAgent.mock.calls.at(-1)?.[0]?.doctrineOverride ?? '');
    expect(doctrine).toContain('## Doing things for the user (you operate Digby)');
    expect(doctrine).toContain('NO account tools');
    expect(doctrine).toContain('Never pretend to save, schedule, or remember anything');
    expect(doctrine).not.toContain('This chat: id');
    expect(doctrine).not.toContain('## Your connected apps');
    expect(doctrine).toContain('no action chips');
  });

  it('(c) the L2 checker runs as a FULL autonomous peer (deepseek-flash, 8 steps, web tools, max thinking)', async () => {
    mockRunChatWorker.mockImplementation(async () => ({
      finalText: 'PEER-DRAFT',
      parts: [{ type: 'tool_call', name: 'search_engine', args: { query: 'x' } }],
    }));
    const key = await startDetachedChatRun({ message: 'the question', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-sd-c', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => !isRunActive(key!), 20000);

    const checkerCall = mockRunChatWorker.mock.calls.find(([i]: any[]) => !String(i.userMessage).includes('YOUR DRAFT ANSWER'));
    expect(checkerCall).toBeTruthy();
    const [input, role] = checkerCall!;
    expect(role).toBe('cross_checker');
    expect(input.model).toBe('deepseek-flash'); // V4.1 Flash cutover 2026-09-10 (deepseek-v4-pro 2026-09-03 → 09-10; glm-5.2 one-shot before)
    // FULL peer: role-default step budget from chatProfile('thinking') — never
    // the one-shot maxSteps:1 drafter — under the raised soft deadline.
    expect(input.profile.maxSteps).toBe(8);
    expect(input.profile.runDeadlineMs).toBe(CROSS_CHECK_SOFT_MS);
    expect(CROSS_CHECK_SOFT_MS).toBe(300_000);
    // Web tools ON (no gateway-down muzzle), full-depth reasoning.
    expect(input.noWebTools).toBeUndefined();
    expect(input.providerExtra).toEqual({ reasoning_effort: 'max', thinking: { type: 'enabled' } });
    // Autonomy doctrine: its own tools, honest grounding, no user interaction,
    // and ZERO one-shot/pre-run-search wording.
    const doctrine = String(input.doctrineOverride);
    expect(doctrine).toContain('independent CROSS-CHECKER');
    expect(doctrine).toContain('your OWN live web tools');
    expect(doctrine).toContain('state your grounding honestly');
    expect(doctrine).toContain('CANNOT ask the user');
    // Artifact grounding (ticket ce9ee48d): the phantom-recap defense rides in
    // EVERY L2 checker doctrine, not just supervisor chats.
    expect(doctrine).toContain('ARTIFACT GROUNDING');
    expect(doctrine).toContain('not present in my provided context');
    expect(doctrine).not.toContain('ALREADY RUN');
    expect(doctrine).not.toContain('UNVERIFIED');
    expect(doctrine).not.toContain('no tool calls are needed');

    // The card is honest telemetry: the peer fired a web tool → webSearchUsed.
    const complete = events.find(e => e.type === 'complete')!.data;
    // Owner 2026-09-15: the checker's card is the DOUBLE CHECKER seat's card.
    expect(complete.models.double_checker).toBeTruthy();
    expect(complete.models.double_checker.webSearchUsed).toBe(true);
    expect(complete.models.double_checker.modelUsed).toBe('deepseek-flash');
    expect(complete.models.deepseek).toBeUndefined(); // no vendor-keyed cards anymore
    expect(complete.models.glm).toBeUndefined(); // the Triple Checker is not in the L2 lineup
    expect(complete.models.triple_checker).toBeUndefined();
  });

  it("(c2) a peer that never fired a web tool gets webSearchUsed:false — the flag is real usage, not the old forced-SERP claim", async () => {
    mockRunChatWorker.mockImplementation(async () => ({ finalText: 'MEMORY-DRAFT', parts: [] }));
    const key = await startDetachedChatRun({ message: 'the question', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-sd-c2', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => !isRunActive(key!), 20000);
    const complete = events.find(e => e.type === 'complete')!.data;
    expect(complete.models.double_checker.webSearchUsed).toBe(false);
  });

  it('(d) a router-classified SIMPLE question proceeds without the checker draft and skips the step-0 reconcile wait', async () => {
    // The checker draft never arrives within the test…
    mockRunChatWorker.mockImplementation(async () => new Promise(() => {}));
    const t0 = Date.now();
    // 'What is the capital of France?' — the auto router's existing heuristic
    // classifies this as single_thinking (SIMPLE): the run must NOT wait the
    // 60s step-0 late-wait (nor the 75s soft deadline) for the missing draft.
    const key = await startDetachedChatRun({ message: 'What is the capital of France?', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-sd-d', sessionId: null });
    await waitFor(() => !isRunActive(key!), 20000);
    expect(Date.now() - t0).toBeLessThan(20000);
    // No reconcile pass (the second worker call shape) — the only worker
    // invocation is the still-pending checker itself.
    expect(mockRunChatWorker).toHaveBeenCalledTimes(1);
    expect(String(mockRunChatWorker.mock.calls[0][0].userMessage)).not.toContain('YOUR DRAFT ANSWER');
    expect(persistedAssistantContent('chat-sd-d')).toContain('A'.repeat(100));
  });

  it('(e) machineWake: no search, NO peer checker (cost gate), preamble-prefixed prompt', async () => {
    const key = await startDetachedChatRun({
      message: 'fleet digest wake', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-sd-e', sessionId: null,
      machineWake: true, messageOrigin: 'schedule', userTurnAt: new Date(),
    });
    expect(key).toBe('chat:chat-sd-e');
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50)); // let any stray fire-and-forget settle before asserting silence
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockRunChatWorker).not.toHaveBeenCalled(); // machine wakes never spawn the full-peer checker
    // The wake preamble still wraps the persisted prompt (startDetachedChatRun).
    expect(persistedUserContent('chat-sd-e')).toContain('[MOCK-WAKE-PREAMBLE]');
    const doctrine = String(mockRunCodingAgent.mock.calls.at(-1)?.[0]?.doctrineOverride ?? '');
    expect(doctrine).not.toContain('WEB SEARCH RUNNING IN PARALLEL');
    // (g) machine wakes share the capability playbook ON PURPOSE — a scheduled
    // prompt ending in "then notify_user with the result" must find notify_user.
    expect(doctrine).toContain('## Doing things for the user (you operate Digby)');
    expect(doctrine).toContain('notify_user');
  });

  // Owner 2026-09-22: "we shouldn't have double checker run for machine
  // supervisors" — a hook wake / agent-sent message is a machine turn even
  // without machineWake, and it must not spawn the full-peer checker either.
  it('(e2) a hook-origin turn (no machineWake flag) spawns NO peer checker', async () => {
    const key = await startDetachedChatRun({
      message: 'hook: run 1234 completed in lane X — dispose', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-sd-e2', sessionId: null,
      messageOrigin: 'hook', userTurnAt: new Date(),
    });
    await waitFor(() => !isRunActive(key!));
    await new Promise(r => setTimeout(r, 50));
    expect(mockRunChatWorker).not.toHaveBeenCalled();
  });

  it('(e3) kill switch MACHINE_TURN_CROSSCHECK_ENABLED=1 restores the checker on hook/agent-origin turns (machineWake still skips)', async () => {
    process.env.MACHINE_TURN_CROSSCHECK_ENABLED = '1';
    try {
      const key = await startDetachedChatRun({
        message: 'agent-sent: please review the lane report and confirm', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-sd-e3', sessionId: null,
        messageOrigin: 'agent', userTurnAt: new Date(),
      });
      await waitFor(() => !isRunActive(key!));
      expect(mockRunChatWorker).toHaveBeenCalled();
    } finally {
      delete process.env.MACHINE_TURN_CROSSCHECK_ENABLED;
    }
  });

  it("(f) finalize records ONE 'chat_search_usage' metric with the run's real web-tool call count", async () => {
    mockRunCodingAgent.mockImplementation(async () => ({
      finalText: 'A'.repeat(500),
      parts: [
        { type: 'tool_call', name: 'search_engine', args: { query: 'x' } },
        { type: 'tool_result', name: 'search_engine', result: 'r' },
        { type: 'tool_call', name: 'web_pipe', args: { query: 'y' } },
        { type: 'tool_call', name: 'list_chats', args: {} }, // NOT a web tool
        { type: 'text', text: 'A'.repeat(500) },
      ],
    }));
    const key = await startDetachedChatRun({ message: 'the question', mode: 'single_thinking' as const, userId: 'u1', chatId: 'chat-sd-f', sessionId: null });
    await waitFor(() => !isRunActive(key!), 20000);
    const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'chat_search_usage');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ mode: 'single_thinking', webToolCalls: 2, machine: false });
    expect(rows[0].sessionId).toBe('chat-sd-f');
  });

  it("(h) finalize records ONE 'chat_phantom_web_claim' metric on the unbacked web-failure claim class — and never on an honest search-backed answer", async () => {
    // The class shape: a web-failure claim streams BEFORE any web call this
    // run; a healthy search comes AFTER (the selfCorrected signal). NOT a
    // replay of the real 1ef71188 incident — its own intra-run ordering is
    // unrecoverable (the claim turn made 2 web_pipe calls; guests persist no
    // per-part rows). See phantom-tool-claim.1ef71188.test.ts for the
    // corrected incident account.
    mockRunCodingAgent.mockImplementation(async () => ({
      finalText: 'Here are fresher 2026 picks for your costumes.',
      parts: [
        { type: 'text', text: 'Some first ideas for couples costumes…' },
        { type: 'text', text: 'I tried to pull fresher 2026 web material just now and the search came back garbage.' },
        { type: 'tool_call', name: 'search_engine', args: { query: 'couples halloween costumes 2026' } },
        { type: 'tool_result', name: 'search_engine', result: 'primark.com 9 Sept 2026, brit.co 8 Sept 2026' },
        { type: 'text', text: 'Fresher picks…' },
      ],
    }));
    const key = await startDetachedChatRun({ message: 'the question', mode: 'single_thinking' as const, userId: 'u1', chatId: 'chat-sd-h', sessionId: null });
    await waitFor(() => !isRunActive(key!), 20000);
    const phantomRows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'chat_phantom_web_claim');
    expect(phantomRows).toHaveLength(1);
    expect(phantomRows[0].sessionId).toBe('chat-sd-h');
    expect(phantomRows[0].meta).toMatchObject({ mode: 'single_thinking', tier: 'midturn', selfCorrected: true, machine: false });
    expect(phantomRows[0].meta.excerpt).toContain('came back garbage');
    // The grounding metric still lands beside it (one row each).
    expect(mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'chat_search_usage')).toHaveLength(1);

    // Honest control: the same claim sentence AFTER a real (failed) search is
    // a truthful report of that call — no metric row.
    jest.clearAllMocks();
    mockRunCodingAgent.mockImplementation(async () => ({
      finalText: 'Answering from what the failed search left us.',
      parts: [
        { type: 'tool_call', name: 'search_engine', args: { query: 'x' } },
        { type: 'tool_result', name: 'search_engine', result: 'error: upstream 502' },
        { type: 'text', text: 'I tried to pull fresher material just now and the search came back garbage.' },
      ],
    }));
    const key2 = await startDetachedChatRun({ message: 'the question', mode: 'single_thinking' as const, userId: 'u1', chatId: 'chat-sd-h2', sessionId: null });
    await waitFor(() => !isRunActive(key2!), 20000);
    expect(mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'chat_phantom_web_claim')).toHaveLength(0);
  });

  it("(g3) finalize records ONE 'chat_platform_usage' metric: platform-tool calls, distinct tools, action chips", async () => {
    mockRunCodingAgent.mockImplementation(async () => ({
      finalText: `${'A'.repeat(500)}\n\n[FOLLOWUPS]\n- What changed since yesterday?\n- Check this again tomorrow morning and message me on Telegram\n[/FOLLOWUPS]`,
      parts: [
        { type: 'tool_call', name: 'search_engine', args: { query: 'x' } },      // web, NOT platform
        { type: 'tool_call', name: 'list_chats', args: {} },                      // platform read
        { type: 'tool_call', name: 'schedule_message', args: { prompt: 'p' } },   // platform mutating
        { type: 'tool_result', name: 'schedule_message', result: 'staged' },      // results never count
        { type: 'tool_call', name: 'schedule_message', args: { confirmationId: 'c1' } }, // second call, same tool
        { type: 'text', text: 'A'.repeat(500) },
      ],
    }));
    const key = await startDetachedChatRun({ message: 'the question', mode: 'single_thinking' as const, userId: 'u1', chatId: 'chat-sd-g3', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => !isRunActive(key!), 20000);
    const rows = mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'chat_platform_usage');
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe('chat-sd-g3');
    expect(rows[0].meta).toEqual({
      mode: 'single_thinking',
      platformToolCalls: 3,
      tools: ['list_chats', 'schedule_message'],
      actionChips: 1,
      followUps: 2, // owner 2026-09-18: chips carried per answer, so [FOLLOWUPS] compliance is readable by mode
      machine: false,
    });
    // …and the search metric still lands beside it (one row each).
    expect(mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'chat_search_usage')).toHaveLength(1);
    // The chip itself reached the UI intact.
    const fu = events.find(e => e.type === 'followups');
    expect(fu?.data?.questions).toEqual(['What changed since yesterday?', 'Check this again tomorrow morning and message me on Telegram']);
  });
});

describe('countPlatformToolCalls / platformToolNamesCalled (pure helpers)', () => {
  it('count only PLATFORM_TOOL_NAMES tool_call parts and tolerate garbage', () => {
    const parts = [
      { type: 'tool_call', name: 'list_chats' },
      { type: 'tool_call', name: 'schedule_message' },
      { type: 'tool_call', name: 'schedule_message' },
      { type: 'tool_call', name: 'goal_create' },
      { type: 'tool_call', name: 'search_engine' },   // web tool
      { type: 'tool_call', name: 'gmail_search' },    // connector tool
      { type: 'tool_result', name: 'list_chats' },    // result, not a call
      { type: 'text', text: 'list_chats' },
      null,
    ];
    expect(countPlatformToolCalls(parts)).toBe(4);
    expect(platformToolNamesCalled(parts)).toEqual(['list_chats', 'schedule_message', 'goal_create']);
    expect(platformToolNamesCalled(parts, 2)).toEqual(['list_chats', 'schedule_message']); // capped
    expect(countPlatformToolCalls(undefined)).toBe(0);
    expect(countPlatformToolCalls('nope')).toBe(0);
    expect(platformToolNamesCalled(undefined)).toEqual([]);
  });
});

describe('countWebToolCalls (pure helper)', () => {
  it('counts only web-grounding tool_call parts and tolerates garbage', () => {
    expect(countWebToolCalls([
      { type: 'tool_call', name: 'search_engine' },
      { type: 'tool_call', name: 'scrape_as_markdown' },
      { type: 'tool_call', name: 'browser_task' },
      { type: 'tool_call', name: 'web_pipe' },
      { type: 'tool_call', name: 'gmail_search' },
      { type: 'tool_result', name: 'search_engine' },
      { type: 'text', text: 'search_engine' },
      null,
    ])).toBe(4);
    expect(countWebToolCalls(undefined)).toBe(0);
    expect(countWebToolCalls('nope')).toBe(0);
  });
});

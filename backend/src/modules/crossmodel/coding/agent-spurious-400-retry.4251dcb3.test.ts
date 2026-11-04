/**
 * SPURIOUS in-budget 400 rejections — transient-first recovery (ticket 4251dcb3).
 *
 * The mishap (2026-09-11): during a provider-side 400-incident window
 * (Moonshot rejected EVERY request for hours), FIVE in-budget runs died with
 * "The model kept rejecting the request (too large or malformed; transcript
 * 34k–231k chars vs ~800k budget), 2 compact-and-retry attempts exhausted" —
 * including owner-facing coding messages and a Telegram turn. The size lane
 * can never fix a rejection that is not about size: compaction no-oped (under
 * budget), the clip no-oped (every message under its cap), and both retries
 * resent the same doomed payload. Every run recovered later when a re-send
 * simply landed outside the incident window.
 *
 * The fix: a 400 on an IN-BUDGET transcript whose drained provider body does
 * NOT name a size/token cause is SPURIOUS — it takes the transient backoff
 * lane FIRST (same request resent — the transcript stays intact), and only
 * when the backoff budget is spent does the shrink lane get its chance (the
 * remediation-P1 oversize class — a REAL acceptance ceiling under our char
 * budget — still converges, ~100s later). A provider body naming size/tokens
 * is trusted immediately (the provider's token count can exceed our char
 * estimate).
 *
 * Scaffold mirrors agent-oversize-retry.test.ts (same mock set).
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
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
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
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected' },
}));

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
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

// The incident shape: transcript far UNDER the context budget.
const CONTEXT_BUDGET = 800_000;
const PROVIDER_LIMIT_CHARS = 50_000;

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: CONTEXT_BUDGET,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

/** 12 answered tool rounds of 13k chars each ≈ 156k — every message under the
 *  14k per-message clip cap, total under the 800k budget (the 4251dcb3 shape:
 *  34k–231k chars vs ~800k). */
const bigHistory = (): any[] => {
  const out: any[] = [];
  for (let i = 0; i < 12; i++) {
    out.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: `h${i}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"big.txt"}' } }],
    });
    out.push({ role: 'tool', tool_call_id: `h${i}`, content: `file part ${i}\n` + 'x'.repeat(13_000) });
  }
  return out;
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/spurious-400-test',
  sessionId: 'sess-spurious-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: bigHistory() as any,
  userMessage: 'finish the audit',
  emit: jest.fn(),
});

const messageChars = (messages: any[]): number =>
  messages.reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);

/** The incident's rejection: HTTP 400, generic wrapper message, NO drained
 *  provider body (the terminal note carried no "provider said:" segment). */
const BARE_400 = {
  content: '', reasoning: '', toolCalls: [], finishReason: 'error',
  errorMessage: 'Request too large or malformed for the model', errorStatus: 400,
};
const SIZE_NAMED_400 = {
  ...BARE_400,
  providerError: '{"error":{"message":"request exceeds the maximum context length allowed"}}',
};
const TOOL_TURN = {
  content: '', reasoning: '',
  toolCalls: [{ id: 't1', name: 'update_feedback', arguments: '{"id":"deadbeef-1","status":"done"}' }],
  finishReason: 'tool_calls',
};
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const rejectionMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'provider_rejected');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1'; // backoff lane in milliseconds
});

afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
});

describe('spurious in-budget 400 rejections (ticket 4251dcb3)', () => {
  it('the mishap replay: two bare 400s on an in-budget transcript recover via the backoff lane — SAME payload resent, transcript never shrunk', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(BARE_400)
      .mockResolvedValueOnce(BARE_400)
      .mockResolvedValueOnce(TOOL_TURN)
      .mockResolvedValueOnce(FINAL);
    const emit = jest.fn();
    const result = await runCodingAgent({ ...makeInput(), emit });

    // The run SURVIVES the incident window — no terminal rejection note.
    expect(result.finalText).toBe('Done.');
    expect(result.modelErrored).toBeUndefined();
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);

    // Backoff-lane evidence: the retry resent the SAME (unshrunk) request —
    // the transcript is never mutilated for a rejection that is not about size.
    const chars = mockRunModelTurn.mock.calls.slice(0, 3).map((c) => messageChars(c[1] as any[]));
    expect(chars[1]).toBe(chars[0]);
    expect(chars[2]).toBe(chars[0]);

    // The backoff lane emits NO provider_rejected rows while it is WINNING —
    // rows fire at the outcome sites (shrink_retry per shrink; gave_up at the
    // terminal for EITHER lane since 6d633649, tagged meta.lane)…
    expect(rejectionMetrics()).toHaveLength(0);
    // …and tells the user it is backing off, not "compacting".
    const progress = emit.mock.calls.map((c) => c[1]?.message || '').join('\n');
    expect(progress).toContain('backing off');
    expect(progress).not.toContain('shrank context');
  });

  it('a persistent window dies HONESTLY after both lanes: 3 backoffs + 2 shrinks, "5 recovery attempts exhausted", kind transient', async () => {
    mockRunModelTurn.mockResolvedValue(BARE_400); // rejects forever
    const result = await runCodingAgent(makeInput());

    expect(result.modelErrored).toBe(true);
    expect(result.modelErrorKind).toBe('transient'); // a provider-incident death, not a real size problem
    // Chat-audience note (6d633649): plain HTTP-status copy, no operator jargon…
    expect(result.finalText).toContain('HTTP 400');
    expect(result.finalText).not.toContain('kept rejecting the request');
    // 1 initial + 3 backoff retries + 2 shrink retries = 6 model calls, all rejected.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(6);
    // …but the note still counts ALL recovery attempts — never again "2
    // compact-and-retry attempts exhausted" while 3 backoffs also ran.
    expect(result.finalText).toContain('5 retries');
    // The shrink-lane fall-through still recorded its telemetry.
    expect(rejectionMetrics().map((m) => m.meta.outcome)).toEqual(['shrink_retry', 'shrink_retry', 'gave_up']);
  });

  it('control: a 400 whose provider body names size/tokens keeps the shrink lane (no backoff detour, converges on a real ceiling)', async () => {
    let served = 0;
    mockRunModelTurn.mockImplementation(async (_provider: any, messages: any[]) => {
      if (messageChars(messages) > PROVIDER_LIMIT_CHARS) return SIZE_NAMED_400;
      served += 1;
      return served === 1 ? TOOL_TURN : FINAL;
    });
    const result = await runCodingAgent(makeInput());

    expect(result.finalText).toBe('Done.');
    expect(result.modelErrored).toBeUndefined();
    // Pure size lane: 2 shrink retries, no transient detour (4 model calls:
    // reject, reject, tool turn, final — a backoff detour would add 3 more).
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
    expect(rejectionMetrics().map((m) => m.meta.outcome)).toEqual(['shrink_retry', 'shrink_retry']);
  });

  it('review N1: size rejections phrased Chinese/Anthropic-style stay in the shrink lane — no transient detour', async () => {
    // GLM-5.3 is the default coding seat and Zhipu phrases overlength in
    // Chinese; Anthropic says "prompt is too long". Both must route to the
    // shrink lane IMMEDIATELY (a real size rejection that detoured through 3
    // backoffs would burn ~100s before converging).
    for (const providerError of ['messages 长度超出限制', 'prompt is too long: 91234 tokens > 8192 maximum']) {
      jest.clearAllMocks();
      let served = 0;
      const sizeNamed = { ...BARE_400, providerError };
      mockRunModelTurn.mockImplementation(async (_provider: any, messages: any[]) => {
        if (messageChars(messages) > PROVIDER_LIMIT_CHARS) return sizeNamed;
        served += 1;
        return served === 1 ? TOOL_TURN : FINAL;
      });
      const result = await runCodingAgent(makeInput());
      expect(result.modelErrored).toBeUndefined();
      // Pure size lane: 4 model calls — ZERO transient backoffs burned.
      expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
      expect(rejectionMetrics().map((m) => m.meta.outcome)).toEqual(['shrink_retry', 'shrink_retry']);
    }
  });
});

// ── Rollout watch 2026-09-15 (tick 16): CAPABILITY / request-shape rejection ──
// The supervisor seat moved to a LiteLLM-fronted deepseek-v4.1-flash whose vLLM
// backend rejects every tool-enabled request ("auto" tool choice requires
// --enable-auto-tool-choice and --tool-call-parser). Neither lane can fix that:
// 26 supervisor wakes died 7 retries each in one hour. The loop now fails FAST
// with the provider's words, kind 'capability', and files ONE owner-action ticket.
//
// Same class, second production sighting — ticket be217b59 (2026-09-15
// 14:36–15:49Z, 9 occurrences across 5 sessions): the owner's LiteLLM endpoint
// serving the supervisor/council seats still had tool parsing off, and the
// fail-fast lane + deduped owner-action ticket above are exactly what fired.
// Sightings ceased at 15:49Z (seat/endpoint corrected owner-side); every
// supervisor lane was verified completing wakes normally at 23:02–23:28Z.
// This file is the replayTestPath cited in be217b59's verified close.
const mockFileFeedbackTicket: jest.Mock = jest.fn(async () => ({ ok: true }));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  // platform-tools.ts statically reads FEEDBACK_TYPES from this module — keep
  // the real surface, capture only the ticket write.
  ...jest.requireActual('../feedback/feedback.service'),
  fileFeedbackTicket: (...a: any[]) => mockFileFeedbackTicket(...a),
}));

const CAPABILITY_400 = {
  ...BARE_400,
  providerError: 'litellm.BadRequestError: OpenAIException - "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set. Received Model Group=deepseek-v4.1-flash Available Model Group Fallbacks=None',
};

describe('capability rejection (rollout watch 2026-09-15) — a 400 the request SHAPE caused fails fast, no shrink, no backoff', () => {
  beforeEach(() => { mockFileFeedbackTicket.mockClear(); });

  it('ONE model call, kind capability, the provider\'s words in the note, a provider_rejected row tagged lane capability, one owner-action ticket', async () => {
    mockRunModelTurn.mockResolvedValue(CAPABILITY_400);
    const emit = jest.fn();
    const result = await runCodingAgent({ ...makeInput(), emit });
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1); // no backoff lane, no shrink lane
    expect(result.modelErrored).toBe(true);
    expect(result.modelErrorKind).toBe('capability');
    expect(result.modelErrorStatus).toBe(400);
    expect(result.finalText).toContain('REJECTED THE REQUEST SHAPE');
    expect(result.finalText).toContain('enable-auto-tool-choice');
    expect(result.finalText).toContain('Retries cannot help');
    const rows = rejectionMetrics();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual(expect.objectContaining({ outcome: 'gave_up', lane: 'capability', status: 400 }));
    await new Promise((r) => setImmediate(r)); // the ticket files fire-and-forget
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0];
    expect(ticket.title).toContain('SEAT MISCONFIGURED');
    expect(ticket.area).toBe('owner-action');
    expect(ticket.description).toContain('--enable-auto-tool-choice');
    // No "backing off" / "shrank context" progress — the lanes never ran.
    const progress = emit.mock.calls.map((c) => c[1]?.message || '').join('\n');
    expect(progress).not.toContain('backing off');
    expect(progress).not.toContain('shrank context');
  });

  it('a bare 400 without a capability body still takes the existing lanes (the 4251dcb3 contract is untouched)', async () => {
    mockRunModelTurn.mockResolvedValueOnce(BARE_400).mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput());
    expect(result.finalText).toBe('Done.');
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it.each([
    'This model does not support tools',
    'Unsupported parameter: tool_choice',
    "Unknown parameter: 'reasoning_effort'",
    'function calling is not supported for this model',
  ])('recognizes the capability shape: %s', (msg) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CAPABILITY_REJECTION_RE } = require('./agent');
    expect(CAPABILITY_REJECTION_RE.test(msg)).toBe(true);
  });

  // FO f90 (2026-10-06): the retired-route shape — the endpoint registry still
  // lists a model the gateway no longer serves (cql-litellm
  // api-cohere-command-a-plus after the mesh teardown). Without these rows in
  // the regex the deterministic 400 fell into the shrink lane: 15 chat runs ×
  // ~6 retries = 90 errors/4 h before gave_up. Both LiteLLM phrasings are
  // pinned so either survives provider copy edits.
  it.each([
    '/chat/completions: Invalid model name passed in model=api-cohere-command-a-plus. Call `/v1/models` to view available models for your key.',
    "Invalid model name passed in model=foo. Call /v1/models to view available models for your key.",
  ])('recognizes the retired-route shape (FO f90): %s', (msg) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CAPABILITY_REJECTION_RE } = require('./agent');
    expect(CAPABILITY_REJECTION_RE.test(msg)).toBe(true);
  });

  it.each([
    'request exceeds the maximum context length allowed',
    'Request too large or malformed for the model',
    'rate limit reached, please retry',
  ])('does NOT call a size or load error a capability rejection: %s', (msg) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CAPABILITY_REJECTION_RE } = require('./agent');
    expect(CAPABILITY_REJECTION_RE.test(msg)).toBe(false);
  });
});

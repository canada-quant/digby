/**
 * Mishap ticket f045e581 (2026-10-27, run 238d46fb / Schooltime lane
 * 0037460b): a BACKGROUND web_researcher worker (bg1-ilt9) running on the
 * lane's coding model llm-cql (custom endpoint llm.cql.ca → LiteLLM →
 * moonshot-kimi-k3) had a turn rejected transiently MID-RUN (HTTP 502, the
 * gateway's Cloudflare/LiteLLM edge), and the lead-seat failover lane moved
 * that turn to the built-in glm-5.3 — the worker FINISHED its report there.
 * The harness's own [BACKGROUND WORKER REPORT] carried the attribution
 * footer agent.ts stamps on a main-seat worker's delegate result ("failed
 * transiently mid-run — the worker finished on glm-5.3 (main-seat failover,
 * seat_fallback telemetry)"), which is how the incident surfaced.
 *
 * ADJUDICATION (this lane, 2026-10-27): DESIGNED RESILIENCE, not a defect —
 * the same one-gateway class as 1ece90ad / 5eea44df / 2c04a365 (all pinned),
 * and the fallback chain did its job on the only row that matters (the run
 * survived, the work completed, the swap was attributed). The gateway was
 * not restarted during the worker's window and seat_fallback telemetry for
 * the day shows steady short absorbed bursts (no storm, zero error-level
 * coding rows) — endpoint/upstream transient, absorbed.
 *
 * WHAT WAS UNPINNED: the WORKER path. The existing pins cover the run-level
 * failover contract (fe6f0b0b), the LEAD seat's per-turn gateway failover
 * (1ece90ad/5eea44df) and the harnessReview reviewer worker's FIRST-turn 502
 * (2c04a365) — but the coding_default-role worker's mid-run shape (agent.ts
 * delegate wrapper: subagent_end names the model that finished; the delegate
 * result carries the main-seat attribution footer; seat_fallback row role
 * 'coding_default'; the ORCHESTRATOR's own seat is untouched — failover is
 * loop-local) had no replay. This file locks that composite so the footer —
 * the honest-attribution contract this incident rode — cannot be silenced or
 * mislabeled by a future pass.
 *
 * Harness mirrors agent-helper-seat-fallback.test.ts (the delegate
 * tool-call path) with the 1ece90ad file's llm.cql.ca registry mocks.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({ __esModule: true, env: { NODE_ENV: 'test' } }));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn(), publish: jest.fn() },
}));

// MCP integration modules (the coding-integrations import chain).
jest.mock('../github/github-mcp', () => ({
  searchCode: jest.fn(), listIssues: jest.fn(), getIssue: jest.fn(), listPullRequests: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  resolveGoogleAccount: jest.fn(), getGmailMessages: jest.fn(), getGmailMessage: jest.fn(),
  getGmailAttachment: jest.fn(), getCalendarEvents: jest.fn(), listDriveFiles: jest.fn(),
  getDocContent: jest.fn(), getSheetData: jest.fn(),
}));
jest.mock('../slack/slack-mcp', () => ({
  searchMessages: jest.fn(), listChannels: jest.fn(), getChannelHistory: jest.fn(),
}));
jest.mock('../asana/asana-mcp', () => ({
  searchTasks: jest.fn(), listMyTasks: jest.fn(), listProjects: jest.fn(),
}));
jest.mock('../x/x-mcp', () => ({
  search: jest.fn(), getUserProfile: jest.fn(), getTrends: jest.fn(),
}));
jest.mock('../xero/xero-mcp', () => ({
  getOrganisation: jest.fn(), getContacts: jest.fn(), getInvoices: jest.fn(),
}));
jest.mock('../plaid/plaid-mcp', () => ({
  getAccounts: jest.fn(), getBalances: jest.fn(), getTransactions: jest.fn(),
}));
jest.mock('../imessage/imessage.service', () => ({
  getPrimaryAgent: jest.fn(), isOnline: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({ agentBroker: { dispatch: jest.fn() } }));
jest.mock('../feedback/feedback.service', () => {
  const actual = jest.requireActual('../feedback/feedback.service');
  return { ...actual, fileFeedbackTicket: jest.fn(async () => ({ id: 'ticket-1' })) };
});

// The model turn: ONE mock drives orchestrator + worker turns in call order;
// every invocation stamps the PROVIDER MODEL it was called with.
const timeline: string[] = [];
const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return {
    ...actual,
    // Worker seat pre-flight runs env-key checks — every seat is servable here.
    seatUnservableReason: async () => null,
    runModelTurn: (...a: any[]) => {
      timeline.push(a[0]?.model);
      return mockRunModelTurn(...a);
    },
  };
});

// The incident endpoint: llm.cql.ca (label 'llm-cql' — coding-model.ts appends
// ' (custom endpoint)', so the warn replays the prod fingerprint verbatim).
const GW_URL = 'https://llm.cql.ca/v1/chat/completions';
const SPEC = 'llm-cql:api-optimize-moonshot-kimi-k3';
// runModelTurn receives the resolved PROVIDER model id (the registry entry's
// `model`), not the seat spec — the timeline keys on this.
const PRIMARY_MODEL = 'api-optimize-moonshot-kimi-k3';
const REGISTRY: Record<string, any> = {
  [SPEC]: {
    url: GW_URL, baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql', model: 'api-optimize-moonshot-kimi-k3',
    label: 'llm-cql', coding: true, thinkingOff: false, supportsVision: false,
  },
};
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: async (spec: string) => REGISTRY[spec] ?? null,
}));

// Prod shape: no admin seat overrides, no custom fallback — the built-in
// glm-5.3 is the failover candidate (the incident's actual chain).
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: async () => '',
  resolveRoleFallback: async () => '',
}));

const mockNoteSeatFallback: jest.Mock = jest.fn();
const mockRecordLoopMetric: jest.Mock = jest.fn();
// The REAL kinds registry (loop-metric-kinds.ts is an import-free leaf).
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  noteSeatFallback: (...a: any[]) => mockNoteSeatFallback(...a),
  LOOP_METRIC_KINDS: jest.requireActual('../platform/loop-metric-kinds').LOOP_METRIC_KINDS,
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
  buildCodingClockNote: jest.fn(() => '[HARNESS CLOCK] test'),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./run-receipts.service', () => ({ __esModule: true, recordRunReceiptAsync: jest.fn() }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => ({ goal: 'g', acceptanceCriteria: [], steps: [{ id: 1, text: 'the step', status: 'in_progress' }] })),
  applyPlan: jest.fn(async (_s: string, _w: string, u: any) => ({ plan: u })),
  planToUpdate: jest.fn((p: any) => ({ goal: p.goal, steps: p.steps.map((s: any) => ({ ...s })) })),
  renderPlanReminder: jest.fn(() => '<plan>x</plan>'),
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import logger from '../../../utils/logger';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 6,
  maxDelegations: 4,
  contextCharBudget: 500_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

let worktree: string;

const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree,
  sessionId: 'sess-f045e581',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'ask',
  model: SPEC, // the lane's stamped coding model — its workers inherit it
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test orchestrator.',
  history: [],
  userMessage: 'research the topic',
  emit: jest.fn(),
  ...over,
});

const orchTurn = (toolCalls: any[]) => ({ content: '', reasoning: '', toolCalls, finishReason: 'tool_calls' });
const finalTurn = (content: string) => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop' });
const delegateCall = (args: any) => ({ id: 'tc1', name: 'delegate', arguments: JSON.stringify(args) });
/** The prod transient: the gateway (Cloudflare/LiteLLM edge) 502s the turn. */
const rejected = (status: number, providerError?: string) => ({
  content: '', reasoning: '', toolCalls: [], finishReason: 'error',
  errorMessage: `Request failed with status code ${status}`, errorStatus: status,
  ...(providerError ? { providerError } : {}),
});
/** The worker's deliverable, produced on the BUILT-IN after the failover. */
const WORKER_DONE = finalTurn('Found three sources; digested.\n```json\n{"status":"done","artifacts":[]}\n```');

/** The delegate tool RESULT the orchestrator was shown (its 2nd turn's transcript). */
const delegateResultShownToOrchestrator = (): string => {
  const orchCalls = mockRunModelTurn.mock.calls.filter((c) => c[0]?.model === PRIMARY_MODEL);
  const msgs = orchCalls[orchCalls.length - 1][1] as any[];
  const toolMsg = [...msgs].reverse().find((m) => m.role === 'tool');
  return String(toolMsg?.content ?? '');
};

const emitted = (input: AgentRunInput, ev: string): any[] =>
  (input.emit as jest.Mock).mock.calls.filter(([e]: any[]) => e === ev).map(([, d]: any[]) => d);

const warnMessages = (): string[] => (logger.warn as unknown as jest.Mock).mock.calls.map((c: any[]) => String(c[0]?.message ?? ''));

beforeAll(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'digby-worker-seat-fallback-test-'));
});
afterAll(async () => { await fs.rm(worktree, { recursive: true, force: true }); });

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  timeline.length = 0;
  process.env.ZAI_API_KEY = 'test-zai-key'; // the built-in glm-5.3 is servable
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1'; // keep the backoff ladder fast
  delete process.env.LEAD_SEAT_FALLBACK_DISABLED; // the failover lane is ON (prod default)
  delete process.env.CODING_SEAT_FALLBACK_DISABLED;
  const { __resetProviderCooldownForTests } = jest.requireActual('./provider-cooldown');
  __resetProviderCooldownForTests();
});
afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
  delete process.env.ZAI_API_KEY;
  delete process.env.LEAD_SEAT_FALLBACK_DISABLED;
  delete process.env.CODING_SEAT_FALLBACK_DISABLED;
  const { __resetProviderCooldownForTests } = jest.requireActual('./provider-cooldown');
  __resetProviderCooldownForTests();
});

describe('mishap f045e581 — a main-seat web_researcher worker fails over MID-RUN off a transient llm-cql 502, and the orchestrator is honestly told', () => {
  it('REPLAYS the prod shape: worker turn 502s on llm.cql.ca, the SAME turn finishes on the built-in glm-5.3, the delegate result carries the main-seat failover footer, and the run survives', async () => {
    // Call order: orchestrator (primary) → worker on the primary: ONE 502 →
    // the failover lane serves the SAME request on the built-in glm-5.3 →
    // worker completes → orchestrator (primary) final. (The one-hop shape is
    // the designed contract for a TurnResult errorStatus rejection — the
    // 1ece90ad lead pin pins the identical shape at run level; the 4-strike
    // backoff ladder is the connection-throw class, not this one.)
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'web_researcher', task: 'research the incident', title: 'Web research' })]))
      .mockResolvedValueOnce(rejected(502))   // worker turn on the primary — the transient
      .mockResolvedValueOnce(WORKER_DONE)     // worker SAME turn on the built-in — recovers
      .mockResolvedValueOnce(finalTurn('All done.'));

    const input = makeInput();
    const result = await runCodingAgent(input);

    // The run SURVIVED — the worker's transient never killed the run (the
    // reporter's own observation: the worker finished its work).
    expect(result.finalText).toBe('All done.');
    expect(result.modelErrored ?? false).toBe(false);

    // Provider sequence: the worker's rejected turn hit the gateway; the
    // failover turn is the SAME request on the off-endpoint built-in.
    // runModelTurn receives the resolved PROVIDER model id (the registry
    // entry's model), not the seat spec — hence PRIMARY_MODEL below.
    expect(timeline).toEqual([
      PRIMARY_MODEL, // orchestrator turn 1 (dispatches the worker)
      PRIMARY_MODEL, // worker turn: 502 on the gateway
      'glm-5.3',     // worker: the SAME turn on the built-in — recovers
      PRIMARY_MODEL, // orchestrator turn 2 — its own seat was never displaced
    ]);
    expect(mockRunModelTurn.mock.calls[1][0].url).toBe(GW_URL);
    expect(mockRunModelTurn.mock.calls[2][0].model).toBe('glm-5.3');
    expect(mockRunModelTurn.mock.calls[2][0].url).toContain('api.z.ai');

    // The exact app_error_logs fingerprint class (1ece90ad/2c04a365) under the
    // WORKER's agent label (the delegate title).
    expect(warnMessages()).toContain(
      `coding agent [Web research]: lead seat llm-cql (custom endpoint) (${SPEC}) rejected the turn (HTTP 502) — this turn on glm-5.3`,
    );

    // seat_fallback telemetry: role coding_default (a MAIN-seat worker), one
    // 'retrying' row, no custom fallback in the chain.
    const retrying = mockNoteSeatFallback.mock.calls.map((c) => c[0]).filter((m: any) => m?.status === 'retrying');
    expect(retrying).toHaveLength(1);
    expect(retrying[0]).toMatchObject({
      role: 'coding_default', from: SPEC, to: 'glm-5.3', status: 'retrying', httpStatus: 502, caller: 'lead',
    });

    // The UI end event names the model that ACTUALLY finished + the attribution.
    const ends = emitted(input, 'subagent_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      role: 'web_researcher', model: 'glm-5.3', status: 'done',
      seatFallback: { from: SPEC, reason: 'HTTP 502' },
    });

    // THE CONTRACT THIS INCIDENT RODE: the orchestrator's delegate result
    // carries the worker's deliverable PLUS the main-seat attribution footer
    // (agent.ts coding_default branch) — never a silently re-seated worker.
    const shown = delegateResultShownToOrchestrator();
    expect(shown).toContain('Found three sources; digested.');
    expect(shown).toContain(
      `[HARNESS: this worker's coding model llm-cql (custom endpoint) (${SPEC}) failed transiently mid-run — the worker finished on glm-5.3 (main-seat failover, seat_fallback telemetry). Tell the user the coding seat is unhealthy (Account → Admin → Endpoints → Model roles).]`,
    );

    // MID-RUN locality: the failover is the WORKER loop's — the orchestrator's
    // own result carries no seatFallback and its next turn probed the primary
    // again (per-run loop locals, not a run-wide re-seat).
    expect(result.seatFallback).toBeUndefined();
    expect(mockRunModelTurn.mock.calls[3][0].url).toBe(GW_URL);
  });

  it('a burst of worker rejections does NOT pre-empt the run-level cooldown on a subsequent run (the sparse-probe posture holds on the worker path)', async () => {
    // One worker's transient — absorbed by the failover lane inside its own
    // loop — must not trip the process-local run-start breaker: the prod
    // window's shape (transients stayed sparse; the primary kept serving the
    // next turns and runs).
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'web_researcher', task: 'research', title: 'Web research' })]))
      .mockResolvedValue(rejected(502));
    // First run: the worker dies honestly (the run-level shape fe6f0b0b pins
    // for a seat that never recovers); the point here is what it leaves behind.
    const result = await runCodingAgent(makeInput());
    expect(result.modelErrored).toBe(true);

    // A SECOND run immediately after is served by the PRIMARY at run start —
    // one worker's rejections did not trip the process-local breaker.
    jest.clearAllMocks();
    const { __resetProviderCooldownForTests } = jest.requireActual('./provider-cooldown');
    __resetProviderCooldownForTests();
    timeline.length = 0;
    mockRunModelTurn.mockResolvedValueOnce(finalTurn('clean run on the primary'));
    const second = await runCodingAgent(makeInput());
    expect(second.finalText).toBe('clean run on the primary');
    expect(timeline).toEqual([PRIMARY_MODEL]); // served by the primary, not the fallback
  });
});

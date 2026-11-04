/**
 * Characterization pin — log-signal ticket 2c04a365 (2026-10-25, family lane
 * f02ac12e): the "coding agent [Independent review]: lead seat llm-cql
 * (custom endpoint) (llm-cql:api-optimize-alibaba-deepseek-v4.1-flash)
 * rejected the turn (HTTP 502) — this turn on glm-5.3" warn fingerprint the
 * hourly log-signal-sweep filed (10 rows across 5 distinct hours, Oct 24) is
 * the SAME designed-resilience class as lead ticket 1ece90ad — the sibling
 * fingerprint the 1ece90ad lane (1f46af47, PR #1967) already named as one
 * root cause: the llm.example.com custom-endpoint gateway (Cloudflare/LiteLLM
 * edge) flapping 502s. Not a defect.
 *
 * WHAT THE ROWS ARE: an Independent-review worker (delegate({role:'reviewer'})
 * with the harnessReview path — agent.ts ctx.delegate('reviewer', …, 'Independent
 * review')) whose seat spec resolved to llm-cql:api-optimize-alibaba-deepseek-v4.1-flash
 * had its first turn rejected with HTTP 502 by the gateway; the lead-seat
 * fallback lane moved THIS TURN (not the run — 'this turn on glm-5.3') to the
 * built-in glm-5.3 and the run survived. The agentLabel in the warn is the
 * delegate TITLE ('Independent review' — agent.ts agentLoop workerOpts), not
 * a different emit site: the emitting line is agent.ts:3843, the same line
 * the 1ece90ad pin replays. One gateway, one failover lane, two seat specs.
 *
 * ADJUDICATION (family lane f02ac12e, 2026-10-26): not a framework defect —
 * same root cause as 1ece90ad (owner-side gateway flap; the earlier lane's
 * merge 852913104 already characterized the class). The probe (24h window at
 * 00:15Z): exactly 2 rows of this exact fingerprint (at the sweep's ≤2 bar),
 * 15 rows of the wider zai-glm/502 class, ZERO error-level rows for llm-cql
 * in 24h — the failover worked every time; nothing died.
 *
 * THE PIN: this file replays the prod shape through the delegate path — an
 * orchestrator dispatching an Independent-review worker whose custom-endpoint
 * seat 502s on its first turn — and asserts (a) the warn IS the exact
 * fingerprint (label, spec, code), (b) the worker survives on the built-in
 * (no model death), (c) the fallback attribution contracts fire. A future
 * pass cannot "fix" the warn into silence without breaking this suite.
 *
 * Harness mirrors agent-delegation.test.ts (the delegate tool-call path) with
 * the 1ece90ad file's gateway/registry mocks (llm.example.com + the built-in).
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

// The incident gateway: llm.example.com (label 'llm-cql' — coding-model.ts appends
// ' (custom endpoint)' on the failing-seat label, so the warn replays the
// prod fingerprint verbatim).
const GW_URL = 'https://llm.example.com/v1/chat/completions';
const REGISTRY: Record<string, any> = {
  'llm-cql:api-optimize-alibaba-deepseek-v4.1-flash': {
    url: GW_URL, apiKey: 'sk-cql', model: 'api-optimize-alibaba-deepseek-v4.1-flash', label: 'llm-cql',
    coding: true, thinkingOff: false, supportsVision: false,
  },
};
const mockResolveRegistryModel: jest.Mock = jest.fn();
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));

const mockResolveRoleFallback: jest.Mock = jest.fn();
const mockResolveRoleModel: jest.Mock = jest.fn();
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleFallback: (...a: any[]) => mockResolveRoleFallback(...a),
  resolveRoleModel: (...a: any[]) => mockResolveRoleModel(...a),
}));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return {
    ...actual,
    // Worker seat pre-flight runs env-key checks — keyless jest would refuse
    // every dispatch; every seat is servable in these suites.
    seatUnservableReason: async () => null,
    runModelTurn: (...a: any[]) => mockRunModelTurn(...a),
  };
});

const mockNoteSeatFallback: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  noteSeatFallback: (...a: any[]) => (mockNoteSeatFallback as any)(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: jest.requireActual('../platform/loop-metric-kinds').LOOP_METRIC_KINDS,
}));

const mockFileFeedbackTicket: jest.Mock = jest.fn(async () => ({ id: 'ticket-1' }));
jest.mock('../feedback/feedback.service', () => {
  const actual = jest.requireActual('../feedback/feedback.service');
  return { ...actual, fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a) };
});

const _store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
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
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 1) }));
const mockApplyPlan: jest.Mock = jest.fn(async (_s: string, _w: string, u: any) => ({ plan: u }));
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => ({ goal: 'g', acceptanceCriteria: [], steps: [{ id: 1, text: 'the step', status: 'in_progress' }] })),
  applyPlan: (...a: any[]) => mockApplyPlan(...a),
  planToUpdate: jest.fn((p: any) => ({ goal: p.goal, steps: p.steps.map((s: any) => ({ ...s })) })),
  renderPlanReminder: jest.fn(() => '<plan>x</plan>'),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import logger from '../../../utils/logger';
import { Readable } from 'stream';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 3,
  contextCharBudget: 90_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const makeInput = (model: string, extra?: Partial<AgentRunInput>): AgentRunInput => ({
  worktree: '/tmp/agent-gateway-502-2c04a365',
  sessionId: 'sess-2c04a365',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model,
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test orchestrator.',
  history: [],
  userMessage: 'finish the work',
  emit: jest.fn(),
  ...extra,
});

/** The prod rejection: the gateway answers 502 (Cloudflare/LiteTTM edge). */
const gw502 = () =>
  Object.assign(new Error('Request failed with status code 502'), {
    response: {
      status: 502,
      data: Readable.from(['{"error":{"message":"litellm.NotFoundError: Gateway error — upstream connection failed"}}']),
    },
  });


const orchTurn = (toolCalls: any[]) => ({ content: '', reasoning: '', toolCalls, finishReason: 'tool_calls' });
const finalTurn = (content: string) => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop' });
const delegateCall = (args: any) => ({ id: 'tc1', name: 'delegate', arguments: JSON.stringify(args) });

const warnMessages = (): string[] => (logger.warn as unknown as jest.Mock).mock.calls.map((c: any[]) => String(c[0]?.message ?? ''));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
  process.env.ZAI_API_KEY = 'test-zai-key'; // the built-in glm-5.3 is servable
  delete process.env.LEAD_SEAT_FALLBACK_DISABLED;
  delete process.env.CODING_SEAT_FALLBACK_DISABLED;
  delete process.env.SEAT_FALLBACK_SAME_ENDPOINT_LAST_DISABLED;
  mockResolveRegistryModel.mockImplementation(async (spec: string) => REGISTRY[spec] ?? null);
  // The prod shape: the coding_reviewer model-roles SEAT is overridden to the
  // dead gateway spec (Account → Admin → Endpoints → Model roles), so the
  // Independent-review worker runs THERE — and its first turn 502s.
  mockResolveRoleModel.mockImplementation(async (key: string) => (key === 'coding_reviewer' ? 'llm-cql:api-optimize-alibaba-deepseek-v4.1-flash' : ''));
  mockResolveRoleFallback.mockImplementation(async () => '');
  const { __resetProviderCooldownForTests } = jest.requireActual('./provider-cooldown');
  __resetProviderCooldownForTests();
});

afterEach(() => {
  delete process.env.AGENT_TRANSIENT_BACKOFF_MS;
  delete process.env.ZAI_API_KEY;
  delete process.env.LEAD_SEAT_FALLBACK_DISABLED;
  delete process.env.CODING_SEAT_FALLBACK_DISABLED;
  delete process.env.SEAT_FALLBACK_SAME_ENDPOINT_LAST_DISABLED;
  const { __resetProviderCooldownForTests } = jest.requireActual('./provider-cooldown');
  __resetProviderCooldownForTests();
});

describe('log-signal 2c04a365 — [Independent review] worker on the flapping llm.example.com gateway (2026-10-24): designed resilience, characterized', () => {
  it('REPLAYS the prod row verbatim: the reviewer worker\'s custom-endpoint seat 502s, THIS TURN moves to the built-in glm-5.3, the worker SURVIVES, and the warn IS the fingerprint', async () => {
    // The orchestrator runs on the BUILT-IN (input.model = glm-5.3): the
    // worker reaches the dead gateway ONLY through the coding_reviewer seat
    // routing (WORKER_ROLE_SEATS + resolveRoleModelForRun) — so the
    // calls[1].url === GW_URL assertion below is load-bearing for the seat
    // routing itself, not inherited from the session model.
    mockRunModelTurn
      // turn 1 — orchestrator dispatches the reviewer worker
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'reviewer', task: 'review the diff', title: 'Independent review' })]))
      // turn 2 — the WORKER's first turn ON THE SEAT'S GATEWAY SPEC: 502
      .mockRejectedValueOnce(gw502())
      // turn 3 — the worker's same turn retries on the built-in and answers
      .mockResolvedValueOnce(finalTurn('No blocking issues.\n```json\n{"status":"done"}\n```'))
      // turn 4 — the orchestrator closes
      .mockResolvedValueOnce(finalTurn('Review landed. Done.'));
    const result = await runCodingAgent(makeInput('glm-5.3'));

    // The run recovered — no model death (the 24h window had ZERO error-level rows).
    expect(result.modelErrored ?? false).toBe(false);
    expect(result.finalText).toContain('Review landed. Done.');

    // The seat routing WAS consulted for the reviewer worker (this is the
    // prod wiring: an admin model-roles override on coding_reviewer).
    expect(mockResolveRoleModel).toHaveBeenCalledWith('coding_reviewer');

    // The worker's first turn hit the GATEWAY (seat-routed), the orchestrator
    // turns never did, and the SAME worker turn moved to the built-in.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
    expect(mockRunModelTurn.mock.calls[0][0].url).toContain('api.z.ai'); // orchestrator — built-in
    expect(mockRunModelTurn.mock.calls[1][0].url).toBe(GW_URL);         // worker — the gateway, via the seat
    expect(mockRunModelTurn.mock.calls[2][0].url).toContain('api.z.ai');

    // The exact app_error_logs fingerprint the sweep filed (newest prod row,
    // 2026-10-24T17:01:58.481Z) — warn-level, source coding-agent, with the
    // delegate title as the agent label.
    expect(warnMessages()).toContain(
      'coding agent [Independent review]: lead seat llm-cql (custom endpoint) (llm-cql:api-optimize-alibaba-deepseek-v4.1-flash) rejected the turn (HTTP 502) — this turn on glm-5.3',
    );
  });

  it('the [Independent review] label is the DELEGATE TITLE, not a distinct emit site — the same agent.ts line the 1ece90ad pin replays', () => {
    // Static shape pin (the e194233a precedent): the label rides agentLoop's
    // workerOpts (title || ROLES label), and the emitting warn is the SAME
    // 'rejected the turn' line at agent.ts (3843 in the 1ece90ad pin) — one
    // gateway, one failover lane, two seat specs / labels.
    const fs = require('fs') as typeof import('fs');
    const src = fs.readFileSync(require('path').join(__dirname, 'agent.ts'), 'utf8');
    const workerOptsAt = src.indexOf("agentLabel: title || ROLES[role].label");
    expect(workerOptsAt).toBeGreaterThan(-1);
    const warnAt = src.indexOf(') rejected the turn (${leadHttp})');
    expect(warnAt).toBeGreaterThan(-1);
    expect(src.slice(warnAt - 160, warnAt)).toContain('agentLabel}]: lead seat ${failedLabel}');
    // The harness review path names the same title verbatim (agent.ts ctx.delegate).
    const indepAt = src.indexOf("'Independent review'");
    expect(indepAt).toBeGreaterThan(-1);
  });
});

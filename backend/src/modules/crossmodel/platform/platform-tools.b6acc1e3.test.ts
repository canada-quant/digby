/**
 * Ticket b6acc1e3 — start_coding_session `model` param, TOOLS layer.
 *
 * Pins the agent-facing surface of the fix (the service-layer stamping half is
 * in platform.service.b6acc1e3.test.ts, the run-time override exemption in
 * coding/run-executor.test.ts):
 *   1. The tool SCHEMA exposes an optional `model` string param (still only
 *      projectId required) so the supervisor seat can pick the spawn's model.
 *   2. The STAGING seam (never confirm a doomed action) rejects an invalid
 *      model BEFORE a confirm card exists, and stages a valid one.
 *   3. The HANDLER passes the model through to platform.startCodingSession and
 *      the spawn RECEIPT names the stamped model + its explicit-param
 *      provenance (the ticket's acceptance: "the spawn receipt and the
 *      session's coding.model field reflect it").
 *   4. A service-layer 400 (invalid model past a stale staged card) comes back
 *      as a clean refusal string, never an opaque thrown tool error.
 *
 * Mock stack mirrors platform-tools.test.ts; the service layer under the tools
 * is fully mocked (mapping + receipt text is what we pin). The staging
 * validator's resolveOneCodingPick seam is mocked at the coding-data.service
 * boundary — the REAL validator is exercised end-to-end by the service-layer
 * replay file.
 */

import { createPendingConfirmationTable } from './pending-confirmations.testkit';
import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockConfirmations = createPendingConfirmationTable();
const mockOwnerQuestions = createOwnerQuestionTable();

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    ownerQuestion: mockOwnerQuestions.api,
    crossModelMessage: mockOwnerQuestions.crossModelMessage,
    crossModelChat: mockOwnerQuestions.crossModelChat,
    telegramLink: { findUnique: async () => null },
  },
}));

jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: async () => {},
}));

beforeEach(() => { mockConfirmations.reset(); mockOwnerQuestions.reset(); });

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
}));
jest.mock('../coding/process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''),
  listProcesses: jest.fn(async () => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('../coding/code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run',
  ] as const,
}));

// The service layer under the tools — fully mocked; mapping is what we pin.
const svc = {
  startCodingSession: jest.fn(),
  resolveCodingSessionTarget: jest.fn(async (): Promise<any> => ({
    ok: true,
    project: {
      id: 'p1', userId: 'u1', name: 'Project P', repoUrl: 'https://github.com/a/b',
      defaultBranch: 'main', provider: 'github', githubLabel: null, folderId: null,
      createdAt: new Date(), updatedAt: new Date(),
    },
    projectId: 'p1',
    source: 'direct',
  })),
  suggestProjectsByIdPrefix: jest.fn(async () => [] as Array<{ id: string; name: string }>),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

// FEEDBACK_TYPES is read at MODULE SCOPE by the tool schema — mirror it.
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  getFeedbackTicketById: jest.fn(),
  isAdminUser: jest.fn(),
}));
jest.mock('../fleet/fleet-telemetry', () => ({ __esModule: true, fleetTelemetry: jest.fn(async () => ({ ok: true })) }));
jest.mock('../feedback/closure-evidence', () => ({
  __esModule: true,
  verifyMachineCloseEvidence: jest.fn(async () => ({ ok: true, auditNote: '[machine-close evidence: test]', verified: ['commitSha'] })),
}));
jest.mock('./autonomy.service', () => ({
  __esModule: true,
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async () => null),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
}));
jest.mock('../upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(async () => null),
  combineAttachments: jest.fn((atts: any[]) => atts[0]),
}));

// Ticket b6acc1e3: the staging validator's model seam (dynamically imported).
// Mirrors the real resolver's CONTRACT (built-ins pass, anything else null) —
// the real implementation is exercised in platform.service.b6acc1e3.test.ts.
const mockResolveOneCodingPick: jest.Mock = jest.fn(async (pick?: string) =>
  (pick && ['glm-5.3', 'deepseek-flash', 'kimi-k3'].includes(pick) ? pick : null));
jest.mock('../coding/coding-data.service', () => ({
  __esModule: true,
  resolveOneCodingPick: (...a: any[]) => mockResolveOneCodingPick(...a),
}));

import { PLATFORM_TOOL_SCHEMA, executePlatformTool } from './platform-tools';
import type { ToolContext } from '../coding/tools';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  const ctx = {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    userTurnAt: new Date(),
    requestApproval: async () => 'allow',
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
  return ctx;
}

/** First call registers the pending confirmation; the re-call from a NEW user
 *  turn carries the confirmationId and executes. Returns the final result. */
async function confirmed(ctx: ToolContext, name: string, args: any): Promise<string> {
  const first = await executePlatformTool(ctx, name, args);
  const reg = JSON.parse(first);
  expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
  expect(typeof reg.confirmationId).toBe('string');
  return executePlatformTool(
    { ...ctx, userTurnAt: new Date(Date.now() + 60_000) },
    name,
    { ...args, confirmationId: reg.confirmationId },
  );
}

beforeEach(() => jest.clearAllMocks());

// No-card-for-requested-work (platform/work-tools.ts): on a HUMAN turn the
// requested-work tools (start_coding_session, create_feed, own-chat schedule
// tools, …) now execute WITHOUT a card. This suite pins the STAGING contract
// itself (staging-time validation, WYSIWYG confirm, the card envelope), which
// still governs machine turns and the kill switch — so it runs with the switch
// set; the direct path is pinned by work-tools.test.ts.
beforeAll(() => { process.env.WORK_TOOLS_NO_CARD_DISABLED = '1'; });
afterAll(() => { delete process.env.WORK_TOOLS_NO_CARD_DISABLED; });

describe('start_coding_session model param (ticket b6acc1e3)', () => {
  it('the schema exposes an OPTIONAL model string param — projectId is optional too since misfiled-spawns-1 (SPAWN_PROJECT_REQUIRED=1 restores it)', () => {
    const tool = PLATFORM_TOOL_SCHEMA.find((t) => t.function.name === 'start_coding_session')!;
    const params: any = tool.function.parameters;
    expect(params.properties.model).toMatchObject({ type: 'string' });
    expect(params.properties.model.description).toContain('glm-5.3');
    expect(params.properties.model.description).toContain('deepseek-flash');
    expect(params.properties.model.description).toContain('kimi-k3');
    expect(params.required).toBeUndefined();
  });

  it('staging REFUSES an omitted projectId from an UNGROUPED caller with the filing rule — nothing staged, the resolver is never asked about "" (misfiled-spawns-5)', async () => {
    // makeCtx() carries no projectId (an ungrouped chat); the stamp cannot fill it in.
    const out = await executePlatformTool(makeCtx(), 'start_coding_session', { title: 'Fix' });
    expect(out).toMatch(/^start_coding_session REFUSED: this chat has no project/);
    expect(out).toContain('the project named "crossmodel"');
    expect(out).toContain('Nothing was staged or created');
    expect(out).not.toContain('needsConfirmation');
    expect(svc.resolveCodingSessionTarget).not.toHaveBeenCalled();
    expect(svc.startCodingSession).not.toHaveBeenCalled();
  });

  it('staging REJECTS an invalid model before any confirm card exists (never confirm a doomed action)', async () => {
    const out = await executePlatformTool(makeCtx(), 'start_coding_session', { projectId: 'p1', title: 'Fix', model: 'gpt-4o' });
    expect(out).toContain('"gpt-4o"');
    expect(out).toContain('Nothing was staged');
    expect(out).not.toContain('needsConfirmation');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
  });

  it('staging accepts a valid model and the confirm-card summary names it', async () => {
    const out = await executePlatformTool(makeCtx(), 'start_coding_session', { projectId: 'p1', title: 'Fix', model: 'glm-5.3' });
    const reg = JSON.parse(out);
    expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
    expect(JSON.stringify(reg)).toContain('glm-5.3');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
  });

  it('execution passes the model through and the RECEIPT names the stamped model + its explicit-param pin', async () => {
    svc.startCodingSession.mockResolvedValue({
      id: 'sess-9', projectId: 'p1', title: 'Fix', branch: 'digby/session-sess-9', baseBranch: 'main',
      model: 'glm-5.3', modelSource: 'spawn-param', permissionMode: 'auto',
    });
    const out = await confirmed(makeCtx(), 'start_coding_session', { projectId: 'p1', title: 'Fix', model: 'glm-5.3' });
    expect(svc.startCodingSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', projectId: 'p1', title: 'Fix', model: 'glm-5.3' }),
    );
    expect(out).toContain('model glm-5.3');
    expect(out).toContain('explicit model param');
  });

  it('a default-resolved spawn (no param) keeps the ORIGINAL receipt phrasing (no pin note)', async () => {
    svc.startCodingSession.mockResolvedValue({
      id: 'sess-9', projectId: 'p1', title: 'Fix', branch: 'digby/session-sess-9', baseBranch: 'main',
      model: 'glm-5.3', modelSource: null, permissionMode: 'auto',
    });
    const out = await confirmed(makeCtx(), 'start_coding_session', { projectId: 'p1', title: 'Fix' });
    expect(svc.startCodingSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', projectId: 'p1', model: undefined }),
    );
    expect(out).toContain('model glm-5.3,');
    expect(out).not.toContain('explicit model param');
  });

  it('a service-layer 400 (stale staged card) returns a clean refusal string — never a thrown tool error', async () => {
    svc.startCodingSession.mockRejectedValue(Object.assign(
      new Error('Cannot start a coding session: model "gpt-4o" is not a built-in coding model (glm-5.3 | deepseek-flash | kimi-k3) or an enabled, [coding]-flagged "<label>:<modelId>" endpoint model. Nothing was created — re-call with a valid model or omit the param for the default resolution.'),
      { statusCode: 400 },
    ));
    // Stage with a VALID model (staging passes), then the execution-time
    // service re-validation is what fails (e.g. the endpoint went stale).
    const out = await confirmed(makeCtx(), 'start_coding_session', { projectId: 'p1', title: 'Fix', model: 'glm-5.3' });
    expect(out).toContain('Cannot start a coding session');
    expect(out).toContain('"gpt-4o"');
  });
});

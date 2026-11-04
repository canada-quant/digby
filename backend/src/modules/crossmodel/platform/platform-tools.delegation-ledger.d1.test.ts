/**
 * build 2026-10-08 D-1 — the delegation ledger's write seams inside the
 * platform tools (SHADOW: the tool result is byte-identical; the ledger write
 * is fire-and-forget through a dynamic import):
 *   · start_coding_session records ONE `session` task — parent = the calling
 *     chat, child = the new session, the parent run, the call's tool-intent key
 *     (ToolContext.intentKey, D-2) as its idempotency key; an IDLE spawn (no
 *     prompt, no charter) waits on input;
 *   · send_chat_message records a `message_ask` whose first state follows the
 *     delivery (queued / steer / started) and asks the ledger to skip a report up.
 * Scaffolding mirrors platform-tools.project-supervisor-spawn.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: jest.fn(async () => null), storePut: jest.fn(async () => {}) }));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true, searchMemory: jest.fn(async () => []), storeFindings: jest.fn(async () => 0), clearSessionMemory: jest.fn(async () => {}),
}));
jest.mock('../coding/process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(), waitForProcessOutput: jest.fn(), readProcessOutput: jest.fn(), releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''), listProcesses: jest.fn(async () => ''), processSnapshot: jest.fn(() => []),
}));
jest.mock('../coding/code-index.service', () => ({
  __esModule: true, searchCodeSemantic: jest.fn(async () => []), syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })), kickCodeIndexSync: jest.fn(),
}));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));

const svc = {
  listChats: jest.fn(), createChat: jest.fn(), getChatStatus: jest.fn(), getChatMessages: jest.fn(), sendChatMessage: jest.fn(),
  renameChat: jest.fn(), archiveChat: jest.fn(), moveChat: jest.fn(), deleteChat: jest.fn(), createProject: jest.fn(),
  getProject: jest.fn(), updateProject: jest.fn(), deleteProject: jest.fn(), moveFolder: jest.fn(), startCodingSession: jest.fn(),
  scheduleChatRun: jest.fn(), listSchedules: jest.fn(), cancelSchedule: jest.fn(),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(), listFeedbackTickets: jest.fn(), updateFeedbackTicket: jest.fn(), isAdminUser: jest.fn(),
}));
const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48, MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(), setChatAutonomy: jest.fn(), auditAutonomousExecution: jest.fn(async () => {}),
  implicitParentAutonomyAllows: jest.fn(async () => false),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));
jest.mock('./hooks.service', () => ({ __esModule: true, ensureChildResultHook: jest.fn(async () => ({ id: 'hook-1' })) }));
jest.mock('../coding/run-journal.service', () => ({ __esModule: true, buildParentContextBlock: jest.fn(async () => '') }));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), incr: jest.fn(async () => 1), expire: jest.fn(async () => 1), ttl: jest.fn(async () => -1), decr: jest.fn(async () => 0), pTTL: jest.fn(async () => 300_000) },
}));
jest.mock('../coding/spend-cap.service', () => ({ __esModule: true, trailingSpend24h: jest.fn(async () => ({ chatUsd: 0, projectUsd: 0 })) }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, LOOP_METRIC_KINDS: {}, recordLoopMetric: jest.fn() }));

// THE seam under test.
const mockRecordDelegationTask: jest.Mock = jest.fn();
jest.mock('./delegation-tasks', () => ({ __esModule: true, recordDelegationTask: (...a: any[]) => mockRecordDelegationTask(...a) }));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';
const mockConfirmations = createPendingConfirmationTable();
const mockChatFindUnique: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    crossModelChat: {
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      update: jest.fn(async () => ({})), count: jest.fn(async () => 0), findMany: jest.fn(async () => []),
    },
    chatCodingState: { findMany: jest.fn(async () => []) },
    agentRun: { findMany: jest.fn(async () => []) },
    systemSetting: { findUnique: jest.fn(async () => null) },
    projectTodo: { findFirst: jest.fn(async () => null) },
    projectGoal: { findFirst: jest.fn(async () => null) },
    eventHook: { findFirst: jest.fn(async () => ({ id: 'proj-hook-1' })) },
  },
}));

import { executePlatformTool } from './platform-tools';
import { ToolContext } from '../coding/tools';

const KEY = 'a'.repeat(40);
function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: 'sess-sup', userId: 'u1', permissionMode: 'auto', runId: 'run-77', intentKey: KEY,
    emit: () => {}, alwaysAllow: new Set<string>(), requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }), agentSurface: 'coding',
    ...overrides,
  } as unknown as ToolContext;
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  autonomySvc.getChatAutonomy.mockResolvedValue(null);
  mockChatFindUnique.mockResolvedValue({ id: 'sess-sup', userId: 'u1', isProjectSupervisor: true, projectId: 'proj-1' });
  svc.startCodingSession.mockResolvedValue({
    id: 'sess-new', title: 'Worker task', projectId: 'proj-1', branch: 'digby/session-new', baseBranch: 'main', model: 'glm-5.3', permissionMode: 'auto',
  });
});

describe('build 2026-10-08 D-1 — ledger seams in the platform tools', () => {
  it('start_coding_session records ONE session task (parent chat + run, child, the call\'s intent key)', async () => {
    const out = await executePlatformTool(makeCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task', prompt: 'Run the bench' });
    expect(out).toContain('Started coding session sess-new');
    await settle();
    expect(mockRecordDelegationTask).toHaveBeenCalledTimes(1);
    expect(mockRecordDelegationTask.mock.calls[0][0]).toMatchObject({
      kind: 'session', source: 'start_coding_session', userId: 'u1', parentChatId: 'sess-sup', parentRunId: 'run-77',
      childChatId: 'sess-new', projectId: 'proj-1', brief: 'Worker task', state: 'submitted', origin: 'machine', idempotencyKey: KEY,
    });
  });

  it('an IDLE spawn (no prompt, no charter) is a task waiting on input', async () => {
    await executePlatformTool(makeCtx({ intentKey: undefined } as any), 'start_coding_session', { projectId: 'proj-1', title: 'Idle lane' });
    await settle();
    expect(mockRecordDelegationTask.mock.calls[0][0]).toMatchObject({ kind: 'session', state: 'input_required', idempotencyKey: null });
  });

  it('a refused spawn records nothing', async () => {
    mockChatFindUnique.mockResolvedValue({ id: 'sess-1', userId: 'u1', isProjectSupervisor: false, projectId: 'proj-1' });
    const db = (await import('../../../config/database')).default as any;
    db.crossModelChat.count.mockResolvedValueOnce(8);
    const out = await executePlatformTool(makeCtx({ sessionId: 'sess-1' } as any), 'start_coding_session', { projectId: 'proj-1', title: 'Ninth child' });
    expect(out).toContain('spawn REFUSED');
    await settle();
    expect(mockRecordDelegationTask).not.toHaveBeenCalled();
  });

  it.each([
    ['queued behind a busy plain chat', { chatId: 'lane-1', position: 2 }, 'queued'],
    ['steered into a running lane', { chatId: 'lane-1', delivery: 'steer' }, 'steer'],
    ['a new run', { chatId: 'lane-1', profile: 'coding', mode: 'auto' }, 'started'],
  ])('send_chat_message %s → a message_ask with that delivery', async (_label, result, deliveredAs) => {
    svc.sendChatMessage.mockResolvedValue(result);
    // the chat's autonomy grant lets the machine send execute (no confirmation card)
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: 48 });
    const out = await executePlatformTool(makeCtx(), 'send_chat_message', { chatId: 'lane-1', content: 'Pick up todo 4 — the bench rerun.' });
    expect(out).toContain('"ok":true');
    expect(svc.sendChatMessage).toHaveBeenCalled();
    await settle();
    expect(mockRecordDelegationTask).toHaveBeenCalledTimes(1);
    expect(mockRecordDelegationTask.mock.calls[0][0]).toMatchObject({
      kind: 'message_ask', source: 'send_chat_message', parentChatId: 'sess-sup', parentRunId: 'run-77', childChatId: 'lane-1',
      brief: 'Pick up todo 4 — the bench rerun.', skipIfReportUp: true, deliveredAs, origin: 'machine', idempotencyKey: KEY,
    });
  });
});

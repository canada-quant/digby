/**
 * Ticket e580b601 — stringified-null assigneeChatId normalization at the
 * todo tool-arg seam, end-to-end through executePlatformTool (goals.service
 * mocked at its dynamic-import boundary; prisma at config/database — the
 * 03587322 scaffolding discipline).
 *
 * The 2026-09-24 16:24:26Z incident (canlegal-bench supervisor 615723ba, run
 * serving owner msg 20fbcc78): a batch of 5 todo_create calls each passed
 * assigneeChatId "null" — the LITERAL STRING, not JSON null (verbatim from
 * the chat's stored parts: {"title": "Execute Mac-route citator harvest over
 * the 371 pending case_treatment records (staged: …", "goalId":
 * "fb84129a-7ab0-4fe2-958e-523f9c6ce0c6", "assigneeChatId": "null"}). Every
 * call failed "Tool todo_create failed: assigneeChatId: chat not found" —
 * requireAssignableChat looked up a chat literally id'd "null" — and the
 * 3-streak breaker tripped a mishap ticket. The model recovered by re-issuing
 * without the arg (16:26:47 todo_create ok), but the artifact class is
 * framework-absorbable: same normalization as context.service.ts:305 /
 * crossmodel.controller.ts:943 ("treat the LITERAL strings
 * 'undefined'/'null' as missing").
 *
 * Pinned behavior:
 *   (i)   todo_create with assigneeChatId "null" (string) creates the todo
 *         UNASSIGNED — no chat lookup, no 400, createTodo called without the
 *         assigneeChatId key (verbatim incident replay);
 *   (ii)  "undefined"/""/whitespace normalize the same way;
 *   (iii) a REAL chat id passes through untouched (createTodo receives it);
 *   (iv)  JSON null / omitted arg still mean "not provided" (unchanged);
 *   (v)   todo_update with assigneeChatId "null" UNASSIGNS (assigneeChatId
 *         null reaches updateTodo) instead of 400ing;
 *   (vi)  todo_update with a real id reassigns untouched.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// tools.ts transitively imports plan.service → context-store → DB/env (process.exit).
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
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('./platform.service', () => ({
  __esModule: true,
  startCodingSession: jest.fn(async (opts: any) => ({ id: 'child-1', projectId: opts.projectId, title: opts.title ?? 'child', branch: 'digby/session-child-1', baseBranch: 'main', model: 'glm-5.3', modelSource: null })),
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(),
}));
// error-handler imports config/env (process.exit without env vars) — mock the boundary.
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    isOperational = true;
    constructor(public statusCode: number, public message: string) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
// crossmodel.service pulls the model-integration/env chains — mock the boundary.
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: jest.fn(async () => ({ access: 'owner', exists: true })) },
}));

// The scope guard's prisma probes (projectGoal.findUnique resolves the target
// goal's project; unknown goal ids skip the guard so the MOCKED createTodo
// owns the path).
const mockDb = {
  activity: { create: jest.fn(async () => ({})) },
  crossModelChat: { findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
  projectGoal: { findUnique: jest.fn(async (_args?: any): Promise<any> => null) },
  projectTodo: { findFirst: jest.fn(async (_args?: any): Promise<any> => null) },
};
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: mockDb,
}));

// The service layer under the tool — mocked at its dynamic-import boundary.
const todoRow = { id: 'todo-e580b601', title: 'T', status: 'pending', assigneeChatId: null, goalId: 'goal-1' };
const mockCreateTodo = jest.fn(async (opts: any) => ({ ...todoRow, ...(opts.assigneeChatId ? { assigneeChatId: opts.assigneeChatId } : {}) }));
const mockUpdateTodo = jest.fn(async (opts: any) => ({ ...todoRow, ...(opts.assigneeChatId ? { assigneeChatId: opts.assigneeChatId } : {}) }));
jest.mock('./goals.service', () => ({
  __esModule: true,
  createTodo: (opts: any) => mockCreateTodo(opts),
  updateTodo: (opts: any) => mockUpdateTodo(opts),
}));

jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
  recordLoopMetric: jest.fn(),
}));
// 4057952b review finding 1 pin: the tool dynamic-imports ./session-titles
// for the post-create charter bind — mock the boundary so the canonical-id
// argument is assertable.
const mockBindCharter: jest.Mock = jest.fn(async () => ({ bound: true }));
jest.mock('./session-titles', () => ({
  __esModule: true,
  bindCharter: (...a: any[]) => mockBindCharter(...a),
}));
jest.mock('./hooks.service', () => ({  __esModule: true,
  subscribeHook: jest.fn(),
  findCoveringHooks: jest.fn(async () => []),
  updateHook: jest.fn(),
  unsubscribeHook: jest.fn(),
  listHooks: jest.fn(async () => []),
  ensureChildResultHook: jest.fn(async () => null),
}));

import { executePlatformTool } from './platform-tools';
import { ToolContext } from '../coding/tools';

const LANE = 'supervisor-615723ba';
const USER = 'u1';
const GOAL = 'goal-fb84129a';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: LANE, userId: USER, permissionMode: 'auto',
    agentSurface: 'coding', projectId: 'chat',
    emit: () => {}, alwaysAllow: new Set<string>(),
    ...overrides,
  } as ToolContext;
}

describe('e580b601: stringified-null assigneeChatId normalization (todo tools)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('(i) verbatim incident replay — todo_create with assigneeChatId "null" (LITERAL STRING) creates the todo unassigned, not 400 "chat not found"', async () => {
    const out = await executePlatformTool(makeCtx(), 'todo_create', {
      title: 'Execute Mac-route citator harvest over the 371 pending case_treatment records (staged: data/preservation/citator_mac_route_20260919/ — mac_citator_harvest.py + pending_371.json), owner solving captchas on cql-stanne-macbook-pro-1',
      goalId: GOAL,
      assigneeChatId: 'null',
    });
    expect(out).toContain('Created todo');
    expect(out).not.toContain('chat not found');
    expect(mockCreateTodo).toHaveBeenCalledTimes(1);
    const passed = mockCreateTodo.mock.calls[0][0];
    expect(passed.assigneeChatId).toBeUndefined(); // unassigned — the key is absent
    // and no chat lookup ever ran (requireAssignableChat never fired)
    expect(mockDb.crossModelChat.findUnique).not.toHaveBeenCalled();
  });

  it('(ii) "undefined" and blank strings normalize the same way', async () => {
    for (const bad of ['undefined', '', '   ']) {
      jest.clearAllMocks();
      await executePlatformTool(makeCtx(), 'todo_create', { title: 'T', goalId: GOAL, assigneeChatId: bad });
      expect(mockCreateTodo.mock.calls[0][0].assigneeChatId).toBeUndefined();
    }
  });

  it('(iii) a REAL chat id passes through untouched', async () => {
    await executePlatformTool(makeCtx(), 'todo_create', { title: 'T', goalId: GOAL, assigneeChatId: 'chat-11449a0a-real' });
    expect(mockCreateTodo.mock.calls[0][0].assigneeChatId).toBe('chat-11449a0a-real');
  });

  it('(iii-b) 4057952b review finding 1 — the post-create bindCharter reads the CANONICAL assignee from the RETURNED row, not the raw arg', async () => {
    // The raw arg here is an 8-char PREFIX; the returned row carries the full
    // id (createTodo resolved it). bindCharter must receive the FULL id — its
    // readChatTitleRow lookup is exact-id, so a prefix would silently not bind.
    mockBindCharter.mockClear();
    mockCreateTodo.mockImplementationOnce(async (opts: any) => ({ ...todoRow, assigneeChatId: 'b94e3fad-60e6-4fd2-b981-f668c486fea6' }));
    await executePlatformTool(makeCtx(), 'todo_create', { title: 'T', goalId: GOAL, assigneeChatId: 'b94e3fad' });
    expect(mockBindCharter).toHaveBeenCalledTimes(1);
    expect(mockBindCharter).toHaveBeenCalledWith(
      'b94e3fad-60e6-4fd2-b981-f668c486fea6',
      expect.objectContaining({ todoId: 'todo-e580b601' }),
      expect.objectContaining({ reason: 'todo' }),
    );
  });

  it('(iv) JSON null / omitted still mean "not provided" (unchanged)', async () => {
    await executePlatformTool(makeCtx(), 'todo_create', { title: 'T', goalId: GOAL, assigneeChatId: null });
    expect(mockCreateTodo.mock.calls[0][0].assigneeChatId).toBeUndefined();
    jest.clearAllMocks();
    await executePlatformTool(makeCtx(), 'todo_create', { title: 'T', goalId: GOAL });
    expect(mockCreateTodo.mock.calls[0][0].assigneeChatId).toBeUndefined();
  });

  it('(v) todo_update with assigneeChatId "null" (string) UNASSIGNS instead of failing', async () => {
    const out = await executePlatformTool(makeCtx(), 'todo_update', { todoId: 'todo-e580b601', assigneeChatId: 'null' });
    expect(out).not.toContain('chat not found');
    expect(mockUpdateTodo).toHaveBeenCalledTimes(1);
    expect(mockUpdateTodo.mock.calls[0][0].assigneeChatId).toBeNull();
  });

  it('(vi) todo_update with a real id reassigns untouched', async () => {
    await executePlatformTool(makeCtx(), 'todo_update', { todoId: 'todo-e580b601', assigneeChatId: 'chat-worker-2' });
    expect(mockUpdateTodo.mock.calls[0][0].assigneeChatId).toBe('chat-worker-2');
  });
});

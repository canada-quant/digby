/**
 * Ticket dd3a19fa (P3) — MACHINE-RUN WIRING GUARDS on hook_subscribe /
 * hook_update, end-to-end through executePlatformTool (hooks.service mocked;
 * prisma boundaries mocked — the platform-tools.g19-target-scope.test.ts
 * scaffolding discipline).
 *
 * The 2026-09-20 stray-wildcard incident: a derailed machine-triggered run
 * armed an owner-scope WILDCARD hook with the BARE DEFAULT prompt onto the
 * "Finding Flaws in Legal Bench Scores" lane (chat 619a1241), which already
 * had project-scope coverage. The duplicate double-woke the lane and BOTH
 * wakes re-derailed it. The hook row carried no creator provenance.
 *
 * Pinned behavior:
 *   (i)    a machine-triggered hook_subscribe with NO promptTemplate is
 *          REFUSED (bare default-prompt wakes carry no intent — the incident
 *          shape; an omitted template would also WIPE an existing row's
 *          template on the dedup-rewire path);
 *   (ii)   a machine-triggered hook_subscribe WITH a promptTemplate executes
 *          and threads creator provenance (createdVia / createdByChatId /
 *          createdByRunId) into subscribeHook;
 *   (iii)  a machine-triggered NEW WILDCARD that duplicates coverage an
 *          enabled project-scope hook already provides is REFUSED, naming the
 *          covering hook (subscribeHook never called);
 *   (iv)   the SAME call from a user-anchored run EXECUTES with a COVERAGE
 *          WARNING instead of a refusal (intentional stacking stays possible
 *          from a user turn);
 *   (v)    the promptTemplate requirement binds machine runs on SPECIFIC-
 *          source subscribes too; the duplicate-coverage probe is
 *          wildcard-only;
 *   (vi)   hook_update clearing a hook's promptTemplate from a machine run is
 *          REFUSED (template wipe = the same content-free-wake shape).
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
jest.mock('./platform.service', () => ({ __esModule: true }));
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
    constructor(public statusCode: number, public message: string, public isOperational = true) {
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
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    activity: { create: jest.fn(async () => ({})) },
    crossModelChat: { findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
  },
}));

// The hook service layer under the tool — mocked; the GUARDS in the tool case
// are what we pin.
const HOOKS = {
  subscribeHook: jest.fn(),
  findCoveringHooks: jest.fn(),
  updateHook: jest.fn(),
  unsubscribeHook: jest.fn(),
  listHooks: jest.fn(async () => []),
};
jest.mock('./hooks.service', () => ({ __esModule: true, ...HOOKS }));

import { executePlatformTool } from './platform-tools';
import { ToolContext } from '../coding/tools';

const LANE = 'lane-1';
const USER = 'u1';
const TGT = 'c-target';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: LANE, userId: USER, permissionMode: 'auto',
    agentSurface: 'coding',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}

/** The incident's pre-existing coverage: a PROJECT-scope hook waking TGT on
 *  run_completed (findCoveringHooks serves it). */
const coveringProjectHook = () => ([{
  id: 'h-proj-99abcdef', sourceChatId: null, projectId: 'p-canlaw', targetChatId: TGT,
  eventTypes: ['run_completed'], promptTemplate: 'project tpl', enabled: true,
  debounceSec: 60, lastFiredAt: null, createdAt: '2026-09-20T00:00:00Z',
}]);

beforeEach(() => {
  jest.clearAllMocks();
  HOOKS.findCoveringHooks.mockResolvedValue([]);
  HOOKS.subscribeHook.mockImplementation(async (opts: any) => ({
    id: 'h-new', sourceChatId: opts.sourceChatId ?? null, targetChatId: opts.targetChatId,
    eventTypes: opts.eventTypes, promptTemplate: opts.promptTemplate ?? '',
    enabled: true, debounceSec: opts.debounceSec ?? 60, lastFiredAt: null,
    createdAt: '2026-09-20T00:00:00Z',
    ...(opts.createdVia ? { createdVia: opts.createdVia } : {}),
    ...(opts.createdByChatId ? { createdByChatId: opts.createdByChatId } : {}),
    ...(opts.createdByRunId ? { createdByRunId: opts.createdByRunId } : {}),
  }));
  HOOKS.updateHook.mockResolvedValue({
    id: 'h-1', sourceChatId: null, targetChatId: TGT, eventTypes: ['run_completed'],
    promptTemplate: 'tpl', enabled: true, debounceSec: 60,
  });
});

describe('hook_subscribe machine-run wiring guards — ticket dd3a19fa', () => {
  it('dd3a19fa (i): machine-triggered subscribe with NO promptTemplate is REFUSED — subscribeHook never runs', async () => {
    const out = await executePlatformTool(makeCtx(), 'hook_subscribe', { targetChatId: TGT, eventTypes: ['run_completed'] });
    expect(out).toContain('REFUSED');
    expect(out).toContain('promptTemplate');
    expect(out).toContain('dd3a19fa');
    expect(HOOKS.subscribeHook).not.toHaveBeenCalled();
  });

  it('dd3a19fa (ii): machine-triggered subscribe WITH a promptTemplate executes and threads creator provenance', async () => {
    const out = await executePlatformTool(makeCtx({ runId: 'r-77' }), 'hook_subscribe', {
      targetChatId: TGT, eventTypes: ['run_completed'], promptTemplate: 'wake tpl {{summary}}',
    });
    expect(out).toContain('Subscribed');
    expect(HOOKS.findCoveringHooks).toHaveBeenCalledWith({
      userId: USER, targetChatId: TGT, eventTypes: ['run_completed'],
    });
    expect(HOOKS.subscribeHook).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER, sourceChatId: null, targetChatId: TGT,
      createdVia: 'tool:hook_subscribe', createdByChatId: LANE, createdByRunId: 'r-77',
    }));
  });

  it('dd3a19fa (iii): machine-triggered NEW WILDCARD duplicating project-scope coverage is REFUSED, naming the covering hook', async () => {
    HOOKS.findCoveringHooks.mockResolvedValue(coveringProjectHook());
    const out = await executePlatformTool(makeCtx(), 'hook_subscribe', {
      targetChatId: TGT, eventTypes: ['run_completed'], promptTemplate: 'tpl {{summary}}',
    });
    expect(out).toContain('REFUSED');
    expect(out).toContain('duplicate coverage');
    expect(out).toContain('h-proj-9'); // the covering hook's first-8
    expect(out).toContain('dd3a19fa');
    expect(HOOKS.subscribeHook).not.toHaveBeenCalled();
  });

  it('dd3a19fa (iv): the SAME wildcard from a USER-anchored run executes with a COVERAGE WARNING (no refusal)', async () => {
    HOOKS.findCoveringHooks.mockResolvedValue(coveringProjectHook());
    const out = await executePlatformTool(makeCtx({ userTurnAt: new Date() }), 'hook_subscribe', {
      targetChatId: TGT, eventTypes: ['run_completed'],
    });
    // No promptTemplate required on a user turn; duplicate coverage warns.
    expect(out).toContain('Subscribed');
    expect(out).toContain('COVERAGE WARNING');
    expect(out).toContain('h-proj-9');
    expect(HOOKS.subscribeHook).toHaveBeenCalled();
  });

  it('dd3a19fa (v): the promptTemplate requirement binds machine runs on SPECIFIC-source subscribes too; the coverage probe is wildcard-only', async () => {
    const out = await executePlatformTool(makeCtx(), 'hook_subscribe', {
      sourceChatId: 'c-src', targetChatId: TGT, eventTypes: ['run_completed'],
    });
    expect(out).toContain('REFUSED');
    expect(HOOKS.subscribeHook).not.toHaveBeenCalled();
    expect(HOOKS.findCoveringHooks).not.toHaveBeenCalled();
  });
});

describe('hook_update machine-run template-wipe guard — ticket dd3a19fa', () => {
  it('dd3a19fa (vi): clearing promptTemplate from a machine run is REFUSED; a non-empty replacement executes', async () => {
    const refused = await executePlatformTool(makeCtx(), 'hook_update', { hookId: 'h-1', promptTemplate: '' });
    expect(refused).toContain('REFUSED');
    expect(refused).toContain('dd3a19fa');
    expect(HOOKS.updateHook).not.toHaveBeenCalled();

    const ok = await executePlatformTool(makeCtx(), 'hook_update', { hookId: 'h-1', promptTemplate: 'new tpl {{summary}}' });
    expect(ok).toContain('Updated hook h-1');
    expect(HOOKS.updateHook).toHaveBeenCalledWith(expect.objectContaining({ hookId: 'h-1', promptTemplate: 'new tpl {{summary}}' }));
  });

  it('dd3a19fa (vi-bis): a user-anchored run may still clear a template (no machine guard)', async () => {
    const out = await executePlatformTool(makeCtx({ userTurnAt: new Date() }), 'hook_update', { hookId: 'h-1', promptTemplate: '' });
    expect(out).toContain('Updated hook h-1');
    expect(HOOKS.updateHook).toHaveBeenCalled();
  });
});

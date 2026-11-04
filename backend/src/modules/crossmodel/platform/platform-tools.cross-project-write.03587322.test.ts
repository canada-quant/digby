/**
 * Ticket 03587322 (P3) — CROSS-PROJECT WRITE GUARD on todo_create / goal_create,
 * end-to-end through executePlatformTool (goals.service mocked at its dynamic-
 * import boundary; prisma at config/database — the dd3a19fa/g19 scaffolding
 * discipline).
 *
 * The 2026-09-21 lane-596102ca firing-256 incident: a derailed coding session
 * whose home project is canlegal-bench (f0bc9e80) wrote 23 junk todos
 * ("noop-f256-break2".."break24") into goal 0f9c6db6 of the FOREIGN sibling
 * project CanLaw (d355f5d9) — the USER-level requireProjectWrite passed (same
 * owner) and nothing on the create path compared the target goal's project to
 * the session's home project. The guard refuses create-class fleet writes
 * whose target project differs from the run's home project, unless the fleet
 * explicitly authorized the cross-project target by assigning this session a
 * (non-dropped) todo there.
 *
 * Pinned behavior:
 *   (i)    todo_create under a FOREIGN-project goal is REFUSED, citing the
 *          scoping rule (home + target + the assignment recourse + the
 *          todo_update/goal_update carve-out); createTodo never runs; a
 *          guard_strike metric (seam cross_project_write_refused) records;
 *   (ii)   todo_create under a HOME-project goal executes unchanged;
 *   (iii)  todo_create into a foreign goal EXECUTES when the explicit
 *          authorization exists — an indexed probe finds a non-dropped todo
 *          assigned to THIS session in the target project (the where-clause
 *          is pinned, including the dropped exclusion);
 *   (iv)   goal_create into a FOREIGN project is REFUSED; into the home
 *          project executes;
 *   (v)    an UNGROUPED chat (projectId 'chat' — the fleet-supervisor
 *          pattern, cross-project boards by design) is unguarded;
 *   (vi)   an UNKNOWN goal id skips the guard — createTodo's canonical 404
 *          path (with hints) owns that error.
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
const mockStartCodingSession = jest.fn(async (opts: any) => ({ id: 'child-1', projectId: opts.projectId, title: opts.title ?? 'child', branch: 'digby/session-child-1', baseBranch: 'main', model: 'glm-5.3', modelSource: null }));
jest.mock('./platform.service', () => ({ __esModule: true, startCodingSession: (opts: any) => mockStartCodingSession(opts) }));
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

// The guard's two prisma probes: projectGoal.findUnique (resolve the target
// goal's project) and projectTodo.findFirst (the assignment authorization).
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

// The service layer under the tool — mocked at its dynamic-import boundary;
// the GUARD in the dispatch case is what we pin. canonicalGoalIdForTool is a
// passthrough by default (the firing-24 prefix resolution before the guard);
// prefix cases override it per-test.
const mockGoals = { createTodo: jest.fn(), createGoal: jest.fn(), canonicalGoalIdForTool: jest.fn(async (id: string) => id) };
jest.mock('./goals.service', () => ({ __esModule: true, ...mockGoals }));

// Loop-metric capture (recordPlatformLoopMetric rides a dynamic import; the
// 91ec252a gotcha — flush a setImmediate before asserting on a void metric).
const mockLoopMetrics = { recordLoopMetric: jest.fn() };
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
  recordLoopMetric: mockLoopMetrics.recordLoopMetric,
}));

jest.mock('./hooks.service', () => ({
  __esModule: true,
  subscribeHook: jest.fn(),
  findCoveringHooks: jest.fn(async () => []),
  updateHook: jest.fn(),
  unsubscribeHook: jest.fn(),
  listHooks: jest.fn(async () => []),
  ensureChildResultHook: jest.fn(async () => null),
}));

import { executePlatformTool } from './platform-tools';
import { ToolContext } from '../coding/tools';

const LANE = 'lane-596102ca';
const USER = 'u1';
const HOME = 'proj-canlegal-bench-f0bc9e80';
const FOREIGN = 'proj-canlaw-d355f5d9';
const GOAL_FOREIGN = 'goal-0f9c6db6-foreign';
const GOAL_HOME = 'goal-home-1';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: LANE, userId: USER, permissionMode: 'auto',
    agentSurface: 'coding', projectId: HOME,
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.projectGoal.findUnique.mockImplementation(async ({ where }: any) =>
    where.id === GOAL_FOREIGN ? { projectId: FOREIGN } : where.id === GOAL_HOME ? { projectId: HOME } : null);
  mockDb.projectTodo.findFirst.mockResolvedValue(null);
  mockGoals.createTodo.mockImplementation(async (opts: any) => ({
    id: 't-new-123', goalId: opts.goalId, title: opts.title, status: 'pending', projectId: HOME,
  }));
  mockGoals.createGoal.mockImplementation(async (opts: any) => ({
    id: 'g-new-123', projectId: opts.projectId, title: opts.title, status: 'active',
  }));
});

describe('cross-project write guard on todo_create / goal_create — ticket 03587322', () => {
  it('03587322 (i): todo_create under a FOREIGN-project goal is REFUSED, citing the scoping rule; createTodo never runs; refusal is telemetered', async () => {
    const out = await executePlatformTool(makeCtx(), 'todo_create', { goalId: GOAL_FOREIGN, title: 'noop-f256-break2' });
    expect(out).toContain('REFUSED (cross-project write)');
    expect(out).toContain(GOAL_FOREIGN);                    // the offending goal
    expect(out).toContain(FOREIGN);                         // the goal's project
    expect(out).toContain(HOME);                            // the session's home project
    expect(out).toContain('assigning this session a todo'); // the explicit-authorization recourse
    expect(out).toContain('todo_update');                   // updates to existing rows are unaffected
    expect(mockGoals.createTodo).not.toHaveBeenCalled();
    await flush();
    expect(mockLoopMetrics.recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike',
      sessionId: LANE,
      meta: expect.objectContaining({
        seam: 'cross_project_write_refused', tool: 'todo_create',
        homeProjectId: HOME, targetProjectId: FOREIGN, goalId: GOAL_FOREIGN,
      }),
    }));
  });

  it('03587322 (ii): todo_create under a HOME-project goal executes unchanged', async () => {
    const out = await executePlatformTool(makeCtx(), 'todo_create', { goalId: GOAL_HOME, title: 'real work' });
    expect(out).toContain('Created todo t-new-123');
    expect(mockGoals.createTodo).toHaveBeenCalledWith({ userId: USER, goalId: GOAL_HOME, title: 'real work', actingChatId: LANE, machineTriggered: true }); // W5-5: attributed create; 2026-10-20 actorKind
    expect(mockDb.projectTodo.findFirst).not.toHaveBeenCalled(); // same-project short-circuit: no authorization probe needed
  });

  it('03587322 (iii): todo_create into a foreign goal EXECUTES when the fleet assigned this session a (non-dropped) todo in the target project', async () => {
    mockDb.projectTodo.findFirst.mockResolvedValue({ id: 't-assigned-9' });
    const out = await executePlatformTool(makeCtx(), 'todo_create', { goalId: GOAL_FOREIGN, title: 'decompose assigned work' });
    expect(out).toContain('Created todo t-new-123');
    expect(mockGoals.createTodo).toHaveBeenCalled();
    // The authorization probe is pinned: THIS session, the TARGET project, dropped excluded.
    expect(mockDb.projectTodo.findFirst).toHaveBeenCalledWith({
      where: { assigneeChatId: LANE, projectId: FOREIGN, status: { in: ['pending', 'in_progress', 'blocked'] } },
      select: { id: true },
    });
  });

  it('03587322 (iv): goal_create into a FOREIGN project is REFUSED; into the home project executes', async () => {
    const refused = await executePlatformTool(makeCtx(), 'goal_create', { projectId: FOREIGN, title: 'foreign goal' });
    expect(refused).toContain('REFUSED (cross-project write)');
    expect(refused).toContain(FOREIGN);
    expect(refused).toContain(HOME);
    expect(mockGoals.createGoal).not.toHaveBeenCalled();

    const created = await executePlatformTool(makeCtx(), 'goal_create', { projectId: HOME, title: 'home goal' });
    expect(created).toContain('Created goal g-new-123');
    expect(mockGoals.createGoal).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, projectId: HOME, title: 'home goal' }));
  });

  it('03587322 (v): an UNGROUPED chat (projectId chat sentinel) is unguarded — the fleet-supervisor pattern keeps cross-project boards', async () => {
    const out = await executePlatformTool(
      makeCtx({ agentSurface: undefined, projectId: 'chat' } as any),
      'todo_create', { goalId: GOAL_FOREIGN, title: 'fleet-level tracking todo' },
    );
    expect(out).toContain('Created todo t-new-123');
    expect(mockGoals.createTodo).toHaveBeenCalled();
  });

  it('03587322 (vi): an UNKNOWN goal id skips the guard — createTodo (and its canonical 404) owns that path', async () => {
    mockGoals.createTodo.mockRejectedValue(Object.assign(new Error('Goal not found: "goal-missing".'), { statusCode: 404 }));
    await expect(
      executePlatformTool(makeCtx(), 'todo_create', { goalId: 'goal-missing', title: 'x' }),
    ).rejects.toThrow('Goal not found');
    expect(mockGoals.createTodo).toHaveBeenCalled(); // the guard did not intercept
  });

  

  // ── FO firing 24 (2026-09-25): the guard's goal probe must run on the
  // CANONICAL id. A project-scoped run creating under a FOREIGN goal referenced
  // by its unique 8-char prefix previously BYPASSED the scoping refusal (the
  // exact findUnique on the raw prefix returned null → guard skipped). The
  // dispatch case now resolves the prefix BEFORE the probe, and passes the
  // RESOLVED id to createTodo.
  it('firing-24: a unique goal PREFIX resolves before the guard — a foreign-goal prefix create is REFUSED (not bypassed), and createTodo receives the canonical id', async () => {
    const FULL_FOREIGN = '0f9c6db6-aaaa-4bbb-8ccc-00000000000f';
    // The canonicalizer resolves the prefix; the guard probe then finds the row.
    mockGoals.canonicalGoalIdForTool.mockImplementation(async (id: string) => (id === '0f9c6db6' ? FULL_FOREIGN : id));
    mockDb.projectGoal.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === FULL_FOREIGN ? { projectId: FOREIGN } : where.id === GOAL_HOME ? { projectId: HOME } : null);
    const out = await executePlatformTool(makeCtx(), 'todo_create', { goalId: '0f9c6db6', title: 'prefix probe' });
    expect(out).toContain('REFUSED (cross-project write)'); // NOT bypassed
    expect(out).toContain(FULL_FOREIGN);
    expect(mockGoals.createTodo).not.toHaveBeenCalled();
    await flush();
    expect(mockLoopMetrics.recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike',
      meta: expect.objectContaining({ seam: 'cross_project_write_refused', goalId: FULL_FOREIGN }),
    }));
  });

  it('firing-24: a HOME goal referenced by prefix resolves and executes — createTodo receives the canonical id', async () => {
    const FULL_HOME = 'homegoal-aaaa-4bbb-8ccc-000000000001';
    mockGoals.canonicalGoalIdForTool.mockImplementation(async (id: string) => (id === 'homegoal1' ? FULL_HOME : id));
    mockDb.projectGoal.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === FULL_HOME ? { projectId: HOME } : null);
    const out = await executePlatformTool(makeCtx(), 'todo_create', { goalId: 'homegoal1', title: 'home prefix' });
    expect(out).toContain('Created todo t-new-123');
    expect(mockGoals.createTodo).toHaveBeenCalledWith(expect.objectContaining({ goalId: FULL_HOME, title: 'home prefix' }));
  });

  it('firing-24: canonicalizer failure falls back to the RAW id — fail-open guard semantics preserved', async () => {
    mockGoals.canonicalGoalIdForTool.mockRejectedValue(new Error('prisma hiccup'));
    mockGoals.createTodo.mockRejectedValue(Object.assign(new Error('Goal not found: "0f9c6db6".'), { statusCode: 404 }));
    await expect(
      executePlatformTool(makeCtx(), 'todo_create', { goalId: '0f9c6db6', title: 'x' }),
    ).rejects.toThrow('Goal not found'); // createTodo's canonical 404 owns the error
    expect(mockGoals.createTodo).toHaveBeenCalledWith(expect.objectContaining({ goalId: '0f9c6db6' }));
  });
});

// ── Owner 2026-09-22: "sessions that were created to fix frameworks are just in
// my normal non-workspace — I see two" — two crossmodel lanes spawned review
// children with projectId = the owner's personal Workspace. A spawn from a
// project-scoped run is pinned to its home project unless the fleet assigned
// this chat a todo in the target; a missing projectId defaults to home; an
// ungrouped caller is untouched.
describe('home-project pin on start_coding_session (owner 2026-09-22)', () => {
  beforeEach(() => {
    mockStartCodingSession.mockClear();
    (mockDb.crossModelChat.findUnique as jest.Mock).mockImplementation(async ({ where }: any) =>
      where?.id === LANE ? { id: LANE, userId: USER, isProjectSupervisor: false, projectId: HOME } : null);
  });

  it('a spawn into a FOREIGN project from a project-scoped lane is re-homed to the lane\'s project, the caller is told, and a corrected-spawn strike is recorded', async () => {
    const out = await executePlatformTool(makeCtx(), 'start_coding_session', { projectId: FOREIGN, title: 'Adversarial Review of Proposed Fix' });
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].projectId).toBe(HOME);
    expect(String(out)).toContain('NOTE: you asked for project');
    expect(String(out)).toContain(`created in this chat's own project ${HOME}`);
    await flush();
    expect(mockLoopMetrics.recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_strike', meta: expect.objectContaining({ seam: 'cross_project_spawn_corrected', homeProjectId: HOME, targetProjectId: FOREIGN }),
    }));
  });

  it('the fleet\'s assignment authorizes the cross-project spawn — the target is kept', async () => {
    mockDb.projectTodo.findFirst.mockResolvedValueOnce({ id: 't-assigned' });
    const out = await executePlatformTool(makeCtx(), 'start_coding_session', { projectId: FOREIGN, title: 'Authorized reviewer' });
    expect(mockStartCodingSession.mock.calls[0][0].projectId).toBe(FOREIGN);
    expect(String(out)).not.toContain('NOTE: you asked for project');
  });

  it('a missing projectId defaults to the home project instead of failing', async () => {
    await executePlatformTool(makeCtx(), 'start_coding_session', { title: 'child' });
    expect(mockStartCodingSession.mock.calls[0][0].projectId).toBe(HOME);
  });

  it('an ungrouped caller (fleet supervisor pattern) spawns wherever it says', async () => {
    (mockDb.crossModelChat.findUnique as jest.Mock).mockResolvedValue({ id: LANE, userId: USER, isProjectSupervisor: false, projectId: null });
    await executePlatformTool(makeCtx({ projectId: 'chat' } as any), 'start_coding_session', { projectId: FOREIGN, title: 'fleet spawn' });
    expect(mockStartCodingSession.mock.calls[0][0].projectId).toBe(FOREIGN);
  });

  });

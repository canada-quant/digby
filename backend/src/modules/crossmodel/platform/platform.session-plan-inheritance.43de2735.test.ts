/**
 * REPLAY PIN — ticket 43de2735-784a-4a73-bc33-bd46f914bd8a (bug_report,
 * 2026-09-17): "Spawned review session's plan block shows a DIFFERENT ticket's
 * goal text — cross-session plan contamination".
 *
 * Observed: two sibling ticket lanes (c4825f71 on 31738d9a, 0c6aef9b on
 * dd4e20ad) ran in parallel and each spawned an adversarial-review child
 * minutes apart. get_chat_status on child fa15ffe5 returned plan.goal =
 * "Fix ticket 31738d9a: …" — the OTHER lane's ticket. The child revised its
 * plan 7-8 times with the foreign goal stuck (update_plan retains an omitted
 * goal server-side), and the goal rode the child's own per-turn <plan>
 * reminder — a context-layer leak, not just display.
 *
 * Root cause: startCodingSession ALWAYS chained continuity from
 * findPriorSession(projectId, newId) — the MOST RECENTLY UPDATED session in
 * the project, any lane — and provisionWorktree copied that prior session's
 * UNFINISHED plan (goal included) into the brand-new session's plan store.
 * With sibling lanes active, the "prior" is an unrelated lane and the spawned
 * child boots carrying its goal.
 *
 * Fix: a session created WITH an explicit first-goal prompt (fleet spawn /
 * ticket batch / start_coding_session brief — the prompt IS the goal) skips
 * prior-PLAN inheritance (inheritPriorPlan:false). Prompt-less UI
 * "continue my work" sessions keep it. Session-MEMORY inheritance and
 * branch continuity are deliberately untouched.
 *
 * These tests replay the exact contamination shape against mocked Prisma and
 * pin BOTH directions: prompted ⇒ no applyPlan; unprompted ⇒ applyPlan with
 * the prior goal (the feature the gate must not kill).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  crossModelChat: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  crossModelMessage: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  chatCodingState: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  agentRun: { findMany: jest.fn(), findFirst: jest.fn() },
  projectMember: { findUnique: jest.fn(), findMany: jest.fn() },
  userPreferences: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  chatSchedule: { count: jest.fn(), create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(), groupBy: jest.fn() },
  activity: { create: jest.fn(async () => ({})) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedis = {
  incr: jest.fn(), expire: jest.fn(), decr: jest.fn(), set: jest.fn(), del: jest.fn(),
  scan: jest.fn(async (_cursor?: number, _opts?: any) => ({ cursor: 0, keys: [] as string[] })),
  mGet: jest.fn(async (_keys?: string[]) => [] as Array<string | null>),
  exists: jest.fn(async (_key?: string) => 0),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

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

jest.mock('../integrations/moonshot.integration', () => ({ __esModule: true, default: { synthesize: jest.fn(), generateTitle: jest.fn() } }));

const mockResolveRegistryModel = jest.fn(async (_spec?: string, _userId?: string): Promise<any> => null);
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));

jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../langgraph/memory.graph', () => ({
  __esModule: true,
  getProjectSettings: jest.fn(async () => ({ crossProjectMemory: false })),
  setProjectSettings: jest.fn(async () => ({ crossProjectMemory: true })),
  updateContextAsync: jest.fn(),
}));

const mockStartDetachedChatRun = jest.fn((..._args: any[]) => true);
const mockPreemptMachineRun = jest.fn(async (..._args: any[]): Promise<{ preempted: boolean; freed: boolean }> => ({ preempted: false, freed: false }));
const mockNudgeQueueDrainSoon = jest.fn((..._args: any[]) => {});
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  preemptMachineRunForUserMessage: (...a: any[]) => mockPreemptMachineRun(...a),
  nudgeQueueDrainSoon: (...a: any[]) => mockNudgeQueueDrainSoon(...a),
  chatRunKey: (id: string) => `chat:${id}`,
}));

const mockStartScheduledRun = jest.fn(async (..._args: any[]): Promise<{ started: boolean; reason?: string }> => ({ started: true }));
const mockSteerActiveRun = jest.fn(async (..._args: any[]): Promise<{ steered: boolean; reason?: string }> => ({ steered: false, reason: 'no_active_run' }));
jest.mock('../coding/coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
  steerActiveRun: (...a: any[]) => mockSteerActiveRun(...a),
}));

const mockLoadAttachment = jest.fn(async (..._args: any[]): Promise<any> => null);
jest.mock('../upload.controller', () => ({
  loadAttachment: (...a: any[]) => mockLoadAttachment(...a),
}));

const mockEnqueueChatMessage = jest.fn(async (..._args: any[]) => ({ id: 'p1', position: 1 }));
const mockCountPending = jest.fn(async (..._args: any[]): Promise<number> => 0);
const mockCountPendingUser = jest.fn(async (..._args: any[]): Promise<number> => 0);
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  MAX_QUEUE_DEPTH: 20,
  enqueueChatMessage: (...a: any[]) => mockEnqueueChatMessage(...a),
  countPending: (...a: any[]) => mockCountPending(...a),
  countPendingUser: (...a: any[]) => mockCountPendingUser(...a),
}));

const mockDepthForChat = jest.fn(async (..._args: any[]) => 0);
const mockStampHookDepth = jest.fn(async (..._args: any[]) => {});
const mockEmitHookEvent = jest.fn(async (..._args: any[]) => {});
jest.mock('./hooks.service', () => ({
  __esModule: true,
  depthForChat: (...a: any[]) => mockDepthForChat(...a),
  stampHookDepth: (...a: any[]) => mockStampHookDepth(...a),
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
}));

const mockEnsureUserSpace = jest.fn(async (..._args: any[]): Promise<any> => null);
jest.mock('./user-space.service', () => ({
  __esModule: true,
  ensureUserSpace: (...a: any[]) => mockEnsureUserSpace(...a),
}));

const mockEnsureProjectSupervisor = jest.fn(async (..._args: any[]): Promise<any> => null);
const mockPauseProjectSupervisor = jest.fn(async (..._args: any[]): Promise<void> => {});
jest.mock('./project-supervisor.service', () => ({
  __esModule: true,
  ensureProjectSupervisor: (...a: any[]) => mockEnsureProjectSupervisor(...a),
  pauseProjectSupervisor: (...a: any[]) => mockPauseProjectSupervisor(...a),
}));

jest.mock('../coding/workspace.service', () => ({
  __esModule: true,
  sessionBranchName: (id: string) => `digby/session-${id}`,
  worktreePath: (id: string) => `/wt/${id}`,
  ensureWorktree: jest.fn(async () => '/wt/x'),
  ensureBlankWorktree: jest.fn(async () => '/wt/x'),
  removeWorktree: jest.fn(async () => {}),
  removeSessionEnv: jest.fn(async () => {}),
  // Ticket a086c69d: provisionWorktree now gates on volume ownership — the
  // default-owner mock keeps this suite on the EAGER path (plan inheritance
  // runs before the ready flip), matching pre-change behavior.
  isWorkspaceVolumeOwner: jest.fn(() => true),
}));
jest.mock('../coding/container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(async () => ({})),
  stopSessionContainer: jest.fn(async () => {}),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  clearSessionMemory: jest.fn(async () => {}),
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
}));
jest.mock('../coding/scaffolding.service', () => ({ __esModule: true, scaffoldProjectDocs: jest.fn(async () => {}), ensureProjectDocs: jest.fn(async () => ({ scaffold: {}, refresh: {} })) }));
const mockInheritSessionMemory = jest.fn(async (..._args: any[]) => {});
jest.mock('../coding/coding-memory.service', () => ({ __esModule: true, inheritSessionMemory: (...a: any[]) => mockInheritSessionMemory(...a) }));
jest.mock('../coding/verify.service', () => ({ __esModule: true, readDigbyConfig: jest.fn(async () => null) }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => {}),
  memClear: jest.fn(async () => {}),
}));
jest.mock('../coding/worktree-snapshot.service', () => ({
  __esModule: true,
  publishWorktreeSnapshot: jest.fn(async () => {}),
}));

// plan.service: REAL module except the two recording seams the fix gates on —
// getPlan (fed the sibling lane's unfinished plan) and applyPlan (the write
// that must NOT happen for a prompted spawn). requireActual keeps planToUpdate
// and every other export real so the inheritance payload shape stays honest.
const mockGetPlan = jest.fn(async (_sessionId: string): Promise<any> => null);
const mockApplyPlan = jest.fn(async (_sessionId: string, _worktree: string, _update: any): Promise<any> => ({ plan: null, warnings: [] }));
jest.mock('../coding/plan.service', () => {
  const actual = jest.requireActual('../coding/plan.service');
  return {
    __esModule: true,
    ...actual,
    getPlan: (sessionId: string) => mockGetPlan(sessionId),
    applyPlan: (sessionId: string, worktree: string, update: any) => mockApplyPlan(sessionId, worktree, update),
  };
});

import * as platform from './platform.service';

const OWNER = 'owner-1';

const CODING_PROJECT = {
  id: 'proj-1', userId: OWNER, name: 'Repo', repoUrl: 'https://github.com/a/b',
  repoProvider: 'github', defaultBranch: 'main', githubLabel: null,
  createdAt: new Date(), updatedAt: new Date(),
};

/** The SIBLING LANE (c4825f71 shape): most recently updated session in the
 *  project, still holding an UNFINISHED plan for its own ticket. */
const PRIOR_STATE = {
  id: 'prior-1', projectId: 'proj-1', userId: OWNER, title: 'Sibling lane',
  branch: 'digby/session-prior-1', baseBranch: 'main', worktreePath: '/wt/prior-1',
  permissionMode: 'auto', model: 'glm-5.3', status: 'ready', errorMessage: null,
  createdAt: new Date(), updatedAt: new Date(),
  chat: {
    id: 'prior-1', userId: OWNER, projectId: 'proj-1', title: 'Sibling lane',
    mode: 'code', createdAt: new Date(), updatedAt: new Date(),
  },
};
const FOREIGN_GOAL = "Fix ticket 31738d9a: cross-checker drafts must not present fabricated state-claims as observed fact";
const PRIOR_PLAN = {
  goal: FOREIGN_GOAL,
  acceptanceCriteria: ['verify chain green'],
  version: 7,
  updatedAt: new Date().toISOString(),
  steps: [
    { id: 1, text: 'implement the fix', status: 'completed' },
    { id: 2, text: 'deploy-watch + evidence-close', status: 'in_progress' },
  ],
};

function mockNewSession(id: string) {
  mockPrisma.crossModelProject.findFirst.mockResolvedValue(CODING_PROJECT);
  mockPrisma.userPreferences.findUnique.mockResolvedValue(null);
  mockPrisma.crossModelChat.create.mockResolvedValue({
    id, userId: OWNER, projectId: 'proj-1', title: 'Review child', mode: 'code',
    createdAt: new Date(), updatedAt: new Date(),
  });
  mockPrisma.chatCodingState.create.mockResolvedValue({
    id, projectId: 'proj-1', userId: OWNER, title: 'Review child', branch: 'pending',
    baseBranch: 'main', worktreePath: null, permissionMode: 'auto', model: 'glm-5.3',
    status: 'provisioning', errorMessage: null, createdAt: new Date(), updatedAt: new Date(),
  });
  // findPriorSession: the sibling lane is the most recently updated session.
  mockPrisma.chatCodingState.findFirst.mockResolvedValue(PRIOR_STATE);
  // The sibling's durable plan row (unfinished, foreign ticket goal).
  mockGetPlan.mockImplementation(async (sessionId: string) => (sessionId === 'prior-1' ? PRIOR_PLAN : null));
}

const flush = async (rounds = 25) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.activity.create.mockResolvedValue({});
  (mockPrisma.$transaction as any).mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg)));
});

describe('ticket 43de2735 — cross-session plan contamination on session spawn', () => {
  it('REPRO: a session spawned WITH a first-goal brief (the review-child shape) does NOT inherit the sibling lane\'s unfinished plan', async () => {
    mockNewSession('sess-new');
    // First-prompt delivery chain (mirrors platform.service.test.ts P6 setup):
    mockRedis.set.mockImplementation(async (key: string, ..._args: any[]) =>
      typeof key === 'string' && key.startsWith('coding:first-prompt:') ? 'OK' : undefined);
    (mockRedis as any).get = jest.fn(async (key: string) =>
      key === 'coding:first-prompt:pending:sess-new' ? 'review the dd4e20ad diff' : null);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 'sess-new', status: 'ready', worktreePath: '/wt/sess-new' });
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ select }: any) =>
      select?.userId && !select?.title
        ? { id: 'sess-new', userId: OWNER, projectId: 'proj-1' }
        : { id: 'sess-new', userId: OWNER, projectId: 'proj-1', title: 'Review child', mode: 'code', createdAt: new Date(), updatedAt: new Date() });
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);

    const s = await platform.startCodingSession({
      userId: OWNER, projectId: 'proj-1', title: 'Review child',
      prompt: 'review the dd4e20ad diff', promptOrigin: { kind: 'agent' },
    });
    expect(s.id).toBe('sess-new');
    await flush();

    // THE PIN: the foreign goal must never be written into the new session's
    // plan store. Pre-fix this fired with planToUpdate(PRIOR_PLAN) — the exact
    // 43de2735 contamination (goal "Fix ticket 31738d9a…" on a dd4e20ad lane).
    expect(mockApplyPlan).not.toHaveBeenCalled();
    // Branch continuity (findPriorSession) is deliberately UNAFFECTED — the
    // new branch still bases on the sibling's branch (out of this ticket's
    // scope), and session-MEMORY inheritance still runs.
    expect(mockInheritSessionMemory).toHaveBeenCalledWith('prior-1', 'sess-new');
  });

  it('CONTINUITY PRESERVED: a prompt-less UI "continue my work" session STILL inherits the prior unfinished plan', async () => {
    mockNewSession('sess-ui');
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 'sess-ui', status: 'ready', worktreePath: '/wt/sess-ui' });

    const s = await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'Continue' });
    expect(s.id).toBe('sess-ui');
    await flush();

    expect(mockApplyPlan).toHaveBeenCalledTimes(1);
    const [targetSessionId, _wt, update] = mockApplyPlan.mock.calls[0];
    expect(targetSessionId).toBe('sess-ui');
    expect(update.goal).toBe(FOREIGN_GOAL);
    expect(update.steps.map((st: any) => st.text)).toEqual(['implement the fix', 'deploy-watch + evidence-close']);
  });

  it('pre-existing guard intact: a COMPLETED prior plan is never inherited (prompt-less flow)', async () => {
    mockNewSession('sess-ui2');
    mockGetPlan.mockImplementation(async (sessionId: string) =>
      sessionId === 'prior-1'
        ? { ...PRIOR_PLAN, steps: PRIOR_PLAN.steps.map((st) => ({ ...st, status: 'completed' })) }
        : null);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 'sess-ui2', status: 'ready', worktreePath: '/wt/sess-ui2' });

    await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'Continue' });
    await flush();

    expect(mockApplyPlan).not.toHaveBeenCalled();
  });

  it('chainFromPrior:false (dedicated ticket lanes, 2026-10-06) → no prior lookup: base branch, no plan, no session memory', async () => {
    mockNewSession('sess-ticket');
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 'sess-ticket', status: 'ready', worktreePath: '/wt/sess-ticket' });
    const ws = jest.requireMock('../coding/workspace.service') as any;
    ws.ensureWorktree.mockClear();

    await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'ticket 4bb5fe23: add ga tag', chainFromPrior: false });
    await flush();

    // findPriorSession (chatCodingState.findFirst) is never consulted, so the
    // branch bases on origin/<base> — not the sibling lane's unmerged branch.
    expect(mockPrisma.chatCodingState.findFirst).not.toHaveBeenCalled();
    expect(ws.ensureWorktree).toHaveBeenCalledTimes(1);
    expect(ws.ensureWorktree.mock.calls[0][6]).toBeUndefined();
    expect(mockApplyPlan).not.toHaveBeenCalled();
    expect(mockInheritSessionMemory).not.toHaveBeenCalled();
  });

  it('no prior session at all → no inheritance, no crash (first session in a project)', async () => {
    mockNewSession('sess-first');
    mockPrisma.chatCodingState.findFirst.mockResolvedValue(null); // findPriorSession → null
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 'sess-first', status: 'ready', worktreePath: '/wt/sess-first' });

    await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'First' });
    await flush();

    expect(mockApplyPlan).not.toHaveBeenCalled();
    expect(mockInheritSessionMemory).not.toHaveBeenCalled();
  });
});

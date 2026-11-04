/**
 * REPLAY — audit 2026-10-08 W2-1 (lanes.md F2): spawned children branched from
 * the most recently updated SIBLING session's branch.
 *
 * Observed (prod, 2026-10-07/08): crossmodel reviewer sub-sessions 521edf42,
 * acc12087, af23b007 and 0bdc8200 all started at 2745ea53 — the FO lane
 * 5f90c628's `digby/session-5f90c628` branch, stuck on 2026-09-23 (871 commits
 * behind origin/main) because that lane works on fo/* branches. findPriorSession
 * (project-wide "most recently updated session") picked it; only ticket lanes
 * passed chainFromPrior:false. The reviewers' verify chains then failed on a
 * time-bomb test main had fixed on 09-25, a frontier council was convened to
 * diagnose the stale base, and one reviewer committed a fixture "sync".
 *
 * Fix: start_coding_session passes chainFromPrior:false (fresh from
 * origin/<default>) and a caller that WANTS a branch names it (continueBranch ->
 * startFromBranch). The prompt-less UI "continue my work" path keeps the chain.
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
  codingSchedule: { count: jest.fn(), create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(), groupBy: jest.fn() },
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

const FO_PRIOR = { ...PRIOR_STATE, id: '5f90c628-fo-lane', branch: 'digby/session-5f90c628', title: 'FO lane' };

describe('audit 2026-10-08 W2-1 — spawned children start fresh, not from a sibling lane', () => {
  it('REPLAY: a reviewer spawn (chainFromPrior:false) is cut from origin/<default>, never the FO lane branch', async () => {
    mockNewSession('521edf42-new');
    mockPrisma.chatCodingState.findFirst.mockResolvedValue(FO_PRIOR);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: '521edf42-new', status: 'ready', worktreePath: '/wt/521edf42-new' });
    const ws: any = jest.requireMock('../coding/workspace.service');
    const s = await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'Independent review', chainFromPrior: false });
    await flush();
    expect(ws.ensureWorktree).toHaveBeenCalledTimes(1);
    const args = (ws.ensureWorktree as jest.Mock).mock.calls[0];
    expect(args[6]).toBeUndefined(); // startRef: none => origin/main
    expect(args).not.toContain('digby/session-5f90c628');
    expect(mockInheritSessionMemory).not.toHaveBeenCalled();
    expect((s as any).chainedFromSession).toBeUndefined();
    expect((s as any).startFromBranch).toBeUndefined();
  });

  it('an explicit continueBranch (startFromBranch) is the only chain — no plan / memory inheritance', async () => {
    mockNewSession('rev-child');
    mockPrisma.chatCodingState.findFirst.mockResolvedValue(FO_PRIOR);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 'rev-child', status: 'ready', worktreePath: '/wt/rev-child' });
    const ws: any = jest.requireMock('../coding/workspace.service');
    const s = await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'Review a1ab0cd5', chainFromPrior: false, startFromBranch: 'digby/session-a1ab0cd5' });
    await flush();
    expect((ws.ensureWorktree as jest.Mock).mock.calls[0][6]).toBe('digby/session-a1ab0cd5');
    expect(mockInheritSessionMemory).not.toHaveBeenCalled();
    expect(mockApplyPlan).not.toHaveBeenCalled();
    expect((s as any).startFromBranch).toBe('digby/session-a1ab0cd5');
  });

  it('a malformed continueBranch is ignored (fresh base), never handed to git', () => {
    for (const bad of ['--upload-pack=touch x', 'main..HEAD', '', '   ', 'refs/heads/x/', '-x', 'a b']) {
      expect(platform.validStartFromBranch(bad)).toBeUndefined();
    }
    expect(platform.validStartFromBranch(' origin/fo/firing-10 ')).toBe('origin/fo/firing-10');
    expect(platform.validStartFromBranch('digby/session-a1ab0cd5')).toBe('digby/session-a1ab0cd5');
  });

  it('the UI "continue my work" path (no chainFromPrior) still chains from the prior session', async () => {
    mockNewSession('sess-ui3');
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 'sess-ui3', status: 'ready', worktreePath: '/wt/sess-ui3' });
    const ws: any = jest.requireMock('../coding/workspace.service');
    const s = await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'Continue' });
    await flush();
    expect((ws.ensureWorktree as jest.Mock).mock.calls[0][6]).toBe('digby/session-prior-1');
    expect((s as any).chainedFromSession).toBe('prior-1');
  });
});

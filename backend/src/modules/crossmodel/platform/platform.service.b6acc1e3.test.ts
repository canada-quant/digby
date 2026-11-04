/**
 * Ticket b6acc1e3 — start_coding_session `model` param, SERVICE layer.
 *
 * The ticket: start_coding_session exposed no model/model-route parameter, so a
 * supervisor seat could not pick the model a spawned session runs on — the
 * spawn stamped the platform default regardless of intent (2026-09-17 kimi-k3
 * billing 429: spawn d4ab649b stamped kimi-k3 and its first run died on the
 * same 429, while the supervisor intended glm-5.3).
 *
 * The fix: startCodingSession accepts an optional explicit `model`, validated
 * with the SAME resolveOneCodingPick the pref/project picks use (built-ins +
 * legacy aliases + enabled [coding] '<label>:<modelId>' Edge specs — the REAL
 * coding-data.service runs in this file, only the Edge registry is stubbed).
 * An explicit param WINS over the whole default chain (project pick → user
 * pref → coding_default seat) and stamps chatCodingState.modelSource
 * 'spawn-param' (the run-executor then skips the project override — that half
 * is pinned in coding/run-executor.test.ts). An unresolvable value is a hard
 * 400 — never a silent re-stamp to the default the caller routed around.
 *
 * Mock stack mirrors platform.service.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  crossModelChat: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  chatCodingState: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  userPreferences: { findUnique: jest.fn() },
  activity: { create: jest.fn(async () => ({})) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    incr: jest.fn(), expire: jest.fn(), decr: jest.fn(), set: jest.fn(), del: jest.fn(),
    scan: jest.fn(async () => ({ cursor: 0, keys: [] as string[] })),
    mGet: jest.fn(async () => [] as Array<string | null>),
    exists: jest.fn(async () => 0),
  },
}));

// error-handler imports config/env → process.exit at import without env vars.
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

// Edge custom-endpoint registry (dynamically imported by the REAL
// resolveOneCodingPick's '<label>:<modelId>' branch). Default: no match.
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
// The project codingModel pick lives in the Store — the default-resolution
// conflict case sets it per-test.
const mockGetProjectSettings = jest.fn(async (_projectId?: string): Promise<any> => ({ crossProjectMemory: false }));
jest.mock('../langgraph/memory.graph', () => ({
  __esModule: true,
  getProjectSettings: (...a: any[]) => mockGetProjectSettings(...a),
  setProjectSettings: jest.fn(async () => ({ crossProjectMemory: true })),
  updateContextAsync: jest.fn(),
}));

jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: jest.fn(() => true),
  preemptMachineRunForUserMessage: jest.fn(async () => ({ preempted: false, freed: false })),
  nudgeQueueDrainSoon: jest.fn(() => {}),
  chatRunKey: (id: string) => `chat:${id}`,
}));
jest.mock('../coding/coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: jest.fn(async () => ({ started: true })),
  steerActiveRun: jest.fn(async () => ({ steered: false, reason: 'no_active_run' })),
}));
jest.mock('../upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  MAX_QUEUE_DEPTH: 20,
  enqueueChatMessage: jest.fn(async () => ({ id: 'p1', position: 1 })),
  countPending: jest.fn(async () => 0),
  countPendingUser: jest.fn(async () => 0),
}));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  depthForChat: jest.fn(async () => 0),
  stampHookDepth: jest.fn(async () => {}),
  emitHookEvent: jest.fn(async () => {}),
}));
jest.mock('./user-space.service', () => ({ __esModule: true, ensureUserSpace: jest.fn(async () => null) }));
jest.mock('./project-supervisor.service', () => ({
  __esModule: true,
  ensureProjectSupervisor: jest.fn(async () => null),
  pauseProjectSupervisor: jest.fn(async () => {}),
}));
jest.mock('../coding/workspace.service', () => ({
  __esModule: true,
  sessionBranchName: (id: string) => `digby/session-${id}`,
  worktreePath: (id: string) => `/wt/${id}`,
  ensureWorktree: jest.fn(async () => '/wt/x'),
  ensureBlankWorktree: jest.fn(async () => '/wt/x'),
  removeWorktree: jest.fn(async () => {}),
  removeSessionEnv: jest.fn(async () => {}),
}));
jest.mock('../coding/container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(async () => ({})),
  stopSessionContainer: jest.fn(async () => {}),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
}));
jest.mock('../coding/scaffolding.service', () => ({ __esModule: true, scaffoldProjectDocs: jest.fn(async () => {}), ensureProjectDocs: jest.fn(async () => ({ scaffold: {}, refresh: {} })) }));
jest.mock('../coding/coding-memory.service', () => ({ __esModule: true, inheritSessionMemory: jest.fn(async () => {}) }));
jest.mock('../coding/verify.service', () => ({ __esModule: true, readDigbyConfig: jest.fn(async () => null) }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  default: { search: jest.fn(async () => []), add: jest.fn(async () => {}) },
}));

import * as platform from './platform.service';

const OWNER = 'u-owner';
const CODING_PROJECT = {
  id: 'proj-1', userId: OWNER, name: 'Repo', repoUrl: 'https://github.com/a/b',
  repoProvider: 'github', defaultBranch: 'main', githubLabel: null,
  createdAt: new Date(), updatedAt: new Date(),
};

/** Standard spawn mocks; the created state row echoes its write data so the
 *  returned session shape reflects exactly what was stamped. */
function mockSpawn() {
  mockPrisma.crossModelProject.findFirst.mockResolvedValue(CODING_PROJECT);
  mockPrisma.userPreferences.findUnique.mockResolvedValue(null);
  mockPrisma.crossModelChat.create.mockImplementation(async ({ data }: any) => ({
    id: 'sess-1', userId: data.userId, projectId: data.projectId, title: data.title,
    mode: data.mode, createdAt: new Date(), updatedAt: new Date(),
  }));
  mockPrisma.chatCodingState.create.mockImplementation(async ({ data }: any) => ({
    id: data.id, projectId: data.projectId, userId: data.userId, title: data.title,
    branch: data.branch, baseBranch: 'main', worktreePath: null,
    permissionMode: data.permissionMode, model: data.model, modelSource: data.modelSource ?? null,
    status: 'provisioning', errorMessage: null, createdAt: new Date(), updatedAt: new Date(),
  }));
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
  mockPrisma.chatCodingState.update.mockResolvedValue({});
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({ supervised: true });
}

beforeEach(() => jest.clearAllMocks());

describe('startCodingSession explicit model param (ticket b6acc1e3)', () => {
  it('an explicit model WINS over BOTH the project pick and the user pref, stamped modelSource spawn-param', async () => {
    mockSpawn();
    // The ticket's exact scenario: the project pick points at the dead route…
    mockGetProjectSettings.mockResolvedValue({ codingModel: 'kimi-k3' });
    // …and so does the user pref — the explicit param must beat BOTH.
    mockPrisma.userPreferences.findUnique.mockResolvedValue({ codingModel: 'deepseek-flash', codingPermissionMode: 'auto' });

    const s = await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'Fix', model: 'glm-5.3' });

    expect(mockPrisma.chatCodingState.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ model: 'glm-5.3', modelSource: 'spawn-param' }) }),
    );
    expect(s.model).toBe('glm-5.3');
    expect(s.modelSource).toBe('spawn-param');
    // The audit row names the provenance too (never a silent stamp).
    expect(mockPrisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'code.session_start',
          metadata: expect.objectContaining({ model: 'glm-5.3', modelSource: 'spawn-param' }),
        }),
      }),
    );
  });

  it('a legacy alias explicit pick aliases forward (glm-5.2 → glm-5.3) and stamps spawn-param', async () => {
    mockSpawn();
    const s = await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'Fix', model: 'glm-5.2' });
    expect(mockPrisma.chatCodingState.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ model: 'glm-5.3', modelSource: 'spawn-param' }) }),
    );
    expect(s.model).toBe('glm-5.3');
  });

  it('an UNRESOLVABLE model is a hard 400 — nothing created, the message names the bad value', async () => {
    mockSpawn();
    const err = await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'Fix', model: 'gpt-4o' })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 400 });
    expect(String(err.message)).toContain('"gpt-4o"');
    expect(String(err.message)).toContain('glm-5.3 | deepseek-flash | kimi-k3');
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatCodingState.create).not.toHaveBeenCalled();
  });

  it('no model param → the DEFAULT chain runs (project pick wins) and modelSource stays NULL', async () => {
    mockSpawn();
    mockGetProjectSettings.mockResolvedValue({ codingModel: 'kimi-k3' });
    const s = await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'Fix' });
    const createData = mockPrisma.chatCodingState.create.mock.calls[0][0].data;
    expect(createData.model).toBe('kimi-k3');
    // Spread-stamped only when set: the key is absent (column stays NULL) so
    // the run-time project override keeps applying to default-stamped sessions.
    expect(createData.modelSource).toBeUndefined();
    expect(s.model).toBe('kimi-k3');
    expect(s.modelSource).toBeNull();
  });

  it("an enabled, [coding]-flagged Edge '<label>:<modelId>' spec is accepted verbatim (resolveOneCodingPick family — no second validator)", async () => {
    mockSpawn();
    mockResolveRegistryModel.mockResolvedValue({ coding: true, enabled: true });
    const s = await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'Fix', model: 'spark:my-coding-model' });
    expect(mockResolveRegistryModel).toHaveBeenCalledWith('spark:my-coding-model', OWNER);
    expect(mockPrisma.chatCodingState.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ model: 'spark:my-coding-model', modelSource: 'spawn-param' }) }),
    );
    expect(s.model).toBe('spark:my-coding-model');
  });

  it('an Edge spec that no longer resolves enabled+coding-capable is a 400 (no silent fall-back to the default)', async () => {
    mockSpawn();
    mockResolveRegistryModel.mockResolvedValue(null); // gone / disabled
    const err = await platform.startCodingSession({ userId: OWNER, projectId: 'proj-1', title: 'Fix', model: 'spark:dead-model' })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 400 });
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
  });
});

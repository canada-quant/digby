/**
 * DW-5 measure-first (FO firing 68, 2026-10-03; owner 2026-09-11 "sending a
 * message to the Fleet Supervisor chat feels stuck 3-7 s"): the
 * supervisor_send_timing instrument on the platform seam. The f66 adjudication
 * proved the send is durable-correct and pinned the source-derived bound
 * (PREEMPT_WAIT_MS 5_000) — this landing adds the MEASUREMENT the backlog
 * item's next step demands before any ordering change: one
 * loop_metrics row per fleet-surface send, seams attributed.
 *
 * What this pins (the real sendChatMessage plain path, mocked at every
 * boundary exactly like platform.service.test.ts):
 *   - a fleet-marked send stamps EXACTLY ONE row at its terminal with the
 *     seam breakdown (authMs / modeMs / busyMs / preemptMs / deliverMs);
 *   - the busy path stamps outcome 'queued' (and a freed preempt 'started'
 *     with preempted:true);
 *   - a send WITHOUT the fleet marker stamps nothing — every other
 *     sendChatMessage caller is untouched.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
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

const mockAutoOnly: jest.Mock = jest.fn(async () => false);
const mockAllowance: jest.Mock = jest.fn(async () => ({ allowed: true }));
const mockReserve: jest.Mock = jest.fn(async () => ({ allowed: true, used: 1, limit: 5, remaining: 4 }));
jest.mock('../rate-limit.service', () => ({
  getPatienceAutoOnly: (...a: any[]) => mockAutoOnly(...a),
  deepResearchAllowance: (...a: any[]) => mockAllowance(...a),
  reserveDeepResearchQuota: (...a: any[]) => mockReserve(...a),
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
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
jest.mock('../coding/spend-cap.service', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/spend-cap.service'),
  trailingProjectSpend24h: jest.fn(async () => ({ usd: 0, runs: 0 })),
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
  __esModule: true,
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
const mockHookBacklogStarving = jest.fn(async (..._args: any[]): Promise<boolean> => false);
const mockDrainHookEventsForTarget = jest.fn((..._args: any[]) => {});
jest.mock('./hooks.service', () => ({
  __esModule: true,
  depthForChat: (...a: any[]) => mockDepthForChat(...a),
  stampHookDepth: (...a: any[]) => mockStampHookDepth(...a),
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  hookBacklogStarving: (...a: any[]) => mockHookBacklogStarving(...a),
  drainHookEventsForTarget: (...a: any[]) => mockDrainHookEventsForTarget(...a),
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
jest.mock('../coding/coding-memory.service', () => ({ __esModule: true, inheritSessionMemory: jest.fn(async () => {}) }));
jest.mock('../coding/verify.service', () => ({ __esModule: true, readDigbyConfig: jest.fn(async () => null) }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => {}),
  memClear: jest.fn(async () => {}),
}));

// The instrument itself — kinds REAL (so every other kind reference in
// platform.service stays intact), recordLoopMetric CAPTURED.
const mockRecordLoopMetric = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import * as platform from './platform.service';

const OWNER = 'u-owner';
const SUP_CHAT = {
  id: 'sup-chat-1', userId: OWNER, projectId: null, title: 'Fleet Supervisor',
  mode: 'thinking', isSupervisor: true, isProjectSupervisor: false,
  createdAt: new Date('2026-07-01'), updatedAt: new Date('2026-07-02'),
};

function mockChatAccess(chat: any) {
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ select }: any) => {
    if (select?.userId && !select?.title) return { id: chat.id, userId: chat.userId, projectId: chat.projectId };
    return { ...chat };
  });
  mockPrisma.projectMember.findUnique.mockResolvedValue(null);
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
  mockPrisma.crossModelChat.update.mockResolvedValue({ ...chat });
  mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
  mockPrisma.chatCodingState.update.mockResolvedValue({});
}

const timingRows = () => mockRecordLoopMetric.mock.calls
  .map((c: any[]) => c[0])
  .filter((r: any) => r?.kind === 'supervisor_send_timing');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.activity.create.mockResolvedValue({});
  mockPrisma.crossModelProject.findUnique.mockResolvedValue(null);
  mockPrisma.agentRun.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
  mockPrisma.chatSchedule.groupBy.mockResolvedValue([]);
  mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
  mockPrisma.chatSchedule.count.mockResolvedValue(0);
  mockPrisma.chatCodingState.count.mockResolvedValue(0);
  mockRedis.scan.mockResolvedValue({ cursor: 0, keys: [] });
  mockRedis.mGet.mockResolvedValue([]);
  mockRedis.exists.mockResolvedValue(0);
  mockPrisma.projectMember.findMany.mockResolvedValue([]);
  mockStartDetachedChatRun.mockReturnValue(true);
  mockDepthForChat.mockResolvedValue(0);
  mockLoadAttachment.mockResolvedValue(null);
  mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
  mockEnsureUserSpace.mockResolvedValue(null);
  mockResolveRegistryModel.mockResolvedValue(null);
});

describe('DW-5 supervisor_send_timing — the platform seam (FO firing 68)', () => {
  it('a fleet-marked send stamps EXACTLY ONE row at its terminal with the seam breakdown', async () => {
    mockChatAccess(SUP_CHAT);
    const r = await platform.sendChatMessage({ userId: OWNER, chatId: SUP_CHAT.id, content: 'status?', timingSurface: 'fleet' });
    expect(r.queued).toBe(true);
    const rows = timingRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.sessionId).toBe(SUP_CHAT.id);
    expect(row.unit).toBe('ms');
    expect(typeof row.value).toBe('number');
    expect(row.value).toBeGreaterThanOrEqual(0);
    expect(row.meta).toMatchObject({ surface: 'fleet', outcome: 'started', busy: false, preempted: false });
    for (const k of ['authMs', 'modeMs', 'busyMs', 'preemptMs', 'deliverMs']) {
      expect(typeof row.meta[k]).toBe('number');
      expect(row.meta[k]).toBeGreaterThanOrEqual(0);
    }
    // The send itself is unchanged: the detached run started exactly as before.
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER, chatId: SUP_CHAT.id, message: 'status?' }),
    );
  });

  it('a BUSY supervisor chat stamps outcome queued (the owner-felt case — the message lands in the durable FIFO)', async () => {
    mockChatAccess(SUP_CHAT);
    mockRedis.exists.mockResolvedValue(1); // cross-process busy liveness key
    const r = await platform.sendChatMessage({ userId: OWNER, chatId: SUP_CHAT.id, content: 'status?', timingSurface: 'fleet' });
    expect(r).toMatchObject({ ok: true, queued: true, position: 1 });
    const rows = timingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ surface: 'fleet', outcome: 'queued', busy: true, preempted: false });
  });

  it('a preempt that FREED the slot stamps started with preempted:true — the F1 seam the f66 bound names', async () => {
    mockChatAccess(SUP_CHAT);
    mockRedis.exists.mockResolvedValue(1);
    mockPreemptMachineRun.mockResolvedValueOnce({ preempted: true, freed: true });
    const r = await platform.sendChatMessage({ userId: OWNER, chatId: SUP_CHAT.id, content: 'status?', timingSurface: 'fleet' });
    expect(r.queued).toBe(true);
    const rows = timingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ surface: 'fleet', outcome: 'started', preempted: true });
    expect(mockPreemptMachineRun).toHaveBeenCalledWith(SUP_CHAT.id);
  });

  it('a send WITHOUT the fleet marker stamps nothing — every other sendChatMessage caller is untouched', async () => {
    mockChatAccess(SUP_CHAT);
    const r = await platform.sendChatMessage({ userId: OWNER, chatId: SUP_CHAT.id, content: 'hello' });
    expect(r.queued).toBe(true);
    expect(mockStartDetachedChatRun).toHaveBeenCalled();
    expect(timingRows()).toHaveLength(0);
  });
});

describe('DW-5 fix — transcript-free auth fetch (FO firing 110, 2026-10-10)', () => {
  // Measured root cause (f110 box-A probe): the Fleet Supervisor chat
  // (c0e22e36) holds 16,674 rows / ~263 MB, and every supervisor_send_timing
  // row showed authMs = 95–99% of total (4.1–4.8 s idle, 19–20 s busy) —
  // the send path's getChatById 'write' fetch was taking the LEGACY branch
  // (full transcript + enrichment) for a send that reads only the access
  // gate and scalar chat fields. The fix routes it through the PAGED branch
  // with messageLimit: 0. These tests pin BOTH arms.
  afterEach(() => { jest.clearAllMocks(); });

  it('the send-path auth fetch loads ZERO transcript rows (paged messageLimit:0, take:1 probe row — never the unbounded legacy load)', async () => {
    mockChatAccess(SUP_CHAT);
    const r = await platform.sendChatMessage({ userId: OWNER, chatId: SUP_CHAT.id, content: 'status?' });
    expect(r.queued).toBe(true);
    // The paged branch's findMany carries take: messageLimit + 1 = 1 (the
    // hasMore probe row) — the legacy branch has NO take at all.
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1, where: { chatId: SUP_CHAT.id } }),
    );
  });

  it('the send itself is unchanged: the detached run starts with the same message either way', async () => {
    mockChatAccess(SUP_CHAT);
    const r = await platform.sendChatMessage({ userId: OWNER, chatId: SUP_CHAT.id, content: 'status?', timingSurface: 'fleet' });
    expect(r.queued).toBe(true);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER, chatId: SUP_CHAT.id, message: 'status?' }),
    );
    // The instrument keeps working on the light path (authMs now measures
    // the cheap fetch — the f110 verification probe reads exactly this).
    expect(timingRows()).toHaveLength(1);
  });
});

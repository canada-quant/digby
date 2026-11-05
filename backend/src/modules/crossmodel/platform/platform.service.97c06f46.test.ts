/**
 * Unit pin — ticket 97c06f46, the getChatExistenceTruth half.
 *
 * getChatExistenceTruth (platform.service.ts) is the ADMIN-only existence
 * oracle behind the chatNotFoundRecovery branch pinned in
 * platform-tools.97c06f46.test.ts. It answers the EXISTENCE question the
 * access-scoped 404 cannot: does the chat row exist, and is it archived?
 * Only existence + archivedAt ever leave this function — never an owner id,
 * never a title (an admin may be told THAT a chat exists and is invisible to
 * them, not whose it is).
 *
 * Pinned here against the REAL module. platform.service transitively imports
 * config/env (which process.exit(1)s env-less and kills the jest worker) —
 * the mock scaffold below mirrors platform.service.test.ts's proven header
 * (every transitively env-pulling chain mocked; only prisma is shaped per
 * this suite: getChatExistenceTruth reads user + crossModelChat alone).
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
  activity: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedis = {
  incr: jest.fn(), expire: jest.fn(), decr: jest.fn(), set: jest.fn(), del: jest.fn(),
  scan: jest.fn(async () => ({ cursor: 0, keys: [] as string[] })),
  mGet: jest.fn(async () => [] as Array<string | null>),
  exists: jest.fn(async () => 0),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

jest.mock('../rate-limit.service', () => ({
  __esModule: true,
  getPatienceAutoOnly: jest.fn(async () => false),
  deepResearchAllowance: jest.fn(async () => ({ allowed: true })),
  reserveDeepResearchQuota: jest.fn(async () => ({ allowed: true })),
}));

jest.mock('./lane-depth', () => ({
  __esModule: true,
  routeResearchLane: jest.fn(async (i: any) => ({ mode: i.mode, routing: i.routing, turnPlan: null, route: 'not_governed', why: 'test' })),
}));

// error-handler imports config/env, which calls process.exit(1) without env
// vars and kills the whole jest worker at import time — mock AppError.
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

jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: jest.fn(async () => null),
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

jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: jest.fn(() => true),
  preemptMachineRunForUserMessage: jest.fn(async () => ({ preempted: false, freed: false })),
  nudgeQueueDrainSoon: jest.fn(),
  chatRunKey: (id: string) => `chat:${id}`,
}));

jest.mock('../coding/coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: jest.fn(async () => ({ started: true })),
  steerActiveRun: jest.fn(async () => ({ steered: false, reason: 'no_active_run' })),
}));

jest.mock('../upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(async () => null),
  combineAttachments: jest.fn((atts: any[]) => atts[0]),
}));

jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  depthForChat: jest.fn(async () => 1),
}));

jest.mock('./user-space.service', () => ({
  __esModule: true,
  isUserSpaceProject: jest.fn(() => false),
}));

jest.mock('./project-supervisor.service', () => ({
  __esModule: true,
  ensureProjectSupervisor: jest.fn(async () => null),
}));

jest.mock('../coding/workspace.service', () => ({
  __esModule: true,
  ensureProjectWorkspace: jest.fn(async () => null),
}));

jest.mock('../coding/container.service', () => ({
  __esModule: true,
  getDevContainerInfo: jest.fn(async () => null),
}));

import { getChatExistenceTruth } from './platform.service';

const CHAT = 'eebace78-9ef3-4852-9982-4fd85498d5ec';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getChatExistenceTruth (ticket 97c06f46) — the admin existence oracle', () => {
  it('an ADMIN caller gets the raw existence truth: a LIVE chat exists, not archived', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: CHAT, archivedAt: null });
    const r = await getChatExistenceTruth({ userId: 'sup-f4350445', chatId: CHAT });
    expect(r).toEqual({ exists: true, archivedAt: null });
    // NEVER an owner id or title in the select — only existence + archivedAt.
    expect(mockPrisma.crossModelChat.findUnique).toHaveBeenCalledWith({
      where: { id: CHAT },
      select: { id: true, archivedAt: true },
    });
  });

  it('an ADMIN caller probing an ARCHIVED chat: exists true, archivedAt set (archive ≠ delete)', async () => {
    const at = new Date('2026-10-17T17:55:18.000Z');
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' }); // case-insensitive
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'fbdc568d-0000-0000-0000-000000000000', archivedAt: at });
    const r = await getChatExistenceTruth({ userId: 'sup-f4350445', chatId: 'fbdc568d-0000-0000-0000-000000000000' });
    expect(r).toEqual({ exists: true, archivedAt: at });
  });

  it('an ADMIN caller probing a chat that does not exist: exists false (the only safe "gone")', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    const r = await getChatExistenceTruth({ userId: 'sup-f4350445', chatId: '00000000-0000-0000-0000-000000000000' });
    expect(r).toEqual({ exists: false, archivedAt: null });
  });

  it('a NON-admin caller gets null — the generic no-leak ambiguity survives for everyone else', async () => {
    for (const role of ['USER', 'user', 'member', '']) {
      mockPrisma.user.findUnique.mockResolvedValue(role ? { role } : null);
      const r = await getChatExistenceTruth({ userId: 'plain-user', chatId: CHAT });
      expect(r).toBeNull();
    }
    // and it never even probed the chat row (no existence read for non-admins)
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
  });

  it('fail-closed: a DB error returns null (never a wrong existence answer)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    mockPrisma.crossModelChat.findUnique.mockRejectedValue(new Error('connection reset'));
    const r = await getChatExistenceTruth({ userId: 'sup-f4350445', chatId: CHAT });
    expect(r).toBeNull();
  });
});

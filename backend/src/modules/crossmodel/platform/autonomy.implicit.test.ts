/**
 * Sub-session promotion (2026-09-02, piece 3) — implicitParentAutonomyAllows
 * unit tests against the REAL autonomy.service with mocked Prisma.
 *
 * Security pins (the whole point of the scoped implicit allowance):
 *   - allows ONLY the caller's own FIRST-DEGREE children (live parentChatId);
 *   - refuses non-children, grandchildren (second-degree), user-mismatched
 *     targets, self-targets, and non-listed tools;
 *   - schedule targets resolve by EXACT id + same owner only;
 *   - fails CLOSED on any lookup error.
 *
 * Scaffolding mirrors autonomy.service.test.ts (do not modify that file).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  chatAutonomy: { findUnique: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn(async () => ({ count: 1 })) },
  activity: { create: jest.fn(async () => ({})) },
  // crossModelChat.findMany = the unique ≥8-char own-scoped chat prefix lookup (2026-09-14).
  crossModelChat: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
  // findMany = the unique ≥8-char prefix lookup (gate flip 2026-09-11).
  codingSchedule: { findFirst: jest.fn(), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// error-handler imports config/env, which calls process.exit(1) without env vars.
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

// crossmodel.service pulls the model-integration/env chains — mock the boundary.
const mockGetChatAccess = jest.fn();
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: (...a: any[]) => mockGetChatAccess(...a) },
}));

import { implicitParentAutonomyAllows, PARENT_IMPLICIT_TOOLS, auditAutonomousExecution } from './autonomy.service';

const CALLER = 'parent-chat-1';
const USER = 'u1';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
  mockPrisma.codingSchedule.findFirst.mockResolvedValue(null);
  mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
});

describe('PARENT_IMPLICIT_TOOLS scope', () => {
  it('is exactly the narrow steer/tune set — never spawn/arm/grant tools', () => {
    expect([...PARENT_IMPLICIT_TOOLS]).toEqual(['send_chat_message', 'update_schedule', 'cancel_schedule', 'stop_run', 'answer_chat_question', 'approve_request', 'pause_schedule', 'resume_schedule',
      'set_chat_instructions' /* T3b 2026-09-24: standing rules on a first-degree child — still no spawn/arm/grant */]);
    expect(PARENT_IMPLICIT_TOOLS).not.toContain('start_coding_session');
    expect(PARENT_IMPLICIT_TOOLS).not.toContain('schedule_message');
    expect(PARENT_IMPLICIT_TOOLS).not.toContain('set_chat_autonomy');
  });
});

describe('send_chat_message targets', () => {
  it('ALLOWS a first-degree own child (live parentChatId, same user)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ parentChatId: CALLER, userId: USER });
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'send_chat_message', args: { chatId: 'child-1', content: 'x' },
    })).resolves.toBe(true);
    expect(mockPrisma.crossModelChat.findUnique).toHaveBeenCalledWith({
      where: { id: 'child-1' }, select: { parentChatId: true, userId: true },
    });
  });

  it('ALLOWS a first-degree own child named by its 8-char prefix (owner pending-card incident 2026-09-14)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null); // the prefix is not an exact id
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: 'child-1a-0000-4000-8000-000000000001', parentChatId: CALLER, userId: USER },
    ]);
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'send_chat_message', args: { chatId: 'child-1a', content: 'x' },
    })).resolves.toBe(true);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith({
      where: { userId: USER, id: { startsWith: 'child-1a' } },
      select: { id: true, parentChatId: true, userId: true },
      take: 2,
    });
    // Ambiguous → refuses (fail closed), never a guess.
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: 'child-1a-0000-4000-8000-000000000001', parentChatId: CALLER, userId: USER },
      { id: 'child-1a-0000-4000-8000-000000000002', parentChatId: CALLER, userId: USER },
    ]);
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'send_chat_message', args: { chatId: 'child-1a', content: 'x' },
    })).resolves.toBe(false);
  });

  it('REFUSES a non-child target (parentChatId null)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ parentChatId: null, userId: USER });
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'send_chat_message', args: { chatId: 'stranger', content: 'x' },
    })).resolves.toBe(false);
  });

  it("REFUSES a SECOND-DEGREE target (grandchild — its parent is the child, not the caller)", async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ parentChatId: 'child-1', userId: USER });
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'send_chat_message', args: { chatId: 'grandchild-1', content: 'x' },
    })).resolves.toBe(false);
  });

  it('REFUSES on user mismatch (target chat owned by someone else)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ parentChatId: CALLER, userId: 'other-user' });
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'send_chat_message', args: { chatId: 'child-1', content: 'x' },
    })).resolves.toBe(false);
  });

  it('REFUSES a self-target and an empty target without touching the DB', async () => {
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'send_chat_message', args: { chatId: CALLER, content: 'x' },
    })).resolves.toBe(false);
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'send_chat_message', args: { content: 'x' },
    })).resolves.toBe(false);
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
  });

  it('REFUSES an unknown target chat (findUnique null)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'send_chat_message', args: { chatId: 'gone', content: 'x' },
    })).resolves.toBe(false);
  });
});

describe('schedule targets (update_schedule / cancel_schedule)', () => {
  it("ALLOWS tuning a schedule that lives on the caller's own child", async () => {
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({ sessionId: 'child-1' });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ parentChatId: CALLER, userId: USER });
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'update_schedule', args: { id: 'sch-1', intervalMinutes: 60 },
    })).resolves.toBe(true);
    // Exact id + same owner is tried FIRST (the prefix lookup only runs on a miss).
    expect(mockPrisma.codingSchedule.findFirst).toHaveBeenCalledWith({
      where: { id: 'sch-1', userId: USER }, select: { sessionId: true },
    });
    expect(mockPrisma.codingSchedule.findMany).not.toHaveBeenCalled();
  });

  it("ALLOWS cancelling a schedule on the caller's own child", async () => {
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({ sessionId: 'child-1' });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ parentChatId: CALLER, userId: USER });
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'cancel_schedule', args: { id: 'sch-1' },
    })).resolves.toBe(true);
  });

  it('REFUSES when the schedule does not resolve for this owner (unknown / foreign / short prefix)', async () => {
    mockPrisma.codingSchedule.findFirst.mockResolvedValue(null);
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'cancel_schedule', args: { id: 'sch-pre' }, // 7 chars — below the prefix floor
    })).resolves.toBe(false);
    expect(mockPrisma.codingSchedule.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
  });

  // Gate flip 2026-09-11 (owner: full steam): a UNIQUE ≥8-char owner-scoped
  // prefix — the shape the schedule tools themselves invite — RESOLVES like the
  // full id; an ambiguous prefix still fails closed.
  it("ALLOWS tuning a child's schedule addressed by a UNIQUE ≥8-char prefix", async () => {
    mockPrisma.codingSchedule.findFirst.mockResolvedValue(null); // exact miss
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: '8accf96b-1111-2222-3333-444444444444', sessionId: 'child-1' }]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ parentChatId: CALLER, userId: USER });
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'update_schedule', args: { id: '8accf96b', intervalMinutes: 30 },
    })).resolves.toBe(true);
    expect(mockPrisma.codingSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: USER, id: { startsWith: '8accf96b' } },
    }));
  });

  it('REFUSES an AMBIGUOUS prefix (never widens on a guess)', async () => {
    mockPrisma.codingSchedule.findFirst.mockResolvedValue(null);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([
      { id: '8accf96b-aaaa', sessionId: 'child-1' },
      { id: '8accf96b-bbbb', sessionId: 'child-2' },
    ]);
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'cancel_schedule', args: { id: '8accf96b' },
    })).resolves.toBe(false);
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
  });

  it("REFUSES a schedule on a NON-child chat", async () => {
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({ sessionId: 'stranger-chat' });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ parentChatId: null, userId: USER });
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'update_schedule', args: { id: 'sch-2', prompt: 'p' },
    })).resolves.toBe(false);
  });

  it("REFUSES a schedule on the CALLER's own chat (self)", async () => {
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({ sessionId: CALLER });
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'cancel_schedule', args: { id: 'sch-3' },
    })).resolves.toBe(false);
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
  });
});

describe('scope boundaries + fail-closed', () => {
  it('REFUSES non-listed tools without any DB read', async () => {
    for (const tool of ['schedule_message', 'start_coding_session', 'set_chat_autonomy', 'dispatch_platform_task', 'send_to_instance']) {
      await expect(implicitParentAutonomyAllows({
        callerChatId: CALLER, userId: USER, tool, args: { chatId: 'child-1' },
      })).resolves.toBe(false);
    }
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.findFirst).not.toHaveBeenCalled();
  });

  it('REFUSES on missing caller/user identity', async () => {
    await expect(implicitParentAutonomyAllows({
      callerChatId: '', userId: USER, tool: 'send_chat_message', args: { chatId: 'child-1' },
    })).resolves.toBe(false);
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: '', tool: 'send_chat_message', args: { chatId: 'child-1' },
    })).resolves.toBe(false);
  });

  it('fails CLOSED when the chat lookup throws', async () => {
    mockPrisma.crossModelChat.findUnique.mockRejectedValue(new Error('db down'));
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'send_chat_message', args: { chatId: 'child-1' },
    })).resolves.toBe(false);
  });

  it('fails CLOSED when the schedule lookup throws', async () => {
    mockPrisma.codingSchedule.findFirst.mockRejectedValue(new Error('db down'));
    await expect(implicitParentAutonomyAllows({
      callerChatId: CALLER, userId: USER, tool: 'cancel_schedule', args: { id: 'sch-1' },
    })).resolves.toBe(false);
  });
});

describe('auditAutonomousExecution note (implicit-scope attribution)', () => {
  it('records the caller-supplied note in the Activity metadata', async () => {
    await auditAutonomousExecution({ chatId: CALLER, tool: 'send_chat_message', userId: USER, note: 'implicit parent→child autonomy' });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: {
        userId: USER, action: 'autonomy.execute', resource: 'platform',
        metadata: { chatId: CALLER, tool: 'send_chat_message', note: 'implicit parent→child autonomy' },
      },
    });
  });

  it('keeps the legacy default note when none is supplied', async () => {
    await auditAutonomousExecution({ chatId: CALLER, tool: 'send_chat_message', userId: USER });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: {
        userId: USER, action: 'autonomy.execute', resource: 'platform',
        metadata: { chatId: CALLER, tool: 'send_chat_message', note: 'autonomous execution' },
      },
    });
  });
});

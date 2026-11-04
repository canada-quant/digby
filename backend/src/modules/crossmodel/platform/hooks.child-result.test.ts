/**
 * Sub-session promotion (2026-09-02, piece 2) — ensureChildResultHook unit
 * tests against the REAL hooks.service (mocked Prisma/Redis/boundaries).
 *
 * Pins:
 *   - creation composes subscribeHook (validation/audit/logging untouched)
 *     with the child→parent wiring + the parent-flavored template;
 *   - DEDUPE: any existing child→parent hook of the owner wins (including a
 *     user-narrowed one) — no double-wiring, no second create;
 *   - never-throw contract: every failure path returns null (a hook hiccup
 *     must never fail the spawn that requested it).
 *
 * Scaffolding mirrors hooks.service.test.ts (do not modify that file).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  eventHook: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(async () => ({})),
    delete: jest.fn(async () => ({})),
  },
  hookEvent: {
    create: jest.fn(async () => ({})),
    findMany: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  crossModelChat: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
  crossModelMessage: { create: jest.fn(async () => ({})) },
  activity: { create: jest.fn(async () => ({})) },
  $queryRaw: jest.fn(),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));

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

const mockGetChatAccess = jest.fn();
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: (...a: any[]) => mockGetChatAccess(...a) },
}));

jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: jest.fn(async () => ({ started: true })),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
  notifyDailyCapOnce: jest.fn(async () => {}),
}));

import {
  ensureChildResultHook, CHILD_RESULT_EVENT_TYPES, CHILD_RESULT_PROMPT_TEMPLATE,
} from './hooks.service';
import logger from '../../../utils/logger';

const USER = 'u1';
const PARENT = 'parent-chat-1';
const CHILD = 'child-chat-1';

const createdRow = (over: any = {}) => ({
  id: 'h-new', userId: USER, sourceChatId: CHILD, targetChatId: PARENT,
  eventTypes: [...CHILD_RESULT_EVENT_TYPES], promptTemplate: CHILD_RESULT_PROMPT_TEMPLATE,
  enabled: true, debounceSec: 60, lastFiredAt: null,
  createdAt: new Date('2026-09-02T00:00:00Z'), updatedAt: new Date('2026-09-02T00:00:00Z'),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.eventHook.findFirst.mockResolvedValue(null);
  mockPrisma.eventHook.create.mockImplementation(async ({ data }: any) => createdRow(data));
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
});

describe('ensureChildResultHook — creation', () => {
  it('creates the child→parent hook via the subscribe idiom (events, template, audit)', async () => {
    const view = await ensureChildResultHook({ userId: USER, parentChatId: PARENT, childChatId: CHILD });
    expect(view).not.toBeNull();
    expect(mockPrisma.eventHook.create).toHaveBeenCalledWith({
      data: {
        userId: USER,
        sourceChatId: CHILD,
        targetChatId: PARENT,
        eventTypes: ['run_completed', 'run_failed', 'attention_needed'],
        promptTemplate: CHILD_RESULT_PROMPT_TEMPLATE,
        // Creator provenance (ticket dd3a19fa): system wiring stamps itself.
        createdVia: 'system:child-result-hook',
        createdByChatId: PARENT,
      },
    });
    expect(view!.sourceChatId).toBe(CHILD);
    expect(view!.targetChatId).toBe(PARENT);
    expect(view!.eventTypes).toEqual(['run_completed', 'run_failed', 'attention_needed']);
    // subscribeHook's own audit trail fires (composition, not duplication).
    expect(mockPrisma.activity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'hook.subscribe' }),
    }));
    // Both endpoints were access-checked by subscribeHook (source + target).
    expect(mockGetChatAccess).toHaveBeenCalledWith(CHILD, USER);
    expect(mockGetChatAccess).toHaveBeenCalledWith(PARENT, USER);
  });

  it('CHILD_RESULT_EVENT_TYPES is the terminal/attention set', () => {
    expect(CHILD_RESULT_EVENT_TYPES).toEqual(['run_completed', 'run_failed', 'attention_needed']);
  });
});

describe('ensureChildResultHook — dedupe', () => {
  it('returns the EXISTING child→parent hook without creating a second one', async () => {
    const existing = createdRow({ id: 'h-existing' });
    mockPrisma.eventHook.findFirst.mockResolvedValue(existing);
    const view = await ensureChildResultHook({ userId: USER, parentChatId: PARENT, childChatId: CHILD });
    expect(view!.id).toBe('h-existing');
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.findFirst).toHaveBeenCalledWith({
      where: { userId: USER, sourceChatId: CHILD, targetChatId: PARENT },
    });
  });

  it('a deliberately NARROWED existing hook also wins (user wiring is respected)', async () => {
    mockPrisma.eventHook.findFirst.mockResolvedValue(createdRow({ id: 'h-narrow', eventTypes: ['run_failed'] }));
    const view = await ensureChildResultHook({ userId: USER, parentChatId: PARENT, childChatId: CHILD });
    expect(view!.id).toBe('h-narrow');
    expect(view!.eventTypes).toEqual(['run_failed']);
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
  });
});

describe('ensureChildResultHook — never throws', () => {
  it('returns null (with a warn) when the dedupe lookup throws', async () => {
    mockPrisma.eventHook.findFirst.mockRejectedValue(new Error('db down'));
    await expect(ensureChildResultHook({ userId: USER, parentChatId: PARENT, childChatId: CHILD })).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns null when subscribeHook refuses (access check fails)', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: false });
    await expect(ensureChildResultHook({ userId: USER, parentChatId: PARENT, childChatId: CHILD })).resolves.toBeNull();
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
  });

  it('returns null on degenerate inputs (self-pair / missing ids) without touching the DB', async () => {
    await expect(ensureChildResultHook({ userId: USER, parentChatId: PARENT, childChatId: PARENT })).resolves.toBeNull();
    await expect(ensureChildResultHook({ userId: USER, parentChatId: '', childChatId: CHILD })).resolves.toBeNull();
    await expect(ensureChildResultHook({ userId: '', parentChatId: PARENT, childChatId: CHILD })).resolves.toBeNull();
    expect(mockPrisma.eventHook.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
  });
});

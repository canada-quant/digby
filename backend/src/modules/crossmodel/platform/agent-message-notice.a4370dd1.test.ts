/**
 * Agent-message notification (ticket a4370dd1) — the receiving chat's UI gets
 * a machine notification when another session sends it a message.
 *
 * Pins the two halves of the fix:
 *   1. the module: publishChatListEvent's new 'chat.message' kind carries the
 *      SENDING chat's id + title (same-user fleet — never the content), drops
 *      a MALFORMED sender id, and passes an absent one;
 *   2. the emission seam: platform.service sendChatMessage emits exactly ONE
 *      'chat.message' notice at every accept terminal (coding steer / coding
 *      start / plain started / queued) for an AGENT-origin send — and emits
 *      NOTHING for a human or webhook send (the sender's own UI renders its
 *      own human messages; a webhook's provenance lives upstream).
 *
 * The notice rides the EXISTING per-user channel (6201e0ee) — no new endpoint,
 * no new auth surface — and the unread dot's machine-origin suppression (owner
 * 2026-09-16) is untouched: the dot stays off. The receiving side no longer
 * TOASTS the notice (ticket 9d07fd1f, owner 2026-10-19 quiet front end — the
 * chat row + transcript are the surface), but the server still emits it: the
 * row's updatedAt bump and the minimal-view "Message from <session>" stub both
 * ride this notice through the client's delta refresh.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TARGET = { id: 'chat-target-0001', userId: 'u1', projectId: null, title: 'Target Lane', mode: 'auto', isSupervisor: false, isProjectSupervisor: false, archivedAt: null };
const SOURCE = { title: 'Sender Lane', project: null };

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    // agentSendSource looks the SENDING chat up by id (the target comes from
    // the mocked crossmodel.service.getChatById below).
    crossModelChat: {
      findUnique: jest.fn(async () => ({ ...SOURCE })),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
    },
    // The coding branch's kid guard reads the sender's isChild flag.
    user: { findUnique: jest.fn(async () => ({ isChild: false })) },
    chatCodingState: { findUnique: jest.fn(async () => null) },
    projectMember: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    crossModelProject: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    activity: { create: jest.fn(async () => ({})) },
    loopMetric: { create: jest.fn(async () => ({})) },
  },
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, message: string, public isOperational = true) { super(message); Object.setPrototypeOf(this, AppError.prototype); }
  },
}));

jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: {
    getChatById: jest.fn(async () => ({ ...TARGET })),
  },
}));

// Plain path (no coding satellite): the router never attaches, the coding
// branch is never entered.
jest.mock('../coding/coding-data.service', () => {
  const actual = jest.requireActual('../coding/coding-data.service');
  return {
    ...actual,
    getChatCapability: jest.fn(async () => ({ hasWorkspaceState: false, codeCapable: false })),
    ensureChatWorkspaceState: jest.fn(async () => null),
  };
});

jest.mock('./send-mode', () => {
  const actual = jest.requireActual('./send-mode');
  return {
    ...actual,
    resolveSendMode: jest.fn(async () => ({ mode: 'thinking', routing: undefined, routingSource: undefined, autoRouted: false, autoOnly: false, segment: undefined })),
    demoteForQuota: jest.fn(() => ({ mode: 'thinking', routing: undefined })),
  };
});

const mockIsChatBusy = jest.fn(async (_chatId?: string): Promise<boolean> => false);
jest.mock('../chat-agent/chat-busy', () => ({ __esModule: true, isChatBusy: (...a: any[]) => mockIsChatBusy(...(a as [string])) }));

jest.mock('./hooks.service', () => ({
  __esModule: true,
  depthForChat: jest.fn(async () => 0),
  stampHookDepth: jest.fn(async () => undefined),
  hookBacklogStarving: jest.fn(async () => false),
  drainHookEventsForTarget: jest.fn(() => undefined),
}));

const mockStartDetachedChatRun = jest.fn(async (_args?: any): Promise<boolean> => true);
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...(a as [any])),
  nudgeQueueDrainSoon: jest.fn(() => undefined),
}));

// The coding branch's two accept terminals (steer + fresh start) — mocked so
// the coding-surface test drives them deterministically.
const mockSteerActiveRun = jest.fn(async (_args?: any): Promise<{ steered: boolean }> => ({ steered: false }));
const mockStartScheduledRun = jest.fn(async (_args?: any): Promise<{ started: boolean }> => ({ started: true }));
jest.mock('../coding/coding-stream.controller', () => ({
  __esModule: true,
  steerActiveRun: (...a: any[]) => mockSteerActiveRun(...(a as [any])),
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...(a as [any])),
}));

const mockEnqueueChatMessage = jest.fn(async (_args?: any): Promise<{ position: number; coalesced: boolean }> => ({ position: 1, coalesced: false }));
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  enqueueChatMessage: (...a: any[]) => mockEnqueueChatMessage(...(a as [any])),
}));

/** Captures every redis publish (the cross-box leg) for the module half. */
const redisPublished: Array<{ channel: string; message: string }> = [];
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    publish: jest.fn(async (channel: string, message: string) => { redisPublished.push({ channel, message }); return 1; }),
    duplicate: () => ({
      connect: async () => undefined,
      on: () => undefined,
      subscribe: async () => undefined,
      quit: async () => undefined,
    }),
  },
}));

// Call-through recorder over the seam platform.service calls.
const emitted: Array<Record<string, any>> = [];
jest.mock('./chat-events', () => {
  const actual = jest.requireActual('./chat-events');
  return {
    ...actual,
    publishChatListEvent: (userId: string, event: Record<string, any>) => {
      emitted.push({ userId, ...event });
      return actual.publishChatListEvent(userId, event);
    },
  };
});

import { publishChatListEvent, __resetChatEventsForTest } from './chat-events';
import * as platformService from './platform.service';

const AGENT_ORIGIN = { kind: 'agent' as const, sourceChatId: 'chat-source-0001' };

beforeEach(() => {
  emitted.length = 0;
  redisPublished.length = 0;
  __resetChatEventsForTest();
  mockStartDetachedChatRun.mockClear();
  mockEnqueueChatMessage.mockClear();
  mockStartDetachedChatRun.mockResolvedValue(true);
  mockEnqueueChatMessage.mockResolvedValue({ position: 1, coalesced: false });
  mockIsChatBusy.mockResolvedValue(false);
});

// ── Module half: the wire shape ───────────────────────────────────────────────

describe('chat.message notice — module shape (a4370dd1)', () => {
  it('carries the sender id + title and never the content', () => {
    const got: any[] = [];
    const { subscribeChatEvents } = jest.requireActual('./chat-events') as typeof import('./chat-events');
    const unsub = subscribeChatEvents('u1', (e) => got.push(e));
    publishChatListEvent('u1', { kind: 'chat.message', chatId: TARGET.id, sourceChatId: 'chat-source-0001', sourceTitle: 'Sender Lane' } as any);
    unsub();
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe('chat.message');
    expect(got[0].chatId).toBe(TARGET.id);
    expect(got[0].sourceChatId).toBe('chat-source-0001');
    expect(got[0].sourceTitle).toBe('Sender Lane');
    expect(got[0].at).toBeTruthy();
  });

  it('rides the cross-box redis leg with the sender fields in the envelope', async () => {
    publishChatListEvent('u1', { kind: 'chat.message', chatId: TARGET.id, sourceChatId: 'chat-source-0001', sourceTitle: 'Sender Lane' } as any);
    await new Promise((r) => setImmediate(r));
    const row = redisPublished.find((p) => p.channel === 'digby:chat-events');
    expect(row).toBeTruthy();
    const env = JSON.parse(row!.message);
    expect(env.userId).toBe('u1');
    expect(env.event.kind).toBe('chat.message');
    expect(env.event.sourceChatId).toBe('chat-source-0001');
    expect(env.event.sourceTitle).toBe('Sender Lane');
  });

  it('drops a MALFORMED sender id but passes an ABSENT one (a re-added arrival surface has a generic fallback)', () => {
    const got: any[] = [];
    const { subscribeChatEvents } = jest.requireActual('./chat-events') as typeof import('./chat-events');
    const unsub = subscribeChatEvents('u1', (e) => got.push(e));
    publishChatListEvent('u1', { kind: 'chat.message', chatId: TARGET.id, sourceChatId: 'bad id!' } as any);
    expect(got).toHaveLength(0);
    publishChatListEvent('u1', { kind: 'chat.message', chatId: TARGET.id } as any);
    expect(got).toHaveLength(1);
    expect(got[0].sourceChatId).toBeUndefined();
    unsub();
  });

  });

// ── Emission seam: sendChatMessage terminals ─────────────────────────────────

describe('sendChatMessage emits the agent-message notice (a4370dd1)', () => {
  it('plain IDLE target: accepted+started → ONE chat.message naming the sender', async () => {
    const res = await platformService.sendChatMessage({ userId: 'u1', chatId: TARGET.id, content: 'status update from the fleet', origin: AGENT_ORIGIN });
    expect(res.queued).toBe(true);
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([
      { userId: 'u1', kind: 'chat.message', chatId: TARGET.id, sourceChatId: 'chat-source-0001', sourceTitle: 'Sender Lane' },
    ]);
  });

  it('plain BUSY target: queued → still exactly ONE chat.message (the owner sees it land even queued)', async () => {
    mockIsChatBusy.mockResolvedValue(true);
    const res = await platformService.sendChatMessage({ userId: 'u1', chatId: TARGET.id, content: 'nudge while busy', origin: AGENT_ORIGIN });
    expect(res.queued).toBe(true);
    expect(mockEnqueueChatMessage).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([
      { userId: 'u1', kind: 'chat.message', chatId: TARGET.id, sourceChatId: 'chat-source-0001', sourceTitle: 'Sender Lane' },
    ]);
  });

  it('HUMAN send (no origin): no notice — the dot + optimistic render already cover it', async () => {
    await platformService.sendChatMessage({ userId: 'u1', chatId: TARGET.id, content: 'a human turn' });
    expect(emitted).toEqual([]);
  });

  it('WEBHOOK send: no chat.message notice (provenance lives upstream; out of a4370dd1 scope)', async () => {
    await platformService.sendChatMessage({ userId: 'u1', chatId: TARGET.id, content: 'external alert', origin: { kind: 'webhook' } });
    expect(emitted).toEqual([]);
  });

  it('the notice targets the chat OWNER (a member-shared lane send notifies the owner, not the sending member)', async () => {
    // Target owned by u-owner, the SENDING run acts as u-member (shared project).
    const crossModelService = (await import('../crossmodel.service')).default;
    (crossModelService.getChatById as jest.Mock).mockResolvedValueOnce({ ...TARGET, userId: 'u-owner' });
    await platformService.sendChatMessage({ userId: 'u-member', chatId: TARGET.id, content: 'peer relay', origin: AGENT_ORIGIN });
    expect(emitted).toEqual([
      { userId: 'u-owner', kind: 'chat.message', chatId: TARGET.id, sourceChatId: 'chat-source-0001' },
    ]);
  });

  it('title containment (review a4370dd1-8): a CROSS-OWNER send withholds the sender title; a same-user send carries it', async () => {
    // Same-user fleet: the recipient IS the acting user — the title rides.
    await platformService.sendChatMessage({ userId: 'u1', chatId: TARGET.id, content: 'same user', origin: AGENT_ORIGIN });
    expect(emitted[emitted.length - 1]).toMatchObject({ sourceTitle: 'Sender Lane' });
    // Cross-owner: a member's send into another owner's chat — no title.
    const crossModelService = (await import('../crossmodel.service')).default;
    (crossModelService.getChatById as jest.Mock).mockResolvedValueOnce({ ...TARGET, userId: 'u-owner' });
    await platformService.sendChatMessage({ userId: 'u-member', chatId: TARGET.id, content: 'cross owner', origin: AGENT_ORIGIN });
    expect(emitted[emitted.length - 1]).not.toHaveProperty('sourceTitle');
  });

  it('coding surface: a steer into an ACTIVE run emits ONE notice; a fresh coding run start emits ONE notice', async () => {
    // Flip the router to the coding surface for this test only (the satellite
    // exists → the coding branch runs; coding-stream.controller is mocked so
    // steerActiveRun / startScheduledRun report acceptance deterministically).
    const { getChatCapability } = await import('../coding/coding-data.service');
    const capabilityMock = getChatCapability as jest.Mock;
    capabilityMock.mockResolvedValue({ hasWorkspaceState: true, codeCapable: true });
    const steerMock = mockSteerActiveRun;
    const startMock = mockStartScheduledRun;
    const before = emitted.filter((e) => e.kind === 'chat.message').length;
    try {
      // LEG 1 — busy coding session: steerActiveRun accepts → steer terminal.
      steerMock.mockResolvedValueOnce({ steered: true });
      const steerRes = await platformService.sendChatMessage({ userId: 'u1', chatId: TARGET.id, content: 'steer me', origin: AGENT_ORIGIN });
      expect(steerRes.delivery).toBe('steer');
      expect(steerMock).toHaveBeenCalledTimes(1);
      expect(emitted[emitted.length - 1]).toMatchObject({ kind: 'chat.message', chatId: TARGET.id, sourceChatId: 'chat-source-0001' });
      // LEG 2 — idle coding session: startScheduledRun accepts → started terminal.
      steerMock.mockResolvedValueOnce({ steered: false });
      startMock.mockResolvedValueOnce({ started: true });
      const startRes = await platformService.sendChatMessage({ userId: 'u1', chatId: TARGET.id, content: 'start me', origin: AGENT_ORIGIN });
      expect(startRes.queued).toBe(true);
      expect(startMock).toHaveBeenCalledTimes(1);
      expect(emitted[emitted.length - 1]).toMatchObject({ kind: 'chat.message', chatId: TARGET.id, sourceChatId: 'chat-source-0001' });
      // Exactly TWO notices across both legs — no doubles, no misses.
      expect(emitted.filter((e) => e.kind === 'chat.message')).toHaveLength(before + 2);
    } finally {
      capabilityMock.mockResolvedValue({ hasWorkspaceState: false, codeCapable: false });
    }
  });

  it('a REFUSED send (archived target) emits nothing — refusals are not deliveries', async () => {
    const crossModelService = (await import('../crossmodel.service')).default;
    (crossModelService.getChatById as jest.Mock).mockResolvedValueOnce({ ...TARGET, archivedAt: new Date() });
    await expect(platformService.sendChatMessage({ userId: 'u1', chatId: TARGET.id, content: 'revive attempt', origin: AGENT_ORIGIN }))
      .rejects.toThrow(/ARCHIVED/i);
    expect(emitted).toEqual([]);
  });
});

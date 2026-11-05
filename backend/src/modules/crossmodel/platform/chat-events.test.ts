/**
 * Chat-list events (ticket 6201e0ee) — the sidebar push channel.
 *
 * Pins the three halves of the channel:
 *   1. the module: per-user in-process fan-out, kill switch, malformed-id
 *      drop, cross-box envelope (Redis publish) — never double-delivering
 *      the publishing box's own echo;
 *   2. the emission seams: platform.service's chat mutations call
 *      publishChatListEvent (create/rename/move/archive/restore/session
 *      spawn/delete) with the right kind — mocked prisma, real service
 *      functions;
 *   3. the SSE endpoint's HTTP contract (401 anonymous, ?token= auth, ready
 *      frame, pushed notice, user isolation, disabled-terminal) lives in
 *      chat-events.endpoint.test.ts; route-posture.test.ts pins the router's
 *      open-route posture class (not a route enumeration of this endpoint).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** Captures every redis publish + the subscribe the bridge performs. */
const redisState = {
  published: [] as Array<{ channel: string; message: string }>,
  subscribers: [] as Array<(message: string) => void>,
};
const redisPublish = jest.fn(async (channel: string, message: string) => {
  redisState.published.push({ channel, message });
  return 1;
});
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    publish: (...a: any[]) => redisPublish(...(a as [string, string])),
    duplicate: () => ({
      connect: async () => undefined,
      on: () => undefined,
      subscribe: async (_c: string, listener: (m: string) => void) => { redisState.subscribers.push(listener); },
      quit: async () => undefined,
    }),
  },
}));

// ── Module half ───────────────────────────────────────────────────────────────

import {
  CHAT_EVENTS_CHANNEL,
  publishChatListEvent,
  subscribeChatEvents,
  __resetChatEventsForTest,
} from './chat-events';

beforeEach(() => {
  __resetChatEventsForTest();
  redisState.published.length = 0;
  redisState.subscribers.length = 0;
});

describe('chat-events module — per-user fan-out', () => {
  it('delivers a notice only to the same user\'s subscribers', () => {
    const got: string[] = [];
    const other: string[] = [];
    subscribeChatEvents('u1', (e) => got.push(e.kind));
    subscribeChatEvents('u2', (e) => other.push(e.kind));
    publishChatListEvent('u1', { kind: 'chat.archived', chatId: 'chat-0001' });
    expect(got).toEqual(['chat.archived']);
    expect(other).toEqual([]);
  });

  it('unsubscribes cleanly (no delivery after the unsubscribe fn runs)', () => {
    const got: string[] = [];
    const unsub = subscribeChatEvents('u1', (e) => got.push(e.kind));
    unsub();
    publishChatListEvent('u1', { kind: 'chat.renamed', chatId: 'chat-0001' });
    expect(got).toEqual([]);
  });

  it('drops malformed chat ids instead of publishing them', async () => {
    const got: string[] = [];
    subscribeChatEvents('u1', (e) => got.push(e.kind));
    publishChatListEvent('u1', { kind: 'chat.renamed', chatId: '' });
    publishChatListEvent('u1', { kind: 'chat.renamed', chatId: 'x' });
    publishChatListEvent('u1', { kind: 'chat.renamed', chatId: 'bad id!; DROP' });
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual([]);
    expect(redisState.published).toEqual([]);
  });

  it('publishes the cross-box envelope on the shared channel', async () => {
    publishChatListEvent('u1', { kind: 'chat.created', chatId: 'chat-0001-aaaa' });
    await new Promise((r) => setImmediate(r));
    expect(redisState.published.length).toBe(1);
    const { channel, message } = redisState.published[0];
    expect(channel).toBe(CHAT_EVENTS_CHANNEL);
    const env = JSON.parse(message);
    expect(env.userId).toBe('u1');
    expect(env.event.kind).toBe('chat.created');
    expect(env.event.chatId).toBe('chat-0001-aaaa');
    expect(typeof env.event.at).toBe('string');
    expect(typeof env.sender).toBe('string'); // per-process echo guard
  });

  it('the bridge re-delivers OTHER boxes\' messages but skips its own echo', async () => {
    // Subscribe once → the bridge connects and registers its listener.
    const got: string[] = [];
    subscribeChatEvents('u1', (e) => got.push(e.kind));
    await new Promise((r) => setImmediate(r));
    expect(redisState.subscribers.length).toBe(1);
    const bridge = redisState.subscribers[0];

    // Another box's envelope → delivered locally.
    bridge(JSON.stringify({ sender: 'other-box', userId: 'u1', event: { kind: 'chat.moved', chatId: 'chat-0001', at: new Date().toISOString() } }));
    expect(got).toEqual(['chat.moved']);

    // THIS box's own echo (same sender as publish) → skipped.
    const own = await (async () => {
      publishChatListEvent('u1', { kind: 'chat.renamed', chatId: 'chat-0001' });
      await new Promise((r) => setImmediate(r));
      return redisState.published[redisState.published.length - 1];
    })();
    const before = got.length;
    bridge(own.message);
    expect(got.length).toBe(before); // no second delivery
  });
});

// ── Emission seams: the platform.service mutations call the publisher ────────

jest.mock('../../../config/database', () => {
  const chatRow = { id: 'chat-0001-aaaa', userId: 'u1', projectId: null, title: 'T', isSupervisor: false, isProjectSupervisor: false };
  return {
    __esModule: true,
    default: {
      crossModelChat: {
        findUnique: jest.fn(async () => ({ ...chatRow, archivedAt: null })),
        update: jest.fn(async () => chatRow),
        create: jest.fn(async () => chatRow),
      },
      chatCodingState: {
        findUnique: jest.fn(async () => null),
        update: jest.fn(async () => ({})),
      },
      chatSchedule: { count: jest.fn(async () => 0) },
      activity: { create: jest.fn(async () => ({})) },
      projectMember: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
      crossModelProject: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    },
  };
});
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); Object.setPrototypeOf(this, AppError.prototype); }
  },
}));

const emitted: Array<{ userId: string; kind: string; chatId: string }> = [];
jest.mock('./chat-events', () => {
  const actual = jest.requireActual('./chat-events');
  return {
    ...actual,
    // Call-through recorder: the module-half tests above exercise REAL
    // delivery; the seam tests below only assert what was emitted.
    publishChatListEvent: (userId: string, event: { kind: string; chatId: string }) => {
      emitted.push({ userId, kind: event.kind, chatId: event.chatId });
      return actual.publishChatListEvent(userId, event);
    },
  };
});

import * as platformService from './platform.service';
import crossModelService from '../crossmodel.service';
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: {
    createChat: jest.fn(async () => ({ id: 'chat-0001-aaaa', title: 'T' })),
    updateChat: jest.fn(async () => ({ id: 'chat-0001-aaaa', title: 'T' })),
    deleteChat: jest.fn(async () => ({})),
    getChatAccess: jest.fn(async () => ({ access: 'owner', exists: true })),
  },
}));

describe('platform.service mutations emit chat-list events (6201e0ee)', () => {
  beforeEach(() => { emitted.length = 0; });

  it('createChat emits chat.created for the creating user', async () => {
    await platformService.createChat({ userId: 'u1', title: 'New chat' });
    expect(emitted).toEqual([{ userId: 'u1', kind: 'chat.created', chatId: 'chat-0001-aaaa' }]);
  });

  it('renameChat emits chat.renamed', async () => {
    await platformService.renameChat({ userId: 'u1', chatId: 'chat-0001-aaaa', title: 'Renamed' });
    expect(emitted).toEqual([{ userId: 'u1', kind: 'chat.renamed', chatId: 'chat-0001-aaaa' }]);
  });

  it('moveChat emits chat.moved', async () => {
    await platformService.moveChat({ userId: 'u1', chatId: 'chat-0001-aaaa', projectId: null });
    expect(emitted).toEqual([{ userId: 'u1', kind: 'chat.moved', chatId: 'chat-0001-aaaa' }]);
  });

  it('deleteChat emits chat.deleted (review N5 — a deleted row never returns in any delta response)', async () => {
    await platformService.deleteChat({ userId: 'u1', chatId: 'chat-0001-aaaa' });
    expect(emitted).toEqual([{ userId: 'u1', kind: 'chat.deleted', chatId: 'chat-0001-aaaa' }]);
  });

  it('archiveChat emits chat.archived (archive) and chat.restored (restore)', async () => {
    await platformService.archiveChat({ userId: 'u1', chatId: 'chat-0001-aaaa', archived: true });
    expect(emitted).toEqual([{ userId: 'u1', kind: 'chat.archived', chatId: 'chat-0001-aaaa' }]);
    emitted.length = 0;
    await platformService.archiveChat({ userId: 'u1', chatId: 'chat-0001-aaaa', archived: false });
    expect(emitted).toEqual([{ userId: 'u1', kind: 'chat.restored', chatId: 'chat-0001-aaaa' }]);
  });

  it('archiveChat REFUSES (no emission) a supervisor chat', async () => {
    const db = require('../../../config/database').default;
    (db.crossModelChat.findUnique as jest.Mock).mockResolvedValueOnce({ ...{ id: 'chat-0001-aaaa', userId: 'u1', projectId: null, title: 'T', isSupervisor: true, isProjectSupervisor: false } });
    await expect(platformService.archiveChat({ userId: 'u1', chatId: 'chat-0001-aaaa', archived: true })).rejects.toThrow(/cannot be archived/i);
    expect(emitted).toEqual([]);
  });
});

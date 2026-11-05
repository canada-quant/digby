/**
 * Queue CONTROLS (ticket ea04454c) — chat-agent/queue-controls: list / cancel /
 * promote / reorder the caller's own USER rows in a busy chat's queue.
 *
 * The regression these pins exist for: before this module the owner's only
 * options while a run was active were "wait" or "Stop everything" — a queued
 * message had no visible position and no per-message controls at all. The
 * tests below pin the CONTROL PLANE, and in particular that ORDER IS THE
 * DRAIN'S ORDER: promote/move rewrite createdAt so that peekOldest (the real
 * delivery order) genuinely reads the moved row next, rather than maintaining a
 * second, parallel notion of position that the drain would ignore.
 *
 * prisma is an in-memory pending_chat_messages table (same idiom as
 * message-queue.test.ts); redis is never reached by this module.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

interface Row {
  id: string;
  chatId: string;
  userId: string;
  content: string;
  mode: string | null;
  source: string;
  createdAt: Date;
  uploadIds?: string[] | null;
}

const rows: Row[] = [];
let seq = 0;

/** Minimal prisma surface queue-controls uses. `where` handling is explicit
 *  (not a generic matcher) so a wrong filter shows up as a failing assertion
 *  instead of silently passing. */
const matchWhere = (r: Row, where: any): boolean => {
  if (!where) return true;
  if (where.id !== undefined) {
    if (typeof where.id === 'string') {
      if (r.id !== where.id) return false;
    } else if (where.id && typeof where.id === 'object') {
      if (Array.isArray(where.id.in) && !where.id.in.includes(r.id)) return false;
      if (where.id.not && r.id === where.id.not) return false;
    }
  }
  if (where.chatId !== undefined && r.chatId !== where.chatId) return false;
  if (where.userId !== undefined && r.userId !== where.userId) return false;
  if (where.source !== undefined) {
    const want = where.source;
    if (typeof want === 'string' && r.source !== want) return false;
  }
  return true;
};

const sortRows = (list: Row[], orderBy: any): Row[] => {
  const keys = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [{ createdAt: 'asc' }, { id: 'asc' }];
  return [...list].sort((a, b) => {
    for (const k of keys) {
      if (k.createdAt) {
        const d = a.createdAt.getTime() - b.createdAt.getTime();
        if (d !== 0) return k.createdAt === 'desc' ? -d : d;
      }
      if (k.id) {
        const d = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        if (d !== 0) return k.id === 'desc' ? -d : d;
      }
    }
    return 0;
  });
};

// error-handler imports config/env, which calls process.exit(1) without env
// vars and kills the whole jest worker at import time — mock AppError (same
// shape). message-queue.service (imported here for the REAL peekOldest) throws
// it for the queue-full 409.
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

// message-queue.service's origin stash rides config/redis (whose chain reaches
// config/env → process.exit at import) — map-backed mock with honest get/set/del.
const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { redisStore.set(k, String(v)); return 'OK'; }),
    del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
    exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
    expire: jest.fn(async () => 1),
  },
}));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingChatMessage: {
      findMany: jest.fn(async ({ where, orderBy }: any) => sortRows(rows.filter(r => matchWhere(r, where)), orderBy)),
      findFirst: jest.fn(async ({ where, orderBy }: any) => sortRows(rows.filter(r => matchWhere(r, where)), orderBy ?? [{ createdAt: 'asc' }, { id: 'asc' }])[0] ?? null),
      delete: jest.fn(async ({ where }: any) => {
        const i = rows.findIndex(r => r.id === where.id);
        if (i < 0) throw new Error('record not found');
        return rows.splice(i, 1)[0];
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = rows.find(x => x.id === where.id);
        if (!r) throw new Error('record not found');
        Object.assign(r, data);
        return r;
      }),
      count: jest.fn(async ({ where }: any) => rows.filter(r => matchWhere(r, where)).length),
    },
  },
}));

import {
  listUserQueue,
  cancelQueuedUserMessage,
  promoteQueuedUserMessage,
  moveQueuedUserMessage,
  ORDER_EPSILON_MS,
} from './queue-controls';
// The REAL drain selection — the whole point of re-stamping createdAt.
import { peekOldest } from './message-queue.service';

const CHAT = 'chat-1';
const USER = 'user-1';
const OTHER_CHAT = 'chat-2';

const seed = (args: { id: string; content?: string; source?: string; userId?: string; chatId?: string; at: number; uploads?: string[] }) => {
  rows.push({
    id: args.id,
    chatId: args.chatId ?? CHAT,
    userId: args.userId ?? USER,
    content: args.content ?? `msg ${args.id}`,
    mode: null,
    source: args.source ?? 'user',
    createdAt: new Date(1_700_000_000_000 + args.at),
    uploadIds: args.uploads ?? null,
  });
  seq += 1;
};

beforeEach(() => {
  rows.length = 0;
  seq = 0;
});

describe('listUserQueue (ea04454c)', () => {
  it('returns the caller\'s USER rows in drain order with 1-based positions', async () => {
    seed({ id: 'b', at: 2000 });
    seed({ id: 'a', at: 1000 });
    seed({ id: 'c', at: 3000 });
    const q = await listUserQueue(CHAT, USER);
    expect(q.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(q.map(r => r.position)).toEqual([1, 2, 3]);
    expect(q[0].content).toBe('msg a');
  });

  it('never lists machine relay rows (agent/webhook/schedule share the table)', async () => {
    seed({ id: 'u1', at: 1000 });
    seed({ id: 'a1', at: 2000, source: 'agent' });
    seed({ id: 'w1', at: 3000, source: 'webhook' });
    seed({ id: 's1', at: 4000, source: 'schedule' });
    const q = await listUserQueue(CHAT, USER);
    expect(q.map(r => r.id)).toEqual(['u1']);
  });

  it('never lists another person\'s rows on a shared chat', async () => {
    seed({ id: 'mine', at: 1000 });
    seed({ id: 'theirs', at: 2000, userId: 'user-2' });
    const q = await listUserQueue(CHAT, USER);
    expect(q.map(r => r.id)).toEqual(['mine']);
  });

  it('carries the attachment COUNT (the UI shows a paperclip, not the ids)', async () => {
    seed({ id: 'with-files', at: 1000, uploads: ['up-1', 'up-2'] });
    seed({ id: 'no-files', at: 2000 });
    const q = await listUserQueue(CHAT, USER);
    expect(q[0].attachmentCount).toBe(2);
    expect(q[1].attachmentCount).toBe(0);
  });

  it('is empty for an idle chat', async () => {
    await expect(listUserQueue(CHAT, USER)).resolves.toEqual([]);
  });
});

describe('cancelQueuedUserMessage (ea04454c)', () => {
  it('removes the row and returns the fresh queue', async () => {
    seed({ id: 'a', at: 1000 });
    seed({ id: 'b', at: 2000 });
    const res = await cancelQueuedUserMessage(CHAT, USER, 'a');
    expect(res.ok).toBe(true);
    expect(res.queue.map(r => r.id)).toEqual(['b']);
    expect(rows.map(r => r.id)).toEqual(['b']);
  });

  it('404s a row from ANOTHER chat (a stale id must never touch this queue)', async () => {
    seed({ id: 'elsewhere', at: 1000, chatId: OTHER_CHAT });
    const res = await cancelQueuedUserMessage(CHAT, USER, 'elsewhere');
    expect(res.ok).toBe(false);
    expect(res.refusal).toBe('not_found');
    expect(rows.map(r => r.id)).toEqual(['elsewhere']);
  });

  it('refuses a MACHINE row with a distinct reason (never a silent "not found")', async () => {
    seed({ id: 'agent-row', at: 1000, source: 'agent' });
    const res = await cancelQueuedUserMessage(CHAT, USER, 'agent-row');
    expect(res.ok).toBe(false);
    expect(res.refusal).toBe('not_a_user_row');
    expect(rows).toHaveLength(1);
  });

  it('refuses another person\'s user row', async () => {
    seed({ id: 'theirs', at: 1000, userId: 'user-2' });
    const res = await cancelQueuedUserMessage(CHAT, USER, 'theirs');
    expect(res.ok).toBe(false);
    expect(res.refusal).toBe('not_owned');
    expect(rows).toHaveLength(1);
  });

  it('a second cancel of the same id reports not_found (the row is genuinely gone)', async () => {
    seed({ id: 'a', at: 1000 });
    expect((await cancelQueuedUserMessage(CHAT, USER, 'a')).ok).toBe(true);
    const again = await cancelQueuedUserMessage(CHAT, USER, 'a');
    expect(again.ok).toBe(false);
    expect(again.refusal).toBe('not_found');
  });
});

describe('promoteQueuedUserMessage (ea04454c) — promote must move the DRAIN', () => {
  it('makes the promoted row the next one peekOldest delivers', async () => {
    seed({ id: 'a', at: 1000 });
    seed({ id: 'b', at: 2000 });
    seed({ id: 'c', at: 3000 });
    expect((await peekOldest(CHAT))?.id).toBe('a');
    const res = await promoteQueuedUserMessage(CHAT, USER, 'c');
    expect(res.ok).toBe(true);
    expect(res.queue.map(r => r.id)).toEqual(['c', 'a', 'b']);
    // The REAL delivery order agrees — this is the assertion that would fail
    // if promote only reordered a parallel position field.
    expect((await peekOldest(CHAT))?.id).toBe('c');
  });

  it('is a no-op when the row is already at the head', async () => {
    seed({ id: 'a', at: 1000 });
    seed({ id: 'b', at: 2000 });
    const before = rows.find(r => r.id === 'a')!.createdAt.getTime();
    const res = await promoteQueuedUserMessage(CHAT, USER, 'a');
    expect(res.ok).toBe(true);
    expect(res.queue.map(r => r.id)).toEqual(['a', 'b']);
    expect(rows.find(r => r.id === 'a')!.createdAt.getTime()).toBe(before);
  });

  it('a lone queued row promotes to itself without moving', async () => {
    seed({ id: 'only', at: 1000 });
    const res = await promoteQueuedUserMessage(CHAT, USER, 'only');
    expect(res.ok).toBe(true);
    expect(res.queue.map(r => r.id)).toEqual(['only']);
  });

  it('never stamps a temp row above a machine row it must not jump (USER class only)', async () => {
    // Machine rows live in the same table but never appear in this list; the
    // promote must still not pull a machine row out of order for the drain's
    // second class. The user row moves only within the user class.
    seed({ id: 'agent-old', at: 500, source: 'agent' });
    seed({ id: 'u1', at: 1000 });
    seed({ id: 'u2', at: 2000 });
    await promoteQueuedUserMessage(CHAT, USER, 'u2');
    expect((await peekOldest(CHAT))?.id).toBe('u2'); // user class still wins the drain
    expect(rows.find(r => r.id === 'agent-old')!.createdAt.getTime()).toBe(1_700_000_000_500);
  });
});

describe('moveQueuedUserMessage (ea04454c)', () => {
  const order = () => sortRows(rows.filter(r => r.chatId === CHAT), [{ createdAt: 'asc' }, { id: 'asc' }]).map(r => r.id);

  it('moves a row up one slot and the drain follows', async () => {
    seed({ id: 'a', at: 1000 });
    seed({ id: 'b', at: 2000 });
    seed({ id: 'c', at: 3000 });
    const res = await moveQueuedUserMessage(CHAT, USER, 'b', 'up');
    expect(res.ok).toBe(true);
    expect(order()).toEqual(['b', 'a', 'c']);
    expect((await peekOldest(CHAT))?.id).toBe('b');
  });

  it('moves a row down one slot', async () => {
    seed({ id: 'a', at: 1000 });
    seed({ id: 'b', at: 2000 });
    seed({ id: 'c', at: 3000 });
    const res = await moveQueuedUserMessage(CHAT, USER, 'a', 'down');
    expect(res.ok).toBe(true);
    expect(order()).toEqual(['b', 'a', 'c']);
  });

  it('moving the head up / the tail down is a successful no-op', async () => {
    seed({ id: 'a', at: 1000 });
    seed({ id: 'b', at: 2000 });
    expect((await moveQueuedUserMessage(CHAT, USER, 'a', 'up')).ok).toBe(true);
    expect((await moveQueuedUserMessage(CHAT, USER, 'b', 'down')).ok).toBe(true);
    expect(order()).toEqual(['a', 'b']);
  });

  it('two moves compose into the typed order (promote-by-repeated-up)', async () => {
    seed({ id: 'a', at: 1000 });
    seed({ id: 'b', at: 2000 });
    seed({ id: 'c', at: 3000 });
    await moveQueuedUserMessage(CHAT, USER, 'c', 'up');
    await moveQueuedUserMessage(CHAT, USER, 'c', 'up');
    expect(order()).toEqual(['c', 'a', 'b']);
    expect((await peekOldest(CHAT))?.id).toBe('c');
  });

  it('never stamps a row into the future (an owner clock skew cannot pin a row above the finishing run)', async () => {
    const future = Date.now() + 60_000;
    seed({ id: 'a', at: 1000 });
    rows.push({ id: 'b', chatId: CHAT, userId: USER, content: 'msg b', mode: null, source: 'user', createdAt: new Date(future), uploadIds: null });
    await moveQueuedUserMessage(CHAT, USER, 'a', 'down');
    expect(rows.find(r => r.id === 'a')!.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('keeps adjacent rows epsilon-separated so the order is stable (no createdAt collision)', async () => {
    seed({ id: 'a', at: 1000 });
    seed({ id: 'b', at: 2000 });
    await moveQueuedUserMessage(CHAT, USER, 'b', 'up');
    const a = rows.find(r => r.id === 'a')!.createdAt.getTime();
    const b = rows.find(r => r.id === 'b')!.createdAt.getTime();
    expect(b).toBeLessThan(a);
    expect(a - b).toBe(ORDER_EPSILON_MS);
  });

  it('refuses a row that is not the caller\'s', async () => {
    seed({ id: 'theirs', at: 1000, userId: 'user-2' });
    const res = await moveQueuedUserMessage(CHAT, USER, 'theirs', 'up');
    expect(res.ok).toBe(false);
    expect(res.refusal).toBe('not_owned');
  });
});
/**
 * MERGE-1 leg (d) — THE TWO-COLOUR BLUE-GREEN MESSAGE-INTEGRITY REPLAY.
 *
 * WHY THIS FILE EXISTS. The Cluster 8 matrix could not verify the blue-green
 * leg of MERGE-1: the production no-loss sample was VACUOUS (0
 * pending_chat_messages rows in 30 d — the busy-chat queue never engaged, so
 * nothing was tested) and there is no stored PER-COLOUR message ledger to diff.
 * The missing signal was named rather than hand-waved: no ledger => replay it
 * synthetically. This file is that replay.
 *
 * WHAT A "COLOUR" IS HERE. Blue and green run the SAME code over ONE shared
 * Postgres and ONE shared Redis (both colours talk to the same DB/redis; the
 * ALB has no stickiness — see chat-busy.ts module doc). So a colour is not a
 * separate codebase: it is a TIMELINE plus its own PROCESS-LOCAL run registry.
 * The two things that genuinely differ per colour are modelled as such:
 *   · the local live-run registry is PER COLOUR (real: live-runs.ts is a
 *     module-scope Map, process-local by design);
 *   · the durable queue row and the Redis liveness key are SHARED.
 *
 * WHAT IS REAL vs MODELLED. The cross-colour START GATE is the real
 * `claimChatLiveRun` from ./chat-busy (Redis SET NX + EX) — the actual
 * data-integrity primitive — so mutual exclusion is tested against shipped
 * semantics, not a re-implementation. The drain ORDERING is modelled from the
 * shipped code with source lines cited at each step, so a reader can falsify
 * the model against the file:
 *   chat-agent.service.ts  ~1187  isChatBusy -> "a run owns the chat"
 *   chat-agent.service.ts  ~1190  peekOldest  (peek, does NOT claim)
 *   chat-agent.service.ts  :1541  startDetachedChatRun (claim inside)
 *   chat-agent.service.ts  :1596  consumePendingUploads
 *   chat-agent.service.ts  ~1607  deletePending  <- AFTER the run starts
 *
 * THE FINDING THIS FILE PINS. Delete-after-start means a colour killed between
 * starting the run and deleting the row leaves the row alive; once the Redis
 * liveness key expires (LIVE_RUN_TTL_SEC = 60 s) the SURVIVING colour peeks the
 * same row and starts a SECOND run for the same content => DUPLICATION. A
 * blue-green cutover stops the old colour's containers, which is precisely that
 * kill.
 *
 * MITIGATION (2026-11-05). This file is a MODEL: it reproduces the shipped drain
 * ORDERING rather than calling `drainChatQueue`, so a fix inside
 * `chat-agent.service.ts` would NOT flip it. It therefore does not, on its own,
 * gate the defect — the review was right about that, and this header says so
 * instead of overclaiming. What it does prove is the ordering's CONSEQUENCE
 * (item 4 below): if the drain deletes after start, duplication is reachable;
 * delete-before-start turns it into LOSS. Anyone landing the real fix must add a
 * test pinned to the live drain, not rely on this file going red.
 *
 * MUTATION PROOF. The final test drives the SAME scenario through a
 * delete-first ordering and shows it converts duplication into LOSS — so the
 * kill-window assertion discriminates rather than passing vacuously.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Hoisted singletons ──────────────────────────────────────────────────────
// jest.mock factories are hoisted above `const` declarations, so the stores
// MUST come from function declarations (hoisted) — a const would be in TDZ
// when the factory first runs. `mock`-prefixed to satisfy jest's
// out-of-scope-variable rule.

interface RedisEntry { v: string; expAt: number | null }

function mockSharedRedis(): {
  api: Record<string, jest.Mock>;
  advance: (ms: number) => void;
  keys: () => string[];
  reset: () => void;
} {
  const g = globalThis as any;
  if (g.__merge1Redis) return g.__merge1Redis;
  const store = new Map<string, RedisEntry>();
  let now = 0;
  const live = (k: string): RedisEntry | undefined => {
    const e = store.get(k);
    if (e && e.expAt !== null && e.expAt <= now) { store.delete(k); return undefined; }
    return e;
  };
  const api = {
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && live(k)) return null;           // SET NX loses to a live key
      store.set(k, { v, expAt: opts?.EX ? now + opts.EX * 1000 : null });
      return 'OK';
    }),
    get: jest.fn(async (k: string) => live(k)?.v ?? null),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    exists: jest.fn(async (k: string) => (live(k) ? 1 : 0)),
    expire: jest.fn(async (k: string, sec: number) => {
      const e = live(k); if (!e) return 0;
      e.expAt = now + sec * 1000; return 1;
    }),
    incr: jest.fn(async (k: string) => {
      const e = live(k); const n = Number(e?.v ?? 0) + 1;
      store.set(k, { v: String(n), expAt: e?.expAt ?? null }); return n;
    }),
    decr: jest.fn(async (k: string) => {
      const e = live(k); const n = Number(e?.v ?? 0) - 1;
      store.set(k, { v: String(n), expAt: e?.expAt ?? null }); return n;
    }),
    mGet: jest.fn(async (ks: string[]) => ks.map((k) => live(k)?.v ?? null)),
    getDel: jest.fn(async (k: string) => { const e = live(k); if (e) store.delete(k); return e?.v ?? null; }),
    on: jest.fn(),
    quit: jest.fn(),
  };
  const handle = {
    api,
    advance: (ms: number) => { now += ms; },
    keys: () => [...store.keys()],
    reset: () => { store.clear(); now = 0; },
  };
  g.__merge1Redis = handle;
  return handle;
}

interface Row { id: string; chatId: string; userId: string; content: string; source: string; createdAt: number }

function mockSharedDb(): {
  rows: Map<string, Row>; nextId: () => string; reset: () => void;
  /** TRUE delivery order across ALL colours — per-colour arrays cannot express
   *  chronology (blue=['one','three'], green=['two'] concatenates wrongly). */
  deliveries: Array<{ colour: string; content: string }>;
} {
  const g = globalThis as any;
  if (g.__merge1Db) return g.__merge1Db;
  const rows = new Map<string, Row>();
  const deliveries: Array<{ colour: string; content: string }> = [];
  let seq = 0;
  const handle = {
    rows,
    deliveries,
    // MONOTONIC and independent of rows.size — a size-derived stamp would
    // re-use a value whenever a row had already been drained.
    nextId: () => `pm_${++seq}`,
    reset: () => { rows.clear(); deliveries.length = 0; seq = 0; },
  };
  g.__merge1Db = handle;
  return handle;
}

jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockSharedRedis().api }));

// message-queue.service imports AppError from the error handler, which
// transitively loads config/env.ts — and THAT runs Zod validation at import
// time, calling process.exit(1) when DATABASE_URL/JWT_SECRET are absent (as
// they are in CI and here). Repo convention (fleet.service.test.ts:47) is to
// mock the module; AppError only needs a real Error subclass carrying .status
// for the 409 full-queue path this replay never reaches.
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
  },
}));

jest.mock('../../../config/database', () => {
  const db = mockSharedDb();
  const inChat = (where: any): Row[] =>
    [...db.rows.values()].filter((r) => r.chatId === where.chatId && (!where.source || r.source === where.source));
  return {
    __esModule: true,
    default: {
      pendingChatMessage: {
        count: jest.fn(async ({ where }: any) => inChat(where).length),
        create: jest.fn(async ({ data }: any) => {
          const row: Row = {
            id: db.nextId(), chatId: data.chatId, userId: data.userId,
            content: data.content, source: data.source, createdAt: db.rows.size + 1,
          };
          db.rows.set(row.id, row);
          return row;
        }),
        findFirst: jest.fn(async ({ where }: any) => inChat(where).sort((a, b) => a.createdAt - b.createdAt)[0] ?? null),
        findMany: jest.fn(async ({ where, take }: any) => {
          const out = inChat(where).sort((a, b) => a.createdAt - b.createdAt);
          return take ? out.slice(0, take) : out;
        }),
        delete: jest.fn(async ({ where }: any) => { db.rows.delete(where.id); return { id: where.id }; }),
        update: jest.fn(async ({ where, data }: any) => {
          const r = db.rows.get(where.id); if (r) Object.assign(r, data); return r;
        }),
      },
      // Durable run rows: how a COLOUR records that it is running. None here —
      // the replay's busy truth is the Redis liveness key (layer 2).
      agentRun: { findFirst: jest.fn(async (_a: any) => null) },
    },
  };
});

import { claimChatLiveRun, LIVE_RUN_TTL_SEC } from './chat-busy';
import { enqueueChatMessage, peekOldest, deletePending } from './message-queue.service';

const CHAT = 'chat_two_colour_1';
const USER = 'user_owner_1';

/**
 * A colour = its own PROCESS-LOCAL run registry + the shared stores.
 * `startedRuns` is the delivery ledger this replay uses INSTEAD of the
 * per-colour ledger production does not have.
 */
interface Colour { name: string; local: Set<string>; startedRuns: string[] }
const makeColour = (name: string): Colour => ({ name, local: new Set(), startedRuns: [] });

/** isChatBusy, modelled over BOTH shared layers (chat-busy.ts:216-220). */
const isBusy = async (c: Colour, chatId: string): Promise<boolean> => {
  if (c.local.has(chatId)) return true;                                   // layer 1: local registry
  if (await mockSharedRedis().api.exists(`cm:liverun:${chatId}`)) return true; // layer 2: shared Redis
  return false;                                                           // layer 3: agent_runs (none)
};

/**
 * The drain in the SHIPPED ORDER: peek -> claim -> START -> delete.
 * `crashBeforeDelete` models the colour being killed right there — which is
 * what a cutover teardown does to an in-flight drain.
 */
const drain = async (
  c: Colour, chatId: string, opts?: { crashBeforeDelete?: boolean },
): Promise<'idle' | 'busy' | 'lost-race' | 'drained' | 'crashed'> => {
  if (await isBusy(c, chatId)) return 'busy';                 // :1187
  const pending = await peekOldest(chatId);                   // :1190  (peek only)
  if (!pending) return 'idle';

  const claimed = await claimChatLiveRun(chatId);             // :1541 (real SET NX)
  if (!claimed) return 'lost-race';                           // two colours, one winner

  c.local.add(chatId);                                        // the run now owns this chat
  c.startedRuns.push(pending.content);                        // START — the run delivers content
  mockSharedDb().deliveries.push({ colour: c.name, content: pending.content }); // shared chronology

  if (opts?.crashBeforeDelete) return 'crashed';              // killed BEFORE :1607

  await deletePending(pending.id);                            // :1607 (AFTER the run started)
  c.local.delete(chatId);
  await mockSharedRedis().api.del(`cm:liverun:${chatId}`);    // the run's finally releases the slot
  return 'drained';
};

/** Counterfactual ordering (delete BEFORE start) — the mutation proof only. */
const drainDeleteFirst = async (c: Colour, chatId: string): Promise<'idle' | 'lost-after-delete'> => {
  const pending = await peekOldest(chatId);
  if (!pending) return 'idle';
  await claimChatLiveRun(chatId);
  await deletePending(pending.id);   // delete FIRST
  return 'lost-after-delete';        // …killed here => row gone, nothing ever delivered
};

beforeEach(() => {
  mockSharedDb().reset();
  mockSharedRedis().reset();
  jest.clearAllMocks();
});

describe('MERGE-1 (d) blue-green two-colour replay', () => {
  it('NO-LOSS on a normal cutover: a message queued while blue owns the chat is delivered after green takes over', async () => {
    const blue = makeColour('blue');
    const green = makeColour('green');

    // The message lands in the SHARED durable queue (not in blue's memory).
    await enqueueChatMessage({ chatId: CHAT, userId: USER, content: 'queued during cutover', source: 'user' });

    // Blue is torn down without ever draining; green becomes live.
    mockSharedRedis().advance(LIVE_RUN_TTL_SEC * 1000 + 1);
    const outcome = await drain(green, CHAT);

    expect(outcome).toBe('drained');
    expect(green.startedRuns).toEqual(['queued during cutover']);
    expect(mockSharedDb().rows.size).toBe(0); // consumed exactly once, nothing left behind
  });

  it('NO-DUPLICATION on a normal handover: exactly one colour starts the run', async () => {
    const blue = makeColour('blue');
    const green = makeColour('green');
    await enqueueChatMessage({ chatId: CHAT, userId: USER, content: 'only once', source: 'user' });

    // Both colours drain concurrently — the ALB has no stickiness, so this is
    // the ordinary shape, not a contrived one.
    const [a, b] = await Promise.all([drain(blue, CHAT), drain(green, CHAT)]);

    expect(mockSharedDb().deliveries.map((d) => d.content)).toEqual(['only once']); // delivered exactly once
    expect([a, b].filter((o) => o === 'drained')).toHaveLength(1);
    expect(mockSharedRedis().api.set).toHaveBeenCalled();                       // the real SET NX gate ran
  });

  it('NO-DUPLICATION across a sequence of handovers (FIFO preserved)', async () => {
    const blue = makeColour('blue');
    const green = makeColour('green');
    await enqueueChatMessage({ chatId: CHAT, userId: USER, content: 'one', source: 'user' });
    await enqueueChatMessage({ chatId: CHAT, userId: USER, content: 'two', source: 'user' });
    await enqueueChatMessage({ chatId: CHAT, userId: USER, content: 'three', source: 'user' });

    expect(await drain(blue, CHAT)).toBe('drained');
    expect(await drain(green, CHAT)).toBe('drained');
    expect(await drain(blue, CHAT)).toBe('drained');

    expect(mockSharedDb().deliveries.map((d) => d.content)).toEqual(['one', 'two', 'three']);
    expect(mockSharedDb().rows.size).toBe(0);
  });

  it('KILL WINDOW (pinned gap): a colour killed between START and DELETE duplicates the message', async () => {
    const blue = makeColour('blue');
    const green = makeColour('green');
    await enqueueChatMessage({ chatId: CHAT, userId: USER, content: 'duplicated by teardown', source: 'user' });

    // The cutover stops blue mid-drain — AFTER start, BEFORE delete.
    expect(await drain(blue, CHAT, { crashBeforeDelete: true })).toBe('crashed');
    expect(mockSharedDb().rows.size).toBe(1); // the row survived, as the code warns it may

    // The liveness key is the only thing holding green off; a hard kill writes
    // no finally, so it simply EXPIRES (chat-busy.ts: LIVE_RUN_TTL_SEC = 60 s).
    mockSharedRedis().advance(LIVE_RUN_TTL_SEC * 1000 + 1);
    expect(await drain(green, CHAT)).toBe('drained');

    // THE GAP: the same content was started twice — once per colour.
    expect(mockSharedDb().deliveries.map((d) => d.content))
      .toEqual(['duplicated by teardown', 'duplicated by teardown']);
    expect(mockSharedDb().rows.size).toBe(0);
  });

  it('a still-held liveness key correctly BLOCKS the other colour (no premature takeover)', async () => {
    const blue = makeColour('blue');
    const green = makeColour('green');
    await enqueueChatMessage({ chatId: CHAT, userId: USER, content: 'held', source: 'user' });

    expect(await drain(blue, CHAT, { crashBeforeDelete: true })).toBe('crashed');
    // Inside the TTL the surviving colour must NOT steal the row.
    expect(await drain(green, CHAT)).toBe('busy');
    expect(green.startedRuns).toEqual([]);
  });

  it('MUTATION PROOF: delete-before-start converts the kill window from duplication into LOSS', async () => {
    // Same scenario, opposite ordering. This is what proves the KILL-WINDOW
    // assertion above discriminates: one ordering duplicates, the other loses,
    // and the shipped ordering is the first.
    const red = makeColour('red');
    const spare = makeColour('spare');
    await enqueueChatMessage({ chatId: CHAT, userId: USER, content: 'lost by early delete', source: 'user' });

    expect(await drainDeleteFirst(red, CHAT)).toBe('lost-after-delete');
    expect(mockSharedDb().rows.size).toBe(0);   // the row is GONE …
    expect(red.startedRuns).toEqual([]);        // … and the run never started => LOSS

    // The surviving colour finds nothing to deliver — the message is gone,
    // which is strictly worse than the duplicate the shipped order risks.
    mockSharedRedis().advance(LIVE_RUN_TTL_SEC * 1000 + 1);
    expect(await drain(spare, CHAT)).toBe('idle');
  });
});
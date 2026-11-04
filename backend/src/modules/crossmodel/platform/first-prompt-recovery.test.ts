/**
 * first-prompt-recovery (nightly finding 2026-08-28: three spawned "Ticket
 * batch" sessions sat ready-and-empty forever — the fire-and-forget
 * deliverPromptWhenReady died with the process and the prompt was never
 * persisted). Pins: Redis stash semantics; the shared Redis-locked delivery
 * path (fast path + sweeper can never double-deliver); 409 → moot; non-409
 * keeps the pending key; the sweep's ready+empty+pending selection.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { chatCodingState: { findMany: jest.fn() } },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn() },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const mockSendChatMessage = jest.fn();
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  sendChatMessage: (...args: any[]) => mockSendChatMessage(...args),
}));

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import {
  stashPendingFirstPrompt,
  clearPendingFirstPrompt,
  deliverPendingFirstPrompt,
  sweepPendingFirstPrompts,
} from './first-prompt-recovery';

const mockPrisma = prisma as any;
const mockRedis = redisClient as any;

const CHAT = 'chat-1111';
const USER = 'user-2222';
const PROMPT = 'Work ticket batch: do the thing';
const PENDING = `coding:first-prompt:pending:${CHAT}`;
const LOCK = `coding:first-prompt:lock:${CHAT}`;

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.get.mockResolvedValue(null);
  mockRedis.del.mockResolvedValue(1);
  mockSendChatMessage.mockResolvedValue({ id: 'msg-1' });
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
});

describe('stashPendingFirstPrompt', () => {
  it('persists the prompt with a 24h TTL and reports the stash landed', async () => {
    await expect(stashPendingFirstPrompt(CHAT, PROMPT)).resolves.toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith(PENDING, PROMPT, { PX: 24 * 60 * 60_000 });
  });

  it('never throws when Redis is down — returns false so the caller uses the in-memory fallback', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(stashPendingFirstPrompt(CHAT, PROMPT)).resolves.toBe(false);
  });
});

describe('clearPendingFirstPrompt', () => {
  it('deletes the pending key, best-effort', async () => {
    await clearPendingFirstPrompt(CHAT);
    expect(mockRedis.del).toHaveBeenCalledWith(PENDING);
  });
});

describe('deliverPendingFirstPrompt', () => {
  it('delivers the pending prompt and clears pending + lock', async () => {
    mockRedis.get.mockResolvedValueOnce(PROMPT);
    const result = await deliverPendingFirstPrompt(CHAT, USER);
    expect(result).toBe('delivered');
    expect(mockRedis.set).toHaveBeenCalledWith(LOCK, '1', { NX: true, PX: 5 * 60_000 });
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT });
    expect(mockRedis.del).toHaveBeenCalledWith(PENDING);
    expect(mockRedis.del).toHaveBeenCalledWith(LOCK);
  });

  it('uses the fallback prompt when no pending key exists (failed stash)', async () => {
    const result = await deliverPendingFirstPrompt(CHAT, USER, PROMPT);
    expect(result).toBe('delivered');
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT });
  });

  it("returns 'already' with neither pending nor fallback — and sends nothing", async () => {
    const result = await deliverPendingFirstPrompt(CHAT, USER);
    expect(result).toBe('already');
    expect(mockSendChatMessage).not.toHaveBeenCalled();
    expect(mockRedis.del).toHaveBeenCalledWith(LOCK);
  });

  it("returns 'locked' when another path holds the delivery lock", async () => {
    mockRedis.set.mockResolvedValueOnce(null); // NX lost
    const result = await deliverPendingFirstPrompt(CHAT, USER);
    expect(result).toBe('locked');
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it("treats a 409 as moot: clears the pending key, sends no retry", async () => {
    mockRedis.get.mockResolvedValueOnce(PROMPT);
    mockSendChatMessage.mockRejectedValueOnce(Object.assign(new Error('busy'), { statusCode: 409 }));
    const result = await deliverPendingFirstPrompt(CHAT, USER);
    expect(result).toBe('moot');
    expect(mockRedis.del).toHaveBeenCalledWith(PENDING);
  });

  it('KEEPS the pending key on a non-409 send error (next sweep retries) and still releases the lock', async () => {
    mockRedis.get.mockResolvedValueOnce(PROMPT);
    mockSendChatMessage.mockRejectedValueOnce(new Error('db hiccup'));
    await expect(deliverPendingFirstPrompt(CHAT, USER)).rejects.toThrow('db hiccup');
    expect(mockRedis.del).not.toHaveBeenCalledWith(PENDING);
    expect(mockRedis.del).toHaveBeenCalledWith(LOCK);
  });
});

/**
 * Ticket 2e9e5264 (2026-09-14) — replay pin: the pre-fix delivery sent the
 * first prompt with NO origin, so sendChatMessage defaulted 'user' and a
 * MACHINE-spawned session's first run was stamped a human turn — triggerKind
 * 'user' in run-executor bypassed the machineTriggered-keyed gates (zero-tool
 * evidence gate, outbound-claim audit) on run #1. The author's origin now
 * rides the stash (JSON { prompt, origin }) and the send; legacy plain-string
 * stashes keep delivering origin-less (the human-UI default is unchanged).
 */
describe('origin threading (ticket 2e9e5264)', () => {
  const AGENT = { kind: 'agent' as const, sourceChatId: 'chat-parent' };

  it('stash WITH an origin persists JSON { prompt, origin } with the 24h TTL', async () => {
    await expect(stashPendingFirstPrompt(CHAT, PROMPT, AGENT)).resolves.toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith(PENDING, JSON.stringify({ prompt: PROMPT, origin: AGENT }), { PX: 24 * 60 * 60_000 });
  });

  it('stash WITHOUT an origin keeps the legacy plain-string payload (human-UI path unchanged)', async () => {
    await stashPendingFirstPrompt(CHAT, PROMPT);
    expect(mockRedis.set).toHaveBeenCalledWith(PENDING, PROMPT, { PX: 24 * 60 * 60_000 });
  });

  it('delivers a JSON-stashed prompt WITH its origin — a spawned session first run is stamped agent', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ prompt: PROMPT, origin: AGENT }));
    const result = await deliverPendingFirstPrompt(CHAT, USER);
    expect(result).toBe('delivered');
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT, origin: AGENT });
  });

  it('a legacy plain-string stash delivers WITHOUT origin when no fallback origin rides along (sweeper path — the pre-fix behavior is unchanged)', async () => {
    mockRedis.get.mockResolvedValueOnce(PROMPT);
    const result = await deliverPendingFirstPrompt(CHAT, USER);
    expect(result).toBe('delivered');
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT });
  });

  it('a legacy plain-string stash (no origin recorded) inherits the fast path fallback origin — the author is the same caller', async () => {
    mockRedis.get.mockResolvedValueOnce(PROMPT);
    const result = await deliverPendingFirstPrompt(CHAT, USER, undefined, AGENT);
    expect(result).toBe('delivered');
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT, origin: AGENT });
  });

  it('the fast path fallback origin is used when the stash failed (no pending key)', async () => {
    const result = await deliverPendingFirstPrompt(CHAT, USER, PROMPT, AGENT);
    expect(result).toBe('delivered');
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT, origin: AGENT });
  });

  it('the STASHED origin wins over the fast path fallback origin', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ prompt: PROMPT, origin: { kind: 'agent' } }));
    const result = await deliverPendingFirstPrompt(CHAT, USER, PROMPT, AGENT);
    expect(result).toBe('delivered');
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT, origin: { kind: 'agent' } });
  });

  it('a stash whose origin is garbage degrades to origin-less, never throws', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ prompt: PROMPT, origin: { kind: 'bogus' } }));
    const result = await deliverPendingFirstPrompt(CHAT, USER);
    expect(result).toBe('delivered');
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT });
  });

  it("a raw prompt that merely STARTS with '{' (invalid JSON) is delivered verbatim, origin-less", async () => {
    const weird = '{"not":"a payload" — truncated';
    mockRedis.get.mockResolvedValueOnce(weird);
    const result = await deliverPendingFirstPrompt(CHAT, USER);
    expect(result).toBe('delivered');
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: weird });
  });

  it('the SWEEPER delivers a JSON-stashed prompt with its origin (it has no in-memory copy)', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValueOnce([{ id: CHAT, userId: USER }]);
    mockRedis.get.mockImplementation(async (key: string) =>
      key === PENDING ? JSON.stringify({ prompt: PROMPT, origin: { kind: 'agent' } }) : null);
    const delivered = await sweepPendingFirstPrompts();
    expect(delivered).toBe(1);
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT, origin: { kind: 'agent' } });
  });
});

describe('sweepPendingFirstPrompts', () => {
  it('delivers to ready+empty sessions that have a pending prompt; skips promptless ones', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValueOnce([
      { id: CHAT, userId: USER },
      { id: 'chat-noprompt', userId: USER },
    ]);
    mockRedis.get.mockImplementation(async (key: string) => (key === PENDING ? PROMPT : null));
    const delivered = await sweepPendingFirstPrompts();
    expect(delivered).toBe(1);
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT });
    // selection shape: ready OR provisioning-error (f173), past the grace window, zero coding messages
    const query = mockPrisma.chatCodingState.findMany.mock.calls[0][0];
    expect(query.where.OR).toEqual([
      { status: 'ready' },
      { status: 'error', errorMessage: { startsWith: 'Workspace provisioning failed' } },
    ]);
    expect(query.where.messages).toEqual({ none: {} });
    expect(query.where.createdAt.lt).toBeInstanceOf(Date);
  });

  it('f173: a provisioning-error zero-message session with a pending prompt gets re-fired (config-lock heal)', async () => {
    // The DB-side filter (asserted above) now SELECTS these rows; the
    // delivery path is unchanged — the fired run's re-provision self-heals
    // through reattachWorktree (prod session d66f78f9's manual re-fire).
    mockPrisma.chatCodingState.findMany.mockResolvedValueOnce([{ id: CHAT, userId: USER }]);
    mockRedis.get.mockImplementation(async (key: string) => (key === PENDING ? PROMPT : null));
    const delivered = await sweepPendingFirstPrompts();
    expect(delivered).toBe(1);
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT });
  });

  it('f173 kill switch: FIRST_PROMPT_ERROR_SWEEP_DISABLED=1 restores the ready-only scan', async () => {
    process.env.FIRST_PROMPT_ERROR_SWEEP_DISABLED = '1';
    try {
      mockPrisma.chatCodingState.findMany.mockResolvedValueOnce([]);
      await sweepPendingFirstPrompts();
      const query = mockPrisma.chatCodingState.findMany.mock.calls[0][0];
      expect(query.where.OR).toEqual([{ status: 'ready' }]);
    } finally {
      delete process.env.FIRST_PROMPT_ERROR_SWEEP_DISABLED;
    }
  });

  it('f173/H1: an error-arm 409 KEEPS the pending key (heal refused — the lane has no run yet)', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValueOnce([{ id: CHAT, userId: USER, status: 'error' }]);
    mockRedis.get.mockImplementation(async (key: string) => (key === PENDING ? PROMPT : null));
    mockRedis.set.mockImplementation(async () => 'OK'); // re-fire stamp + delivery lock both claim
    mockSendChatMessage.mockRejectedValueOnce(Object.assign(new Error('heal refused'), { statusCode: 409 }));
    const delivered = await sweepPendingFirstPrompts();
    expect(delivered).toBe(0);
    // The prompt survives for the next sweep — an error-arm 409 never deletes
    // it (the exact prompt-loss class the arm exists to close).
    expect(mockRedis.del.mock.calls.some(([k]: [string]) => k === PENDING)).toBe(false);
  });

  it('f173/H2: the error arm is bounded by the re-fire marker (no send every 60s on a permanent failure)', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValueOnce([{ id: CHAT, userId: USER, status: 'error' }]);
    mockRedis.get.mockImplementation(async (key: string) => (key === PENDING ? PROMPT : null));
    // Marker already stamped (NX loses) → the row is skipped before any send.
    mockRedis.set.mockImplementation(async (key: string) => (key.includes('error-refire') ? null : 'OK'));
    const delivered = await sweepPendingFirstPrompts();
    expect(delivered).toBe(0);
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it('f173/H3: the error arm predicate uses the shared PROVISIONING_FAILED_PREFIX', async () => {
    const { PROVISIONING_FAILED_PREFIX } = await import('./first-prompt-recovery');
    mockPrisma.chatCodingState.findMany.mockResolvedValueOnce([]);
    await sweepPendingFirstPrompts();
    const query = mockPrisma.chatCodingState.findMany.mock.calls[0][0];
    expect(query.where.OR[1]).toEqual({ status: 'error', errorMessage: { startsWith: PROVISIONING_FAILED_PREFIX } });
  });

  it('is fail-closed on query error (returns 0, next tick retries)', async () => {
    mockPrisma.chatCodingState.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(sweepPendingFirstPrompts()).resolves.toBe(0);
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it('counts only real deliveries (locked/moot do not count)', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValueOnce([{ id: CHAT, userId: USER }]);
    mockRedis.get.mockResolvedValue(PROMPT);
    mockRedis.set.mockResolvedValueOnce(null); // sweep's lock attempt lost
    await expect(sweepPendingFirstPrompts()).resolves.toBe(0);
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });
});

/**
 * Human-spawned child (cohesive chat live fixes 2026-09-28, platform/human-spawn.ts):
 * the parent turn's anchor rides the stash as origin.userTurnAt and is handed to
 * sendChatMessage as a real `userTurnAt` (the origin passed down keeps its
 * kind + sourceChatId shape) — so the child's first run is classified 'user',
 * never "unattended machine-triggered". A garbage anchor is dropped; a
 * machine stash (no anchor) is byte-identical to before.
 */
describe('human-spawn anchor threading (2026-09-28)', () => {
  const AT = '2026-09-28T05:09:58.000Z';
  const HUMAN = { kind: 'user' as const, sourceChatId: 'chat-parent', userTurnAt: AT };

  it('stash persists the anchor inside the origin JSON', async () => {
    await expect(stashPendingFirstPrompt(CHAT, PROMPT, HUMAN)).resolves.toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith(PENDING, JSON.stringify({ prompt: PROMPT, origin: HUMAN }), { PX: 24 * 60 * 60_000 });
  });

  it('delivery passes userTurnAt as a Date and an origin of kind + sourceChatId only', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ prompt: PROMPT, origin: HUMAN }));
    await expect(deliverPendingFirstPrompt(CHAT, USER)).resolves.toBe('delivered');
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT, origin: { kind: 'user', sourceChatId: 'chat-parent' }, userTurnAt: new Date(AT) });
  });

  it('the fast-path fallback origin carries the anchor too (stash failed)', async () => {
    await expect(deliverPendingFirstPrompt(CHAT, USER, PROMPT, HUMAN)).resolves.toBe('delivered');
    expect(mockSendChatMessage).toHaveBeenCalledWith(expect.objectContaining({ userTurnAt: new Date(AT), origin: { kind: 'user', sourceChatId: 'chat-parent' } }));
  });

  it('a garbage anchor is dropped (origin still delivers), and a machine stash carries no userTurnAt', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ prompt: PROMPT, origin: { kind: 'user', userTurnAt: 'not-a-date' } }));
    await deliverPendingFirstPrompt(CHAT, USER);
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT, origin: { kind: 'user' } });
    mockSendChatMessage.mockClear();
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ prompt: PROMPT, origin: { kind: 'agent', sourceChatId: 'chat-parent' } }));
    await deliverPendingFirstPrompt(CHAT, USER);
    expect(mockSendChatMessage).toHaveBeenCalledWith({ userId: USER, chatId: CHAT, content: PROMPT, origin: { kind: 'agent', sourceChatId: 'chat-parent' } });
    expect(mockSendChatMessage.mock.calls[0][0]).not.toHaveProperty('userTurnAt');
  });
});

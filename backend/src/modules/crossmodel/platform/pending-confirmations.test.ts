/**
 * Platform unification (security hardening) — the user-turn-anchored
 * confirmation registry, unit-tested directly against an in-memory
 * pendingConfirmation table (config/database mocked): staged-args
 * snapshotting, the one-shot consume, every denial reason, lazy TTL expiry,
 * the anchor semantics (pending.createdAt < userTurnAt) that makes prompt
 * injection unable to confirm its own registrations, the session lookup that
 * rehydrates the protocol into plain-chat history, and the REST-surface
 * helpers (list/get/resolve/record) the confirmations controller builds on.
 */

import { createPendingConfirmationTable } from './pending-confirmations.testkit';

const mockConfirmations = createPendingConfirmationTable();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { pendingConfirmation: mockConfirmations.api },
}));

import {
  CONFIRMATION_TTL_MS,
  EXPIRED_LISTING_WINDOW_MS,
  consumePendingConfirmation,
  getActivePendingForSession,
  getPendingConfirmation,
  listPendingConfirmationsForUser,
  listRecentlyExpiredConfirmationsForUser,
  pendingConfirmationCount,
  recordConfirmationResult,
  registerPendingConfirmation,
  resolvePendingConfirmation,
} from './pending-confirmations';

beforeEach(() => {
  mockConfirmations.reset();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('register + consume (DB-persisted, staged-args)', () => {
  const ARGS = { chatId: 'c1', content: 'hello' };
  const register = (over: Partial<Parameters<typeof registerPendingConfirmation>[0]> = {}) =>
    registerPendingConfirmation({ sessionId: 'sess-1', userId: 'u1', tool: 'send_chat_message', args: ARGS, summary: 's', ...over });

  it('registers a durable row: cf_ id, pending, freshness-horizon expiresAt, stored staged args', async () => {
    const { confirmationId, expiresInMinutes, expiresAt } = await register();
    expect(confirmationId).toMatch(/^cf_/);
    expect(expiresInMinutes).toBe(CONFIRMATION_TTL_MS / 60_000);
    expect(expiresAt).toBeGreaterThan(Date.now() + CONFIRMATION_TTL_MS - 5000);
    const row = await getPendingConfirmation(confirmationId);
    expect(row).toMatchObject({
      chatId: 'sess-1', userId: 'u1', tool: 'send_chat_message', status: 'pending', args: ARGS,
    });
    expect(await pendingConfirmationCount()).toBe(1);
  });

  // Cohesive chat (2026-09-28): the staging origin rides the row so the pending
  // listing can flag machine-staged cards; an omitted origin stays NULL (legacy).
  it('persists the staging origin when given and leaves it unset otherwise', async () => {
    const { confirmationId: machineId } = await register({ origin: 'machine' });
    expect(await getPendingConfirmation(machineId)).toMatchObject({ origin: 'machine' });
    const { confirmationId: userId } = await register({ origin: 'user' });
    expect(await getPendingConfirmation(userId)).toMatchObject({ origin: 'user' });
    const { confirmationId: legacyId } = await register();
    expect((await getPendingConfirmation(legacyId)) as any).not.toHaveProperty('origin');
  });

  it('a confirm from a LATER user turn executes the STAGED args (one-shot)', async () => {
    const { confirmationId } = await register();
    const row = await getPendingConfirmation(confirmationId);
    const later = new Date(row!.createdAt.getTime() + 1000);
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message', userTurnAt: later,
    })).resolves.toEqual({ ok: true, args: ARGS });
    expect(await pendingConfirmationCount()).toBe(0);
    // One-shot: a second consume of the same id is an unknown-id denial.
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message',
      userTurnAt: new Date(later.getTime() + 1000),
    })).resolves.toEqual({ ok: false, reason: 'unknown' });
  });

  it('snapshots the args at registration (later mutation of the caller object cannot rewrite the confirmed action)', async () => {
    const mutable: any = { chatId: 'c1', content: 'hello' };
    const { confirmationId } = await registerPendingConfirmation({
      sessionId: 'sess-1', userId: 'u1', tool: 'send_chat_message', args: mutable, summary: 's',
    });
    mutable.content = 'DROP TABLES'; // the same object keeps flowing through the registering turn
    const row = await getPendingConfirmation(confirmationId);
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message',
      userTurnAt: new Date(row!.createdAt.getTime() + 1000),
    })).resolves.toEqual({ ok: true, args: { chatId: 'c1', content: 'hello' } });
  });

  it('denies an unknown confirmationId', async () => {
    await expect(consumePendingConfirmation({
      confirmationId: 'cf_nope', sessionId: 'sess-1', tool: 'send_chat_message',
      userTurnAt: new Date(Date.now() + 1000),
    })).resolves.toEqual({ ok: false, reason: 'unknown' });
  });

  it('denies a different session or tool as wrong_session (and keeps the pending)', async () => {
    const { confirmationId } = await register();
    const row = await getPendingConfirmation(confirmationId);
    const later = new Date(row!.createdAt.getTime() + 1000);
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-OTHER', tool: 'send_chat_message', userTurnAt: later,
    })).resolves.toEqual({ ok: false, reason: 'wrong_session' });
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'cancel_schedule', userTurnAt: later,
    })).resolves.toEqual({ ok: false, reason: 'wrong_session' });
    // Not burned: the faithful confirm still passes.
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message', userTurnAt: later,
    })).resolves.toEqual({ ok: true, args: ARGS });
  });

  it('denies a missing userTurnAt as no_user_turn (machine-triggered runs fail closed)', async () => {
    const { confirmationId } = await register();
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message',
    })).resolves.toEqual({ ok: false, reason: 'no_user_turn' });
    // Still confirmable by a later REAL user turn.
    const row = await getPendingConfirmation(confirmationId);
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message',
      userTurnAt: new Date(row!.createdAt.getTime() + 1000),
    })).resolves.toEqual({ ok: true, args: ARGS });
  });

  it('denies a same-turn confirm (createdAt >= userTurnAt) — the injection case', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { confirmationId } = await register(); // createdAt = 1_000_000
    // Equal timestamps: the "user turn" IS the turn that registered the pending.
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message',
      userTurnAt: new Date(1_000_000),
    })).resolves.toEqual({ ok: false, reason: 'same_turn' });
    // A user turn from BEFORE the registration (the message that started this run).
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message',
      userTurnAt: new Date(999_999),
    })).resolves.toEqual({ ok: false, reason: 'same_turn' });
    // Only a strictly LATER user turn confirms.
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message',
      userTurnAt: new Date(1_000_001),
    })).resolves.toEqual({ ok: true, args: ARGS });
  });

  it('stale-action safety: past the freshness horizon a confirm denies and flips the row to expired (never a silent fire)', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { confirmationId } = await register(); // createdAt = 1_000_000, expiresAt = 1_000_000 + TTL
    (Date.now as jest.Mock).mockReturnValue(1_000_000 + CONFIRMATION_TTL_MS + 1000);
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message',
      userTurnAt: new Date(1_000_000 + CONFIRMATION_TTL_MS + 1000),
    })).resolves.toEqual({ ok: false, reason: 'unknown' });
    expect((await getPendingConfirmation(confirmationId))!.status).toBe('expired');
    expect(await pendingConfirmationCount()).toBe(0);
  });

  it('a pending registered DURING a machine run still confirms from a later REAL user turn', async () => {
    // Registration needs no userTurnAt (the machine run registers, the user
    // confirms in their next message) — the schedule-supervisor flow.
    const { confirmationId } = await register();
    const row = await getPendingConfirmation(confirmationId);
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message',
      userTurnAt: new Date(row!.createdAt.getTime() + 60_000),
    })).resolves.toEqual({ ok: true, args: ARGS });
  });
});

describe('getActivePendingForSession (chat-history rehydration lookup)', () => {
  const register = (over: Partial<Parameters<typeof registerPendingConfirmation>[0]> = {}) =>
    registerPendingConfirmation({ sessionId: 'sess-A', userId: 'u1', tool: 'cancel_schedule', args: { id: 's1' }, summary: 's', ...over });

  it('returns null when nothing is pending for the session', async () => {
    await expect(getActivePendingForSession('sess-none')).resolves.toBeNull();
  });

  it('returns the newest live pending for the session (never args)', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await register({ summary: 'older' });
    (Date.now as jest.Mock).mockReturnValue(1_001_000);
    const newer = await register({ summary: 'newer' });
    await register({ sessionId: 'sess-OTHER', summary: 'other session' });
    const active = await getActivePendingForSession('sess-A');
    expect(active).toMatchObject({ confirmationId: newer.confirmationId, tool: 'cancel_schedule', summary: 'newer' });
    expect(active).not.toHaveProperty('args');
  });

  it('a consumed pending no longer counts as active', async () => {
    const { confirmationId } = await register();
    await expect(getActivePendingForSession('sess-A')).resolves.not.toBeNull();
    const row = await getPendingConfirmation(confirmationId);
    await consumePendingConfirmation({
      confirmationId, sessionId: 'sess-A', tool: 'cancel_schedule',
      userTurnAt: new Date(row!.createdAt.getTime() + 1000),
    });
    await expect(getActivePendingForSession('sess-A')).resolves.toBeNull();
  });

  it('an expired pending no longer counts as active', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await register();
    (Date.now as jest.Mock).mockReturnValue(1_000_000 + CONFIRMATION_TTL_MS + 1000);
    await expect(getActivePendingForSession('sess-A')).resolves.toBeNull();
  });
});

describe('REST-surface helpers', () => {
  const register = (over: Partial<Parameters<typeof registerPendingConfirmation>[0]> = {}) =>
    registerPendingConfirmation({ sessionId: 'sess-1', userId: 'u1', tool: 'cancel_schedule', args: { id: 'sch1' }, summary: 's', ...over });

  it('resolvePendingConfirmation flips one-shot: pending → cancelled, then denies', async () => {
    const { confirmationId } = await register();
    expect(await resolvePendingConfirmation(confirmationId, 'cancelled')).toBe(true);
    expect(await resolvePendingConfirmation(confirmationId, 'cancelled')).toBe(false);
    expect(await resolvePendingConfirmation('cf_nope', 'cancelled')).toBe(false);
    expect((await getPendingConfirmation(confirmationId))!.status).toBe('cancelled');
    expect((await getPendingConfirmation(confirmationId))!.resolvedAt).toBeInstanceOf(Date);
  });

  it('recordConfirmationResult stores the outcome; failed flips status to failed', async () => {
    const { confirmationId } = await register();
    expect(await resolvePendingConfirmation(confirmationId, 'consumed')).toBe(true);
    await recordConfirmationResult(confirmationId, { error: 'boom' }, true);
    const row = await getPendingConfirmation(confirmationId);
    expect(row!.status).toBe('failed');
    expect(row!.result).toEqual({ error: 'boom' });
  });

  it('listPendingConfirmationsForUser returns the user\'s pending rows, newest first — INCLUDING stale ones (ticket 7705fec2: cards persist until answered)', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const a = await register({ summary: 'first' });
    (Date.now as jest.Mock).mockReturnValue(1_001_000);
    const b = await register({ summary: 'second' });
    await register({ userId: 'u2', sessionId: 'sess-2', summary: 'other user' });
    const resolved = await register({ summary: 'already cancelled' });
    expect(await resolvePendingConfirmation(resolved.confirmationId, 'cancelled')).toBe(true);
    // A STALE pending row (past its freshness horizon) STAYS listed — the
    // owner must still see it and dismiss it (Confirm would refuse as stale).
    (Date.now as jest.Mock).mockReturnValue(1_002_000);
    const stale = await register({ summary: 'stale' });
    mockConfirmations.rows.find((r) => r.id === stale.confirmationId)!.expiresAt = new Date(500_000);

    const list = await listPendingConfirmationsForUser('u1');
    expect(list.map((r: any) => r.id)).toEqual([stale.confirmationId, b.confirmationId, a.confirmationId]);
  });

  it('listRecentlyExpiredConfirmationsForUser surfaces only rows FLIPPED to expired in the window — a stale-but-pending row is a live card, not a trace (7705fec2)', async () => {
    const NOW = 10_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);

    const setExpiry = (id: string, expiresAtMs: number) => {
      mockConfirmations.rows.find((r) => r.id === id)!.expiresAt = new Date(expiresAtMs);
    };

    // Stale but still 'pending' → a LIVE card in the pending listing, never a trace here.
    const stalePending = await register({ summary: 'stale pending' });
    setExpiry(stalePending.confirmationId, NOW - 5 * 60_000);
    // Flipped to 'expired' (a stale confirm attempt) → surfaces.
    const flipped = await register({ summary: 'flipped expired' });
    setExpiry(flipped.confirmationId, NOW - 60_000);
    mockConfirmations.rows.find((r) => r.id === flipped.confirmationId)!.status = 'expired';
    // Expired OUTSIDE the window → dropped.
    const old = await register({ summary: 'too old' });
    setExpiry(old.confirmationId, NOW - EXPIRED_LISTING_WINDOW_MS - 1);
    mockConfirmations.rows.find((r) => r.id === old.confirmationId)!.status = 'expired';
    // Resolved WITH an outcome → never an "expired" trace.
    const cancelled = await register({ summary: 'cancelled' });
    setExpiry(cancelled.confirmationId, NOW - 60_000);
    expect(await resolvePendingConfirmation(cancelled.confirmationId, 'cancelled')).toBe(true);
    // Still live → belongs to the pending listing, not this one.
    await register({ summary: 'still live' });
    // Another user's flipped row → invisible.
    const other = await register({ userId: 'u2', sessionId: 'sess-2', summary: 'other user' });
    setExpiry(other.confirmationId, NOW - 60_000);
    mockConfirmations.rows.find((r) => r.id === other.confirmationId)!.status = 'expired';

    const list = await listRecentlyExpiredConfirmationsForUser('u1');
    expect(list.map((r: any) => r.summary)).toEqual(['flipped expired']);
    // The stale-but-pending row rides the PENDING listing instead.
    const pendingList = await listPendingConfirmationsForUser('u1');
    expect(pendingList.map((r: any) => r.summary)).toContain('stale pending');
  });
});

describe('persistence until answered (ticket 7705fec2)', () => {
  const ARGS = { chatId: 'c1', content: 'nudge the benchmarks lane' };
  const register = () =>
    registerPendingConfirmation({ sessionId: 'sess-1', userId: 'u1', tool: 'send_chat_message', args: ARGS, summary: 'Send a nudge' });

  it('an unanswered owner decision survives FAR past the old 24h expiry — still listed and still confirmable', async () => {
    const T = 1_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(T);
    const { confirmationId } = await register();
    // 25 hours later — the pre-7705fec2 TTL (24h) would have killed the card.
    const LATER = T + 25 * 60 * 60 * 1000;
    (Date.now as jest.Mock).mockReturnValue(LATER);
    const list = await listPendingConfirmationsForUser('u1');
    expect(list.map((r: any) => r.id)).toContain(confirmationId);
    // ...and a real user turn STILL completes it (well inside the freshness horizon).
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message', userTurnAt: new Date(LATER),
    })).resolves.toEqual({ ok: true, args: ARGS });
    // Answered → resolved: the card leaves the listing with an outcome.
    await expect(listPendingConfirmationsForUser('u1')).resolves.toEqual([]);
  });

  it('stale-action safety: past the freshness horizon the card is still listed, but a confirm refuses, flips it to expired, and it leaves as a trace — never a silent fire', async () => {
    const T = 1_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(T);
    const { confirmationId } = await register();
    const PAST_HORIZON = T + CONFIRMATION_TTL_MS + 1000;
    (Date.now as jest.Mock).mockReturnValue(PAST_HORIZON);
    // Still visible: the owner sees WHAT is pending even long after staging.
    expect((await listPendingConfirmationsForUser('u1')).map((r: any) => r.id)).toEqual([confirmationId]);
    // A confirm attempt (fresh user turn or REST click) must NOT execute the
    // stale staged args — it denies and flips the row so the card leaves WITH
    // an outcome the owner can see, requiring a re-stage.
    await expect(consumePendingConfirmation({
      confirmationId, sessionId: 'sess-1', tool: 'send_chat_message', userTurnAt: new Date(PAST_HORIZON),
    })).resolves.toEqual({ ok: false, reason: 'unknown' });
    expect((await getPendingConfirmation(confirmationId))!.status).toBe('expired');
    await expect(listPendingConfirmationsForUser('u1')).resolves.toEqual([]);
    expect((await listRecentlyExpiredConfirmationsForUser('u1')).map((r: any) => r.id)).toEqual([confirmationId]);
  });
});

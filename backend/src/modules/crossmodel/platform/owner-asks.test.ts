/**
 * owner-asks.ts (tt-rd audit 2026-09-27, findings 3/4/5) + the shared
 * reply-row leaf (fleet/supervisor-reply-row.ts).
 *
 *  - isSupervisorReplyRow: owner-origin + finalize stamp + not a card kind +
 *    not a provider-error / harness envelope + non-empty;
 *  - buildOpenOwnerAsksBlock: lists only asks with NO qualifying reply after
 *    them, oldest first, capped, with the answer-first instruction; '' when
 *    nothing is open; a reply-scan error hides the ask
 *    (fail-open — never re-inject because a lookup broke);
 *  - rewakeForUnansweredOwnerAsk: ONE direct wake per ask (Redis NX), the
 *    prompt names the ask + msg id, telemetry row lands; the switch stops it.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelMessage: { findMany: jest.fn(async (): Promise<any[]> => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const redisStore = new Map<string, string>();
const mockRedis = {
  set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => {
    if (opts?.NX && redisStore.has(k)) return null;
    redisStore.set(k, v);
    return 'OK';
  }),
  get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
  del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockListOpenOwnerAsks: jest.Mock = jest.fn(async (): Promise<any[]> => []);
const mockCloseAskOnReply: jest.Mock = jest.fn(async (): Promise<boolean> => true);
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  listOpenOwnerAsks: (...a: any[]) => mockListOpenOwnerAsks(...a),
  closeAskOnReply: (...a: any[]) => mockCloseAskOnReply(...a),
}));

const mockEnqueueDirectWake: jest.Mock = jest.fn(async (): Promise<any> => ({ ok: true, hookEventId: 'hook-evt-0001' }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import {
  buildOpenOwnerAsksBlock, buildOpenOwnerAsksWake, renderOpenOwnerAsksBlock, hasSupervisorReplyAfter, findSupervisorReplyAfter,
  rewakeForUnansweredOwnerAsk, renderOwnerAskRewakePrompt, OPEN_OWNER_ASKS_HEADER, OPEN_OWNER_ASKS_MAX_ROWS, OWNER_ASK_REWAKE_KEY,
} from './owner-asks';
import { isSupervisorReplyRow, hasFinalizeStamp, isOwnerOrigin } from '../fleet/supervisor-reply-row';
import { EMPTY_RUN_FALLBACK_NOTE } from '../coding/harness-error-notes';

const NOW = new Date('2026-09-27T16:00:00Z');
const CHAT = '810c924d-0000-4000-8000-000000000000';
const ask = (over: Partial<{ id: string; text: string; at: string; messageId: string }> = {}) => ({
  id: 'd-1', text: 'any progress ?', at: new Date(NOW.getTime() - 2 * 3600_000).toISOString(), messageId: 'msg-aaaaaaaa-1', ...over,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('supervisor-reply-row (shared leaf)', () => {
  it('a finalize-stamped, owner-origin, non-envelope row is the supervisor\'s reply; cards, machine rows, envelopes and blanks are not', () => {
    expect(isSupervisorReplyRow({ content: 'Progress: PR #706 landed.', metadata: { engine: 'agent' } })).toBe(true);
    expect(isSupervisorReplyRow({ content: 'Progress: PR #706 landed.', metadata: { models: { digby: {} } } })).toBe(true);
    expect(isSupervisorReplyRow({ content: 'Progress: PR #706 landed.', metadata: { engine: 'agent', origin: 'user' } })).toBe(true);
    expect(isSupervisorReplyRow({ content: 'WAKE: no-op', metadata: { engine: 'agent', origin: 'hook' } })).toBe(false);
    // fixer 2026-09-27 (finding upward-chatter-1): the reply of an [OWNER ASK
    // UNANSWERED] re-wake is HOOK-origin — the harness stamp ownerAskReply
    // (set only on a real answer) makes it the supervisor's reply; the stamp
    // never rescues an envelope, a card kind or a blank.
    expect(isSupervisorReplyRow({ content: 'We are at 5.08 tok/s of record (msg 871d203b).', metadata: { engine: 'agent', origin: 'hook', ownerAskReply: true } })).toBe(true);
    expect(isSupervisorReplyRow({ content: EMPTY_RUN_FALLBACK_NOTE, metadata: { engine: 'agent', origin: 'hook', ownerAskReply: true } })).toBe(false);
    expect(isSupervisorReplyRow({ content: 'brief', metadata: { engine: 'agent', origin: 'hook', ownerAskReply: true, kind: 'owner_briefing' } })).toBe(false);
    expect(isSupervisorReplyRow({ content: 'answer', metadata: { origin: 'hook', ownerAskReply: true } })).toBe(false); // no finalize stamp
    expect(isSupervisorReplyRow({ content: 'Progress…', metadata: null })).toBe(false); // harness notice: no stamp
    expect(isSupervisorReplyRow({ content: 'brief', metadata: { engine: 'agent', kind: 'owner_briefing' } })).toBe(false);
    expect(isSupervisorReplyRow({ content: 'Sorry…', metadata: { engine: 'agent', providerError: { status: 429 } } })).toBe(false);
    expect(isSupervisorReplyRow({ content: EMPTY_RUN_FALLBACK_NOTE, metadata: { engine: 'agent' } })).toBe(false);
    expect(isSupervisorReplyRow({ content: '   ', metadata: { engine: 'agent' } })).toBe(false);
    expect(hasFinalizeStamp({ engine: 'agent' })).toBe(true);
    expect(hasFinalizeStamp({})).toBe(false);
    expect(isOwnerOrigin(undefined)).toBe(true);
    expect(isOwnerOrigin({ origin: 'schedule' })).toBe(false);
  });
});

describe('hasSupervisorReplyAfter', () => {
  beforeEach(() => { mockPrisma.crossModelMessage.findMany.mockReset(); });
  it('true when a qualifying assistant row follows the ask; false when only envelopes / machine notes follow', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValueOnce([
      { id: 'a1', content: EMPTY_RUN_FALLBACK_NOTE, metadata: { engine: 'agent' } },
      { id: 'a2', content: 'WAKE: no-op — nothing moved', metadata: { engine: 'agent', origin: 'schedule' } },
    ]);
    expect(await hasSupervisorReplyAfter(CHAT, NOW)).toBe(false);
    mockPrisma.crossModelMessage.findMany.mockResolvedValueOnce([
      { id: 'a3', content: 'We are at 5.08 tok/s; the bisect is on rung zf.', metadata: { engine: 'agent' } },
    ]);
    expect(await hasSupervisorReplyAfter(CHAT, NOW)).toBe(true);
    const where = mockPrisma.crossModelMessage.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ chatId: CHAT, role: 'assistant', createdAt: { gt: NOW } });
  });
  it('a read error answers TRUE (fail-open: never re-inject because the lookup broke)', async () => {
    mockPrisma.crossModelMessage.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await hasSupervisorReplyAfter(CHAT, NOW)).toBe(true);
  });
});

describe('buildOpenOwnerAsksBlock', () => {
  beforeEach(() => {
    mockListOpenOwnerAsks.mockReset().mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockReset().mockResolvedValue([]);
  });

  it('renders the unanswered asks with age + msg id and the answer-first instruction; answered asks are omitted', async () => {
    mockListOpenOwnerAsks.mockResolvedValue([
      ask({ id: 'd-old', text: 'where are we at', at: new Date(NOW.getTime() - 5 * 3600_000).toISOString(), messageId: 'msg-bbbbbbbb-2' }),
      ask({ id: 'd-answered', text: 'any new progress', messageId: 'msg-cccccccc-3' }),
      ask({ id: 'd-new', text: 'what are you doing', at: new Date(NOW.getTime() - 20 * 60_000).toISOString(), messageId: 'msg-dddddddd-4' }),
    ]);
    // Reply scan per ask (call order = ask order): old → none; answered → a real reply; new → none.
    mockPrisma.crossModelMessage.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'r', content: 'Bisect rung zf exonerated; 5.08 tok/s of record.', metadata: { engine: 'agent' } }])
      .mockResolvedValueOnce([]);
    const block = await buildOpenOwnerAsksBlock(CHAT, NOW);
    expect(block.startsWith(OPEN_OWNER_ASKS_HEADER)).toBe(true);
    expect(block).toContain('(5h ago, msg msg-bbbb) "where are we at"');
    expect(block).toContain('(20m ago, msg msg-dddd) "what are you doing"');
    expect(block).not.toContain('any new progress');
    expect(block).toContain('Answer each in plain words THIS wake before any sweep, dispatch or report-up');
    expect(block).toContain('the harness marks the ask answered when your reply lands');
    // fixer 2026-09-27: EVERY open ask is read (no maxAgeMs — an old ask a reply
    // already answered must still reconcile); the 72 h cap applies to the block rows only.
    expect(mockListOpenOwnerAsks).toHaveBeenCalledWith(CHAT, expect.objectContaining({ now: NOW }));
    expect(mockListOpenOwnerAsks.mock.calls[0][1].maxAgeMs).toBeUndefined();
  });

  it('asks older than 72 h with no reply are left to the state doc / follow-through (not in the block)', async () => {
    mockListOpenOwnerAsks.mockResolvedValue([ask({ id: 'd-stale', text: 'where are we at', at: new Date(NOW.getTime() - 100 * 3600_000).toISOString() })]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    const wake = await buildOpenOwnerAsksWake(CHAT, { userId: 'u1', now: NOW });
    expect(wake.block).toBe('');
    expect(wake.hideAskIds).toEqual([]);
    expect(mockCloseAskOnReply).not.toHaveBeenCalled();
  });

  it("'' when nothing is open", async () => {
    expect(await buildOpenOwnerAsksBlock(CHAT, NOW)).toBe('');
  });

  it('the pure render caps rows (oldest first) and tolerates a missing messageId', () => {
    const many = Array.from({ length: OPEN_OWNER_ASKS_MAX_ROWS + 3 }, (_, i) => ask({ id: `d-${i}`, text: `ask ${i}`, messageId: undefined as any }));
    const txt = renderOpenOwnerAsksBlock(many, NOW);
    expect(txt.split('\n').filter((l) => l.startsWith('- (')).length).toBe(OPEN_OWNER_ASKS_MAX_ROWS);
    expect(txt).toContain('(2h ago) "ask 0"');
    expect(renderOpenOwnerAsksBlock([], NOW)).toBe('');
  });
});

// fixer 2026-09-27 (finding upward-chatter-1c): the wake read RECONCILES asks a
// qualifying reply already answered (closeAskOnReply, source 'reconcile') and
// hands back the ids the [SUPERVISOR STATE] render must omit — the block's own
// rows and the answered ones — so an ask renders once, and an answered-but-
// unclosed ask (a machine-wake answer, or an owner-turn answer from before the
// close existed) stops re-injecting for 72 h.
describe('buildOpenOwnerAsksWake — reconcile + hideAskIds', () => {
  beforeEach(() => {
    mockListOpenOwnerAsks.mockReset().mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockReset().mockResolvedValue([]);
    mockCloseAskOnReply.mockClear();
  });

  it('an answered ask is closed with its reply row id (source reconcile) and hidden; an unanswered one is listed once and hidden from the state doc; a scan error hides without closing', async () => {
    mockListOpenOwnerAsks.mockResolvedValue([
      ask({ id: 'd-answered', text: 'any new progress', messageId: 'msg-cccccccc-3', at: new Date(NOW.getTime() - 5 * 3600_000).toISOString() }),
      ask({ id: 'd-open', text: 'where are we at', messageId: 'msg-bbbbbbbb-2' }),
      ask({ id: 'd-err', text: 'what are you doing', messageId: 'msg-eeeeeeee-5', at: new Date(NOW.getTime() - 20 * 60_000).toISOString() }),
    ]);
    mockPrisma.crossModelMessage.findMany
      .mockResolvedValueOnce([
        { id: 'a-noop', content: 'WAKE: no-op — nothing moved', metadata: { engine: 'agent', origin: 'schedule' } },
        { id: 'a-answer', content: 'We are at 5.08 tok/s; the bisect is on rung zf.', metadata: { engine: 'agent', origin: 'hook', ownerAskReply: true } },
      ])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('db down'));
    const wake = await buildOpenOwnerAsksWake(CHAT, { userId: 'u1', now: NOW });
    await flush();
    expect(wake.block).toContain('"where are we at"');
    expect(wake.block).not.toContain('any new progress');
    expect(wake.block).not.toContain('what are you doing');
    expect(wake.hideAskIds).toEqual(['d-answered', 'd-open', 'd-err']);
    expect(wake.reconciledAskIds).toEqual(['d-answered']);
    expect(mockCloseAskOnReply).toHaveBeenCalledTimes(1);
    expect(mockCloseAskOnReply).toHaveBeenCalledWith(CHAT, 'u1', { askMessageId: 'msg-cccccccc-3', replyMessageId: 'a-answer', source: 'reconcile' });
  });

  it('no userId → block + hide ids only, never a close', async () => {
    mockListOpenOwnerAsks.mockResolvedValue([ask({ id: 'd-answered', messageId: 'msg-cccccccc-3' })]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValueOnce([{ id: 'a1', content: 'answered', metadata: { engine: 'agent' } }]);
    const wake = await buildOpenOwnerAsksWake(CHAT, { now: NOW });
    expect(wake).toEqual({ block: '', hideAskIds: ['d-answered'], reconciledAskIds: [] });
    expect(mockCloseAskOnReply).not.toHaveBeenCalled();
  });

  it('findSupervisorReplyAfter returns the FIRST qualifying row id, null when none, and error:true on a failed read', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValueOnce([
      { id: 'a1', content: EMPTY_RUN_FALLBACK_NOTE, metadata: { engine: 'agent' } },
      { id: 'a2', content: 'first real answer', metadata: { engine: 'agent' } },
      { id: 'a3', content: 'second real answer', metadata: { engine: 'agent' } },
    ]);
    expect(await findSupervisorReplyAfter(CHAT, NOW)).toEqual({ replyId: 'a2' });
    mockPrisma.crossModelMessage.findMany.mockResolvedValueOnce([]);
    expect(await findSupervisorReplyAfter(CHAT, NOW)).toEqual({ replyId: null });
    mockPrisma.crossModelMessage.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await findSupervisorReplyAfter(CHAT, NOW)).toEqual({ replyId: null, error: true });
  });
});

describe('rewakeForUnansweredOwnerAsk', () => {
  const input = { chatId: CHAT, askMessageId: 'msg-871d203b-xxxx', askText: 'what is going on with the speed mission, it has been two days', askAt: new Date('2026-09-25T19:16:00Z'), reason: 'empty' as const };
  beforeEach(() => {
    redisStore.clear(); mockEnqueueDirectWake.mockClear(); mockRecordLoopMetric.mockClear();
  });

  it('enqueues ONE direct wake naming the ask + msg id, records owner_ask_rewake, and dedupes the second call on the same ask', async () => {
    expect(await rewakeForUnansweredOwnerAsk(input)).toBe(true);
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const call = mockEnqueueDirectWake.mock.calls[0][0];
    expect(call.targetChatId).toBe(CHAT);
    expect(call.prompt).toContain('[OWNER ASK UNANSWERED]');
    expect(call.prompt).toContain('"what is going on with the speed mission, it has been two days" (msg msg-871d)');
    expect(call.prompt).toContain('at 19:16Z');
    expect(call.prompt).toContain('cite msg msg-871d');
    expect(call.meta).toMatchObject({ origin: 'owner-asks', kind: 'owner_ask_unanswered', reason: 'empty' });
    expect(redisStore.has(OWNER_ASK_REWAKE_KEY(input.askMessageId))).toBe(true);
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_ask_rewake', sessionId: CHAT, meta: expect.objectContaining({ enqueued: true, reason: 'empty', askMessageId: 'msg-871d' }) }));
    // once per ask
    expect(await rewakeForUnansweredOwnerAsk(input)).toBe(false);
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
  });

  it('a hook refusal answers false and still records the row (enqueued:false)', async () => {
    mockEnqueueDirectWake.mockResolvedValueOnce({ ok: false, error: 'target chat not found' });
    expect(await rewakeForUnansweredOwnerAsk({ ...input, askMessageId: 'msg-other' })).toBe(false);
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_ask_rewake', meta: expect.objectContaining({ enqueued: false }) }));
  });

  it('renderOwnerAskRewakePrompt clips the ask and forbids sweeping before the answer', () => {
    const p = renderOwnerAskRewakePrompt({ askText: 'x'.repeat(400), askMessageId: 'abcdefgh-1', askAt: new Date('2026-09-25T19:16:00Z') });
    expect(p).toContain(`"${'x'.repeat(200)}" (msg abcdefgh) at 19:16Z`);
    expect(p).toContain('no sweep, no report-up, until it is answered');
  });
});

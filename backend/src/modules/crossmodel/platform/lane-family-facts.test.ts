/**
 * lane-family-facts (lane lifecycle C review fixer, 2026-10-21) pins: the
 * restore marker (written only while lane-retire is on), the live-descendant
 * walk (≤ 3 levels, unarchived only, a cycle never loops, a capped level or a
 * failed read answers null = blocking), and `restored:false` skipping the
 * marker read.
 */
type Row = Record<string, any>;
const chats: Row[] = [];
const runs: Row[] = [];
const schedules: Row[] = [];
const states: Row[] = [];
const webhooks: Row[] = [];
const hooks: Row[] = [];
const activities: Row[] = [];
const todos: Row[] = [];
const questions: Row[] = [];
const confirmations: Row[] = [];
const messages: Row[] = [];
const shares: Row[] = [];
const tickets: Row[] = [];
const store = new Map<string, unknown>();
const inList = (v: unknown, cond: any) => (cond?.in as unknown[]).includes(v);
const mockPrisma: any = {
  crossModelChat: {
    findMany: jest.fn(async ({ where, take, select }: any) => {
      if (where.parentChatId) return chats.filter((c) => inList(c.parentChatId, where.parentChatId) && !c.archivedAt).slice(0, take).map((c) => ({ id: c.id, parentChatId: c.parentChatId }));
      return chats.filter((c) => inList(c.id, where.id)).map((c) => (select?.titlePinned ? { id: c.id, titlePinned: !!c.titlePinned } : { id: c.id, userId: c.userId ?? 'u1', ...(select?.createdAt && c.createdAt ? { createdAt: c.createdAt } : {}) }));
    }),
  },
  agentRun: { findMany: jest.fn(async ({ where }: any) => runs.filter((r) => inList(r.sessionId, where.sessionId) && inList(r.status, where.status))) },
  chatWebhook: { findMany: jest.fn(async ({ where }: any) => webhooks.filter((w) => inList(w.chatId, where.chatId) && (where.isActive === undefined || w.isActive === where.isActive)).map((w) => ({ chatId: w.chatId }))) },
  eventHook: { findMany: jest.fn(async ({ where }: any) => hooks.filter((h) => inList(h.targetChatId, where.targetChatId) && h.enabled === where.enabled).map((h) => ({ targetChatId: h.targetChatId, createdVia: h.createdVia ?? null }))) },
  activity: {
    findMany: jest.fn(async ({ where, take }: any) => activities.filter((a) => inList(a.userId, where.userId) && (where.action?.in ? where.action.in.includes(a.action) : a.action === where.action) && a.createdAt >= where.createdAt.gte
      && (!where.OR || where.OR.some((o: any) => a.metadata?.chatId === o.metadata.equals))).slice(0, take).map((a) => ({ action: a.action, metadata: a.metadata, createdAt: a.createdAt }))),
  },
  projectTodo: { findMany: jest.fn(async ({ where }: any) => todos.filter((t) => inList(t.assigneeChatId, where.assigneeChatId) && inList(t.status, where.status))) },
  ownerQuestion: { findMany: jest.fn(async ({ where }: any) => questions.filter((q) => inList(q.chatId, where.chatId) && q.status === where.status)) },
  pendingConfirmation: { findMany: jest.fn(async ({ where }: any) => confirmations.filter((c) => inList(c.chatId, where.chatId) && c.status === where.status && c.expiresAt > where.expiresAt.gt)) },
  crossModelMessage: { findMany: jest.fn(async ({ where, take }: any) => messages.filter((m) => inList(m.chatId, where.chatId) && m.role === where.role && m.createdAt >= where.createdAt.gte).slice(0, take)) },
  chatShareLink: { findMany: jest.fn(async ({ where }: any) => shares.filter((x) => inList(x.chatId, where.chatId))) },
  userFeatureRequest: { findMany: jest.fn(async ({ where }: any) => tickets.filter((t) => inList(t.status, where.status) && where.OR.some((o: any) => t.context?.dispatchedTo === o.context.equals))) },
  codingSchedule: { findMany: jest.fn(async ({ where }: any) => schedules.filter((s) => inList(s.sessionId, where.sessionId) && s.enabled)) },
  chatCodingState: { findMany: jest.fn(async ({ where }: any) => states.filter((s) => inList(s.id, where.id) && inList(s.status, where.status))) },
};
const mockStoreGetMany = jest.fn(async (ns: string[], keys: string[]) => {
  const out = new Map<string, unknown>();
  for (const k of keys) { const v = store.get(`${ns.join(':')}|${k}`); if (v !== undefined) out.set(k, v); }
  return out;
});
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storePut: jest.fn(async (ns: string[], key: string, value: unknown) => { store.set(`${ns.join(':')}|${key}`, value); }),
  storeGetMany: (...a: any[]) => (mockStoreGetMany as any)(...a),
}));

import {
  readLaneFamilyFacts, rememberLaneRestore, readRestoreAuditChats, readInboundIntegrations, readLaneKeepReasons, laneRestoreMarkerReadersOff, readAllLaneKeepReasons,
  LANE_FAMILY_ROWS_CAP, LANE_RESTORE_AUDIT_ROWS_CAP, LANE_HUMAN_ROWS_CAP, LANE_RESTORE_AUDIT_LOOKBACK_MS, readRestoredChats,
} from './lane-family-facts';

const NOW = new Date('2026-10-21T20:00:00Z');
const D = 86400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * D);

beforeEach(() => {
  jest.clearAllMocks();
  for (const a of [chats, runs, schedules, states, webhooks, hooks, activities, todos, questions, confirmations, messages, shares, tickets]) a.length = 0;
  store.clear();
  for (const k of ['LANE_IDLE_RETIRE_DISABLED', 'ARCHIVE_CASCADE_DISABLED', 'TICKET_LANE_ARCHIVE_GAPS_DISABLED', 'PLATFORM_ENGINEER_CHAT_ID']) delete process.env[k];
});

describe('readLaneFamilyFacts', () => {
  it('live = a descendant ≤ 3 levels down with a live run / enabled schedule / running satellite; archived and too-deep descendants do not count', async () => {
    chats.push(
      { id: 'a1', parentChatId: 'A' }, { id: 'a2', parentChatId: 'a1' }, { id: 'a3', parentChatId: 'a2' }, { id: 'a4', parentChatId: 'a3' },
      { id: 'b1', parentChatId: 'B', archivedAt: new Date() },
      { id: 'c1', parentChatId: 'C' },
    );
    runs.push({ sessionId: 'a4', status: 'running' }, { sessionId: 'b1', status: 'running' }, { sessionId: 'c1', status: 'completed' });
    let f = await readLaneFamilyFacts(['A', 'B', 'C']);
    expect([...f!.liveRoots]).toEqual([]); // a4 is level 4, b1 archived, c1 finished
    states.push({ id: 'a3', status: 'provisioning' });
    schedules.push({ sessionId: 'c1', enabled: true });
    f = await readLaneFamilyFacts(['A', 'B', 'C']);
    expect([...f!.liveRoots].sort()).toEqual(['A', 'C']);
  });

  it('the restore marker counts on the chat itself or a descendant; restored:false never reads the store', async () => {
    chats.push({ id: 'k1', parentChatId: 'K' });
    await rememberLaneRestore('k1', { cascade: true });
    await rememberLaneRestore('M', {});
    const f = await readLaneFamilyFacts(['K', 'M', 'N']);
    expect([...f!.restoredRoots].sort()).toEqual(['K', 'M']);
    mockStoreGetMany.mockClear();
    expect([...(await readLaneFamilyFacts(['K'], { restored: false }))!.restoredRoots]).toEqual([]);
    expect(mockStoreGetMany).not.toHaveBeenCalled();
  });

  it('a cycle never loops; a capped level, a failed liveness read or a failed marker read answers null (blocking)', async () => {
    chats.push({ id: 'x1', parentChatId: 'X' }, { id: 'X', parentChatId: 'x1' });
    expect(await readLaneFamilyFacts(['X'])).not.toBeNull();
    mockPrisma.crossModelChat.findMany.mockResolvedValueOnce(Array.from({ length: LANE_FAMILY_ROWS_CAP }, (_, i) => ({ id: `k${i}`, parentChatId: 'X' })));
    expect(await readLaneFamilyFacts(['X'])).toBeNull();
    mockPrisma.codingSchedule.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await readLaneFamilyFacts(['X'])).toBeNull();
    mockStoreGetMany.mockRejectedValueOnce(new Error('down'));
    expect(await readLaneFamilyFacts(['X'])).toBeNull();
  });
});

describe('rememberLaneRestore', () => {
  it('writes {at, source, actorChatId, cascade}; nothing only when EVERY reader is off (LANE_IDLE_RETIRE_DISABLED + ARCHIVE_CASCADE_DISABLED + TICKET_LANE_ARCHIVE_GAPS_DISABLED)', async () => {
    const at = new Date('2026-10-21T20:00:00Z');
    await rememberLaneRestore('c-1', { source: 'session_api', actorChatId: 'ps-1' }, at);
    expect(store.get('lane-lifecycle:restored|c-1')).toEqual({ at: at.toISOString(), source: 'session_api', actorChatId: 'ps-1', cascade: false });
    // REPRO (finding 12): LANE_IDLE_RETIRE_DISABLED=1 alone still records the restore —
    // the ticket drain and a machine cascade read it, and lane-retire reads it once re-enabled.
    process.env.LANE_IDLE_RETIRE_DISABLED = '1';
    await rememberLaneRestore('c-2', {});
    expect(store.has('lane-lifecycle:restored|c-2')).toBe(true);
    process.env.ARCHIVE_CASCADE_DISABLED = '1';
    expect(laneRestoreMarkerReadersOff()).toBe(false);
    process.env.TICKET_LANE_ARCHIVE_GAPS_DISABLED = '1';
    expect(laneRestoreMarkerReadersOff()).toBe(true);
    await rememberLaneRestore('c-3', {});
    expect(store.has('lane-lifecycle:restored|c-3')).toBe(false);
  });
});

describe('readRestoreAuditChats (second review fixer)', () => {
  it('a chat.restore newer than the chat\'s newest chat.archive counts (no archive row counts too); an archive after the restore does not; other owners\' rows never match', async () => {
    chats.push({ id: 'a', userId: 'u1' }, { id: 'b', userId: 'u1' }, { id: 'c', userId: 'u1' }, { id: 'd', userId: 'u1' });
    activities.push(
      { userId: 'u1', action: 'chat.archive', createdAt: ago(4), metadata: { chatId: 'a' } }, { userId: 'u1', action: 'chat.restore', createdAt: ago(2), metadata: { chatId: 'a' } },
      { userId: 'u1', action: 'chat.restore', createdAt: ago(4), metadata: { chatId: 'b' } }, { userId: 'u1', action: 'chat.archive', createdAt: ago(2), metadata: { chatId: 'b' } },
      { userId: 'u1', action: 'chat.restore', createdAt: ago(9), metadata: { chatId: 'c' } },
      { userId: 'u2', action: 'chat.restore', createdAt: ago(1), metadata: { chatId: 'd' } },
    );
    expect([...(await readRestoreAuditChats(['a', 'b', 'c', 'd'], NOW))!].sort()).toEqual(['a', 'c']);
    // Third review (2026-10-22): ONE read, restricted in SQL to the ASKED chats (never every restore the owner made,
    // filtered in JS) — both actions, the 180-day window, the chatIds as JSON-path equalities.
    expect(mockPrisma.activity.findMany).toHaveBeenCalledTimes(1);
    const read = mockPrisma.activity.findMany.mock.calls[0][0];
    expect(read.where).toEqual({
      userId: { in: ['u1'] }, resource: 'platform', action: { in: ['chat.restore', 'chat.archive'] }, createdAt: { gte: new Date(NOW.getTime() - LANE_RESTORE_AUDIT_LOOKBACK_MS) },
      OR: ['a', 'b', 'c', 'd'].map((id) => ({ metadata: { path: ['chatId'], equals: id } })),
    });
    expect(read.take).toBe(LANE_RESTORE_AUDIT_ROWS_CAP);
  });

  it('a full page or a failed read answers null (blocking); the family read with restoreAudit folds it in under the root', async () => {
    chats.push({ id: 'P', userId: 'u1' }, { id: 'k', userId: 'u1', parentChatId: 'P' });
    activities.push({ userId: 'u1', action: 'chat.restore', createdAt: ago(1), metadata: { chatId: 'k' } });
    expect([...(await readLaneFamilyFacts(['P'], { restoreAudit: true, now: NOW }))!.restoredRoots]).toEqual(['P']);
    expect([...(await readLaneFamilyFacts(['P'], { now: NOW }))!.restoredRoots]).toEqual([]); // marker only
    // Third review (2026-10-22): a FULL page reads restored for ITS chunk's chats only (fail-safe) — never null for the whole pass.
    mockPrisma.activity.findMany.mockResolvedValueOnce(Array.from({ length: LANE_RESTORE_AUDIT_ROWS_CAP }, () => ({ action: 'chat.archive', metadata: { chatId: 'x' }, createdAt: ago(1) })));
    expect([...(await readRestoreAuditChats(['P'], NOW))!]).toEqual(['P']);
    mockPrisma.activity.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await readRestoreAuditChats(['P'], NOW)).toBeNull();
    mockPrisma.activity.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await readLaneFamilyFacts(['P'], { restoreAudit: true, now: NOW })).toBeNull();
  });

  it('REPRO (third review 2026-10-22): a capped chunk can no longer block the whole pass — 201 asked chats read in two chunks; the first chunk\'s page is full (its 200 chats read restored, kept), the second chunk is still judged on its own rows', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `k${String(i).padStart(3, '0')}`);
    for (const id of ids) chats.push({ id, userId: 'u1' });
    activities.push({ userId: 'u1', action: 'chat.archive', createdAt: ago(3), metadata: { chatId: 'k200' } });
    mockPrisma.activity.findMany.mockResolvedValueOnce(Array.from({ length: LANE_RESTORE_AUDIT_ROWS_CAP }, () => ({ action: 'chat.restore', metadata: { chatId: 'k000' }, createdAt: ago(1) })));
    const out = await readRestoreAuditChats(ids, NOW);
    expect(out).not.toBeNull();
    expect(out!.size).toBe(200);
    expect(out!.has('k199')).toBe(true);
    expect(out!.has('k200')).toBe(false); // the second chunk: archived, never restored
    expect(mockPrisma.activity.findMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.activity.findMany.mock.calls[1][0].where.OR).toEqual([{ metadata: { path: ['chatId'], equals: 'k200' } }]);
  });
});

describe('readRestoredChats (third review 2026-10-22 — the run-reaper\'s marker read)', () => {
  it('answers the asked chats that carry the restore marker; a failed read answers null; nothing is read while every marker reader switch is off (no marker is written then)', async () => {
    await rememberLaneRestore('r-1', {});
    expect([...(await readRestoredChats(['r-1', 'r-2']))!]).toEqual(['r-1']);
    mockStoreGetMany.mockRejectedValueOnce(new Error('down'));
    expect(await readRestoredChats(['r-1'])).toBeNull();
    // The wave's one switch parser: 'true' turns each reader off too.
    process.env.LANE_IDLE_RETIRE_DISABLED = 'true';
    process.env.ARCHIVE_CASCADE_DISABLED = 'on';
    process.env.TICKET_LANE_ARCHIVE_GAPS_DISABLED = 'true';
    expect(laneRestoreMarkerReadersOff()).toBe(true);
    mockStoreGetMany.mockClear();
    expect([...(await readRestoredChats(['r-1']))!]).toEqual([]);
    expect(mockStoreGetMany).not.toHaveBeenCalled();
  });
});

describe('readInboundIntegrations (second review fixer)', () => {
  it('an ACTIVE ChatWebhook or an ENABLED non-system hook targeting the chat; a legacy hook (no createdVia) counts; a failed read answers null', async () => {
    webhooks.push({ chatId: 'w', isActive: true }, { chatId: 'w-off', isActive: false });
    hooks.push(
      { targetChatId: 'h', enabled: true, createdVia: 'tool:hook_subscribe' }, { targetChatId: 'h-legacy', enabled: true, createdVia: null },
      { targetChatId: 'h-sys', enabled: true, createdVia: 'system:direct-wake' }, { targetChatId: 'h-off', enabled: false, createdVia: 'rest' },
    );
    expect([...(await readInboundIntegrations(['w', 'w-off', 'h', 'h-legacy', 'h-sys', 'h-off']))!].sort()).toEqual(['h', 'h-legacy', 'w']);
    mockPrisma.eventHook.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await readInboundIntegrations(['w'])).toBeNull();
  });
});

describe('readLaneKeepReasons (second review fixer)', () => {
  it('the first rule that keeps each lane, in the fixed order; `legs` narrows the reads; any failed read answers null', async () => {
    const ids = ['live', 'kid', 'restored', 'todo', 'owner', 'human', 'shared', 'pinned', 'wired', 'ticket', 'standing', 'free'];
    for (const id of ids) chats.push({ id, userId: 'u1', titlePinned: id === 'pinned' });
    runs.push({ sessionId: 'live', status: 'interrupted' }, { sessionId: 'free', status: 'completed' });
    chats.push({ id: 'kid-1', userId: 'u1', parentChatId: 'kid' });
    schedules.push({ sessionId: 'kid-1', enabled: true });
    await rememberLaneRestore('restored', {});
    todos.push({ assigneeChatId: 'todo', status: 'blocked' });
    questions.push({ chatId: 'owner', status: 'open' });
    messages.push({ chatId: 'human', role: 'user', createdAt: ago(13), metadata: { origin: 'telegram' } }, { chatId: 'free', role: 'user', createdAt: ago(1), metadata: { origin: 'agent' } });
    shares.push({ chatId: 'shared', isActive: true, expiresAt: null }, { chatId: 'free', isActive: true, expiresAt: ago(1) });
    webhooks.push({ chatId: 'wired', isActive: true });
    tickets.push({ status: 'awaiting_verification', context: { dispatchedTo: 'ticket' } });
    process.env.PLATFORM_ENGINEER_CHAT_ID = 'standing';
    const all = await readLaneKeepReasons(ids, { now: NOW });
    expect(Object.fromEntries(all!)).toEqual({
      live: 'live_run', kid: 'live_child', restored: 'owner_restored', todo: 'open_todos', owner: 'awaiting_owner', human: 'human_recent',
      shared: 'share_link', pinned: 'title_pinned', wired: 'inbound_integration', ticket: 'ticket_owned', standing: 'standing_lane',
    });
    // narrowed: only the asked legs run (no family / run / message reads)
    jest.clearAllMocks();
    const narrow = await readLaneKeepReasons(ids, { legs: ['share_link', 'title_pinned'], now: NOW });
    expect(Object.fromEntries(narrow!)).toEqual({ shared: 'share_link', pinned: 'title_pinned' });
    expect(mockPrisma.agentRun.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
    // a 13-day-old human row is outside a 7-day window
    expect((await readLaneKeepReasons(['human'], { legs: ['human_recent'], humanWindowMs: 7 * D, now: NOW }))!.size).toBe(0);
    // a full human-row page reads human for every lane (fail-safe)
    mockPrisma.crossModelMessage.findMany.mockResolvedValueOnce(Array.from({ length: LANE_HUMAN_ROWS_CAP }, () => ({ chatId: 'x', metadata: { origin: 'agent' } })));
    expect(Object.fromEntries((await readLaneKeepReasons(['free'], { legs: ['human_recent'], now: NOW }))!)).toEqual({ free: 'human_recent' });
    mockPrisma.ownerQuestion.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await readLaneKeepReasons(['free'], { now: NOW })).toBeNull();
  });
});

describe('fifth review (2026-10-22) — the restore-audit scan starts at the asked chats\' creation, never 180 days back for a young lane', () => {
  it('REPRO (DB load): the read starts a day before the OLDEST asked chat of the chunk was created; a restore after creation is still found; an archive after it still wins', async () => {
    chats.push({ id: 'young', userId: 'u1', createdAt: ago(3) }, { id: 'older', userId: 'u1', createdAt: ago(5) }, { id: 'back', userId: 'u1', createdAt: ago(4) });
    activities.push(
      { userId: 'u1', action: 'chat.archive', createdAt: ago(2.5), metadata: { chatId: 'young' } }, { userId: 'u1', action: 'chat.restore', createdAt: ago(2), metadata: { chatId: 'young' } },
      { userId: 'u1', action: 'chat.restore', createdAt: ago(3), metadata: { chatId: 'back' } }, { userId: 'u1', action: 'chat.archive', createdAt: ago(1), metadata: { chatId: 'back' } },
    );
    expect([...(await readRestoreAuditChats(['young', 'older', 'back'], NOW))!]).toEqual(['young']);
    expect(mockPrisma.activity.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.activity.findMany.mock.calls[0][0].where.createdAt).toEqual({ gte: new Date(ago(5).getTime() - 86400_000) });
  });

  it('a chunk with a chat of UNKNOWN creation time, or one older than the lookback, reads the full lookback (never a narrower window than the 180 days)', async () => {
    chats.push({ id: 'known', userId: 'u1', createdAt: ago(2) }, { id: 'unknown', userId: 'u1' });
    await readRestoreAuditChats(['known', 'unknown'], NOW);
    expect(mockPrisma.activity.findMany.mock.calls[0][0].where.createdAt).toEqual({ gte: new Date(NOW.getTime() - LANE_RESTORE_AUDIT_LOOKBACK_MS) });
    chats.push({ id: 'ancient', userId: 'u1', createdAt: ago(400) });
    await readRestoreAuditChats(['ancient'], NOW);
    expect(mockPrisma.activity.findMany.mock.calls[1][0].where.createdAt).toEqual({ gte: new Date(NOW.getTime() - LANE_RESTORE_AUDIT_LOOKBACK_MS) });
  });
});

describe('fourth review (2026-10-22) — every rule per lane; a per-pass restore-audit memo', () => {
  it('readAllLaneKeepReasons answers EVERY rule keeping a lane in LANE_KEEP_REASONS order — a RESTORED lane with a live descendant reads [live_child, owner_restored] (readLaneKeepReasons still reports the first)', async () => {
    chats.push({ id: 'R', userId: 'u1' }, { id: 'R-kid', userId: 'u1', parentChatId: 'R' }, { id: 'F', userId: 'u1' });
    schedules.push({ sessionId: 'R-kid', enabled: true });
    await rememberLaneRestore('R', {});
    questions.push({ chatId: 'R', status: 'open' });
    const all = await readAllLaneKeepReasons(['R', 'F'], { now: NOW });
    expect(Object.fromEntries(all!)).toEqual({ R: ['live_child', 'owner_restored', 'awaiting_owner'] });
    expect(Object.fromEntries((await readLaneKeepReasons(['R', 'F'], { now: NOW }))!)).toEqual({ R: 'live_child' });
    mockPrisma.ownerQuestion.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await readAllLaneKeepReasons(['R'], { now: NOW })).toBeNull();
  });

  it('readRestoreAuditChats with a cache reads only the ids the cache lacks, fills it (restored and not), answers cached ids without a read, and never caches a failed read', async () => {
    chats.push({ id: 'a', userId: 'u1' }, { id: 'b', userId: 'u1' }, { id: 'c', userId: 'u1' });
    activities.push({ userId: 'u1', action: 'chat.restore', createdAt: ago(1), metadata: { chatId: 'a' } });
    const cache = new Map<string, boolean>();
    expect([...(await readRestoreAuditChats(['a', 'b'], NOW, cache))!]).toEqual(['a']);
    expect(Object.fromEntries(cache)).toEqual({ a: true, b: false });
    expect(mockPrisma.activity.findMany).toHaveBeenCalledTimes(1);
    // a second site of the same pass: a and b come from the memo, only c is read
    expect([...(await readRestoreAuditChats(['a', 'b', 'c'], NOW, cache))!]).toEqual(['a']);
    expect(mockPrisma.activity.findMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.activity.findMany.mock.calls[1][0].where.OR).toEqual([{ metadata: { path: ['chatId'], equals: 'c' } }]);
    // everything cached: no read at all (not even the owner read)
    mockPrisma.crossModelChat.findMany.mockClear();
    expect([...(await readRestoreAuditChats(['a', 'c'], NOW, cache))!]).toEqual(['a']);
    expect(mockPrisma.activity.findMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
    // a failed read answers null and caches nothing
    chats.push({ id: 'd', userId: 'u1' });
    mockPrisma.activity.findMany.mockRejectedValueOnce(new Error('down'));
    expect(await readRestoreAuditChats(['d'], NOW, cache)).toBeNull();
    expect(cache.has('d')).toBe(false);
    // the family read threads the memo through (restoreAuditCache)
    const famCache = new Map<string, boolean>([['a', true]]);
    mockPrisma.activity.findMany.mockClear();
    expect([...(await readLaneFamilyFacts(['a'], { restoreAudit: true, restoreAuditCache: famCache, now: NOW }))!.restoredRoots]).toEqual(['a']);
    expect(mockPrisma.activity.findMany).not.toHaveBeenCalled();
  });
});

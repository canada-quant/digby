/**
 * lane-retire (lane lifecycle C1, 2026-10-21) pins, over an in-memory fixture
 * world behind a mocked Prisma client:
 *   - evaluateLaneRetire: every skip reason, in its fixed order, and eligible;
 *   - proveMachineSpawned p1–p4 (and what is NOT proof: titleSource
 *     'spawn-param' alone, a REST/API-made chat whose first message reads
 *     'user', a session delegation with origin 'user');
 *   - gatherLaneRetireFacts: idle = newest run / message / receipt / creation
 *     (never chat.updatedAt), a failed leg reads BLOCKING;
 *   - retireIdleLanes: archives only proven idle lanes through archiveChat
 *     (source 'lane_retire'), ≤ 25 per pass, one lane_retired row per archive
 *     + one per pass, the rotating window, a 4xx refusal is a skip, and
 *     LANE_IDLE_RETIRE_DISABLED=1 archives nothing;
 *   - review fixer (2026-10-21): a RESTORED lane is never archived again (the
 *     restore marker, on it or a descendant), an open todo of ANY project, an
 *     open owner question / pending confirmation and a LIVE descendant keep a
 *     lane, and collectRetireCandidates walks the project's coding lanes by id
 *     past the placement index's 200 newest chats.
 */
type Row = Record<string, any>;
const world: {
  chats: Row[]; states: Row[]; runs: Row[]; schedules: Row[]; shares: Row[]; tickets: Row[]; messages: Row[]; receipts: Row[]; tasks: Row[]; projects: Row[];
  todos: Row[]; questions: Row[]; confirmations: Row[]; webhooks: Row[]; hooks: Row[]; activities: Row[];
} = { chats: [], states: [], runs: [], schedules: [], shares: [], tickets: [], messages: [], receipts: [], tasks: [], projects: [], todos: [], questions: [], confirmations: [], webhooks: [], hooks: [], activities: [] };
/** The context store (the restore marker), keyed "<namespace>|<key>". */
const store = new Map<string, unknown>();
const fail = new Set<string>();

const inList = (v: unknown, cond: any): boolean => (cond && typeof cond === 'object' && 'in' in cond ? (cond.in as unknown[]).includes(v) : v === cond);
const ctxMatch = (ctx: any, c: any): boolean => {
  const key = c.path[0];
  if ('equals' in c) return ctx?.[key] === c.equals;
  if ('array_contains' in c) return Array.isArray(ctx?.[key]) && c.array_contains.every((x: unknown) => ctx[key].includes(x));
  return false;
};
const guard = (name: string) => { if (fail.has(name)) throw new Error(`${name} down`); };
const groupMax = (rows: Row[], key: string, field: string) => {
  const m = new Map<string, Date>();
  for (const r of rows) { const cur = m.get(r[key]); if (!cur || r[field] > cur) m.set(r[key], r[field]); }
  return [...m.entries()].map(([k, v]) => ({ [key]: k, _max: { [field]: v } }));
};

const mockPrisma: any = {
  crossModelChat: {
    findMany: jest.fn(async ({ where }: any) => {
      if (where.parentChatId) { guard('family'); return world.chats.filter((c) => inList(c.parentChatId, where.parentChatId) && !c.archivedAt).map((c) => ({ id: c.id, parentChatId: c.parentChatId })); }
      guard('chats');
      return world.chats.filter((c) => inList(c.id, where.id) && (where.archivedAt === undefined || (where.archivedAt === null ? !c.archivedAt : true))).map((c) => ({ ...c }));
    }),
    findUnique: jest.fn(async ({ where }: any) => { const c = world.chats.find((x) => x.id === where.id); return c ? { ...c } : null; }),
  },
  chatCodingState: { findMany: jest.fn(async ({ where }: any) => { guard(where.status ? 'familyStates' : 'states'); return world.states.filter((s) => inList(s.id, where.id) && (!where.status || inList(s.status, where.status))); }) },
  agentRun: {
    findMany: jest.fn(async ({ where }: any) => { guard('liveRuns'); return world.runs.filter((r) => inList(r.sessionId, where.sessionId) && inList(r.status, where.status)); }),
    groupBy: jest.fn(async ({ where }: any) => { guard('runMax'); return groupMax(world.runs.filter((r) => inList(r.sessionId, where.sessionId)), 'sessionId', 'updatedAt'); }),
  },
  codingSchedule: {
    findMany: jest.fn(async ({ where }: any) => { guard('familySchedules'); return world.schedules.filter((x) => inList(x.sessionId, where.sessionId) && x.enabled).map((x) => ({ sessionId: x.sessionId })); }),
    groupBy: jest.fn(async ({ where }: any) => {
      guard('schedules');
      const m = new Map<string, number>();
      for (const s of world.schedules.filter((x) => inList(x.sessionId, where.sessionId) && x.enabled)) m.set(s.sessionId, (m.get(s.sessionId) ?? 0) + 1);
      return [...m.entries()].map(([sessionId, n]) => ({ sessionId, _count: { _all: n } }));
    }),
  },
  chatShareLink: { findMany: jest.fn(async ({ where }: any) => { guard('shares'); return world.shares.filter((s) => inList(s.chatId, where.chatId)); }) },
  userFeatureRequest: {
    findMany: jest.fn(async ({ where }: any) => {
      guard(where.status ? 'owning' : 'p2');
      return world.tickets.filter((t) => (!where.status || inList(t.status, where.status)) && where.OR.some((c: any) => ctxMatch(t.context, c.context))).map((t) => ({ context: t.context }));
    }),
  },
  crossModelMessage: {
    groupBy: jest.fn(async ({ where }: any) => { guard('msgMax'); return groupMax(world.messages.filter((m) => inList(m.chatId, where.chatId)), 'chatId', 'createdAt'); }),
    findMany: jest.fn(async ({ where, take }: any) => {
      guard('userRows');
      return world.messages.filter((m) => inList(m.chatId, where.chatId) && m.role === where.role && m.createdAt >= where.createdAt.gte).slice(0, take).map((m) => ({ chatId: m.chatId, metadata: m.metadata }));
    }),
    findFirst: jest.fn(async ({ where }: any) => {
      guard('p4');
      const rows = world.messages.filter((m) => m.chatId === where.chatId && m.role === where.role).sort((a, b) => a.createdAt - b.createdAt);
      return rows[0] ? { metadata: rows[0].metadata } : null;
    }),
  },
  runToolReceipt: { groupBy: jest.fn(async ({ where }: any) => { guard('receiptMax'); return groupMax(world.receipts.filter((r) => inList(r.chatId, where.chatId)), 'chatId', 'createdAt'); }) },
  delegationTask: {
    findMany: jest.fn(async ({ where }: any) => {
      guard('p1');
      return world.tasks.filter((t) => inList(t.childChatId, where.childChatId) && where.OR.some((c: any) => t.kind === c.kind && (c.origin === undefined || t.origin === c.origin)));
    }),
  },
  projectTodo: { findMany: jest.fn(async ({ where }: any) => { guard('todos'); return world.todos.filter((t) => inList(t.assigneeChatId, where.assigneeChatId) && inList(t.status, where.status)).map((t) => ({ assigneeChatId: t.assigneeChatId })); }) },
  ownerQuestion: { findMany: jest.fn(async ({ where }: any) => { guard('questions'); return world.questions.filter((q) => inList(q.chatId, where.chatId) && q.status === where.status).map((q) => ({ chatId: q.chatId })); }) },
  pendingConfirmation: {
    findMany: jest.fn(async ({ where }: any) => {
      guard('confirmations');
      return world.confirmations.filter((c) => inList(c.chatId, where.chatId) && c.status === where.status && c.expiresAt > where.expiresAt.gt).map((c) => ({ chatId: c.chatId }));
    }),
  },
  // Second review fixer (2026-10-21): inbound integrations + the restore audit.
  chatWebhook: { findMany: jest.fn(async ({ where }: any) => { guard('webhooks'); return world.webhooks.filter((w) => inList(w.chatId, where.chatId) && (where.isActive === undefined || w.isActive === where.isActive)).map((w) => ({ chatId: w.chatId })); }) },
  eventHook: { findMany: jest.fn(async ({ where }: any) => { guard('hooks'); return world.hooks.filter((h) => inList(h.targetChatId, where.targetChatId) && h.enabled === where.enabled).map((h) => ({ targetChatId: h.targetChatId, createdVia: h.createdVia ?? null })); }) },
  activity: {
    findMany: jest.fn(async ({ where, take }: any) => {
      guard('activity');
      // Third review (2026-10-22): ONE read per chunk of asked chats — both actions (action IN), the chunk's chatIds as JSON-path ORs.
      return world.activities.filter((a) => inList(a.userId, where.userId) && (where.action?.in ? where.action.in.includes(a.action) : a.action === where.action) && a.createdAt >= where.createdAt.gte
        && (!where.OR || where.OR.some((o: any) => a.metadata?.chatId === o.metadata.equals)))
        .sort((x, y) => y.createdAt - x.createdAt).slice(0, take).map((a) => ({ action: a.action, metadata: a.metadata, createdAt: a.createdAt }));
    }),
  },
  crossModelProject: {
    findMany: jest.fn(async ({ where }: any) => {
      guard('folders');
      if (where.archivedAt) return world.projects.filter((p) => p.archivedAt && where.OR.some((o: any) => o.userId === p.userId)).map((p) => ({ id: p.id, path: `/${p.id}` }));
      return [];
    }),
  },
};
const mockArchiveChat = jest.fn(async (opts: any) => {
  const c = world.chats.find((x) => x.id === opts.chatId);
  if (c) c.archivedAt = new Date();
  return { id: opts.chatId, archived: true };
});
const mockRecordLoopMetric = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), LOOP_METRIC_KINDS: { LANE_RETIRED: 'lane_retired' } }));
jest.mock('./decision-gate', () => ({ __esModule: true, decide: jest.fn(), decisionMode: jest.fn(() => 'shadow'), decisionThreshold: (_p: string, f: number) => f, stashDecision: jest.fn() }));
jest.mock('./platform.service', () => ({ __esModule: true, archiveChat: (...a: any[]) => (mockArchiveChat as any)(...a) }));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storePut: jest.fn(async (ns: string[], key: string, value: unknown) => { store.set(`${ns.join(':')}|${key}`, value); }),
  storeGetMany: jest.fn(async (ns: string[], keys: string[]) => {
    guard('store');
    const out = new Map<string, unknown>();
    for (const k of keys) { const v = store.get(`${ns.join(':')}|${k}`); if (v !== undefined) out.set(k, v); }
    return out;
  }),
}));

import {
  evaluateLaneRetire, proveMachineSpawned, gatherLaneRetireFacts, previewLaneRetire, retireIdleLanes, archiveIdleLane, rotateRetireWindow,
  isHumanUserRow, __resetLaneRetireCursorForTests, __resetLaneRetireScanCursorsForTests, collectRetireCandidates,
  LANE_RETIRE_MAX_PER_PASS, LANE_RETIRE_SCAN_MAX_PAGES, LANE_RETIRE_IDLE_MS, type LaneRetireFacts,
} from './lane-retire';
import { rememberLaneRestore } from './lane-family-facts';
import * as sessionTopology from './session-topology';
import type { LaneIndexRow } from './session-topology';

const NOW = new Date('2026-10-21T19:00:00Z');
const D = 86400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * D);
const lane = (laneId: string, over: Partial<LaneIndexRow> = {}): LaneIndexRow => ({
  laneId, title: `Lane ${laneId}`, charterGoalId: null, charterTodoIds: [], goalIds: [], planGoal: null, ageDays: 20, runs14d: 0, running: false,
  enabledSchedules: 0, busySkips24h: 0, compactionsPerRun: 0, goalsHeld: 0, lastMutatingReceiptAgeSec: null, worktreeBranch: null, parentChatId: null,
  isSupervisor: false, isCoding: true, charterOpen: false, titlePinned: false, ...over,
});
const facts = (over: Partial<LaneRetireFacts> = {}): LaneRetireFacts => ({
  isSupervisor: false, satelliteStatus: 'ready', liveRun: false, enabledSchedules: 0, liveDescendant: false, openTodos: false, awaitingOwner: false,
  titlePinned: false, ownerRestored: false, archivedFolder: false, shareLinkActive: false, inboundIntegration: false,
  standingLane: false, ticketOwned: false, lastActivityAt: ago(10), humanRecent: false, proof: 'p2:dispatched_to', projectId: 'proj-1', parentChatId: null, userId: 'u1', ...over,
});

/** A proven (ticket-lane) idle chat in the world. */
function seedLane(id: string, over: Row = {}): void {
  world.chats.push({ id, userId: 'u1', projectId: 'proj-1', parentChatId: null, isSupervisor: false, isProjectSupervisor: false, titlePinned: false, createdAt: ago(20), archivedAt: null, ...over });
  world.states.push({ id, status: 'ready', titleSource: 'spawn-param' });
  world.runs.push({ sessionId: id, status: 'completed', updatedAt: ago(9) });
  world.messages.push({ chatId: id, role: 'user', createdAt: ago(19), metadata: { origin: 'agent' } });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(world) as Array<keyof typeof world>) world[k] = [];
  store.clear();
  fail.clear();
  delete process.env.LANE_IDLE_RETIRE_DISABLED;
  delete process.env.PLATFORM_ENGINEER_CHAT_ID;
  __resetLaneRetireCursorForTests();
  __resetLaneRetireScanCursorsForTests();
});

describe('evaluateLaneRetire (pure)', () => {
  it('eligible only when no rule applies', () => {
    expect(evaluateLaneRetire(lane('a'), facts(), NOW)).toEqual({ eligible: true, reason: 'eligible' });
  });
  it('skip reasons, each on its own, in the fixed order', () => {
    const cases: Array<[string, Partial<LaneIndexRow>, Partial<LaneRetireFacts>]> = [
      ['supervisor', { isSupervisor: true }, {}],
      ['supervisor', {}, { isSupervisor: true }],
      ['running', { running: true }, {}],
      ['running', {}, { liveRun: true }],
      ['running', {}, { satelliteStatus: 'provisioning' }],
      ['schedule', { enabledSchedules: 1 }, {}],
      ['schedule', {}, { enabledSchedules: 2 }],
      ['live_child', {}, { liveDescendant: true }],
      ['charter_open', { charterOpen: true }, {}],
      ['open_todos', { goalIds: ['g'] }, {}],
      ['open_todos', {}, { openTodos: true }],
      ['awaiting_owner', {}, { awaitingOwner: true }],
      ['title_pinned', { titlePinned: true }, {}],
      ['owner_restored', {}, { ownerRestored: true }],
      ['archived_folder', {}, { archivedFolder: true }],
      ['share_link', {}, { shareLinkActive: true }],
      ['standing_lane', {}, { standingLane: true }],
      ['ticket_owned', {}, { ticketOwned: true }],
      ['not_idle', {}, { lastActivityAt: ago(6.9) }],
      ['not_idle', {}, { lastActivityAt: null }],
      ['human_recent', {}, { humanRecent: true }],
      ['owner_created', {}, { proof: null }],
    ];
    for (const [reason, l, f] of cases) expect(evaluateLaneRetire(lane('a', l), facts(f), NOW)).toEqual({ eligible: false, reason });
    // order: a supervisor that is also running and scheduled reads 'supervisor'; a scheduled, pinned lane reads 'schedule'
    expect(evaluateLaneRetire(lane('a', { isSupervisor: true, running: true, enabledSchedules: 1 }), facts(), NOW).reason).toBe('supervisor');
    expect(evaluateLaneRetire(lane('a', { enabledSchedules: 1, titlePinned: true }), facts({ proof: null }), NOW).reason).toBe('schedule');
  });
  it('a human row is any user row whose origin is not a machine origin (missing, user, a human channel)', () => {
    expect(isHumanUserRow(null)).toBe(true);
    expect(isHumanUserRow({})).toBe(true);
    expect(isHumanUserRow({ origin: 'user' })).toBe(true);
    expect(isHumanUserRow({ origin: 'telegram' })).toBe(true);
    expect(isHumanUserRow({ origin: 'owner' })).toBe(true);
    for (const o of ['agent', 'webhook', 'schedule', 'hook', 'machine']) expect(isHumanUserRow({ origin: o })).toBe(false);
  });
});

describe('proveMachineSpawned (p1–p4)', () => {
  it('each proof, with p1 > p2 > p3 > p4 precedence; titleSource spawn-param alone, an API-made chat and a user-origin session delegation are NOT proof', async () => {
    const ids = ['c-p1t', 'c-p1s', 'c-p1u', 'c-p2d', 'c-p2p', 'c-p3', 'c-p3plain', 'c-p4', 'c-api', 'c-spawnparam', 'c-both'];
    for (const id of ids) world.chats.push({ id, userId: 'u1', parentChatId: null });
    world.tasks.push({ childChatId: 'c-p1t', kind: 'ticket', origin: null }, { childChatId: 'c-p1s', kind: 'session', origin: 'machine' }, { childChatId: 'c-p1u', kind: 'session', origin: 'user' }, { childChatId: 'c-both', kind: 'ticket', origin: null });
    world.tickets.push({ status: 'done', context: { dispatchedTo: 'c-p2d', previousLanes: ['c-p2p'] } }, { status: 'done', context: { dispatchedTo: 'c-both' } });
    world.chats.push({ id: 'ps-1', userId: 'u1', isProjectSupervisor: true, isSupervisor: false }, { id: 'plain-parent', userId: 'u1', isProjectSupervisor: false, isSupervisor: false });
    world.chats.find((c) => c.id === 'c-p3')!.parentChatId = 'ps-1';
    world.chats.find((c) => c.id === 'c-p3plain')!.parentChatId = 'plain-parent';
    world.messages.push(
      { chatId: 'c-p4', role: 'user', createdAt: ago(5), metadata: { origin: 'schedule' } },
      { chatId: 'c-p4', role: 'user', createdAt: ago(9), metadata: { origin: 'agent' } }, // the FIRST row wins
      { chatId: 'c-api', role: 'user', createdAt: ago(9), metadata: { origin: 'user' } },
      { chatId: 'c-api', role: 'user', createdAt: ago(3), metadata: { origin: 'agent' } }, // a later machine row is not proof
      { chatId: 'c-spawnparam', role: 'user', createdAt: ago(9), metadata: null },
    );
    world.states.push({ id: 'c-spawnparam', status: 'ready', titleSource: 'spawn-param' });
    const p = await proveMachineSpawned(ids);
    expect(Object.fromEntries(p)).toEqual({
      'c-p1t': 'p1:ticket', 'c-p1s': 'p1:session_machine', 'c-p2d': 'p2:dispatched_to', 'c-p2p': 'p2:previous_lane', 'c-p3': 'p3:supervisor_parent', 'c-p4': 'p4:agent', 'c-both': 'p1:ticket',
    });
    // titleSource is never read as proof
    expect(mockPrisma.chatCodingState.findMany).not.toHaveBeenCalled();
  });

  it('a failed proof read leaves its proofs out (fail-safe: no proof, never archived); the others still prove', async () => {
    world.chats.push({ id: 'c-1', userId: 'u1', parentChatId: null });
    world.tasks.push({ childChatId: 'c-1', kind: 'ticket', origin: null });
    world.messages.push({ chatId: 'c-1', role: 'user', createdAt: ago(9), metadata: { origin: 'agent' } });
    fail.add('p1');
    expect(Object.fromEntries(await proveMachineSpawned(['c-1']))).toEqual({ 'c-1': 'p4:agent' });
    fail.add('p4');
    expect((await proveMachineSpawned(['c-1'])).size).toBe(0);
  });
});

describe('gatherLaneRetireFacts', () => {
  it('idle = newest of creation / run update / message / receipt (never chat.updatedAt); share link, ticket ownership, standing lane, archived folder, human rows', async () => {
    seedLane('l-1', { updatedAt: ago(0.01) }); // a machine write bumped updatedAt — ignored
    seedLane('l-2');
    world.receipts.push({ chatId: 'l-2', createdAt: ago(2) });
    world.shares.push({ chatId: 'l-1', isActive: true, expiresAt: null });
    world.tickets.push({ status: 'awaiting_verification', context: { dispatchedTo: 'l-2' } });
    world.messages.push({ chatId: 'l-1', role: 'user', createdAt: ago(12), metadata: {} });
    process.env.PLATFORM_ENGINEER_CHAT_ID = 'l-2';
    world.projects.push({ id: 'proj-1', userId: 'u1', archivedAt: ago(1) });
    const f = await gatherLaneRetireFacts(['l-1', 'l-2', 'gone'], NOW);
    expect([...f.keys()]).toEqual(['l-1', 'l-2']);
    expect(f.get('l-1')).toMatchObject({ lastActivityAt: ago(9), shareLinkActive: true, ticketOwned: false, standingLane: false, humanRecent: true, archivedFolder: true });
    expect(f.get('l-2')).toMatchObject({ lastActivityAt: ago(2), shareLinkActive: false, ticketOwned: true, standingLane: true, humanRecent: false });
  });

  it('every failed leg reads BLOCKING; a failed chat read yields no facts at all', async () => {
    seedLane('l-1');
    for (const leg of ['states', 'liveRuns', 'schedules', 'shares', 'owning', 'runMax', 'userRows', 'folders', 'todos', 'questions', 'family']) fail.add(leg);
    const f = (await gatherLaneRetireFacts(['l-1'], NOW)).get('l-1')!;
    expect(f).toMatchObject({
      satelliteStatus: 'running', liveRun: true, enabledSchedules: 1, shareLinkActive: true, ticketOwned: true, lastActivityAt: NOW, humanRecent: true, archivedFolder: true,
      openTodos: true, awaitingOwner: true, liveDescendant: true, ownerRestored: true,
    });
    expect(evaluateLaneRetire(lane('l-1'), { ...f, proof: 'p1:ticket' }, NOW).eligible).toBe(false);
    fail.add('chats');
    expect((await gatherLaneRetireFacts(['l-1'], NOW)).size).toBe(0);
  });
});

describe('previewLaneRetire / retireIdleLanes', () => {
  const cand = (id: string, l: Partial<LaneIndexRow> = {}) => ({ lane: lane(id, l), projectId: 'proj-1', userId: 'u1' });

  it('archives ONLY a proven idle lane through archiveChat (source lane_retire); an owner-made / API-made lane, a scheduled one and a recently-human one stay; metric rows per archive + per pass', async () => {
    seedLane('l-ticket');
    world.tickets.push({ status: 'done', context: { dispatchedTo: 'l-ticket' } });
    seedLane('l-api');
    world.messages.find((m) => m.chatId === 'l-api')!.metadata = { origin: 'user' }; // a platform-REST session: first message reads 'user'
    seedLane('l-sched');
    world.schedules.push({ sessionId: 'l-sched', enabled: true });
    seedLane('l-human');
    world.messages.push({ chatId: 'l-human', role: 'user', createdAt: ago(8), metadata: null });
    const r = await retireIdleLanes([cand('l-ticket'), cand('l-api'), cand('l-sched'), cand('l-human')], NOW);
    expect(r).toEqual({ considered: 4, archived: 1, cascaded: 0, skipped: { owner_created: 1, schedule: 1, human_recent: 1 } });
    expect(mockArchiveChat).toHaveBeenCalledTimes(1);
    // Third review (2026-10-22): the cascade applies lane-retire's own 7-day idle bar to every child (cascadeIdleMs).
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: 'u1', chatId: 'l-ticket', source: 'lane_retire', cascadeBudget: { remaining: LANE_RETIRE_MAX_PER_PASS - 1 }, cascadeIdleMs: LANE_RETIRE_IDLE_MS, restoreAuditCache: expect.any(Map) });
    const rows = mockRecordLoopMetric.mock.calls.map((c) => c[0]);
    expect(rows).toEqual([
      { kind: 'lane_retired', sessionId: 'l-ticket', meta: { phase: 'archived', proof: 'p2:dispatched_to', idleDays: 9, projectId: 'proj-1', parentChatId: null } },
      { kind: 'lane_retired', meta: { phase: 'pass', considered: 4, archived: 1, cascaded: 0, skipped: { owner_created: 1, schedule: 1, human_recent: 1 } } },
    ]);
    // the proof is read only for the lane every other rule admitted
    expect(mockPrisma.delegationTask.findMany).toHaveBeenCalledTimes(1);
    // (the window is sorted by lane id)
    expect(mockPrisma.delegationTask.findMany.mock.calls[0][0].where.childChatId).toEqual({ in: ['l-api', 'l-ticket'] });
  });

  it('caps archives at LANE_RETIRE_MAX_PER_PASS; the next pass resumes after the last archived lane', async () => {
    const ids = Array.from({ length: LANE_RETIRE_MAX_PER_PASS + 3 }, (_, i) => `l-${String(i).padStart(3, '0')}`);
    for (const id of ids) { seedLane(id); world.tasks.push({ childChatId: id, kind: 'ticket', origin: null }); }
    const first = await retireIdleLanes(ids.map((id) => cand(id)), NOW);
    expect(first.archived).toBe(LANE_RETIRE_MAX_PER_PASS);
    expect(first.skipped).toEqual({ pass_cap: 3 });
    const second = await retireIdleLanes(ids.map((id) => cand(id)), NOW);
    expect(second.archived).toBe(3);
    expect(world.chats.every((c) => c.archivedAt)).toBe(true);
  });

  it('a 4xx refusal is a skip; an already-archived chat is never re-archived; the switch archives nothing (no metric rows)', async () => {
    seedLane('l-1');
    world.tasks.push({ childChatId: 'l-1', kind: 'ticket', origin: null });
    mockArchiveChat.mockImplementationOnce(async () => { throw Object.assign(new Error('This chat has enabled schedules'), { statusCode: 409 }); });
    expect(await retireIdleLanes([cand('l-1')], NOW)).toMatchObject({ archived: 0, skipped: { refused_409: 1 } });
    world.chats[0].archivedAt = ago(1);
    expect(await archiveIdleLane({ userId: 'u1', chatId: 'l-1' })).toEqual({ archived: false, skip: 'already_archived' });
    expect(await archiveIdleLane({ userId: 'u2', chatId: 'l-1' })).toEqual({ archived: false, skip: 'gone' });
    jest.clearAllMocks();
    world.chats[0].archivedAt = null;
    process.env.LANE_IDLE_RETIRE_DISABLED = '1';
    expect(await retireIdleLanes([cand('l-1')], NOW)).toEqual({ considered: 0, archived: 0, cascaded: 0, skipped: {} });
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('previewLaneRetire never archives; a lane whose fresh read missed reads unverified', async () => {
    seedLane('l-1');
    world.tasks.push({ childChatId: 'l-1', kind: 'session', origin: 'machine' });
    const v = await previewLaneRetire([cand('l-1'), cand('l-missing')], NOW);
    expect(v.map((x) => [x.laneId, x.eligible, x.reason, x.proof])).toEqual([['l-1', true, 'eligible', 'p1:session_machine'], ['l-missing', false, 'unverified', null]]);
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('rotateRetireWindow: sorted by id, starts after the cursor, wraps, bounded — every candidate is visited', () => {
    const cs = ['d', 'a', 'c', 'b', 'e'].map((id) => cand(id));
    expect(rotateRetireWindow(cs, null, 3).map((c) => c.lane.laneId)).toEqual(['a', 'b', 'c']);
    expect(rotateRetireWindow(cs, 'c', 3).map((c) => c.lane.laneId)).toEqual(['d', 'e', 'a']);
    expect(rotateRetireWindow(cs, 'zz', 2).map((c) => c.lane.laneId)).toEqual(['a', 'b']);
  });
});

describe('review fixer (2026-10-21) — restore, cross-project todos, owner-parked lanes, live descendants, the coding-lane walk', () => {
  const cand = (id: string, l: Partial<LaneIndexRow> = {}) => ({ lane: lane(id, l), projectId: 'proj-1', userId: 'u1' });
  /** A proven (p1 ticket) idle lane. */
  const seedProven = (id: string, over: Row = {}) => { seedLane(id, over); world.tasks.push({ childChatId: id, kind: 'ticket', origin: null }); };

  it('REPLAY (case A): a lane the owner RESTORES after lane-retire archived it is never archived again — the next pass skips it owner_restored', async () => {
    seedProven('l-1');
    expect((await retireIdleLanes([cand('l-1')], NOW)).archived).toBe(1);
    // The owner clicks Restore: archiveChat's restore leg clears archivedAt and writes the marker.
    world.chats[0].archivedAt = null;
    await rememberLaneRestore('l-1', { source: null, cascade: false }, NOW);
    const second = await retireIdleLanes([cand('l-1')], new Date(NOW.getTime() + 6 * 3600_000));
    expect(second).toEqual({ considered: 1, archived: 0, cascaded: 0, skipped: { owner_restored: 1 } });
    expect(mockArchiveChat).toHaveBeenCalledTimes(1);
    // …and a week later still (the marker is permanent: a restored lane is the owner's).
    expect((await retireIdleLanes([cand('l-1')], new Date(NOW.getTime() + 30 * D))).skipped).toEqual({ owner_restored: 1 });
  });

  it('a parent whose cascade would take back a RESTORED child is kept (the marker under a descendant)', async () => {
    seedProven('P');
    world.chats.push({ id: 'C1', userId: 'u1', projectId: 'proj-1', parentChatId: 'P', archivedAt: null, createdAt: ago(20) });
    await rememberLaneRestore('C1', { cascade: true }, NOW);
    expect((await gatherLaneRetireFacts(['P'], NOW)).get('P')).toMatchObject({ ownerRestored: true, liveDescendant: false });
    expect((await retireIdleLanes([cand('P')], NOW)).skipped).toEqual({ owner_restored: 1 });
  });

  it('rememberLaneRestore writes nothing only when EVERY marker reader is off (lane-retire, the cascade, the ticket drain\'s gap paths)', async () => {
    process.env.LANE_IDLE_RETIRE_DISABLED = '1';
    await rememberLaneRestore('l-1', {}, NOW);
    // Second review fixer: the ticket drain and a machine cascade still read it.
    expect(store.size).toBe(1);
    store.clear();
    process.env.ARCHIVE_CASCADE_DISABLED = '1';
    process.env.TICKET_LANE_ARCHIVE_GAPS_DISABLED = '1';
    try {
      await rememberLaneRestore('l-1', {}, NOW);
      expect(store.size).toBe(0);
    } finally {
      delete process.env.ARCHIVE_CASCADE_DISABLED;
      delete process.env.TICKET_LANE_ARCHIVE_GAPS_DISABLED;
    }
  });

  it('an OPEN todo assigned from ANOTHER project keeps the lane (the index todo leg is project-scoped); a done one does not', async () => {
    seedProven('l-x');
    seedProven('l-done');
    world.todos.push({ assigneeChatId: 'l-x', projectId: 'proj-OTHER', status: 'in_progress' }, { assigneeChatId: 'l-done', projectId: 'proj-OTHER', status: 'done' });
    const f = await gatherLaneRetireFacts(['l-x', 'l-done'], NOW);
    expect(f.get('l-x')!.openTodos).toBe(true);
    expect(f.get('l-done')!.openTodos).toBe(false);
    // the leg is NOT project-filtered
    expect(mockPrisma.projectTodo.findMany.mock.calls[0][0].where).toEqual({ assigneeChatId: { in: ['l-x', 'l-done'] }, status: { in: ['pending', 'in_progress', 'blocked'] } });
    expect(await retireIdleLanes([cand('l-x'), cand('l-done')], NOW)).toMatchObject({ archived: 1, skipped: { open_todos: 1 } });
    expect(mockArchiveChat).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', chatId: 'l-done', source: 'lane_retire' }));
  });

  it('a lane parked on the OWNER (open owner question, or a pending unexpired confirmation) is kept; an answered question / expired card is not a hold', async () => {
    for (const id of ['l-q', 'l-cf', 'l-answered', 'l-expired']) seedProven(id);
    world.questions.push({ chatId: 'l-q', status: 'open' }, { chatId: 'l-answered', status: 'answered' });
    world.confirmations.push({ chatId: 'l-cf', status: 'pending', expiresAt: new Date(NOW.getTime() + 3600_000) }, { chatId: 'l-expired', status: 'pending', expiresAt: ago(1) });
    const r = await retireIdleLanes(['l-q', 'l-cf', 'l-answered', 'l-expired'].map((id) => cand(id)), NOW);
    expect(r).toEqual({ considered: 4, archived: 2, cascaded: 0, skipped: { awaiting_owner: 2 } });
    expect(mockArchiveChat.mock.calls.map((c) => c[0].chatId).sort()).toEqual(['l-answered', 'l-expired']);
    world.chats.find((c) => c.id === 'l-answered')!.archivedAt = null;
    fail.add('confirmations');
    expect((await gatherLaneRetireFacts(['l-answered'], NOW)).get('l-answered')!.awaitingOwner).toBe(true);
  });

  it('REPLAY (case B): a parent with a LIVE child (running run / enabled schedule / provisioning satellite, ≤ 3 levels down) is kept — its result hook would be paused', async () => {
    seedProven('P-run');
    world.chats.push({ id: 'c-run', userId: 'u1', parentChatId: 'P-run', archivedAt: null });
    world.runs.push({ sessionId: 'c-run', status: 'running', updatedAt: ago(0.01) });
    seedProven('P-sched');
    world.chats.push({ id: 'c-sched', userId: 'u1', parentChatId: 'P-sched', archivedAt: null });
    world.schedules.push({ sessionId: 'c-sched', enabled: true });
    seedProven('P-deep');
    world.chats.push({ id: 'd1', userId: 'u1', parentChatId: 'P-deep', archivedAt: null }, { id: 'd2', userId: 'u1', parentChatId: 'd1', archivedAt: null }, { id: 'd3', userId: 'u1', parentChatId: 'd2', archivedAt: null });
    world.states.push({ id: 'd3', status: 'provisioning' });
    seedProven('P-idle');
    world.chats.push({ id: 'c-idle', userId: 'u1', parentChatId: 'P-idle', archivedAt: null });
    world.states.push({ id: 'c-idle', status: 'ready' });
    world.runs.push({ sessionId: 'c-idle', status: 'completed', updatedAt: ago(9) });
    seedProven('P-archived-child');
    world.chats.push({ id: 'c-arch', userId: 'u1', parentChatId: 'P-archived-child', archivedAt: ago(2) });
    world.runs.push({ sessionId: 'c-arch', status: 'running', updatedAt: ago(0.01) });
    const ids = ['P-run', 'P-sched', 'P-deep', 'P-idle', 'P-archived-child'];
    const f = await gatherLaneRetireFacts(ids, NOW);
    expect(Object.fromEntries(ids.map((id) => [id, f.get(id)!.liveDescendant]))).toEqual({ 'P-run': true, 'P-sched': true, 'P-deep': true, 'P-idle': false, 'P-archived-child': false });
    const r = await retireIdleLanes(ids.map((id) => cand(id)), NOW);
    expect(r.skipped).toEqual({ live_child: 3 });
    expect(mockArchiveChat.mock.calls.map((c) => c[0].chatId).sort()).toEqual(['P-archived-child', 'P-idle']);
  });

  it('a failed family read reads BLOCKING (live_child)', async () => {
    seedProven('P');
    world.chats.push({ id: 'c', userId: 'u1', parentChatId: 'P', archivedAt: null });
    fail.add('familySchedules');
    expect((await gatherLaneRetireFacts(['P'], NOW)).get('P')).toMatchObject({ liveDescendant: true, ownerRestored: true });
    fail.clear();
    fail.add('store');
    expect((await gatherLaneRetireFacts(['P'], NOW)).get('P')).toMatchObject({ liveDescendant: true });
  });

  describe('collectRetireCandidates — the coding-lane walk', () => {
    const PAGE = sessionTopology.SESSION_TOPOLOGY_MAX_LANES;
    /** `n` coding lanes l-0000… sorted by id; buildLaneIndex is stubbed to page them like the real `scan` query. */
    function stubPages(n: number, opts: { partialPage?: number } = {}) {
      const ids = Array.from({ length: n }, (_, i) => `l-${String(i).padStart(4, '0')}`);
      const calls: Array<string | null> = [];
      const spy = jest.spyOn(sessionTopology, 'buildLaneIndex').mockImplementation(async (_p: string, _u: string, o: any = {}) => {
        const after = o.scan?.afterId ?? null;
        calls.push(after);
        const page = ids.filter((id) => !after || id > after).slice(0, PAGE).map((id) => lane(id, { lastMutatingReceiptAgeSec: 9 * 86400 }));
        return { lanes: page, goalTitles: {}, partial: opts.partialPage === calls.length };
      });
      return { ids, calls, spy };
    }
    afterEach(() => jest.restoreAllMocks());

    it('pages through every coding lane by id (never the 200-newest placement index) and asks buildLaneIndex in scan mode', async () => {
      const { ids, calls, spy } = stubPages(PAGE * 2 + 5);
      const r = await collectRetireCandidates('proj-1', 'u1', NOW);
      expect(r).toMatchObject({ pages: 3, partialPages: 0, truncated: false });
      expect(r.candidates.map((c) => c.lane.laneId)).toEqual(ids);
      expect(calls).toEqual([null, ids[PAGE - 1], ids[2 * PAGE - 1]]);
      expect(spy.mock.calls[0][2]).toMatchObject({ scan: { afterId: null } });
    });

    it('a PARTIAL page feeds nothing; the walk goes on', async () => {
      const { ids } = stubPages(PAGE + 3, { partialPage: 1 });
      const r = await collectRetireCandidates('proj-1', 'u1', NOW);
      expect(r).toMatchObject({ pages: 2, partialPages: 1 });
      expect(r.candidates.map((c) => c.lane.laneId)).toEqual(ids.slice(PAGE));
    });

    it(`capped at LANE_RETIRE_SCAN_MAX_PAGES: the next pass resumes after the last lane reached, then starts over; persistCursor:false leaves it alone`, async () => {
      const { ids, calls } = stubPages(PAGE * (LANE_RETIRE_SCAN_MAX_PAGES + 1) + 1);
      const first = await collectRetireCandidates('proj-1', 'u1', NOW);
      expect(first).toMatchObject({ pages: LANE_RETIRE_SCAN_MAX_PAGES, truncated: true });
      calls.length = 0;
      await collectRetireCandidates('proj-1', 'u1', NOW, { persistCursor: false });
      expect(calls[0]).toBe(ids[PAGE * LANE_RETIRE_SCAN_MAX_PAGES - 1]); // the preview reads from the stored cursor…
      calls.length = 0;
      const second = await collectRetireCandidates('proj-1', 'u1', NOW);
      expect(calls[0]).toBe(ids[PAGE * LANE_RETIRE_SCAN_MAX_PAGES - 1]); // …which it did not move
      expect(second.candidates.map((c) => c.lane.laneId)).toEqual(ids.slice(PAGE * LANE_RETIRE_SCAN_MAX_PAGES));
      calls.length = 0;
      await collectRetireCandidates('proj-1', 'u1', NOW);
      expect(calls[0]).toBeNull();
    });
  });
});

describe('second review fixer (2026-10-21) — inbound integrations, the webhook proof, the restore audit, the pass budget', () => {
  const cand = (id: string, l: Partial<LaneIndexRow> = {}) => ({ lane: lane(id, l), projectId: 'proj-1', userId: 'u1' });
  const seedProven = (id: string, over: Row = {}) => { seedLane(id, over); world.tasks.push({ childChatId: id, kind: 'ticket', origin: null }); };

  it('REPRO (finding 3): a lane the owner wired a webhook / wake hook into is kept — an active ChatWebhook or an enabled non-system hook targeting it; a system hook, a disabled hook or an inactive webhook is not a hold', async () => {
    // The reviewer's case: first message in through the owner's webhook, an active ChatWebhook, an enabled hook, idle 8 d.
    seedLane('l-wh');
    world.messages.find((m) => m.chatId === 'l-wh')!.metadata = { origin: 'webhook' };
    world.webhooks.push({ chatId: 'l-wh', isActive: true });
    world.hooks.push({ targetChatId: 'l-wh', enabled: true, createdVia: 'rest' });
    seedProven('l-hook');
    world.hooks.push({ targetChatId: 'l-hook', enabled: true, createdVia: 'tool:hook_subscribe' });
    seedProven('l-legacy');
    world.hooks.push({ targetChatId: 'l-legacy', enabled: true, createdVia: null }); // pre-provenance: the conservative side
    seedProven('l-sys');
    world.hooks.push({ targetChatId: 'l-sys', enabled: true, createdVia: 'system:child-result-hook' });
    seedProven('l-off');
    world.hooks.push({ targetChatId: 'l-off', enabled: false, createdVia: 'rest' });
    world.webhooks.push({ chatId: 'l-off', isActive: false });
    const v = await previewLaneRetire(['l-wh', 'l-hook', 'l-legacy', 'l-sys', 'l-off'].map((id) => cand(id)), NOW);
    expect(Object.fromEntries(v.map((x) => [x.laneId, x.reason]))).toEqual({
      'l-wh': 'inbound_integration', 'l-hook': 'inbound_integration', 'l-legacy': 'inbound_integration', 'l-sys': 'eligible', 'l-off': 'eligible',
    });
    // a failed integration read keeps every lane
    fail.add('hooks');
    expect((await gatherLaneRetireFacts(['l-sys'], NOW)).get('l-sys')!.inboundIntegration).toBe(true);
  });

  it('a first WEBHOOK message is not machine-spawn proof while the chat carries a ChatWebhook row (any state); without one it still proves; a failed webhook read drops the proof', async () => {
    for (const id of ['c-owned', 'c-revoked', 'c-bare']) {
      world.chats.push({ id, userId: 'u1', parentChatId: null });
      world.messages.push({ chatId: id, role: 'user', createdAt: ago(9), metadata: { origin: 'webhook' } });
    }
    world.webhooks.push({ chatId: 'c-owned', isActive: true }, { chatId: 'c-revoked', isActive: false });
    expect(Object.fromEntries(await proveMachineSpawned(['c-owned', 'c-revoked', 'c-bare']))).toEqual({ 'c-bare': 'p4:webhook' });
    fail.add('webhooks');
    expect((await proveMachineSpawned(['c-bare'])).size).toBe(0);
  });

  it('REPRO (findings 4 / 12): a lane restored BEFORE the marker existed (or while every reader was off) is kept by the restore audit — a chat.restore newer than its last chat.archive; a lane re-archived after its restore is not; a failed audit read keeps it', async () => {
    // Restored by hand 2 days before the deploy, idle since; no marker.
    seedProven('l-restored');
    world.activities.push(
      { userId: 'u1', action: 'chat.archive', createdAt: ago(5), metadata: { chatId: 'l-restored' } },
      { userId: 'u1', action: 'chat.restore', createdAt: ago(2), metadata: { chatId: 'l-restored' } },
    );
    // Restored, then archived again (and later cleared directly with no audit): not the owner's restore any more.
    seedProven('l-rearchived');
    world.activities.push(
      { userId: 'u1', action: 'chat.restore', createdAt: ago(6), metadata: { chatId: 'l-rearchived' } },
      { userId: 'u1', action: 'chat.archive', createdAt: ago(5), metadata: { chatId: 'l-rearchived' } },
    );
    // A descendant restored: its parent's cascade would take it back.
    seedProven('P');
    world.chats.push({ id: 'P-kid', userId: 'u1', projectId: 'proj-1', parentChatId: 'P', archivedAt: null, createdAt: ago(20) });
    world.activities.push({ userId: 'u1', action: 'chat.restore', createdAt: ago(3), metadata: { chatId: 'P-kid' } });
    seedProven('l-plain');
    const r = await retireIdleLanes(['l-restored', 'l-rearchived', 'P', 'l-plain'].map((id) => cand(id)), NOW);
    expect(r.skipped).toEqual({ owner_restored: 2 });
    expect(mockArchiveChat.mock.calls.map((c) => c[0].chatId).sort()).toEqual(['l-plain', 'l-rearchived']);
    // fail-safe: a failed audit read keeps the lanes it was asked about
    for (const c of world.chats) c.archivedAt = null;
    mockArchiveChat.mockClear();
    fail.add('activity');
    expect((await retireIdleLanes([cand('l-plain')], NOW)).skipped).toEqual({ owner_restored: 1 });
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('the audit is read only when a lane is otherwise eligible (the owners\' Activity rows are not scanned on a pass with nothing to archive)', async () => {
    seedProven('l-busy');
    world.schedules.push({ sessionId: 'l-busy', enabled: true });
    await retireIdleLanes([cand('l-busy')], NOW);
    expect(mockPrisma.activity.findMany).not.toHaveBeenCalled();
  });

  it('REPRO (finding 5): the pass cap counts the CASCADE — the lanes archived plus the children their cascade takes share ONE budget of LANE_RETIRE_MAX_PER_PASS', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `l-${i}`);
    for (const id of ids) seedProven(id);
    // Each archive's cascade takes 10 idle children (or what is left of the budget).
    mockArchiveChat.mockImplementation(async (opts: any) => {
      const c = world.chats.find((x) => x.id === opts.chatId);
      if (c) c.archivedAt = new Date();
      if (opts.cascadeBudget) opts.cascadeBudget.remaining -= Math.min(10, opts.cascadeBudget.remaining);
      return { id: opts.chatId, archived: true };
    });
    const r = await retireIdleLanes(ids.map((id) => cand(id)), NOW);
    // 25 → root 1 (24) → cascade 10 (14) → root 2 (13) → cascade 10 (3) → root 3 (2) → cascade 2 (0) → pass cap
    expect(r).toMatchObject({ archived: 3, cascaded: 22, skipped: { pass_cap: 3 } });
    expect(r.archived + r.cascaded).toBe(LANE_RETIRE_MAX_PER_PASS);
    // a refused archive refunds its slot (no cascade ran)
    jest.clearAllMocks();
    for (const c of world.chats) c.archivedAt = null;
    mockArchiveChat.mockImplementationOnce(async () => { throw Object.assign(new Error('running'), { statusCode: 409 }); });
    mockArchiveChat.mockImplementation(async (opts: any) => { const c = world.chats.find((x) => x.id === opts.chatId); if (c) c.archivedAt = new Date(); return { id: opts.chatId, archived: true }; });
    __resetLaneRetireCursorForTests();
    const again = await retireIdleLanes(ids.map((id) => cand(id)), NOW);
    expect(again).toMatchObject({ archived: 5, cascaded: 0, skipped: { refused_409: 1 } });
  });
});

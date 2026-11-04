/**
 * deploy-resume-brief (mishap ticket 5ba5f03e — "Chat-runtime deploys interrupt
 * in-flight runs; recovery re-runs from scratch") — REPLAY of the mishap and
 * pin of the fix.
 *
 * THE MISHAP (2026-09-18, 3 sightings): a blue-green deploy SIGTERM-killed
 * in-flight chat turns whose remaining work exceeded the bounded drain
 * (DRAIN_MAX_SECONDS) — supervisor wakes, a multi-hour generation lane — and
 * the orphan-recovery re-fire re-ran the turn FROM SCRATCH: every tool the dead
 * attempt already executed ran twice (wasted tokens; one lane's generation
 * ledger had to be hand-corrected 130→74).
 *
 * THE FIX (the ticket's option b — soft checkpoint): the SIGTERM ritual
 * harvests the interrupted run's receipt-backed executions into a bounded
 * DeployResumeBrief riding the requeue entry + the interrupt row's metadata,
 * and the re-fired turn receives it as resumeBrief (rendered into its context
 * by runChatAgentTurn) with one rule: ALREADY EXECUTED — do not repeat.
 *
 * Pinned here:
 *   LEAF — buildResumeBrief is ok-only/newest-capped/id-pruned and null on
 *     empty; parseResumeBrief round-trips a JSON brief and degrades junk to
 *     null; renderResumeBriefNote carries the do-not-repeat contract and is
 *     hard-bounded at RESUME_BRIEF_NOTE_MAX_CHARS.
 *   RITUAL (the replay): an active chat run with run_tool_receipts rows gets
 *     its brief onto the Redis requeue entry AND the interrupt row metadata —
 *     ok-only at the query contract, window scoped to the run's own start
 *     (a prior turn's receipts never leak in); no receipts → NO brief field
 *     (the pre-fix byte shape, backward compatible).
 *   DRAIN + RULE C (the carry-forward): a requeue entry's resume reaches
 *     startDetachedChatRun as resumeBrief (human AND machine re-fire shapes);
 *     an entry WITHOUT resume re-fires exactly as before; a Rule-C interrupt
 *     row forwards metadata.resume the same way.
 *
 * Mock surface mirrors shutdown-interrupt.test.ts + orphan-recovery.test.ts:
 * in-memory Redis fake with REAL NX semantics, stand-in prisma (runToolReceipt
 * added), chat-agent.service + hooks.service + loop-metrics mocked at the
 * boundary, live-runs real except the two ritual-facing reads.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const redisStore = new Map<string, string>();
const redisLists = new Map<string, string[]>();
const mockRedis = {
  set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean; EX?: number }) => {
    if (opts?.NX && redisStore.has(k)) return null;
    redisStore.set(k, v);
    return 'OK';
  }),
  get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
  del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
  rPush: jest.fn(async (k: string, v: string) => {
    const l = redisLists.get(k) ?? [];
    l.push(v);
    redisLists.set(k, l);
    return l.length;
  }),
  lRange: jest.fn(async (k: string, start: number, stop: number) => {
    const l = redisLists.get(k) ?? [];
    const end = stop < 0 ? l.length + stop : stop;
    return l.slice(start, end + 1);
  }),
  lRem: jest.fn(async (k: string, count: number, v: string) => {
    const l = redisLists.get(k) ?? [];
    let removed = 0;
    const kept = l.filter((x) => {
      if (x === v && removed < count) { removed += 1; return false; }
      return true;
    });
    redisLists.set(k, kept);
    return removed;
  }),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockPrisma: any = {
  pendingChatMessage: {
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(async () => null),
  },
  crossModelMessage: {
    update: jest.fn(async () => ({})),
    create: jest.fn(async () => ({})),
    findFirst: jest.fn(async () => null),
  },
  crossModelChat: { update: jest.fn(async () => ({})) },
  agentRun: { findFirst: jest.fn(async () => null) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  $queryRaw: jest.fn(async () => []),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

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

const mockListActiveRunIds = jest.fn((): string[] => []);
const mockRunStartedAt = jest.fn((..._args: any[]): number | null => null);
jest.mock('../coding/live-runs', () => {
  const actual = jest.requireActual('../coding/live-runs');
  return {
    __esModule: true,
    ...actual,
    listActiveRunIds: () => mockListActiveRunIds(),
    runStartedAt: (k: string) => mockRunStartedAt(k),
  };
});

const mockRecordLoopMetric = jest.fn();
const mockFlushLoopMetrics = jest.fn(async () => {});
jest.mock('../platform/loop-metrics.service', () => {
  const actual = jest.requireActual('../platform/loop-metrics.service');
  return {
    __esModule: true,
    ...actual,
    recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
    flushLoopMetrics: () => mockFlushLoopMetrics(),
  };
});

const mockDrainChatQueue = jest.fn(async (..._a: any[]) => true);
const mockStartDetachedChatRun = jest.fn(async (..._a: any[]): Promise<string | null> => 'chat:c1');
jest.mock('./chat-agent.service', () => ({
  __esModule: true,
  drainChatQueue: (...a: any[]) => mockDrainChatQueue(...a),
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
}));

const mockEmitHookEventSafe = jest.fn(async (..._a: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
}));

import { interruptActiveChatRunsForShutdown, DEPLOY_INTERRUPT_ORIGIN, DEPLOY_REQUEUE_KEY } from './shutdown-interrupt';
import { drainDeployRequeue, sweepOrphanedChatTurns } from './orphan-recovery';
import {
  buildResumeBrief,
  parseResumeBrief,
  renderResumeBriefNote,
  RESUME_BRIEF_MAX_RECEIPTS,
  RESUME_BRIEF_NOTE_MAX_CHARS,
  RESUME_BRIEF_PREFIX,
  type DeployResumeBrief,
} from './deploy-resume-brief';
import type { ToolReceipt } from '../coding/run-receipts';

const USER_ROW = { id: 'm1', role: 'user', metadata: null };
const OLD = new Date(Date.now() - 60 * 60_000);

function receipt(tool: string, over: Partial<ToolReceipt> = {}): ToolReceipt {
  return {
    id: `rcpt-${tool}-${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'c1',
    runId: 'r1',
    tool,
    ok: true,
    ids: {},
    inputHash: null,
    outputHash: null,
    createdAt: new Date(),
    ...over,
  };
}

/** A Rule-B/C raw-SQL join row (orphan-recovery.test.ts idiom). */
function orphanRow(over: Partial<any> = {}) {
  return {
    id: 'm1',
    chatId: 'c1',
    content: 'orphaned question',
    metadata: null,
    createdAt: OLD,
    chatUserId: 'u1',
    chatMode: 'thinking',
    ...over,
  };
}

function mockQueryRouter(opts: { byId?: any | null; interruptRows?: any[]; ruleBRows?: any[] } = {}) {
  mockPrisma.$queryRaw.mockImplementation(async (strings: any, ..._values: any[]) => {
    const sql = String(strings?.join ? strings.join('?') : strings);
    if (sql.includes('WHERE m."id" = ')) return opts.byId ? [opts.byId] : [];
    if (sql.includes(`metadata"->>'origin'`)) return opts.interruptRows ?? [];
    return opts.ruleBRows ?? [];
  });
}

function pushEntry(over: Record<string, unknown> = {}): string {
  const raw = JSON.stringify({ chatId: 'c1', userMessageId: 'm1', reason: 'deploy', at: new Date().toISOString(), ...over });
  redisLists.set(DEPLOY_REQUEUE_KEY, [...(redisLists.get(DEPLOY_REQUEUE_KEY) ?? []), raw]);
  return raw;
}

const BRIEF: DeployResumeBrief = {
  v: 1,
  harvestedAt: new Date().toISOString(),
  receipts: [
    { tool: 'send_chat_message', at: new Date(Date.now() - 5 * 60_000).toISOString(), ids: { chatId: 'deadbeef' } },
    { tool: 'todo_update', at: new Date(Date.now() - 2 * 60_000).toISOString(), ids: { todoId: 'abc12345' } },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  redisLists.clear();
  mockRedis.set.mockImplementation(async (k: string, v: string, opts?: { NX?: boolean; EX?: number }) => {
    if (opts?.NX && redisStore.has(k)) return null;
    redisStore.set(k, v);
    return 'OK';
  });
  mockRedis.get.mockImplementation(async (k: string) => redisStore.get(k) ?? null);
  mockRedis.del.mockImplementation(async (k: string) => (redisStore.delete(k) ? 1 : 0));
  mockRedis.exists.mockImplementation(async (k: string) => (redisStore.has(k) ? 1 : 0));
  mockRedis.rPush.mockImplementation(async (k: string, v: string) => {
    const l = redisLists.get(k) ?? [];
    l.push(v);
    redisLists.set(k, l);
    return l.length;
  });
  mockRedis.lRange.mockImplementation(async (k: string, start: number, stop: number) => {
    const l = redisLists.get(k) ?? [];
    const end = stop < 0 ? l.length + stop : stop;
    return l.slice(start, end + 1);
  });
  mockRedis.lRem.mockImplementation(async (k: string, count: number, v: string) => {
    const l = redisLists.get(k) ?? [];
    let removed = 0;
    const kept = l.filter((x) => {
      if (x === v && removed < count) { removed += 1; return false; }
      return true;
    });
    redisLists.set(k, kept);
    return removed;
  });
  mockPrisma.pendingChatMessage.findMany.mockResolvedValue([]);
  mockPrisma.pendingChatMessage.findFirst.mockResolvedValue(null);
  mockPrisma.crossModelMessage.update.mockResolvedValue({});
  mockPrisma.crossModelMessage.create.mockResolvedValue({});
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
  mockPrisma.crossModelChat.update.mockResolvedValue({});
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
  mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockListActiveRunIds.mockReturnValue([]);
  mockRunStartedAt.mockReturnValue(null);
  mockFlushLoopMetrics.mockResolvedValue(undefined);
  mockDrainChatQueue.mockResolvedValue(true);
  mockStartDetachedChatRun.mockResolvedValue('chat:c1');
});

// ── LEAF: the brief itself ────────────────────────────────────────────────────

describe('deploy-resume-brief leaf (5ba5f03e)', () => {
  it('buildResumeBrief keeps ok receipts newest-capped with pruned ids; empty/failed-only → null', () => {
    expect(buildResumeBrief([])).toBeNull();
    expect(buildResumeBrief([receipt('verify', { ok: false })])).toBeNull(); // ok-only: a failed execution proves nothing
    const many = Array.from({ length: RESUME_BRIEF_MAX_RECEIPTS + 5 }, (_, i) =>
      receipt(`tool_${i}`, { createdAt: new Date(Date.now() - (100 - i) * 1000) }));
    const brief = buildResumeBrief(many)!;
    expect(brief).not.toBeNull();
    expect(brief.v).toBe(1);
    expect(typeof brief.harvestedAt).toBe('string');
    expect(brief.receipts).toHaveLength(RESUME_BRIEF_MAX_RECEIPTS);
    expect(brief.receipts[0].tool).toBe('tool_5'); // the OLDEST dropped — freshest kept
    expect(brief.receipts.at(-1)!.tool).toBe(`tool_${RESUME_BRIEF_MAX_RECEIPTS + 4}`);
  });

  it('buildResumeBrief prunes ids to short citable strings (junk values dropped, long values truncated)', () => {
    const brief = buildResumeBrief([
      receipt('git_push', { ids: { sha: 'a'.repeat(40), branch: 'digby/session-x', bad: { nested: true }, empty: '' } }),
    ])!;
    expect(brief.receipts[0].ids).toEqual({ sha: 'a'.repeat(40), branch: 'digby/session-x' });
  });

  it('parseResumeBrief round-trips a JSON brief; junk/shape violations → null', () => {
    const round = parseResumeBrief(JSON.parse(JSON.stringify(BRIEF)));
    expect(round).toEqual(BRIEF);
    expect(parseResumeBrief(null)).toBeNull();
    expect(parseResumeBrief('string')).toBeNull();
    expect(parseResumeBrief({ v: 2, harvestedAt: 'x', receipts: [] })).toBeNull();
    expect(parseResumeBrief({ v: 1, harvestedAt: 'x', receipts: [] })).toBeNull(); // empty brief is no brief
    expect(parseResumeBrief({ v: 1, receipts: BRIEF.receipts })).toBeNull(); // missing harvestedAt
    // Tolerant per-entry: junk entries drop, valid ones survive.
    const mixed = parseResumeBrief({ v: 1, harvestedAt: 'h', receipts: [{ nope: true }, BRIEF.receipts[0]] });
    expect(mixed?.receipts).toHaveLength(1);
    expect(mixed?.receipts[0].tool).toBe('send_chat_message');
  });

  it('renderResumeBriefNote carries the do-not-repeat contract + receipt ids, bounded at the char cap', () => {
    const note = renderResumeBriefNote(BRIEF);
    expect(note.startsWith(RESUME_BRIEF_PREFIX)).toBe(true);
    expect(note).toContain('do NOT repeat');
    expect(note).toContain('send_chat_message');
    expect(note).toContain('chatId deadbeef');
    expect(note).toContain('todo_update');
    // Char cap: long id values force the oldest receipts out with an omitted count.
    const fat: DeployResumeBrief = {
      v: 1,
      harvestedAt: BRIEF.harvestedAt,
      receipts: Array.from({ length: RESUME_BRIEF_MAX_RECEIPTS }, (_, i) => ({
        tool: `fat_tool_${i}`,
        at: BRIEF.receipts[0].at,
        ids: { a: 'x'.repeat(48), b: 'x'.repeat(48), c: 'x'.repeat(48), d: 'x'.repeat(48) },
      })),
    };
    const capped = renderResumeBriefNote(fat);
    expect(capped.length).toBeLessThanOrEqual(RESUME_BRIEF_NOTE_MAX_CHARS);
    expect(capped).toMatch(/\+\d+ earlier action\(s\)/);
  });
});

// ── RITUAL: the mishap replay — an interrupted run's progress is preserved ────

describe('SIGTERM ritual harvest (5ba5f03e replay)', () => {
  it('active chat run with receipts → brief rides the requeue entry AND the interrupt-row metadata; query is ok-only, scoped to run start', async () => {
    const startedAt = Date.now() - 10 * 60_000; // a 10-min-old wake — inside the drain, killable
    mockListActiveRunIds.mockReturnValue(['chat:c1']);
    mockRunStartedAt.mockReturnValue(startedAt);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(USER_ROW);
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([
      // DB-shape: orderBy createdAt DESC (newest first) — getRecentChatReceipts
      // reverses to oldest-first after the newest-kept cap.
      receipt('todo_update', { ids: { todoId: 'abc12345' }, createdAt: new Date(startedAt + 120_000) }),
      receipt('send_chat_message', { ids: { chatId: 'deadbeef' }, createdAt: new Date(startedAt + 60_000) }),
    ]);
    await interruptActiveChatRunsForShutdown('deploy');
    // The receipt read: THIS chat, ok-only, window from the run's own start (± skew).
    expect(mockPrisma.runToolReceipt.findMany).toHaveBeenCalledTimes(1);
    const q = mockPrisma.runToolReceipt.findMany.mock.calls[0][0];
    expect(q.where.chatId).toBe('c1');
    expect(q.where.ok).toBe(true);
    const gteMs = q.where.createdAt.gte.getTime();
    expect(Math.abs(gteMs - (startedAt - 5_000))).toBeLessThan(4_000);
    // The requeue entry carries the soft checkpoint.
    expect(mockRedis.rPush).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(mockRedis.rPush.mock.calls[0][1]);
    expect(entry.chatId).toBe('c1');
    const brief = parseResumeBrief(entry.resume);
    expect(brief).not.toBeNull();
    expect(brief!.receipts.map((r) => r.tool)).toEqual(['send_chat_message', 'todo_update']);
    expect(brief!.receipts[0].ids).toEqual({ chatId: 'deadbeef' });
    // … and the interrupt row's metadata carries it too (the Rule-C path).
    const created = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    const metaBrief = parseResumeBrief(created.metadata.resume);
    expect(metaBrief).toEqual(brief);
  });

  it('no receipts (or no run start) → NO resume field: the entry/row keep the exact pre-fix shape', async () => {
    mockListActiveRunIds.mockReturnValue(['chat:c1']);
    mockRunStartedAt.mockReturnValue(Date.now() - 60_000);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(USER_ROW);
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([]); // nothing consequential yet
    await interruptActiveChatRunsForShutdown('deploy');
    const entry = JSON.parse(mockRedis.rPush.mock.calls[0][1]);
    expect('resume' in entry).toBe(false);
    const created = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect('resume' in created.metadata).toBe(false);

    jest.clearAllMocks();
    mockListActiveRunIds.mockReturnValue(['chat:c1']);
    mockRunStartedAt.mockReturnValue(null); // run start unknown — harvest stands down
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(USER_ROW);
    await interruptActiveChatRunsForShutdown('deploy');
    expect(mockPrisma.runToolReceipt.findMany).not.toHaveBeenCalled();
    const entry2 = JSON.parse(mockRedis.rPush.mock.calls[0][1]);
    expect('resume' in entry2).toBe(false);
  });
});

// ── DRAIN + RULE C: the brief reaches the re-fired run ────────────────────────

describe('re-fire carry-forward (5ba5f03e)', () => {
  it('requeue entry WITH resume → startDetachedChatRun receives resumeBrief (the checkpoint reaches the new color)', async () => {
    pushEntry({ resume: JSON.parse(JSON.stringify(BRIEF)) });
    mockQueryRouter({ byId: orphanRow() });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(USER_ROW);
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    const args = mockStartDetachedChatRun.mock.calls[0][0];
    expect(args.recoveryForMessageId).toBe('m1');
    expect(args.resumeBrief).toEqual(BRIEF);
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]); // retired on the won start
  });

  it('requeue entry WITHOUT resume (pre-fix shape / a turn that did nothing) → re-fires exactly as before, no resumeBrief', async () => {
    pushEntry();
    mockQueryRouter({ byId: orphanRow() });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(USER_ROW);
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun.mock.calls[0][0].resumeBrief).toBeUndefined();
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });

  it('requeue entry with a JUNK resume → tolerated, plain re-fire (a bad brief never blocks a turn)', async () => {
    pushEntry({ resume: { v: 99, garbage: true } });
    mockQueryRouter({ byId: orphanRow() });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(USER_ROW);
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun.mock.calls[0][0].resumeBrief).toBeUndefined();
  });

  it('machine re-fire (cleanWake stash) also carries resumeBrief — the supervisor-wake shape from the ticket', async () => {
    pushEntry({ resume: JSON.parse(JSON.stringify(BRIEF)) });
    mockQueryRouter({
      byId: orphanRow({ metadata: { origin: 'schedule', machineMessage: 'clean wake prompt' } }),
    });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(USER_ROW);
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    const args = mockStartDetachedChatRun.mock.calls[0][0];
    expect(args.machineWake).toBe(true);
    expect(args.message).toBe('clean wake prompt');
    expect(args.resumeBrief).toEqual(BRIEF);
  });

  it('RULE C (RPUSH lost): the interrupt row’s metadata.resume reaches the re-fire the same way', async () => {
    mockQueryRouter({
      byId: orphanRow(),
      interruptRows: [{
        id: 'm-int',
        chatId: 'c1',
        metadata: { origin: DEPLOY_INTERRUPT_ORIGIN, interruptedMessageId: 'm1', reason: 'deploy', resume: JSON.parse(JSON.stringify(BRIEF)) },
      }],
    });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(USER_ROW);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun.mock.calls[0][0].resumeBrief).toEqual(BRIEF);
  });
});

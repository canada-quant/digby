/**
 * Replay pin — ticket 3405e332 (2026-09-17 one-shot schedule drift incident).
 *
 * Incident: one-shot schedules on BUSY plain chats drifted hours past their
 * intended fire time (Fleet Supervisor schedules 7a7deedb ~7h / 0283acd6 ~3h,
 * both runs 0/1 "last skipped:busy") because the sweeper only re-armed a busy
 * fire by 3 minutes forever. Both were cancelled AFTER their trigger condition
 * had already resolved — they would have fired stale.
 *
 * Fix (this file pins the DRAIN layer): a one-shot firing on a busy plain chat
 * now enqueues into pending_chat_messages with source/origin 'schedule'
 * (schedule.service fireScheduleTarget), and drainChatQueue
 *   - replays it as the SAME machine wake it would have been on the direct
 *     fire path (machineWake:true + messageOrigin 'schedule'), and
 *   - enforces CANCEL-WINS against the stashed scheduleId (drop only on
 *     certainty: row gone or cancel-class lastStatus — the drain-time mirror
 *     of run-executor's claim-time stale-firing guard; a read error, a lost
 *     stash, or a consumed 'started' row all deliver).
 *
 * Harness mirrors message-queue.test.ts: REAL message-queue.service +
 * REAL chat-agent.service drainChatQueue over in-memory tables; prisma, the
 * agent loop, search, memory, titles and hooks are mocked.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// error-handler imports config/env, which calls process.exit(1) without env
// vars and kills the whole jest worker at import time — mock AppError (same
// shape). message-queue.service throws it for the queue-full 409.
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

/** In-memory pending_chat_messages table — FIFO assertions stay honest. */
const pendingRows: Array<{
  id: string; chatId: string; userId: string; content: string;
  mode: string | null; source: string; createdAt: Date; uploadIds?: string[];
}> = [];
let pendingSeq = 0;
/** Transcript-row ids minted by the buffered $transaction mock. */
let msgSeq = 0;

/** In-memory crossmodel_messages table — only what the supersession marker
 *  (c6db9c72) reads: user rows of SOURCE chats (chatId/role/createdAt/metadata). */
const transcriptRows: Array<{
  id: string; chatId: string; role: string; content: string; createdAt: Date; metadata?: unknown;
}> = [];

// message-queue.service's origin stash + chat-busy's cross-process claim ride
// config/redis (whose chain reaches config/env → process.exit at import) —
// map-backed mock with honest get/set/del and REAL SET NX semantics.
const redisStore = new Map<string, string>();
const mockRedis = {
  set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => {
    if (opts?.NX && redisStore.has(k)) return null;
    redisStore.set(k, String(v));
    return 'OK';
  }),
  get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
  del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
  mGet: jest.fn(async (keys: string[]) => keys.map((k) => redisStore.get(k) ?? null)),
  expire: jest.fn(async (..._a: any[]) => 1),
  // MERGE-1 kill-window fix: noteDrainAttempt bounds the immediate redelivery
  // chain after a failed persist. Without incr the call THROWS and the
  // fail-open path returns 0, so the bound would never engage (a real spin).
  incr: jest.fn(async (k: string) => {
    const n = Number(redisStore.get(k) ?? 0) + 1;
    redisStore.set(k, String(n));
    return n;
  }),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockPrisma: any = {
  pendingChatMessage: {
    count: jest.fn(async ({ where }: any) =>
      pendingRows.filter(r => r.chatId === where.chatId && (where.source == null || r.source === where.source)).length),
    create: jest.fn(async ({ data }: any) => {
      pendingSeq += 1;
      const row = { id: `p${pendingSeq}`, createdAt: new Date(Date.now() + pendingSeq), ...data };
      pendingRows.push(row);
      return row;
    }),
    findFirst: jest.fn(async ({ where }: any) =>
      pendingRows
        .filter(r => r.chatId === where.chatId && (where.source == null || r.source === where.source))
        .sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) || a.id.localeCompare(b.id))[0] ?? null),
    findMany: jest.fn(async ({ where, take }: any) =>
      pendingRows
        .filter(r => r.chatId === where.chatId && (where.source == null || r.source === where.source))
        .sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) || a.id.localeCompare(b.id))
        .slice(0, take ?? undefined)),
    delete: jest.fn(async ({ where }: any) => {
      const i = pendingRows.findIndex(r => r.id === where.id);
      if (i >= 0) pendingRows.splice(i, 1);
      return {};
    }),
    // MERGE-1 cutover kill-window fix (2026-11-05): the persist consumes the
    // drained rows in ONE transaction with the transcript row.
    deleteMany: jest.fn(async ({ where }: any) => {
      const ids: string[] = where?.id?.in ?? (where?.id ? [where.id] : []);
      let count = 0;
      for (const id of ids) {
        const i = pendingRows.findIndex(r => r.id === id);
        if (i >= 0) { pendingRows.splice(i, 1); count += 1; }
      }
      return { count };
    }),
  },
  // chat-agent run persistence (a drained run executes a REAL detached turn).
  crossModelMessage: {
    create: jest.fn(async () => ({})),
    findMany: jest.fn(async ({ where, take }: any) =>
      transcriptRows
        .filter(r => r.chatId === where.chatId
          && (where.role == null || r.role === where.role)
          && (!where.createdAt?.gt || r.createdAt > where.createdAt.gt))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, take ?? undefined)),
  },
  crossModelChat: {
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUnique: jest.fn(async () => ({ title: 'A proper existing title' })),
  },
  // MERGE-1 cutover kill-window fix (2026-11-05): createMessagesConsumingPending
// writes the transcript row and consumes the queued row in ONE transaction.
// Buffered, all-or-nothing (see message-queue.test.ts for the rationale).
  $transaction: jest.fn(async (fn: any) => {
    const created: any[] = [];
    let consumedIds: string[] = [];
    const tx = {
      crossModelMessage: {
        // Delegate to the SAME mock the non-transactional path uses, so tests
        // asserting on crossModelMessage.create (drainedUserRow) stay meaningful.
        create: jest.fn(async (args: any) => {
          const row = { id: `m${++msgSeq}`, createdAt: new Date(Date.now() + msgSeq), ...args.data };
          created.push(row);
          void mockPrisma.crossModelMessage.create(args);
          return row;
        }),
      },
      pendingChatMessage: {
        deleteMany: jest.fn(async ({ where }: any) => {
          consumedIds = where?.id?.in ?? (where?.id ? [where.id] : []);
          return { count: consumedIds.length };
        }),
      },
    };
    const out = await fn(tx);
    for (const r of created) transcriptRows.push(r);
    for (const id of consumedIds) {
      const i = pendingRows.findIndex(r => r.id === id);
      if (i >= 0) pendingRows.splice(i, 1);
    }
    return out;
  }),
  // chat-busy's durable layer (worker-tier coding runs) — none in these tests.
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  // 3405e332 cancel-wins guard: the drain re-reads the firing's schedule row.
  // Default = the post-consume state of a fired one-shot (enabled:false,
  // lastStatus 'started') — the KEEP case; drop cases override per-test.
  chatSchedule: {
    findUnique: jest.fn(async () => ({ lastStatus: 'started' })),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Seat pre-flight (2026-09-04): the REAL seatUnservableReason reads provider
// env keys, and this jest env is keyless — every run would fail fast with
// SeatUnservableError before reaching the mocked workers.
jest.mock('../coding/coding-model', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/coding-model'),
  seatUnservableReason: jest.fn(async () => null),
}));

jest.mock('../coding/agent', () => ({
  runCodingAgent: jest.fn(async () => ({ finalText: 'A'.repeat(500) })),
  runChatWorker: jest.fn(async () => ({ finalText: '' })),
}));
jest.mock('../mcp-search', () => ({
  searchWithBrightData: jest.fn(async () => ''),
  SEARCH_UNAVAILABLE_NOTE: '[search unavailable]',
}));
jest.mock('../langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: { saveToSessionHistory: jest.fn(async () => {}) },
}));
jest.mock('../integrations/moonshot.integration', () => ({
  __esModule: true,
  default: { generateTitle: jest.fn(async () => 'A Generated Title') },
}));
const mockStampHookDepth = jest.fn(async (..._a: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  clearHookDepth: jest.fn(async () => {}),
  stampHookDepth: (...a: any[]) => mockStampHookDepth(...a),
}));
// Non-empty prior history: skips the up-front title block (whose 12s race
// timer would linger) and the stale-title repair early-returns.
jest.mock('./chat-context', () => ({
  buildChatQueryContext: jest.fn(async (a: any) => ({
    queryMessage: a.message,
    systemContext: '',
    conversationHistory: [{ role: 'user', content: 'earlier' }],
    projectId: null,
  })),
  persistAndEmitCanvases: jest.fn(async () => []),
}));

const mockLoadAttachment = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockCombineAttachments = jest.fn((atts: any[]) =>
  atts.length ? { ...atts[0], additionalFiles: atts.slice(1) } : undefined);
jest.mock('../upload.controller', () => ({
  attachmentKey: (id: string) => `cm:upload:${id}`,
  loadAttachment: (...a: any[]) => mockLoadAttachment(...a),
  combineAttachments: (a: any[]) => mockCombineAttachments(a),
}));
const mockMapAttachmentForAgent = jest.fn((combined: any) => {
  if (!combined) return {};
  const out: any = {};
  if (combined.type === 'image' && combined.base64) {
    out.userImages = [{ mediaType: combined.mimeType || 'image/png', data: combined.base64, name: combined.filename }];
  }
  if (combined.extractedText) out.documentText = `[uploaded docs]\n${combined.extractedText}`;
  return out;
});
jest.mock('./chat-gate', () => ({ mapAttachmentForAgent: (a: any) => mockMapAttachmentForAgent(a) }));

import { enqueueChatMessage, countPending, readPendingOrigin } from './message-queue.service';
import { drainChatQueue } from './chat-agent.service';
import { runCodingAgent } from '../coding/agent';
import { isRunActive } from '../coding/live-runs';

const mockRunCodingAgent = runCodingAgent as jest.Mock;

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for condition');
}

/**
 * ASYNC variant of waitFor — for predicates that must AWAIT (a DB/count read).
 * waitFor's predicate is SYNC, so passing an async one returns a Promise, which
 * is always truthy: the wait passes vacuously on its first call. Anything that
 * needs an await must come through here.
 */
async function waitUntil(pred: () => Promise<boolean>, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred()) && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
}

/** The persisted user row a drained run left behind (by content needle). */
function drainedUserRow(needle: string) {
  return mockPrisma.crossModelMessage.create.mock.calls
    .map((c: any[]) => c[0]?.data)
    .find((d: any) => d?.role === 'user' && String(d?.content ?? '').includes(needle));
}

beforeEach(() => {
  jest.clearAllMocks();
  pendingRows.length = 0;
  pendingSeq = 0;
  transcriptRows.length = 0;
  redisStore.clear(); // a leaked liveness key must not fail a later claim
});

describe('3405e332 — schedule-origin busy-queue drain', () => {
  it('a schedule firing enqueued behind a busy chat round-trips its origin stash (kind schedule + scheduleId)', async () => {
    const { id } = await enqueueChatMessage({
      chatId: 'chat-sq0', userId: 'u1', content: 'check back on the outage', source: 'schedule',
      origin: { kind: 'schedule', scheduleId: 'sch_9' },
    });
    await expect(readPendingOrigin(id)).resolves.toEqual({ kind: 'schedule', scheduleId: 'sch_9' });
  });

  it('REPLAY: a queued ONE-SHOT firing drains as a machine wake once the lane frees — no more silent drift', async () => {
    await enqueueChatMessage({
      chatId: 'chat-sq1', userId: 'u1', content: 'check back on the provider billing outage', source: 'schedule',
      origin: { kind: 'schedule', scheduleId: 'sch_1' },
    });
    await expect(drainChatQueue('chat-sq1', 'u1')).resolves.toBe(true);
    // The cancel-wins guard re-read the schedule row and KEPT the firing
    // (lastStatus 'started' = the consumed one-shot, not a cancel class).
    expect(mockPrisma.chatSchedule.findUnique).toHaveBeenCalledWith({ where: { id: 'sch_1' }, select: { lastStatus: true } });
    // MERGE-1 kill-window fix (2026-11-05): consumption moved from dequeue to
    // the persist transaction — assert it lands, not that it lands early.
    // Poll explicitly: waitFor takes a SYNC predicate, so an async one would
    // be truthy on its first call and pass vacuously.
    await waitUntil(async () => (await countPending('chat-sq1')) === 0);
    expect(await countPending('chat-sq1')).toBe(0); // row consumed at persist
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('provider billing outage')));
    // Provenance: the drained run is stamped like the direct fire path
    // (messageOrigin 'schedule') — never laundered into a human turn.
    await waitFor(() => !!drainedUserRow('provider billing outage'));
    expect(drainedUserRow('provider billing outage').metadata).toMatchObject({ origin: 'schedule' });
    await waitFor(() => !isRunActive('chat:chat-sq1'));
    await new Promise((r) => setTimeout(r, 100)); // let the drained run's own fire-and-forget drain settle
  });

  // ── One-shot CHAIN provenance (finding B1): the drain re-threads the
  // stashed scheduleId into the run so its own-chat `once` re-arms still
  // stamp their chain link exactly like the direct fire path.
  it('finding B1 — a drained schedule firing reaches the agent loop with firedByScheduleId = the stashed scheduleId', async () => {
    await enqueueChatMessage({
      chatId: 'chat-sq1b', userId: 'u1', content: 'resume the grid probe', source: 'schedule',
      origin: { kind: 'schedule', scheduleId: 'sch_chain_1' },
    });
    await expect(drainChatQueue('chat-sq1b', 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('resume the grid probe')));
    const call = mockRunCodingAgent.mock.calls.find(c => String(c[0]?.userMessage).includes('resume the grid probe'));
    expect(call?.[0]?.firedByScheduleId).toBe('sch_chain_1');
    await waitFor(() => !isRunActive('chat:chat-sq1b'));
    await new Promise((r) => setTimeout(r, 100));
  });

  it('finding B1 CONTROL — a queued message with NO schedule origin reaches the agent loop with no firedByScheduleId', async () => {
    await enqueueChatMessage({ chatId: 'chat-sq1c', userId: 'u1', content: 'a plain queued note', source: 'agent' });
    await expect(drainChatQueue('chat-sq1c', 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('a plain queued note')));
    const call = mockRunCodingAgent.mock.calls.find(c => String(c[0]?.userMessage).includes('a plain queued note'));
    expect(call?.[0]?.firedByScheduleId).toBeUndefined();
    await waitFor(() => !isRunActive('chat:chat-sq1c'));
    await new Promise((r) => setTimeout(r, 100));
  });

  it('cancel-wins: a firing whose schedule was CANCELLED after queueing is dropped, never delivered', async () => {
    // The incident shape verbatim: the owner answered the watched question and
    // the schedule was cancelled BEFORE the lane freed — delivering now would
    // fire a stale reminder.
    mockPrisma.chatSchedule.findUnique.mockResolvedValueOnce({ lastStatus: 'cancelled' });
    await enqueueChatMessage({
      chatId: 'chat-sq2', userId: 'u1', content: 'stale recharge-card reminder', source: 'schedule',
      origin: { kind: 'schedule', scheduleId: 'sch_2' },
    });
    await expect(drainChatQueue('chat-sq2', 'u1')).resolves.toBe(false); // nothing startable left
    expect(mockRunCodingAgent).not.toHaveBeenCalled();
    expect(await countPending('chat-sq2')).toBe(0); // the stale row is gone, not re-queued
  });

  it('cancel-wins: a firing whose schedule row was DELETED after queueing is dropped', async () => {
    mockPrisma.chatSchedule.findUnique.mockResolvedValueOnce(null);
    await enqueueChatMessage({
      chatId: 'chat-sq3', userId: 'u1', content: 'dead schedule firing', source: 'schedule',
      origin: { kind: 'schedule', scheduleId: 'sch_3' },
    });
    await expect(drainChatQueue('chat-sq3', 'u1')).resolves.toBe(false);
    expect(mockRunCodingAgent).not.toHaveBeenCalled();
    expect(await countPending('chat-sq3')).toBe(0);
  });

  it('a schedule-read ERROR never drops the firing (fail-open — uncertainty must not lose a real firing)', async () => {
    mockPrisma.chatSchedule.findUnique.mockRejectedValueOnce(new Error('db blip'));
    await enqueueChatMessage({
      chatId: 'chat-sq4', userId: 'u1', content: 'firing survives a guard hiccup', source: 'schedule',
      origin: { kind: 'schedule', scheduleId: 'sch_4' },
    });
    await expect(drainChatQueue('chat-sq4', 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('guard hiccup')));
    await waitFor(() => !isRunActive('chat:chat-sq4'));
    await new Promise((r) => setTimeout(r, 100));
  });

  it('a lost origin stash still drains machine-marked via the row source column (no guard read possible)', async () => {
    await enqueueChatMessage({
      chatId: 'chat-sq5', userId: 'u1', content: 'stash-less schedule firing', source: 'schedule', // no origin → no stash
    });
    await expect(drainChatQueue('chat-sq5', 'u1')).resolves.toBe(true);
    expect(mockPrisma.chatSchedule.findUnique).not.toHaveBeenCalled(); // no scheduleId → nothing to check
    await waitFor(() => !!drainedUserRow('stash-less schedule firing'));
    expect(drainedUserRow('stash-less schedule firing').metadata).toMatchObject({ origin: 'schedule' });
    await waitFor(() => !isRunActive('chat:chat-sq5'));
    await new Promise((r) => setTimeout(r, 100));
  });

  it('a dropped firing falls through to the NEXT queued message in the same drain', async () => {
    mockPrisma.chatSchedule.findUnique.mockResolvedValueOnce({ lastStatus: 'skipped:cancelled' });
    await enqueueChatMessage({
      chatId: 'chat-sq6', userId: 'u1', content: 'cancelled schedule firing', source: 'schedule',
      origin: { kind: 'schedule', scheduleId: 'sch_6' },
    });
    await enqueueChatMessage({ chatId: 'chat-sq6', userId: 'u1', content: 'real agent nudge behind it', source: 'agent' });
    await expect(drainChatQueue('chat-sq6', 'u1')).resolves.toBe(true);
    expect(mockPrisma.chatSchedule.findUnique).toHaveBeenCalledTimes(1); // guard ran only for the schedule row
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('real agent nudge behind it')));
    expect(await countPending('chat-sq6')).toBe(0); // both rows consumed (drop + start)
    await waitFor(() => !isRunActive('chat:chat-sq6'));
    await new Promise((r) => setTimeout(r, 100));
  });
});

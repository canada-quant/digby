/**
 * Busy-chat message queue (2026-08-07) — message-queue.service (enqueue/peek/
 * delete/count over an in-memory pending_chat_messages table) + the REAL
 * chat-agent.service drainChatQueue: no-op while a run is active, starts the
 * OLDEST queued message when idle, deletes the row on dequeue, one-per-drain
 * (the new run's own finally drains the next — the FIFO chain).
 *
 * live-runs is the REAL in-memory registry (the busy gate is exactly what the
 * drain keys on); prisma, the agent loop, search, memory, titles, and hooks
 * are mocked so a drained run completes in milliseconds. Mocking pattern
 * follows chat-agent.service.test.ts / platform.service.test.ts.
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

// message-queue.service's origin stash rides config/redis (whose chain reaches
// config/env → process.exit at import) — map-backed mock with honest get/set/del.
// chat-busy's cross-process layer rides the SAME store with REAL SET NX semantics
// (drainChatQueue's idle check and the drained run's atomic claim use it).
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
    // Coalesced agent drain (2026-09-14): peekOldestAgentBatch reads the oldest N agent rows.
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
    // MERGE-1 cutover kill-window fix (2026-11-05): the drain no longer deletes
    // right after the claim — the run's own persist consumes the rows via
    // createMessagesConsumingPending, which uses deleteMany({ id: { in } }).
    deleteMany: jest.fn(async ({ where }: any) => {
      const ids: string[] = where?.id?.in ?? (where?.id ? [where.id] : []);
      let count = 0;
      for (const id of ids) {
        const i = pendingRows.findIndex(r => r.id === id);
        if (i >= 0) { pendingRows.splice(i, 1); count += 1; }
      }
      return { count };
    }),
    // Full-queue coalesce (loop #15): the same sender's newest row absorbs the follow-up.
    update: jest.fn(async ({ where, data }: any) => {
      const r = pendingRows.find(x => x.id === where.id);
      if (r) Object.assign(r, data);
      return r ?? {};
    }),
  },
  // chat-agent run persistence (a drained run executes a REAL detached turn).
  crossModelMessage: {
    create: jest.fn(async () => ({})),
    // Supersession marker (c6db9c72): latestOwnerRowsAfter reads the SOURCE
    // chats' user rows — newest-first within the createdAt window.
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
// REAL all-or-nothing semantics: writes are buffered and applied only when the
// callback resolves, so a transaction that fails leaves BOTH tables untouched
// (an eager mock would make the atomicity claim unprovable).
  $transaction: jest.fn(async (fn: any) => {
    const created: any[] = [];
    let consumedIds: string[] = [];
    const tx = {
      crossModelMessage: {
        // Delegate to the SAME mock the non-transactional path uses, so tests
        // asserting on crossModelMessage.create stay meaningful either way.
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
    // COMMIT — both effects land together, or neither does.
    for (const r of created) transcriptRows.push(r);
    for (const id of consumedIds) {
      const i = pendingRows.findIndex(r => r.id === id);
      if (i >= 0) pendingRows.splice(i, 1);
    }
    return out;
  }),
  // chat-busy's durable layer (worker-tier coding runs) — none in these tests.
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Loop-#15 coalesce telemetry rides a dynamic import — keep the real module (and its prisma) out.
const mockRecordLoopMetricMQ = jest.fn(async () => {});
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => (mockRecordLoopMetricMQ as any)(...a),
  recordLoopMetrics: jest.fn(),
  LOOP_METRIC_KINDS: { CHAT_QUEUE_COALESCED: 'chat_queue_coalesced', QUEUE_FAIRNESS_PREEMPT: 'queue_fairness_preempt', HOOK_STARVATION_YIELD: 'hook_starvation_yield', FINALIZE_HANDOFF: 'finalize_handoff' },
}));

// Seat pre-flight (2026-09-04): the REAL seatUnservableReason reads provider
// env keys, and this jest env is keyless — every run would fail fast with
// SeatUnservableError before reaching the mocked workers. Keep the rest of
// coding-model REAL (resolveRoleModelForRun etc. are exercised).
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
// The drained run's finalize emits hook events via a fire-and-forget dynamic
// import — mocked at the module boundary (the real module's chain reaches
// config/env → process.exit at import). stampHookDepth: the drain re-stamps a
// queued agent send's wake-depth onto the chat (depth ladder through hops).
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
  // queryMessage passes the DRAINED message through so runCodingAgent's
  // userMessage observably carries it (the real builder wraps it in context).
  buildChatQueryContext: jest.fn(async (a: any) => ({
    queryMessage: a.message,
    systemContext: '',
    conversationHistory: [{ role: 'user', content: 'earlier' }],
    projectId: null,
  })),
  persistAndEmitCanvases: jest.fn(async () => []),
}));

// Queued attachments (ac65d51e): the drain resolves staged upload ids through
// upload.controller (load/combine) + chat-gate (map) — both dynamically
// imported. Mocked at the boundary: upload.controller's chain (multer /
// ingestion) is import-heavy and the real combine/map internals have their own
// suites — what's under test HERE is the queue→dequeue handoff itself.
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

import {
  enqueueChatMessage, peekOldest, deletePending, countPending, countPendingUser, readPendingOrigin, MAX_QUEUE_DEPTH,
  SUPERSEDED_STEER_NOTE_PREFIX, oldestPendingHead, COALESCED_FOLLOW_UP_PREFIX, QUEUE_COALESCE_MAX_CHARS,
} from './message-queue.service';
import { drainChatQueue, nudgeQueueDrainSoon } from './chat-agent.service';
import { runCodingAgent } from '../coding/agent';
import { isRunActive, startLiveRun, endLiveRun } from '../coding/live-runs';

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

beforeEach(() => {
  jest.clearAllMocks();
  pendingRows.length = 0;
  pendingSeq = 0;
  transcriptRows.length = 0;
  redisStore.clear(); // a leaked liveness key must not fail a later claim
});

describe('enqueueChatMessage', () => {
  it('persists the row and reports the 1-based FIFO position', async () => {
    const r1 = await enqueueChatMessage({ chatId: 'c1', userId: 'u1', content: 'first', mode: 'thinking', source: 'user' });
    const r2 = await enqueueChatMessage({ chatId: 'c1', userId: 'u1', content: 'second', mode: null, source: 'agent' });
    expect(r1.position).toBe(1);
    expect(r2.position).toBe(2);
    expect(pendingRows).toHaveLength(2);
    expect(pendingRows[0]).toMatchObject({ chatId: 'c1', userId: 'u1', content: 'first', mode: 'thinking', source: 'user' });
    // The cap is per CHAT — another chat's queue positions independently.
    const other = await enqueueChatMessage({ chatId: 'c2', userId: 'u1', content: 'elsewhere', source: 'agent' });
    expect(other.position).toBe(1);
  });

  it('peekOldest returns the OLDEST row within a class (FIFO); deletePending removes it; countPending counts', async () => {
    await enqueueChatMessage({ chatId: 'c1', userId: 'u1', content: 'first', source: 'user' });
    await enqueueChatMessage({ chatId: 'c1', userId: 'u1', content: 'second', source: 'user' });
    expect(await countPending('c1')).toBe(2);
    const oldest = await peekOldest('c1');
    expect(oldest?.content).toBe('first');
    await deletePending(oldest!.id);
    expect(await countPending('c1')).toBe(1);
    expect((await peekOldest('c1'))?.content).toBe('second');
    expect(await peekOldest('c-empty')).toBeNull();
  });

  it('F2a priority: USER-origin rows peek BEFORE older machine/relay rows; machine rows stay FIFO among themselves', async () => {
    // Machine traffic queues first (the 2026-09-04 incident shape: relay/agent
    // rows ahead of the owner's typed question in a plain FIFO).
    await enqueueChatMessage({ chatId: 'cq', userId: 'u1', content: 'relay one', source: 'agent' });
    await enqueueChatMessage({ chatId: 'cq', userId: 'u1', content: 'relay two', source: 'webhook' });
    await enqueueChatMessage({ chatId: 'cq', userId: 'u1', content: 'owner question', source: 'user' });
    const head = await peekOldest('cq');
    expect(head?.content).toBe('owner question');
    await deletePending(head!.id);
    // With no user rows left the machine rows drain in their own FIFO order.
    expect((await peekOldest('cq'))?.content).toBe('relay one');
  });

  it('countPendingUser counts ONLY user-typed rows (F3 honest-status source)', async () => {
    await enqueueChatMessage({ chatId: 'cc', userId: 'u1', content: 'relay', source: 'agent' });
    await enqueueChatMessage({ chatId: 'cc', userId: 'u1', content: 'hook fire', source: 'webhook' });
    expect(await countPendingUser('cc')).toBe(0);
    await enqueueChatMessage({ chatId: 'cc', userId: 'u1', content: 'mine', source: 'user' });
    expect(await countPendingUser('cc')).toBe(1);
    expect(await countPending('cc')).toBe(3);
  });

  it('an AGENT send stashes its fleet origin + depth (Redis side-channel); readPendingOrigin round-trips it', async () => {
    const { id } = await enqueueChatMessage({
      chatId: 'c1', userId: 'u1', content: 'nudge', source: 'agent',
      origin: { kind: 'agent', sourceChatId: 'sup-1', depth: 2 },
    });
    await expect(readPendingOrigin(id)).resolves.toEqual({ kind: 'agent', sourceChatId: 'sup-1', depth: 2 });
    // deletePending clears the stash with the row.
    await deletePending(id);
    await expect(readPendingOrigin(id)).resolves.toBeNull();
  });

  it('a USER send stashes nothing, and a Redis hiccup never blocks an agent enqueue (origin degrades)', async () => {
    const { id } = await enqueueChatMessage({ chatId: 'c1', userId: 'u1', content: 'hello', source: 'user' });
    await expect(readPendingOrigin(id)).resolves.toBeNull();
    mockRedis.set.mockRejectedValueOnce(new Error('down'));
    await expect(enqueueChatMessage({
      chatId: 'c1', userId: 'u1', content: 'nudge', source: 'agent',
      origin: { kind: 'agent', sourceChatId: 'sup-1', depth: 1 },
    })).resolves.toMatchObject({ position: 2 });
  });

  it(`the ${MAX_QUEUE_DEPTH + 1}th message throws AppError(409) 'queue is full'`, async () => {
    for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
      await enqueueChatMessage({ chatId: 'c1', userId: 'u1', content: `m${i}`, source: 'agent' });
    }
    await expect(enqueueChatMessage({ chatId: 'c1', userId: 'u1', content: 'one too many', source: 'agent' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/queue is full/i) });
    expect(await countPending('c1')).toBe(MAX_QUEUE_DEPTH); // the 21st did NOT persist
    // …but a DIFFERENT chat still accepts.
    await expect(enqueueChatMessage({ chatId: 'c2', userId: 'u1', content: 'fine', source: 'agent' }))
      .resolves.toMatchObject({ position: 1 });
  });

  it('queued attachments (ac65d51e): uploadIds persist on the row and each blob TTL is stretched', async () => {
    mockRedis.expire.mockClear();
    await enqueueChatMessage({ chatId: 'c1', userId: 'u1', content: 'with files', source: 'user', uploadIds: ['u-a', 'u-b'] });
    expect((await peekOldest('c1'))?.uploadIds).toEqual(['u-a', 'u-b']);
    expect(mockRedis.expire).toHaveBeenCalledWith('cm:upload:u-a', 24 * 60 * 60);
    expect(mockRedis.expire).toHaveBeenCalledWith('cm:upload:u-b', 24 * 60 * 60);
    // No ids → no TTL writes (the plain-text path is untouched).
    mockRedis.expire.mockClear();
    await enqueueChatMessage({ chatId: 'c1', userId: 'u1', content: 'plain', source: 'user' });
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });
});

describe('drainChatQueue', () => {
  it('is a no-op while a run is active (the row stays queued; no run starts)', async () => {
    await enqueueChatMessage({ chatId: 'chat-d1', userId: 'u1', content: 'later', mode: 'single_thinking', source: 'user' });
    startLiveRun('chat:chat-d1');
    try {
      await expect(drainChatQueue('chat-d1', 'u1')).resolves.toBe(false);
      expect(mockRunCodingAgent).not.toHaveBeenCalled();
      expect(await countPending('chat-d1')).toBe(1); // untouched
    } finally {
      endLiveRun('chat:chat-d1');
    }
  });

  it('idle chat with an empty queue → false, nothing starts', async () => {
    await expect(drainChatQueue('chat-d2', 'u1')).resolves.toBe(false);
    expect(mockRunCodingAgent).not.toHaveBeenCalled();
  });

  it('a RETIRING colour (deploy drain, 2026-09-18) starts NO machine run — the queued agent row stays for the new colour, then drains once the flag is gone', async () => {
    const { markRetiring, __resetRetiringForTests } = await import('../coding/retiring');
    await enqueueChatMessage({ chatId: 'chat-dr', userId: 'u1', content: 'lane report-up', mode: 'single_thinking', source: 'agent' });
    markRetiring();
    try {
      await expect(drainChatQueue('chat-dr', 'u1')).resolves.toBe(false);
      expect(mockRunCodingAgent).not.toHaveBeenCalled();
      expect(isRunActive('chat:chat-dr')).toBe(false); // no local slot taken, nothing to release
      expect(await countPending('chat-dr')).toBe(1);    // row untouched
    } finally {
      __resetRetiringForTests();
    }
    await expect(drainChatQueue('chat-dr', 'u1')).resolves.toBe(true);
    await waitFor(() => !isRunActive('chat:chat-dr'));
  });

  it('idle chat: starts a run carrying the OLDEST message and consumes its row at persist', async () => {
    await enqueueChatMessage({ chatId: 'chat-d3', userId: 'u1', content: 'oldest question', mode: 'single_thinking', source: 'agent' });
    await expect(drainChatQueue('chat-d3', 'u1')).resolves.toBe(true);
    expect(isRunActive('chat:chat-d3')).toBe(true);      // the run registered synchronously
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('oldest question')));
    // MERGE-1 kill-window fix (2026-11-05): the row is no longer deleted when
    // the drain returns — it is consumed in the SAME transaction that persists
    // the transcript row, which is what makes a cutover kill unable to
    // duplicate (row survives + liveness expires) or lose (deleted, never
    // persisted) the message. Asserted at persist, not at dequeue.
    // NOTE: poll explicitly — waitFor takes a SYNC predicate, so an async one
    // would be truthy on its first call and pass vacuously.
    await waitUntil(async () => (await countPending('chat-d3')) === 0);
    expect(await countPending('chat-d3')).toBe(0);
    await waitFor(() => !isRunActive('chat:chat-d3'));   // let the run finish cleanly
  });

  it('ONE message per drain — the new run’s own finally drains the next (FIFO chain)', async () => {
    await enqueueChatMessage({ chatId: 'chat-d4', userId: 'u1', content: 'msg one', mode: 'single_thinking', source: 'user' });
    await enqueueChatMessage({ chatId: 'chat-d4', userId: 'u1', content: 'msg two', mode: 'single_thinking', source: 'agent' });

    // Hold the FIRST run in flight (otherwise the ms-fast mock completes and
    // its finally drains row 2 before the intermediate assertions run).
    let releaseRunA!: () => void;
    const gateA = new Promise<void>(res => { releaseRunA = res; });
    mockRunCodingAgent.mockImplementationOnce(async () => { await gateA; return { finalText: 'A'.repeat(500) }; });

    await expect(drainChatQueue('chat-d4', 'u1')).resolves.toBe(true);
    // Exactly ONE run started, carrying the oldest; the second row is still queued.
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('msg one')));
    expect(mockRunCodingAgent.mock.calls.filter(c => String(c[0]?.userMessage).includes('msg two'))).toHaveLength(0);
    expect((await peekOldest('chat-d4'))?.content).toBe('msg two');

    // The first run finishes → its finally drains the second message → FIFO order.
    releaseRunA();
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('msg two')));
    await waitFor(() => !isRunActive('chat:chat-d4') && pendingRows.filter(r => r.chatId === 'chat-d4').length === 0);
    const carried = mockRunCodingAgent.mock.calls.map(c => String(c[0]?.userMessage));
    expect(carried.findIndex(m => m.includes('msg one'))).toBeLessThan(carried.findIndex(m => m.includes('msg two')));
  });

  it('drains a queued AGENT send MARKED (metadata.origin + sourceChatId) and re-stamps the sender depth', async () => {
    await enqueueChatMessage({
      chatId: 'chat-d6', userId: 'u1', content: 'agent nudge', mode: 'single_thinking', source: 'agent',
      origin: { kind: 'agent', sourceChatId: 'sup-1', depth: 2 },
    });
    await expect(drainChatQueue('chat-d6', 'u1')).resolves.toBe(true);
    // Depth propagation through the queued hop (hooks.service ladder).
    expect(mockStampHookDepth).toHaveBeenCalledWith('chat-d6', 2);
    // The drained run persists its user row marked — the fleet views must not
    // render a queued nudge as an interactive human turn.
    await waitFor(() => mockPrisma.crossModelMessage.create.mock.calls.some((c: any[]) =>
      c[0]?.data?.role === 'user' && c[0]?.data?.metadata?.origin === 'agent' && c[0]?.data?.metadata?.sourceChatId === 'sup-1'));
    await waitFor(() => !isRunActive('chat:chat-d6'));
  });

  it('a queued agent send at depth 0 drains marked but does NOT stamp (no wake chain to climb)', async () => {
    await enqueueChatMessage({
      chatId: 'chat-d7', userId: 'u1', content: 'cold nudge', mode: 'single_thinking', source: 'agent',
      origin: { kind: 'agent', sourceChatId: 'sup-1', depth: 0 },
    });
    await expect(drainChatQueue('chat-d7', 'u1')).resolves.toBe(true);
    expect(mockStampHookDepth).not.toHaveBeenCalled();
    await waitFor(() => mockPrisma.crossModelMessage.create.mock.calls.some((c: any[]) =>
      c[0]?.data?.role === 'user' && c[0]?.data?.metadata?.origin === 'agent'));
    await waitFor(() => !isRunActive('chat:chat-d7'));
  });

  it('a drained USER send keeps HUMAN provenance — never machine-stamped (explicit user stamp or unset)', async () => {
    await enqueueChatMessage({ chatId: 'chat-d8', userId: 'u1', content: 'human q', mode: 'single_thinking', source: 'user' });
    await expect(drainChatQueue('chat-d8', 'u1')).resolves.toBe(true);
    expect(mockStampHookDepth).not.toHaveBeenCalled();
    await waitFor(() => mockPrisma.crossModelMessage.create.mock.calls.some((c: any[]) => c[0]?.data?.role === 'user'));
    const userRow = mockPrisma.crossModelMessage.create.mock.calls.find((c: any[]) => c[0]?.data?.role === 'user');
    // The drain stamps an explicit {origin:'user'} (audit p10) or leaves metadata
    // unset — both classify as an interactive human turn in the fleet views.
    expect(userRow[0].data.metadata?.origin ?? 'user').toBe('user');
    await waitFor(() => !isRunActive('chat:chat-d8'));
  });

  it('an unrecognized stored mode falls back to a runnable level (never crashes the drain)', async () => {
    await enqueueChatMessage({ chatId: 'chat-d5', userId: 'u1', content: 'odd mode', mode: 'browser_agent', source: 'user' });
    await expect(drainChatQueue('chat-d5', 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('odd mode')));
    await waitFor(() => !isRunActive('chat:chat-d5'));
    expect(await countPending('chat-d5')).toBe(0);
  });

  it('queued attachments (ac65d51e): the drain resolves staged ids into the run — documentText + chip metadata', async () => {
    mockLoadAttachment.mockImplementation(async (id: string) =>
      id === 'up-doc' ? { type: 'document', filename: 'notes.txt', extractedText: 'QUEUE-DOC-TEXT' } : null);
    await enqueueChatMessage({ chatId: 'chat-da1', userId: 'u1', content: 'read this', mode: 'single_thinking', source: 'user', uploadIds: ['up-doc'] });
    await expect(drainChatQueue('chat-da1', 'u1')).resolves.toBe(true);
    // The drained run's query carries the extracted document text (the same
    // seam as an immediate send: startDetachedChatRun merges documentText).
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('QUEUE-DOC-TEXT')));
    // Filename+type chips land on the persisted user row (metadata.attachments),
    // carrying the staged uploadId (c6e8edda) — the read-time ChatFile join key
    // for the inline-image render.
    await waitFor(() => mockPrisma.crossModelMessage.create.mock.calls.some((c: any[]) =>
      c[0]?.data?.role === 'user'
      && Array.isArray(c[0]?.data?.metadata?.attachments)
      && c[0].data.metadata.attachments[0]?.filename === 'notes.txt'
      && c[0].data.metadata.attachments[0]?.type === 'document'
      && c[0].data.metadata.attachments[0]?.uploadId === 'up-doc'));
    await waitFor(() => !isRunActive('chat:chat-da1'));
    expect(await countPending('chat-da1')).toBe(0); // row consumed on dequeue
  });

  it('queued attachments (ac65d51e): an expired blob annotates the drained message — never a silent drop', async () => {
    mockLoadAttachment.mockResolvedValue(null); // Redis TTL lapsed mid-queue
    await enqueueChatMessage({ chatId: 'chat-da2', userId: 'u1', content: 'see file', mode: 'single_thinking', source: 'user', uploadIds: ['up-gone'] });
    await expect(drainChatQueue('chat-da2', 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c =>
      String(c[0]?.userMessage).includes('see file')
      && String(c[0]?.userMessage).includes('expired before this queued message ran')));
    await waitFor(() => !isRunActive('chat:chat-da2'));
  });

  it('F2a: drains the USER-origin row BEFORE an OLDER machine row for the same chat (owner incident 2026-09-04)', async () => {
    // The incident FIFO: machine relay queued first, then the owner typed.
    await enqueueChatMessage({
      chatId: 'chat-p1', userId: 'u1', content: 'machine relay', mode: 'single_thinking', source: 'agent',
      origin: { kind: 'agent', sourceChatId: 'sup-1', depth: 0 },
    });
    await enqueueChatMessage({ chatId: 'chat-p1', userId: 'u1', content: 'owner question', mode: 'single_thinking', source: 'user' });

    // Hold the first drained run so the intermediate order is observable.
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    mockRunCodingAgent.mockImplementationOnce(async () => { await gate; return { finalText: 'A'.repeat(500) }; });

    await expect(drainChatQueue('chat-p1', 'u1')).resolves.toBe(true);
    // The USER message ran first even though the machine row is older…
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('owner question')));
    expect(mockRunCodingAgent.mock.calls.filter(c => String(c[0]?.userMessage).includes('machine relay'))).toHaveLength(0);
    expect((await peekOldest('chat-p1'))?.content).toBe('machine relay'); // still queued, not lost
    // …and the machine row drains next off the finished run's finally.
    release();
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('machine relay')));
    await waitFor(() => !isRunActive('chat:chat-p1') && pendingRows.filter(r => r.chatId === 'chat-p1').length === 0);
    const carried = mockRunCodingAgent.mock.calls.map(c => String(c[0]?.userMessage));
    expect(carried.findIndex(m => m.includes('owner question'))).toBeLessThan(carried.findIndex(m => m.includes('machine relay')));
  });

  it('F2b: a message enqueued MID-RUN drains at that run\'s finalize — immediately, no sweep involved', async () => {
    // Start a held run first (an empty queue — the run comes from a direct start
    // via the drain of a seed row), then enqueue while it is ACTIVE.
    await enqueueChatMessage({ chatId: 'chat-p2', userId: 'u1', content: 'seed turn', mode: 'single_thinking', source: 'user' });
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    mockRunCodingAgent.mockImplementationOnce(async () => { await gate; return { finalText: 'A'.repeat(500) }; });
    await expect(drainChatQueue('chat-p2', 'u1')).resolves.toBe(true);
    await waitFor(() => isRunActive('chat:chat-p2'));
    // MERGE-1 kill-window fix (2026-11-05): the SEED row is now consumed at the
    // run's persist, which lands AFTER isRunActive flips (the claim registers
    // synchronously). Wait for that consume, otherwise the assertion below
    // counts the seed row as well as the mid-run one.
    await waitUntil(async () => (await countPending('chat-p2')) === 0);

    // The user types while the run is busy — the send path enqueues.
    await enqueueChatMessage({ chatId: 'chat-p2', userId: 'u1', content: 'typed while busy', mode: 'single_thinking', source: 'user' });
    expect(await countPending('chat-p2')).toBe(1);

    // Run finishes → its finally triggers the immediate drain (the assertion:
    // the queued row starts WITHOUT any sweeper/nudge call in this test).
    release();
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('typed while busy')));
    await waitFor(() => !isRunActive('chat:chat-p2'));
    expect(await countPending('chat-p2')).toBe(0);
  });

  it('F2b: nudgeQueueDrainSoon delivers a row enqueued into an ALREADY-IDLE chat (the enqueue-vs-finalize race) — and is a no-op while busy', async () => {
    // The incident race: the busy check saw a dying run, the enqueue landed
    // AFTER its finalize drain — with no future finalize, only the sweep would
    // ever deliver. The nudge closes it.
    await enqueueChatMessage({ chatId: 'chat-p3', userId: 'u1', content: 'raced the finalize', mode: 'single_thinking', source: 'user' });
    nudgeQueueDrainSoon('chat-p3', 'u1', [10]);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('raced the finalize')));
    await waitFor(() => !isRunActive('chat:chat-p3'));
    expect(await countPending('chat-p3')).toBe(0);

    // Busy chat: the nudge must not double-run — the row stays queued.
    await enqueueChatMessage({ chatId: 'chat-p4', userId: 'u1', content: 'stays queued', mode: 'single_thinking', source: 'user' });
    startLiveRun('chat:chat-p4');
    try {
      nudgeQueueDrainSoon('chat-p4', 'u1', [10]);
      await new Promise(r => setTimeout(r, 60));
      expect(await countPending('chat-p4')).toBe(1);
      expect(mockRunCodingAgent.mock.calls.filter(c => String(c[0]?.userMessage).includes('stays queued'))).toHaveLength(0);
    } finally {
      endLiveRun('chat:chat-p4');
    }
  });
});

describe('coalesced report-up digest (owner 2026-09-14): consecutive queued AGENT rows drain as ONE turn', () => {
  it('three agent sends queued while busy → ONE run carrying all three (FIFO, provenance kept), max depth stamped, all rows deleted', async () => {
    await enqueueChatMessage({ chatId: 'chat-batch', userId: 'u1', content: '[AGENT-SENT MESSAGE — from chat "spark lane" (28de72e5)…]\nspark delta A', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: '28de72e5-0000-0000-0000-000000000000', depth: 1 } });
    await enqueueChatMessage({ chatId: 'chat-batch', userId: 'u1', content: 'bench delta B (older row, no header)', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: '615723ba-0000-0000-0000-000000000000', depth: 2 } });
    await enqueueChatMessage({ chatId: 'chat-batch', userId: 'u1', content: 'canlaw delta C', mode: 'single_thinking', source: 'agent' });
    await expect(drainChatQueue('chat-batch', 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('canlaw delta C')));
    const msgs = mockRunCodingAgent.mock.calls.map(c => String(c[0]?.userMessage)).filter(m => m.includes('delta'));
    expect(msgs).toHaveLength(1); // ONE run, not three
    const m = msgs[0];
    expect(m).toContain('3 agent messages arrived while this chat was busy');
    expect(m.indexOf('spark delta A')).toBeLessThan(m.indexOf('bench delta B'));
    expect(m.indexOf('bench delta B')).toBeLessThan(m.indexOf('canlaw delta C'));
    expect(m).toContain('[queued agent message from chat 615723ba'); // header-less row gets a minimal provenance line
    expect(mockStampHookDepth).toHaveBeenCalledWith('chat-batch', 2); // the DEEPEST sender
    await waitFor(() => !isRunActive('chat:chat-batch') && pendingRows.filter(r => r.chatId === 'chat-batch').length === 0);
  });

  it('a USER row drains alone and FIRST; the agent rows behind it batch on the next drain', async () => {
    await enqueueChatMessage({ chatId: 'chat-batch2', userId: 'u1', content: 'agent one', mode: 'single_thinking', source: 'agent' });
    await enqueueChatMessage({ chatId: 'chat-batch2', userId: 'u1', content: 'human typed this', mode: 'single_thinking', source: 'user' });
    await enqueueChatMessage({ chatId: 'chat-batch2', userId: 'u1', content: 'agent two', mode: 'single_thinking', source: 'agent' });
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    mockRunCodingAgent.mockImplementationOnce(async () => { await gate; return { finalText: 'A'.repeat(500) }; });
    await expect(drainChatQueue('chat-batch2', 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('human typed this')));
    const humanRun = mockRunCodingAgent.mock.calls.find(c => String(c[0]?.userMessage).includes('human typed this'));
    expect(String(humanRun![0]?.userMessage)).not.toContain('agent one'); // never coalesced with agent traffic
    expect(pendingRows.filter(r => r.chatId === 'chat-batch2')).toHaveLength(2);
    release();
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('agent two')));
    const agentRun = mockRunCodingAgent.mock.calls.find(c => String(c[0]?.userMessage).includes('agent two'));
    expect(String(agentRun![0]?.userMessage)).toContain('agent one'); // both agent rows in ONE turn
    expect(String(agentRun![0]?.userMessage)).toContain('2 agent messages arrived');
    await waitFor(() => !isRunActive('chat:chat-batch2') && pendingRows.filter(r => r.chatId === 'chat-batch2').length === 0);
  });

  it('a single queued agent row drains exactly as before (no digest wrapper)', async () => {
    await enqueueChatMessage({ chatId: 'chat-batch3', userId: 'u1', content: 'lone agent note', mode: 'single_thinking', source: 'agent' });
    await expect(drainChatQueue('chat-batch3', 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('lone agent note')));
    const run = mockRunCodingAgent.mock.calls.find(c => String(c[0]?.userMessage).includes('lone agent note'));
    expect(String(run![0]?.userMessage)).not.toContain('arrived while this chat was busy');
    await waitFor(() => !isRunActive('chat:chat-batch3'));
  });
});

describe('superseded-steer marker (ticket c6db9c72): a queued agent row drains with an owner-supersession note when the source chat has a NEWER owner row', () => {
  const SRC_A = '9e6e1712-0000-0000-0000-000000000000';
  const SRC_B = '615723ba-0000-0000-0000-000000000000';
  const lastRunWith = (needle: string) =>
    String(mockRunCodingAgent.mock.calls.find(c => String(c[0]?.userMessage).includes(needle))![0]?.userMessage);

  it('coalesced batch: only the section whose source chat has a newer owner row carries the marker (the fleet-incident shape)', async () => {
    await enqueueChatMessage({ chatId: 'chat-ss1', userId: 'u1', content: '[AGENT-SENT MESSAGE — from chat "spark" (9e6e1712), another Digby agent, NOT the owner.]\nstand down canlegal-bench dispatch', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: SRC_A, depth: 0 } });
    await enqueueChatMessage({ chatId: 'chat-ss1', userId: 'u1', content: 'bench acceptance', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: SRC_B, depth: 0 } });
    // The owner ruled in spark's chat AFTER the steer was queued (22:42Z ruling vs ~22:41Z enqueue).
    transcriptRows.push({ id: 'o1', chatId: SRC_A, role: 'user', content: 'splash belongs to canlegal-bench', createdAt: new Date(Date.now() + 60_000), metadata: { origin: 'user' } });
    await expect(drainChatQueue('chat-ss1', 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('stand down canlegal-bench')));
    const m = lastRunWith('stand down canlegal-bench');
    expect(m).toContain('2 agent messages arrived');
    const markerLines = m.split('\n').filter(l => l.includes(SUPERSEDED_STEER_NOTE_PREFIX));
    expect(markerLines).toHaveLength(1); // spark's section only — bench stays clean
    expect(markerLines[0]).toContain(SRC_A.slice(0, 8));
    expect(markerLines[0]).toContain('get_chat_messages');
    expect(m.indexOf(SUPERSEDED_STEER_NOTE_PREFIX)).toBeLessThan(m.indexOf('stand down canlegal-bench'));
    expect(m.indexOf('bench acceptance')).toBeGreaterThan(m.indexOf('stand down canlegal-bench')); // section order untouched
    await waitFor(() => !isRunActive('chat:chat-ss1') && pendingRows.filter(r => r.chatId === 'chat-ss1').length === 0);
  });

  it('no marker when the newest owner row is OLDER than the enqueue; machine-origin and assistant rows never trigger it', async () => {
    await enqueueChatMessage({ chatId: 'chat-ss2', userId: 'u1', content: 'agent delta', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: SRC_A, depth: 0 } });
    transcriptRows.push(
      { id: 'o-old', chatId: SRC_A, role: 'user', content: 'old owner note', createdAt: new Date(Date.now() - 3_600_000), metadata: { origin: 'user' } },
      { id: 'm-sched', chatId: SRC_A, role: 'user', content: '[MACHINE-TRIGGERED RUN …]', createdAt: new Date(Date.now() + 60_000), metadata: { origin: 'schedule' } },
      { id: 'm-agent', chatId: SRC_A, role: 'user', content: '[AGENT-SENT MESSAGE …]', createdAt: new Date(Date.now() + 61_000), metadata: { origin: 'agent', sourceChatId: 'x' } },
      { id: 'a-new', chatId: SRC_A, role: 'assistant', content: 'assistant activity', createdAt: new Date(Date.now() + 62_000) },
    );
    await expect(drainChatQueue('chat-ss2', 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('agent delta')));
    expect(lastRunWith('agent delta')).not.toContain(SUPERSEDED_STEER_NOTE_PREFIX);
    await waitFor(() => !isRunActive('chat:chat-ss2') && pendingRows.filter(r => r.chatId === 'chat-ss2').length === 0);
  });

  it('a single queued agent row drains with the marker prepended (no digest wrapper); metadata-less owner rows count', async () => {
    await enqueueChatMessage({ chatId: 'chat-ss3', userId: 'u1', content: 'lone steer', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: SRC_B, depth: 1 } });
    // Legacy owner row: NO metadata at all (undefined) — still an owner row.
    transcriptRows.push({ id: 'o-null', chatId: SRC_B, role: 'user', content: 'owner ruling (legacy null metadata)', createdAt: new Date(Date.now() + 60_000) });
    await expect(drainChatQueue('chat-ss3', 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('lone steer')));
    const m = lastRunWith('lone steer');
    expect(m).not.toContain('agent messages arrived'); // no digest wrapper for a single row
    expect(m).toContain(SUPERSEDED_STEER_NOTE_PREFIX);
    expect(m.indexOf(SUPERSEDED_STEER_NOTE_PREFIX)).toBeLessThan(m.indexOf('lone steer'));
    await waitFor(() => !isRunActive('chat:chat-ss3') && pendingRows.filter(r => r.chatId === 'chat-ss3').length === 0);
  });

  it('a marker-lookup failure delivers unannotated (advisory, never blocks delivery)', async () => {
    (mockPrisma.crossModelMessage.findMany as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    await enqueueChatMessage({ chatId: 'chat-ss4', userId: 'u1', content: 'steer under failure', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: SRC_A, depth: 0 } });
    transcriptRows.push({ id: 'o1', chatId: SRC_A, role: 'user', content: 'owner', createdAt: new Date(Date.now() + 60_000), metadata: { origin: 'user' } });
    await expect(drainChatQueue('chat-ss4', 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('steer under failure')));
    expect(lastRunWith('steer under failure')).not.toContain(SUPERSEDED_STEER_NOTE_PREFIX);
    await waitFor(() => !isRunActive('chat:chat-ss4') && pendingRows.filter(r => r.chatId === 'chat-ss4').length === 0);
  });
});

describe('full-queue COALESCE + queue head (autonomy loop #15, 2026-09-21)', () => {
  const fill = async (chatId: string, sender: string, n = MAX_QUEUE_DEPTH) => {
    for (let i = 0; i < n; i++) {
      await enqueueChatMessage({ chatId, userId: 'u1', content: `report ${i} from ${sender}`, source: 'agent', origin: { kind: 'agent', sourceChatId: sender, depth: 1 } });
    }
  };
  beforeEach(() => { mockRecordLoopMetricMQ.mockClear(); });

  it("a full queue MERGES an agent send into the same sender's NEWEST waiting row (no 409, count unchanged, marker + both parts)", async () => {
    await fill('c1', 'sup-A', MAX_QUEUE_DEPTH - 2);
    await enqueueChatMessage({ chatId: 'c1', userId: 'u1', content: 'from B', source: 'agent', origin: { kind: 'agent', sourceChatId: 'sup-B', depth: 1 } });
    await enqueueChatMessage({ chatId: 'c1', userId: 'u1', content: 'A latest', source: 'agent', origin: { kind: 'agent', sourceChatId: 'sup-A', depth: 1 } });
    expect(await countPending('c1')).toBe(MAX_QUEUE_DEPTH);
    const r = await enqueueChatMessage({ chatId: 'c1', userId: 'u1', content: 'A follow-up', source: 'agent', origin: { kind: 'agent', sourceChatId: 'sup-A', depth: 2 } });
    expect(r).toMatchObject({ coalesced: true });
    expect(r.position).toBeGreaterThanOrEqual(1);
    expect(await countPending('c1')).toBe(MAX_QUEUE_DEPTH);
    const target = pendingRows.find((x) => x.id === r.id)!;
    expect(target.content.startsWith('A latest')).toBe(true);
    expect(target.content).toContain(COALESCED_FOLLOW_UP_PREFIX + ' sup-A');
    expect(target.content.endsWith('A follow-up')).toBe(true);
    expect(pendingRows.find((x) => x.content === 'from B')!.content).toBe('from B'); // another sender's row untouched
  });

  it('no row from the same sender → the honest 409 as before; user/webhook/attachment sends never coalesce', async () => {
    await fill('c2', 'sup-A');
    await expect(enqueueChatMessage({ chatId: 'c2', userId: 'u1', content: 'C new', source: 'agent', origin: { kind: 'agent', sourceChatId: 'sup-C', depth: 1 } }))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(enqueueChatMessage({ chatId: 'c2', userId: 'u1', content: 'human', source: 'user' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(enqueueChatMessage({ chatId: 'c2', userId: 'u1', content: 'hook', source: 'webhook', origin: { kind: 'webhook' } })).rejects.toMatchObject({ statusCode: 409 });
    await expect(enqueueChatMessage({ chatId: 'c2', userId: 'u1', content: 'with file', source: 'agent', origin: { kind: 'agent', sourceChatId: 'sup-A', depth: 1 }, uploadIds: ['up1'] })).rejects.toMatchObject({ statusCode: 409 });
    expect(await countPending('c2')).toBe(MAX_QUEUE_DEPTH);
  });

  it('a merge that would exceed QUEUE_COALESCE_MAX_CHARS is refused (409) instead of building an unbounded row', async () => {
    await fill('c3', 'sup-A');
    await expect(enqueueChatMessage({ chatId: 'c3', userId: 'u1', content: 'x'.repeat(QUEUE_COALESCE_MAX_CHARS), source: 'agent', origin: { kind: 'agent', sourceChatId: 'sup-A', depth: 1 } }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('oldestPendingHead: oldest row of any class; reports user when any human row waits; null when empty', async () => {
    expect(await oldestPendingHead('c4')).toBeNull();
    await enqueueChatMessage({ chatId: 'c4', userId: 'u1', content: 'old agent', source: 'agent', origin: { kind: 'agent', sourceChatId: 'sup-A' } });
    await enqueueChatMessage({ chatId: 'c4', userId: 'u1', content: 'sched', source: 'schedule' });
    const h1 = await oldestPendingHead('c4');
    expect(h1).toMatchObject({ source: 'agent' });
    expect(h1!.createdAt).toEqual(pendingRows.find((r) => r.content === 'old agent')!.createdAt);
    await enqueueChatMessage({ chatId: 'c4', userId: 'u1', content: 'typed', source: 'user' });
    expect(await oldestPendingHead('c4')).toMatchObject({ source: 'user' });
  });
});

describe('wake rider (hardening loop iteration 7, 2026-09-24): queued agent rows ride a hook/schedule wake', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mq = require('./message-queue.service') as typeof import('./message-queue.service');
  it('peeks the FIFO agent rows with provenance + max depth, and consume deletes exactly those rows', async () => {
    await enqueueChatMessage({ chatId: 'chat-rider', userId: 'u1', content: '[AGENT-SENT MESSAGE — from chat "spark lane" (28de72e5)…]\nspark delta A', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: '28de72e5-0000-0000-0000-000000000000', depth: 1 } });
    await enqueueChatMessage({ chatId: 'chat-rider', userId: 'u1', content: 'bench delta B', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: '615723ba-0000-0000-0000-000000000000', depth: 3 } });
    const rider = await mq.peekWakeRider('chat-rider');
    expect(rider).not.toBeNull();
    expect(rider!.rows.map(r => r.content)).toEqual([expect.stringContaining('spark delta A'), 'bench delta B']);
    expect(rider!.maxDepth).toBe(3);
    expect(rider!.remaining).toBe(0);
    expect(rider!.text.startsWith('[QUEUED WHILE BUSY — 2 ')).toBe(true);
    expect(rider!.text).toContain('[queued agent message from chat 615723ba');
    expect(rider!.text.indexOf('spark delta A')).toBeLessThan(rider!.text.indexOf('bench delta B'));
    expect(await countPending('chat-rider')).toBe(2); // peek is read-only
    expect(await mq.consumeWakeRider(rider!)).toBe(2);
    expect(await countPending('chat-rider')).toBe(0);
  });

  it('a waiting USER row or an upload row at the head → no rider; a schedule row never rides', async () => {
    await enqueueChatMessage({ chatId: 'chat-rider-u', userId: 'u1', content: 'agent x', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: 'a' } });
    await enqueueChatMessage({ chatId: 'chat-rider-u', userId: 'u1', content: 'human typed', mode: 'single_thinking', source: 'user' });
    expect(await mq.peekWakeRider('chat-rider-u')).toBeNull();

    await enqueueChatMessage({ chatId: 'chat-rider-s', userId: 'u1', content: 'queued one-shot firing', mode: 'single_thinking', source: 'schedule', origin: { kind: 'schedule', scheduleId: 'sch1' } });
    expect(await mq.peekWakeRider('chat-rider-s')).toBeNull();

    await enqueueChatMessage({ chatId: 'chat-rider-k', userId: 'u1', content: 'agent y', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: 'b' } });
    expect((await mq.peekWakeRider('chat-rider-k'))?.rows).toHaveLength(1);
  });

  it('the char budget bounds the rider: rows that do not fit stay queued and the header counts them; an oversize head row rides nothing', async () => {
    const big = 'X'.repeat(600);
    for (let i = 0; i < 4; i++) {
      await enqueueChatMessage({ chatId: 'chat-rider-b', userId: 'u1', content: `${i}:${big}`, mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: `src${i}` } });
    }
    const rider = await mq.peekWakeRider('chat-rider-b', { maxChars: 1400 });
    expect(rider!.rows).toHaveLength(2);
    expect(rider!.remaining).toBe(2);
    expect(rider!.text).toContain('2 more remain queued and drain after this turn.');
    await enqueueChatMessage({ chatId: 'chat-rider-x', userId: 'u1', content: 'Y'.repeat(900), mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: 'src' } });
    expect(await mq.peekWakeRider('chat-rider-x', { maxChars: 500 })).toBeNull();
  });
});

// ── REPORT-UP ACK-ONLY DRAIN (OPT-IN — tt-rd audit 2026-09-27, finding 2) ──────
// Status-only report-ups from project supervisors used to drain on the Fleet
// Supervisor as full reasoning turns (946 agent-origin turns / 14 d). Under
// REPORT_UP_ACK_ONLY_DRAIN=1 the harness acks such a batch instead.
describe('report-up ack-only drain (REPORT_UP_ACK_ONLY_DRAIN=1)', () => {
  const FS = 'fs-chat-0001';
  const PS_A = 'ps-a-00000000-0000-0000-0000-000000000000';
  const PS_B = 'ps-b-00000000-0000-0000-0000-000000000000';
  const chatRows: Record<string, any> = {
    [FS]: { id: FS, title: 'Fleet Supervisor', isSupervisor: true, isProjectSupervisor: false, userId: 'u1' },
    [PS_A]: { id: PS_A, title: 'tt-rd Supervisor', isSupervisor: false, isProjectSupervisor: true, userId: 'u1' },
    [PS_B]: { id: PS_B, title: 'spark Supervisor', isSupervisor: false, isProjectSupervisor: true, userId: 'u1' },
  };
  const persisted = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data);
  const ackMetrics = () => (mockRecordLoopMetricMQ.mock.calls as any[][]).map((c) => c[0]).filter((r) => r?.kind === 'report_up_ack_only');

  beforeEach(() => {
    process.env.REPORT_UP_ACK_ONLY_DRAIN = '1';
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) => chatRows[where?.id] ?? { title: 'A proper existing title' });
    mockPrisma.crossModelChat.findMany = jest.fn(async ({ where }: any) => Object.values(chatRows).filter((r: any) => (where?.id?.in ?? []).includes(r.id) && (where?.userId == null || r.userId === where.userId)));
    mockPrisma.crossModelMessage.create.mockClear();
    mockRecordLoopMetricMQ.mockClear();
    mockRunCodingAgent.mockClear();
  });
  afterEach(() => {
    delete process.env.REPORT_UP_ACK_ONLY_DRAIN;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
    delete mockPrisma.crossModelChat.findMany;
  });

  it('a batch of status-only report-ups from project supervisors into the Fleet Supervisor is ACKED: no run, rows deleted, one agent row + one ack row persisted, telemetry', async () => {
    await enqueueChatMessage({ chatId: FS, userId: 'u1', content: 'Status: 2 goals active, lanes unchanged since last sweep.', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: PS_A, depth: 1 } });
    await enqueueChatMessage({ chatId: FS, userId: 'u1', content: 'Lane roster unchanged; premise register at 5.08 of record.', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: PS_B, depth: 1 } });
    await expect(drainChatQueue(FS, 'u1')).resolves.toBe(false); // nothing further queued → the chained drain reports no run
    await new Promise((r) => setTimeout(r, 30));
    expect(mockRunCodingAgent).not.toHaveBeenCalled();
    expect(await countPending(FS)).toBe(0);
    const rows = persisted();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ chatId: FS, role: 'user', metadata: { origin: 'agent', ackOnly: true, batch: 2 } });
    expect(rows[0].content).toContain('2 status-only report-up(s) from project supervisor(s) ps-a-000, ps-b-000');
    expect(rows[0].content).toContain('Lane roster unchanged');
    expect(rows[1]).toMatchObject({ chatId: FS, role: 'assistant', content: '[REPORT-UP ACKED — no ask, no state change; not answered]', metadata: { origin: 'report-up-ack', kind: 'report_up_ack', batch: 2 } });
    expect(ackMetrics()).toEqual([expect.objectContaining({ kind: 'report_up_ack_only', sessionId: FS, value: 2 })]);
    expect(mockStampHookDepth).not.toHaveBeenCalledWith(FS, expect.anything());
  });

  it('a batch with an ASK or a STATE CHANGE, a non-supervisor source, a non-fleet target, or a waiting user row drains as a normal turn', async () => {
    // ask
    await enqueueChatMessage({ chatId: FS, userId: 'u1', content: 'Status unchanged. Should we pause the bounty poll?', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: PS_A, depth: 1 } });
    await expect(drainChatQueue(FS, 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some((c) => String(c[0]?.userMessage).includes('pause the bounty poll')));
    await waitFor(() => !isRunActive(`chat:${FS}`));
    expect(ackMetrics()).toHaveLength(0);
    // non-supervisor source
    mockRunCodingAgent.mockClear();
    await enqueueChatMessage({ chatId: FS, userId: 'u1', content: 'lane roster unchanged', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: 'lane-plain-0000', depth: 1 } });
    await expect(drainChatQueue(FS, 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some((c) => String(c[0]?.userMessage).includes('lane roster unchanged')));
    await waitFor(() => !isRunActive(`chat:${FS}`));
    // non-fleet target (a project supervisor receiving from another project supervisor)
    mockRunCodingAgent.mockClear();
    await enqueueChatMessage({ chatId: PS_A, userId: 'u1', content: 'roster unchanged', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: PS_B, depth: 1 } });
    await expect(drainChatQueue(PS_A, 'u1')).resolves.toBe(true);
    await waitFor(() => !isRunActive(`chat:${PS_A}`));
    expect(ackMetrics()).toHaveLength(0);
    // user row waiting behind the agent row → the user row drains first anyway (peekOldest), never an ack
    mockRunCodingAgent.mockClear();
    await enqueueChatMessage({ chatId: FS, userId: 'u1', content: 'roster unchanged again', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: PS_A, depth: 1 } });
    await enqueueChatMessage({ chatId: FS, userId: 'u1', content: 'owner typed this', mode: 'single_thinking', source: 'user' });
    await expect(drainChatQueue(FS, 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some((c) => String(c[0]?.userMessage).includes('owner typed this')));
    await waitFor(() => !isRunActive(`chat:${FS}`));
    // …and once the owner's run finishes, its finalize drains the leftover status-only row: acked, no second turn.
    await waitFor(() => ackMetrics().length === 1);
    expect(mockRunCodingAgent.mock.calls.some((c) => String(c[0]?.userMessage).includes('roster unchanged again'))).toBe(false);
  });

  it('OFF by default: without REPORT_UP_ACK_ONLY_DRAIN the same batch drains as a coalesced turn', async () => {
    delete process.env.REPORT_UP_ACK_ONLY_DRAIN;
    await enqueueChatMessage({ chatId: FS, userId: 'u1', content: 'Status: unchanged A', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: PS_A, depth: 1 } });
    await enqueueChatMessage({ chatId: FS, userId: 'u1', content: 'Status: unchanged B', mode: 'single_thinking', source: 'agent', origin: { kind: 'agent', sourceChatId: PS_B, depth: 1 } });
    await expect(drainChatQueue(FS, 'u1')).resolves.toBe(true);
    await waitFor(() => mockRunCodingAgent.mock.calls.some((c) => String(c[0]?.userMessage).includes('Status: unchanged B')));
    const m = String(mockRunCodingAgent.mock.calls.find((c) => String(c[0]?.userMessage).includes('Status: unchanged B'))![0].userMessage);
    // the coalesced preamble now tells the Fleet Supervisor not to narrate status-only reports
    expect(m).toContain('2 agent messages arrived while this chat was busy');
    expect(m).toContain('a status-only report from a project supervisor needs no answer — do not narrate it');
    await waitFor(() => !isRunActive(`chat:${FS}`));
    expect(ackMetrics()).toHaveLength(0);
  });
});

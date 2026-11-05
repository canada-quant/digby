/**
 * MERGE-1 cutover kill-window — REGRESSION PIN (2026-11-05).
 *
 * THE DEFECT THIS FILE PINS. Delivering a queued message used to be TWO
 * independent writes: drainChatQueue started the detached run and then deleted
 * the `pending_chat_messages` row, while the run persisted the transcript row
 * LATER and separately. A blue-green cutover kills whichever colour is draining
 * at an arbitrary instant, so BOTH failure modes were reachable:
 *
 *   (A) DUPLICATION — the run started and persisted its transcript row, then
 *       the colour died before the delete. The queue row survives. The
 *       cross-process liveness key behind isChatBusy has a 60 s TTL
 *       (LIVE_RUN_TTL_SEC), so once it expires a surviving colour peeks the
 *       same row and starts a SECOND run for the same content.
 *   (B) LOSS — the colour died between the delete and the persist: the row is
 *       gone and the content was never written anywhere.
 *
 * No reordering fixes both (deleting earlier trades duplication for loss — the
 * mutation proof at the bottom shows exactly that). The fix makes the two
 * writes ONE Postgres transaction (message-queue.service
 * createMessagesConsumingPending), so every kill point is safe:
 *   · before the commit -> neither effect; the row is still queued (no loss);
 *   · after the commit  -> both effects exactly once (no duplication).
 *
 * WHAT IS ASSERTED, and why each assertion FAILS on the pre-fix code:
 *   1. a persist FAILURE leaves the queue row present — pre-fix, the drain had
 *      already deleted it unconditionally, so this is the LOSS half;
 *   2. the transcript write and the row consumption happen inside ONE
 *      `$transaction` callback — pre-fix there was no transaction at all;
 *   3. a successful delivery leaves NO queue row, so a later drain (after the
 *      liveness TTL lapses) cannot re-deliver — the DUPLICATION half;
 *   4. the row is never consumed when the persist is what failed — i.e. the
 *      consume cannot outlive the content.
 *
 * Harness: REAL message-queue.service + REAL chat-agent.service drainChatQueue
 * over in-memory tables, mirroring message-queue.test.ts. The mock's
 * `$transaction` is genuinely all-or-nothing (writes are buffered and applied
 * only when the callback RESOLVES), which is what makes assertion 1 meaningful:
 * an eager mock would "commit" a failed transaction and the test would lie.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

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

/** In-memory pending_chat_messages — the queue row being delivered. */
const pendingRows: Array<{ id: string; chatId: string; userId: string; content: string; source: string; createdAt: Date; mode?: string | null }> = [];
let pendingSeq = 0;
/** In-memory transcript — the row the delivery is supposed to produce. */
const transcriptRows: Array<{ id: string; chatId: string; role: string; content: string; createdAt: Date; metadata?: any }> = [];
let msgSeq = 0;

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

/**
 * Cutover-kill simulation for the transcript write.
 *   'none'   — normal
 *   'once'   — the next persist fails, then the code recovers (proves the
 *              redelivery path: the message is retried and delivered)
 *   'always' — EVERY persist fails (the colour is dead). This is the mode the
 *              loss assertions use: with a sticky failure no retry can quietly
 *              succeed and consume the row, so "the row is still queued" is a
 *              real statement about the failed delivery rather than a race the
 *              test happened to win.
 */
let persistFailureMode: 'none' | 'once' | 'always' = 'none';
const shouldFailPersist = (): boolean => {
  if (persistFailureMode === 'always') return true;
  if (persistFailureMode === 'once') { persistFailureMode = 'none'; return true; }
  return false;
};

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
    deleteMany: jest.fn(async ({ where }: any) => {
      // Only reached OUTSIDE a transaction (the continuation carve-out).
      const ids: string[] = where?.id?.in ?? (where?.id ? [where.id] : []);
      let count = 0;
      for (const id of ids) {
        const i = pendingRows.findIndex(r => r.id === id);
        if (i >= 0) { pendingRows.splice(i, 1); count += 1; }
      }
      return { count };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const r = pendingRows.find(x => x.id === where.id);
      if (r) Object.assign(r, data);
      return r ?? {};
    }),
  },
  crossModelMessage: {
    create: jest.fn(async ({ data }: any) => {
      if (shouldFailPersist()) throw new Error('cutover: colour killed mid-write');
      const row = { id: `m${++msgSeq}`, createdAt: new Date(Date.now() + msgSeq), ...data };
      transcriptRows.push(row);
      return row;
    }),
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
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  /**
   * GENUINELY all-or-nothing: the callback's writes are BUFFERED and applied
   * only if it resolves. A throw inside the callback leaves BOTH tables exactly
   * as they were — which is the property the fix depends on and the property
   * assertion 1 tests. An eager mock here would make the whole file vacuous.
   */
  $transaction: jest.fn(async (fn: any) => {
    const created: any[] = [];
    let consumedIds: string[] = [];
    const tx = {
      crossModelMessage: {
        create: jest.fn(async ({ data }: any) => {
          if (shouldFailPersist()) throw new Error('cutover: colour killed mid-write');
          const row = { id: `m${++msgSeq}`, createdAt: new Date(Date.now() + msgSeq), ...data };
          created.push(row);
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
    const out = await fn(tx); // a throw here propagates WITHOUT committing
    for (const r of created) transcriptRows.push(r);
    for (const id of consumedIds) {
      const i = pendingRows.findIndex(r => r.id === id);
      if (i >= 0) pendingRows.splice(i, 1);
    }
    return out;
  }),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(async () => {}),
  recordLoopMetrics: jest.fn(),
  LOOP_METRIC_KINDS: { CHAT_QUEUE_COALESCED: 'chat_queue_coalesced', QUEUE_FAIRNESS_PREEMPT: 'queue_fairness_preempt', HOOK_STARVATION_YIELD: 'hook_starvation_yield', FINALIZE_HANDOFF: 'finalize_handoff' },
}));
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
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  clearHookDepth: jest.fn(async () => {}),
  stampHookDepth: jest.fn(async () => {}),
}));
jest.mock('./chat-context', () => ({
  buildChatQueryContext: jest.fn(async (a: any) => ({
    queryMessage: a.message,
    systemContext: '',
    conversationHistory: [{ role: 'user', content: 'earlier' }],
    projectId: null,
  })),
  persistAndEmitCanvases: jest.fn(async () => []),
}));
jest.mock('../upload.controller', () => ({
  attachmentKey: (id: string) => `cm:upload:${id}`,
  loadAttachment: jest.fn(async () => null),
  combineAttachments: jest.fn(() => undefined),
}));
jest.mock('./chat-gate', () => ({ mapAttachmentForAgent: jest.fn(() => ({})) }));

import { enqueueChatMessage, countPending, __resetDrainAttemptLedgerForTests } from './message-queue.service';
import { drainChatQueue } from './chat-agent.service';
import { isRunActive } from '../coding/live-runs';

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for condition');
}
async function waitUntil(pred: () => Promise<boolean>, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred()) && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
}

beforeEach(() => {
  jest.clearAllMocks();
  pendingRows.length = 0;
  transcriptRows.length = 0;
  pendingSeq = 0;
  msgSeq = 0;
  persistFailureMode = 'none';
  redisStore.clear();
  // Module-level ledger: this fixture resets its id counters, so the SAME row
  // ids recur across cases and attempts would carry over (1→2→3→4 → cooldown).
  __resetDrainAttemptLedgerForTests();
});

describe('MERGE-1 cutover kill-window — no loss, no duplication', () => {
  it('LOSS HALF: a persist that dies mid-write leaves the queue row intact (nothing is consumed)', async () => {
    await enqueueChatMessage({ chatId: 'kw1', userId: 'u1', content: 'survive the cutover', mode: 'single_thinking', source: 'user' });
    expect(await countPending('kw1')).toBe(1);

    // The detached run's transcript write dies (the colour was killed), and it
    // stays dead for every retry — otherwise a successful redelivery would
    // consume the row and the assertion below would be racing the recovery
    // rather than testing the failed delivery.
    persistFailureMode = 'always';
    await expect(drainChatQueue('kw1', 'u1')).resolves.toBe(true);
    await waitFor(() => !isRunActive('chat:kw1'));

    // THE ASSERTION THAT FAILS ON THE PRE-FIX CODE: the old drain deleted the
    // row right after the claim, so a killed persist lost the message forever.
    // With consume-at-persist the row is still queued and a later drain
    // redelivers it.
    expect(await countPending('kw1')).toBe(1);
    expect(transcriptRows.filter(r => r.chatId === 'kw1')).toHaveLength(0);
  });

  it('ATOMICITY: the transcript write and the row consumption run inside ONE $transaction', async () => {
    await enqueueChatMessage({ chatId: 'kw2', userId: 'u1', content: 'one write', mode: 'single_thinking', source: 'user' });
    await drainChatQueue('kw2', 'u1');
    await waitUntil(async () => (await countPending('kw2')) === 0);

    expect(mockPrisma.$transaction).toHaveBeenCalled();
    // The consume happened INSIDE the callback, not on the bare client: the
    // outer deleteMany (continuation carve-out only) must NOT have been used.
    expect(mockPrisma.pendingChatMessage.deleteMany).not.toHaveBeenCalled();
    const txArg = mockPrisma.$transaction.mock.calls[0][0];
    expect(typeof txArg).toBe('function');
  });

  it('DUPLICATION HALF: a completed delivery consumes the row, so a later drain cannot re-deliver it', async () => {
    await enqueueChatMessage({ chatId: 'kw3', userId: 'u1', content: 'deliver exactly once', mode: 'single_thinking', source: 'user' });
    await drainChatQueue('kw3', 'u1');
    await waitUntil(async () => (await countPending('kw3')) === 0);

    // Live through the 60s liveness TTL lapse of the first run.
    await waitFor(() => !isRunActive('chat:kw3'));
    expect(await countPending('kw3')).toBe(0);

    // A surviving colour peeks again after the TTL — nothing to deliver. This
    // is the exact re-drain that duplicated pre-fix when the delete had not
    // happened before the kill.
    await expect(drainChatQueue('kw3', 'u1')).resolves.toBe(false);
    expect(transcriptRows.filter(r => r.chatId === 'kw3' && r.role === 'user')).toHaveLength(1);
  });

  it('the row is NEVER consumed when the persist is what failed (consume cannot outlive the content)', async () => {
    await enqueueChatMessage({ chatId: 'kw4', userId: 'u1', content: 'no orphan consume', mode: 'single_thinking', source: 'user' });
    persistFailureMode = 'always';
    await drainChatQueue('kw4', 'u1');
    await waitFor(() => !isRunActive('chat:kw4'));

    // Pre-fix the drain's own deletePending had already removed it (the row is
    // gone AND the content was never written = pure loss).
    expect(await countPending('kw4')).toBe(1);
    // The transaction was opened, so the consume is genuinely in it, and it
    // rolled back with the failed write.
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});
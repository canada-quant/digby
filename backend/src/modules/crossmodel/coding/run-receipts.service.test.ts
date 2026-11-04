/**
 * Tests for the run-receipts persistence side: the fire-and-forget writer
 * (insert verbatim, swallow failures) and the runId reader (maps rows,
 * degrades to [] on error).
 *
 * Boundary-mocked: prisma (config/database) is a stub; the REAL service
 * executes. Never import config/env transitively here.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCreate: jest.Mock = jest.fn(async () => ({}));
const mockFindMany: jest.Mock = jest.fn(async () => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { runToolReceipt: { create: (...a: any[]) => mockCreate(...a), findMany: (...a: any[]) => mockFindMany(...a) } },
}));

import { recordRunReceiptAsync, getRunReceipts, getRecentChatReceipts, getRunReceiptsStrict, getRecentChatReceiptsStrict } from './run-receipts.service';
import type { ToolReceipt } from './run-receipts';
import logger from '../../../utils/logger';
import { runWithTelemetryRun, resolveReceiptRunId } from '../../../utils/run-telemetry-context';

/** Flush the writer's fire-and-forget async IIFE (microtask chain only — no timers). */
const flush = () => new Promise((r) => setImmediate(r));

const NOW = new Date('2026-08-24T12:00:00Z');

const receipt = (over: Partial<ToolReceipt> = {}): ToolReceipt => ({
  id: 'r-1',
  chatId: 'chat-1',
  runId: 'run-1',
  tool: 'open_pull_request',
  ok: true,
  ids: { prNumber: 300, url: 'https://github.com/x/y/pull/300' },
  inputHash: 'a'.repeat(64),
  outputHash: 'b'.repeat(64),
  createdAt: NOW,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({});
  mockFindMany.mockResolvedValue([]);
});

describe('recordRunReceiptAsync', () => {
  it('(a) success: inserts ONE row verbatim (in-process id, nulls for absent fields)', async () => {
    recordRunReceiptAsync(receipt({ runId: null, inputHash: null, outputHash: null }));
    await flush();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toEqual({
      data: {
        id: 'r-1',
        chatId: 'chat-1',
        runId: null,
        tool: 'open_pull_request',
        ok: true,
        ids: { prNumber: 300, url: 'https://github.com/x/y/pull/300' },
        inputHash: null,
        outputHash: null,
        createdAt: NOW,
      },
    });
  });

  it('(b) a persistent insert failure is swallowed + ONE warn after the retry budget — the writer NEVER throws (updated 1e356736: the warn fires after the LAST attempt, not the first)', async () => {
    mockCreate.mockRejectedValue(new Error('db down'));
    expect(() => recordRunReceiptAsync(receipt())).not.toThrow();
    // wait past the full retry budget (2 retries × 250 ms backoff) so no
    // in-flight attempt leaks into the NEXT test's mock
    await new Promise((r) => setTimeout(r, 900));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  // ── todo 1e356736 item 2 (2026-10-16): the drain-loss class ─────────────────
  // Specimens (the 08:09–08:32Z #1568 deploy window): two update_supervisor_state
  // saves whose supervisor_states rows ARE durable but whose receipt rows never
  // landed. Root cause 1: a TRANSIENT insert failure dropped the row permanently
  // — one warn, no retry. Root cause 2: the web process's shutdown raced the
  // fire-and-forget INSERT to $disconnect. The writer now (1) retries a bounded
  // number of times and (2) registers in the background-tasks registry so a
  // draining process can await it before disconnecting.
  it('(c) todo 1e356736: a TRANSIENT insert failure is retried — the row lands on the second attempt', async () => {
    let calls = 0;
    mockCreate.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('connection terminated unexpectedly');
      return {};
    });
    recordRunReceiptAsync(receipt({ tool: 'update_supervisor_state', ids: { supervisor_state: 'supervisor_state', applied: 3 } }));
    // the retry backoff is 250 ms — wait past it
    await new Promise((r) => setTimeout(r, 600));
    expect(calls).toBe(2);
    expect(mockCreate.mock.calls[1][0]).toEqual({
      data: {
        id: 'r-1',
        chatId: 'chat-1',
        runId: 'run-1',
        tool: 'update_supervisor_state',
        ok: true,
        ids: { supervisor_state: 'supervisor_state', applied: 3 },
        inputHash: 'a'.repeat(64),
        outputHash: 'b'.repeat(64),
        createdAt: NOW,
      },
    });
    expect(logger.warn).not.toHaveBeenCalled(); // the transient attempt recovered — no warn
  });

  it('(d) todo 1e356736: a PERSISTENT insert failure exhausts the budget, warns ONCE with the attempt count, and still never throws', async () => {
    mockCreate.mockRejectedValue(new Error('db down'));
    expect(() => recordRunReceiptAsync(receipt({ tool: 'update_supervisor_state' }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 900));
    // 1 first attempt + RECEIPT_WRITE_RETRIES = 3 total
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/failed after 3 attempt\(s\)/));
  });

  it('(f) todo 1e356736: every pending write is REGISTERED in the background-tasks registry — a draining process can await it before $disconnect', async () => {
    // in-flight insert: resolves only when the test says so
    let release: (() => void) | null = null;
    const gate = new Promise<void>((res) => { release = res; });
    mockCreate.mockImplementation(async () => { await gate; return {}; });
    recordRunReceiptAsync(receipt({ tool: 'update_supervisor_state' }));
    const { pendingBackgroundCount } = jest.requireActual('../../../utils/background-tasks');
    expect(pendingBackgroundCount()).toBeGreaterThanOrEqual(1);
    release!();
    await new Promise((r) => setTimeout(r, 50));
    expect(pendingBackgroundCount()).toBe(0); // settled + deregistered
  });
});

describe('getRunReceipts', () => {
  it('maps rows oldest-first into ToolReceipt shape', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'r-1', chatId: 'chat-1', runId: 'run-1', tool: 'git_commit', ok: true, ids: { sha: '84fe3ae0' }, inputHash: 'x', outputHash: 'y', createdAt: NOW },
      { id: 'r-2', chatId: 'chat-1', runId: 'run-1', tool: 'run_command', ok: false, ids: {}, inputHash: null, outputHash: null, createdAt: NOW },
    ]);
    const out = await getRunReceipts('run-1');
    expect(mockFindMany).toHaveBeenCalledWith({ where: { runId: 'run-1' }, orderBy: { createdAt: 'asc' } });
    expect(out).toEqual([
      { id: 'r-1', chatId: 'chat-1', runId: 'run-1', tool: 'git_commit', ok: true, ids: { sha: '84fe3ae0' }, inputHash: 'x', outputHash: 'y', createdAt: NOW },
      { id: 'r-2', chatId: 'chat-1', runId: 'run-1', tool: 'run_command', ok: false, ids: {}, inputHash: null, outputHash: null, createdAt: NOW },
    ]);
  });

  it('a non-object ids column degrades to {} rather than poisoning the row', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'r-1', chatId: 'chat-1', runId: 'run-1', tool: 'run_command', ok: true, ids: null, inputHash: null, outputHash: null, createdAt: NOW },
    ]);
    const [r] = await getRunReceipts('run-1');
    expect(r.ids).toEqual({});
  });

  it('degrades to [] on any read error', async () => {
    mockFindMany.mockRejectedValue(new Error('db down'));
    await expect(getRunReceipts('run-1')).resolves.toEqual([]);
  });
});

describe('getRecentChatReceipts (cross-wake exoneration reads)', () => {
  it('reads ok-only receipts for the chat inside the recency window, NEWEST-first at the DB (cap keeps fresh rows — spark B28), returned oldest-first', async () => {
    const before = Date.now();
    mockFindMany.mockResolvedValue([
      // DB returns newest-first under the desc order…
      { id: 'r-new', chatId: 'chat-1', runId: 'run-new', tool: 'git_push', ok: true, ids: { branch: 'b' }, inputHash: null, outputHash: null, createdAt: new Date(NOW.getTime() + 60_000) },
      { id: 'r-old', chatId: 'chat-1', runId: 'run-old', tool: 'file_feedback', ok: true, ids: { ticketId: 't-1' }, inputHash: null, outputHash: null, createdAt: NOW },
    ]);
    const out = await getRecentChatReceipts('chat-1');
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    const arg = mockFindMany.mock.calls[0][0];
    expect(arg.where.chatId).toBe('chat-1');
    expect(arg.where.ok).toBe(true); // a failed/staged execution exonerates nothing
    // spark B28: the cap must keep the NEWEST rows — asc + take dropped the
    // freshest executions from a busy window, so the verifier convicted
    // truthful restatements of them.
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.take).toBe(500);
    // 24h default window.
    const gteMs = arg.where.createdAt.gte.getTime();
    expect(gteMs).toBeGreaterThan(before - 24 * 60 * 60 * 1000 - 1000);
    expect(gteMs).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1000 + 1000);
    // …and the service reverses back to the documented oldest-first contract.
    expect(out.map((r) => r.id)).toEqual(['r-old', 'r-new']);
  });

  it('honors a custom window and degrades to [] on any read error', async () => {
    await getRecentChatReceipts('chat-1', 60_000);
    const gteMs = mockFindMany.mock.calls[0][0].where.createdAt.gte.getTime();
    expect(Math.abs(Date.now() - 60_000 - gteMs)).toBeLessThan(1000);

    mockFindMany.mockRejectedValue(new Error('db down'));
    await expect(getRecentChatReceipts('chat-1')).resolves.toEqual([]);
  });

  it('a tools filter rides into the WHERE clause so the 500-row cap bounds only matching rows (tt-rd fixer 2026-09-27); no / empty filter ⇒ no tool clause', async () => {
    await getRecentChatReceipts('chat-1', 7 * 24 * 3600_000, { tools: ['open_pull_request'] });
    const arg = mockFindMany.mock.calls[0][0];
    expect(arg.where.tool).toEqual({ in: ['open_pull_request'] });
    expect(arg.where.ok).toBe(true);
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.take).toBe(500);

    mockFindMany.mockClear();
    await getRecentChatReceipts('chat-1', 60_000, { tools: ['open_pull_request', 'merge_pull_request', ''] });
    expect(mockFindMany.mock.calls[0][0].where.tool).toEqual({ in: ['open_pull_request', 'merge_pull_request'] });

    mockFindMany.mockClear();
    await getRecentChatReceipts('chat-1', 60_000, { tools: [] });
    expect(mockFindMany.mock.calls[0][0].where.tool).toBeUndefined();

    mockFindMany.mockClear();
    await getRecentChatReceipts('chat-1');
    expect(mockFindMany.mock.calls[0][0].where.tool).toBeUndefined();
  });

  // ── fb64368a review round 2 (NEW MAJOR): the STRICT twins reject where the
  // swallowing twins resolve [] — the executor's zero-receipt gate depends on
  // the distinction ("the run executed nothing" vs "the read failed").
  it('STRICT variants REJECT on a read error while the swallowing twins resolve [] (same query semantics)', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: 'r-1', chatId: 'chat-1', runId: 'run-1', tool: 'run_command', ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: NOW }]);
    await expect(getRunReceiptsStrict('run-1')).resolves.toHaveLength(1);
    mockFindMany.mockRejectedValue(new Error('db down'));
    await expect(getRunReceipts('run-1')).resolves.toEqual([]); // swallowing twin unchanged
    await expect(getRunReceiptsStrict('run-1')).rejects.toThrow('db down');
    await expect(getRecentChatReceipts('chat-1')).resolves.toEqual([]); // swallowing twin unchanged
    await expect(getRecentChatReceiptsStrict('chat-1')).rejects.toThrow('db down');
    // Query semantics identical to the swallowing twin (order, cap, ok filter).
    mockFindMany.mockResolvedValueOnce([]);
    await getRecentChatReceiptsStrict('chat-1');
    const arg = mockFindMany.mock.calls.at(-1)![0];
    expect(arg.where.ok).toBe(true);
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.take).toBe(500);
  });
});

describe('resolveReceiptRunId (ticket e225aad8 — the runId a receipt persists under)', () => {
  it('a durable coding run\'s runId ALWAYS wins, even inside an ambient chat-turn context', () => {
    const id = runWithTelemetryRun({ runId: 'chat-turn-1', sessionId: 'chat-1' }, () =>
      resolveReceiptRunId('agent-run-9', 'chat-1'));
    expect(id).toBe('agent-run-9');
  });
  it('a chat turn with no durable runId takes the turn\'s ambient telemetry id (chat-<uuid>) for its OWN session', () => {
    const id = runWithTelemetryRun({ runId: 'chat-turn-1', sessionId: 'chat-1' }, () =>
      resolveReceiptRunId(undefined, 'chat-1'));
    expect(id).toBe('chat-turn-1');
    // explicit null (the pre-fix call shape input.runId ?? null) behaves like undefined
    expect(runWithTelemetryRun({ runId: 'chat-turn-1', sessionId: 'chat-1' }, () =>
      resolveReceiptRunId(null, 'chat-1'))).toBe('chat-turn-1');
  });
  it('the ambient id is only taken for the turn\'s OWN session — another chat\'s id resolves null (never cross-chat attribution)', () => {
    const id = runWithTelemetryRun({ runId: 'chat-turn-1', sessionId: 'chat-1' }, () =>
      resolveReceiptRunId(undefined, 'chat-2'));
    expect(id).toBeNull();
  });
  it('outside any ambient turn (or with the kill switch) the pre-fix null shape returns', () => {
    expect(resolveReceiptRunId(undefined, 'chat-1')).toBeNull();
    process.env.CHAT_RUN_TELEMETRY_ID_DISABLED = '1';
    try {
      expect(runWithTelemetryRun({ runId: 'chat-turn-1', sessionId: 'chat-1' }, () =>
        resolveReceiptRunId(undefined, 'chat-1'))).toBeNull();
    } finally {
      delete process.env.CHAT_RUN_TELEMETRY_ID_DISABLED;
    }
  });
  it('end-to-end write shape: a receipt minted for a chat turn persists under the turn\'s telemetry id', async () => {
    await runWithTelemetryRun({ runId: 'chat-turn-1', sessionId: 'chat-1' }, async () => {
      recordRunReceiptAsync(receipt({ runId: resolveReceiptRunId(undefined, 'chat-1'), tool: 'get_chat_status', ids: { chatId: 'lane-9' } }));
    });
    await flush();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.runId).toBe('chat-turn-1');
  });
});

/**
 * Inline task card — the SHARED contract (cohesive chat, 2026-09-28).
 *
 * Pins what every branch relies on, independent of which implementation of
 * task-events.ts is merged (branch D's stub or branch B's module):
 *   · parseTaskEvent accepts the contract and drops malformed payloads;
 *   · emitTaskEvent pushes ONE `task` frame on the chat's live run (a
 *     subscriber sees it; no run ⇒ false, never a throw);
 *   · persistTaskCard upserts ONE `task` part per taskId on the assistant row
 *     (replaced in place on update, appended once, a legacy row seeded with
 *     its content as a text part, the compact copy mirrored on metadata.task)
 *     and NEVER invents a row: the anchor is `messageId` or a row that already
 *     carries the task (review fixer 2026-09-28 — "the newest assistant row"
 *     is the wrong row once the user has sent another message).
 *
 * Named `.contract.test.ts` because branch B ships its own task-events.test.ts
 * (its module's internals); both suites run against the merged module.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma = {
  crossModelMessage: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { emitTaskEvent, parseTaskEvent, persistTaskCard, TASK_EVENT_TYPE, type TaskEventPayload } from './task-events';
import { endLiveRun, startLiveRun, subscribeRun } from '../coding/live-runs';
import { isTaskPart } from '../coding/transcript-parts';

const CHAT = '11111111-1111-4111-8111-111111111111';

function payload(over: Partial<TaskEventPayload> = {}): TaskEventPayload {
  return {
    taskId: 'task-1',
    chatId: CHAT,
    kind: 'session',
    status: 'running',
    title: 'Build the investor deck',
    steps: { done: 2, total: 5 },
    receipts: { ok: 3, total: 4 },
    spendUsd: 0.12,
    startedAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:05:00.000Z',
    artifacts: [],
    ...over,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('parseTaskEvent — the shared contract', () => {
  it('accepts a full payload and keeps every contract field', () => {
    const p = parseTaskEvent(payload({
      childChatId: 'child-1', etaText: '~3 min', resultMessageId: 'msg-9', note: 'n',
      status: 'done',
      artifacts: [{ name: 'deck.pdf', bytes: 1024, url: '/api/x/deck.pdf', kind: 'file' }, { name: 'PR #12', url: 'https://github.com/x/y/pull/12', kind: 'pr' }],
    }));
    expect(p).toMatchObject({
      taskId: 'task-1', chatId: CHAT, childChatId: 'child-1', kind: 'session', status: 'done',
      title: 'Build the investor deck', steps: { done: 2, total: 5 }, receipts: { ok: 3, total: 4 }, spendUsd: 0.12,
      etaText: '~3 min', resultMessageId: 'msg-9', note: 'n',
    });
    expect(p!.artifacts).toEqual([
      { name: 'deck.pdf', bytes: 1024, url: '/api/x/deck.pdf', kind: 'file' },
      { name: 'PR #12', url: 'https://github.com/x/y/pull/12', kind: 'pr' },
    ]);
  });

  it('drops malformed payloads instead of throwing', () => {
    expect(parseTaskEvent(null)).toBeNull();
    expect(parseTaskEvent('x')).toBeNull();
    expect(parseTaskEvent(payload({ taskId: '' }))).toBeNull();
    expect(parseTaskEvent(payload({ kind: 'weird' as any }))).toBeNull();
    expect(parseTaskEvent(payload({ status: 'paused' as any }))).toBeNull();
  });

  it('clamps counters, defaults the clocks, and drops nameless / unknown-kind artifacts', () => {
    const p = parseTaskEvent({
      taskId: 't', chatId: CHAT, kind: 'continuation', status: 'running',
      steps: { done: -3, total: 2.7 }, receipts: null, spendUsd: -1,
      artifacts: [{ name: '', kind: 'file' }, { name: 'a.txt', kind: 'zip' }, 'junk'],
    });
    expect(p).not.toBeNull();
    expect(p!.steps).toEqual({ done: 0, total: 2 });
    expect(p!.receipts).toEqual({ ok: 0, total: 0 });
    expect(p!.spendUsd).toBe(0);
    expect(p!.title).toBe('Task');
    expect(p!.artifacts).toEqual([{ name: 'a.txt', kind: 'file' }]);
    expect(Number.isNaN(Date.parse(p!.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(p!.updatedAt))).toBe(false);
  });
});

describe('emitTaskEvent — one `task` frame on the chat live run', () => {
  it('pushes the frame on the registered chat run so an attached viewer sees it', () => {
    const key = `chat:${CHAT}`;
    startLiveRun(key);
    const seen: Array<{ type: string; data: any }> = [];
    const unsub = subscribeRun(key, (e) => seen.push({ type: e.type, data: e.data }));
    try {
      expect(emitTaskEvent(CHAT, payload())).toBe(true);
      const frame = seen.find(e => e.type === TASK_EVENT_TYPE);
      expect(frame).toBeDefined();
      expect(frame!.data).toMatchObject({ taskId: 'task-1', chatId: CHAT, status: 'running', title: 'Build the investor deck' });
    } finally {
      unsub?.();
      endLiveRun(key);
    }
  });

  it('returns false (never throws) when no run is live for the chat or the payload is malformed', () => {
    expect(emitTaskEvent('no-such-chat', payload({ chatId: 'no-such-chat' }))).toBe(false);
    const key = `chat:${CHAT}`;
    startLiveRun(key);
    try { expect(emitTaskEvent(CHAT, payload({ kind: 'nope' as any }))).toBe(false); }
    finally { endLiveRun(key); }
  });
});

describe('persistTaskCard — ONE task part per taskId on the assistant row', () => {
  it('never invents a row: no messageId and no row carrying the task ⇒ null, nothing written', async () => {
    // The chat's newest row is a LATER turn's answer — the wrong anchor.
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { id: 'row-new', content: 'later answer', parts: [{ type: 'text', text: 'later answer' }], metadata: null },
      { id: 'row-old', content: 'older', parts: [{ type: 'text', text: 'older' }], metadata: null },
    ]);
    await expect(persistTaskCard(CHAT, payload())).resolves.toBeNull();
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
  });

  it('appends the card to the anchor row named by messageId and mirrors the compact copy on metadata.task', async () => {
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'row-anchor', content: 'answer', parts: [{ type: 'text', text: 'answer' }], metadata: { mode: 'thinking' } });
    mockPrisma.crossModelMessage.update.mockResolvedValue({});
    await expect(persistTaskCard(CHAT, payload({ childChatId: 'child-1' }), { messageId: 'row-anchor' })).resolves.toBe('row-anchor');
    const call = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'row-anchor' });
    expect(call.data.parts).toHaveLength(2);
    expect(isTaskPart(call.data.parts[1])).toBe(true);
    expect(call.data.parts[1].task).toMatchObject({ taskId: 'task-1', status: 'running' });
    expect(call.data.metadata).toMatchObject({ mode: 'thinking', task: { taskId: 'task-1', kind: 'session', status: 'running', childChatId: 'child-1' } });
  });

  it('finds the row by metadata.task.taskId too (the compact mirror) when no part carries it', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { id: 'row-newer', content: 'later', parts: [{ type: 'text', text: 'later' }], metadata: null },
      { id: 'row-meta', content: 'answer', parts: [{ type: 'text', text: 'answer' }], metadata: { task: { taskId: 'task-1', status: 'running' } } },
    ]);
    mockPrisma.crossModelMessage.update.mockResolvedValue({});
    await expect(persistTaskCard(CHAT, payload({ status: 'failed' }))).resolves.toBe('row-meta');
    const call = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(call.data.parts.map((p: any) => p.type)).toEqual(['text', 'task']);
    expect(call.data.metadata.task).toMatchObject({ taskId: 'task-1', status: 'failed' });
  });

  it('replaces the existing card in place on update — never a second card — and prefers the row that already carries it', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { id: 'row-newer', content: 'later answer', parts: [{ type: 'text', text: 'later answer' }], metadata: null },
      { id: 'row-task', content: 'answer', parts: [{ type: 'text', text: 'answer' }, { type: 'task', task: payload() }, { type: 'text', text: 'tail' }], metadata: null },
    ]);
    mockPrisma.crossModelMessage.update.mockResolvedValue({});
    await expect(persistTaskCard(CHAT, payload({ status: 'done', steps: { done: 5, total: 5 } }))).resolves.toBe('row-task');
    const call = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'row-task' });
    expect(call.data.parts.map((p: any) => p.type)).toEqual(['text', 'task', 'text']);
    expect(call.data.parts[1].task).toMatchObject({ status: 'done', steps: { done: 5, total: 5 } });
  });

  it('seeds a legacy row (no parts) with its content as the one text part before the card', async () => {
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'row-legacy', content: 'the answer text', parts: null, metadata: null });
    mockPrisma.crossModelMessage.update.mockResolvedValue({});
    await expect(persistTaskCard(CHAT, payload(), { messageId: 'row-legacy' })).resolves.toBe('row-legacy');
    const parts = mockPrisma.crossModelMessage.update.mock.calls[0][0].data.parts;
    expect(parts).toEqual([{ type: 'text', text: 'the answer text' }, { type: 'task', task: expect.objectContaining({ taskId: 'task-1' }) }]);
  });

  it("targets an explicit messageId when given — scoped to THIS chat's assistant rows — and falls back to the carrier scan when it does not resolve", async () => {
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'row-x', content: 'x', parts: [], metadata: null });
    mockPrisma.crossModelMessage.update.mockResolvedValue({});
    await expect(persistTaskCard(CHAT, payload(), { messageId: 'row-x' })).resolves.toBe('row-x');
    expect(mockPrisma.crossModelMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'row-x', chatId: CHAT, role: 'assistant' } }));
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
    // A foreign-chat / user-row messageId resolves to nothing: only a row already carrying the task is written.
    jest.clearAllMocks();
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([{ id: 'row-other', content: 'o', parts: [], metadata: null }]);
    await expect(persistTaskCard(CHAT, payload(), { messageId: 'row-foreign' })).resolves.toBeNull();
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
  });

  it('returns null on no row or DB failure — never throws', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    await expect(persistTaskCard(CHAT, payload())).resolves.toBeNull();
    mockPrisma.crossModelMessage.findMany.mockRejectedValue(new Error('db down'));
    await expect(persistTaskCard(CHAT, payload())).resolves.toBeNull();
  });
});

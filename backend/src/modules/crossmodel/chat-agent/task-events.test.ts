/**
 * task-events — the shared task-card contract (cohesive-chat wave 2026-09-28):
 * emitTaskEvent rides the chat's live run as a `task` SSE event (no-op without
 * one), persistTaskCard upserts the `{ type: 'task', task }` part on a chat row
 * and mirrors metadata.task. prisma is an in-memory map; live-runs is REAL.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const rows = new Map<string, any>();
const mockPrisma: any = {
  crossModelMessage: {
    // Merged module (cohesive/integration): the anchor lookup is findFirst
    // scoped { id, chatId, role:'assistant' }; the carrier scan is findMany.
    findFirst: jest.fn(async ({ where }: any) => {
      const r = rows.get(where.id);
      return r && r.chatId === where.chatId && r.role === where.role ? r : null;
    }),
    findMany: jest.fn(async ({ where }: any) => {
      const list = [...rows.values()].filter((r) => r.chatId === where.chatId && r.role === 'assistant');
      return list.sort((a, b) => b.createdAt - a.createdAt);
    }),
    update: jest.fn(async ({ where, data }: any) => { const r = rows.get(where.id); Object.assign(r, data); return r; }),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { buildTaskEvent, emitTaskEvent, persistTaskCard, TASK_EVENT_TYPE, TASK_PART_TYPE, spawnedSessionsInParts } from './task-events';
import { startLiveRun, endLiveRun, subscribeRun } from '../coding/live-runs';

const ev = (over: Partial<ReturnType<typeof buildTaskEvent>> = {}) => buildTaskEvent({ taskId: 'task-1', chatId: 'chat-1', kind: 'continuation', status: 'running', title: 'Finishing your task', ...over });

beforeEach(() => { rows.clear(); jest.clearAllMocks(); });

describe('buildTaskEvent', () => {
  it('fills the contract defaults and restamps updatedAt', () => {
    const e = ev({ startedAt: '2026-09-28T00:00:00.000Z' });
    expect(e).toMatchObject({ taskId: 'task-1', chatId: 'chat-1', kind: 'continuation', status: 'running', steps: { done: 0, total: 0 }, receipts: { ok: 0, total: 0 }, spendUsd: 0, artifacts: [], startedAt: '2026-09-28T00:00:00.000Z' });
    expect(typeof e.updatedAt).toBe('string');
  });
});

describe('emitTaskEvent', () => {
  it('is a no-op (false) without a live run; pushes a `task` event to the chat run when one is active', () => {
    expect(emitTaskEvent('chat-e1', ev({ chatId: 'chat-e1' }))).toBe(false);
    startLiveRun('chat:chat-e1');
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun('chat:chat-e1', (e) => events.push(e));
    try {
      expect(emitTaskEvent('chat-e1', ev({ chatId: 'chat-e1', status: 'done', resultMessageId: 'row-9' }))).toBe(true);
      expect(events.some((e) => e.type === TASK_EVENT_TYPE && e.data.status === 'done' && e.data.resultMessageId === 'row-9')).toBe(true);
    } finally { endLiveRun('chat:chat-e1'); }
  });
});

describe('persistTaskCard', () => {
  it('appends the task part + mirrors metadata.task on the named row; a second write with the same taskId REPLACES the part', async () => {
    rows.set('row-1', { id: 'row-1', chatId: 'chat-1', role: 'assistant', content: 'partial', parts: [{ type: 'text', text: 'partial' }], metadata: { mode: 'thinking' }, createdAt: 1 });
    expect(await persistTaskCard('chat-1', ev(), { messageId: 'row-1' })).toBe('row-1');
    let r = rows.get('row-1');
    expect(r.parts).toHaveLength(2);
    expect(r.parts[1]).toMatchObject({ type: TASK_PART_TYPE, task: { taskId: 'task-1', status: 'running' } });
    expect(r.metadata).toMatchObject({ mode: 'thinking', task: { taskId: 'task-1', status: 'running', kind: 'continuation' } });
    expect(await persistTaskCard('chat-1', ev({ status: 'done', resultMessageId: 'row-2' }), { messageId: 'row-1' })).toBe('row-1');
    r = rows.get('row-1');
    expect(r.parts).toHaveLength(2); // replaced, not appended
    expect(r.parts[1].task).toMatchObject({ status: 'done', resultMessageId: 'row-2' });
    expect(r.metadata.task).toMatchObject({ status: 'done', resultMessageId: 'row-2' });
  });

  it('a row with no parts gets a text part seeded from content so the transcript keeps the answer', async () => {
    rows.set('row-3', { id: 'row-3', chatId: 'chat-1', role: 'assistant', content: 'the answer', parts: null, metadata: null, createdAt: 1 });
    await persistTaskCard('chat-1', ev(), { messageId: 'row-3' });
    expect(rows.get('row-3').parts).toEqual([{ type: 'text', text: 'the answer' }, expect.objectContaining({ type: TASK_PART_TYPE })]);
  });

  it('finds the row by taskId when no messageId is given; a foreign-chat messageId is refused; nothing ⇒ null (never invents a row)', async () => {
    rows.set('row-4', { id: 'row-4', chatId: 'chat-1', role: 'assistant', content: 'x', parts: [], metadata: { task: { taskId: 'task-1' } }, createdAt: 5 });
    rows.set('row-5', { id: 'row-5', chatId: 'chat-2', role: 'assistant', content: 'y', parts: [], metadata: {}, createdAt: 6 });
    expect(await persistTaskCard('chat-1', ev({ status: 'failed' }))).toBe('row-4');
    expect(rows.get('row-4').metadata.task.status).toBe('failed');
    expect(await persistTaskCard('chat-1', ev({ taskId: 'task-other' }), { messageId: 'row-5' })).toBeNull();
    expect(await persistTaskCard('chat-9', ev({ taskId: 'task-none' }))).toBeNull();
    expect(mockPrisma.crossModelMessage.update).toHaveBeenCalledTimes(1);
  });

  it('never throws — a prisma failure answers null', async () => {
    mockPrisma.crossModelMessage.findFirst.mockRejectedValueOnce(new Error('db down'));
    expect(await persistTaskCard('chat-1', ev(), { messageId: 'row-1' })).toBeNull();
  });
});

// ── Hand-off polish (2026-09-28, audit CT-2): the spawn-turn helpers ──
import { spawnCardStillOwed, spawnEndTurnNotice } from './task-events';

describe('spawnCardStillOwed / spawnEndTurnNotice (hand-off polish)', () => {
  it('a posted hand-off record targeting THIS chat means the done card exists — no running card is owed; anything else still owes it', () => {
    expect(spawnCardStillOwed(null, 'chat-1')).toBe(true);
    expect(spawnCardStillOwed(undefined, 'chat-1')).toBe(true);
    expect(spawnCardStillOwed({ resultMessageId: 'msg-1', targetChatId: 'chat-1', postedAt: '2026-09-28T06:46:32Z' }, 'chat-1')).toBe(false);
    expect(spawnCardStillOwed({ resultMessageId: null, targetChatId: 'chat-1', postedAt: '2026-09-28T06:46:32Z' }, 'chat-1')).toBe(false); // posted, row id unknown
    expect(spawnCardStillOwed({ resultMessageId: 'msg-1', targetChatId: 'chat-OTHER', postedAt: '2026-09-28T06:46:32Z' }, 'chat-1')).toBe(true); // posted elsewhere
    expect(spawnCardStillOwed({ resultMessageId: null, targetChatId: 'chat-1', postedAt: null }, 'chat-1')).toBe(true); // nothing posted yet
  });

  it('the notice names the session, says the card + Result row report back, forbids polling / re-reading / narrating a click', () => {
    const n = spawnEndTurnNotice('  CQL   DGX B300 deck ');
    expect(n.startsWith('[HARNESS NOTICE — not typed by the user] The sub-session "CQL DGX B300 deck" is running now')).toBe(true);
    expect(n).toMatch(/task card in this chat tracks it/);
    expect(n).toMatch(/Do not poll, wait for, or re-read the session/);
    expect(n).toMatch(/do not narrate a click, a card to confirm, or a worktree/);
    expect(spawnEndTurnNotice(null)).toContain('"Coding session"');
    expect(spawnEndTurnNotice('x'.repeat(300))).toContain(`"${'x'.repeat(160)}"`);
  });
});

// audit 2026-10-06 T5-2 (ticket 2bae9728): a session created IDLE (no prompt, no
// charter) has no run — the finalize must not persist a "running" card for it.
describe('audit 2026-10-06 T5-2 — spawnedSessionsInParts skips an IDLE spawn', () => {
  const part = (ids: Record<string, string>) => ({ type: 'tool_result', name: 'start_coding_session', result: JSON.stringify({ ok: true, tool: 'start_coding_session', ids, message: 'Started coding session s1 "Deck" on branch b.' }) });
  it('firstPrompt none ⇒ no card; given / charter / absent ⇒ the card as before; a clipped idle envelope is skipped too', () => {
    expect(spawnedSessionsInParts([part({ sessionId: 's1', firstPrompt: 'none' })])).toEqual([]);
    expect(spawnedSessionsInParts([part({ sessionId: 's1', firstPrompt: 'charter' })])).toEqual([{ sessionId: 's1', title: 'Deck' }]);
    expect(spawnedSessionsInParts([part({ sessionId: 's1' })])).toEqual([{ sessionId: 's1', title: 'Deck' }]);
    const clipped = { type: 'tool_result', name: 'start_coding_session', result: '{"ok":true,"tool":"start_coding_session","ids":{"sessionId":"s2","firstPrompt":"none"},"message":"Started cod' };
    expect(spawnedSessionsInParts([clipped])).toEqual([]);
  });
});

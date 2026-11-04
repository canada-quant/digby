/**
 * Inline task card — the client contract (cohesive chat, 2026-09-28).
 * Pins the parser, the card state machine, the ONE-card-per-task rules
 * (transcript-part round trip, in-place row updates), the sub-session Result
 * source, the child-session status mapping, and the plain normalizer's `task`
 * → `complete` round trip (the appended bubble carries the card the persisted
 * row will show).
 */

import { describe, it, expect } from 'vitest';
import {
  applyTaskToMessages, findSessionResult, formatBytes, formatDurationShort, formatSpend, isTaskPart,
  mergeChildSessionIntoTask, messagesHaveTask, parseTaskEvent, pendingTasksOf, reduceTaskState, taskOfPart,
  tasksOfMessage, type TaskEventPayload,
} from './task-card';
import { upsertTaskPartParts } from './transcript-parts';
import { makeLegacyNormalizer, mapPlainMessages } from '@/app/crossmodel/plain-session';
import type { MessagePart } from './api/coding';

const CHAT = 'chat-1';

function payload(over: Partial<TaskEventPayload> = {}): TaskEventPayload {
  return {
    taskId: 'task-1', chatId: CHAT, kind: 'session', status: 'running', title: 'Build the deck',
    steps: { done: 1, total: 4 }, receipts: { ok: 2, total: 2 }, spendUsd: 0.05,
    startedAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:01:00.000Z', artifacts: [],
    ...over,
  };
}
const text = (t: string): MessagePart => ({ type: 'text', text: t });
const taskPart = (t: TaskEventPayload): MessagePart => ({ type: 'task', task: t });

describe('parseTaskEvent', () => {
  it('accepts the contract and drops malformed payloads', () => {
    expect(parseTaskEvent(payload({ artifacts: [{ name: 'deck.pdf', bytes: 2048, url: '/f/deck.pdf', kind: 'file' }] }))).toMatchObject({
      taskId: 'task-1', chatId: CHAT, kind: 'session', status: 'running', artifacts: [{ name: 'deck.pdf', bytes: 2048, url: '/f/deck.pdf', kind: 'file' }],
    });
    expect(parseTaskEvent(null)).toBeNull();
    expect(parseTaskEvent({ ...payload(), taskId: 1 })).toBeNull();
    expect(parseTaskEvent(payload({ status: 'paused' as any }))).toBeNull();
    expect(parseTaskEvent(payload({ kind: 'other' as any }))).toBeNull();
  });

  it('clamps counters and drops nameless artifacts', () => {
    const p = parseTaskEvent({ taskId: 't', chatId: CHAT, kind: 'continuation', status: 'done', steps: { done: -1, total: 3.9 }, spendUsd: 'x', artifacts: [{ name: '' }, { name: 'a', kind: 'pr' }] });
    expect(p).toMatchObject({ steps: { done: 0, total: 3 }, receipts: { ok: 0, total: 0 }, spendUsd: 0, title: 'Task', artifacts: [{ name: 'a', kind: 'pr' }] });
  });
});

describe('reduceTaskState — terminal never regresses to an older running frame', () => {
  it('replaces with a valid newer payload and keeps the previous on a malformed one', () => {
    const a = payload();
    expect(reduceTaskState(a, payload({ status: 'done' }))).toMatchObject({ status: 'done' });
    expect(reduceTaskState(a, { junk: true })).toBe(a);
  });

  it('ignores a replayed running frame that is not newer than the done state', () => {
    const done = payload({ status: 'done', updatedAt: '2026-09-28T10:05:00.000Z' });
    expect(reduceTaskState(done, payload({ status: 'running', updatedAt: '2026-09-28T10:04:00.000Z' }))).toBe(done);
    expect(reduceTaskState(done, payload({ status: 'running', updatedAt: '2026-09-28T10:06:00.000Z' }))).toMatchObject({ status: 'running' });
  });

  it('a different taskId is a different card', () => {
    const a = payload({ status: 'done' });
    expect(reduceTaskState(a, payload({ taskId: 'task-2' }))).toMatchObject({ taskId: 'task-2', status: 'running' });
  });
});

describe('upsertTaskPartParts — the transcript-part round trip (mirror of the backend helper)', () => {
  it('appends once, then replaces in place keeping the part identity fields', () => {
    const first = upsertTaskPartParts([text('answer')], payload(), (p) => ({ ...p, uid: 'p1' } as MessagePart));
    expect(first).toHaveLength(2);
    expect(isTaskPart(first[1])).toBe(true);
    expect((first[1] as any).uid).toBe('p1');
    const second = upsertTaskPartParts(first, payload({ status: 'done' }), (p) => ({ ...p, uid: 'p2' } as MessagePart));
    expect(second).toHaveLength(2);
    expect((second[1] as any).uid).toBe('p1'); // replaced in place — no remount
    expect(taskOfPart(second[1])).toMatchObject({ status: 'done' });
    expect(first[1]).toMatchObject({ task: { status: 'running' } }); // input untouched
  });

  it('a payload without a taskId returns the same array', () => {
    const parts = [text('x')];
    expect(upsertTaskPartParts(parts, payload({ taskId: '' }))).toBe(parts);
  });
});

describe('applyTaskToMessages / messagesHaveTask — ONE card per task across rows', () => {
  const rows = [
    { id: 'u', role: 'user', content: 'do it', parts: undefined as MessagePart[] | undefined },
    { id: 'a1', role: 'assistant', content: 'working', parts: [text('working'), taskPart(payload())] },
    { id: 'a2', role: 'assistant', content: 'later', parts: [text('later')] },
  ];

  it('updates the row that carries the task and leaves the others by identity', () => {
    expect(messagesHaveTask(rows, 'task-1')).toBe(true);
    expect(messagesHaveTask(rows, 'nope')).toBe(false);
    const out = applyTaskToMessages(rows, payload({ status: 'done', resultMessageId: 'a2' }));
    expect(out).not.toBe(rows);
    expect(out[0]).toBe(rows[0]);
    expect(out[2]).toBe(rows[2]);
    expect(tasksOfMessage(out[1].parts)).toHaveLength(1);
    expect(tasksOfMessage(out[1].parts)[0]).toMatchObject({ status: 'done', resultMessageId: 'a2' });
  });

  it('returns the same array when no row carries the task or the payload is malformed', () => {
    expect(applyTaskToMessages(rows, payload({ taskId: 'other' }))).toBe(rows);
    expect(applyTaskToMessages(rows, { nope: 1 })).toBe(rows);
  });

  it('pendingTasksOf lists running / waiting cards newest row first and skips settled ones', () => {
    const list = [
      { parts: [taskPart(payload({ taskId: 'old', status: 'waiting_user' }))] },
      { parts: [taskPart(payload({ taskId: 'done', status: 'done' }))] },
      { parts: [taskPart(payload({ taskId: 'new' }))] },
    ];
    expect(pendingTasksOf(list).map(t => t.taskId)).toEqual(['new', 'old']);
  });
});

describe('findSessionResult — the sub-session Result section source', () => {
  it('prefers the newest settled task part, falls back to metadata.task, and ignores running cards', () => {
    const settled = payload({ status: 'done', artifacts: [{ name: 'deck.pdf', kind: 'file', url: '/f/deck.pdf' }] });
    expect(findSessionResult([{ role: 'assistant', parts: [taskPart(settled)] }])).toMatchObject({ status: 'done' });
    expect(findSessionResult([{ role: 'assistant', parts: [taskPart(payload())] }])).toBeNull();
    expect(findSessionResult([{ role: 'assistant', parts: [text('x')], plainMeta: { task: payload({ status: 'failed' }) } }])).toMatchObject({ status: 'failed' });
    expect(findSessionResult([{ role: 'user', parts: [taskPart(settled)] }])).toBeNull();
  });
});

describe('mergeChildSessionIntoTask — the child status feed mapped onto the same card', () => {
  it('a child in error fails the card with its message; running / ready leave it; a settled card is never reopened', () => {
    const t = payload();
    expect(mergeChildSessionIntoTask(t, { status: 'error', errorMessage: 'container died' })).toMatchObject({ status: 'failed', note: 'container died' });
    expect(mergeChildSessionIntoTask(t, { status: 'running' })).toBe(t);
    expect(mergeChildSessionIntoTask(t, { status: 'ready' })).toBe(t);
    expect(mergeChildSessionIntoTask(t, null)).toBe(t);
    const done = payload({ status: 'done' });
    expect(mergeChildSessionIntoTask(done, { status: 'error' })).toBe(done);
  });
});

describe('plain normalizer — a `task` frame rides the parts into `complete`', () => {
  it('validates the frame, upserts ONE task part, and the appended bubble carries the latest state', () => {
    const normalize = makeLegacyNormalizer();
    expect(normalize('task', { junk: true })).toBeNull();
    const first = normalize('task', payload());
    expect(first).toEqual({ type: 'task', data: expect.objectContaining({ taskId: 'task-1', status: 'running' }) });
    normalize('chunk', { content: 'Working on the deck now.' });
    normalize('task', payload({ status: 'done', steps: { done: 4, total: 4 } }));
    const done = normalize('complete', {});
    expect(done?.type).toBe('complete');
    const tasks = tasksOfMessage(done!.data.parts);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'done', steps: { done: 4, total: 4 } });
    expect(done!.data.finalText).toBe('Working on the deck now.');
  });

  it('a frame for a task an EARLIER row carries is forwarded but NOT folded into the new turn — that row is updated instead', () => {
    // Persisted row A1 carries task-1 (running); the user is on turn 2 and the
    // chat's live run forwards task-1's frames (a background continuation).
    let rows = mapPlainMessages({ messages: [{ id: 'a1', role: 'assistant', content: 'x', parts: [text('x'), taskPart(payload())], createdAt: 'now' }] });
    const normalize = makeLegacyNormalizer({ hasTask: (id) => messagesHaveTask(rows, id) });
    const frame = normalize('task', payload({ status: 'done', steps: { done: 4, total: 4 } }));
    expect(frame).toEqual({ type: 'task', data: expect.objectContaining({ taskId: 'task-1', status: 'done' }) });
    rows = applyTaskToMessages(rows, frame!.data); // what the view does with the forwarded frame
    normalize('chunk', { content: 'Second answer.' });
    const done = normalize('complete', {});
    expect(tasksOfMessage(done!.data.parts)).toHaveLength(0); // no second card under the turn-2 bubble
    expect(tasksOfMessage(rows[0].parts)[0]).toMatchObject({ status: 'done', steps: { done: 4, total: 4 } }); // A1's card updated
    // A task no row carries still rides this turn's parts.
    const fresh = normalize('task', payload({ taskId: 'task-2' }));
    expect(fresh?.type).toBe('task');
    expect(tasksOfMessage(normalize('complete', {})!.data.parts).map(t => t.taskId)).toEqual(['task-2']);
  });

  it('a persisted task part survives the stored-row mapping untouched', () => {
    const full = { messages: [{ id: 'a1', role: 'assistant', content: 'x', parts: [text('x'), taskPart(payload({ status: 'done' }))], createdAt: 'now' }] };
    const rows = mapPlainMessages(full);
    expect(tasksOfMessage(rows[0].parts)[0]).toMatchObject({ taskId: 'task-1', status: 'done' });
  });
});

describe('copy helpers', () => {
  it('formats spend, durations and bytes', () => {
    expect(formatSpend(0)).toBe('');
    expect(formatSpend(0.004)).toBe('<$0.01');
    expect(formatSpend(0.12)).toBe('$0.12');
    expect(formatSpend(12.34)).toBe('$12.3');
    expect(formatDurationShort(12_000)).toBe('12s');
    expect(formatDurationShort(185_000)).toBe('3m 05s');
    expect(formatDurationShort(3_720_000)).toBe('1h 02m');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(348 * 1024)).toBe('348 KB');
    expect(formatBytes(1.2 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatBytes(undefined)).toBe('');
  });
});

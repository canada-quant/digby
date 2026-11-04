/**
 * TaskCard / TaskResultSection render pins (cohesive chat, 2026-09-28).
 * Same react-dom/server idiom as DepthPill.test.tsx (node-environment vitest,
 * no jsdom): the SSR markup is what these pins target; the state machine is
 * pinned in lib/task-card.test.ts. Also pins that AssistantParts renders a
 * `task` part as the card (and nothing else changes around it).
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { TaskCard, TaskCardActionsContext, TaskResultSection } from './TaskCard';
import { AssistantParts } from './code-transcript';
import { OPEN_RESULT_LABEL, OPEN_SESSION_LABEL, REPLY_BELOW_LABEL, type TaskEventPayload } from '@/lib/task-card';
import type { MessagePart } from '@/lib/api/coding';

function payload(over: Partial<TaskEventPayload> = {}): TaskEventPayload {
  return {
    taskId: 'task-1', chatId: 'chat-1', kind: 'session', status: 'running', title: 'Build the investor deck',
    steps: { done: 2, total: 5 }, receipts: { ok: 3, total: 4 }, spendUsd: 0.12,
    startedAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:03:00.000Z', artifacts: [],
    ...over,
  };
}
const card = (task: TaskEventPayload) => renderToStaticMarkup(createElement(TaskCard, { task }));
const withActions = (task: TaskEventPayload) => renderToStaticMarkup(
  createElement(TaskCardActionsContext.Provider, { value: { openChat: () => {}, openResult: () => {}, focusComposer: () => {} } }, createElement(TaskCard, { task })),
);

describe('TaskCard — one card, four states', () => {
  it('running: title, kind badge, Working pill, steps, receipts, spend, a live clock, the ETA', () => {
    const out = card(payload({ etaText: '~4 min left' }));
    expect(out).toContain('data-task-card="running"');
    expect(out).toContain('Build the investor deck');
    expect(out).toContain('data-task-kind="session"');
    expect(out).toContain('Sub-session');
    expect(out).toContain('data-task-status="running"');
    expect(out).toContain('Working');
    expect(out).toContain('Steps 2/5');
    expect(out).toContain('Receipts 3/4');
    expect(out).toContain('$0.12');
    expect(out).toContain('data-task-clock');
    expect(out).toContain('~4 min left');
    expect(out).not.toContain('data-task-artifacts');
  });

  it('done: Done pill, "took" duration, the artifacts with download / PR / canvas links, Open result', () => {
    const out = card(payload({
      status: 'done', resultMessageId: 'msg-9', kind: 'continuation',
      artifacts: [
        { name: 'deck.pdf', bytes: 2048, url: '/api/crossmodel/files/1/download', kind: 'file' },
        { name: 'PR #12', url: 'https://github.com/x/y/pull/12', kind: 'pr' },
        { name: 'Outline', kind: 'canvas' },
      ],
    }));
    expect(out).toContain('data-task-card="done"');
    expect(out).toContain('data-task-status="done"');
    expect(out).toContain('Continuing');
    expect(out).toContain('took 3m 00s');
    expect(out).toContain('data-task-artifacts');
    expect(out).toContain('href="/api/crossmodel/files/1/download"');
    expect(out).toContain('download="deck.pdf"');
    expect(out).toContain('2 KB');
    expect(out).toContain('href="https://github.com/x/y/pull/12"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('Outline');
    expect(out).toContain(OPEN_RESULT_LABEL);
    expect(out).toContain('data-task-action="open-result"');
    expect(out).not.toContain('data-task-eta');
  });

  it('failed: Failed pill and the harness note', () => {
    const out = card(payload({ status: 'failed', note: 'The workspace ran out of disk.', kind: 'schedule' }));
    expect(out).toContain('data-task-card="failed"');
    expect(out).toContain('Failed');
    expect(out).toContain('Scheduled');
    expect(out).toContain('The workspace ran out of disk.');
  });

  it('waiting_user: the question as the note and the Reply below action', () => {
    const out = card(payload({ status: 'waiting_user', note: 'Which quarter should the deck cover?' }));
    expect(out).toContain('data-task-card="waiting_user"');
    expect(out).toContain('Waiting for you');
    expect(out).toContain('Which quarter should the deck cover?');
    expect(out).toContain(REPLY_BELOW_LABEL);
    expect(out).toContain('data-task-action="reply"');
  });

  it('Open session renders only when the view provides an opener and the card names a child', () => {
    expect(card(payload({ childChatId: 'child-1' }))).not.toContain(OPEN_SESSION_LABEL);
    expect(withActions(payload({ childChatId: 'child-1' }))).toContain(OPEN_SESSION_LABEL);
    expect(withActions(payload())).not.toContain(OPEN_SESSION_LABEL);
  });

  it('zero counters and zero spend render no empty facts', () => {
    const out = card(payload({ steps: { done: 0, total: 0 }, receipts: { ok: 0, total: 0 }, spendUsd: 0 }));
    expect(out).not.toContain('data-task-steps');
    expect(out).not.toContain('data-task-receipts');
    expect(out).not.toContain('data-task-spend');
  });
});

describe('AssistantParts renders a `task` part as the card', () => {
  it('in arrival order beside the prose; a malformed task part renders nothing', () => {
    const parts: MessagePart[] = [
      { type: 'text', text: 'On it — building the deck now.' },
      { type: 'task', task: payload() },
      { type: 'task', task: { taskId: 'broken' } as any },
    ];
    const out = renderToStaticMarkup(createElement(AssistantParts, { parts }));
    expect(out).toContain('On it — building the deck now.');
    expect(out).toContain('data-task-card="running"');
    expect(out.match(/data-task-card=/g)).toHaveLength(1);
  });
});

describe('TaskResultSection — the sub-session Result block', () => {
  it('leads with Result, the title, the deliverable count and the artifact links', () => {
    const out = renderToStaticMarkup(createElement(TaskResultSection, {
      task: payload({ status: 'done', artifacts: [{ name: 'deck.pdf', url: '/f/deck.pdf', kind: 'file' }, { name: 'PR #3', url: 'https://github.com/x/y/pull/3', kind: 'pr' }] }),
    }));
    expect(out).toContain('data-task-result="done"');
    expect(out).toContain('Result');
    expect(out).toContain('Build the investor deck');
    expect(out).toContain('2 deliverables');
    expect(out).toContain('href="/f/deck.pdf"');
    expect(out).toContain('href="https://github.com/x/y/pull/3"');
  });

  it('a failed run says so and a run with nothing handed back says so', () => {
    expect(renderToStaticMarkup(createElement(TaskResultSection, { task: payload({ status: 'failed' }) }))).toContain('The run did not finish');
    expect(renderToStaticMarkup(createElement(TaskResultSection, { task: payload({ status: 'done' }) }))).toContain('No files handed back');
  });
});

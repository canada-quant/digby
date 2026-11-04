/**
 * Minimal view render pins (2026-10-16, lib/view-mode.ts): what a user — or an admin with Debug mode off — sees.
 * SSR markup, node-environment vitest (the DepthPill / TaskCard idiom). The suites default to the full view
 * (vitest.config env); these pin the minimal one through __setViewModeForTests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { AssistantParts, CodeTranscriptMarkdown } from './code-transcript';
import { TaskCard } from './TaskCard';
import { MinimalNoteLine } from './MinimalNoteLine';
import { __setViewModeForTests, groupMinimalNotes, isMinimalHidden, minimalNoteLabel, minimalNotesText } from '@/lib/view-mode';
import type { MessagePart } from '@/lib/api/coding';

describe('minimal view', () => {
  beforeEach(() => __setViewModeForTests({ viewMode: 'minimal' }));
  afterEach(() => __setViewModeForTests(null));

  it('renders tool work as one-line activity rows — no arguments, no output, no guard notes', () => {
    const parts: MessagePart[] = [
      { type: 'text', text: 'On it.' },
      { type: 'tool_call', name: 'run_command', args: { command: 'npm test' } },
      { type: 'tool_result', name: 'run_command', result: 'PASS secret-output' },
      { type: 'tool_call', name: 'run_command', args: { command: 'npm run lint' } },
      { type: 'text', text: '[HARNESS EVIDENCE GUARD] x', marker: 'guard' },
      { type: 'text', text: 'Done — all green.' },
    ];
    const html = renderToStaticMarkup(createElement(AssistantParts, { parts }));
    expect(html).toContain('data-minimal-activity="terminal"');
    expect(html).toContain('Ran 2 commands');
    // A quiet grey line, never a box (owner 2026-10-16: "the small little text in light gray instead of these big boxes").
    expect(html).not.toContain('Terminal');
    expect(html).not.toContain('rounded-2xl');
    expect(html).toContain('Done — all green.');
    expect(html).not.toContain('secret-output');
    expect(html).not.toContain('HARNESS EVIDENCE GUARD');
    expect(html).not.toContain('npm test'); // labels only show once a row is opened
  });

  it('drops the verification footer under an answer', () => {
    const html = renderToStaticMarkup(createElement(CodeTranscriptMarkdown, { text: 'Shipped.\n\n✓ Auto-verify passed (typecheck, lint).' }));
    expect(html).toContain('Shipped.');
    expect(html).not.toContain('data-harness-footer');
    expect(html).not.toContain('Auto-verify');
  });

  it('task card: title and status, no steps / receipts / spend / ETA', () => {
    const html = renderToStaticMarkup(createElement(TaskCard, {
      task: {
        taskId: 't', chatId: 'c', kind: 'session', status: 'running', title: 'Build the investor deck',
        steps: { done: 2, total: 5 }, receipts: { ok: 3, total: 4 }, spendUsd: 0.12, etaText: 'about 5 min',
        startedAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:03:00.000Z', artifacts: [],
      },
    }));
    expect(html).toContain('Build the investor deck');
    expect(html).not.toContain('data-task-steps');
    expect(html).not.toContain('data-task-receipts');
    expect(html).not.toContain('data-task-spend');
    expect(html).not.toContain('about 5 min');
  });

  it('server stubs: hidden rows and the "Message from" line', () => {
    expect(isMinimalHidden({ minimal: { hidden: true } })).toBe(true);
    expect(isMinimalHidden({ origin: 'schedule' })).toBe(false);
    expect(minimalNoteLabel({ minimal: { note: 'message_from', label: 'Hyperstack 8xA100' } })).toBe('Message from Hyperstack 8xA100');
    expect(minimalNoteLabel({ minimal: { note: 'message_from' } })).toBe('Message from another session');
    expect(minimalNoteLabel(undefined)).toBeNull();
    expect(renderToStaticMarkup(createElement(MinimalNoteLine, { text: 'Message from Grok Bot' }))).toContain('Message from Grok Bot');
  });
});

// Owner 2026-10-21, Fleet Supervisor chat: "what are these messages over and over again?" — a column of bare
// "Message from crossmodel Supervisor" / "Message from 5. Close the JWT pending-IP watch" lines. A stretch is ONE line.
describe('minimal view: a stretch of "Message from" notes is one line', () => {
  type Row = { id: string; meta?: unknown };
  const note = (id: string, label?: string): Row => ({ id, meta: { minimal: { note: 'message_from', ...(label ? { label } : {}) } } });
  const hidden = (id: string): Row => ({ id, meta: { minimal: { hidden: true } } });
  const visible = (id: string): Row => ({ id, meta: { origin: 'user' } });
  const group = (rows: Row[]) => groupMinimalNotes(rows, r => r.meta, r => r.id);

  it('the owner\'s pasted stretch collapses to one line with per-sender counts', () => {
    const rows = [
      note('a', 'crossmodel Supervisor'), note('b', '5. Close the JWT pending-IP watch'), note('c', 'cql-agx-orin64 Supervisor'),
      note('d', '5. Close the JWT pending-IP watch'), note('e', 'crossmodel Supervisor'), note('f', 'crossmodel Supervisor'),
      note('g', 'Schooltime Supervisor'),
    ];
    const items = group(rows);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'notes', key: 'a', rows,
      text: 'Messages from crossmodel Supervisor (3), 5. Close the JWT pending-IP watch (2), cql-agx-orin64 Supervisor, +1 more',
      title: 'Messages from crossmodel Supervisor (3), 5. Close the JWT pending-IP watch (2), cql-agx-orin64 Supervisor, Schooltime Supervisor',
    });
  });

  it('a single note keeps today\'s exact text; a missing label still reads "another session"', () => {
    expect(group([note('a', 'Hyperstack 8xA100')])).toEqual([{ kind: 'notes', key: 'a', text: 'Message from Hyperstack 8xA100', rows: [note('a', 'Hyperstack 8xA100')] }]);
    expect(minimalNotesText(['another session', 'another session'])).toBe('Messages from another session (2)');
    expect(group([note('a'), note('b', 'Grok Bot')])[0]).toMatchObject({ text: 'Messages from another session, Grok Bot' });
  });

  it('hidden stubs between notes join the stretch; a visible row breaks it; trailing hidden stubs stay rows', () => {
    const items = group([visible('u1'), note('a', 'X'), hidden('h1'), note('b', 'Y'), hidden('h2'), visible('r1'), note('c', 'X'), hidden('h3')]);
    expect(items.map(i => (i.kind === 'notes' ? `notes:${i.key}:${i.rows.map(r => r.id).join('+')}` : `row:${i.row.id}`))).toEqual([
      'row:u1', 'notes:a:a+h1+b', 'row:h2', 'row:r1', 'notes:c:c', 'row:h3',
    ]);
    expect(items[1]).toMatchObject({ text: 'Messages from X, Y' });
    expect(items[1]).not.toHaveProperty('title');
    expect(items[4]).toMatchObject({ text: 'Message from X' });
  });

  it('no notes ⇒ every row passes through in order', () => {
    expect(group([visible('u1'), hidden('h1'), visible('r1')]).map(i => (i.kind === 'row' ? i.row.id : '?'))).toEqual(['u1', 'h1', 'r1']);
  });

  it('the line carries the uncapped list as its tooltip', () => {
    const html = renderToStaticMarkup(createElement(MinimalNoteLine, { text: 'Messages from A, B, C, +1 more', title: 'Messages from A, B, C, D' }));
    expect(html).toContain('Messages from A, B, C, +1 more');
    expect(html).toContain('title="Messages from A, B, C, D"');
  });

  it('both transcripts render the grouped line in the minimal view', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    expect(read('./CodeSessionView.tsx')).toContain('groupMinimalNotes(slice, row => row.plainMeta, row => row.id)');
    expect(read('../management/SupervisorChatTab.tsx')).toContain('groupMinimalNotes(thread, ');
  });
});

describe('full view (admin Debug mode on) is unchanged', () => {
  afterEach(() => __setViewModeForTests(null));
  it('still renders tool cards and the footer', () => {
    __setViewModeForTests({ viewMode: 'full', isAdmin: true, debugMode: true });
    const html = renderToStaticMarkup(createElement(AssistantParts, { parts: [{ type: 'tool_call', name: 'run_command', args: { command: 'npm test' } }] }));
    expect(html).not.toContain('data-minimal-activity');
    const md = renderToStaticMarkup(createElement(CodeTranscriptMarkdown, { text: 'Shipped.\n\n✓ Auto-verify passed (typecheck, lint).' }));
    expect(md).toContain('data-harness-footer');
  });
});

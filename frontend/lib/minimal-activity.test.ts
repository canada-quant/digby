import { describe, it, expect } from 'vitest';
import { buildMinimalItems, activityKindOf, groupMinimalLines } from './minimal-activity';
import type { MessagePart } from './api/coding';

describe('minimal activity rows', () => {
  it('folds consecutive same-kind calls into one row', () => {
    const parts: MessagePart[] = [
      { type: 'text', text: 'On it.' },
      { type: 'tool_call', name: 'run_command', args: { command: 'npm test' } },
      { type: 'tool_result', name: 'run_command', result: '' },
      { type: 'tool_call', name: 'run_command', args: { command: 'npm run lint' } },
      { type: 'tool_result', name: 'run_command', result: '' },
      { type: 'tool_call', name: 'edit_file', args: { path: 'a.ts' } },
      { type: 'text', text: 'Done.' },
    ];
    const items = buildMinimalItems(parts);
    expect(items).toEqual([
      { kind: 'part', index: 0 },
      { kind: 'activity', activity: 'terminal', title: 'Terminal', summary: 'Ran 2 commands', labels: ['npm test', 'npm run lint'], start: 1, count: 2, firstTool: 'run_command' },
      { kind: 'activity', activity: 'edit', title: 'Files', summary: 'Edited 1 file', labels: ['a.ts'], start: 5, count: 1, firstTool: 'edit_file' },
      { kind: 'part', index: 6 },
    ]);
  });

  it('names a routine and skips bookkeeping, guard notes and reasoning', () => {
    const items = buildMinimalItems([
      { type: 'reasoning', text: 'x' },
      { type: 'tool_call', name: 'update_plan', args: {} },
      { type: 'text', text: 'guard', marker: 'guard' },
      { type: 'text', text: 'draft', struck: true },
      { type: 'tool_call', name: 'schedule_message', args: { name: 'MuseSpark job hourly check-in' } },
    ] as MessagePart[]);
    expect(items).toEqual([
      { kind: 'activity', activity: 'routine', title: 'Routine', summary: 'Created routine MuseSpark job hourly check-in', labels: ['MuseSpark job hourly check-in'], start: 4, note: true, count: 1, firstTool: 'schedule_message' },
    ]);
  });

  it('routine verbs follow the tool; messages are one-line notes', () => {
    const [r] = buildMinimalItems([{ type: 'tool_call', name: 'cancel_schedule', args: {} }] as MessagePart[]);
    expect(r).toMatchObject({ kind: 'activity', summary: 'Stopped routine', note: true });
    const [m] = buildMinimalItems([{ type: 'tool_call', name: 'send_chat_message', args: {} }] as MessagePart[]);
    expect(m).toMatchObject({ kind: 'activity', summary: 'Sent a message', note: true });
  });

  it('classifies common tools', () => {
    expect(activityKindOf('read_file')).toBe('read');
    expect(activityKindOf('write_file')).toBe('edit');
    expect(activityKindOf('search_engine')).toBe('web');
    expect(activityKindOf('send_chat_message')).toBe('message');
    expect(activityKindOf('start_coding_session')).toBe('session');
    expect(activityKindOf('open_pull_request')).toBe('github');
    expect(activityKindOf('browser_task')).toBe('browser');
    expect(activityKindOf('search_memory')).toBe('memory');
    expect(activityKindOf('mystery')).toBe('other');
  });

  it('merges every step between two pieces of prose into one quiet line', () => {
    const items = groupMinimalLines(buildMinimalItems([
      { type: 'text', text: "I'll pull up those two CRA letters now." },
      { type: 'tool_call', name: 'gmail_search', args: { query: 'CRA' } },
      { type: 'tool_call', name: 'gmail_get_message', args: {} },
      { type: 'tool_call', name: 'search_memory', args: {} },
      { type: 'tool_call', name: 'gmail_get_attachment', args: {} },
      { type: 'tool_call', name: 'gmail_get_attachment', args: {} },
      { type: 'tool_call', name: 'schedule_message', args: { name: 'CRA reply watch' } },
      { type: 'text', text: 'Here is what the letters say.' },
    ] as MessagePart[]));
    expect(items.map(i => i.kind)).toEqual(['part', 'activityLine', 'activity', 'part']);
    expect(items[1]).toMatchObject({ kind: 'activityLine', text: 'Read 4 emails · Checked memory', start: 1 });
    expect((items[2] as any).note).toBe(true);
  });

  it('names apps and connectors instead of "Tools"', () => {
    const line = (name: string) => (groupMinimalLines(buildMinimalItems([{ type: 'tool_call', name, args: {} }] as MessagePart[]))[0] as any).text;
    expect(line('slack_search')).toBe('Checked Slack');
    expect(line('mcp_granola_list_meetings')).toBe('Checked Granola');
    expect(line('calendar_list_events')).toBe('Checked the calendar');
    expect(line('drive_search')).toBe('Checked Drive');
    expect(line('gmail_send_email')).toBeUndefined(); // a sent email is a note line, not a quiet line
  });
});

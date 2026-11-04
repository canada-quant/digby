/**
 * chat-list-live.ts — the sidebar delta merge + watermark (ticket d6b2eef5):
 * known rows refresh in place (transcript kept, position kept), unknown rows
 * are prepended, an unchanged delta returns the same array, and the running-id
 * kick fires once per unknown id.
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_LIST_LIVE_ACTIVE_MS, CHAT_LIST_LIVE_IDLE_MS, CHAT_LIST_LIVE_LIMIT,
  mergeChatRows, newestUpdatedAt, unknownRunningIds,
} from './chat-list-live';

type Row = { id: string; title?: string; parentChatId?: string | null; updatedAt?: string; messages?: unknown[] };
const row = (id: string, updatedAt: string, extra: Partial<Row> = {}): Row => ({ id, title: `T ${id}`, parentChatId: null, updatedAt, messages: [], ...extra });

describe('newestUpdatedAt', () => {
  it('returns the newest ISO updatedAt, never below the floor, null when nothing carries one', () => {
    expect(newestUpdatedAt([row('a', '2026-09-28T10:00:00.000Z'), row('b', '2026-09-28T11:00:00.000Z')])).toBe('2026-09-28T11:00:00.000Z');
    expect(newestUpdatedAt([row('a', '2026-09-28T10:00:00.000Z')], '2026-09-28T12:00:00.000Z')).toBe('2026-09-28T12:00:00.000Z');
    expect(newestUpdatedAt([{ id: 'x' }])).toBeNull();
    expect(newestUpdatedAt([], '2026-09-28T09:00:00.000Z')).toBe('2026-09-28T09:00:00.000Z');
  });
});

describe('mergeChatRows', () => {
  const prev = [row('a', '2026-09-28T10:00:00.000Z', { messages: [{ role: 'user', content: 'hi' }] }), row('b', '2026-09-28T09:00:00.000Z')];

  it('prepends unknown rows in incoming order and leaves known rows untouched', () => {
    const m = mergeChatRows(prev, [row('new2', '2026-09-28T12:00:00.000Z'), row('new1', '2026-09-28T11:30:00.000Z')]);
    expect(m.changed).toBe(true);
    expect(m.rows.map((r) => r.id)).toEqual(['new2', 'new1', 'a', 'b']);
    expect(m.added).toEqual(['new2', 'new1']);
    expect(m.updated).toEqual([]);
    expect(m.rows[2]).toBe(prev[0]); // same object — no churn on untouched rows
  });

  it('refreshes a known row in place — fields overwrite, the loaded transcript is kept, the position is kept', () => {
    const m = mergeChatRows(prev, [row('a', '2026-09-28T12:00:00.000Z', { title: 'Renamed', parentChatId: 'p' })]);
    expect(m.changed).toBe(true);
    expect(m.updated).toEqual(['a']);
    expect(m.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(m.rows[0]).toMatchObject({ title: 'Renamed', parentChatId: 'p', updatedAt: '2026-09-28T12:00:00.000Z' });
    expect(m.rows[0].messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('returns the SAME array when the delta carries nothing new (no re-render) and ignores malformed rows', () => {
    const same = mergeChatRows(prev, [row('a', '2026-09-28T10:00:00.000Z', { messages: [] })]);
    expect(same.changed).toBe(false);
    expect(same.rows).toBe(prev);
    expect(mergeChatRows(prev, []).rows).toBe(prev);
    expect(mergeChatRows(prev, [{ id: undefined } as unknown as Row]).rows).toBe(prev);
  });

  it('dedupes an id repeated inside one delta', () => {
    const m = mergeChatRows(prev, [row('n', '2026-09-28T12:00:00.000Z'), row('n', '2026-09-28T12:00:00.000Z')]);
    expect(m.rows.map((r) => r.id)).toEqual(['n', 'a', 'b']);
  });
});

describe('unknownRunningIds + constants', () => {
  it('reports running ids the sidebar has no row for, once per id', () => {
    const kicked = new Set<string>();
    expect(unknownRunningIds(['a', 'x'], new Set(['a']), kicked)).toEqual(['x']);
    expect(unknownRunningIds(['a', 'x', 'y'], new Set(['a']), kicked)).toEqual(['y']);
    expect(kicked).toEqual(new Set(['x', 'y']));
  });

  it('cadence: 15 s while a coding spinner is visible, 60 s idle; 50 rows per delta', () => {
    expect(CHAT_LIST_LIVE_ACTIVE_MS).toBe(15_000);
    expect(CHAT_LIST_LIVE_IDLE_MS).toBe(60_000);
    expect(CHAT_LIST_LIVE_LIMIT).toBe(50);
  });
});

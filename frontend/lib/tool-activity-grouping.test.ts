/**
 * Ticket 295068fa — pins for the tool-activity accordion (see
 * tool-activity-grouping.ts): ≥4 consecutive tool parts collapse into ONE
 * pill; the run at the parts tail (the live edge) NEVER collapses; short runs
 * pass through; grouping never reorders or drops a part.
 */

import { describe, expect, it } from 'vitest';
import type { MessagePart } from '@/lib/api/coding';
import { groupProseParts } from './prose-grouping';
import { groupToolActivityItems, pairToolActions, toolActivityLabel, toolKindNoun, MIN_TOOL_RUN, MIN_LIVE_TOOL_RUN, type ToolActivityItem } from './tool-activity-grouping';

const tc = (name: string): MessagePart => ({ type: 'tool_call', name, args: {} });
const tr = (name: string): MessagePart => ({ type: 'tool_result', name, result: 'ok' });
const txt = (t: string): MessagePart => ({ type: 'text', text: t });

const toolRuns = (items: ReturnType<typeof groupToolActivityItems>) =>
  items.filter((i): i is ToolActivityItem => i.kind === 'toolActivity');

describe('295068fa — groupToolActivityItems', () => {
  it('collapses a completed run of ≥MIN_TOOL_RUN tool parts into one pill', () => {
    const parts = [txt('Starting.'), tc('read_file'), tr('read_file'), tc('grep'), tr('grep'), tc('edit_file'), tr('edit_file'), txt('Done.')];
    const items = groupToolActivityItems(groupProseParts(parts), parts);
    const runs = toolRuns(items);
    expect(runs).toHaveLength(1);
    expect(runs[0].indices).toEqual([1, 2, 3, 4, 5, 6]);
    expect(runs[0].names).toEqual(['read_file', 'read_file', 'grep', 'grep', 'edit_file', 'edit_file']);
    // No part is dropped or reordered: the surrounding text singles keep
    // their exact positions (groupProseParts emits lone text parts adjacent
    // to tool runs as kind:'part' singles, not prose groups).
    expect(items[0].kind).toBe('part');
    expect((items[0] as any).part.text).toBe('Starting.');
    expect(items[items.length - 1].kind).toBe('part');
    expect((items[items.length - 1] as any).part.text).toBe('Done.');
    expect(items[1].kind).toBe('toolActivity');
  });

  it('the TAIL run (live edge) never collapses by default, even when long (coding sessions follow along)', () => {
    const parts = [txt('Working.'), tc('a'), tr('a'), tc('b'), tr('b'), tc('c'), tr('c')];
    const items = groupToolActivityItems(groupProseParts(parts), parts);
    expect(toolRuns(items)).toHaveLength(0);
    // All six tool parts plus the leading text single still render in order.
    const singles = items.filter(i => i.kind === 'part');
    expect(singles).toHaveLength(7);
    expect((singles[0] as any).part.text).toBe('Working.');
  });

  // Owner 2026-09-15: a Level 2 chat showed ~30 flat tool rows above the
  // Double Checker chip — all of them the live edge. Plain chats fold it.
  it('foldTail: the TAIL run folds into ONE live pill (≥ MIN_LIVE_TOOL_RUN), flagged live, with the seats that produced it', () => {
    const lab = (p: MessagePart, label: string): MessagePart => ({ ...p, label } as MessagePart);
    const parts = [
      txt('Working.'),
      lab(tc('search_engine'), 'Double Checker'), lab(tr('search_engine'), 'Double Checker'),
      lab(tc('search_memory'), 'Digby'), lab(tr('search_memory'), 'Digby'),
      lab(tc('scrape_as_markdown'), 'Double Checker'), lab(tr('scrape_as_markdown'), 'Double Checker'),
    ];
    const items = groupToolActivityItems(groupProseParts(parts), parts, { foldTail: true });
    const runs = toolRuns(items);
    expect(runs).toHaveLength(1);
    expect(runs[0].live).toBe(true);
    expect(runs[0].indices).toEqual([1, 2, 3, 4, 5, 6]);
    expect(runs[0].labels).toEqual(['Double Checker', 'Digby']); // first-seen order, deduped
    expect(MIN_LIVE_TOOL_RUN).toBe(3);
    // Below the live floor the tail stays inline even with foldTail.
    const short = [txt('x'), tc('a'), tr('a')];
    expect(toolRuns(groupToolActivityItems(groupProseParts(short), short, { foldTail: true }))).toHaveLength(0);
    // A COMPLETED run (prose follows) is never flagged live and keeps the ≥4 floor.
    const done = [txt('x'), tc('a'), tr('a'), tc('b'), tr('b'), txt('y')];
    const doneRuns = toolRuns(groupToolActivityItems(groupProseParts(done), done, { foldTail: true }));
    expect(doneRuns).toHaveLength(1);
    expect(doneRuns[0].live).toBeUndefined();
    expect(doneRuns[0].labels).toEqual([]);
  });

  it('short runs (<MIN_TOOL_RUN) pass through untouched', () => {
    const parts = [txt('x'), tc('a'), tr('a'), tc('b'), txt('y')];
    const partsArr = parts as MessagePart[];
    const items = groupToolActivityItems(groupProseParts(partsArr), partsArr);
    expect(toolRuns(items)).toHaveLength(0);
    expect(MIN_TOOL_RUN).toBeGreaterThan(3);
  });

  it('two runs separated by prose collapse independently', () => {
    const runA = [tc('a'), tr('a'), tc('b'), tr('b')];
    const runB = [tc('c'), tr('c'), tc('d'), tr('d')];
    const parts = [txt('one'), ...runA, txt('two'), ...runB, txt('three')];
    const items = groupToolActivityItems(groupProseParts(parts), parts);
    expect(toolRuns(items)).toHaveLength(2);
  });

  it('label is plain English with per-kind counts, biggest first — never a raw tool name (owner directive 2026-07-24)', () => {
    expect(toolActivityLabel(['run_command', 'run_command', 'run_command', 'read_file', 'read_file', 'grep']))
      .toBe('6 actions · 3 commands · 2 files read · 1 code search');
    expect(toolActivityLabel(['search_engine', 'search_engine', 'search_memory', 'scrape_as_markdown', 'scrape_as_markdown', 'web_pipe', 'search_engine', 'search_memory', 'scrape_as_markdown']))
      .toBe('9 actions · 3 web searches · 3 pages read · 2 memory searches · …');
    expect(toolActivityLabel(['a', 'b', 'c', 'd'])).toContain('4 actions');
    expect(toolActivityLabel(['search_engine'])).toBe('1 action · 1 web search');
    // With the parts, a tool_call + its tool_result count as ONE action.
    const parts: MessagePart[] = [tc('search_engine'), tr('search_engine'), tc('search_memory'), tr('search_memory')];
    expect(toolActivityLabel(parts.map(p => p.name!), parts)).toBe('2 actions · 1 web search · 1 memory search');
    expect(toolKindNoun('scrape_batch')).toEqual(['batch of pages read', 'batches of pages read']);
    expect(toolKindNoun('some_new_tool')).toEqual(['some new tool', 'some new tool']);
  });

  it('the pill key is uid-first (review N1), positional only as fallback', () => {
    const withUid = (name: string, uid: string): MessagePart => ({ type: 'tool_call', name, args: {}, uid } as MessagePart);
    const parts = [txt('x'), withUid('a', 'u-first'), tr('a'), tc('b'), tr('b'), txt('y')];
    const items = groupToolActivityItems(groupProseParts(parts), parts);
    expect(toolRuns(items)[0].key).toBe('u-first');
    // Persisted rows carry no uid → positional fallback (their array never shifts).
    const persisted = [txt('x'), tc('a'), tr('a'), tc('b'), tr('b'), txt('y')];
    const items2 = groupToolActivityItems(groupProseParts(persisted), persisted);
    expect(toolRuns(items2)[0].key).toBe('ta1');
  });
});

describe('pairToolActions — call↔result pairing across interleaved seats (owner 2026-09-15)', () => {
  const lc = (name: string, label: string): MessagePart => ({ type: 'tool_call', name, args: {}, label } as MessagePart);
  const lr = (name: string, label: string): MessagePart => ({ type: 'tool_result', name, result: '1 B', label } as MessagePart);

  it('adjacent pairs bind exactly as the old adjacency merge did', () => {
    const parts = [tc('a'), tr('a'), tc('b'), tr('b')];
    const { resultFor, pairedResults } = pairToolActions(parts);
    expect(resultFor.get(0)).toBe(1);
    expect(resultFor.get(2)).toBe(3);
    expect([...pairedResults].sort()).toEqual([1, 3]);
  });

  it('a late result binds to the NEAREST EARLIER unpaired call of the same name', () => {
    // Digby fires two searches, the results land later and out of order with a memory lookup between.
    const parts = [tc('search_engine'), tc('search_memory'), tc('search_engine'), tr('search_memory'), tr('search_engine'), tr('search_engine')];
    const { resultFor, pairedResults } = pairToolActions(parts);
    expect(resultFor.get(1)).toBe(3);
    expect(resultFor.get(2)).toBe(4); // nearest earlier open search_engine call
    expect(resultFor.get(0)).toBe(5);
    expect(pairedResults.size).toBe(3);
  });

  it('seat labels keep the Double Checker\'s result off Digby\'s card', () => {
    const parts = [lc('search_engine', 'Digby'), lc('search_engine', 'Double Checker'), lr('search_engine', 'Digby'), lr('search_engine', 'Double Checker')];
    const { resultFor } = pairToolActions(parts);
    expect(resultFor.get(0)).toBe(2);
    expect(resultFor.get(1)).toBe(3);
  });

  it('an unlabelled result (legacy stream) may still bind to a labelled call', () => {
    const parts = [lc('scrape_as_markdown', 'Digby'), tr('scrape_as_markdown')];
    expect(pairToolActions(parts).resultFor.get(0)).toBe(1);
  });

  it('an orphan result (no earlier call) stays unpaired so the renderer can still show it', () => {
    const parts = [tr('search_engine'), tc('search_engine')];
    const { resultFor, pairedResults } = pairToolActions(parts);
    expect(resultFor.size).toBe(0);
    expect(pairedResults.size).toBe(0);
  });
});

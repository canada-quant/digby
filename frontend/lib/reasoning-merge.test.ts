import { describe, it, expect } from 'vitest';
import { mergeDeltaIntoParts, splitSummaryLabel } from './reasoning-merge';
import type { MessagePart } from './api/coding';

const t = (text: string): MessagePart => ({ type: 'text', text } as MessagePart);
const tool = (name = 'run_command'): MessagePart => ({ type: 'tool_call', name, args: {} } as MessagePart);
/** A seat-labelled tool part — the plain-chat agent-activity shape (sse-adapter.ts
 *  sends `label: 'Digby'` for the lead, `label: 'Double Checker'` for the checker). */
const seatTool = (name: string, label: string, extra: Record<string, unknown> = {}): MessagePart =>
  ({ type: 'tool_call', name, args: {}, label, ...extra } as MessagePart);
const R = (parts: MessagePart[]) => parts.filter(p => p.type === 'reasoning');

describe('mergeDeltaIntoParts — per-label reasoning coalescing (2026-08-30 spam fix)', () => {
  it('zebra-interleaved personas coalesce into ONE part per label (no fragment rows)', () => {
    let parts: MessagePart[] = [];
    const seq: Array<[string, string]> = [
      ['Digby', 'The quick'], ['Fact-checker', 'I disagree'], ['Digby', ' brown fox'],
      ['Fact-checker', ' because…'], ['Digby', ' jumps'], ['Fact-checker', ' here'],
    ];
    for (const [label, delta] of seq) parts = mergeDeltaIntoParts(parts, 'reasoning', delta, { label });
    expect(R(parts)).toHaveLength(2);
    expect(parts.map(p => `${p.label}:${p.text}`)).toEqual([
      'Digby:The quick brown fox jumps',
      'Fact-checker:I disagree because… here',
    ]);
  });

  it('a persona part keeps its first-appearance position even after tools/text intervene', () => {
    let parts: MessagePart[] = [];
    parts = mergeDeltaIntoParts(parts, 'reasoning', 'hmm', { label: 'Digby' });
    parts = [...parts, tool()];
    parts = mergeDeltaIntoParts(parts, 'text', 'Answer. ');
    parts = mergeDeltaIntoParts(parts, 'reasoning', 'more', { label: 'Digby' });
    expect(parts.map(p => p.type)).toEqual(['reasoning', 'tool_call', 'text']);
    expect((parts[0] as any).text).toBe('hmmmore');
  });

  it('unlabeled reasoning rides the most recent reasoning part instead of splitting the run', () => {
    let parts: MessagePart[] = [];
    parts = mergeDeltaIntoParts(parts, 'reasoning', 'abc', { label: 'Digby' });
    parts = mergeDeltaIntoParts(parts, 'reasoning', 'summary\n');
    parts = mergeDeltaIntoParts(parts, 'reasoning', 'def', { label: 'Digby' });
    expect(R(parts)).toHaveLength(1);
    expect((parts[0] as any).text).toBe('abcsummary\ndef');
    expect((parts[0] as any).label).toBe('Digby');
  });

  it('unlabeled reasoning with no prior reasoning part starts its own unlabeled part', () => {
    let parts: MessagePart[] = [t('hi')];
    parts = mergeDeltaIntoParts(parts, 'reasoning', 'thinking');
    expect(parts[1]).toMatchObject({ type: 'reasoning', text: 'thinking' });
    expect((parts[1] as any).label).toBeUndefined();
  });

  it('text deltas trailing-merge; interleaved reasoning coalesces into one part mid-run', () => {
    // kimi-k3-style interleaving: T, R, T, R, T — reasoning deltas land in
    // the ONE reasoning part (position fixed), later text trailing-merges.
    // The resulting [text, reasoning, text] shape is exactly what
    // prose-grouping.ts renders as a single joined prose block.
    let parts: MessagePart[] = [];
    parts = mergeDeltaIntoParts(parts, 'text', 'Hello ');
    parts = mergeDeltaIntoParts(parts, 'reasoning', 'hmm');
    parts = mergeDeltaIntoParts(parts, 'text', 'world');
    parts = mergeDeltaIntoParts(parts, 'reasoning', ' more');
    parts = mergeDeltaIntoParts(parts, 'text', '!');
    expect(parts.map(p => `${p.type}:${p.text}`)).toEqual(['text:Hello ', 'reasoning:hmm more', 'text:world!']);
  });

  it('is immutable — merges return a new array and a new part object', () => {
    const before: MessagePart[] = [{ type: 'reasoning', text: 'a', label: 'Digby', uid: 'p1' } as MessagePart];
    const after = mergeDeltaIntoParts(before, 'reasoning', 'b', { label: 'Digby' });
    expect(after).not.toBe(before);
    expect(after[0]).not.toBe(before[0]);
    expect(before[0].text).toBe('a');
    expect((after[0] as any).uid).toBe('p1'); // uid preserved → React key stable
  });

  it('stamps only NEWLY created parts', () => {
    let n = 0;
    const stamp = (p: MessagePart) => ({ ...p, uid: `u${++n}` } as MessagePart);
    let parts: MessagePart[] = [];
    parts = mergeDeltaIntoParts(parts, 'reasoning', 'a', { label: 'Digby', stamp });
    parts = mergeDeltaIntoParts(parts, 'reasoning', 'b', { label: 'Digby', stamp });
    expect(n).toBe(1);
    expect((parts[0] as any).uid).toBe('u1');
  });

  it('empty deltas are a no-op (same array reference)', () => {
    const parts: MessagePart[] = [];
    expect(mergeDeltaIntoParts(parts, 'reasoning', '', { label: 'Digby' })).toBe(parts);
  });
});

// Ticket 53c0b979 (user report 2026-10-24: "unprofessional ui responses
// chronologically sometimes breaks words with tool calls"): the Double
// Checker's agent-activity tool frames stream on the SAME SSE as the lead's
// answer chunks (chat-agent.service.ts runs the checker concurrently via
// Promise.all), so a checker tool part can land between two deltas of ONE
// word. The trailing-only text rule opened a NEW text part after the card —
// and AssistantParts renders in ARRIVAL ORDER, so the word rendered split
// across the tool card. These tests replay that stream shape.
describe('mergeDeltaIntoParts — text continues across foreign-seat tool cards (ticket 53c0b979)', () => {
  it('the lead\'s mid-word text is NEVER split by a Double Checker tool card landing between its deltas', () => {
    let parts: MessagePart[] = [];
    parts = mergeDeltaIntoParts(parts, 'text', 'The figure is 2.1 per');
    // The checker's tool frames interleave with the lead's answer stream.
    parts = [...parts, seatTool('search_engine', 'Double Checker')];
    parts = mergeDeltaIntoParts(parts, 'text', 'cent (stats.gov).');
    const texts = parts.filter(p => p.type === 'text');
    expect(texts).toHaveLength(1); // ONE text part — the word "percent" is whole
    expect(texts[0].text).toBe('The figure is 2.1 percent (stats.gov).');
    // The card keeps its chronological slot (still in the array, after the text part).
    expect(parts.map(p => p.type)).toEqual(['text', 'tool_call']);
  });

  it('reasoning between foreign-seat tool cards is crossed too (the window is foreign tools + reasoning)', () => {
    let parts: MessagePart[] = [];
    parts = mergeDeltaIntoParts(parts, 'text', 'Answer begins: 4');
    parts = [...parts, seatTool('search_engine', 'Double Checker')];
    parts = mergeDeltaIntoParts(parts, 'reasoning', 'checker thought', { label: 'Double Checker' });
    parts = mergeDeltaIntoParts(parts, 'text', '2');
    expect(parts.filter(p => p.type === 'text')).toHaveLength(1);
    expect((parts.find(p => p.type === 'text') as any).text).toBe('Answer begins: 42');
  });

  it('the lead\'s OWN tool card still breaks text (label "Digby" — its trail separates pre/post text)', () => {
    let parts: MessagePart[] = [];
    parts = mergeDeltaIntoParts(parts, 'text', 'Before the tool.');
    parts = [...parts, seatTool('search_engine', 'Digby')];
    parts = mergeDeltaIntoParts(parts, 'text', 'After the tool.');
    expect(parts.filter(p => p.type === 'text').map(p => p.text)).toEqual(['Before the tool.', 'After the tool.']);
  });

  it('UNLABELLED tool cards still break text (coding sessions and pre-2026-09-15 servers — untouched surface)', () => {
    let parts: MessagePart[] = [];
    parts = mergeDeltaIntoParts(parts, 'text', 'Before.');
    parts = [...parts, tool()];
    parts = mergeDeltaIntoParts(parts, 'text', 'After.');
    expect(parts.filter(p => p.type === 'text').map(p => p.text)).toEqual(['Before.', 'After.']);
  });

  it('a guard marker or struck draft is never crossed back into (text after it starts a NEW part)', () => {
    let parts: MessagePart[] = [];
    parts = mergeDeltaIntoParts(parts, 'text', 'draft');
    parts = [...parts, { type: 'text', text: 'guard notice', marker: 'guard' } as MessagePart];
    parts = mergeDeltaIntoParts(parts, 'text', ' next');
    // the marker block is its own block; the text after it is a NEW part
    expect(parts.filter(p => p.type === 'text').map(p => (p as any).text)).toEqual(['draft', 'guard notice', ' next']);
    // struck draft: the walk stops at it even across a foreign-seat card
    const struckParts: MessagePart[] = [t('rejected'), { ...t('struck one'), struck: true } as MessagePart, seatTool('web_pipe', 'Double Checker')];
    const out = mergeDeltaIntoParts(struckParts, 'text', ' continuation');
    expect(out.filter(p => p.type === 'text').map(p => (p as any).text)).toEqual(['rejected', 'struck one', ' continuation']);
  });

  it('a foreign-seat tool run longer than the lead\'s last text still continues it (window is unbounded back to the last crossable boundary)', () => {
    let parts: MessagePart[] = [];
    parts = mergeDeltaIntoParts(parts, 'text', 'The answer: ');
    parts = [...parts, seatTool('search_engine', 'Double Checker'), seatTool('scrape_as_markdown', 'Double Checker'), { type: 'tool_result', name: 'scrape_as_markdown', result: 'x', label: 'Double Checker' } as MessagePart];
    parts = mergeDeltaIntoParts(parts, 'text', '42.');
    expect(parts.filter(p => p.type === 'text')).toHaveLength(1);
    expect((parts.find(p => p.type === 'text') as any).text).toBe('The answer: 42.');
    // Nothing was lost: the tool run stays verbatim in arrival order.
    expect(parts.filter(p => p.type === 'tool_call')).toHaveLength(2);
    expect(parts.filter(p => p.type === 'tool_result')).toHaveLength(1);
  });

  it('the continued text part keeps its object identity shape (stamp not required) and inputs stay untouched', () => {
    let parts: MessagePart[] = [];
    parts = mergeDeltaIntoParts(parts, 'text', 'alpha');
    parts = [...parts, seatTool('search_engine', 'Double Checker')];
    const original = parts.slice();
    const next = mergeDeltaIntoParts(parts, 'text', 'beta');
    expect((next.find(p => p.type === 'text') as any).text).toBe('alphabeta');
    // the INPUT array is untouched (immutable merge — a NEW part object replaced the old one in a NEW array)
    expect(parts).toEqual(original);
    expect((parts.find(p => p.type === 'text') as any).text).toBe('alpha');
    expect(next).not.toBe(parts);
  });
});

describe('splitSummaryLabel', () => {
  it('splits a persona prefix', () => {
    expect(splitSummaryLabel('Digby: The quick brown')).toEqual({ label: 'Digby', text: 'The quick brown' });
    expect(splitSummaryLabel('Fact-checker clone 1: hmm')).toEqual({ label: 'Fact-checker clone 1', text: 'hmm' });
  });
  it('passes through summaries with no prefix', () => {
    expect(splitSummaryLabel('Searched the web')).toEqual({ text: 'Searched the web' });
  });
});

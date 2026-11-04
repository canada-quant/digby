import { describe, it, expect } from 'vitest';
import { groupProseParts, proseGroupText, type ProseGroupItem, type SinglePartItem } from './prose-grouping';
import type { MessagePart } from './api/coding';

const t = (text: string, uid?: string): MessagePart => ({ type: 'text', text, ...(uid ? { uid } : {}) } as MessagePart);
const r = (text: string, uid?: string): MessagePart => ({ type: 'reasoning', text, ...(uid ? { uid } : {}) } as MessagePart);
const tool = (name = 'run_command'): MessagePart => ({ type: 'tool_call', name, args: {} } as MessagePart);

const groups = (items: ReturnType<typeof groupProseParts>) => items.filter(i => i.kind === 'prose') as ProseGroupItem[];
const singles = (items: ReturnType<typeof groupProseParts>) => items.filter(i => i.kind === 'part') as SinglePartItem[];

describe('groupProseParts', () => {
  it('groups [text, reasoning, text] into one prose group with a lossless join', () => {
    const items = groupProseParts([t('Hello '), r('thinking…'), t('world')]);
    expect(items).toHaveLength(1);
    const g = groups(items)[0];
    expect(proseGroupText(g)).toBe('Hello world');
    expect(g.thoughts).toHaveLength(1);
    expect(g.raw).toHaveLength(3);
  });

  it('groups long interleavings [t,r,t,r,t] with all thoughts in arrival order', () => {
    const items = groupProseParts([t('A'), r('r1'), t('B'), r('r2'), t('C')]);
    expect(items).toHaveLength(1);
    const g = groups(items)[0];
    expect(proseGroupText(g)).toBe('ABC');
    expect(g.thoughts.map(x => x.text)).toEqual(['r1', 'r2']);
  });

  it('joins mid-word fragments exactly (no invented whitespace)', () => {
    const g = groups(groupProseParts([t('Ver'), r('hmm'), t('ifier watching')]))[0];
    expect(proseGroupText(g)).toBe('Verifier watching');
  });

  it('passes a lone text part through unchanged', () => {
    const items = groupProseParts([t('solo')]);
    expect(groups(items)).toHaveLength(0);
    expect(singles(items)).toHaveLength(1);
  });

  it('passes a lone reasoning part through unchanged', () => {
    const items = groupProseParts([r('solo')]);
    expect(groups(items)).toHaveLength(0);
    expect(singles(items)).toHaveLength(1);
  });

  it('does NOT group [text, reasoning] (thought after prose, nothing follows)', () => {
    const items = groupProseParts([t('answer'), r('tail thought')]);
    expect(groups(items)).toHaveLength(0);
    expect(singles(items)).toHaveLength(2);
  });

  it('does NOT group [reasoning, text] (thought before prose, nothing precedes)', () => {
    const items = groupProseParts([r('plan first'), t('answer')]);
    expect(groups(items)).toHaveLength(0);
    expect(singles(items)).toHaveLength(2);
  });

  it('a tool call breaks the run — [t, tool, t] stays three singles', () => {
    const items = groupProseParts([t('A'), tool(), t('B')]);
    expect(groups(items)).toHaveLength(0);
    expect(singles(items)).toHaveLength(3);
    expect(singles(items)[1].part.type).toBe('tool_call');
  });

  it('groups on both sides of an interleaved tool call', () => {
    const items = groupProseParts([t('A'), r('r1'), t('B'), tool(), t('C'), r('r2'), t('D')]);
    expect(items).toHaveLength(3);
    expect(items.map(i => i.kind)).toEqual(['prose', 'part', 'prose']);
    expect(proseGroupText(groups(items)[0])).toBe('AB');
    expect(proseGroupText(groups(items)[1])).toBe('CD');
  });

  it('single-part indices stay aligned with the original array (tool_call→tool_result merge peek)', () => {
    const items = groupProseParts([t('A'), r('r'), t('B'), tool('grep'), { type: 'tool_result', name: 'grep', result: 'x' } as MessagePart]);
    const s = singles(items);
    expect(s[0].index).toBe(3);
    expect(s[1].index).toBe(4);
  });

  it('empty reasoning still allows grouping but adds no thought chip', () => {
    const items = groupProseParts([t('A'), r('   '), t('B')]);
    const g = groups(items);
    expect(g).toHaveLength(1);
    expect(g[0].thoughts).toHaveLength(0);
    expect(proseGroupText(g[0])).toBe('AB');
  });

  it('whitespace-only text parts do not form groups on their own', () => {
    const items = groupProseParts([t('  '), r('r'), t('real')]);
    expect(groups(items)).toHaveLength(0);
    expect(singles(items)).toHaveLength(3);
  });

  it('whitespace-only text inside a group is preserved in the join (lossless)', () => {
    const items = groupProseParts([t('A'), t(' '), r('r'), t('B')]);
    const g = groups(items);
    expect(g).toHaveLength(1);
    expect(proseGroupText(g[0])).toBe('A B');
  });

  it('pure consecutive text parts (no reasoning) are NOT regrouped — zero behavior change', () => {
    const items = groupProseParts([t('A'), t('B')]);
    expect(groups(items)).toHaveLength(0);
    expect(singles(items)).toHaveLength(2);
  });

  it('group key uses the first part uid when present, positional fallback otherwise', () => {
    const withUid = groups(groupProseParts([t('A', 'p7'), r('r', 'p8'), t('B', 'p9')]));
    expect(withUid[0].key).toBe('p7');
    const noUid = groups(groupProseParts([t('x'), tool(), t('A'), r('r'), t('B')]));
    expect(noUid[0].key).toBe('g2');
  });

  it('a trailing reasoning inside a run is absorbed into the group', () => {
    const items = groupProseParts([t('A'), r('r1'), t('B'), r('r2')]);
    expect(items).toHaveLength(1);
    const g = groups(items)[0];
    expect(g.thoughts.map(x => x.text)).toEqual(['r1', 'r2']);
    expect(proseGroupText(g)).toBe('AB');
  });

  it('raw preserves the exact arrival order for expansion', () => {
    const input = [t('A'), r('r1'), t('B'), r('r2'), t('C')];
    const g = groups(groupProseParts(input))[0];
    expect(g.raw.map(p => p.type)).toEqual(['text', 'reasoning', 'text', 'reasoning', 'text']);
  });

  it('collapses a pure multi-persona reasoning run into ONE thoughts item (2026-08-30 spam fix)', () => {
    const items = groupProseParts([
      { type: 'reasoning', text: 'hmm', label: 'Digby' } as MessagePart,
      { type: 'reasoning', text: 'checking', label: 'Fact-checker' } as MessagePart,
      { type: 'reasoning', text: 'sources', label: 'Researcher' } as MessagePart,
    ]);
    expect(items).toHaveLength(1);
    const th = items[0];
    expect(th.kind).toBe('thoughts');
    if (th.kind === 'thoughts') {
      expect(th.thoughts.map(x => x.label)).toEqual(['Digby', 'Fact-checker', 'Researcher']);
      expect(th.endIndex).toBe(2);
    }
  });

  it('a lone reasoning part still passes through as a single', () => {
    const items = groupProseParts([r('solo')]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('part');
  });

  it('reasoning subruns group inside a non-prose mixed run, text stays a single', () => {
    const items = groupProseParts([r('r1'), r('r2'), t('answer')]);
    expect(items.map(i => i.kind)).toEqual(['thoughts', 'part']);
  });

  it('a tool call between persona thoughts yields two separate thoughts items', () => {
    const items = groupProseParts([r('a'), r('b'), tool(), r('c'), r('d')]);
    expect(items.map(i => i.kind)).toEqual(['thoughts', 'part', 'thoughts']);
  });

  it('whitespace-only reasoning parts are dropped from a thoughts group', () => {
    const items = groupProseParts([r('  '), r('real'), r('also real')]);
    expect(items).toHaveLength(1);
    if (items[0].kind === 'thoughts') expect(items[0].thoughts.map(x => x.text)).toEqual(['real', 'also real']);
  });
});

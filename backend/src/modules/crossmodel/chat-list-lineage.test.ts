/**
 * chat-list-lineage.ts — the sidebar page completes its lineage server-side
 * (ticket d6b2eef5): missing parents are found per hop and spliced in right
 * before their first descendant, so nesting is right on first paint.
 */
import { CHAT_LIST_ANCESTOR_HOPS, missingParentIds, spliceAncestors } from './chat-list-lineage';

type Row = { id: string; parentChatId?: string | null; displayParentChatId?: string | null; title?: string };
const r = (id: string, parentChatId?: string | null): Row => ({ id, parentChatId: parentChatId ?? null });
/** A machine-spawned lane: real parent (maybe none) + the folder supervisor as display parent. */
const d = (id: string, parentChatId: string | null, displayParentChatId: string): Row => ({ id, parentChatId, displayParentChatId });
const ids = (rows: Row[]) => rows.map((x) => x.id);

describe('missingParentIds', () => {
  it('returns parent ids the page does not carry, deduped, in input order', () => {
    const page = [r('c1', 'p1'), r('c2', 'p1'), r('c3', 'p2'), r('p2'), r('x')];
    expect(missingParentIds(page, new Set(ids(page)))).toEqual(['p1']);
  });

  it('is empty when every referenced parent is known', () => {
    const page = [r('p'), r('c', 'p')];
    expect(missingParentIds(page, new Set(ids(page)))).toEqual([]);
  });

  it('honours the known set the caller grows between hops', () => {
    const fetched = [r('p1', 'g1')];
    expect(missingParentIds(fetched, new Set(['c1', 'p1']))).toEqual(['g1']);
    expect(missingParentIds(fetched, new Set(['c1', 'p1', 'g1']))).toEqual([]);
  });
});

describe('spliceAncestors', () => {
  it('inserts a fetched parent right BEFORE its first child, keeping the page order otherwise', () => {
    const page = [r('c1', 'p1'), r('x'), r('c2', 'p1')];
    expect(ids(spliceAncestors(page, [r('p1')]))).toEqual(['p1', 'c1', 'x', 'c2']);
  });

  it('emits grandparent → parent → child when two hops were fetched', () => {
    const page = [r('c', 'p')];
    expect(ids(spliceAncestors(page, [r('p', 'g'), r('g')]))).toEqual(['g', 'p', 'c']);
  });

  it('never duplicates an ancestor already on the page and returns a copy when nothing was fetched', () => {
    const page = [r('p'), r('c', 'p')];
    const out = spliceAncestors(page, [r('p')]);
    expect(ids(out)).toEqual(['p', 'c']);
    const copy = spliceAncestors(page, []);
    expect(copy).toEqual(page);
    expect(copy).not.toBe(page);
  });

  it('stops the walk at a parent the page already carries (no re-emit) and appends an unreferenced ancestor defensively', () => {
    const page = [r('p'), r('c', 'p')];
    expect(ids(spliceAncestors(page, [r('stray')]))).toEqual(['p', 'c', 'stray']);
  });

  it('is cycle-safe on the soft-ref column', () => {
    const page = [r('a', 'b')];
    expect(ids(spliceAncestors(page, [r('b', 'a')]))).toEqual(['b', 'a']);
  });
});

// Display parents (2026-10-21, platform/display-parent.ts): the folder's Project
// Supervisor is completed onto a page carrying a parentless ticket lane exactly
// like a real parent, and the real parent wins the splice when it was fetched.
describe('display parents (2026-10-21)', () => {
  it('a display parent the page does not carry is a missing id (after the row\'s real parent, deduped)', () => {
    const page = [d('lane1', null, 'ps'), d('lane2', null, 'ps'), d('fleet-lane', 'fs', 'ps')];
    expect(missingParentIds(page, new Set(ids(page)))).toEqual(['ps', 'fs']);
  });

  it('a display parent is still collected when the real parent is on the page (the client may hide that parent)', () => {
    const page = [r('fs'), d('fleet-lane', 'fs', 'ps')];
    expect(missingParentIds(page, new Set(ids(page)))).toEqual(['ps']);
  });

  it('is empty when the display parent is already on the page', () => {
    const page = [r('ps'), d('lane', null, 'ps')];
    expect(missingParentIds(page, new Set(ids(page)))).toEqual([]);
  });

  it('splices a fetched display parent right before its first lane', () => {
    const page = [r('x'), d('lane1', null, 'ps'), d('lane2', null, 'ps')];
    expect(ids(spliceAncestors(page, [r('ps')]))).toEqual(['x', 'ps', 'lane1', 'lane2']);
  });

  it('the real parent wins the walk when it was fetched; the display parent is not emitted before the child', () => {
    // child of a lane: parent 'lane' and display 'ps' both fetched — the chain is lane → (lane's own display) ps.
    const page = [d('child', 'lane', 'ps')];
    expect(ids(spliceAncestors(page, [d('lane', null, 'ps'), r('ps')]))).toEqual(['ps', 'lane', 'child']);
    // only the real parent fetched (ps unknown) — the display parent never appears.
    expect(ids(spliceAncestors(page, [r('lane')]))).toEqual(['lane', 'child']);
  });

  it('falls back to the display parent when the real parent is not a fetched ancestor (e.g. on the page)', () => {
    const page = [r('fs'), d('fleet-lane', 'fs', 'ps')];
    expect(ids(spliceAncestors(page, [r('ps')]))).toEqual(['fs', 'ps', 'fleet-lane']);
  });

  it('a display-parent cycle on the soft-ref column stays safe', () => {
    const page = [d('a', null, 'b')];
    expect(ids(spliceAncestors(page, [d('b', null, 'a')]))).toEqual(['b', 'a']);
  });
});

describe('hop bound', () => {
  it('the hop bound is two (child → parent → grandparent)', () => {
    expect(CHAT_LIST_ANCESTOR_HOPS).toBe(2);
  });
});

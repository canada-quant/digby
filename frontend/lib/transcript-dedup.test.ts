/**
 * dedupById (P2 item 5) — render-side id-safety for the converged transcript:
 * the SAME message id never renders twice; DISTINCT ids always do (genuine
 * duplicate DB rows are real rows and stay).
 */

import { describe, expect, it } from 'vitest';
import { dedupById } from './transcript-dedup';

const m = (id: string, content = '') => ({ id, content });

describe('dedupById (P2 item 5)', () => {
  it('the same id never renders twice — first occurrence keeps its slot', () => {
    const rows = [m('a', 'one'), m('b'), m('a', 'dupe'), m('c'), m('b', 'dupe2')];
    const out = dedupById(rows);
    expect(out.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(out[0].content).toBe('one');
  });

  it('distinct ids ALWAYS pass — identical content is not grounds for dropping (real DB rows stay)', () => {
    const rows = [m('p1', 'PONG'), m('p2', 'PONG')];
    expect(dedupById(rows)).toHaveLength(2);
  });

  it('identity-preserving when there is nothing to drop (no re-render churn)', () => {
    const rows = [m('a'), m('b'), m('c')];
    expect(dedupById(rows)).toBe(rows);
    const empty: Array<{ id: string }> = [];
    expect(dedupById(empty)).toBe(empty);
  });

  it('collapses a triple collision to one row', () => {
    expect(dedupById([m('x'), m('x'), m('x')])).toHaveLength(1);
  });
});

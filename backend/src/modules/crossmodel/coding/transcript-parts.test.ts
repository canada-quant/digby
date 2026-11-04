/**
 * transcript-parts — the executor/live-view mirror helpers for discarded and
 * rejected drafts (owner transcript 2026-09-08). The frontend copy
 * (frontend/lib/transcript-parts.ts) pins the same cases under vitest.
 */
import { trimTrailingText, appendGuardMarker, isDeliveredTextPart, upsertTaskPart, isTaskPart, TASK_PART_TYPE, type TranscriptPartLike } from './transcript-parts';

const t = (text: string, extra: Record<string, unknown> = {}): TranscriptPartLike => ({ type: 'text', text, ...extra });
const r = (text: string): TranscriptPartLike => ({ type: 'reasoning', text });
const tool = (): TranscriptPartLike => ({ type: 'tool_call', name: 'run_command', args: {} });

describe('trimTrailingText (draft_discarded)', () => {
  it('removes exactly the streamed draft from a single trailing text part', () => {
    const parts = [tool(), t('earlier answer. ' + 'FABRICATED DRAFT')];
    expect(trimTrailingText(parts, 'FABRICATED DRAFT'.length)).toBe(16);
    expect(parts).toEqual([tool(), t('earlier answer. ')]);
  });

  it('removes a whole trailing part when the draft is exactly its text', () => {
    const parts = [tool(), t('FABRICATED DRAFT')];
    expect(trimTrailingText(parts, 16)).toBe(16);
    expect(parts).toEqual([tool()]);
  });

  it('walks back over interleaved reasoning parts and across text fragments', () => {
    const parts = [tool(), t('AB'), r('thinking…'), t('CD'), r('more'), t('EF')];
    expect(trimTrailingText(parts, 5)).toBe(5); // EF, CD, and the B of AB
    expect(parts).toEqual([tool(), t('A'), r('thinking…'), r('more')]);
  });

  it('stops at a tool boundary — text before the last tool result is never the discarded turn', () => {
    const parts = [t('older prose'), tool(), t('short')];
    expect(trimTrailingText(parts, 500)).toBe(5);
    expect(parts).toEqual([t('older prose'), tool()]);
  });

  it('stops at a harness marker part', () => {
    const parts = [t('draft one', { struck: true }), t('⚠︎ marker', { marker: 'guard' }), t('xyz')];
    expect(trimTrailingText(parts, 100)).toBe(3);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({ marker: 'guard' });
  });

  it('zero / negative / NaN budgets are no-ops', () => {
    const parts = [t('keep')];
    expect(trimTrailingText(parts, 0)).toBe(0);
    expect(trimTrailingText(parts, -4)).toBe(0);
    expect(trimTrailingText(parts, Number.NaN)).toBe(0);
    expect(parts).toEqual([t('keep')]);
  });
});

describe('appendGuardMarker (guard_marker)', () => {
  it('strikes the preceding text part and appends the marker as its own part', () => {
    const parts = [tool(), t('rejected draft')];
    appendGuardMarker(parts, '⚠︎ rejected', true);
    expect(parts).toEqual([tool(), t('rejected draft', { struck: true }), t('⚠︎ rejected', { marker: 'guard' })]);
  });

  it('skips reasoning parts to find the draft, but never strikes past a tool boundary', () => {
    const a = [t('draft'), r('thought')];
    appendGuardMarker(a, 'm', true);
    expect(a[0]).toMatchObject({ struck: true });
    const b = [t('older'), tool()];
    appendGuardMarker(b, 'm', true);
    expect(b[0]).not.toHaveProperty('struck');
  });

  it('strikes EVERY text fragment of the rejected turn when reasoning interleaved (T/R/T/R/T), stopping at the tool boundary and at an earlier marker', () => {
    const parts = [t('older, accepted'), tool(), t('frag A'), r('think'), t('frag B'), r('more'), t('frag C')];
    appendGuardMarker(parts, '⚠︎ rejected', true);
    expect(parts.filter((p) => p.struck).map((p) => p.text)).toEqual(['frag A', 'frag B', 'frag C']);
    expect(parts[0]).not.toHaveProperty('struck');
    const withMarker = [t('draft one', { struck: true }), t('⚠︎ m1', { marker: 'guard' }), t('draft two')];
    appendGuardMarker(withMarker, '⚠︎ m2', true);
    expect(withMarker.map((p) => !!p.struck)).toEqual([true, false, true, false]);
  });

  it('struckPrev=false only appends', () => {
    const parts = [t('kept')];
    appendGuardMarker(parts, 'm', false);
    expect(parts).toEqual([t('kept'), t('m', { marker: 'guard' })]);
  });
});

describe('isDeliveredTextPart', () => {
  it('excludes markers, struck drafts, and non-text parts', () => {
    expect(isDeliveredTextPart(t('ok'))).toBe(true);
    expect(isDeliveredTextPart(t('m', { marker: 'guard' }))).toBe(false);
    expect(isDeliveredTextPart(t('d', { struck: true }))).toBe(false);
    expect(isDeliveredTextPart(r('x'))).toBe(false);
    expect(isDeliveredTextPart(null)).toBe(false);
  });
});

// ── Inline task card (cohesive chat, 2026-09-28) — mirrored in the frontend
// suite as upsertTaskPartParts (immutable). ONE card per taskId.
const task = (taskId: string, status = 'running'): { taskId: string; status: string } => ({ taskId, status });

describe('upsertTaskPart (task event → ONE task part per taskId)', () => {
  it('appends a new task part at the tail and returns its index', () => {
    const parts = [t('answer'), tool()];
    expect(upsertTaskPart(parts, task('a'))).toBe(2);
    expect(parts).toHaveLength(3);
    expect(parts[2]).toEqual({ type: TASK_PART_TYPE, task: task('a') });
    expect(isTaskPart(parts[2])).toBe(true);
  });

  it('replaces the existing card IN PLACE on update — never a second card', () => {
    const parts = [t('answer'), { type: TASK_PART_TYPE, task: task('a') } as TranscriptPartLike, t('tail')];
    expect(upsertTaskPart(parts, task('a', 'done'))).toBe(1);
    expect(parts.map(p => p.type)).toEqual(['text', TASK_PART_TYPE, 'text']);
    expect((parts[1].task as any).status).toBe('done');
  });

  it('keeps different tasks as separate cards and ignores a payload without a taskId', () => {
    const parts: TranscriptPartLike[] = [];
    upsertTaskPart(parts, task('a'));
    upsertTaskPart(parts, task('b'));
    expect(parts).toHaveLength(2);
    expect(upsertTaskPart(parts, { taskId: '' })).toBe(-1);
    expect(parts).toHaveLength(2);
  });

  it('isTaskPart is false for prose, tools and a task part without an id', () => {
    expect(isTaskPart(t('x'))).toBe(false);
    expect(isTaskPart(tool())).toBe(false);
    expect(isTaskPart({ type: TASK_PART_TYPE, task: {} })).toBe(false);
    expect(isTaskPart(null)).toBe(false);
  });
});

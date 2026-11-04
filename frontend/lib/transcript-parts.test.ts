import { describe, it, expect } from 'vitest';
import { trimTrailingTextParts, appendGuardMarkerParts, upsertTaskPartParts } from './transcript-parts';
import type { MessagePart } from './api/coding';
import type { TaskEventPayload } from './task-card';

const t = (text: string, extra: Record<string, unknown> = {}): MessagePart => ({ type: 'text', text, ...extra } as MessagePart);
const r = (text: string): MessagePart => ({ type: 'reasoning', text } as MessagePart);
const tool = (): MessagePart => ({ type: 'tool_call', name: 'run_command', args: {} } as MessagePart);

// Mirror of backend coding/transcript-parts.test.ts — same cases, immutable API.
describe('trimTrailingTextParts (draft_discarded)', () => {
  it('removes exactly the streamed draft from a single trailing text part, without mutating the input', () => {
    const input = [tool(), t('earlier answer. FABRICATED DRAFT')];
    const out = trimTrailingTextParts(input, 'FABRICATED DRAFT'.length);
    expect(out).toEqual([tool(), t('earlier answer. ')]);
    expect(input[1].text).toBe('earlier answer. FABRICATED DRAFT');
  });

  it('drops a trailing part the draft fills entirely', () => {
    expect(trimTrailingTextParts([tool(), t('FABRICATED DRAFT')], 16)).toEqual([tool()]);
  });

  it('walks back over interleaved reasoning parts and across text fragments', () => {
    const out = trimTrailingTextParts([tool(), t('AB'), r('thinking…'), t('CD'), r('more'), t('EF')], 5);
    expect(out).toEqual([tool(), t('A'), r('thinking…'), r('more')]);
  });

  it('stops at a tool boundary and at a harness marker', () => {
    expect(trimTrailingTextParts([t('older prose'), tool(), t('short')], 500)).toEqual([t('older prose'), tool()]);
    const out = trimTrailingTextParts([t('draft one', { struck: true }), t('⚠︎ marker', { marker: 'guard' }), t('xyz')], 100);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ marker: 'guard' });
  });

  it('zero / NaN budgets return the same array', () => {
    const input = [t('keep')];
    expect(trimTrailingTextParts(input, 0)).toBe(input);
    expect(trimTrailingTextParts(input, Number.NaN)).toBe(input);
  });
});

describe('appendGuardMarkerParts (guard_marker)', () => {
  it('strikes the preceding text part (new object) and appends a stamped marker part', () => {
    const input = [tool(), t('rejected draft')];
    const out = appendGuardMarkerParts(input, '⚠︎ rejected', true, (p) => ({ ...p, uid: 'p1' } as MessagePart));
    expect(out).toEqual([tool(), t('rejected draft', { struck: true }), t('⚠︎ rejected', { marker: 'guard', uid: 'p1' })]);
    expect(input[1]).not.toHaveProperty('struck');
  });

  it('skips reasoning to find the draft but never strikes past a tool boundary', () => {
    expect(appendGuardMarkerParts([t('draft'), r('thought')], 'm', true)[0]).toMatchObject({ struck: true });
    expect(appendGuardMarkerParts([t('older'), tool()], 'm', true)[0]).not.toHaveProperty('struck');
  });

  it('strikes EVERY text fragment of the rejected turn when reasoning interleaved (T/R/T/R/T), stopping at the tool boundary and at an earlier marker', () => {
    const out = appendGuardMarkerParts([t('older, accepted'), tool(), t('frag A'), r('think'), t('frag B'), r('more'), t('frag C')], '⚠︎ rejected', true);
    expect(out.filter((p) => p.struck).map((p) => p.text)).toEqual(['frag A', 'frag B', 'frag C']);
    expect(out[0]).not.toHaveProperty('struck');
    const withMarker = appendGuardMarkerParts([t('draft one', { struck: true }), t('⚠︎ m1', { marker: 'guard' }), t('draft two')], '⚠︎ m2', true);
    expect(withMarker.map((p) => !!p.struck)).toEqual([true, false, true, false]);
  });

  it('struckPrev=false only appends', () => {
    expect(appendGuardMarkerParts([t('kept')], 'm', false)).toEqual([t('kept'), t('m', { marker: 'guard' })]);
  });
});

// Inline task card (cohesive chat, 2026-09-28) — mirror of the backend's
// upsertTaskPart cases (coding/transcript-parts.test.ts), immutable API.
describe('upsertTaskPartParts (task event → ONE task part per taskId)', () => {
  const task = (taskId: string, status: TaskEventPayload['status'] = 'running'): TaskEventPayload => ({
    taskId, chatId: 'chat-1', kind: 'session', status, title: 'T', steps: { done: 0, total: 0 }, receipts: { ok: 0, total: 0 },
    spendUsd: 0, startedAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:00:00.000Z', artifacts: [],
  });

  it('appends a new task part at the tail without mutating the input', () => {
    const input = [t('answer'), tool()];
    const out = upsertTaskPartParts(input, task('a'));
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ type: 'task', task: task('a') });
    expect(input).toHaveLength(2);
  });

  it('replaces the existing card IN PLACE on update — never a second card', () => {
    const input: MessagePart[] = [t('answer'), { type: 'task', task: task('a') } as MessagePart, t('tail')];
    const out = upsertTaskPartParts(input, task('a', 'done'));
    expect(out.map(p => p.type)).toEqual(['text', 'task', 'text']);
    expect((out[1].task as any).status).toBe('done');
    expect((input[1].task as any).status).toBe('running');
  });

  it('keeps different tasks as separate cards and ignores a payload without a taskId', () => {
    let parts: MessagePart[] = [];
    parts = upsertTaskPartParts(parts, task('a'));
    parts = upsertTaskPartParts(parts, task('b'));
    expect(parts).toHaveLength(2);
    expect(upsertTaskPartParts(parts, task(''))).toBe(parts);
  });
});

/**
 * Hand-off × child-result wake decision (cohesive chat live fixes, 2026-09-28
 * — platform/handoff-parent-wake.ts). Pure pins: a HUMAN-owned non-supervisor
 * parent's run_completed rows are skipped only when the hand-off POSTED (the
 * summary note or the store record); a run_failed row is skipped only when the
 * hand-off is enabled AND the card flipped; supervisor targets, wildcard /
 * self hooks, attention_needed rows, an un-posted completion and a chat with
 * no card to flip all deliver as before; probe errors deliver (fail-open).
 */

import {
  decideHandoffParentWake,
  rowCarriesHandoffNote,
  rowRunId,
  HOOK_STATUS_HANDOFF_POSTED,
  HANDOFF_POSTED_MARKER,
  type HandoffWakeRow,
} from './handoff-parent-wake';

const hook = { id: 'h1', sourceChatId: 'child-1', targetChatId: 'parent-1' };
const human = { isSupervisor: false, isProjectSupervisor: false };
const completed = (over: Partial<HandoffWakeRow> & { payload?: any } = {}): HandoffWakeRow => ({
  id: 'e1', eventType: 'run_completed',
  payload: { summary: `Coding run completed.\n\n${HANDOFF_POSTED_MARKER} on chat parent-1 (message m1): deck.pdf.]`, runId: 'run-1' },
  ...over,
});
const failed = (over: Partial<HandoffWakeRow> & { payload?: any } = {}): HandoffWakeRow => ({
  id: 'e2', eventType: 'run_failed', payload: { summary: 'Coding run FAILED: provider 502', runId: 'run-2', sourceChatTitle: 'Deck' }, ...over,
});

function decide(over: Partial<Parameters<typeof decideHandoffParentWake>[0]> = {}) {
  const flips: HandoffWakeRow[] = [];
  const p = decideHandoffParentWake({
    hook, target: human, rows: [completed()],
    hasRecord: async () => false,
    flipFailedCard: async (row) => { flips.push(row); return true; },
    ...over,
  });
  return Object.assign(p, { flips });
}

describe('decideHandoffParentWake', () => {
  it('constants: the terminal status + the note marker the hand-off appends', () => {
    expect(HOOK_STATUS_HANDOFF_POSTED).toBe('skipped:handoff_posted');
    expect(rowCarriesHandoffNote(completed())).toBe(true);
    expect(rowCarriesHandoffNote(completed({ payload: { summary: 'plain' } }))).toBe(false);
    expect(rowRunId(completed())).toBe('run-1');
    expect(rowRunId(completed({ payload: { summary: 'x' } }))).toBeNull();
  });

  it('a posted completion for a human plain-chat parent is SKIPPED (note in the summary)', async () => {
    await expect(decide()).resolves.toMatchObject({ skip: true, reason: 'handoff_posted', failedRows: [] });
  });

  it('a completion without the note is skipped only when the hand-off RECORD exists for the runId', async () => {
    const row = completed({ payload: { summary: 'Coding run completed.', runId: 'run-9' } });
    const seen: string[] = [];
    await expect(decide({ rows: [row], hasRecord: async (c, r) => { seen.push(`${c}/${r}`); return true; } })).resolves.toMatchObject({ skip: true, reason: 'handoff_posted' });
    expect(seen).toEqual(['child-1/run-9']);
    await expect(decide({ rows: [row], hasRecord: async () => false })).resolves.toMatchObject({ skip: false, reason: 'not_posted' });
    // no runId at all → nothing to look up → deliver
    await expect(decide({ rows: [completed({ payload: { summary: 'Coding run completed.' } })] })).resolves.toMatchObject({ skip: false, reason: 'not_posted' });
  });

  it('a run_failed row: skipped when the parent card flipped to failed; delivers when no card could be flipped', async () => {
    const d = decide({ rows: [failed()] });
    await expect(d).resolves.toMatchObject({ skip: true, reason: 'failed_card_flipped', failedRows: [expect.objectContaining({ id: 'e2' })] });
    expect(d.flips).toHaveLength(1);
    await expect(decide({ rows: [failed()], flipFailedCard: async () => false })).resolves.toMatchObject({ skip: false, reason: 'failed_no_card' });
  });

  it('a mixed posted-completion + failed batch skips as handoff_posted and flips the failed card', async () => {
    const d = decide({ rows: [completed(), failed()] });
    await expect(d).resolves.toMatchObject({ skip: true, reason: 'handoff_posted' });
    expect(d.flips).toHaveLength(1);
  });

  it('never skips: a supervisor target, a wildcard or self hook, an empty batch, or an attention_needed row (the child needs the user)', async () => {
    await expect(decide({ target: { isSupervisor: true } })).resolves.toMatchObject({ skip: false, reason: 'supervisor_target' });
    await expect(decide({ target: { isProjectSupervisor: true } })).resolves.toMatchObject({ skip: false, reason: 'supervisor_target' });
    await expect(decide({ target: null })).resolves.toMatchObject({ skip: false, reason: 'supervisor_target' });
    await expect(decide({ hook: { ...hook, sourceChatId: null } })).resolves.toMatchObject({ skip: false, reason: 'not_child_hook' });
    await expect(decide({ hook: { ...hook, sourceChatId: 'parent-1' } })).resolves.toMatchObject({ skip: false, reason: 'not_child_hook' });
    await expect(decide({ rows: [] })).resolves.toMatchObject({ skip: false, reason: 'no_rows' });
    await expect(decide({ rows: [completed(), { id: 'e3', eventType: 'attention_needed', payload: { summary: 'needs you' } }] })).resolves.toMatchObject({ skip: false, reason: 'other_events' });
  });

  it('a probe that throws delivers (fail-open)', async () => {
    await expect(decide({ rows: [completed({ payload: { summary: 'done', runId: 'r' } })], hasRecord: async () => { throw new Error('store down'); } })).resolves.toMatchObject({ skip: false });
    await expect(decide({ rows: [failed()], flipFailedCard: async () => { throw new Error('db down'); } })).resolves.toMatchObject({ skip: false });
  });
});

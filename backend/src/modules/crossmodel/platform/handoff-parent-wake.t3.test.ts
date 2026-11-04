/**
 * audit 2026-10-06 T3-4 (stanne #9 — double supervision): a HUMAN-owned plain
 * parent is not machine-woken for a child run_completed the hand-off did NOT
 * post when an enabled project-supervisor hook covers the child (the project
 * supervisor owns the lane). Pure pins on decideHandoffParentWake + the kill
 * switch HANDOFF_PS_COVERED_SKIP_DISABLED=1.
 */

import {
  decideHandoffParentWake,
  HOOK_STATUS_PS_COVERS_CHILD,
  type HandoffWakeRow,
} from './handoff-parent-wake';

const hook = { id: 'h1', sourceChatId: 'child-1', targetChatId: 'parent-1' };
const human = { isSupervisor: false, isProjectSupervisor: false };
const unposted = (id = 'e1'): HandoffWakeRow => ({ id, eventType: 'run_completed', payload: { summary: 'Coding run completed. Go files edited.', runId: `run-${id}` } });

function decide(over: Partial<Parameters<typeof decideHandoffParentWake>[0]> = {}) {
  return decideHandoffParentWake({
    hook, target: human, rows: [unposted()],
    hasRecord: async () => false,
    flipFailedCard: async () => true,
    ...over,
  });
}

afterEach(() => { delete process.env.HANDOFF_PS_COVERED_SKIP_DISABLED; });

describe('T3-4 — un-posted child result + project-supervisor coverage', () => {
  it('an un-posted completion is SKIPPED (ps_covers_child) when a project supervisor covers the child; the probe is asked once per batch', async () => {
    const probe = jest.fn(async () => true);
    await expect(decide({ rows: [unposted('a'), unposted('b')], psCoversChild: probe }))
      .resolves.toMatchObject({ skip: true, reason: 'ps_covers_child' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('child-1');
    expect(HOOK_STATUS_PS_COVERS_CHILD).toBe('skipped:ps_covers_child');
  });

  it('no coverage (or no probe) keeps today\'s wake (not_posted); a probe error fails open', async () => {
    await expect(decide({ psCoversChild: async () => false })).resolves.toMatchObject({ skip: false, reason: 'not_posted' });
    await expect(decide()).resolves.toMatchObject({ skip: false, reason: 'not_posted' });
    await expect(decide({ psCoversChild: async () => { throw new Error('db'); } })).resolves.toMatchObject({ skip: false, reason: 'not_posted' });
  });

  it('supervisor parents, attention_needed rows and the kill switch keep the wake', async () => {
    const probe = async () => true;
    await expect(decide({ target: { isProjectSupervisor: true }, psCoversChild: probe })).resolves.toMatchObject({ skip: false, reason: 'supervisor_target' });
    await expect(decide({ rows: [unposted(), { id: 'x', eventType: 'attention_needed', payload: {} }], psCoversChild: probe })).resolves.toMatchObject({ skip: false, reason: 'other_events' });
    process.env.HANDOFF_PS_COVERED_SKIP_DISABLED = '1';
    await expect(decide({ psCoversChild: probe })).resolves.toMatchObject({ skip: false, reason: 'not_posted' });
    delete process.env.HANDOFF_PS_COVERED_SKIP_DISABLED;
  });
});

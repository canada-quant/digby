/**
 * Child-result hook — ownership-moved retirement (ticket f8c62820;
 * platform/child-ownership-wake.ts). Pure pins, mirroring the
 * handoff-parent-wake pure test: the 2026-09-29 incident shape (an external
 * steer NEWER than the parent's last engagement → skip, every pending row
 * terminal-marked 'skipped:ownership_moved', reason names the taker-over);
 * identity BEFORE staleness (a parent steer — even at exactly parentLastAt —
 * still owns); an external steer at/before the parent's latest engagement is
 * stale (the self-heal arm); the child's own rows are never ownership
 * signals; no rows / no steers deliver; the kill switch parses 1|true|on.
 */

import {
  decideChildResultOwnershipWake,
  CHILD_OWNERSHIP_WAKE_SKIPPED,
  HOOK_STATUS_OWNERSHIP_MOVED,
  type ChildOwnershipWakeSteer,
} from './child-ownership-wake';

const HOOK = { id: 'h1', sourceChatId: 'child-1', targetChatId: 'parent-1', createdVia: 'system:child-result-hook' };
const T0 = new Date('2026-09-29T05:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const steer = (sourceChatId: string, createdAt: Date): ChildOwnershipWakeSteer => ({ sourceChatId, createdAt });
const rows = [{ id: 'e1' }, { id: 'e2' }];

const decide = (over: Partial<Parameters<typeof decideChildResultOwnershipWake>[0]> = {}) =>
  decideChildResultOwnershipWake({ hook: HOOK, rows, steers: [], parentLastAt: null, ...over });

describe('decideChildResultOwnershipWake (pure)', () => {
  it('constants: the terminal row status + the telemetry kind', () => {
    expect(HOOK_STATUS_OWNERSHIP_MOVED).toBe('skipped:ownership_moved');
    expect(CHILD_OWNERSHIP_WAKE_SKIPPED).toBe('child_ownership_wake_skipped');
  });

  it('no pending rows → wake (nothing to retire)', () => {
    expect(decide({ rows: [] })).toEqual({ action: 'wake', reason: 'no_pending_rows' });
  });

  it('the incident shape: an external steer NEWER than the parent\'s last engagement → skip + terminal-mark every row', () => {
    expect(decide({ steers: [steer('supervisor-9', at(30)), steer('parent-1', at(10))], parentLastAt: at(10) })).toEqual({
      action: 'skip',
      status: HOOK_STATUS_OWNERSHIP_MOVED,
      metricKind: CHILD_OWNERSHIP_WAKE_SKIPPED,
      reason: 'external_steer_supervisor-9',
      rowIds: ['e1', 'e2'],
    });
  });

  it('a parent steer at EXACTLY parentLastAt still owns (identity before staleness — the arm the staleness guard would otherwise shadow)', () => {
    expect(decide({ steers: [steer('parent-1', at(10))], parentLastAt: at(10) })).toEqual({ action: 'wake', reason: 'steer_from_parent' });
  });

  it('the parent\'s newest row ahead of an older external steer → wake (parent still owns)', () => {
    expect(decide({ steers: [steer('parent-1', at(40)), steer('supervisor-9', at(10))], parentLastAt: at(40) })).toEqual({ action: 'wake', reason: 'steer_from_parent' });
  });

  it('an external steer AT the parent\'s latest engagement is NOT newer → wake (self-heal arm)', () => {
    expect(decide({ steers: [steer('supervisor-9', at(10))], parentLastAt: at(10) })).toEqual({ action: 'wake', reason: 'steer_predates_parent' });
  });

  it('a parent that never engaged (parentLastAt null) + any external agent steer → ownership moved', () => {
    expect(decide({ steers: [steer('supervisor-9', at(30))], parentLastAt: null })).toMatchObject({ action: 'skip', reason: 'external_steer_supervisor-9', rowIds: ['e1', 'e2'] });
  });

  it('the child\'s own rows are never ownership signals (skipped in the scan, stales scanned past)', () => {
    expect(decide({ steers: [steer('child-1', at(99))], parentLastAt: null })).toEqual({ action: 'wake', reason: 'no_steer' });
    expect(decide({ steers: [steer('child-1', at(50)), steer('supervisor-9', at(5)), steer('parent-1', at(10))], parentLastAt: at(10) })).toEqual({ action: 'wake', reason: 'steer_from_parent' });
  });

  it('no steers at all → wake (reason names which arm held: parentLastAt present = steer_predates_parent, null = no_steer)', () => {
    expect(decide({ parentLastAt: at(10) })).toEqual({ action: 'wake', reason: 'steer_predates_parent' });
    expect(decide()).toEqual({ action: 'wake', reason: 'no_steer' });
  });
});

/**
 * Supervisor OFF switch (owner 2026-09-26) — the pure presentation helpers the
 * Admin "Supervisors" panel and the Management Status card render from.
 */
import { describe, it, expect } from 'vitest';
import type { SupervisorSwitchState, SupervisorSwitchTargetState } from '@/lib/api/fleet';
import {
  describeSwitchTarget, formatSwitchSince, totalSkipped, anySwitchOff, confirmOffCopy,
  SUPERVISOR_OFF_FACTS, SUPERVISOR_SWITCH_LABEL, FLEET_SUPERVISOR_ENABLED_KEY, PROJECT_SUPERVISORS_ENABLED_KEY,
} from './supervisor-switch';

const t = (over: Partial<SupervisorSwitchTargetState> = {}): SupervisorSwitchTargetState => ({
  target: 'fleet', key: FLEET_SUPERVISOR_ENABLED_KEY, enabled: true, since: null, updatedBy: null, skipped: 0,
  source: 'env', bootDefault: true, envVar: 'FLEET_SUPERVISOR_ENABLED', ...over,
});
const state = (fleet: Partial<SupervisorSwitchTargetState>, project: Partial<SupervisorSwitchTargetState> = {}): SupervisorSwitchState => ({
  fleet: t(fleet),
  project: t({ target: 'project', key: PROJECT_SUPERVISORS_ENABLED_KEY, envVar: 'PROJECT_SUPERVISORS_ENABLED', ...project }),
  line: null,
});

describe('supervisor-switch helpers', () => {
  it('keys + labels mirror the backend SystemSettings', () => {
    expect(FLEET_SUPERVISOR_ENABLED_KEY).toBe('fleet_supervisor_enabled');
    expect(PROJECT_SUPERVISORS_ENABLED_KEY).toBe('project_supervisors_enabled');
    expect(SUPERVISOR_SWITCH_LABEL).toEqual({ fleet: 'Fleet supervisor', project: 'Project supervisors' });
  });

  it('formatSwitchSince renders "YYYY-MM-DD HH:MMZ" and is null-safe', () => {
    expect(formatSwitchSince('2026-09-26T17:30:12.000Z')).toBe('2026-09-26 17:30Z');
    expect(formatSwitchSince(null)).toBeNull();
    expect(formatSwitchSince('nope')).toBeNull();
  });

  it('describeSwitchTarget: OFF carries since / by / skipped (n/a when unreadable; boot/env when never set); ON says since or default', () => {
    expect(describeSwitchTarget(t({ enabled: false, since: '2026-09-26T17:30:00Z', updatedBy: 'paul@sunday.market', skipped: 7, source: 'setting' })))
      .toBe('OFF since 2026-09-26 17:30Z by paul@sunday.market — wakes skipped: 7');
    expect(describeSwitchTarget(t({ enabled: false, skipped: null }))).toBe('OFF since boot (env FLEET_SUPERVISOR_ENABLED) — wakes skipped: n/a');
    expect(describeSwitchTarget(t({ enabled: true, since: '2026-09-26T18:00:00Z', updatedBy: 'admin@example.com', source: 'setting' }))).toBe('ON since 2026-09-26 18:00Z by admin@example.com');
    expect(describeSwitchTarget(t())).toBe('ON (default, env FLEET_SUPERVISOR_ENABLED)');
  });

  it('totalSkipped sums OFF counters (0 when nothing is off, null when every OFF counter is unreadable); anySwitchOff', () => {
    expect(totalSkipped(null)).toBeNull();
    expect(totalSkipped(state({}))).toBe(0);
    expect(totalSkipped(state({ enabled: false, skipped: 3 }, { enabled: false, skipped: 4 }))).toBe(7);
    expect(totalSkipped(state({ enabled: false, skipped: null }))).toBeNull();
    expect(totalSkipped(state({ enabled: false, skipped: null }, { enabled: false, skipped: 2 }))).toBe(2);
    expect(anySwitchOff(null)).toBe(false);
    expect(anySwitchOff(state({}))).toBe(false);
    expect(anySwitchOff(state({}, { enabled: false }))).toBe(true);
  });

  it('the OFF facts + confirm copy state no-replay, in-flight finishes, lanes unaffected, admin-only', () => {
    const facts = SUPERVISOR_OFF_FACTS.join(' ');
    expect(facts).toContain('never');
    expect(facts).toContain('Nothing skipped is replayed');
    expect(facts).toContain('in flight is never killed');
    expect(facts).toContain('lanes, coding sessions and normal chats are unaffected');
    expect(facts).toContain('Turn it back on to resume');
    expect(facts).toContain('cannot re-enable itself');
    expect(confirmOffCopy('fleet').title).toBe('Turn fleet supervisor off?');
    expect(confirmOffCopy('fleet').body).toContain('counted, never replayed');
    expect(confirmOffCopy('project').title).toBe('Turn project supervisors off?');
    expect(confirmOffCopy('project').body).toContain('none is scaffolded while off');
  });
});

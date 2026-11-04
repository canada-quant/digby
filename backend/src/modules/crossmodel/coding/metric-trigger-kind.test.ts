/**
 * audit 2026-10-06 T8-11 (stanne P3): a delegate worker's loop_metrics stamp inherits the parent run's
 * triggerKind (the spread strips machineTriggered / evidenceGuardRejectBack for posture, which made every
 * worker row 'user'). Telemetry only. SUBAGENT_TRIGGER_KIND_INHERIT_DISABLED=1 restores 'user'.
 */
import { metricTriggerKindFor, subagentTriggerKindInheritDisabled } from './metric-trigger-kind';

afterEach(() => { delete process.env.SUBAGENT_TRIGGER_KIND_INHERIT_DISABLED; });

describe('metricTriggerKindFor (audit 2026-10-06 T8-11)', () => {
  it('top-level runs are unchanged: the guard config wins, else machineTriggered → machine, else user', () => {
    expect(metricTriggerKindFor({ evidenceGuardRejectBack: { triggerKind: 'schedule' }, machineTriggered: true })).toBe('schedule');
    expect(metricTriggerKindFor({ machineTriggered: true })).toBe('machine');
    expect(metricTriggerKindFor({})).toBe('user');
  });

  it('a worker of a schedule-origin run (machineTriggered + guard config stripped) stamps the parent\'s kind', () => {
    expect(metricTriggerKindFor({ machineTriggered: undefined, evidenceGuardRejectBack: undefined, parentTriggerKind: 'schedule' })).toBe('schedule');
    expect(metricTriggerKindFor({ parentTriggerKind: 'hook' })).toBe('hook');
    expect(metricTriggerKindFor({ parentTriggerKind: 'user' })).toBe('user');
  });

  it('an empty / missing parent kind falls back as before', () => {
    expect(metricTriggerKindFor({ parentTriggerKind: '' })).toBe('user');
    expect(metricTriggerKindFor({ parentTriggerKind: null })).toBe('user');
  });

  it('SUBAGENT_TRIGGER_KIND_INHERIT_DISABLED=1: the worker stamps \'user\' again (previous behaviour)', () => {
    process.env.SUBAGENT_TRIGGER_KIND_INHERIT_DISABLED = '1';
    expect(subagentTriggerKindInheritDisabled()).toBe(true);
    expect(metricTriggerKindFor({ parentTriggerKind: 'schedule' })).toBe('user');
  });
});

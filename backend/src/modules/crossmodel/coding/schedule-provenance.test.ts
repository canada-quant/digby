/**
 * audit 2026-10-06 T4-5 — schedule provenance (coding/schedule-provenance.ts):
 * an arm is OWNER-authored only on a real user turn that is neither
 * machine-classified nor an owner-dispatch run, and not the card-free
 * work-tool path. Kill switch SCHEDULE_PROVENANCE_MACHINE_RUNS_DISABLED=1
 * restores the userTurnAt-only test (work-tool rule kept).
 */
import { scheduleArmOwnerAuthored } from './schedule-provenance';

describe('scheduleArmOwnerAuthored', () => {
  const at = new Date('2026-10-05T16:45:52Z');
  afterEach(() => { delete process.env.SCHEDULE_PROVENANCE_MACHINE_RUNS_DISABLED; });

  it('owner only on a plain user turn', () => {
    expect(scheduleArmOwnerAuthored({ userTurnAt: at })).toBe(true);
    expect(scheduleArmOwnerAuthored({})).toBe(false);
    expect(scheduleArmOwnerAuthored(null)).toBe(false);
  });

  it('owner-dispatch, machine-classified and work-tool-direct runs are machine', () => {
    expect(scheduleArmOwnerAuthored({ userTurnAt: at, ownerDispatch: true })).toBe(false);
    expect(scheduleArmOwnerAuthored({ userTurnAt: at, machineTriggered: true })).toBe(false);
    expect(scheduleArmOwnerAuthored({ userTurnAt: at, workToolDirect: true })).toBe(false);
  });

  it('kill switch restores the userTurnAt-only stamp (work-tool rule kept)', () => {
    process.env.SCHEDULE_PROVENANCE_MACHINE_RUNS_DISABLED = '1';
    expect(scheduleArmOwnerAuthored({ userTurnAt: at, ownerDispatch: true })).toBe(true);
    expect(scheduleArmOwnerAuthored({ userTurnAt: at, machineTriggered: true })).toBe(true);
    expect(scheduleArmOwnerAuthored({ userTurnAt: at, workToolDirect: true })).toBe(false);
  });
});

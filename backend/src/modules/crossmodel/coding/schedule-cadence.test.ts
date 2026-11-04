/**
 * wake-cadence (2026-09-27 tt-rd audit, sup/wake-cadence) — the PURE leaf.
 * Every helper here is deterministic and kill-switched; these tests pin the
 * math the fire path / create-update path / run-executor share.
 */
import {
  adaptiveCadenceOwnerRowsEnabled, supervisorReportUpIsAction,
  PROJECT_SWEEP_INTERVAL_SEC, FLEET_SWEEP_INTERVAL_SEC, PROJECT_SWEEP_MAX_INTERVAL_SEC, SWEEP_BACKOFF_NOOP_STREAK,
  stockSweepFloorSec, stockSweepFloorRefusal,
  medianMs, cadenceStretchFor, cadenceStretchStatus, cadenceStretchStateLine, cadenceStretchMaxSec, CADENCE_STRETCH_SAMPLE,
  scheduleNoopStreak, sweepBackoffFor,
  willAutoRenew, scheduleStateRenewClause, isFleetManagedCadence,
  CAP_HANDOFF_CLAUSE_RE, lintSchedulePrompt,
  busyRearmDelayMs, parkedMinutesWithBackoff, BUSY_REARM_BASE_MIN,
  busySteerDeltaBody, scheduleRunWrapupNote, RUN_WRAPUP_INTERVAL_FACTOR,
  latestIntervalAttribution, INTERVAL_ATTRIBUTION_OWNER_SOURCE, INTERVAL_ATTRIBUTION_MACHINE_SOURCE, projectSweepFloorHealOwnerRowsEnabled,
} from './schedule-cadence';
import { parkedMinutes, BUSY_REARM_MIN } from './firing-superseded-gate';
import { nearCapFractionFor, nearCapRunThreshold, scheduleNearCapCause, NEAR_CAP_FRACTION, NEAR_CAP_FRACTION_NO_RENEW } from './schedule-near-cap';

jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/decision-gate', () => ({ __esModule: true, decide: jest.fn(), decisionMode: jest.fn(), decisionThreshold: jest.fn(), recordDecisionOutcome: jest.fn(), stashDecision: jest.fn() }));
jest.mock('../platform/decision-outcome-labels', () => ({ __esModule: true, evidenceToolCallCount: jest.fn(() => 0), toolNamesCalled: jest.fn(() => []), tookPlatformAction: jest.fn(() => false) }));

const ENV_KEYS = [
  'SCHEDULE_ADAPTIVE_CADENCE_OWNER_ROWS', 'SCHEDULE_ADAPTIVE_CADENCE_MAX_SEC',
  'SUPERVISOR_REPORT_UP_IS_ACTION', 'PROJECT_SWEEP_FLOOR_HEAL_OWNER_ROWS',
  'FLEET_MANAGED_CADENCE_SCHEDULE_IDS', 'FLEET_MANAGED_CADENCE_DISABLED',
];
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
afterAll(() => { for (const k of ENV_KEYS) delete process.env[k]; });

describe('opt-in switches — default OFF (owner rows opt-in)', () => {
  it('defaults', () => {
    expect(adaptiveCadenceOwnerRowsEnabled()).toBe(false); // owner-set cadences are never silently overridden
    expect(supervisorReportUpIsAction()).toBe(false);
  });
  it('"true" / "on" flip each one', () => {
    process.env.SCHEDULE_ADAPTIVE_CADENCE_OWNER_ROWS = 'true';
    process.env.SUPERVISOR_REPORT_UP_IS_ACTION = 'on';
    expect(adaptiveCadenceOwnerRowsEnabled()).toBe(true);
    expect(supervisorReportUpIsAction()).toBe(true);
  });
});

describe('stock sweep cadences + floor (wake-cadence-3)', () => {
  it('the project sweep default is 2 h, the fleet sweep 2 h, the backoff ceiling 4 h', () => {
    expect(PROJECT_SWEEP_INTERVAL_SEC).toBe(7200);
    expect(FLEET_SWEEP_INTERVAL_SEC).toBe(7200);
    expect(PROJECT_SWEEP_MAX_INTERVAL_SEC).toBe(14400);
    expect(stockSweepFloorSec('project')).toBe(7200);
    expect(stockSweepFloorSec('fleet')).toBe(7200);
  });
  it('a MACHINE turn setting a stock sweep below its floor is refused with the reason; owner turns and non-stock rows pass', () => {
    const r = stockSweepFloorRefusal({ cls: 'project', machineActor: true, intervalSec: 1800 });
    expect(r).toMatch(/floored at 120 min/);
    expect(r).toMatch(/hook wakes you on events/);
    expect(stockSweepFloorRefusal({ cls: 'project', machineActor: false, intervalSec: 1800 })).toBeNull();
    expect(stockSweepFloorRefusal({ cls: null, machineActor: true, intervalSec: 900 })).toBeNull();
    expect(stockSweepFloorRefusal({ cls: 'project', machineActor: true, intervalSec: 7200 })).toBeNull();
    expect(stockSweepFloorRefusal({ cls: 'fleet', machineActor: true, intervalSec: 3600 })).toMatch(/fleet sweeps are floored/);
  });
});

describe('adaptive cadence stretch (wake-cadence-2)', () => {
  it('medianMs: odd/even lists, ignores non-positive, null on empty', () => {
    expect(medianMs([5, 1, 3])).toBe(3);
    expect(medianMs([4, 1, 3, 2])).toBe(3); // (2+3)/2 rounded
    expect(medianMs([0, -1, NaN])).toBeNull();
    expect(medianMs([])).toBeNull();
  });
  it('THE tt-rd shape: 30-min row, runs of ~65 min → doubled to 60 min, reason run_duration, median reported', () => {
    const s = cadenceStretchFor({ intervalSec: 1800, medianRunMs: 65 * 60_000, busySkips: 0, previousFiringSteered: false });
    expect(s).toEqual({ fromSec: 1800, toSec: 3600, reason: 'run_duration', medianRunMin: 65 });
    expect(cadenceStretchStatus(s!)).toBe('stretched:30m→60m');
    expect(cadenceStretchStateLine(s!)).toMatch(/cadence stretched 30→60 min by the harness: your last 5 runs took ~65 min/);
  });
  it('no stretch when the interval already covers 1.5× the median run', () => {
    expect(cadenceStretchFor({ intervalSec: 7200, medianRunMs: 60 * 60_000, busySkips: 0, previousFiringSteered: false })).toBeNull();
  });
  it('collision triggers without a median: the busy-skip CROSSING (=3) on THIS firing, or the previous firing steered — each at most once per episode', () => {
    expect(cadenceStretchFor({ intervalSec: 1800, medianRunMs: null, busySkips: 3, previousFiringSteered: false })).toMatchObject({ toSec: 3600, reason: 'busy_skips', medianRunMin: null });
    expect(cadenceStretchFor({ intervalSec: 1800, medianRunMs: null, busySkips: 2, previousFiringSteered: false })).toBeNull();
    // fixer 2026-09-27 (the ratchet finding): the busy trigger fires at the CROSSING only — the 4th, 5th… skip of
    // the same parked firing must not double the row again (30 → 60 → 120 → 240 → 360 min in 93 busy minutes).
    expect(cadenceStretchFor({ intervalSec: 3600, medianRunMs: null, busySkips: 4, previousFiringSteered: false })).toBeNull();
    expect(cadenceStretchFor({ intervalSec: 3600, medianRunMs: null, busySkips: 9, previousFiringSteered: false })).toBeNull();
    expect(cadenceStretchFor({ intervalSec: 1800, medianRunMs: null, busySkips: 0, previousFiringSteered: true })).toMatchObject({ toSec: 3600, reason: 'steered' });
    expect(cadenceStretchStateLine(cadenceStretchFor({ intervalSec: 1800, medianRunMs: null, busySkips: 0, previousFiringSteered: true })!)).toMatch(/steered into a still-running run/);
  });
  it('never shrinks, doubles per firing, and stops at the 6 h ceiling (env-tunable, ≥1 h)', () => {
    expect(cadenceStretchMaxSec()).toBe(6 * 3600);
    expect(cadenceStretchFor({ intervalSec: 4 * 3600, medianRunMs: 5 * 3600_000, busySkips: 0, previousFiringSteered: false })).toMatchObject({ toSec: 6 * 3600 });
    expect(cadenceStretchFor({ intervalSec: 6 * 3600, medianRunMs: 9 * 3600_000, busySkips: 5, previousFiringSteered: true })).toBeNull();
    process.env.SCHEDULE_ADAPTIVE_CADENCE_MAX_SEC = '3600';
    expect(cadenceStretchMaxSec()).toBe(3600);
    expect(cadenceStretchFor({ intervalSec: 1800, medianRunMs: 65 * 60_000, busySkips: 0, previousFiringSteered: false })).toMatchObject({ toSec: 3600 });
    process.env.SCHEDULE_ADAPTIVE_CADENCE_MAX_SEC = '10'; // below the 1 h clamp → default
    expect(cadenceStretchMaxSec()).toBe(6 * 3600);
  });
  it('garbage intervals never stretch', () => {
    expect(cadenceStretchFor({ intervalSec: 0, medianRunMs: 1, busySkips: 9, previousFiringSteered: true })).toBeNull();
    expect(cadenceStretchFor({ intervalSec: NaN, medianRunMs: 1, busySkips: 9, previousFiringSteered: true })).toBeNull();
  });
  it('CADENCE_STRETCH_SAMPLE is 5 (the audit\'s "last 5 completed runs")', () => {
    expect(CADENCE_STRETCH_SAMPLE).toBe(5);
  });
});

describe('project sweep backoff (wake-cadence-3)', () => {
  const T = (i: number) => new Date(Date.UTC(2026, 8, 27, 12, 0, i));
  it('scheduleNoopStreak counts consecutive newest schedule-origin no-ops; an action/note ends it; hook no-ops are skipped', () => {
    expect(scheduleNoopStreak([])).toBe(0);
    expect(scheduleNoopStreak([
      { kind: 'supervisor_noop', origin: 'schedule', createdAt: T(9) },
      { kind: 'supervisor_noop', origin: 'hook', createdAt: T(8) },
      { kind: 'supervisor_noop', origin: 'schedule', createdAt: T(7) },
      { kind: 'supervisor_noop', origin: 'schedule', createdAt: T(6) },
      { kind: 'supervisor_action', origin: 'schedule', createdAt: T(5) },
      { kind: 'supervisor_noop', origin: 'schedule', createdAt: T(4) },
    ])).toBe(3);
    expect(scheduleNoopStreak([{ kind: 'supervisor_note', origin: 'schedule', createdAt: T(1) }, { kind: 'supervisor_noop', origin: 'schedule', createdAt: T(0) }])).toBe(0);
    expect(scheduleNoopStreak([{ kind: 'supervisor_noop', origin: 'agent', createdAt: T(1) }])).toBe(0);
  });
  it('3 consecutive no-ops → 2 h doubles to 4 h; 6 → capped at the 4 h ceiling; below 3 nothing', () => {
    expect(sweepBackoffFor({ intervalSec: 7200, defaultSec: 7200, noopStreak: 2, ownerTurnSinceLastNote: false })).toBeNull();
    expect(sweepBackoffFor({ intervalSec: 7200, defaultSec: 7200, noopStreak: 3, ownerTurnSinceLastNote: false })).toEqual({ kind: 'backoff', fromSec: 7200, toSec: 14400, noopStreak: 3 });
    expect(sweepBackoffFor({ intervalSec: 14400, defaultSec: 7200, noopStreak: 6, ownerTurnSinceLastNote: false })).toBeNull(); // already at the ceiling
    expect(sweepBackoffFor({ intervalSec: 7200, defaultSec: 7200, noopStreak: 9, ownerTurnSinceLastNote: false })).toEqual({ kind: 'backoff', fromSec: 7200, toSec: 14400, noopStreak: 9 });
    expect(SWEEP_BACKOFF_NOOP_STREAK).toBe(3);
  });
  it('a streak of 0 (an action/note landed) or an owner turn RESETS a backed-off row to the default; a row at default is untouched', () => {
    expect(sweepBackoffFor({ intervalSec: 14400, defaultSec: 7200, noopStreak: 0, ownerTurnSinceLastNote: false })).toEqual({ kind: 'reset', fromSec: 14400, toSec: 7200, noopStreak: 0 });
    expect(sweepBackoffFor({ intervalSec: 14400, defaultSec: 7200, noopStreak: 5, ownerTurnSinceLastNote: true })).toEqual({ kind: 'reset', fromSec: 14400, toSec: 7200, noopStreak: 5 });
    expect(sweepBackoffFor({ intervalSec: 7200, defaultSec: 7200, noopStreak: 0, ownerTurnSinceLastNote: true })).toBeNull();
  });
  it('a row BELOW the default is never touched by the backoff (the floor heal owns it)', () => {
    expect(sweepBackoffFor({ intervalSec: 1800, defaultSec: 7200, noopStreak: 9, ownerTurnSinceLastNote: false })).toBeNull();
    expect(sweepBackoffFor({ intervalSec: 1800, defaultSec: 7200, noopStreak: 0, ownerTurnSinceLastNote: false })).toBeNull();
  });
});

describe('[SCHEDULE STATE] renewal clause (wake-cadence-4)', () => {
  it('willAutoRenew mirrors maybeRenewOnExhaustion: explicit flag wins, NULL derives TRUE only for machine/system authors', () => {
    expect(willAutoRenew({ promptSetBy: 'machine', renewOnExhaustion: null })).toBe(true);
    expect(willAutoRenew({ promptSetBy: 'system' })).toBe(true);
    expect(willAutoRenew({ promptSetBy: 'user', renewOnExhaustion: null })).toBe(false);
    expect(willAutoRenew({ promptSetBy: null })).toBe(false);
    expect(willAutoRenew({ promptSetBy: 'user', renewOnExhaustion: true })).toBe(true);
    expect(willAutoRenew({ promptSetBy: 'machine', renewOnExhaustion: false })).toBe(false);
  });
  it('the tt-rd row (machine, NULL, 500 cap) reads "auto-renews at cap … NEVER hand off"; an owner row reads "STOPS at cap"; uncapped/one-shot rows get nothing', () => {
    expect(scheduleStateRenewClause({ kind: 'recurring', maxRuns: 500, promptSetBy: 'machine', renewOnExhaustion: null })).toMatch(/^auto-renews at cap — a successor row arms itself; NEVER hand off/);
    const ownerClause = scheduleStateRenewClause({ kind: 'recurring', maxRuns: 500, promptSetBy: 'user', renewOnExhaustion: null })!;
    expect(ownerClause).toMatch(/^STOPS at cap \(owner-set\)/);
    // fixer 2026-09-27: the owner decides — a machine re-arm would be a self-renewing machine row that defeats the
    // owner's deliberate cap (project-supervisor rule 5); the clause must never instruct one.
    expect(ownerClause).toMatch(/the owner decides/);
    expect(ownerClause).toMatch(/do NOT re-arm a replacement/);
    expect(ownerClause).not.toMatch(/re-arm with schedule_message/);
    expect(scheduleStateRenewClause({ kind: 'recurring', maxRuns: null, promptSetBy: 'machine' })).toBeNull();
    expect(scheduleStateRenewClause({ kind: 'once', maxRuns: 1, promptSetBy: 'machine' })).toBeNull();
  });
  it('SS-1 fleet-managed marker: an owner-capped fleet-managed row gets the fleet-routed wording — no owner-decides restatement, no-rearm intact; auto-renew and uncapped rows are untouched', () => {
    const fleet = scheduleStateRenewClause({ kind: 'recurring', maxRuns: 500, promptSetBy: 'user', renewOnExhaustion: null, fleetManaged: true })!;
    expect(fleet).toMatch(/^STOPS at cap \(owner-set\) — cadence FLEET-MANAGED per Fleet Supervisor routing/);
    expect(fleet).not.toMatch(/the owner decides/);
    expect(fleet).toMatch(/route cadence concerns to the Fleet Supervisor/);
    expect(fleet).toMatch(/do NOT re-arm a replacement/);
    // fleetManaged never touches the auto-renew branch or uncapped rows.
    expect(scheduleStateRenewClause({ kind: 'recurring', maxRuns: 500, promptSetBy: 'machine', renewOnExhaustion: null, fleetManaged: true })).toMatch(/^auto-renews at cap/);
    expect(scheduleStateRenewClause({ kind: 'recurring', maxRuns: null, promptSetBy: 'user', fleetManaged: true })).toBeNull();
    // absent the flag the owner wording stands verbatim (M3).
    expect(scheduleStateRenewClause({ kind: 'recurring', maxRuns: 500, promptSetBy: 'user', renewOnExhaustion: null })).toMatch(/the owner decides/);
  });
  it('isFleetManagedCadence: env-list match by full id or >=8-char prefix; FLEET_MANAGED_CADENCE_DISABLED=1 wins', () => {
    expect(isFleetManagedCadence('d2b633c0-1111-2222-3333-444444444444')).toBe(false); // no env → false
    process.env.FLEET_MANAGED_CADENCE_SCHEDULE_IDS = ' 9aaaaaaa-full-id , d2b633c0 ';
    expect(isFleetManagedCadence('d2b633c0-1111-2222-3333-444444444444')).toBe(true); // prefix hit
    expect(isFleetManagedCadence('9aaaaaaa-full-id')).toBe(true); // exact hit
    expect(isFleetManagedCadence('d2b633c1-9999-8888-7777-666666666666')).toBe(false); // near-miss prefix
    expect(isFleetManagedCadence(null)).toBe(false);
    expect(isFleetManagedCadence('')).toBe(false);
    process.env.FLEET_MANAGED_CADENCE_DISABLED = '1';
    expect(isFleetManagedCadence('d2b633c0-1111-2222-3333-444444444444')).toBe(false); // kill switch
  });
});

// ── wake-cadence-3 (fixer 2026-09-27): interval attribution for the floor heal ──
describe('latestIntervalAttribution — who set a stock sweep\'s interval last', () => {
  const owner = { scheduleId: 's1', fields: ['intervalSec'], source: INTERVAL_ATTRIBUTION_OWNER_SOURCE, from: 7200, to: 1800 };
  const machine = { scheduleId: 's1', fields: ['intervalSec'], source: INTERVAL_ATTRIBUTION_MACHINE_SOURCE, from: 7200, to: 3600 };
  const toolAudit = { scheduleId: 's1', fields: ['intervalSec'] }; // platform.service's unattributed audit row (written after every update_schedule)
  const promptOnly = { scheduleId: 's1', fields: ['prompt'], source: INTERVAL_ATTRIBUTION_OWNER_SOURCE };
  it('the newest ATTRIBUTED intervalSec row decides; unattributed rows (the tool audit) and prompt-only rows are skipped', () => {
    expect(latestIntervalAttribution([toolAudit, owner, machine])).toBe('owner');
    expect(latestIntervalAttribution([toolAudit, machine, owner])).toBe('machine');
    expect(latestIntervalAttribution([promptOnly, machine])).toBe('machine');
    for (const src of ['cadence-stretch', 'project-sweep-backoff', 'project-sweep-cadence-floor']) {
      expect(latestIntervalAttribution([{ ...machine, source: src }, owner])).toBe('machine');
    }
  });
  it('a legacy row with no attribution at all → null (the heal keeps its pre-fix behaviour); garbage is tolerated', () => {
    expect(latestIntervalAttribution([toolAudit])).toBeNull();
    expect(latestIntervalAttribution([])).toBeNull();
    expect(latestIntervalAttribution([null, undefined, 'x' as any, { fields: 'intervalSec' } as any])).toBeNull();
  });
  it('PROJECT_SWEEP_FLOOR_HEAL_OWNER_ROWS defaults OFF', () => {
    expect(projectSweepFloorHealOwnerRowsEnabled()).toBe(false);
    process.env.PROJECT_SWEEP_FLOOR_HEAL_OWNER_ROWS = '1';
    expect(projectSweepFloorHealOwnerRowsEnabled()).toBe(true);
  });
});

describe('near-cap fraction follows the renewal derivation (wake-cadence-4 owner notice at 80 %)', () => {
  it('renewing rows 0.9, non-renewing 0.8, authorship-less callers keep 0.9', () => {
    expect(nearCapFractionFor({ promptSetBy: 'machine', renewOnExhaustion: null })).toBe(NEAR_CAP_FRACTION);
    expect(nearCapFractionFor({ promptSetBy: 'user', renewOnExhaustion: null })).toBe(NEAR_CAP_FRACTION_NO_RENEW);
    expect(nearCapFractionFor({ promptSetBy: null })).toBe(NEAR_CAP_FRACTION_NO_RENEW);
    expect(nearCapFractionFor({ renewOnExhaustion: false, promptSetBy: 'machine' })).toBe(NEAR_CAP_FRACTION_NO_RENEW);
    expect(nearCapFractionFor({})).toBe(NEAR_CAP_FRACTION);
    expect(nearCapRunThreshold(500)).toBe(450);
    expect(nearCapRunThreshold(500, 0.8)).toBe(400);
  });
  it('scheduleNearCapCause: an owner row at 400/500 is near-cap, a machine row at 400/500 is not (450)', () => {
    const now = new Date();
    const base = { kind: 'recurring', runsCount: 400, maxRuns: 500, expiresAt: null as Date | null };
    expect(scheduleNearCapCause({ ...base, promptSetBy: 'user', renewOnExhaustion: null }, now)).toBe('run_cap');
    expect(scheduleNearCapCause({ ...base, promptSetBy: 'machine', renewOnExhaustion: null }, now)).toBeNull();
    expect(scheduleNearCapCause(base, now)).toBeNull(); // classic callers unchanged
    expect(scheduleNearCapCause({ ...base, runsCount: 450 }, now)).toBe('run_cap');
  });
});

describe('prompt lint (wake-cadence-4, observe-only)', () => {
  const TTRD = 'Standing loop … SUCCESSOR (arm BEFORE this schedule exhausts at 500): when ≥480 firings have run, flag_owner_question requesting a FRESH monitor lane and hand off.';
  it('matches the tt-rd SUCCESSOR clause and other cap-driven hand-off phrasings', () => {
    expect(CAP_HANDOFF_CLAUSE_RE.test(TTRD)).toBe(true);
    expect(CAP_HANDOFF_CLAUSE_RE.test('at firing 480 hand-off to a new chat')).toBe(true);
    expect(CAP_HANDOFF_CLAUSE_RE.test('arm a successor before the cap')).toBe(true);
    expect(CAP_HANDOFF_CLAUSE_RE.test('poll the CI status every hour and report deltas')).toBe(false);
    expect(CAP_HANDOFF_CLAUSE_RE.test('the successor model of the v2 pipeline is ready')).toBe(false);
  });
  it('only MACHINE-authored prompts are linted; the notice never refuses', () => {
    const f = lintSchedulePrompt(TTRD, 'machine');
    expect(f?.rule).toBe('cap_handoff');
    expect(f?.notice).toMatch(/^\[SCHEDULE PROMPT NOTICE\]/);
    expect(f?.notice).toMatch(/AUTO-RENEWS capped machine schedules/);
    expect(f?.notice).toMatch(/saved as written/);
    expect(lintSchedulePrompt(TTRD, 'user')).toBeNull();
    expect(lintSchedulePrompt(TTRD, null)).toBeNull();
    expect(lintSchedulePrompt('poll CI hourly', 'machine')).toBeNull();
  });
});

describe('busy re-arm backoff (wake-cadence-6)', () => {
  it('3 → 6 → 12 → 24 → 24 min for a long cadence; capped at half the cadence; never below 3 min', () => {
    const H = 3600;
    expect([0, 1, 2, 3, 4, 9].map((k) => busyRearmDelayMs(k, 2 * H) / 60_000)).toEqual([3, 6, 12, 24, 24, 24]);
    expect([0, 1, 2, 3].map((k) => busyRearmDelayMs(k, 1800) / 60_000)).toEqual([3, 6, 12, 15]); // half of 30 min
    expect([0, 1, 2].map((k) => busyRearmDelayMs(k, 900) / 60_000)).toEqual([3, 6, 7.5]);
    expect(busyRearmDelayMs(5, 240) / 60_000).toBe(3); // half-cadence 2 min < base → base
    expect(BUSY_REARM_BASE_MIN).toBe(BUSY_REARM_MIN);
  });
  it('one-shots (no interval) keep the flat 3 min', () => {
    expect(busyRearmDelayMs(4, null) / 60_000).toBe(3);
    expect(busyRearmDelayMs(4, undefined) / 60_000).toBe(3);
  });
  it('parkedMinutes (the superseded gate\'s window) sums the geometric delays', () => {
    expect(parkedMinutesWithBackoff(4, 7200)).toBe(3 + 6 + 12 + 24);
    expect(parkedMinutes({ busySkips: 4, intervalSec: 7200 })).toBe(45);
    expect(parkedMinutes({ busySkips: 0, intervalSec: 7200 })).toBe(3);
    expect(parkedMinutes({ busySkips: 2 })).toBe(6); // no interval → flat
  });
});

describe('busy-steer delta body + schedule-origin wrap-up note (wake-cadence-1)', () => {
  it('the delta body names the firing, says the prompt is unchanged, says WRAP UP, and carries only the short extras', () => {
    const body = busySteerDeltaBody('sch_abcdef123456789', ['[SCHEDULE STATE] firing 5 of 500 · auto-renews at cap', '', '  ']);
    expect(body).toMatch(/^\[SCHEDULED FIRING sch_abcdef123 arrived mid-run — the stored prompt is UNCHANGED/);
    expect(body).toMatch(/WRAP UP at the next natural point/);
    expect(body).toMatch(/\[SCHEDULE STATE\] firing 5 of 500/);
    expect(body.split('\n\n')).toHaveLength(2);
    expect(busySteerDeltaBody('sch_1')).not.toContain('\n\n');
  });
  it('the wrap-up note fires ONCE at ≥2× the interval, not before, never without an interval', () => {
    expect(RUN_WRAPUP_INTERVAL_FACTOR).toBe(2);
    expect(scheduleRunWrapupNote({ elapsedMs: 59 * 60_000, intervalSec: 1800, alreadyDelivered: false })).toBeNull();
    const note = scheduleRunWrapupNote({ elapsedMs: 61 * 60_000, intervalSec: 1800, alreadyDelivered: false });
    expect(note).toMatch(/^\[SCHEDULE CADENCE NOTE — harness, not the user\] This run has been going 61 min; the schedule that started it fires every 30 min/);
    expect(note).toMatch(/This is advice, not a stop\./);
    expect(scheduleRunWrapupNote({ elapsedMs: 61 * 60_000, intervalSec: 1800, alreadyDelivered: true })).toBeNull();
    expect(scheduleRunWrapupNote({ elapsedMs: 61 * 60_000, intervalSec: null, alreadyDelivered: false })).toBeNull();
  });
});

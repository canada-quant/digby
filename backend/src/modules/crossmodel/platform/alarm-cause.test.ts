/**
 * alarm-cause.ts — ALARM-CAUSE-AWARE (supervisor SOTA 2026-10-20): the pure
 * cause table that makes an alarm-TYPE row quiet, the terminal run_failed
 * extra and the ledger's resume-queued excuse.
 */

import {
  CANCEL_ACTOR_KEY, CANCEL_ACTOR_TTL_SEC, failureResumeQueued, hookAlarmCauseAwareDisabled, isProviderTransientFailure,
  quietAlarmCause, terminalRunCauseExtra,
} from './alarm-cause';

afterEach(() => { delete process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED; });

describe('quietAlarmCause — the cause table', () => {
  const LANE = '7bd45d57-1111-4222-8333-444455556666';
  const SUP = '41bd202a-7152-437e-bf4b-a097981692b1';
  it.each([
    // [eventType, payload, expected]
    ['run_failed', { cancelledBy: SUP, sourceChatId: LANE }, 'cancelled'],
    ['run_failed', { cause: 'provider_transient', resumeQueued: true, round: 2, sourceChatId: LANE }, 'provider_transient'],
    ['run_failed', { resumeQueued: 'true' }, null], // only the boolean the emitter writes
    ['run_failed', { cancelledBy: '  ' }, null],
    ['run_failed', { sourceChatId: LANE }, null], // a plain failure stays an alarm
    ['run_failed', undefined, null],
    ['schedule_disabled', { stoppedByChatId: LANE, sourceChatId: LANE, laneLiveWork: true }, 'self_stop'],
    ['schedule_disabled', { stoppedByChatId: LANE, sourceChatId: LANE, laneLiveWork: false }, null], // self-stop that leaves the lane deaf
    // review fix 2026-10-20: zero enabled schedules left is the deaf lane whatever laneLiveWork says.
    ['schedule_disabled', { stoppedByChatId: LANE, sourceChatId: LANE, laneLiveWork: true, remainingEnabled: 0 }, null],
    ['schedule_disabled', { stoppedByChatId: LANE, sourceChatId: LANE, laneLiveWork: true, remainingEnabled: 2 }, 'self_stop'],
    ['schedule_disabled', { stoppedByChatId: SUP, sourceChatId: LANE, laneLiveWork: true }, null], // someone else stopped it
    ['schedule_disabled', { sourceChatId: LANE, laneLiveWork: true }, null], // owner UI / system stop
    ['attention_needed', { cancelledBy: SUP, resumeQueued: true }, null], // never for other types
    ['goal_blocked', { stoppedByChatId: LANE, sourceChatId: LANE, laneLiveWork: true }, null],
    ['run_completed', { cancelledBy: SUP }, null],
  ])('%s %j → %s', (t, payload, expected) => {
    expect(quietAlarmCause(t, payload)).toBe(expected);
  });

  it('the kill switch makes every row type-based again', () => {
    process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED = '1';
    expect(hookAlarmCauseAwareDisabled()).toBe(true);
    expect(quietAlarmCause('run_failed', { cancelledBy: SUP })).toBeNull();
    expect(quietAlarmCause('run_failed', { resumeQueued: true })).toBeNull();
    expect(quietAlarmCause('schedule_disabled', { stoppedByChatId: LANE, sourceChatId: LANE, laneLiveWork: true })).toBeNull();
  });
});

describe('terminalRunCauseExtra — the run_failed emission extra (resume-queued emit)', () => {
  it('a run a chat stopped names cancelledBy and makes the stopper the hook actor', () => {
    expect(terminalRunCauseExtra({ finalStatus: 'cancelled', cancelledBy: 'sup-1' })).toEqual({ cause: 'cancelled', cancelledBy: 'sup-1', actorChatId: 'sup-1' });
  });
  it('a provider-killed FAILED run whose resume is queued carries {cause, resumeQueued, round}', () => {
    expect(terminalRunCauseExtra({ finalStatus: 'failed', providerTransientResumeRound: 3 })).toEqual({ cause: 'provider_transient', resumeQueued: true, round: 3 });
  });
  it('nothing applies ⇒ {} (the emission stays `{ runId }` byte-for-byte)', () => {
    expect(terminalRunCauseExtra({ finalStatus: 'cancelled' })).toEqual({}); // owner Stop button: no actor
    expect(terminalRunCauseExtra({ finalStatus: 'failed', providerTransientResumeRound: null })).toEqual({});
    expect(terminalRunCauseExtra({ finalStatus: 'failed', providerTransientResumeRound: 0 })).toEqual({});
    expect(terminalRunCauseExtra({ finalStatus: 'completed', cancelledBy: 'sup-1', providerTransientResumeRound: 1 })).toEqual({});
    process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED = '1';
    expect(terminalRunCauseExtra({ finalStatus: 'cancelled', cancelledBy: 'sup-1' })).toEqual({});
    expect(terminalRunCauseExtra({ finalStatus: 'failed', providerTransientResumeRound: 2 })).toEqual({});
  });
});

describe('failureResumeQueued — the ledger excuse', () => {
  const T0 = new Date('2026-10-20T10:00:00Z');
  const failed = { id: 'r1', sessionId: 'lane-1', error: 'model provider killed the run (transient failure, HTTP 429): rate limited', startedAt: T0 };
  const later = (status: string, sessionId = 'lane-1') => ({ id: 'r2', sessionId, status, createdAt: new Date(T0.getTime() + 60_000) });
  it('a transient kill followed by a queued / running / completed resume on the SAME lane is excused', () => {
    expect(isProviderTransientFailure(failed.error)).toBe(true);
    for (const st of ['queued', 'running', 'completed']) expect(failureResumeQueued(failed, [failed as any, later(st)])).toBe(true);
  });
  it('a failed resume, another lane, an earlier row, or a non-transient failure excuses nothing (lane_failed stays material)', () => {
    expect(failureResumeQueued(failed, [later('failed')])).toBe(false);
    expect(failureResumeQueued(failed, [later('queued', 'lane-2')])).toBe(false);
    expect(failureResumeQueued(failed, [{ id: 'r0', sessionId: 'lane-1', status: 'completed', createdAt: new Date(T0.getTime() - 60_000) }])).toBe(false);
    expect(failureResumeQueued({ ...failed, error: 'model provider killed the run (capability failure, HTTP 400): bad tools' }, [later('queued')])).toBe(false);
    expect(failureResumeQueued({ ...failed, error: 'provider content filter' }, [later('queued')])).toBe(false);
    expect(failureResumeQueued({ ...failed, startedAt: null, createdAt: null }, [later('queued')])).toBe(false);
  });
});

it('the cancel-actor key shape + TTL', () => {
  expect(CANCEL_ACTOR_KEY('run-9')).toBe('cancel-actor:run-9');
  expect(CANCEL_ACTOR_TTL_SEC).toBe(3600);
});

/**
 * REPLAY — ticket 65af5656 (2026-11-03): a deploy/drain churn must never
 * cancel unrelated lanes' live runs.
 *
 * The defect replayed here is the run-executor lease-refresh guard. Its input,
 * `heartbeatAgentRun(runId)`, is `updateMany({ where: { id, status: 'running' }})`
 * — so its return value is the number of rows RUNNING NOW, not the number of
 * rows that exist. The guard read `0` as "the chat and its row were deleted"
 * and released the execution through the Stop path.
 *
 * Observed at 2026-11-03T09:15:44.96–45.03Z: 64 `zombie_run_stopped` rows
 * across EIGHT lanes inside ~50 ms (loop_metrics kind 'zombie_run_stopped',
 * every row meta {"reason":"run_row_gone"}), including lanes 0037460b (run
 * 2016b371) and 60dfc8a8 (run e2e1a367) — the two Schooltime lanes whose
 * transcripts both finalized "(Stopped.)" at 09:15:45.26Z/09:15:45.27Z with
 * `continuation_suppressed{reason:'stopped'}`. Both chats still exist
 * (get_chat_status 2026-11-03T12:29Z: 0037460b status 'ready' with 2 enabled
 * schedules, 60dfc8a8 status 'running'), which falsifies the "chat deleted"
 * inference the guard acted on.
 *
 * The fix (coding/run-row-liveness.ts + run-executor's lease interval):
 * read the ROW back before releasing anything, classify, and only cancel on a
 * CONFIRMED absence across consecutive beats. This test pins that classifier
 * and the confirmation floor against the reproduction, so a future refactor
 * cannot restore the 0-rows-means-deleted reading.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } }));

import {
  classifyZeroHeartbeat,
  zombieConfirmMisses,
  zombieStopReason,
  type RunRowVerdict,
} from './run-row-liveness';

beforeEach(() => {
  delete process.env.ZOMBIE_RUN_STOP_CONFIRM_MISSES;
});

describe('ticket 65af5656 — a zero-touch heartbeat is not proof of a deleted chat', () => {
  it('a row that is still there and RUNNING-classified elsewhere (e.g. a racing finalize) is stand-down, never a cancel', () => {
    // The reproduction's real shape: 8 lanes' rows were flipped OFF 'running'
    // by a fleet-level actor while the chats themselves survived.
    for (const status of ['completed', 'cancelled', 'queued', 'failed']) {
      expect(classifyZeroHeartbeat({ status })).toBe('not_running');
    }
  });

  it('an INTERRUPTED row is a deploy/drain HAND-OFF, not a zombie — it must be released as resumable', () => {
    // This is the exact 09:15:45Z case: a wave marked the rows 'interrupted'
    // (resume intent, checkpoint retained). Cancelling produced a terminal
    // Stop that then suppressed the continuation. The verdict must route it to
    // the shutdown-interrupt path instead.
    expect(classifyZeroHeartbeat({ status: 'interrupted' })).toBe('resumable');
  });

  it('only a genuinely ABSENT row reads as row_gone — the case the guard exists for', () => {
    expect(classifyZeroHeartbeat(null)).toBe('row_gone');
  });

  it('an unreadable row is unknown (fail-open) — a failed read is never evidence of absence', () => {
    expect(classifyZeroHeartbeat(null, true)).toBe('unknown');
    expect(classifyZeroHeartbeat({ status: 'running' }, true)).toBe('unknown');
  });

  it('absent and garbled statuses never fall through to a cancel verdict', () => {
    // Defensive: an empty/NULL status is "not running", which stands down.
    expect(classifyZeroHeartbeat({ status: null })).toBe('not_running');
    expect(classifyZeroHeartbeat({ status: '' })).toBe('not_running');
    expect(classifyZeroHeartbeat({})).toBe('not_running');
  });

  it('a real absence needs MORE than one beat, so a single transient 0 cannot kill a lane', () => {
    // The 09:15:45Z burst fired every lane's guard on its FIRST zero count.
    // The fix requires consecutive confirmation; the floor must stay >= 2.
    expect(zombieConfirmMisses()).toBeGreaterThanOrEqual(2);
    process.env.ZOMBIE_RUN_STOP_CONFIRM_MISSES = '3';
    expect(zombieConfirmMisses()).toBe(3);
    // A nonsense value falls back to the safe floor rather than 0/1.
    for (const bad of ['0', '-1', 'abc', '']) {
      process.env.ZOMBIE_RUN_STOP_CONFIRM_MISSES = bad;
      expect(zombieConfirmMisses()).toBeGreaterThanOrEqual(2);
    }
  });

  it('each verdict carries its own telemetry reason so confirms, stand-downs and hand-offs are chartable apart', () => {
    const verdicts: RunRowVerdict[] = ['row_gone', 'resumable', 'not_running', 'unknown'];
    const reasons = verdicts.map(zombieStopReason);
    expect(reasons).toEqual(['run_row_gone', 'run_row_interrupted_handoff', 'run_row_not_running', 'run_row_read_failed']);
    // The pre-fix code emitted ONLY 'run_row_gone' for every one of these —
    // which is why 64 identical rows looked like 64 deleted chats.
    expect(new Set(reasons).size).toBe(verdicts.length);
  });
});

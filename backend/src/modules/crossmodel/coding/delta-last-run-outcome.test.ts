/**
 * delta-last-run-outcome.ts (E5, 2026-09-25): the delta_material state's
 * `last_run_outcome` line — harness-derived from the previous labelled
 * outcome row + the schedule's own last status; bounded; pure.
 */
import { formatDeltaLastRunOutcome, relativeAgo } from './delta-last-run-outcome';

const now = new Date('2026-09-25T12:00:00Z');
const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000);

describe('relativeAgo', () => {
  it('minutes / hours / days / never', () => {
    expect(relativeAgo(at(5), now)).toBe('5 min ago');
    expect(relativeAgo(at(150), now)).toBe('3 h ago');
    expect(relativeAgo(at(3 * 1440), now)).toBe('3 d ago');
    expect(relativeAgo(null, now)).toBe('never');
    expect(relativeAgo(at(-10), now)).toBe('0 min ago'); // clock skew never goes negative
  });
});

describe('formatDeltaLastRunOutcome', () => {
  it('no prior row → names the absence plus the schedule status', () => {
    expect(formatDeltaLastRunOutcome(null, { lastStatus: 'started', lastFiredAt: at(90) }, now))
      .toBe('no prior labelled delta-gated firing (schedule lastStatus=started, lastFiredAt=2 h ago)');
    expect(formatDeltaLastRunOutcome(null, {}, now))
      .toBe('no prior labelled delta-gated firing (schedule lastStatus=none, lastFiredAt=never)');
  });

  it('a labelled row → material / not material / unknown with the harness note', () => {
    const s = { lastStatus: 'started', lastFiredAt: at(30) };
    expect(formatDeltaLastRunOutcome({ createdAt: at(31), meta: { actual: true, note: 'finalized: supervisor_action; mutating 1 (send_chat_message); evidence 3' } }, s, now))
      .toBe('previous delta-gated firing 31 min ago: material (the run did real work) — finalized: supervisor_action; mutating 1 (send_chat_message); evidence 3 (schedule lastStatus=started, lastFiredAt=30 min ago)');
    expect(formatDeltaLastRunOutcome({ createdAt: at(31), meta: { actual: false, note: 'finalized: supervisor_noop; mutating 0; evidence 2' } }, s, now))
      .toContain('NOT material (the run only noted it) — finalized: supervisor_noop');
    expect(formatDeltaLastRunOutcome({ createdAt: at(31), meta: { actual: null } }, s, now))
      .toBe('previous delta-gated firing 31 min ago: outcome unknown (schedule lastStatus=started, lastFiredAt=30 min ago)');
  });

  it('malformed meta reads as no prior row; the line is capped at 300 chars', () => {
    expect(formatDeltaLastRunOutcome({ createdAt: at(1), meta: 'junk' }, {}, now)).toMatch(/^no prior labelled/);
    const long = formatDeltaLastRunOutcome({ createdAt: at(1), meta: { actual: true, note: 'x'.repeat(500) } }, {}, now);
    expect(long.length).toBe(300);
  });
});

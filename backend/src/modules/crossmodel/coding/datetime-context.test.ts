/**
 * Regression tests for the owner feedback "coding-session report timestamps
 * default to Zulu": the coding agent prompt now carries the shared
 * [CURRENT DATE & TIME] block (UTC always, user-local when the owner's
 * timezone is known) plus the coding-specific timestamp rule — user-directed
 * timestamps render in the user's tz; machine-to-machine content stays UTC.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { userMemory: { findUnique: jest.fn() } },
}));
// logger transitively imports config/env, whose Zod validation process.exit(1)s
// in a keyless test environment — mock it out like the other suites do.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), setEx: jest.fn(), del: jest.fn() } }));
// Heavy leaf deps of chat-context.ts (imported at module load via
// datetime-context.ts) — mocked so the import never reaches config/env.
jest.mock('../context.service', () => ({
  __esModule: true,
  default: { loadChatContext: jest.fn(), loadSessionContext: jest.fn() },
}));
jest.mock('../rag.service', () => ({
  retrieveChunks: jest.fn(),
  retrieveCrossProjectChunks: jest.fn(),
  buildContextBlock: jest.fn(),
  buildCrossProjectBlock: jest.fn(),
}));
jest.mock('../langgraph/memory.graph', () => ({
  getEnrichedContext: jest.fn(),
  getProjectSettings: jest.fn(),
}));

import prisma from '../../../config/database';
import {
  isValidTimezone, loadUserTimezone, buildCodingDateTimeBlock, buildCodingClockNote, buildChatWakeClockNote,
} from './datetime-context';

const findUnique = prisma.userMemory.findUnique as jest.Mock;

describe('isValidTimezone', () => {
  it('accepts real IANA zones and rejects garbage', () => {
    expect(isValidTimezone('America/Vancouver')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('loadUserTimezone', () => {
  beforeEach(() => findUnique.mockReset());

  it('returns the timezone from user-memory facts', async () => {
    findUnique.mockResolvedValue({ facts: { timezone: 'America/Vancouver' } });
    await expect(loadUserTimezone('u1')).resolves.toBe('America/Vancouver');
    expect(findUnique).toHaveBeenCalledWith({ where: { userId: 'u1' }, select: { facts: true } });
  });

  it('degrades to undefined when memory is missing or has no timezone', async () => {
    findUnique.mockResolvedValue(null);
    await expect(loadUserTimezone('u1')).resolves.toBeUndefined();
    findUnique.mockResolvedValue({ facts: {} });
    await expect(loadUserTimezone('u1')).resolves.toBeUndefined();
  });

  it('degrades to undefined for a stored garbage timezone', async () => {
    findUnique.mockResolvedValue({ facts: { timezone: 'Not/AZone' } });
    await expect(loadUserTimezone('u1')).resolves.toBeUndefined();
  });

  it('never breaks a run when the memory read throws', async () => {
    findUnique.mockRejectedValue(new Error('db down'));
    await expect(loadUserTimezone('u1')).resolves.toBeUndefined();
  });
});

describe('buildCodingDateTimeBlock', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // UTC/Vancouver date split: Thu 2026-08-20 05:30:00 UTC = Wed 2026-08-19 22:30 PDT.
    jest.setSystemTime(new Date(Date.UTC(2026, 7, 20, 5, 30, 0)));
  });
  afterEach(() => jest.useRealTimers());

  it('renders UTC + user-local time and the user-vs-machine timestamp rule', () => {
    const block = buildCodingDateTimeBlock('America/Vancouver');
    // shared block, both clocks — the local date is the DAY BEFORE the UTC date
    expect(block).toContain('Date      : Thursday, August 20, 2026');
    expect(block).toContain('Time      : 05:30:00 UTC');
    expect(block).toContain('User local: Wednesday, August 19, 2026 at 10:30:00 PM PDT (America/Vancouver)');
    // the coding-specific rule, inside the block (before the closing tag):
    // owner convention 63698528 — user-directed timestamps show BOTH clocks
    // (local first, Zulu in parentheses), never one alone.
    expect(block).toContain('FOR THE USER (chat replies, run reports, summaries, PR/issue bodies) render BOTH clocks');
    expect(block).toContain('the USER LOCAL time above (America/Vancouver) first, with the UTC instant in parentheses');
    expect(block).toContain('"10:30 PM PDT (05:30Z)"');
    expect(block).toContain('never a bare Zulu-only or local-only timestamp');
    expect(block).toContain('Machine-to-machine content (hook payloads, log lines, schedule prompts, audit trails, file names) stays UTC / ISO-8601');
    expect(block.indexOf('Timestamp rule:')).toBeLessThan(block.indexOf('[/CURRENT DATE & TIME]'));
  });

  it('tracks the winter offset (PST = UTC-8) across a January date split', () => {
    // Thu 2026-01-15 07:45:00 UTC = Wed 2026-01-14 23:45 PST — standard time,
    // and still a different local date from UTC.
    jest.setSystemTime(new Date(Date.UTC(2026, 0, 15, 7, 45, 0)));
    const block = buildCodingDateTimeBlock('America/Vancouver');
    expect(block).toContain('Date      : Thursday, January 15, 2026');
    expect(block).toContain('User local: Wednesday, January 14, 2026 at 11:45:00 PM PST (America/Vancouver)');
  });

  it('falls back to UTC-only with an explicit "timezone unknown" rule when tz is absent', () => {
    const block = buildCodingDateTimeBlock();
    expect(block).not.toContain('User local:');
    expect(block).toContain("the user's timezone is not known — use UTC (ISO-8601) everywhere");
    expect(block).toContain('Machine-to-machine content (hook payloads, log lines, schedule prompts) stays UTC');
    expect(block).toContain('Date      : Thursday, August 20, 2026');
  });

  it('treats an invalid timezone as absent (never names a bogus zone in the rule)', () => {
    const block = buildCodingDateTimeBlock('Not/AZone');
    expect(block).not.toContain('User local:');
    expect(block).not.toContain('Not/AZone');
    expect(block).toContain("the user's timezone is not known");
  });

  it('carries the clock-discipline rule (ticket 63e9a3cb) in BOTH rule variants', () => {
    // The block is run-start time; lanes must cite the per-turn [HARNESS CLOCK]
    // note or a tool-printed clock instead of estimating elapsed minutes.
    for (const block of [buildCodingDateTimeBlock('America/Vancouver'), buildCodingDateTimeBlock()]) {
      expect(block).toContain('use the latest [HARNESS CLOCK] note (refreshed every turn) or a tool-printed clock verbatim');
      expect(block).toContain('NEVER estimate "now" by adding elapsed minutes to the block above; it is run-start time and goes stale mid-run.');
    }
  });
});

/**
 * The per-turn [HARNESS CLOCK] note (ticket 63e9a3cb): the agent loop pushes it
 * before every model call so "now" is always a fresh harness clock — the fix
 * for lanes estimating block-time + guessed elapsed and overshooting the true
 * clock (the ~+10m future-dated strikes of 2026-08-28).
 */
describe('buildCodingClockNote', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Thu 2026-08-20 05:30:00 UTC = Wed 2026-08-19 22:30 PDT.
    jest.setSystemTime(new Date(Date.UTC(2026, 7, 20, 5, 30, 0)));
  });
  afterEach(() => jest.useRealTimers());

  it('renders a one-line fresh clock in BOTH clocks with the anti-estimation rule', () => {
    const note = buildCodingClockNote('America/Vancouver');
    expect(note).toContain('[HARNESS CLOCK — not typed by the user]');
    expect(note).toContain('Current time: 2026-08-20T05:30:00.000Z / 10:30:00 PM PDT Aug 19 (America/Vancouver).');
    expect(note).toContain('never add estimated elapsed minutes to it.');
    expect(note.trim().split('\n')).toHaveLength(1); // one line — it costs tokens on every turn
  });

  it('tracks the winter offset (PST = UTC-8)', () => {
    jest.setSystemTime(new Date(Date.UTC(2026, 0, 15, 7, 45, 0)));
    const note = buildCodingClockNote('America/Vancouver');
    expect(note).toContain('Current time: 2026-01-15T07:45:00.000Z / 11:45:00 PM PST Jan 14 (America/Vancouver).');
  });

  it('falls back to UTC-only when tz is absent or invalid (never names a bogus zone)', () => {
    const note = buildCodingClockNote();
    expect(note).toContain('Current time: 2026-08-20T05:30:00.000Z.');
    expect(note).not.toContain(' / ');
    const bogus = buildCodingClockNote('Not/AZone');
    expect(bogus).toContain('Current time: 2026-08-20T05:30:00.000Z.');
    expect(bogus).not.toContain('Not/AZone');
  });
});

/**
 * The chat-lane machine-wake variant (ticket ad325229, 2026-09-16): identical
 * per-turn fresh clock, but its stale-clock reference is the machine-wake line
 * — chat lanes carry no [CURRENT DATE & TIME] block, so pointing at one would
 * confuse the lane. The prefix stays '[HARNESS CLOCK' so transient-messages /
 * checkpoint / history-replay stripping treat it exactly like the coding note.
 */
describe('buildChatWakeClockNote', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Wed 2026-09-16 19:16:34 UTC — the incident run's real clock (ad325229).
    jest.setSystemTime(new Date(Date.UTC(2026, 8, 16, 19, 16, 34)));
  });
  afterEach(() => jest.useRealTimers());

  it('renders the same one-line fresh clock but names the machine-wake line as the run-start stamp', () => {
    const note = buildChatWakeClockNote();
    expect(note).toContain('[HARNESS CLOCK — not typed by the user]');
    expect(note).toContain('Current time: 2026-09-16T19:16:34.000Z.');
    expect(note).toContain('the machine-wake line is run-start time; never add estimated elapsed minutes to it.');
    expect(note).not.toContain('[CURRENT DATE & TIME] block');
    expect(note.trim().split('\n')).toHaveLength(1); // one line — it costs tokens on every turn
  });

  it('renders the user-local half when a valid tz is given, and never names a bogus zone', () => {
    const note = buildChatWakeClockNote('America/Toronto');
    expect(note).toContain('Current time: 2026-09-16T19:16:34.000Z / 03:16:34 PM EDT Sep 16 (America/Toronto).');
    const bogus = buildChatWakeClockNote('Not/AZone');
    expect(bogus).toContain('Current time: 2026-09-16T19:16:34.000Z.');
    expect(bogus).not.toContain('Not/AZone');
    expect(bogus).not.toContain(' / ');
  });
});

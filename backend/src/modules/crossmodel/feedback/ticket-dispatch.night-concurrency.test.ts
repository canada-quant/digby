/**
 * Overnight ticket-lane concurrency (2026-10-16).
 *
 * Day cap stays TICKET_LANE_CONCURRENCY (default 4). Inside
 * TICKET_LANE_NIGHT_HOURS (default 22:00–06:00 America/Vancouver) the cap
 * is TICKET_LANE_CONCURRENCY_NIGHT (default 6). A malformed window falls
 * back to the day value. The night-window kick fires only at the start
 * hour, once per Vancouver date.
 */
import { ticketLaneConcurrency, vancouverHour, maybeKickNightTicketDrain } from './ticket-dispatch.service';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findUnique: jest.fn() },
    crossModelProject: { findUnique: jest.fn() },
    userFeatureRequest: { findMany: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    agentRun: { findMany: jest.fn(), count: jest.fn() },
    chatCodingState: { findMany: jest.fn() },
    contextStoreEntry: { findUnique: jest.fn() },
  },
}));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    del: jest.fn(),
    decr: jest.fn(),
  },
}));

jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  startCodingSession: jest.fn(),
  sendChatMessage: jest.fn(),
  archiveChat: jest.fn(),
}));

/** A Date whose America/Vancouver hour is `hour` (DST-proof: search, don't hardcode offsets). */
function atVancouverHour(hour: number): Date {
  const anchor = new Date('2026-06-15T12:00:00Z');
  for (let i = 0; i < 48; i++) {
    const d = new Date(anchor.getTime() + i * 60 * 60 * 1000);
    if (vancouverHour(d) === hour) return d;
  }
  throw new Error(`no date with vancouver hour ${hour}`);
}

const EMPTY: NodeJS.ProcessEnv = {};

describe('ticketLaneConcurrency night window', () => {
  it('defaults: night 6 inside 22:00–06:00 PT, day 4 outside', () => {
    for (const h of [22, 23, 0, 5]) {
      expect(ticketLaneConcurrency(atVancouverHour(h), EMPTY)).toBe(6);
    }
    for (const h of [6, 12, 21]) {
      expect(ticketLaneConcurrency(atVancouverHour(h), EMPTY)).toBe(4);
    }
  });

  it('custom wrapping window is half-open (start inclusive, end exclusive)', () => {
    const env = { TICKET_LANE_NIGHT_HOURS: '22-6' } as NodeJS.ProcessEnv;
    for (const h of [22, 23, 0, 5]) {
      expect(ticketLaneConcurrency(atVancouverHour(h), env)).toBe(6);
    }
    for (const h of [6, 21]) {
      expect(ticketLaneConcurrency(atVancouverHour(h), env)).toBe(4);
    }
  });

  it('non-wrapping window "9-17"', () => {
    const env = { TICKET_LANE_NIGHT_HOURS: '9-17' } as NodeJS.ProcessEnv;
    expect(ticketLaneConcurrency(atVancouverHour(9), env)).toBe(6);
    expect(ticketLaneConcurrency(atVancouverHour(16), env)).toBe(6);
    expect(ticketLaneConcurrency(atVancouverHour(17), env)).toBe(4);
    expect(ticketLaneConcurrency(atVancouverHour(8), env)).toBe(4);
  });

  it('malformed, empty, and equal windows fall back to the day cap', () => {
    const at23 = atVancouverHour(23);
    for (const raw of ['nope', '', '5-5', 'abc-def']) {
      expect(ticketLaneConcurrency(at23, { TICKET_LANE_NIGHT_HOURS: raw } as NodeJS.ProcessEnv)).toBe(4);
    }
  });

  it('"24-6" is start hour 0 (24 % 24), so 23:00 PT is day', () => {
    const env = { TICKET_LANE_NIGHT_HOURS: '24-6' } as NodeJS.ProcessEnv;
    expect(ticketLaneConcurrency(atVancouverHour(23), env)).toBe(4);
    expect(ticketLaneConcurrency(atVancouverHour(0), env)).toBe(6);
    expect(ticketLaneConcurrency(atVancouverHour(5), env)).toBe(6);
    expect(ticketLaneConcurrency(atVancouverHour(6), env)).toBe(4);
  });

  it('clamps both caps to 1–10; below-min and non-finite keep the fallback', () => {
    const night = atVancouverHour(23);
    const day = atVancouverHour(12);
    expect(ticketLaneConcurrency(night, { TICKET_LANE_CONCURRENCY_NIGHT: '0' } as NodeJS.ProcessEnv)).toBe(6);
    expect(ticketLaneConcurrency(night, { TICKET_LANE_CONCURRENCY_NIGHT: 'nope' } as NodeJS.ProcessEnv)).toBe(6);
    expect(ticketLaneConcurrency(night, { TICKET_LANE_CONCURRENCY_NIGHT: '99' } as NodeJS.ProcessEnv)).toBe(10);
    expect(ticketLaneConcurrency(night, { TICKET_LANE_CONCURRENCY_NIGHT: '7' } as NodeJS.ProcessEnv)).toBe(7);
    expect(ticketLaneConcurrency(day, { TICKET_LANE_CONCURRENCY: '0' } as NodeJS.ProcessEnv)).toBe(4);
    expect(ticketLaneConcurrency(day, { TICKET_LANE_CONCURRENCY: '99' } as NodeJS.ProcessEnv)).toBe(10);
    expect(ticketLaneConcurrency(day, { TICKET_LANE_CONCURRENCY: '2' } as NodeJS.ProcessEnv)).toBe(2);
  });

  it('fixed clock: 23:00 PT is night, 12:00 PT is day', () => {
    expect(ticketLaneConcurrency(atVancouverHour(23), EMPTY)).toBe(6);
    expect(ticketLaneConcurrency(atVancouverHour(12), EMPTY)).toBe(4);
  });
});

describe('maybeKickNightTicketDrain', () => {
  const PX = 26 * 60 * 60 * 1000;

  it('skips outside the start hour and never touches redis', async () => {
    const set = jest.fn();
    const drain = jest.fn();
    const out = await maybeKickNightTicketDrain(atVancouverHour(23), EMPTY, { set, drain });
    expect(out).toBe('skipped');
    expect(set).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });

  it('kicks once at the start hour when the NX set lands', async () => {
    const set = jest.fn().mockResolvedValue('OK');
    const drain = jest.fn().mockResolvedValue(undefined);
    const out = await maybeKickNightTicketDrain(atVancouverHour(22), EMPTY, { set, drain });
    expect(out).toBe('kicked');
    expect(drain).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.stringMatching(/^ticket-lane-night-kick:\d{4}-\d{2}-\d{2}$/),
      '1',
      { NX: true, PX },
    );
  });

  it('dedupes when the NX set does not return OK', async () => {
    const set = jest.fn().mockResolvedValue(null);
    const drain = jest.fn();
    const out = await maybeKickNightTicketDrain(atVancouverHour(22), EMPTY, { set, drain });
    expect(out).toBe('deduped');
    expect(drain).not.toHaveBeenCalled();
  });

  it('releases the key and returns failed when the drain throws', async () => {
    const set = jest.fn().mockResolvedValue('OK');
    const del = jest.fn().mockResolvedValue(1);
    const drain = jest.fn().mockRejectedValue(new Error('drain down'));
    const out = await maybeKickNightTicketDrain(atVancouverHour(22), EMPTY, { set, del, drain });
    expect(out).toBe('failed');
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('returns failed without draining when the set throws', async () => {
    const set = jest.fn().mockRejectedValue(new Error('redis down'));
    const del = jest.fn();
    const drain = jest.fn();
    const out = await maybeKickNightTicketDrain(atVancouverHour(22), EMPTY, { set, del, drain });
    expect(out).toBe('failed');
    expect(drain).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('skips a malformed window', async () => {
    const set = jest.fn();
    const out = await maybeKickNightTicketDrain(atVancouverHour(22), { TICKET_LANE_NIGHT_HOURS: 'nope' } as NodeJS.ProcessEnv, { set });
    expect(out).toBe('skipped');
    expect(set).not.toHaveBeenCalled();
  });

  it('a custom window kicks only at its start hour', async () => {
    const env = { TICKET_LANE_NIGHT_HOURS: '9-17' } as NodeJS.ProcessEnv;
    const set = jest.fn().mockResolvedValue('OK');
    const drain = jest.fn().mockResolvedValue(undefined);
    expect(await maybeKickNightTicketDrain(atVancouverHour(10), env, { set, drain })).toBe('skipped');
    expect(set).not.toHaveBeenCalled();
    expect(await maybeKickNightTicketDrain(atVancouverHour(9), env, { set, drain })).toBe('kicked');
    expect(drain).toHaveBeenCalledTimes(1);
  });
});

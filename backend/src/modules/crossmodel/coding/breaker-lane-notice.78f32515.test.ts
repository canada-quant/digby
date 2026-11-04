/**
 * Ticket 78f32515 — reflection.ts breaker-lane-notice unit pin.
 *
 * THE GAP: when the narrated-tool-emit loop breaker (PR #894, ticket
 * 177a31b7) trips, the DERAILED lane itself never learned why its run died —
 * the auto-filed attribution ticket lands in the SUPERVISOR's queue and the
 * attention_needed alarm reaches hook subscribers, but nothing reached the
 * lane's own next run. The #894 review accepted this as a cosmetic follow-up.
 *
 * THE FIX PINNED HERE (unit side):
 *   1. fileStreakInvestigation RETURNS the auto-filed ticket's id — both on a
 *      fresh file and on a dedupe-window hit (the NX key's value stores the
 *      id) — so the lane notice can NAME the ticket.
 *   2. writeBreakerLaneNotice / consumeBreakerLaneNotice are the one-shot
 *      Redis channel whose line the run-executor composes into the lane's
 *      next run's [SCHEDULER NOTICE] context (executor-side pin lives in
 *      run-executor.test.ts; the agent-trip wiring pin lives in
 *      agent-narr-loop-notice.78f32515.test.ts).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindUnique: jest.Mock = jest.fn();
const mockCreate: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findUnique: (...a: any[]) => mockFindUnique(...a) },
    userFeatureRequest: { create: (...a: any[]) => mockCreate(...a) },
  },
}));

const mockRedisSet: jest.Mock = jest.fn();
const mockRedisGet: jest.Mock = jest.fn();
const mockRedisDel: jest.Mock = jest.fn();
const mockRedisGetDel: jest.Mock = jest.fn();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (...a: any[]) => mockRedisSet(...a),
    get: (...a: any[]) => mockRedisGet(...a),
    del: (...a: any[]) => mockRedisDel(...a),
    getDel: (...a: any[]) => mockRedisGetDel(...a), // node-redis v4 camelCase (adversarial-review finding: getdel does not exist)
  },
}));

import {
  fileStreakInvestigation,
  writeBreakerLaneNotice,
  consumeBreakerLaneNotice,
} from './reflection';

const EV = {
  sessionId: 'sess-78f32515',
  runId: 'run-1',
  tool: 'send_chat_message',
  perma: false,
  intended: 'send_chat_message',
  recentFailures: ['Sending the window-gate relay NOW:'],
  goalHint: 'relay the window gate',
};

describe('ticket 78f32515 — fileStreakInvestigation returns the auto-filed ticket id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindUnique.mockResolvedValue({ userId: 'u1', title: 'Spark lane' });
    mockCreate.mockResolvedValue({ id: 'ticket-fresh-1' });
    mockRedisSet.mockResolvedValue('OK');
    mockRedisGet.mockResolvedValue(null);
  });

  it('fresh file: returns the created ticket id and stamps it as the dedupe value (KEEPTTL)', async () => {
    const id = await fileStreakInvestigation(EV);

    expect(id).toBe('ticket-fresh-1');
    // Window claim + id stamp, in that order.
    expect(mockRedisSet).toHaveBeenCalledTimes(2);
    expect(mockRedisSet.mock.calls[0]).toEqual([`reflect:ticket:${EV.sessionId}:${EV.tool}`, '1', { NX: true, EX: 86_400 }]);
    expect(mockRedisSet.mock.calls[1]).toEqual([`reflect:ticket:${EV.sessionId}:${EV.tool}`, 'ticket-fresh-1', { KEEPTTL: true }]);
    // The ticket itself is unchanged in shape (the mishap attribution contract).
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.type).toBe('mishap');
    expect(data.source).toBe('agent-harness');
    expect(data.title).toContain('3× tool-failure streak: send_chat_message');
  });

  it('dedupe-window hit: returns the id stored by the earlier file, no second ticket', async () => {
    mockRedisSet.mockResolvedValue(null); // NX lost — already filed in the window
    mockRedisGet.mockResolvedValue('ticket-earlier-9');

    const id = await fileStreakInvestigation(EV);

    expect(id).toBe('ticket-earlier-9');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("dedupe-window hit with a legacy '1' value (pre-id-stamp or failed create): returns null", async () => {
    mockRedisSet.mockResolvedValue(null);
    mockRedisGet.mockResolvedValue('1');

    expect(await fileStreakInvestigation(EV)).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('filing failure: returns null and never throws (attribution is best-effort)', async () => {
    mockCreate.mockRejectedValue(new Error('db down'));

    await expect(fileStreakInvestigation(EV)).resolves.toBeNull();
  });

  it('unknown session (no chat row): returns null, no id stamp', async () => {
    mockFindUnique.mockResolvedValue(null);

    expect(await fileStreakInvestigation(EV)).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRedisSet).toHaveBeenCalledTimes(1); // window claim only
  });
});

describe('ticket 78f32515 — breaker lane notice write/consume channel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('write stores ONE line naming the breaker, the streak shape, and the ticket id', async () => {
    await writeBreakerLaneNotice('sess-1', {
      breaker: 'narrated-tool-emit loop',
      tool: 'send_chat_message',
      repeats: 4,
      snippet: 'Sending the window-gate relay NOW:',
      ticketId: 'ticket-abc-123',
    });

    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const [key, line, opts] = mockRedisSet.mock.calls[0];
    expect(key).toBe('breaker:lane-notice:sess-1');
    expect(opts).toEqual({ EX: 7 * 24 * 3600 });
    expect(line).toContain('[BREAKER NOTICE]');
    expect(line).toContain('narrated-tool-emit loop');
    expect(line).toContain('"Sending the window-gate relay NOW:" 4×');
    expect(line).toContain('send_chat_message never executed');
    expect(line).toContain('ticket-abc-123');
    expect(line).toContain('re-issue it as a REAL tool call');
  });

  it('write without a ticket id still names the auto-filed ticket honestly', async () => {
    await writeBreakerLaneNotice('sess-2', {
      breaker: 'narrated-tool-emit loop',
      tool: null,
      repeats: 4,
      snippet: 'Sending it now',
      ticketId: null,
    });

    const line = mockRedisSet.mock.calls[0][1];
    expect(line).toContain('the announced tool never executed');
    expect(line).toContain('An attribution ticket was auto-filed');
    expect(line).not.toContain('undefined');
  });

  it('a Redis failure on write is swallowed (the ticket is the durable record)', async () => {
    mockRedisSet.mockRejectedValue(new Error('redis down'));
    await expect(writeBreakerLaneNotice('sess-3', {
      breaker: 'b', tool: null, repeats: 4, snippet: 's', ticketId: null,
    })).resolves.toBeUndefined();
  });

  it('consume returns the stored line exactly once (GETDEL)', async () => {
    mockRedisGetDel.mockResolvedValueOnce('[BREAKER NOTICE] stored line');

    expect(await consumeBreakerLaneNotice('sess-1')).toBe('[BREAKER NOTICE] stored line');
    expect(mockRedisGetDel).toHaveBeenCalledWith('breaker:lane-notice:sess-1');

    mockRedisGetDel.mockResolvedValueOnce(null);
    expect(await consumeBreakerLaneNotice('sess-1')).toBeNull();
  });

  it('consume falls back to GET+DEL on a pre-6.2 Redis (no GETDEL)', async () => {
    mockRedisGetDel.mockRejectedValue(new Error('ERR unknown command `GETDEL`'));
    mockRedisGet.mockResolvedValue('[BREAKER NOTICE] legacy line');

    expect(await consumeBreakerLaneNotice('sess-1')).toBe('[BREAKER NOTICE] legacy line');
    expect(mockRedisDel).toHaveBeenCalledWith('breaker:lane-notice:sess-1');
  });

  it('consume is fail-open: a Redis error reads as no notice', async () => {
    mockRedisGetDel.mockRejectedValue(new Error('redis down'));
    mockRedisGet.mockRejectedValue(new Error('redis down'));

    expect(await consumeBreakerLaneNotice('sess-1')).toBeNull();
  });
});

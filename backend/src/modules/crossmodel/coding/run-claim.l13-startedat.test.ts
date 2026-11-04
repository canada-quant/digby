/**
 * Remediation P0 item L13 (CanLaw review) — `agent_runs.startedAt` was NULL on
 * every worker-claimed run: the queued-row creators (schedule.service fast-lane
 * insert, run-state enqueue) never set it and claimNextRun didn't either; only
 * the legacy in-process createAgentRun stamped it. Fixed at CLAIM time:
 *   - the FIRST claim of a row with NULL startedAt stamps it `now`;
 *   - a RE-CLAIM (crash recovery / interrupted resume) preserves the original —
 *     startedAt means "when the run first started executing", not "latest attempt".
 *
 * Red-green: both stamping tests fail on pre-L13 code (no startedAt in the
 * claim update). Harness: run-claim.test.ts's mockPrisma scaffold.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  agentRun: {
    update: jest.fn(),
  },
  $queryRaw: jest.fn(),
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};

jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { claimNextRun } from './run-claim';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.agentRun.update.mockImplementation(async ({ data }: any) => ({
    id: 'run1', sessionId: 'sess1', status: 'running',
    checkpoint: null, input: { message: 'hi', userId: 'u1' }, inputConsumedAt: null,
    attempts: 1, error: null, ...data,
  }));
});

const queuedRow = (over: Record<string, unknown> = {}) => ({
  id: 'run1', sessionId: 'sess1', status: 'queued',
  checkpoint: null, input: { message: 'hi', userId: 'u1' }, inputConsumedAt: null,
  attempts: 0, error: null, finishedAt: null, workerId: null, startedAt: null,
  ...over,
});

describe('L13 — claimNextRun stamps startedAt', () => {
  it('the FIRST claim of a queued row (startedAt NULL) sets startedAt = claim time', async () => {
    const before = Date.now();
    mockPrisma.$queryRaw.mockResolvedValue([queuedRow()]);
    await claimNextRun('worker-abc-1');
    const data = mockPrisma.agentRun.update.mock.calls[0][0].data;
    expect(data.startedAt).toBeInstanceOf(Date);
    expect((data.startedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((data.startedAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
    // and it is the SAME instant as the heartbeat (one `now` for the claim)
    expect(data.startedAt).toEqual(data.heartbeatAt);
  });

  it('a RE-CLAIM of a crashed running row PRESERVES the original startedAt', async () => {
    const original = new Date('2026-09-08T01:02:03.000Z');
    mockPrisma.$queryRaw.mockResolvedValue([queuedRow({
      status: 'running', workerId: 'worker-abc-1', startedAt: original, attempts: 1,
    })]);
    await claimNextRun('worker-abc-1'); // same generation → attempt increments, startedAt untouched
    const data = mockPrisma.agentRun.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('startedAt');
  });

  it('an interrupted row that never got startedAt (crashed pre-fix rows) is stamped on claim', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([queuedRow({
      status: 'interrupted', finishedAt: new Date(), attempts: 1,
    })]);
    await claimNextRun('worker-abc-1');
    const data = mockPrisma.agentRun.update.mock.calls[0][0].data;
    expect(data.startedAt).toBeInstanceOf(Date);
  });
});

/**
 * Phase 3 — GET /api/crossmodel/coding/cron-status (supervision endpoint).
 *
 * Drives the REAL middleware chain (authenticate, from utils/jwt mocked) in
 * front of the REAL coding.routes → coding.controller over real HTTP (the
 * route-posture harness pattern: app.listen(0) + fetch). Postgres is mocked at
 * config/database; the 401 comes from the guard, the 200 shape from
 * cron_jobs + agent_runs rows/counts.
 */

import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import { Server } from 'http';
import { AddressInfo } from 'net';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../utils/jwt', () => ({ verifyAccessToken: jest.fn() }));

const mockPrisma: any = {
  cronJob: { findMany: jest.fn() },
  agentRun: { groupBy: jest.fn(), count: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time (via coding.controller) —
// mock AppError (same shape).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
// coding-stream.controller (same routes file) imports session-run-lock → config/redis.
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async () => 'OK'),
    get: jest.fn(async () => null),
    del: jest.fn(async () => 1),
    exists: jest.fn(async () => 0),
  },
}));

import { authenticate } from '../../../middleware/auth';
import { verifyAccessToken } from '../../../utils/jwt';
import codingRoutes from './coding.routes';

const mockedVerify = verifyAccessToken as jest.Mock;

let server: Server;
let base: string;

beforeAll(async () => {
  const app: Express = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/crossmodel', authenticate); // the single app-level guard (app.ts posture)
  app.use('/api/crossmodel', codingRoutes);
  server = app.listen(0, '127.0.0.1'); // explicit host: the fetch targets 127.0.0.1 (port-0 wildcard binds can collide across jest workers)
  await new Promise<void>((resolve) => server.on('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedVerify.mockImplementation((token: string) => {
    if (token === 'good-token') return { userId: 'u1', email: 'a@b.c', role: 'USER' };
    throw new Error('bad token');
  });
});

describe('GET /api/crossmodel/coding/cron-status', () => {
  it('401s without a token (the app-level guard)', async () => {
    const res = await fetch(`${base}/api/crossmodel/coding/cron-status`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No token provided' });
    expect(mockPrisma.cronJob.findMany).not.toHaveBeenCalled();
  });

  it('returns the cron_jobs rows + agent_runs counts shape when authenticated', async () => {
    const jobs = [
      { id: 'feed-refresh', intervalSec: 120, nextRunAt: new Date(), lastFiredAt: new Date(), lastStatus: 'ok', leaseExpiresAt: null, workerId: null, enabled: true, createdAt: new Date(), updatedAt: new Date() },
      { id: 'news-prefetch', intervalSec: 900, nextRunAt: new Date(), lastFiredAt: null, lastStatus: null, leaseExpiresAt: null, workerId: null, enabled: true, createdAt: new Date(), updatedAt: new Date() },
    ];
    mockPrisma.cronJob.findMany.mockResolvedValue(jobs);
    mockPrisma.agentRun.groupBy.mockResolvedValue([
      { status: 'queued', _count: { _all: 2 } },
      { status: 'running', _count: { _all: 1 } },
    ]);
    mockPrisma.agentRun.count
      .mockResolvedValueOnce(3)  // failed last 24h
      .mockResolvedValueOnce(7); // completed last 24h

    const res = await fetch(`${base}/api/crossmodel/coding/cron-status`, {
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.jobs).toHaveLength(2);
    expect(body.data.jobs.map((j: any) => j.id)).toEqual(['feed-refresh', 'news-prefetch']);
    expect(body.data.jobs[0].intervalSec).toBe(120);
    expect(body.data.runs).toEqual({
      queued: 2, running: 1, interrupted: 0, failedLast24h: 3, completedLast24h: 7,
    });

    // The live-status groupBy is restricted to the claimable statuses.
    const [groupArgs] = mockPrisma.agentRun.groupBy.mock.calls[0];
    expect(groupArgs.where.status).toEqual({ in: ['queued', 'running', 'interrupted'] });
  });

  it('a missing status group reads as zero', async () => {
    mockPrisma.cronJob.findMany.mockResolvedValue([]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([]);
    mockPrisma.agentRun.count.mockResolvedValue(0);

    const res = await fetch(`${base}/api/crossmodel/coding/cron-status`, {
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data).toEqual({
      jobs: [],
      runs: { queued: 0, running: 0, interrupted: 0, failedLast24h: 0, completedLast24h: 0 },
    });
  });
});

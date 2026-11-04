/**
 * Pins the fleet pulse: admin gating of the shipping/queue sections, the
 * guard-health derivation, Redis caching, and that a GitHub outage degrades
 * to shipping:null (never throws).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 500) { super(message); this.statusCode = statusCode; }
  },
}));

const mockPrisma: any = {
  userFeatureRequest: {
    groupBy: jest.fn(async () => [
      { status: 'open', _count: { _all: 3 } },
      { status: 'in_progress', _count: { _all: 1 } },
      { status: 'done', _count: { _all: 100 } },
    ]),
    count: jest.fn(async () => 7),
    findMany: jest.fn(async () => [
      { id: 't1', title: 'A ticket', status: 'open', type: 'bug_report', source: 'user', createdAt: new Date() },
    ]),
  },
  runJournalEntry: {
    findMany: jest.fn(async () => [{ createdAt: new Date('2026-08-24T00:00:00Z') }]),
    findFirst: jest.fn(async () => ({ createdAt: new Date('2026-08-20T00:00:00Z') })),
  },
  // The guard tile's receipts rollup is RAW SQL (review 2026-09-25 — the
  // Prisma JSON-path NOT filter is NULL-unsafe and zeroed the tile); the tagged
  // template arrives as (strings, ...values).
  $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('r."ok" AS ok')) return [{ ok: true, n: 40 }, { ok: false, n: 2 }];
    if (sql.includes('r."tool" AS tool')) return [{ tool: 'run_command', n: 25 }, { tool: 'git_commit', n: 9 }, { tool: 'verify', n: 6 }];
    return [];
  }),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedis = { get: jest.fn(async (): Promise<string | null> => null), set: jest.fn(async () => 'OK') };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockGetValidToken = jest.fn(async (): Promise<string | null> => 'gh-token');
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: (...a: any[]) => (mockGetValidToken as any)(...a) }));

// fetch: GitHub API stub
const realFetch = global.fetch;
const mockFetch = jest.fn();
beforeAll(() => { (global as any).fetch = mockFetch; });
afterAll(() => { (global as any).fetch = realFetch; });

import { getFleetPulse } from './fleet.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.get.mockResolvedValue(null);
  mockGetValidToken.mockResolvedValue('gh-token');
  mockFetch.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => String(url).includes('/pulls')
      ? [
          { number: 340, title: 'closures', state: 'closed', merged_at: new Date().toISOString(), created_at: new Date().toISOString() },
          { number: 341, title: 'wip', state: 'open', merged_at: null, created_at: new Date().toISOString() },
        ]
      : { workflow_runs: [{ status: 'completed', conclusion: 'success', created_at: new Date().toISOString(), html_url: 'https://github.com/x/runs/1' }] },
  }));
});

describe('getFleetPulse', () => {
  it('ADMIN gets shipping + queue + guard; sections populated', async () => {
    const p = await getFleetPulse('user-admin-000', 'ADMIN');
    expect(p.shipping).not.toBeNull();
    expect(p.shipping!.mergedToday).toBe(1);
    expect(p.shipping!.openPrs).toBe(1);
    expect(p.shipping!.latestDeploy?.conclusion).toBe('success');
    expect(p.queue).toEqual(expect.objectContaining({ open: 3, inProgress: 1, doneToday: 7, doneTotal: 100 }));
    expect(p.queue!.openList).toHaveLength(1);
    expect(p.guard!.catches24h).toBe(1);
    // Receipts rollup: 24h totals + failures + top tools from the grouped counts.
    expect(p.guard!.receipts).toEqual({
      total24h: 42, failed24h: 2, topTools24h: ['run_command', 'git_commit', 'verify'],
    });
  });

  it('guard receipts: the staged-row exclusion is NULL-SAFE — jsonb containment (@>), never the #> path filter that drops every row without a `staged` key', async () => {
    await getFleetPulse('user-admin-010', 'ADMIN');
    const receiptSqls = mockPrisma.$queryRaw.mock.calls
      .map((c: any[]) => (c[0] as TemplateStringsArray).join('?'))
      .filter((sql: string) => sql.includes('"run_tool_receipts"'));
    expect(receiptSqls).toHaveLength(2);
    for (const sql of receiptSqls) {
      // `ids @> '{"staged":true}'` is false (not NULL) when the key is absent, so
      // NOT(...) keeps every ordinary executed/failed receipt.
      expect(sql).toContain(`NOT (r."ids" @> '{"staged":true}'::jsonb)`);
      expect(sql).not.toContain('#>');
      expect(sql).not.toMatch(/=\s*'true'/);
      expect(sql).toContain('r."createdAt" >= ?');
    }
    // Both queries bind the same `since` Date (the only parameter).
    for (const c of mockPrisma.$queryRaw.mock.calls) {
      if ((c[0] as TemplateStringsArray).join('?').includes('"run_tool_receipts"')) expect(c[1]).toBeInstanceOf(Date);
    }
  });

  it('non-admin gets NO framework internals — shipping/queue/guard all null (no global-queue, repo or evidence-guard exposure, ticket 24dd04d5)', async () => {
    const p = await getFleetPulse('user-plain-000', 'USER');
    expect(p.shipping).toBeNull();
    expect(p.queue).toBeNull();
    expect(p.guard).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    // The guard lanes never ran for a non-admin: no journal read, no receipt rollup.
    expect(mockPrisma.runJournalEntry.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('GitHub outage degrades shipping to null, never throws', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const p = await getFleetPulse('user-admin-001', 'ADMIN');
    expect(p.shipping).toBeNull();
    expect(p.queue).not.toBeNull(); // queue is DB-backed, unaffected
  });

  it('no GitHub token → shipping null', async () => {
    mockGetValidToken.mockResolvedValue(null);
    const p = await getFleetPulse('user-admin-002', 'ADMIN');
    expect(p.shipping).toBeNull();
  });

  it('serves the Redis cache when warm (no DB/GitHub hit)', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ generatedAt: 'x', shipping: null, queue: null, guard: { catches24h: 0, lastCatchAt: null } }));
    const p = await getFleetPulse('user-admin-003', 'ADMIN');
    expect(p.generatedAt).toBe('x');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockPrisma.userFeatureRequest.groupBy).not.toHaveBeenCalled();
  });

  it('guard: zero catches in 24h falls back to the all-time last catch (ADMIN — guard internals are admin-only, ticket 24dd04d5)', async () => {
    mockPrisma.runJournalEntry.findMany.mockResolvedValue([]);
    const p = await getFleetPulse('user-admin-004', 'ADMIN');
    expect(p.guard!.catches24h).toBe(0);
    expect(p.guard!.lastCatchAt).toBe('2026-08-20T00:00:00.000Z');
  });

  it('guard: a receipts-rollup DB error OMITS the field — the pulse never throws (ADMIN)', async () => {
    // Re-establish the journal lane's default (a prior test overrode it — mock
    // implementations persist across clearAllMocks).
    mockPrisma.runJournalEntry.findMany.mockResolvedValue([{ createdAt: new Date('2026-08-24T00:00:00Z') }]);
    mockPrisma.$queryRaw
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'));
    const p = await getFleetPulse('user-admin-005', 'ADMIN');
    expect(p.guard!.catches24h).toBe(1); // the journal lane is unaffected
    expect(p.guard!.lastCatchAt).toBe('2026-08-24T00:00:00.000Z');
    expect(p.guard!.receipts).toBeUndefined();
    expect(Object.keys(p.guard!)).not.toContain('receipts');
  });
});

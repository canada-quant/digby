/**
 * memListRefStats (fs-code-knowledge review fix, 2026-10-23): the code index's
 * tiered row cap plans whole-file evictions from per-ref row counts + the
 * newest row's age. Pins the query shape (scope + source, grouped by ref,
 * bounded) and that an unreadable store is null — never "no rows".
 */
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { $executeRawUnsafe: jest.fn(async () => 0), $queryRawUnsafe: jest.fn(async () => []) },
}));
jest.mock('../rag.service', () => ({ __esModule: true, embedTexts: jest.fn(async () => []), rerankTexts: jest.fn(async () => []) }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS: {} }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import prisma from '../../../config/database';
import { memListRefStats } from './unified-memory.service';

const mockQuery = prisma.$queryRawUnsafe as jest.Mock;

describe('memListRefStats', () => {
  beforeEach(() => mockQuery.mockReset());

  it('groups the (scope, source) rows by ref with their count and newest created_at', async () => {
    mockQuery.mockImplementation(async (sql: string) => (/GROUP BY ref/.test(sql)
      ? [{ ref: 'src/a.ts', n: BigInt(3), newest: new Date('2026-10-20T00:00:00Z') }, { ref: 'src/b.test.ts', n: 1, newest: '2026-10-21T00:00:00Z' }, { ref: null, n: 2, newest: null }]
      : []));
    const out = await memListRefStats({ type: 'project', id: 'p1' }, 'code', 70);
    expect(out).toEqual([
      { ref: 'src/a.ts', rows: 3, newestMs: Date.parse('2026-10-20T00:00:00Z') },
      { ref: 'src/b.test.ts', rows: 1, newestMs: Date.parse('2026-10-21T00:00:00Z') },
      { ref: '', rows: 2, newestMs: 0 },
    ]);
    const call = mockQuery.mock.calls.find(c => /GROUP BY ref/.test(c[0]));
    expect(call[0]).toContain('MAX(created_at) AS newest');
    expect(call[0]).toContain('WHERE scope_type = $1 AND scope_id = $2 AND source = $3');
    expect(call[0]).toContain('LIMIT 70');
    expect(call.slice(1)).toEqual(['project', 'p1', 'code']);
  });

  it('an unreadable store answers null', async () => {
    mockQuery.mockImplementation(async (sql: string) => { if (/GROUP BY ref/.test(sql)) throw new Error('db down'); return []; });
    expect(await memListRefStats({ type: 'project', id: 'p1' }, 'code')).toBeNull();
  });
});

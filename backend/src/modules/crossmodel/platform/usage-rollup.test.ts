// Supervisor side-panel usage rollups (2026-10-08) — ./usage-rollup.ts.
const db = { $queryRawUnsafe: jest.fn(), crossModelChat: { findMany: jest.fn() }, crossModelProject: { findMany: jest.fn() } };
jest.mock('../../../config/database', () => ({ __esModule: true, default: db }));
import { fleetUsage, projectUsage, summarizeUsage, USAGE_DAILY_DAYS } from './usage-rollup';

const now = new Date('2026-10-08T15:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
beforeEach(() => jest.resetAllMocks());

describe('summarizeUsage', () => {
  it('splits today / 7 d / 30 d by UTC day and keeps a dense 14-day series', () => {
    const s = summarizeUsage([
      { kind: 'run_spend', day: day('2026-10-08'), key: 'a', v: 1.5 },
      { kind: 'run_tokens_in', day: day('2026-10-08'), key: 'a', v: 1000 },
      { kind: 'run_tokens_out', day: day('2026-10-08'), key: 'a', v: 200 },
      { kind: 'run_spend', day: day('2026-10-02'), key: 'b', v: 2 },     // 6 days ago → in 7 d
      { kind: 'run_spend', day: day('2026-10-01'), key: 'b', v: 4 },     // 7 days ago → 30 d only
      { kind: 'run_spend', day: day('2026-09-20'), key: 'a', v: 8 },
    ], now);
    expect(s.today).toEqual({ usd: 1.5, tokensIn: 1000, tokensOut: 200 });
    expect(s.d7.usd).toBe(3.5);
    expect(s.d30.usd).toBe(15.5);
    expect(s.daily).toHaveLength(USAGE_DAILY_DAYS);
    expect(s.daily[s.daily.length - 1]).toEqual({ date: '2026-10-08', usd: 1.5, tokens: 1200 });
    expect(s.daily[0].date).toBe('2026-09-25');
    expect(s.byKey.get('b')?.d7.usd).toBe(2);
    expect(s.byKey.get('a')?.d30.usd).toBe(9.5);
  });
});

describe('endpoints', () => {
  it('project usage is scoped to the project + owner, and names its top chats', async () => {
    db.$queryRawUnsafe.mockResolvedValueOnce([
      { kind: 'run_spend', day: day('2026-10-08'), key: 'lane-1', v: 3 },
      { kind: 'run_spend', day: day('2026-10-07'), key: 'lane-2', v: 1 },
    ]);
    db.crossModelChat.findMany.mockResolvedValueOnce([{ id: 'lane-1', title: 'node-a 64K · bench' }, { id: 'lane-2', title: null }]);
    const u = await projectUsage('p1', 'owner-1', now);
    const [sql, ...params] = db.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('c."projectId" = $1 AND c."userId" = $2');
    expect(params.slice(0, 2)).toEqual(['p1', 'owner-1']);
    expect(u.today.usd).toBe(3);
    expect(u.topChats.map(t => [t.chatId, t.title, t.usd7d])).toEqual([['lane-1', 'node-a 64K · bench', 3], ['lane-2', null, 1]]);
  });

  it('fleet usage groups per project with the project supervisor chat to open', async () => {
    db.$queryRawUnsafe.mockResolvedValueOnce([
      { kind: 'run_spend', day: day('2026-10-08'), key: 'p1', v: 5 },
      { kind: 'run_spend', day: day('2026-10-06'), key: null, v: 0.5 },
    ]);
    db.crossModelProject.findMany.mockResolvedValueOnce([{ id: 'p1', name: 'Spark cluster' }]);
    db.crossModelChat.findMany.mockResolvedValueOnce([{ id: 'sup-1', projectId: 'p1' }]);
    const u = await fleetUsage('u1', now);
    expect(db.$queryRawUnsafe.mock.calls[0][0]).toContain('c."userId" = $1');
    expect(u.projects).toEqual([
      { projectId: 'p1', name: 'Spark cluster', supervisorChatId: 'sup-1', usdToday: 5, usd7d: 5, tokens7d: 0 },
      { projectId: null, name: 'No project', supervisorChatId: null, usdToday: 0, usd7d: 0.5, tokens7d: 0 },
    ]);
    expect(u.d7.usd).toBe(5.5);
  });
});

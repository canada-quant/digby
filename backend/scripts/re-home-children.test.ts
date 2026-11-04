/**
 * re-home-children (misfiled-spawns-3) — the planner is pure; the apply path is
 * exercised over an in-memory fake that records SQL + params and runs the
 * transaction callback against itself.
 */

import { planRehome, parseArgs, applyMove, main, ChatRow, RehomeDb } from './re-home-children';

const TARGET = 'e5734bd2-7c44-4895-8204-84e456918f18';
const row = (over: Partial<ChatRow>): ChatRow => ({
  id: 'x', title: 't', projectId: '47f9de59', parentChatId: 'b92ef13f', archivedAt: new Date('2026-09-20'),
  isSupervisor: false, isProjectSupervisor: false, codingProjectId: '47f9de59', codingStatus: 'archived', ...over,
});

class FakeDb implements RehomeDb {
  rows: ChatRow[];
  executes: Array<{ sql: string; values: unknown[] }> = [];
  txDepth = 0;
  constructor(rows: ChatRow[]) { this.rows = rows; }
  async $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> {
    if (!sql.includes('FROM "crossmodel_chats" c')) throw new Error(`unexpected query: ${sql}`);
    const ids = values[0] as string[];
    return this.rows.filter((r) => ids.includes(r.id)) as unknown as T;
  }
  async $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> {
    if (this.txDepth === 0) throw new Error('write outside a transaction');
    this.executes.push({ sql, values });
    return 1;
  }
  async $transaction<T>(fn: (tx: RehomeDb) => Promise<T>): Promise<T> {
    this.txDepth += 1;
    try { return await fn(this); } finally { this.txDepth -= 1; }
  }
  async $disconnect() { /* noop */ }
}

describe('planRehome', () => {
  it('moves archived / idle coding children (chat + satellite) and plain chats; refuses supervisors, live sessions, unknown ids and no-ops', () => {
    const rows = [
      row({ id: 'f0429496' }),
      row({ id: '299ad15f', codingProjectId: null, codingStatus: null, parentChatId: null }),
      row({ id: 'running1', codingStatus: 'running' }),
      row({ id: 'prov1', codingStatus: 'provisioning' }),
      row({ id: 'sup1', isProjectSupervisor: true }),
      row({ id: 'there1', projectId: TARGET, codingProjectId: TARGET }),
    ];
    const plan = planRehome(['f0429496', '299ad15f', 'running1', 'prov1', 'sup1', 'there1', 'ghost'], rows, TARGET, { f0429496: 'Adversarial review: ticket c7bf1e66 (PR #838)' });
    expect(plan.moves).toEqual([
      { id: 'f0429496', from: '47f9de59', codingFrom: '47f9de59', hasSatellite: true, title: 'Adversarial review: ticket c7bf1e66 (PR #838)' },
      { id: '299ad15f', from: '47f9de59', codingFrom: null, hasSatellite: false },
    ]);
    expect(plan.refusals.map((r) => r.id)).toEqual(['running1', 'prov1', 'sup1', 'there1', 'ghost']);
    expect(plan.refusals.find((r) => r.id === 'running1')!.reason).toContain('running');
    expect(plan.refusals.find((r) => r.id === 'there1')!.reason).toContain('no-op');
  });

  it('a chat already in the target still moves when a title is requested (rename-only)', () => {
    const plan = planRehome(['a'], [row({ id: 'a', projectId: TARGET, codingProjectId: TARGET })], TARGET, { a: 'New title' });
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0].title).toBe('New title');
  });
});

describe('parseArgs', () => {
  it('parses target, ids, --apply and repeatable --title=<id>:<title>', () => {
    expect(parseArgs([`--target=${TARGET}`, 'a', 'b', '--title=a:Hello: world', '--apply'])).toEqual({
      target: TARGET, ids: ['a', 'b'], apply: true, titles: { a: 'Hello: world' },
    });
    expect(() => parseArgs(['a'])).toThrow('--target');
    expect(() => parseArgs([`--target=${TARGET}`])).toThrow('at least one chat id');
    expect(() => parseArgs([`--target=${TARGET}`, 'a', '--bogus'])).toThrow('unknown flag');
  });
});

describe('applyMove + main', () => {
  it('applyMove updates the chat row and the satellite inside ONE transaction; a plain chat touches only the chat row', async () => {
    const db = new FakeDb([]);
    await applyMove(db, { id: 'f0429496', from: '47f9de59', codingFrom: '47f9de59', hasSatellite: true, title: 'T' }, TARGET);
    expect(db.executes.map((e) => e.sql.slice(0, 32))).toEqual(['UPDATE "crossmodel_chats" SET "p', 'UPDATE "coding_sessions" SET "pr']);
    expect(db.executes[0].values).toEqual([TARGET, 'T', 'f0429496']);
    expect(db.executes[1].values).toEqual([TARGET, 'f0429496']);

    const db2 = new FakeDb([]);
    await applyMove(db2, { id: '299ad15f', from: '47f9de59', codingFrom: null, hasSatellite: false }, TARGET);
    expect(db2.executes).toHaveLength(1);
    expect(db2.executes[0].values).toEqual([TARGET, '299ad15f']);
  });

  it('main is a DRY-RUN by default (prints the plan, writes nothing); --apply writes every planned move and skips refusals', async () => {
    const rows = [row({ id: 'f0429496' }), row({ id: 'running1', codingStatus: 'running' })];
    const db = new FakeDb(rows);
    const out: string[] = [];
    expect(await main([`--target=${TARGET}`, 'f0429496', 'running1'], db, (s) => out.push(s))).toBe(0);
    expect(db.executes).toHaveLength(0);
    expect(out.join('\n')).toContain('PLAN f0429496: 47f9de59 → ' + TARGET);
    expect(out.join('\n')).toContain('SKIP running1');
    expect(out.join('\n')).toContain('dry-run');

    out.length = 0;
    expect(await main([`--target=${TARGET}`, 'f0429496', 'running1', '--apply'], db, (s) => out.push(s))).toBe(0);
    expect(db.executes).toHaveLength(2); // chat + satellite for the one move; the running row untouched
    expect(db.executes.every((e) => e.values.includes('f0429496'))).toBe(true);
    expect(out.join('\n')).toContain('applied 1 move(s), 1 skipped');
  });
});

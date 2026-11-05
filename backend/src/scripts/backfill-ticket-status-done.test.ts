/**
 * scripts/framework-audit/backfill-ticket-status-done.js — the audit-T8
 * one-shot on a MOCKED Prisma client: dry-run by default (lists the legacy
 * rows, writes nothing), --apply folds them to 'done' with the previous value
 * kept on the row's context, a row whose status moved between read and write
 * is skipped (never overwritten), --revert restores from the marker and drops
 * it, and --from validates against the legacy set.
 */
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'backfill-ticket-status-done.js'));

type Row = { id: string; status: string; source: string; title: string; context: any; createdAt: Date };

/** An in-memory Prisma double covering exactly the calls the script makes. */
function makePrisma(rows: Row[]) {
  const prisma: any = {
    rows,
    userFeatureRequest: {
      findMany: jest.fn(async ({ where, take }: any) => {
        let out = rows.filter((r) => (where.status?.in ? where.status.in.includes(r.status) : r.status === where.status));
        out = out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        if (typeof take === 'number') out = out.slice(0, take);
        return out.map((r) => ({ ...r, context: r.context === undefined ? null : JSON.parse(JSON.stringify(r.context)) }));
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id && r.status === where.status);
        if (!row) return { count: 0 };
        row.status = data.status;
        if (data.context !== undefined) row.context = data.context;
        return { count: 1 };
      }),
    },
  };
  return prisma;
}

const legacyRows = (): Row[] => [
  { id: 'd256f6ec-1', status: 'resolved', source: 'user', title: 'status meta ticket', context: null, createdAt: new Date('2026-04-02') },
  { id: '3bc62de8-2', status: 'resolved', source: 'agent', title: 'P5 publish gates', context: { sessionId: 's1' }, createdAt: new Date('2026-09-09') },
  { id: '11111111-3', status: 'closed', source: 'agent', title: 'an older spelling', context: { area: 'x' }, createdAt: new Date('2026-08-01') },
  { id: '22222222-4', status: 'done', source: 'agent', title: 'already canonical', context: {}, createdAt: new Date('2026-09-01') },
  { id: '33333333-5', status: 'open', source: 'user', title: 'live', context: null, createdAt: new Date('2026-09-28') },
];

describe('backfill-ticket-status-done.js', () => {
  it('parseArgs: dry-run default, --from validation, legacy shorthand, limit check', () => {
    expect(script.parseArgs([])).toMatchObject({ apply: false, revert: false, from: ['resolved'], limit: null });
    expect(script.parseArgs(['--apply', '--limit', '2', '--run', 'r1'])).toMatchObject({ apply: true, limit: 2, run: 'r1' });
    expect(script.parseArgs(['--from', 'resolved,closed']).from).toEqual(['resolved', 'closed']);
    expect(script.parseArgs(['--from=legacy']).from).toEqual(script.LEGACY_CLOSED);
    expect(() => script.parseArgs(['--from', 'done'])).toThrow(/target status/);
    expect(() => script.parseArgs(['--from', 'banana'])).toThrow(/not a legacy closed status/);
    expect(() => script.parseArgs(['--bogus'])).toThrow(/unknown argument/);
    expect(() => script.parseArgs(['--limit', '-1'])).toThrow(/--limit/);
  });

  it('dry run (default): reports the resolved rows only and writes nothing', async () => {
    const rows = legacyRows();
    const prisma = makePrisma(rows);
    const report = await script.run({ prisma, argv: [] });
    expect(report).toMatchObject({ action: 'forward', apply: false, dryRun: true, from: ['resolved'], candidates: 2, wouldUpdate: 2 });
    expect(report.byPreviousStatus).toEqual({ resolved: 2 });
    expect(report.bySource).toEqual({ user: 1, agent: 1 });
    expect(report.rows.map((r: any) => r.id)).toEqual(['d256f6ec-1', '3bc62de8-2']);
    expect(prisma.userFeatureRequest.updateMany).not.toHaveBeenCalled();
    expect(rows.filter((r) => r.status === 'resolved')).toHaveLength(2);
  });

  it('--apply folds to done, keeps the previous status on context.statusBackfill, leaves other rows alone', async () => {
    const rows = legacyRows();
    const prisma = makePrisma(rows);
    const report = await script.run({ prisma, argv: ['--apply', '--run', 'run-1'] });
    expect(report).toMatchObject({ apply: true, updated: 2, skippedChanged: 0 });
    const a = rows.find((r) => r.id === 'd256f6ec-1')!;
    const b = rows.find((r) => r.id === '3bc62de8-2')!;
    expect(a.status).toBe('done');
    expect(a.context).toMatchObject({ statusBackfill: { previous: 'resolved', run: 'run-1' } });
    expect(typeof a.context.statusBackfill.at).toBe('string');
    expect(b.context).toMatchObject({ sessionId: 's1', statusBackfill: { previous: 'resolved' } }); // prior context kept
    expect(rows.find((r) => r.id === '11111111-3')!.status).toBe('closed'); // not in --from
    expect(rows.find((r) => r.id === '33333333-5')!.status).toBe('open');
    // every write is guarded on the status we read
    for (const call of prisma.userFeatureRequest.updateMany.mock.calls) expect(call[0].where.status).toBe('resolved');
  });

  it('--from legacy --apply folds every legacy spelling; --limit caps the rows touched', async () => {
    const rows = legacyRows();
    const prisma = makePrisma(rows);
    const report = await script.run({ prisma, argv: ['--from', 'legacy', '--apply', '--limit', '2'] });
    expect(report).toMatchObject({ candidates: 2, updated: 2 });
    // oldest first: the April user row and the August 'closed' row
    expect(rows.find((r) => r.id === 'd256f6ec-1')!.status).toBe('done');
    expect(rows.find((r) => r.id === '11111111-3')!.status).toBe('done');
    expect(rows.find((r) => r.id === '3bc62de8-2')!.status).toBe('resolved');
  });

  it('a row whose status moved between the read and the write is skipped (guarded update), counted under skippedChanged', async () => {
    const rows = legacyRows();
    const prisma = makePrisma(rows);
    prisma.userFeatureRequest.findMany.mockImplementationOnce(async () => {
      const snap = rows.filter((r) => r.status === 'resolved').map((r) => ({ ...r }));
      rows.find((r) => r.id === '3bc62de8-2')!.status = 'open'; // a human reopened it meanwhile
      return snap;
    });
    const report = await script.run({ prisma, argv: ['--apply'] });
    expect(report).toMatchObject({ updated: 1, skippedChanged: 1 });
    expect(rows.find((r) => r.id === '3bc62de8-2')!.status).toBe('open');
  });

  it('--revert (dry run) counts the folded rows; --revert --apply restores the previous status and drops the marker', async () => {
    const rows = legacyRows();
    const prisma = makePrisma(rows);
    await script.run({ prisma, argv: ['--apply', '--run', 'run-2'] });
    const dry = await script.run({ prisma, argv: ['--revert'] });
    expect(dry).toMatchObject({ action: 'revert', apply: false, backfilledRows: 2, wouldRestore: 2 });
    expect(dry.byPreviousStatus).toEqual({ resolved: 2 });
    expect(rows.find((r) => r.id === 'd256f6ec-1')!.status).toBe('done'); // dry run wrote nothing

    const rev = await script.run({ prisma, argv: ['--revert', '--apply'] });
    expect(rev).toMatchObject({ restored: 2, skippedChanged: 0 });
    const a = rows.find((r) => r.id === 'd256f6ec-1')!;
    const b = rows.find((r) => r.id === '3bc62de8-2')!;
    expect(a.status).toBe('resolved');
    expect(a.context).toEqual({});
    expect(b.status).toBe('resolved');
    expect(b.context).toEqual({ sessionId: 's1' });
    expect(rows.find((r) => r.id === '22222222-4')!.status).toBe('done'); // a genuine done row is never touched
  });
});

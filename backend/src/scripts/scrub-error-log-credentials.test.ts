/**
 * scripts/framework-audit/scrub-error-log-credentials.js — the T7 (2026-09-28)
 * retro scrub of app_error_logs on a MOCKED Prisma client: dry-run by default
 * (hit list, no writes, never the token), --apply guarded by the message we
 * read, message / stack / context string leaves rewritten, filters narrow the
 * candidate query, and the Postgres regex mirrors the runtime mask.
 */
import path from 'path';
import { redactUrlCredentials, hasUrlCredentials } from '../utils/redact-credentials';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'scrub-error-log-credentials.js'));

// FAKE fixtures — structurally valid shapes only.
const FAKE_GHO = 'gho_' + 'FAKEfakeFAKEfakeFAKEfakeFAKEfake3456';
const AUTHED = `https://x-access-token:${FAKE_GHO}@github.com/example-org/cql-accelerator.git`;
const MIRROR_MSG = `coding workspace: mirror fetch failed for 922fd3ad (using cache): Command failed: git remote set-url origin ${AUTHED}\nerror: No such remote 'origin'`;

type Row = { id: string; message: string; stack: string | null; context: any; createdAt: Date };

function makePrisma(rows: Row[], opts: { moveOnWrite?: boolean } = {}) {
  const prisma: any = {
    rows,
    $queryRawUnsafe: jest.fn(async (_sql: string, ..._params: any[]) => rows
      .filter((r) => hasUrlCredentials(r.message) || hasUrlCredentials(r.stack) || hasUrlCredentials(JSON.stringify(r.context ?? '')))
      .map((r) => ({ ...r, context: r.context === null ? null : JSON.parse(JSON.stringify(r.context)) }))),
    appErrorLog: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) return { count: 0 };
        if (opts.moveOnWrite) row.message = 'moved';
        if (row.message !== where.message) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  return prisma;
}

function fixtures(): Row[] {
  return [
    { id: 'row-dirty-0001', message: MIRROR_MSG, stack: null, context: null, createdAt: new Date('2026-08-20T09:54:00Z') },
    { id: 'row-dirty-0002', message: 'session history sync: project p failed', stack: `Error: fatal: unable to access ${AUTHED}\n    at x`, context: { err: { message: `push to ${AUTHED} refused` }, url: 'https://github.com/a/b' }, createdAt: new Date('2026-09-28T19:07:00Z') },
    { id: 'row-clean-0003', message: 'plain warning https://github.com/example-org/repo', stack: null, context: { a: 1 }, createdAt: new Date('2026-09-28T19:08:00Z') },
  ];
}

describe('scrub-error-log-credentials.js — parseArgs + SQL regex', () => {
  it('dry-run by default; options validate', () => {
    expect(script.parseArgs([])).toMatchObject({ apply: false, since: null, limit: 5000, id: null, showMasked: false });
    expect(script.parseArgs(['--apply', '--since', '2026-09-01T00:00:00Z', '--limit', '10', '--id', 'row-dirty', '--show-masked'])).toMatchObject({ apply: true, since: '2026-09-01T00:00:00Z', limit: 10, id: 'row-dirty', showMasked: true });
    expect(() => script.parseArgs(['--since', 'yesterday'])).toThrow(/ISO/);
    expect(() => script.parseArgs(['--limit', '0'])).toThrow(/positive/);
    expect(() => script.parseArgs(['--id', 'abc'])).toThrow(/at least 8/);
    expect(() => script.parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });

  it('the Postgres regex mirrors the runtime mask (as a JS regex over the same shapes)', () => {
    const re = new RegExp(script.USERINFO_SQL_RE.replace('[:space:]', '\\s'));
    expect(re.test(AUTHED)).toBe(true);
    expect(re.test('https://alice:pw@example.com')).toBe(true);
    expect(re.test('https://github.com/example-org/repo')).toBe(false);
    expect(re.test('mail paul@example.com')).toBe(false);
  });

  it('maskedSpans masks the userinfo (first 3 + *** + last 2)', () => {
    expect(script.maskedSpans('message', MIRROR_MSG)).toEqual([`message: url userinfo x-a***${FAKE_GHO.slice(-2)}`]);
    expect(script.maskSpan('short')).toBe('***');
  });
});

describe('scrub-error-log-credentials.js — run', () => {
  it('dry run: candidates + hit list, NO writes, no token in the output', async () => {
    const rows = fixtures();
    const prisma = makePrisma(rows);
    const out = await script.run({ prisma, argv: ['--show-masked'], redact: redactUrlCredentials, hasCredentials: hasUrlCredentials });
    expect(out.apply).toBe(false);
    expect(out.errorLogs).toMatchObject({ candidates: 2, rowsWithHits: 2, updated: 0, skippedChanged: 0 });
    expect(out.errorLogs.hits).toEqual([
      { id: 'row-dirty-0001', createdAt: '2026-08-20T09:54:00.000Z', fields: ['message'], masked: [expect.stringMatching(/^message: url userinfo x-a\*\*\*/)] },
      { id: 'row-dirty-0002', createdAt: '2026-09-28T19:07:00.000Z', fields: ['stack', 'context'], masked: expect.arrayContaining([expect.stringMatching(/^stack: url userinfo/), expect.stringMatching(/^context: url userinfo/)]) },
    ]);
    expect(prisma.appErrorLog.updateMany).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain(FAKE_GHO);
    expect(rows[0].message).toContain(FAKE_GHO); // untouched
  });

  it('--since / --limit / --id ride the candidate query as bound parameters', async () => {
    const prisma = makePrisma(fixtures());
    await script.run({ prisma, argv: ['--since', '2026-09-01T00:00:00Z', '--limit', '7', '--id', 'row-dirty-0002'], redact: redactUrlCredentials, hasCredentials: hasUrlCredentials });
    const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM app_error_logs WHERE/);
    expect(sql).toMatch(/"createdAt" >= \$2/);
    expect(sql).toMatch(/"id"::text LIKE \$3/);
    expect(sql).toMatch(/LIMIT \$4/);
    expect(params[0]).toBe(script.USERINFO_SQL_RE);
    expect(params[1]).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(params[2]).toBe('row-dirty-0002%');
    expect(params[3]).toBe(7);
  });

  it('--apply rewrites message / stack / context through a message-guarded update; clean columns survive', async () => {
    const rows = fixtures();
    const prisma = makePrisma(rows);
    const out = await script.run({ prisma, argv: ['--apply'], redact: redactUrlCredentials, hasCredentials: hasUrlCredentials });
    expect(out.errorLogs).toMatchObject({ rowsWithHits: 2, updated: 2, skippedChanged: 0 });
    expect(rows[0].message).not.toContain(FAKE_GHO);
    expect(rows[0].message).toContain('https://***@github.com/example-org/cql-accelerator.git');
    expect(rows[0].message).toContain("No such remote 'origin'");
    expect(rows[1].message).toBe('session history sync: project p failed');
    expect(rows[1].stack).not.toContain(FAKE_GHO);
    expect(rows[1].context).toEqual({ err: { message: 'push to https://***@github.com/example-org/cql-accelerator.git refused' }, url: 'https://github.com/a/b' });
    expect(rows[2].message).toContain('https://github.com/example-org/repo');
    const guard = prisma.appErrorLog.updateMany.mock.calls[0][0].where;
    expect(guard).toEqual({ id: 'row-dirty-0001', message: expect.stringContaining(FAKE_GHO) });
    // Idempotent: nothing left on a second pass.
    const again = await script.run({ prisma, argv: ['--apply'], redact: redactUrlCredentials, hasCredentials: hasUrlCredentials });
    expect(again.errorLogs).toMatchObject({ candidates: 0, rowsWithHits: 0, updated: 0 });
  });

  it('a row that moved between read and write is skippedChanged, never overwritten', async () => {
    const prisma = makePrisma(fixtures(), { moveOnWrite: true });
    const out = await script.run({ prisma, argv: ['--apply'], redact: redactUrlCredentials, hasCredentials: hasUrlCredentials });
    expect(out.errorLogs).toMatchObject({ updated: 0, skippedChanged: 2 });
  });
});

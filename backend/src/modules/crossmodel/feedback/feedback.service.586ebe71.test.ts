/**
 * Replay for ticket 586ebe71 — "feedback 90-day exact-title dedup erodes
 * under volume — take:200 scan lets standing tickets duplicate at ~60-90d".
 *
 * The pre-fix exact-title dedup scanned the newest 200 candidate rows
 * (take: 200, newest-first). Once >200 newer agent rows existed, a STANDING
 * ticket fell out of the scan window and its next recurrence filed a fresh
 * duplicate row instead of bumping — eroding the "one durable row per
 * standing class" property the log-signal-sweep cron (ticket 8a66441e)
 * depends on. The same erosion sat in the closed-reopen and mishap-class
 * scans (and the sweep's isLikelyDedupBump peek, which copied the shape).
 *
 * These tests replay the erosion at DEPTH through a faithful in-memory
 * Prisma engine (take, the (orderField, id) cursor, the case-insensitive
 * title prefilter) with SAME-FAMILY noise — hundreds of OTHER log-signal
 * class rows, exactly the volume the sweep itself produces. On the pre-fix
 * code every depth test below fails (a duplicate row is created / the peek
 * says "not a bump"); on the fixed code the standing row is found on page 2
 * of the scan.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUpdate = jest.fn();
const mockCreate = jest.fn();
const mockCount = jest.fn(async () => 0);
// A faithful paged engine: implements the where clauses the dedup scans use
// (type, source, source.in, status.in, createdAt.gte, AND title
 // contains-insensitive, the (orderField,id) cursor OR), the
// [{field:'desc'},{id:'desc'}] orderBy and `take` — so a test that seeds 250
// candidates exercises the REAL pagination, not a mock that returns
// everything at once.
const rows: any[] = [];
const norm = (t: string) => String(t ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const matchesWhere = (row: any, where: any): boolean => {
  if (!where) return true;
  if (where.type && row.type !== where.type) return false;
  if (typeof where.source === 'string' && row.source !== where.source) return false;
  if (where.source && typeof where.source === 'object' && Array.isArray(where.source.in) && !where.source.in.includes(row.source)) return false;
  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  if (where.createdAt?.gte && new Date(row.createdAt) < new Date(where.createdAt.gte)) return false;
  if (Array.isArray(where.AND)) {
    for (const cond of where.AND) {
      if (cond.title?.contains !== undefined) {
        const hay = String(row.title ?? '').toLowerCase();
        if (!hay.includes(String(cond.title.contains).toLowerCase())) return false;
      }
    }
  }
  if (Array.isArray(where.OR)) {
    const ok = where.OR.some((o: any) => {
      const field = Object.keys(o).find((k) => k !== 'id');
      if (!field) return true;
      const cond = o[field];
      const rowVal = new Date(row[field]).getTime();
      if (cond && typeof cond === 'object' && cond.lt !== undefined) {
        if (rowVal < new Date(cond.lt).getTime()) return true;
      } else if (cond !== undefined) {
        if (rowVal === new Date(cond).getTime() && o.id?.lt !== undefined && String(row.id) < String(o.id.lt)) return true;
      }
      return false;
    });
    if (!ok) return false;
  }
  return true;
};
const mockPrisma: any = {
  userFeatureRequest: {
    findMany: jest.fn(async (args: any = {}) => {
      const orderField = Array.isArray(args.orderBy) ? Object.keys(args.orderBy[0] ?? {})[0] : 'createdAt';
      const sorted = rows
        .filter((r) => matchesWhere(r, args.where))
        .sort((a, b) => {
          const av = new Date(a[orderField]).getTime();
          const bv = new Date(b[orderField]).getTime();
          if (av !== bv) return bv - av; // desc
          return String(b.id) < String(a.id) ? -1 : String(b.id) > String(a.id) ? 1 : 0; // id desc
        });
      return sorted.slice(0, args.take ?? sorted.length).map((r) => ({ ...r }));
    }),
    count: mockCount,
    create: mockCreate,
    update: mockUpdate,
    updateMany: jest.fn(async () => ({ count: 0 })),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  },
  user: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockDrainOpenTicketsToLane = jest.fn(async () => ({ result: 'sent', batched: 1 }));
const mockReleaseTicketDispatchClaim = jest.fn(async () => undefined);
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: (...a: any[]) => (mockDrainOpenTicketsToLane as any)(...a),
  dispatchTicketToLane: jest.fn(async () => 'sent'),
  releaseTicketDispatchClaim: (...a: any[]) => (mockReleaseTicketDispatchClaim as any)(...a),
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

import {
  DEDUP_SCAN_PAGE,
  dedupPrefilterToken,
  fileFeedbackTicket,
  wouldExactTitleDedupBump,
} from './feedback.service';

const STANDING_TITLE = 'log-signal: boot loop on box C (x3 per hour)';
const FILING = {
  userId: 'u1',
  type: 'bug_report',
  title: STANDING_TITLE, // the weekly sweep re-files the SAME stable title
  description: 'Recurring warn fingerprint re-seen by the sweep.',
  context: { sessionId: 'sweep-1', surface: 'coding', filedAt: '2026-10-18T00:00:00.000Z' },
};

let seq = 0;
/**
 * N SAME-FAMILY noise rows NEWER than the standing row — other log-signal
 * classes (they contain the prefilter token 'signal' but never normalize to
 * the standing title). This is exactly the volume the sweep itself produces:
 * ~60-90 days of hourly sweeps over many standing classes.
 */
const seedNoise = (n: number, opts: { type?: string; status?: string } = {}) => {
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.now() - 1000 - (n - i) * 1000);
    rows.push({
      id: `noise-${String(++seq).padStart(4, '0')}`,
      type: opts.type ?? 'bug_report', source: 'agent', status: opts.status ?? 'open', priority: 1,
      title: `log-signal: unrelated warn class number ${i} on box D`,
      description: 'noise', context: {},
      createdAt: at,
      updatedAt: at,
    });
  }
};
const seedStanding = (overrides: Record<string, unknown> = {}) => {
  const at = new Date(Date.now() - 80 * 24 * 3600_000); // 80d old — inside the 90d window, OLDEST row
  const row = {
    id: 'standing-0001',
    type: 'bug_report', source: 'agent', status: 'open', priority: 2,
    title: STANDING_TITLE,
    description: 'Original fingerprint report.',
    context: { sessionId: 'sweep-0', occurrences: 3 },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
  rows.push(row);
  return row;
};

beforeEach(() => {
  rows.length = 0;
  seq = 0;
  jest.clearAllMocks();
  mockCreate.mockImplementation(async ({ data }: any) => ({ id: 'fresh-duplicate', ...data }));
  mockUpdate.mockImplementation(async ({ where, data }: any) => {
    const row = rows.find((r) => r.id === where.id);
    return { ...row, ...data };
  });
});

describe('ticket 586ebe71 — the 90-day exact-title dedup must not erode under volume', () => {
  it('a standing OPEN ticket 250 same-family rows deep still BUMPS instead of duplicating (the erosion replay)', async () => {
    seedNoise(249); // 249 NEWER log-signal class rows push the standing row to position 250
    const standing = seedStanding();
    const r = await fileFeedbackTicket(FILING);
    // Pre-fix: the take:200 scan saw only the newest 200 noise rows — the
    // standing row was out of the window, so a FRESH duplicate was created.
    expect(r).toMatchObject({ deduped: true });
    expect((r as any).ticket.id).toBe('standing-0001');
    expect(mockCreate).not.toHaveBeenCalled();
    const upd = mockUpdate.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'standing-0001' });
    expect(upd.data.context.occurrences).toBe(4); // bumped, trail intact
    expect(standing).toBeTruthy();
  });

  it('the scan pages through the window with a (createdAt,id) cursor — no page-1 shortcut, no skipped rows', async () => {
    seedNoise(249);
    seedStanding();
    await fileFeedbackTicket(FILING);
    // 250 prefiltered candidates / DEDUP_SCAN_PAGE per page → exactly 2 pages,
    // the second carrying the cursor. (An unpaged or skipping scan finds
    // nothing — the standing row is the 250th.)
    const calls = mockPrisma.userFeatureRequest.findMany.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][0].take).toBe(DEDUP_SCAN_PAGE);
    expect(calls[0][0].where.OR).toBeUndefined(); // page 1: no cursor yet
    // page 2: the cursor continues STRICTLY after page 1's last row
    const cursor = calls[1][0].where.OR;
    expect(cursor).toHaveLength(2);
    expect(cursor[0]).toHaveProperty('createdAt.lt');
    expect(cursor[1]).toHaveProperty('createdAt');
    expect(cursor[1]).toHaveProperty('id.lt');
    // both pages order [{createdAt:'desc'},{id:'desc'}] — a TOTAL order, so the
    // cursor can never skip or repeat a row under createdAt collisions
    for (const c of calls) expect(c[0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    // and the found row is the standing one, not a noise row
    expect(mockUpdate.mock.calls[0][0].where).toEqual({ id: 'standing-0001' });
  });

  it('normalized-equal titles that differ in CASE/PUNCTUATION still match — the raw `WHERE title = <normalized>` sketch would have broken this (prefilter superset)', async () => {
    // Stored RAW with different case/punctuation than the filing: normalized
    // forms are EQUAL. The DB prefilter (title CONTAINS longest normalized
    // token, case-insensitive) must not exclude it.
    seedStanding({ title: 'LOG-SIGNAL: Boot Loop on Box C (x3 per hour)' });
    const r = await fileFeedbackTicket(FILING);
    expect(r).toMatchObject({ deduped: true, ticket: { id: 'standing-0001' } });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('the prefilter token is the longest normalized token (selectivity), and the query carries it case-insensitively', async () => {
    seedNoise(3);
    seedStanding();
    await fileFeedbackTicket(FILING);
    const q = mockPrisma.userFeatureRequest.findMany.mock.calls[0][0];
    expect(q.where.AND).toEqual([{ title: { contains: dedupPrefilterToken(norm(STANDING_TITLE)), mode: 'insensitive' } }]);
    // the token is a substring of the STORED raw title (lowercased) — the
    // superset property the whole fix rests on
    expect(STANDING_TITLE.toLowerCase()).toContain(dedupPrefilterToken(norm(STANDING_TITLE)));
    // source/type/status scoping is unchanged — user rows are never candidates
    expect(q.where.type).toBe('bug_report');
    expect(q.where.source).toBe('agent');
    expect(q.where.status).toEqual({ in: ['open', 'in_progress', 'queued', 'reopened'] });
  });

  it('a standing CLOSED ticket 250 closed-noise rows deep still REOPENS (reopen-pass erosion replay)', async () => {
    seedNoise(249, { status: 'done' }); // the reopen scan sees CLOSED rows only
    seedStanding({ status: 'done', context: { sessionId: 'sweep-0', occurrences: 5, reopenCount: 0 } });
    const r = await fileFeedbackTicket(FILING);
    // Pre-fix: the closed scan also took the newest 200 → the done row was out
    // of the window → a brand-new row with occurrences=1 was filed.
    expect(r).toMatchObject({ deduped: true });
    expect(mockCreate).not.toHaveBeenCalled();
    const upd = mockUpdate.mock.calls.at(-1)![0];
    expect(upd.where).toEqual({ id: 'standing-0001' });
    expect(upd.data.status).toBe('open');
    expect(upd.data.context.occurrences).toBe(6);
  });

  it('a standing MISHAP class row 250 rows deep still class-matches (mishap-class pass erosion replay)', async () => {
    // The filing and the standing row share the first 60 normalized chars
    // (one failure class) but differ in the tail (session ids) — the exact
    // pass must NOT eat it, the class pass must find it at depth.
    const long = 'mishap class key prefix that is definitely longer than sixty characters in total';
    seedNoise(249, { type: 'mishap' });
    // mishap-class noise shares the class-key's longest token ('definitely')
    // but not the 60-char class prefix — same-family volume for the class scan
    for (let i = 0; i < 249; i++) {
      rows[i].title = `mishap unrelated failure definitely not this class number ${i}`;
    }
    seedStanding({
      type: 'mishap',
      title: `${long} session aaaa`,
      context: { sessionId: 'm-0', occurrences: 2 },
    });
    const r = await fileFeedbackTicket({ ...FILING, type: 'mishap', title: `${long} session bbbb` });
    expect(r).toMatchObject({ deduped: true, ticket: { id: 'standing-0001' } });
    expect(mockCreate).not.toHaveBeenCalled();
    const upd = mockUpdate.mock.calls[0][0];
    expect(upd.data.context.occurrences).toBe(3);
  });

  it('wouldExactTitleDedupBump (the log-signal-sweep daily-cap peek seam) sees a standing row 250 deep — the peek and the real pass can no longer drift', async () => {
    seedNoise(249);
    seedStanding();
    // Pre-fix the peek scanned take:200 newest → "not a bump" → at cap the
    // sweep DEFERRED the bump, pausing recurrence evidence on a standing class.
    await expect(wouldExactTitleDedupBump({ title: STANDING_TITLE, type: 'bug_report' })).resolves.toBe(true);
    await expect(wouldExactTitleDedupBump({ title: 'a totally unrelated standing class', type: 'bug_report' })).resolves.toBe(false);
  });

  it('the scan stays bounded by the 90-day window: a standing row OUTSIDE the window is not bumped (no dedup regression to "always match")', async () => {
    seedNoise(5);
    seedStanding({ createdAt: new Date(Date.now() - 91 * 24 * 3600_000), updatedAt: new Date(Date.now() - 91 * 24 * 3600_000) });
    const r = await fileFeedbackTicket(FILING);
    expect(r).toMatchObject({ deduped: false }); // outside 90d → a fresh row is correct
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('dedupPrefilterToken: longest token wins; an all-punctuation title (empty norm) yields no filter (unfiltered paged scan, as before)', async () => {
    expect(dedupPrefilterToken('log signal boot loop')).toBe('signal');
    expect(dedupPrefilterToken('ab cd ef')).toBe('ab'); // ties keep the FIRST — deterministic
    expect(dedupPrefilterToken('')).toBe('');
    seedNoise(3);
    seedStanding();
    await fileFeedbackTicket({ ...FILING, title: '!!! ???', description: 'd' });
    // empty token → no AND clause → the scan is unfiltered but still paged
    const q = mockPrisma.userFeatureRequest.findMany.mock.calls[0][0];
    expect(q.where.AND).toBeUndefined();
  });
});

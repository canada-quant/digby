/**
 * plaid_get_transactions pagination + count-first (ticket 7ac4b499).
 *
 * Regression being pinned: the tool held 657 transactions but rendered only
 * the newest 25 — a silent truncation inside the tool result, with no
 * offset/limit to read the rest. getTransactions now pages server-side past
 * Plaid's 100-per-request cap, reports the window total + the offset/limit
 * used in every header, supports `max: 0` as a count-only summary, and says
 * "past the end" instead of returning an empty page for an out-of-range
 * offset. The executor seam (coding-integrations) must pass `limit: 0`
 * through — `args.limit != null` (NOT truthiness) or count-only mode dies at
 * the boundary — and the tool schema must advertise offset/limit.
 *
 * Boundaries mocked: axios (callPlaidApi's only transport), token-manager
 * (getPlaidTokens), logger. callPlaidApi itself runs REAL.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetPlaidTokens = jest.fn();
jest.mock('./token-manager', () => ({
  __esModule: true,
  getPlaidTokens: (...a: any[]) => mockGetPlaidTokens(...(a as [])),
}));

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockAxiosPost(...(a as [])) },
}));

import { getTransactions } from './plaid-mcp';

// ── fixtures ──────────────────────────────────────────────────────────────────

const USER = 'user-1';
const TOKEN = { accessToken: 'access-synth-1', institutionName: 'Chase' };

interface FakeTx { date: string; name: string; amount: number; iso_currency_code?: string }

/** A Plaid /transactions/get page: `n` synthetic rows + the window total. */
const page = (n: number, total: number, firstDate = '2026-01-05'): { data: unknown } => ({
  data: {
    total_transactions: total,
    transactions: Array.from({ length: n }, (_, i): FakeTx => ({
      date: firstDate, name: `TX ${String(i).padStart(4, '0')}`, amount: -(i + 1) / 4,
      iso_currency_code: 'USD',
    })),
  },
});

/** Route the mocked axios.post as a finite Plaid window of `total` rows. */
const serveWindow = (total: number) => {
  mockAxiosPost.mockImplementation(async (_url: string, body: any) => {
    const off = body?.options?.offset ?? 0;
    const count = body?.options?.count ?? 0;
    const n = Math.max(0, Math.min(count, total - off));
    return page(n, total);
  });
};

const calls = () => mockAxiosPost.mock.calls.map((c: any[]) => ({
  url: c[0] as string,
  body: c[1] as Record<string, any>,
}));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLAID_CLIENT_ID = 'test-client-id';
  process.env.PLAID_SECRET = 'test-secret';
  process.env.PLAID_ENV = 'production';
  mockGetPlaidTokens.mockResolvedValue([TOKEN]);
});

afterEach(() => {
  delete process.env.PLAID_CLIENT_ID;
  delete process.env.PLAID_SECRET;
});

// ── 1. the reported bug: a big window is no longer silently truncated ────────

describe('7ac4b499 — no silent truncation of a large window', () => {
  it('reports the 657-item window total in the header, returns the requested page, and tells the caller how to continue', async () => {
    serveWindow(657);
    const out = await getTransactions(USER, 270); // default limit (50)
    expect(out).toContain('657 transactions in window');
    expect(out).toContain('showing 1–50 of 657 (offset=0, limit=50)');
    expect(out).toContain('more available: pass offset=50');
    const rows = (out.match(/^• /gm) || []).length;
    expect(rows).toBe(50); // header total ≠ rows shown, but rows shown are never MORE than asked
  });

  it('a days=30 window of 42 returns all 42 — the 42-held/25-shown mismatch cannot recur', async () => {
    serveWindow(42);
    const out = await getTransactions(USER, 30, 500); // one page big enough for the window
    expect((out.match(/^• /gm) || []).length).toBe(42);
    expect(out).toContain('showing 1–42 of 42 (offset=0, limit=500)');
    expect(out).not.toContain('more available');
  });
});

// ── 2. offset/limit paging ────────────────────────────────────────────────────

describe('7ac4b499 — offset/limit pagination', () => {
  it('offset=50&limit=50 serves the second page and names the next offset', async () => {
    serveWindow(180);
    const out = await getTransactions(USER, 30, 50, 50);
    expect(out).toContain('showing 51–100 of 180 (offset=50, limit=50)');
    expect(out).toContain('more available: pass offset=100');
    const first = calls().find(c => c.url.includes('/transactions/get'));
    expect(first?.body.options).toEqual({ count: 50, offset: 50 }); // server-side skip
  });

  it('an offset past the end is explicit, not an empty success', async () => {
    serveWindow(42);
    const out = await getTransactions(USER, 30, 50, 500);
    expect(out).toContain('offset 500 is past the end');
    expect(out).toContain('Use offset 0–41');
    expect(out).not.toMatch(/^• /m);
  });

  it('limit above Plaid\'s 100-per-request cap pages SERVER-SIDE (limit=250 → requests of 100+100+50)', async () => {
    serveWindow(657);
    const out = await getTransactions(USER, 270, 250, 0);
    const counts = calls().map(c => c.body.options.count);
    expect(counts).toEqual([100, 100, 50]);
    const offsets = calls().map(c => c.body.options.offset);
    expect(offsets).toEqual([0, 100, 200]);
    expect((out.match(/^• /gm) || []).length).toBe(250);
    expect(out).toContain('showing 1–250 of 657');
  });

  it('a short Plaid page ends the window without over-fetching (window 180, limit 250)', async () => {
    serveWindow(180);
    const out = await getTransactions(USER, 270, 250);
    const counts = calls().map(c => c.body.options.count);
    expect(counts).toEqual([100, 100]); // second request is count=100; the SERVER returns 80 rows and we stop
    expect(out).toContain('showing 1–180 of 180 (offset=0, limit=250)');
  });
});

// ── 3. count-only mode (limit: 0) ─────────────────────────────────────────────

describe('7ac4b499 — count-only summary (limit: 0)', () => {
  it('returns the window total with NO transaction rows', async () => {
    serveWindow(657);
    const out = await getTransactions(USER, 270, 0);
    expect(out).toContain('657 transactions in window');
    expect(out).toContain('Pass offset/limit to page through them');
    expect(out).not.toMatch(/^• /m);
  });

  it('costs exactly one wire call of count=1 (total learned, row dropped)', async () => {
    serveWindow(657);
    await getTransactions(USER, 270, 0);
    expect(calls()).toHaveLength(1);
    expect(calls()[0].body.options).toEqual({ count: 1, offset: 0 });
  });

  it('a negative or fractional limit falls back to the default page, never to count-only', async () => {
    serveWindow(657);
    const out = await getTransactions(USER, 270, -3);
    expect(out).toContain('showing 1–50 of 657 (offset=0, limit=50)');
  });

  it('a fractional limit floors to a whole page (2.9 → 2 rows), never collapses to 1 or 0', async () => {
    serveWindow(657);
    const out = await getTransactions(USER, 270, 2.9);
    expect((out.match(/^• /gm) || []).length).toBe(2);
    expect(out).toContain('limit=2');
  });

  it('a non-numeric limit (NaN from the executor seam) falls back to the default 50', async () => {
    serveWindow(657);
    const out = await getTransactions(USER, 270, Number('abc'));
    expect(out).toContain('showing 1–50 of 657 (offset=0, limit=50)');
  });
});

// ── 3b. arg hardening: NaN never reaches the wire or the header ───────────────

describe('7ac4b499 — non-numeric args fall back to defaults (no NaN on the wire)', () => {
  it('a non-numeric offset is sanitized to 0 in the request body (Math.max(0, NaN) is NaN)', async () => {
    serveWindow(657);
    const out = await getTransactions(USER, 270, 50, Number('abc'));
    expect(JSON.stringify(calls()[0].body.options)).not.toContain('NaN');
    expect(calls()[0].body.options).toEqual({ count: 50, offset: 0 });
    expect(out).toContain('(offset=0, limit=50)');
    expect(out).not.toContain('NaN');
  });

  it('a non-numeric days falls back to a 30-day window, not NaN days', async () => {
    serveWindow(657);
    await getTransactions(USER, Number('abc'));
    const body = calls()[0].body;
    const days = Math.round((new Date(body.end_date).getTime() - new Date(body.start_date).getTime()) / 86400000);
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(31);
  });
});

// ── 4. degradation stays graceful (pre-existing contract) ─────────────────────

describe('graceful degradation (unchanged contract)', () => {
  it('returns \'\' when no institution is linked', async () => {
    mockGetPlaidTokens.mockResolvedValue([]);
    await expect(getTransactions(USER, 30)).resolves.toBe('');
  });

  it('an absurd days (1e8) clamps to 730, not a RangeError masquerading as "not connected"', async () => {
    serveWindow(657);
    const out = await getTransactions(USER, 1e8, 10);
    expect(out).not.toBe('');                 // the old failure mode: Date RangeError → catch → ''
    const body = calls()[0].body;
    const days = Math.round((new Date(body.end_date).getTime() - new Date(body.start_date).getTime()) / 86400000);
    expect(days).toBeGreaterThanOrEqual(729); // clamped to Plaid's 24-month /transactions/get limit
    expect(days).toBeLessThanOrEqual(731);
  });

  it('a Plaid response omitting total_transactions never claims the window is exhausted (reviewer finding)', async () => {
    // 180-row window, but Plaid never reports total_transactions: a full last
    // page used to render "showing 1–180 of 180" — asserting completeness it
    // never had. The header must be "of 180+" with a probe hint.
    mockAxiosPost.mockImplementation(async (_u: string, body: any) => {
      const off = body?.options?.offset ?? 0;
      const count = body?.options?.count ?? 0;
      const n = Math.max(0, Math.min(count, 180 - off));
      return { data: { transactions: (page(n, 180).data as any).transactions } }; // total_transactions STRIPPED
    });
    const out = await getTransactions(USER, 270, 250); // one page exactly covers the window
    expect(out).toContain('showing 1–180 of 180+');
    expect(out).toContain('more available: pass offset=180'); // invites the probe that finds row 181
    expect(out).not.toContain('of 180 (');                  // the old false-completeness shape
  });

  it('one institution erroring does not hide the other\'s page — and (2026-10-04) its failure line rides under it', async () => {
    mockGetPlaidTokens.mockResolvedValue([TOKEN, { accessToken: 't2', institutionName: 'Amex' }]);
    mockAxiosPost.mockImplementation(async (_u: string, body: any) => {
      if (body.access_token === 't2') { const e = new Error('boom'); (e as any).response = { data: { error_code: 'INTERNAL_SERVER_ERROR' } }; throw e; }
      return page(Math.min(body?.options?.count ?? 0, 42 - (body?.options?.offset ?? 0)), 42);
    });
    const out = await getTransactions(USER, 30, 500);
    expect(out).toContain('Chase — 42 transactions in window');
    expect(out).not.toContain('Amex —');      // no bogus section for the failed institution
    expect(out).not.toContain('Unknown');
    expect(out).toMatch(/\n\nPlaid transactions read for Amex failed on Plaid's side \(INTERNAL_SERVER_ERROR\)/);

    process.env.INTEGRATION_ERROR_SURFACE_DISABLED = '1';
    try {
      expect(await getTransactions(USER, 30, 500)).not.toContain('Amex'); // the old silent drop
    } finally {
      delete process.env.INTEGRATION_ERROR_SURFACE_DISABLED;
    }
  });
});

// ── 4b. failed calls surface their reason (2026-10-04, integration-error.ts) ──
// A failed Plaid call used to return '' → the executor's "No result from Plaid
// — the integration may not be connected … or nothing matched".

describe('failed Plaid calls surface ONE readable line', () => {
  const plaidErr = (status: number | undefined, data: Record<string, unknown>) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { response: { ...(status ? { status } : {}), data } });

  it('ITEM_LOGIN_REQUIRED (HTTP 400) and a 401 tell the model the bank must be re-linked', async () => {
    const { getBalances } = require('./plaid-mcp');
    mockAxiosPost.mockRejectedValue(plaidErr(400, { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' }));
    expect(await getBalances(USER)).toBe('Plaid balance read for Chase was rejected by Plaid (HTTP 400: ITEM_LOGIN_REQUIRED — the login details of this item have changed) — the Plaid connection needs re-authorizing: Account → Integrations → Plaid Banking → link the bank again.');
    mockAxiosPost.mockRejectedValue(plaidErr(401, {}));
    expect(await getTransactions(USER, 30)).toMatch(/^Plaid transactions read for Chase was rejected by Plaid \(HTTP 401\) —.*Plaid Banking → link the bank again\.$/);
  });

  it('5xx / rate limit / network each say so', async () => {
    const { getAccounts } = require('./plaid-mcp');
    mockAxiosPost.mockRejectedValue(plaidErr(503, {}));
    expect(await getAccounts(USER)).toBe("Plaid accounts read for Chase failed on Plaid's side (HTTP 503) — Plaid is unavailable right now; try again later.");
    mockAxiosPost.mockRejectedValue(plaidErr(429, { error_type: 'RATE_LIMIT_EXCEEDED', error_code: 'ACCOUNTS_LIMIT' }));
    expect(await getAccounts(USER)).toMatch(/was rate-limited by Plaid \(HTTP 429\)/);
    mockAxiosPost.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND production.plaid.com'), { code: 'ENOTFOUND' }));
    expect(await getAccounts(USER)).toBe('Plaid accounts read for Chase could not reach Plaid (network error: ENOTFOUND) — try again shortly.');
  });

  it('kill switch INTEGRATION_ERROR_SURFACE_DISABLED=1 restores the empty string', async () => {
    const { getBalances } = require('./plaid-mcp');
    mockAxiosPost.mockRejectedValue(plaidErr(400, { error_code: 'ITEM_LOGIN_REQUIRED' }));
    process.env.INTEGRATION_ERROR_SURFACE_DISABLED = '1';
    try {
      expect(await getBalances(USER)).toBe('');
      expect(await getTransactions(USER, 30)).toBe('');
    } finally {
      delete process.env.INTEGRATION_ERROR_SURFACE_DISABLED;
    }
  });

  it('an empty-but-successful answer still reads empty (no accounts ⇒ "", empty window ⇒ the plain line)', async () => {
    const { getAccounts } = require('./plaid-mcp');
    mockAxiosPost.mockResolvedValue({ data: { accounts: [] } });
    expect(await getAccounts(USER)).toBe('');
    serveWindow(0);
    expect(await getTransactions(USER, 30)).toContain('Chase — no transactions in window');
  });

  it('missing PLAID_CLIENT_ID / PLAID_SECRET is named as an instance configuration gap, not a user problem', async () => {
    const { getAccounts } = require('./plaid-mcp');
    delete process.env.PLAID_SECRET;
    expect(await getAccounts(USER)).toMatch(/^Plaid accounts read for Chase is unavailable: Plaid is not configured on this Digby instance \(PLAID_CLIENT_ID \/ PLAID_SECRET unset\)/);
  });
});

// ── 5. seam pins — the executor boundary and the advertised schema ────────────

describe('seam pins (executor passthrough + schema)', () => {
  const read = (rel: string) => require('fs').readFileSync(require('path').join(__dirname, rel), 'utf8');

  it('coding-integrations passes limit/offset through with != null (limit:0 must survive — truthiness checks killed count-only)', () => {
    const src = read('../coding/coding-integrations.ts');
    const line = src.split('\n').find((l: string) => l.includes("case 'plaid_get_transactions'"));
    expect(line).toBeDefined();
    expect(line).toContain('args.days != null ? Number(args.days) : undefined');
    expect(line).toContain('args.limit != null ? Number(args.limit) : undefined');
    expect(line).toContain('args.offset != null ? Number(args.offset) : undefined');
    // a truthy `args.limit ? …` passthrough would drop limit:0 (count-only) at the seam
    expect(line).not.toMatch(/args\.limit\s*\?/);
    expect(line).not.toMatch(/args\.offset\s*\?/);
  });

  it('the tool schema advertises offset, limit and the count-only escape hatch', () => {
    const src = read('../coding/integration-tool-schema.ts');
    const block = src.slice(src.indexOf("'plaid_get_transactions'"), src.indexOf("'plaid_get_transactions'") + 1200);
    expect(block).toContain('offset');
    expect(block).toContain('limit');
    expect(block).toContain('count-only');
    expect(block).toMatch(/default 50/);
  });
});

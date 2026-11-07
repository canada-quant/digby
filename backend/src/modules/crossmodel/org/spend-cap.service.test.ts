/**
 * THE ONE USAGE LIMIT (owner directive 2026-11-07T06:40Z).
 *
 * OWNER'S WORDS: "we dont want to limit usage by email verfication at all …
 * people need to freely use digby.ai logged in or not…and we dont want to limit
 * by messages or anything for digby.ai … maybe a hard $100 usage cap per user
 * non admins".
 *
 * This suite pins the four things that would make such a cap either useless or
 * dangerous in production:
 *
 *  1. THE BOUNDARY IS REAL — under the cap allows, AT the cap refuses, over the
 *     cap refuses. An off-by-one that allows "just one more dollar" is not a
 *     $100 cap, and an off-by-one the other way refuses a user who has room left.
 *  2. ADMINS ARE EXEMPT — via the repo's ONE admin predicate (`isAdminViewer`,
 *     which also honours the owner e-mail on production only), and without
 *     even spending a query on them.
 *  3. THE READ FAILS OPEN, THE DECISION DOES NOT — a database blip while
 *     reading spend must not refuse every user; a KNOWN number at/over the cap
 *     must refuse. Confusing the two arms is the real defect (an over-cap send
 *     slipping through as if it were an infra error).
 *  4. THE REFUSAL IS RECOGNIZABLE — `name === 'SpendCapReachedError'` AND
 *     `instanceof` both work. AppError's constructor re-parents the prototype and
 *     severs `instanceof` for subclasses unless the subclass restores it; the
 *     machine-wake seam (chat-agent.service.ts) distinguishes a policy verdict
 *     from an infra fault by name, so a nameless error would be logged as
 *     "proceeding" and the run would start for an over-cap user.
 *
 * Plus the attribution/durability properties: the SQL is positional-param bound
 * (the user id is NEVER interpolated), the total is live loop_metrics FROM the
 * rollup split + spend_daily_rollups BEFORE it (so a lifetime total is not
 * silently reset by the 30-day loop_metrics sweep), and the live half reuses the
 * proven chat-owner attribution from visitor-analytics.service.ts.
 *
 * Hermetic: prisma + logger mocked (the org-quota.send-chain.test pattern). No DB.
 */

const mockQuery = jest.fn(async (..._a: any[]): Promise<any> => []);
/**
 * `$transaction` is mocked as a CALLBACK runner (not a canned value), because the
 * admission's whole correctness argument lives inside it: the advisory lock, the
 * two reads, the compare and the INSERT. Each test installs a stateful fake (see
 * `installFakeAdmissions`) so "the second admission sees the first's hold" is
 * exercised as real control flow rather than asserted on a stub.
 */
const mockTransaction = jest.fn();
const mockSweepDeleteMany = jest.fn(async (..._a: any[]): Promise<any> => ({ count: 0 }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: (...a: any[]) => mockQuery(...a),
    $transaction: (...a: any[]) => mockTransaction(...a),
    spendCapAdmission: { deleteMany: (...a: any[]) => mockSweepDeleteMany(...a) },
    user: { findUnique: jest.fn() },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({ __esModule: true, env: {} }));

import prisma from '../../../config/database';
import { AppError } from '../../../middleware/app-error';
import {
  assertWithinLifetimeSpendCap,
  admitWithinLifetimeSpendCap,
  userLifetimeSpendUsd,
  activeReservationsUsd,
  lifetimeSpendCapUsd,
  spendReservationUsd,
  isSpendCapError,
  SpendCapReachedError,
  spendCapMessage,
  formatUsd,
  sweepExpiredAdmissions,
  LIFETIME_SPEND_CAP_USD,
  RESERVE_USD_DEFAULT,
  RESERVATION_TTL_MS,
  SPEND_CAP_ENV,
  SPEND_RESERVATION_ENV,
} from './spend-cap.service';

const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  $transaction: jest.Mock;
  spendCapAdmission: { deleteMany: jest.Mock };
};

const NOW = new Date('2026-11-07T12:00:00.000Z');
const USER = { id: 'user-1', role: 'USER', email: 'someone@example.com' };
const ADMIN = { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com' };
/** The owner e-mail the repo's admin predicate honours on a PRODUCTION instance only. */
const OWNER = { id: 'owner-1', role: 'USER', email: 'example-user@example.com' };

/**
 * A stateful fake of the admission table + the two reads, so the concurrency
 * behaviour is EXERCISED rather than stubbed.
 *
 * - `committedUsd` answers the lifetime read (the `WITH roll AS (` statement).
 * - the reservations read (`SUM("reservedUsd")`) sums the rows this fake holds
 *   whose `expiresAt` is in the future — an expired row is inserted but simply
 *   never counted, exactly as the real SQL does it.
 * - `create` appends a row, so the SECOND admission in a sequence sees the first
 *   one's hold. That is the regression the reviewer demanded: no hold → both pass.
 *
 * `log` records the call ORDER inside the transaction so a test can assert the
 * advisory lock is taken BEFORE the spend read.
 */
function installFakeAdmissions(opts: {
  committedUsd: number;
  rows?: Array<{ userId: string; reservedUsd: number; expiresAt: Date }>;
  now?: Date;
} = { committedUsd: 0 }) {
  const now = opts.now ?? new Date();
  const rows: Array<{ id: string; userId: string; reservedUsd: number; createdAt: Date; expiresAt: Date }> =
    (opts.rows ?? []).map((r, i) => ({ id: `seed-${i}`, createdAt: now, ...r }));
  const log: string[] = [];

  const tx = {
    $executeRawUnsafe: jest.fn(async (sql: string, ..._params: any[]) => {
      log.push(`execute:${sql}`);
      return 1;
    }),
    $queryRawUnsafe: jest.fn(async (sql: string, ...params: any[]) => {
      if (sql.includes('spend_cap_admissions')) {
        log.push('read:holds');
        const uid = params[0];
        const at = params[1] instanceof Date ? params[1] : now;
        const live = rows.filter((r) => r.userId === uid && r.expiresAt.getTime() > at.getTime());
        return [{ usd: live.reduce((s, r) => s + r.reservedUsd, 0) }];
      }
      log.push('read:spend');
      return [{ usd: opts.committedUsd }];
    }),
    spendCapAdmission: {
      create: jest.fn(async ({ data }: any) => {
        log.push('insert:hold');
        rows.push({ ...data });
        return data;
      }),
    },
  };

  // The transaction runner invokes the callback with this tx — the real adapter
  // does the same, so the code under test is unmodified.
  mockTransaction.mockImplementation(async (fn: any) => fn(tx));

  return { rows, log, tx };
}

const envBackup = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...envBackup };
  delete process.env[SPEND_CAP_ENV];
  delete process.env[SPEND_RESERVATION_ENV];
  delete process.env.DIGBY_INSTANCE;
  mockQuery.mockResolvedValue([{ usd: 0 }]);
  db.user.findUnique.mockResolvedValue(USER);
  mockSweepDeleteMany.mockResolvedValue({ count: 0 });
  // A default fake so a test that only cares about the admin/no-cap arms never
  // trips over an unset $transaction mock.
  installFakeAdmissions({ committedUsd: 0 });
});
afterAll(() => { process.env = { ...envBackup }; });

// ── THE CAP ITSELF ───────────────────────────────────────────────────────────

describe('lifetimeSpendCapUsd — the effective cap (env-injected)', () => {
  const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;

  it('defaults to the owner\u2019s number — 100 US dollars', () => {
    expect(LIFETIME_SPEND_CAP_USD).toBe(100);
    expect(lifetimeSpendCapUsd(env({}))).toBe(100);
    expect(lifetimeSpendCapUsd(env({ [SPEND_CAP_ENV]: '   ' }))).toBe(100);
  });

  it('honours an override', () => {
    expect(lifetimeSpendCapUsd(env({ [SPEND_CAP_ENV]: '250' }))).toBe(250);
    expect(lifetimeSpendCapUsd(env({ [SPEND_CAP_ENV]: ' 12.5 ' }))).toBe(12.5);
  });

  it('0 or "unlimited" means NO cap (the ops escape hatch)', () => {
    expect(lifetimeSpendCapUsd(env({ [SPEND_CAP_ENV]: '0' }))).toBeNull();
    expect(lifetimeSpendCapUsd(env({ [SPEND_CAP_ENV]: 'unlimited' }))).toBeNull();
    expect(lifetimeSpendCapUsd(env({ [SPEND_CAP_ENV]: 'UNLIMITED' }))).toBeNull();
    expect(lifetimeSpendCapUsd(env({ [SPEND_CAP_ENV]: 'none' }))).toBeNull();
  });

  it.each(['abc', '10x', '--5', 'NaN', 'Infinity', '-1', '-0.5'])(
    'malformed/negative %p falls back to the default rather than silently uncapping spend',
    (raw) => {
      expect(lifetimeSpendCapUsd(env({ [SPEND_CAP_ENV]: raw }))).toBe(100);
    },
  );
});

describe('the refusal message + money formatting', () => {
  it('names the cap and says LIFETIME', () => {
    const msg = spendCapMessage(100);
    expect(msg).toContain('$100');
    expect(msg).toMatch(/lifetime/i);
    expect(msg).toMatch(/support/i);
  });

  it('whole dollars stay whole, cents keep two places', () => {
    expect(formatUsd(100)).toBe('$100');
    expect(formatUsd(12.5)).toBe('$12.50');
  });
});

// ── THE QUERY ────────────────────────────────────────────────────────────────

describe('userLifetimeSpendUsd — live loop_metrics + the daily rollups', () => {
  it('sums the run_spend rows of the user\u2019s chats (live) and the older rolled-up days, in ONE statement', async () => {
    mockQuery.mockResolvedValue([{ usd: 42.5 }]);

    const total = await userLifetimeSpendUsd('user-1', NOW);

    expect(total).toBe(42.5);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    // live half: the proven chat-owner attribution, re-keyed exactly as the
    // visitor analytics service does it (never a second attribution rule).
    expect(sql).toContain(`LEFT JOIN "crossmodel_chats" c ON c."id" = lm."sessionId"`);
    expect(sql).toContain(`lm."kind" = 'run_spend'`);
    // rollup half: the days BEFORE the live/rollup split, so the lifetime total
    // survives the 30-day loop_metrics sweep.
    expect(sql).toContain(`"spend_daily_rollups"`);
    expect(sql).toContain(`"day" <`);
    // classified subject = the user's own chats, or the rolled-up user rows.
    expect(sql).toContain(`live.kind = 'user'`);
    expect(sql).toContain(`"subjectKind" = 'user'`);
  });

  it('BINDS the user id as a positional parameter — it is never interpolated into the SQL text', async () => {
    const hostile = `x'; DROP TABLE users; --`;
    await userLifetimeSpendUsd(hostile, NOW);

    const [sql, ...params] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain(hostile);
    expect(params).toContain(hostile);
    // Two id bindings (live + rollup) plus the split day and the window bounds.
    expect(params.filter((p: unknown) => p === hostile)).toHaveLength(2);
  });

  it('returns 0 for an empty/absent result and for a blank user id (without querying)', async () => {
    mockQuery.mockResolvedValue([]);
    expect(await userLifetimeSpendUsd('user-1', NOW)).toBe(0);
    mockQuery.mockClear();
    expect(await userLifetimeSpendUsd('   ', NOW)).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('THROWS when the read fails, so the one fail-open decision lives in the guard', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    await expect(userLifetimeSpendUsd('user-1', NOW)).rejects.toThrow('db down');
  });
});

// ── THE GUARD ────────────────────────────────────────────────────────────────

describe('assertWithinLifetimeSpendCap — the cap decision', () => {
  it('ALLOWS a user under the cap', async () => {
    mockQuery.mockResolvedValue([{ usd: 99.99 }]);
    await expect(assertWithinLifetimeSpendCap({ id: 'user-1' })).resolves.toBeUndefined();
  });

  it('REFUSES a user EXACTLY at the cap (a $100 limit that allows the next dollar is not a $100 limit)', async () => {
    mockQuery.mockResolvedValue([{ usd: 100 }]);
    await expect(assertWithinLifetimeSpendCap({ id: 'user-1' })).rejects.toBeInstanceOf(SpendCapReachedError);
  });

  it('REFUSES a user OVER the cap', async () => {
    mockQuery.mockResolvedValue([{ usd: 143.77 }]);
    const err: any = await assertWithinLifetimeSpendCap({ id: 'user-1' }).catch((e) => e);

    expect(err).toBeInstanceOf(SpendCapReachedError);
    expect(err.statusCode).toBe(402);
    expect(err.message).toBe("You've reached your $100 lifetime usage limit. Contact support if you need more.");
    // Recognizable by class AND name (the machine-wake seam branches on `name`).
    expect(err.name).toBe('SpendCapReachedError');
    expect(isSpendCapError(err)).toBe(true);
    // …and it reports what it measured, so an operator log answers "how far over?".
    expect(err.capUsd).toBe(100);
    expect(err.spentUsd).toBe(143.77);
  });

  it('the prototype survives AppError\u2019s constructor — instanceof works, and the error is a plain AppError too', () => {
    const err = new SpendCapReachedError(100, 100);
    expect(err).toBeInstanceOf(SpendCapReachedError);
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe('SpendCapReachedError');
    // A dynamically-imported duplicate module instance loses `instanceof`, which is
    // exactly why the guard must also recognize the NAME.
    expect(isSpendCapError({ name: 'SpendCapReachedError' })).toBe(true);
    expect(isSpendCapError(new Error('something else'))).toBe(false);
    expect(isSpendCapError(null)).toBe(false);
  });

  it('honours an env override (a $10 cap refuses a $12 user who would pass the default)', async () => {
    process.env[SPEND_CAP_ENV] = '10';
    mockQuery.mockResolvedValue([{ usd: 12 }]);
    const err: any = await assertWithinLifetimeSpendCap({ id: 'user-1' }).catch((e) => e);

    expect(err).toBeInstanceOf(SpendCapReachedError);
    expect(err.capUsd).toBe(10);
    expect(err.message).toContain('$10');
  });

  it.each(['0', 'unlimited'])('env %s disables the cap entirely — no read, no refusal', async (raw) => {
    process.env[SPEND_CAP_ENV] = raw;
    mockQuery.mockResolvedValue([{ usd: 10_000 }]);

    await expect(assertWithinLifetimeSpendCap({ id: 'user-1' })).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('ADMINISTRATORS ARE EXEMPT — and cost no spend query at all', async () => {
    db.user.findUnique.mockResolvedValue(ADMIN);
    mockQuery.mockResolvedValue([{ usd: 5_000 }]);

    await expect(assertWithinLifetimeSpendCap({ id: 'admin-1' })).resolves.toBeUndefined();

    // the admin test is answered from the user row, before the cap is resolved
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('the owner E-MAIL is exempt on production (the repo\u2019s isAdminViewer rule, not a second one)', async () => {
    db.user.findUnique.mockResolvedValue(OWNER);
    mockQuery.mockResolvedValue([{ usd: 5_000 }]);

    await expect(assertWithinLifetimeSpendCap({ id: 'owner-1' })).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('…and that owner-e-mail exemption does NOT apply on a self-host instance (ADMIN role is the only authority there)', async () => {
    process.env.DIGBY_INSTANCE = 'selfhost';
    db.user.findUnique.mockResolvedValue(OWNER);
    mockQuery.mockResolvedValue([{ usd: 5_000 }]);

    await expect(assertWithinLifetimeSpendCap({ id: 'owner-1' })).rejects.toBeInstanceOf(SpendCapReachedError);
  });

  it('a non-admin user whose email merely CONTAINS the owner address is not exempt', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'user-2', role: 'USER', email: 'not-example-user@example.com.example' });
    mockQuery.mockResolvedValue([{ usd: 500 }]);
    await expect(assertWithinLifetimeSpendCap({ id: 'user-2' })).rejects.toBeInstanceOf(SpendCapReachedError);
  });

  it('FAILS OPEN when the spend total cannot be read (a DB blip must not refuse every user)', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    await expect(assertWithinLifetimeSpendCap({ id: 'user-1' })).resolves.toBeUndefined();
  });

  it('FAILS OPEN when the user row cannot be read (deleted-account race / blip)', async () => {
    db.user.findUnique.mockRejectedValue(new Error('db down'));
    await expect(assertWithinLifetimeSpendCap({ id: 'user-1' })).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('FAILS OPEN for a missing user row (nothing to charge)', async () => {
    db.user.findUnique.mockResolvedValue(null);
    await expect(assertWithinLifetimeSpendCap({ id: 'ghost' })).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('is a no-op for a blank user id', async () => {
    await expect(assertWithinLifetimeSpendCap({ id: '' })).resolves.toBeUndefined();
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('an unreadable/non-finite total is NOT a verdict (fail open, never 402 on NaN)', async () => {
    mockQuery.mockResolvedValue([{ usd: 'not-a-number' }]);
    await expect(assertWithinLifetimeSpendCap({ id: 'user-1' })).resolves.toBeUndefined();
  });
});
// ── ATOMIC ADMISSION (the review defect: a preflight is not a cap) ───────────

describe('spendReservationUsd — the per-send hold (env-injected)', () => {
  const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;

  it('defaults to ONE dollar per admitted send', () => {
    expect(RESERVE_USD_DEFAULT).toBe(1);
    expect(spendReservationUsd(env({}))).toBe(1);
    expect(spendReservationUsd(env({ [SPEND_RESERVATION_ENV]: '   ' }))).toBe(1);
  });

  it('honours a positive override', () => {
    expect(spendReservationUsd(env({ [SPEND_RESERVATION_ENV]: '2.5' }))).toBe(2.5);
    expect(spendReservationUsd(env({ [SPEND_RESERVATION_ENV]: ' 5 ' }))).toBe(5);
  });

  it.each(['0', '-1', '-0.5', 'abc', 'NaN', 'Infinity'])(
    'malformed/negative/zero %p falls back to $1 — a ZERO hold would restore the race this fixes',
    (raw) => {
      expect(spendReservationUsd(env({ [SPEND_RESERVATION_ENV]: raw }))).toBe(1);
    },
  );
});

describe('activeReservationsUsd — only UNEXPIRED holds count', () => {
  it('sums live rows and binds the user id + the clock positionally', async () => {
    mockQuery.mockResolvedValue([{ usd: 3 }]);
    const total = await activeReservationsUsd('user-1', NOW);

    expect(total).toBe(3);
    const [sql, ...params] = mockQuery.mock.calls[0];
    expect(sql).toContain('"spend_cap_admissions"');
    expect(sql).toContain(`"expiresAt" > $2`);
    expect(params).toEqual(['user-1', NOW]);
  });

  it('is 0 for a blank id (without querying) and 0 for an unreadable total', async () => {
    await activeReservationsUsd('  ', NOW);
    expect(mockQuery).not.toHaveBeenCalled();

    mockQuery.mockResolvedValue([{ usd: 'nope' }]);
    expect(await activeReservationsUsd('user-1', NOW)).toBe(0);
  });
});

describe('admitWithinLifetimeSpendCap — THE ATOMIC ADMISSION (regression: concurrent sends)', () => {
  it('CONCURRENCY: two sends at the same remaining headroom — the first $1 hold passes, the SECOND IS REFUSED', async () => {
    // The exact race the reviewer reported: with a check-then-run preflight both
    // sends read the same committed total, both pass, both spend, and the account
    // settles past $100. With a hold, the second admission sees the first's live
    // reservation and is refused.
    //
    // NOTE ON THE FIXTURE. The request that commissioned this test named "$99.60
    // committed + a $1 hold → first passes, second refused", which is arithmetically
    // impossible under the SAME spec's `>` rule: 99.60 + 1 = 100.60 > 100, so at
    // $99.60 even ONE admission must be refused (there is only $0.40 of headroom,
    // less than the $1 hold). $98.60 keeps both demanded properties exactly — 98.60
    // + 1 = 99.60 ≤ 100 passes, and 98.60 + 1 + 1 = 100.60 > 100 refuses — so that
    // is the fixture used here; the $99.60 shape is pinned separately below.
    const fake = installFakeAdmissions({ committedUsd: 98.6 });

    const first = await admitWithinLifetimeSpendCap({ id: 'user-1' });
    expect(first.admissionId).toEqual(expect.any(String));
    expect(first.reservedUsd).toBe(1);
    expect(first.committedUsd).toBe(98.6);

    // The first hold is now a row the second admission reads (this is what the
    // preflight could not do — it had nothing to leave behind).
    expect(fake.rows).toHaveLength(1);

    await expect(admitWithinLifetimeSpendCap({ id: 'user-1' })).rejects.toBeInstanceOf(SpendCapReachedError);

    // And the refusal wrote NO second hold — a refused send holds nothing.
    expect(fake.rows).toHaveLength(1);
    // The arithmetic that makes the second refusal correct, stated explicitly.
    expect(98.6 + 1).toBeLessThanOrEqual(100);
    expect(98.6 + 1 + 1).toBeGreaterThan(100);
  });

  it('CONCURRENCY at $99.60: the cap correctly refuses even the FIRST send ($0.40 of headroom < a $1 hold)', async () => {
    // The literal "$99.60" fixture, documented as its own verdict: a preflight
    // would have PASSED it (99.60 < 100) and let a run through on $0.40 of
    // headroom; the hold refuses it, which is the conservative direction.
    const fake = installFakeAdmissions({ committedUsd: 99.6 });

    const err: any = await admitWithinLifetimeSpendCap({ id: 'user-1' }).catch((e) => e);

    expect(err).toBeInstanceOf(SpendCapReachedError);
    expect(err.spentUsd).toBe(99.6);
    expect(fake.rows).toHaveLength(0);
    expect(99.6 + 1).toBeGreaterThan(100);
  });

  it('BOUNDARY: $98.99 + $1 = $99.99 is ALLOWED; $99.01 + $1 = $100.01 is REFUSED (">" not ">=" on the hold)', async () => {
    const under = installFakeAdmissions({ committedUsd: 98.99 });
    await expect(admitWithinLifetimeSpendCap({ id: 'user-1' })).resolves.toMatchObject({ reservedUsd: 1 });
    expect(under.rows).toHaveLength(1);

    const over = installFakeAdmissions({ committedUsd: 99.01 });
    await expect(admitWithinLifetimeSpendCap({ id: 'user-1' })).rejects.toBeInstanceOf(SpendCapReachedError);
    expect(over.rows).toHaveLength(0);
  });

  it('BOUNDARY: a hold that lands EXACTLY on the cap is allowed (projected === cap, not >)', async () => {
    // $99 committed + $1 hold = exactly $100 → admitted (the hold is provision
    // for spend that has not happened, so landing on the cap is inside it).
    const fake = installFakeAdmissions({ committedUsd: 99 });
    await expect(admitWithinLifetimeSpendCap({ id: 'user-1' })).resolves.toMatchObject({ reservedUsd: 1 });
    expect(fake.rows).toHaveLength(1);
  });

  it('the SETTLED-spend arm keeps its hard >= cap refusal (the preflight property is not lost)', async () => {
    installFakeAdmissions({ committedUsd: 100 });
    const err: any = await admitWithinLifetimeSpendCap({ id: 'user-1' }).catch((e) => e);

    expect(err).toBeInstanceOf(SpendCapReachedError);
    expect(err.statusCode).toBe(402);
    expect(err.name).toBe('SpendCapReachedError');
    expect(err.capUsd).toBe(100);
    expect(err.spentUsd).toBe(100);
  });

  it('EXPIRY: an EXPIRED hold does not count toward committed', async () => {
    const past = new Date(Date.now() - RESERVATION_TTL_MS - 60_000);
    // $99 committed + a STALE $5 hold that has expired → still admits (the stale
    // row is invisible), because a crashed run must not permanently hold budget.
    const fake = installFakeAdmissions({
      committedUsd: 99,
      rows: [{ userId: 'user-1', reservedUsd: 5, expiresAt: past }],
    });

    await expect(admitWithinLifetimeSpendCap({ id: 'user-1' })).resolves.toMatchObject({ reservedUsd: 1 });
    expect(fake.rows).toHaveLength(2); // the stale one is still there, just not counted
  });

  it('EXPIRY: the SAME row, still live, DOES block (the expiry test above is not vacuous)', async () => {
    const future = new Date(Date.now() + RESERVATION_TTL_MS);
    installFakeAdmissions({
      committedUsd: 99,
      rows: [{ userId: 'user-1', reservedUsd: 5, expiresAt: future }],
    });

    await expect(admitWithinLifetimeSpendCap({ id: 'user-1' })).rejects.toBeInstanceOf(SpendCapReachedError);
  });

  it('DIFFERENT USERS: user A\u2019s open hold does not count against user B', async () => {
    const future = new Date(Date.now() + RESERVATION_TTL_MS);
    const fake = installFakeAdmissions({
      committedUsd: 99,
      rows: [{ userId: 'user-a', reservedUsd: 5, expiresAt: future }],
    });

    // A is at $99 + $5 already held → refused.
    await expect(admitWithinLifetimeSpendCap({ id: 'user-a' })).rejects.toBeInstanceOf(SpendCapReachedError);
    // B has no holds → admitted despite A sitting next to the cap.
    db.user.findUnique.mockResolvedValue({ id: 'user-b', role: 'USER', email: 'b@example.com' });
    await expect(admitWithinLifetimeSpendCap({ id: 'user-b' })).resolves.toMatchObject({ reservedUsd: 1 });
    expect(fake.rows.filter((r) => r.userId === 'user-b')).toHaveLength(1);
  });

  it('ADVISORY LOCK: the tx takes pg_advisory_xact_lock on the userId BEFORE reading spend', async () => {
    const fake = installFakeAdmissions({ committedUsd: 10 });

    await admitWithinLifetimeSpendCap({ id: 'user-1' });

    // The lock is the FIRST statement in the transaction…
    expect(fake.log[0]).toMatch(/^execute:SELECT pg_advisory_xact_lock/);
    // …and the statement is parameter-bound on the user id, never interpolated.
    const [lockSql, ...lockParams] = fake.tx.$executeRawUnsafe.mock.calls[0];
    expect(lockSql).toContain('pg_advisory_xact_lock(hashtext($1))');
    expect(lockParams).toEqual(['user-1']);
    // …and both number reads happen AFTER it.
    expect(fake.log.indexOf('read:spend')).toBeGreaterThan(0);
    expect(fake.log.indexOf('read:holds')).toBeGreaterThan(fake.log.indexOf('read:spend'));
    // The hold is written LAST, so the row commits with the lock still held.
    expect(fake.log[fake.log.length - 1]).toBe('insert:hold');
  });

  it('the spend read runs on the TRANSACTION client, not the pool (outside-the-lock reads are the bug)', async () => {
    const fake = installFakeAdmissions({ committedUsd: 10 });
    await admitWithinLifetimeSpendCap({ id: 'user-1' });

    expect(fake.tx.$queryRawUnsafe).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('ADMIN is exempt and opens NO transaction at all', async () => {
    db.user.findUnique.mockResolvedValue(ADMIN);

    const res = await admitWithinLifetimeSpendCap({ id: 'admin-1' });

    expect(res).toMatchObject({ admissionId: null, reservedUsd: 0 });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('NO CAP configured → no transaction and no hold row (a hold nobody checks is just a row)', async () => {
    process.env[SPEND_CAP_ENV] = 'unlimited';
    const res = await admitWithinLifetimeSpendCap({ id: 'user-1' });

    expect(res).toMatchObject({ admissionId: null, reservedUsd: 0 });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('an admitted hold expires RESERVATION_TTL_MS (30 min) after it was written', async () => {
    expect(RESERVATION_TTL_MS).toBe(30 * 60 * 1000);

    const fake = installFakeAdmissions({ committedUsd: 1 });
    const res = await admitWithinLifetimeSpendCap({ id: 'user-1' });

    const row = fake.rows[0];
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(RESERVATION_TTL_MS);
    expect(res.expiresAt!.getTime() - row.createdAt.getTime()).toBe(RESERVATION_TTL_MS);
  });

  it('honours DIGBY_SPEND_RESERVATION_USD on the row it writes', async () => {
    process.env[SPEND_RESERVATION_ENV] = '2.5';
    const fake = installFakeAdmissions({ committedUsd: 0 });

    await admitWithinLifetimeSpendCap({ id: 'user-1' });

    expect(fake.rows[0].reservedUsd).toBe(2.5);
  });

  it('FAILS OPEN on infra (a tx error that is NOT our refusal must not refuse the send)', async () => {
    mockTransaction.mockRejectedValue(new Error('could not obtain lock'));
    await expect(admitWithinLifetimeSpendCap({ id: 'user-1' })).resolves.toMatchObject({ admissionId: null });
  });

  it('FAILS OPEN when the user row is unreadable, with no transaction opened', async () => {
    db.user.findUnique.mockRejectedValue(new Error('db down'));
    await expect(admitWithinLifetimeSpendCap({ id: 'user-1' })).resolves.toMatchObject({ admissionId: null });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('is a no-op for a blank id and for a missing user row', async () => {
    await expect(admitWithinLifetimeSpendCap({ id: '' })).resolves.toMatchObject({ admissionId: null });
    expect(db.user.findUnique).not.toHaveBeenCalled();

    db.user.findUnique.mockResolvedValue(null);
    await expect(admitWithinLifetimeSpendCap({ id: 'ghost' })).resolves.toMatchObject({ admissionId: null });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('does NOT fail open on its OWN refusal (the refusal must cross the catch unchanged)', async () => {
    installFakeAdmissions({ committedUsd: 250 });
    const err: any = await admitWithinLifetimeSpendCap({ id: 'user-1' }).catch((e) => e);

    expect(err.name).toBe('SpendCapReachedError');
    expect(err.statusCode).toBe(402);
    expect(isSpendCapError(err)).toBe(true);
  });
});

describe('sweepExpiredAdmissions — housekeeping, never a verdict', () => {
  it('deletes rows past their expiry and reports the count', async () => {
    mockSweepDeleteMany.mockResolvedValue({ count: 4 });
    await expect(sweepExpiredAdmissions(NOW)).resolves.toBe(4);
    expect(mockSweepDeleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lte: NOW } } });
  });

  it('never throws — a missed sweep costs disk, never correctness', async () => {
    mockSweepDeleteMany.mockRejectedValue(new Error('db down'));
    await expect(sweepExpiredAdmissions(NOW)).resolves.toBe(0);
  });
});

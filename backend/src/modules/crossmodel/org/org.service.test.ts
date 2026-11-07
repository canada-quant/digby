/**
 * Org/tenant model tests (Phase 2 Cloud, todo ea95fa0b leg 1 item 2).
 *
 * The invariant under test is the one the rest of leg 1 leans on: EVERY user
 * ends up with exactly one default org, and it can be created either eagerly at
 * user creation or lazily on first use. If either path regresses, quota
 * enforcement silently stops applying to that account — which is why the lazy
 * self-heal is tested as a first-class path rather than an edge case.
 *
 * Hermetic: prisma + logger mocked (the auth.account.test pattern). No DB.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    organization: { create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    membership: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
// error-handler pulls config/env → process.exit without env vars (CI is env-less).
jest.mock('../../../config/env', () => ({ __esModule: true, env: {} }));

import prisma from '../../../config/database';
import { ensurePersonalOrg, ensurePersonalOrgForUser, slugify, setOrgDailyLimit } from './org.service';

const org = prisma as unknown as {
  organization: { create: jest.Mock };
  membership: { findFirst: jest.Mock };
  user: { findUnique: jest.Mock };
};

const createdOrg = { id: 'org-1', slug: 'paul', suspended: false, suspendedReason: null, dailyMessageLimit: null };

beforeEach(() => {
  jest.clearAllMocks();
  org.membership.findFirst.mockResolvedValue(null);
  org.user.findUnique.mockResolvedValue({ email: 'paul@example.com', firstName: 'Paul' });
});

describe('slugify', () => {
  it('derives a URL-safe handle from the email local-part', () => {
    expect(slugify('Paul.Smith+tag@Example.com')).toBe('paul-smith-tag');
  });
  it('never returns an empty slug (the column is NOT NULL)', () => {
    expect(slugify('!!!@example.com')).toBe('org');
    expect(slugify('')).toBe('org');
  });
  it('caps length so the handle stays stable in URLs', () => {
    expect(slugify(`${'a'.repeat(80)}@x.com`).length).toBeLessThanOrEqual(32);
  });
});

describe('ensurePersonalOrg', () => {
  it('creates the org with an OWNER membership flagged default', async () => {
    org.organization.create.mockResolvedValue(createdOrg);

    const result = await ensurePersonalOrg('user-1', 'paul@example.com', 'Paul');

    expect(result).toEqual(createdOrg);
    const data = org.organization.create.mock.calls[0][0].data;
    expect(data.personal).toBe(true);
    expect(data.ownerId).toBe('user-1');
    // NULL limit = unlimited: creating an org must never throttle an account.
    expect(data.dailyMessageLimit).toBeNull();
    expect(data.memberships.create).toEqual({ userId: 'user-1', role: 'OWNER', isDefault: true });
  });

  it('is idempotent — an existing default membership short-circuits before create', async () => {
    org.membership.findFirst.mockResolvedValue({ organization: createdOrg });

    const result = await ensurePersonalOrg('user-1', 'paul@example.com');

    expect(result).toEqual(createdOrg);
    expect(org.organization.create).not.toHaveBeenCalled();
  });

  it('retries with a discriminator when the slug is already taken, then succeeds', async () => {
    org.organization.create
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockResolvedValueOnce({ ...createdOrg, slug: 'paul-ab12cd' });

    const result = await ensurePersonalOrg('user-1', 'paul@example.com');

    expect(org.organization.create).toHaveBeenCalledTimes(2);
    const secondSlug = org.organization.create.mock.calls[1][0].data.slug;
    expect(secondSlug).not.toBe('paul');
    expect(secondSlug.startsWith('paul-')).toBe(true);
    expect(result.slug).toBe('paul-ab12cd');
  });

  it('adopts the org a concurrent call created instead of failing the send', async () => {
    // Both calls raced past the first membership read; the second insert loses on
    // a unique key and the row that won is adopted.
    org.organization.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    org.membership.findFirst
      .mockResolvedValueOnce(null)                       // the initial probe
      .mockResolvedValueOnce({ organization: createdOrg }); // the post-conflict re-read

    const result = await ensurePersonalOrg('user-1', 'paul@example.com');
    expect(result).toEqual(createdOrg);
  });

  it('surfaces a non-uniqueness database error rather than looping', async () => {
    org.organization.create.mockRejectedValue(Object.assign(new Error('db down'), { code: 'P1001' }));
    await expect(ensurePersonalOrg('user-1', 'paul@example.com')).rejects.toThrow('db down');
    expect(org.organization.create).toHaveBeenCalledTimes(1);
  });
});

describe('ensurePersonalOrgForUser (the send-path self-heal)', () => {
  it('returns the existing default org without touching the user row', async () => {
    org.membership.findFirst.mockResolvedValue({ organization: createdOrg });

    const result = await ensurePersonalOrgForUser('user-1');

    expect(result).toEqual(createdOrg);
    expect(org.user.findUnique).not.toHaveBeenCalled();
    expect(org.organization.create).not.toHaveBeenCalled();
  });

  it('creates one lazily for a pre-migration account that has no org', async () => {
    // This is the path every EXISTING prod account takes on its first send: the
    // migration deliberately backfills nothing, so the self-heal must work.
    org.organization.create.mockResolvedValue(createdOrg);

    const result = await ensurePersonalOrgForUser('user-1');

    expect(result).toEqual(createdOrg);
    expect(org.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' }, select: { email: true, firstName: true } });
    expect(org.organization.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a user id that does not exist (an FK dead end) instead of inventing an org', async () => {
    org.user.findUnique.mockResolvedValue(null);
    await expect(ensurePersonalOrgForUser('ghost')).rejects.toThrow('Account not found');
    expect(org.organization.create).not.toHaveBeenCalled();
  });
});
/**
 * NO MESSAGE-COUNT LIMIT ON A NEW ORG (owner directive 2026-11-07T06:40Z:
 * "we dont want to limit by messages or anything for digby.ai").
 *
 * This replaces the old `defaultOrgDailyLimit` branch table, which was DELETED
 * along with the env knob it read (`ORG_DEFAULT_DAILY_MESSAGE_LIMIT`, also gone
 * from docker-compose.app.yml and .env.example). The property that matters now is
 * the opposite one, and it must hold unconditionally:
 *
 *   a NEWLY CREATED org is UNLIMITED — on every instance shape, with every
 *   environment, and with no knob anywhere able to change it.
 *
 * The "hosted instance shape" case is the important one: that is precisely where
 * the old code used to stamp a limit, so a regression that re-introduces
 * instance-dependent defaulting shows up here and nowhere else.
 */
describe('a created org is ALWAYS unlimited (no message-count limit, ever)', () => {
  const createdEnvBackup = { ...process.env };
  afterAll(() => { process.env = { ...createdEnvBackup }; });
  afterEach(() => { process.env = { ...createdEnvBackup }; });

  it('writes dailyMessageLimit: null at organization.create', async () => {
    org.organization.create.mockResolvedValue(createdOrg);
    await ensurePersonalOrg('user-1', 'paul@example.com', 'Paul');
    expect(org.organization.create.mock.calls[0][0].data.dailyMessageLimit).toBeNull();
  });

  it.each([undefined, '', 'prod', 'PROD'])(
    'stays null on a HOSTED instance shape (DIGBY_INSTANCE=%p) — where the old default used to stamp a limit',
    async (kind) => {
      if (kind === undefined) delete process.env.DIGBY_INSTANCE;
      else process.env.DIGBY_INSTANCE = kind;
      // Every knob the old implementation read. NONE of them may have an effect.
      process.env.ORG_DEFAULT_DAILY_MESSAGE_LIMIT = '25';
      org.organization.create.mockResolvedValue(createdOrg);

      await ensurePersonalOrg('user-1', 'paul@example.com');

      expect(org.organization.create.mock.calls[0][0].data.dailyMessageLimit).toBeNull();
    },
  );

  it.each(['selfhost', 'edge'])('stays null on a %s instance shape', async (kind) => {
    process.env.DIGBY_INSTANCE = kind;
    process.env.ORG_DEFAULT_DAILY_MESSAGE_LIMIT = '25';
    org.organization.create.mockResolvedValue(createdOrg);

    await ensurePersonalOrg('user-1', 'paul@example.com');

    expect(org.organization.create.mock.calls[0][0].data.dailyMessageLimit).toBeNull();
  });

  it('the lazily self-healed org (the path every pre-existing account takes) is unlimited too', async () => {
    process.env.ORG_DEFAULT_DAILY_MESSAGE_LIMIT = '25';
    org.organization.create.mockResolvedValue(createdOrg);

    const result = await ensurePersonalOrgForUser('user-1');

    expect(result.dailyMessageLimit).toBeNull();
    expect(org.organization.create.mock.calls[0][0].data.dailyMessageLimit).toBeNull();
  });

  it('an operator can still cap ONE named org through the admin writer (that is not a default)', async () => {
    // setOrgDailyLimit is deliberately untouched by the directive — abuse control
    // on a specific tenant is a decision, not a policy applied to everyone.
    const row = { ...createdOrg, dailyMessageLimit: 5 };
    (org as any).organization.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    (org as any).organization.findUnique = jest.fn().mockResolvedValue(row);

    const updated = await setOrgDailyLimit('org-1', 5);

    expect((org as any).organization.updateMany).toHaveBeenCalledWith({ where: { id: 'org-1' }, data: { dailyMessageLimit: 5 } });
    expect(updated.dailyMessageLimit).toBe(5);
  });
});

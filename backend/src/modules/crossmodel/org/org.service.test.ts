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
    organization: { create: jest.fn() },
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
import { ensurePersonalOrg, ensurePersonalOrgForUser, slugify } from './org.service';

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
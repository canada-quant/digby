/**
 * Tenant suspension tests (Phase 2 Cloud leg 1 item 4 — abuse controls).
 *
 * The gap this closes: `org-quota.service` has refused every send from a
 * suspended org since the leg-1 migration, and `Organization.suspended` +
 * `suspendedReason` have shipped as columns — but nothing in the tree could
 * WRITE them. The kill switch could be read and never thrown.
 *
 * What is pinned here:
 *  - suspending REQUIRES a reason (an operator who cannot say why, in the text
 *    the end user reads, has not made an abuse decision);
 *  - reinstating CLEARS the reason, so a lifted suspension cannot keep
 *    mis-explaining a live workspace;
 *  - a missing org is a clean 404, not a Prisma P2025 from deep in the call;
 *  - the returned shape is the same DefaultOrg the quota path consumes, so the
 *    caller can trust what it reads back.
 *
 * Hermetic: prisma + logger mocked. No DB.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    organization: { updateMany: jest.fn(), findUnique: jest.fn() },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({ __esModule: true, env: {} }));

import prisma from '../../../config/database';
import { setOrgSuspension } from './org.service';

const db = prisma as unknown as {
  organization: { updateMany: jest.Mock; findUnique: jest.Mock };
};

const ROW = {
  id: 'org-1',
  slug: 'acme',
  suspended: true,
  suspendedReason: 'spam',
  dailyMessageLimit: 50,
};

beforeEach(() => {
  jest.clearAllMocks();
  db.organization.updateMany.mockResolvedValue({ count: 1 });
  db.organization.findUnique.mockResolvedValue(ROW);
});

describe('setOrgSuspension — suspending', () => {
  it('writes suspended=true and the trimmed reason, then returns the org', async () => {
    const org = await setOrgSuspension('org-1', true, '  spam  ');

    const arg = db.organization.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'org-1' });
    expect(arg.data).toEqual({ suspended: true, suspendedReason: 'spam' });
    expect(org).toEqual(ROW);
  });

  it('REFUSES to suspend without a reason', async () => {
    // The reason is what the end user sees in their refusal message
    // ("This workspace is suspended: <reason>"); a blank one is not a decision.
    await expect(setOrgSuspension('org-1', true, '   ')).rejects.toThrow(/reason is required/i);
    expect(db.organization.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to suspend with no reason argument at all', async () => {
    await expect(setOrgSuspension('org-1', true)).rejects.toThrow(/reason is required/i);
    expect(db.organization.updateMany).not.toHaveBeenCalled();
  });
});

describe('setOrgSuspension — reinstating', () => {
  it('clears the reason so a lifted suspension leaves no stale explanation', async () => {
    db.organization.findUnique.mockResolvedValue({ ...ROW, suspended: false, suspendedReason: null });
    await setOrgSuspension('org-1', false, 'no longer needed');

    const arg = db.organization.updateMany.mock.calls[0][0];
    expect(arg.data).toEqual({ suspended: false, suspendedReason: null });
  });

  it('does not require a reason to reinstate', async () => {
    await expect(setOrgSuspension('org-1', false)).resolves.toBeDefined();
  });
});

describe('setOrgSuspension — missing org', () => {
  it('404s when no row matched (never a raw Prisma error)', async () => {
    db.organization.updateMany.mockResolvedValue({ count: 0 });
    await expect(setOrgSuspension('nope', true, 'spam')).rejects.toThrow(/not found/i);
  });

  it('404s if the row vanishes between the write and the read-back', async () => {
    db.organization.findUnique.mockResolvedValue(null);
    await expect(setOrgSuspension('org-1', true, 'spam')).rejects.toThrow(/not found/i);
  });
});
/**
 * Free-tier daily-limit writer tests (Phase 2 Cloud, todo ea95fa0b item 2).
 *
 * The defect this closes: `org-quota.service` has always READ
 * `organizations.dailyMessageLimit`, but nothing in the tree ever WROTE it. Every
 * org was therefore NULL — unlimited — so the free tier's limit was not a policy
 * anyone could decide; it was the column default. Readable and unsettable is the
 * same defect class as a kill switch with no thrower, and the sibling of the
 * suspension gap org-suspension.test.ts covers.
 *
 * What is pinned here:
 *  - a number is written through and read back;
 *  - NULL restores UNLIMITED (the deliberate self-host / pre-existing posture),
 *    and 0 is a VALID hard stop distinct from null — collapsing the two would
 *    silently un-meter a tenant;
 *  - a negative or non-integer limit is refused BEFORE the write (a negative
 *    would make the guard's `used >= limit` true on an empty day);
 *  - a missing org is a clean 404, not a Prisma P2025 from deep in the call.
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
import { setOrgDailyLimit } from './org.service';

const db = prisma as unknown as {
  organization: { updateMany: jest.Mock; findUnique: jest.Mock };
};

const ROW = {
  id: 'org-1',
  slug: 'acme',
  suspended: false,
  suspendedReason: null,
  dailyMessageLimit: 50,
};

beforeEach(() => {
  jest.clearAllMocks();
  db.organization.updateMany.mockResolvedValue({ count: 1 });
  db.organization.findUnique.mockResolvedValue(ROW);
});

describe('setOrgDailyLimit — setting a limit', () => {
  it('writes the number and returns the org', async () => {
    const org = await setOrgDailyLimit('org-1', 50);
    expect(db.organization.updateMany).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { dailyMessageLimit: 50 },
    });
    expect(org.dailyMessageLimit).toBe(50);
  });

  it('accepts 0 as a hard stop (distinct from unlimited)', async () => {
    db.organization.findUnique.mockResolvedValue({ ...ROW, dailyMessageLimit: 0 });
    const org = await setOrgDailyLimit('org-1', 0);
    expect(db.organization.updateMany).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { dailyMessageLimit: 0 },
    });
    expect(org.dailyMessageLimit).toBe(0);
  });

  it('accepts null to restore UNLIMITED', async () => {
    db.organization.findUnique.mockResolvedValue({ ...ROW, dailyMessageLimit: null });
    const org = await setOrgDailyLimit('org-1', null);
    expect(db.organization.updateMany).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { dailyMessageLimit: null },
    });
    expect(org.dailyMessageLimit).toBeNull();
  });
});

describe('setOrgDailyLimit — refuses values the guard would mis-evaluate', () => {
  it('rejects a negative limit without writing', async () => {
    await expect(setOrgDailyLimit('org-1', -1)).rejects.toThrow(/0 or more/i);
    expect(db.organization.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a non-integer limit without writing', async () => {
    await expect(setOrgDailyLimit('org-1', 2.5)).rejects.toThrow(/whole number/i);
    expect(db.organization.updateMany).not.toHaveBeenCalled();
  });
});

describe('setOrgDailyLimit — missing org', () => {
  it('404s when the update matched nothing', async () => {
    db.organization.updateMany.mockResolvedValue({ count: 0 });
    await expect(setOrgDailyLimit('nope', 10)).rejects.toThrow(/not found/i);
  });

  it('404s if the row vanishes between the write and the read-back', async () => {
    db.organization.findUnique.mockResolvedValue(null);
    await expect(setOrgDailyLimit('org-1', 10)).rejects.toThrow(/not found/i);
  });
});
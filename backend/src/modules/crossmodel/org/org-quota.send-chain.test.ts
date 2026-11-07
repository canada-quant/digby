/**
 * Phase 2 Cloud leg 1 — the END-TO-END chain (todo ea95fa0b).
 *
 * The unit suites prove org creation, quota arithmetic and email verification
 * separately. This file proves the thing a user actually experiences: a fresh
 * signup gets a personal org, its first N sends are allowed, and send N+1 is
 * REFUSED (not degraded, not silently answered by a cheaper model).
 *
 * It is deliberately written against the real services with only the database
 * and logger mocked, so the seam between org creation and quota enforcement is
 * exercised rather than simulated — that seam is where a wiring mistake would
 * hide (an org the quota service cannot see reads as "unlimited").
 *
 * Hermetic: prisma + logger + env mocked (the auth.account.test pattern).
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    organization: { create: jest.fn() },
    membership: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    orgUsageDaily: { upsert: jest.fn(), update: jest.fn() },
    orgModelUsageDaily: { upsert: jest.fn(), findMany: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({ __esModule: true, env: {} }));

import prisma from '../../../config/database';
import { ensurePersonalOrg } from './org.service';
import { guardOrgSend, OrgQuotaExceededError, recordOrgTokens } from './org-quota.service';

const db = prisma as unknown as {
  organization: { create: jest.Mock };
  membership: { findFirst: jest.Mock };
  user: { findUnique: jest.Mock };
  orgUsageDaily: { upsert: jest.Mock; update: jest.Mock };
  orgModelUsageDaily: { upsert: jest.Mock; findMany: jest.Mock };
  systemSetting: { findUnique: jest.Mock };
};

/**
 * A tiny in-memory stand-in for the two unique-indexed counter tables, so the
 * increment/refund arithmetic is exercised for real across a sequence of sends
 * rather than one call at a time.
 */
function installFakeCounters(limit: number | null) {
  const daily = new Map<string, { messages: number; tokensIn: number; tokensOut: number }>();
  const key = (orgId: string, day: Date) => `${orgId}:${day.toISOString()}`;

  db.organization.create.mockResolvedValue({
    id: 'org-personal', slug: 'paul', suspended: false, suspendedReason: null, dailyMessageLimit: limit,
  });
  db.membership.findFirst.mockResolvedValue(null);
  db.user.findUnique.mockResolvedValue({ email: 'paul@example.com', firstName: 'Paul' });

  db.orgUsageDaily.upsert.mockImplementation(({ where, create, update }: any) => {
    const k = key(where.organizationId_day.organizationId, where.organizationId_day.day);
    const cur = daily.get(k);
    if (!cur) {
      const fresh = { messages: create.messages ?? 0, tokensIn: create.tokensIn ?? 0, tokensOut: create.tokensOut ?? 0 };
      daily.set(k, fresh);
      return Promise.resolve({ ...fresh });
    }
    if (update?.messages?.increment) cur.messages += update.messages.increment;
    if (update?.messages?.decrement) cur.messages -= update.messages.decrement;
    if (update?.tokensIn?.increment) cur.tokensIn += update.tokensIn.increment;
    if (update?.tokensOut?.increment) cur.tokensOut += update.tokensOut.increment;
    return Promise.resolve({ ...cur });
  });
  db.orgUsageDaily.update.mockImplementation(({ where, data }: any) => {
    const k = key(where.organizationId_day.organizationId, where.organizationId_day.day);
    const cur = daily.get(k);
    if (cur && data?.messages?.decrement) cur.messages -= data.messages.decrement;
    return Promise.resolve(cur ? { ...cur } : {});
  });
  db.orgModelUsageDaily.findMany.mockResolvedValue([]);
  db.systemSetting.findUnique.mockResolvedValue(null);
  return daily;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.orgModelUsageDaily.upsert.mockResolvedValue({});
});

describe('signup → send → quota exhausted', () => {
  it('a fresh signup gets a personal org, and its sends are then metered against that org', async () => {
    installFakeCounters(3);

    // 1. SIGNUP: the personal org is created for the new user.
    const org = await ensurePersonalOrg('user-1', 'paul@example.com', 'Paul');
    expect(org.id).toBe('org-personal');
    expect(org.dailyMessageLimit).toBe(3);

    // 2. The quota guard resolves THE SAME org from the user id — this is the
    //    seam the unit tests each covered alone.
    db.membership.findFirst.mockResolvedValue({ organization: org });

    // 3. SENDS 1..3 are allowed.
    for (let i = 1; i <= 3; i++) {
      await expect(guardOrgSend('user-1')).resolves.toEqual({ organizationId: 'org-personal' });
    }

    // 4. SEND 4 is REFUSED — the fail-closed verdict.
    await expect(guardOrgSend('user-1')).rejects.toBeInstanceOf(OrgQuotaExceededError);
  });

  it('after the refusal the user is exactly AT the limit, not past it (the refund held)', async () => {
    const daily = installFakeCounters(2);
    const org = await ensurePersonalOrg('user-1', 'paul@example.com');
    db.membership.findFirst.mockResolvedValue({ organization: org });

    await guardOrgSend('user-1');
    await guardOrgSend('user-1');
    await expect(guardOrgSend('user-1')).rejects.toBeInstanceOf(OrgQuotaExceededError);
    // A refused attempt must not permanently consume a slot: still exactly 2.
    await expect(guardOrgSend('user-1')).rejects.toBeInstanceOf(OrgQuotaExceededError);

    const row = [...daily.values()][0];
    expect(row.messages).toBe(2);
  });

  it('THE DEPTH PROPERTY: a "deep" send costs exactly one message, same as a quick one', async () => {
    // The guard has no depth input, so this is the strongest available statement
    // in a unit test: however the request is shaped, it consumes one slot. The
    // structural half of this proof (guard runs before the run starts, plan is
    // decided inside the run) lives in org-quota.service.test.ts.
    const daily = installFakeCounters(10);
    const org = await ensurePersonalOrg('user-1', 'paul@example.com');
    db.membership.findFirst.mockResolvedValue({ organization: org });

    await guardOrgSend('user-1');
    const afterOne = [...daily.values()][0].messages;

    await guardOrgSend('user-1');
    const afterTwo = [...daily.values()][0].messages;

    expect(afterOne).toBe(1);
    expect(afterTwo).toBe(2); // strictly +1, never a multiple and never zero
  });

  it('an UNLIMITED org (null limit — every pre-existing account) is never refused', async () => {
    installFakeCounters(null);
    const org = await ensurePersonalOrg('user-1', 'paul@example.com');
    db.membership.findFirst.mockResolvedValue({ organization: org });

    for (let i = 0; i < 25; i++) {
      await expect(guardOrgSend('user-1')).resolves.toEqual({ organizationId: 'org-personal' });
    }
  });

  it('token spend for the day accumulates per model and appears on the org meter', async () => {
    installFakeCounters(100);
    const org = await ensurePersonalOrg('user-1', 'paul@example.com');
    db.membership.findFirst.mockResolvedValue({ organization: org });

    await guardOrgSend('user-1');
    await recordOrgTokens(org.id, 'kimi-k3', 500, 250);
    await recordOrgTokens(org.id, 'kimi-k3', 100, 50);
    await recordOrgTokens(org.id, 'deepseek-flash', 40, 10);

    // Per-model rows are upserted once per model…
    const models = db.orgModelUsageDaily.upsert.mock.calls.map(c => c[0].where.organizationId_day_model.model);
    expect(models).toEqual(['kimi-k3', 'kimi-k3', 'deepseek-flash']);
    // …and the day total increments with every turn.
    const dailyIncrements = db.orgUsageDaily.upsert.mock.calls
      .filter(c => c[0].update?.tokensIn?.increment)
      .map(c => c[0].update.tokensIn.increment);
    expect(dailyIncrements).toEqual([500, 100, 40]);
  });

  it('a DIFFERENT org has its own independent counter (no cross-tenant leakage)', async () => {
    installFakeCounters(1);
    const orgA = await ensurePersonalOrg('user-a', 'a@example.com');
    const orgB = { ...orgA, id: 'org-b', slug: 'b' };

    db.membership.findFirst.mockResolvedValue({ organization: orgA });
    await guardOrgSend('user-a');
    await expect(guardOrgSend('user-a')).rejects.toBeInstanceOf(OrgQuotaExceededError);

    // Tenant B is untouched by tenant A exhausting its own pool.
    db.membership.findFirst.mockResolvedValue({ organization: orgB });
    await expect(guardOrgSend('user-b')).resolves.toEqual({ organizationId: 'org-b' });
  });
});
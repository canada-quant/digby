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
    // The lifetime spend cap (spend-cap.service.ts) reads the total through one
    // positional-param raw query, exactly like the visitors analytics service.
    $queryRawUnsafe: jest.fn(),
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
import { REQUIRE_VERIFICATION_SETTING } from './email-verification.service';

const db = prisma as unknown as {
  organization: { create: jest.Mock };
  membership: { findFirst: jest.Mock };
  user: { findUnique: jest.Mock };
  orgUsageDaily: { upsert: jest.Mock; update: jest.Mock };
  orgModelUsageDaily: { upsert: jest.Mock; findMany: jest.Mock };
  systemSetting: { findUnique: jest.Mock };
  $queryRawUnsafe: jest.Mock;
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
  // The lifetime spend cap: every fixture user starts at $0 lifetime spend, so the
  // cap never interferes with the message-metering arithmetic this file is about.
  db.$queryRawUnsafe.mockResolvedValue([{ usd: 0 }]);
  return daily;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.orgModelUsageDaily.upsert.mockResolvedValue({});
  db.$queryRawUnsafe.mockResolvedValue([{ usd: 0 }]);
});

describe('signup → send → metered WITHOUT any message refusal', () => {
  it('a fresh signup gets a personal org and its sends are metered, but never refused', async () => {
    const daily = installFakeCounters(null);

    // 1. SIGNUP: the personal org is created for the new user — and it is
    //    UNLIMITED (owner directive 2026-11-07T06:40Z: no message limits).
    const org = await ensurePersonalOrg('user-1', 'paul@example.com', 'Paul');
    expect(org.id).toBe('org-personal');
    expect(org.dailyMessageLimit).toBeNull();

    // 2. The quota guard resolves THE SAME org from the user id — this is the
    //    seam the unit tests each covered alone.
    db.membership.findFirst.mockResolvedValue({ organization: org });

    // 3. Sends are allowed, and the usage METER still advances for each one.
    for (let i = 1; i <= 6; i++) {
      await expect(guardOrgSend('user-1')).resolves.toEqual({ organizationId: 'org-personal' });
    }

    // The meter is real: six sends recorded, none refused, nothing clamped.
    const row = [...daily.values()][0];
    expect(row.messages).toBe(6);
  });

  it('a LEGACY stored limit does not refuse either — the meter keeps counting', async () => {
    // The org carries an old limit of 2 and sends 1..4 all pass. This is the
    // exact sequence that used to end in a 429; the directive removes it.
    const daily = installFakeCounters(2);
    const org = await ensurePersonalOrg('user-1', 'paul@example.com');
    db.membership.findFirst.mockResolvedValue({ organization: { ...org, dailyMessageLimit: 2 } });

    for (let i = 0; i < 4; i++) {
      await expect(guardOrgSend('user-1')).resolves.toEqual({ organizationId: 'org-personal' });
    }

    // Nothing was refunded, because nothing was ever refused: the meter holds
    // the true count of sends (4), not the clamped limit (2).
    const row = [...daily.values()][0];
    expect(row.messages).toBe(4);
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

  it('tenant counters stay independent (no cross-tenant leakage in the meter)', async () => {
    installFakeCounters(null);
    const orgA = await ensurePersonalOrg('user-a', 'a@example.com');
    const orgB = { ...orgA, id: 'org-b', slug: 'b' };

    db.membership.findFirst.mockResolvedValue({ organization: orgA });
    await guardOrgSend('user-a');
    await guardOrgSend('user-a');

    // Tenant A's sends land on A's meter (installFakeCounters creates 'org-personal')…
    const rowA = db.orgUsageDaily.upsert.mock.calls.at(-1)![0];
    expect(rowA.where.organizationId_day.organizationId).toBe(orgA.id);

    // …and tenant B's send lands on B's, independently. Each org keeps its own
    // counter now that no limit exists to trip over.
    db.membership.findFirst.mockResolvedValue({ organization: orgB });
    await expect(guardOrgSend('user-b')).resolves.toEqual({ organizationId: 'org-b' });
    const rowB = db.orgUsageDaily.upsert.mock.calls.at(-1)![0];
    expect(rowB.where.organizationId_day.organizationId).toBe('org-b');
  });
});
/**
 * THE GATE IS GONE (owner directive 2026-11-07T06:40Z: "we dont want to limit
 * usage by email verfication at all … people need to freely use digby.ai logged
 * in or not").
 *
 * What used to live here pinned the POSITION of the verification gate (verify
 * BEFORE reserve). That ordering is moot: `assertEmailVerifiedForSend` is now a
 * permanent no-op, so there is no refusal left to order. Rather than delete the
 * coverage, these tests invert it — the send guard must ALLOW an unverified
 * account, with the `require_email_verification` setting flipped ON, and must
 * still meter the message normally afterwards.
 *
 * The assertion names `reserveOrgMessage`'s own DB touches (the membership read
 * inside `orgForUser`, then the counter upsert), so it tracks the real
 * implementation rather than a symbol we chose.
 */
describe('guardOrgSend — an unverified account is NEVER blocked (owner 2026-11-07T06:40Z)', () => {
  /** Policy row set to ON — the strongest possible attempt to arm the old gate. */
  function armPolicyOn(verified: boolean) {
    installFakeCounters(5);
    db.systemSetting.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(where.key === REQUIRE_VERIFICATION_SETTING ? { key: where.key, value: 'true' } : null),
    );
    // Org-quota paths read { email, firstName }; the (removed) gate read
    // { emailVerifiedAt }. Serve both shapes so this stays honest whichever
    // projection the code asks for.
    db.user.findUnique.mockImplementation(({ select }: any) =>
      select && 'emailVerifiedAt' in select
        ? Promise.resolve({ emailVerifiedAt: verified ? new Date() : null })
        : Promise.resolve({ email: 'paul@example.com', firstName: 'Paul', emailVerifiedAt: verified ? new Date() : null }),
    );
    const org = { id: 'org-personal', slug: 'paul', suspended: false, suspendedReason: null, dailyMessageLimit: 5 };
    db.membership.findFirst.mockResolvedValue({ organization: org });
    return org;
  }

  it('a send from an UNVERIFIED account under require_email_verification=ON is ALLOWED and metered', async () => {
    armPolicyOn(false);

    await expect(guardOrgSend('user-1')).resolves.toEqual({ organizationId: 'org-personal' });

    // It really did go through the normal path: the org was resolved and the
    // message reservation was taken.
    expect(db.membership.findFirst).toHaveBeenCalled();
    expect(db.orgUsageDaily.upsert).toHaveBeenCalledTimes(1);
    // And the gate read nothing at all (no policy row, no verification row).
    const verificationReads = db.user.findUnique.mock.calls.filter(
      (c) => c[0]?.select && 'emailVerifiedAt' in c[0].select,
    );
    expect(verificationReads).toHaveLength(0);
  });

  it('does not throw EmailVerificationRequiredError for an unverified account (the old 403 is unreachable)', async () => {
    armPolicyOn(false);

    let threw: any = null;
    try {
      await guardOrgSend('user-1');
    } catch (e) {
      threw = e;
    }

    expect(threw).toBeNull(); // it resolved, so nothing was refused
    expect(threw?.name).not.toBe('EmailVerificationRequiredError');
  });

  it('six unverified sends all pass — verification never eats a slot', async () => {
    armPolicyOn(false);
    for (let i = 1; i <= 6; i++) {
      await expect(guardOrgSend('user-1')).resolves.toEqual({ organizationId: 'org-personal' });
    }
    // There is no message-limit refusal either any more (owner directive
    // 2026-11-07T06:40Z), so the sequence simply keeps passing.
  });
});
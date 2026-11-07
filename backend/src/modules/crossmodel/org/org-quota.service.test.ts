/**
 * Per-org quota enforcement tests (Phase 2 Cloud, todo ea95fa0b leg 1 item 3).
 *
 * The two acceptance properties this file exists to prove:
 *  1. EXHAUSTION REFUSES. A send over the org's daily message limit is refused
 *     with a 429-shaped error — not degraded to a cheaper model, not queued.
 *  2. DEPTH CANNOT BYPASS. Escalating compute (deeper rung, council, double
 *     checker) must consume the SAME reservation as a quick answer. Two
 *     independent proofs, because the first alone is forgeable:
 *       (a) BEHAVIOURAL — the guard takes no mode/depth/rung parameter at all,
 *           so there is no input through which depth could change the verdict;
 *       (b) STRUCTURAL — in the real seams the guard is invoked BEFORE the run
 *           starts, and the compute plan is decided INSIDE/AFTER the run, so no
 *           depth is reachable without first paying the reservation.
 *
 * Hermetic: prisma + logger + env mocked (the auth.account.test pattern).
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    organization: { create: jest.fn() },
    membership: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    orgUsageDaily: { upsert: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    orgModelUsageDaily: { upsert: jest.fn(), findMany: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({ __esModule: true, env: {} }));

import * as fs from 'fs';
import * as path from 'path';
import prisma from '../../../config/database';
import {
  guardOrgSend, reserveOrgMessage, recordOrgTokens, utcDayKey,
  OrgQuotaExceededError, MODEL_TOKEN_LIMITS_SETTING,
} from './org-quota.service';

const db = prisma as unknown as {
  organization: { create: jest.Mock };
  membership: { findFirst: jest.Mock };
  user: { findUnique: jest.Mock };
  orgUsageDaily: { upsert: jest.Mock; update: jest.Mock };
  orgModelUsageDaily: { upsert: jest.Mock; findMany: jest.Mock };
  systemSetting: { findUnique: jest.Mock };
};

/** An org whose daily message limit is `limit` (null = unlimited). */
const orgRow = (limit: number | null, extra: Record<string, unknown> = {}) => ({
  id: 'org-1', slug: 'paul', suspended: false, suspendedReason: null, dailyMessageLimit: limit, ...extra,
});

/** The org exists (default membership found) — the common fixture. */
const orgExists = (limit: number | null, extra: Record<string, unknown> = {}) => {
  db.membership.findFirst.mockResolvedValue({ organization: orgRow(limit, extra) });
};

beforeEach(() => {
  jest.clearAllMocks();
  db.membership.findFirst.mockResolvedValue(null);
  db.user.findUnique.mockResolvedValue({ email: 'paul@example.com', firstName: 'Paul' });
  db.organization.create.mockResolvedValue(orgRow(null));
  db.orgUsageDaily.update.mockResolvedValue({});
  db.orgUsageDaily.upsert.mockResolvedValue({ messages: 1 });
  db.orgModelUsageDaily.findMany.mockResolvedValue([]);
  db.systemSetting.findUnique.mockResolvedValue(null);
});

describe('utcDayKey', () => {
  it('is midnight UTC of the given instant (the bucket key)', () => {
    expect(utcDayKey(new Date('2026-11-06T23:45:12Z')).toISOString()).toBe('2026-11-06T00:00:00.000Z');
  });
  it('rolls over at UTC midnight, not local', () => {
    expect(utcDayKey(new Date('2026-11-07T00:00:01Z')).toISOString()).toBe('2026-11-07T00:00:00.000Z');
  });
});

describe('reserveOrgMessage', () => {
  it('UNLIMITED (null limit) always allows and still meters usage', async () => {
    orgExists(null);
    db.orgUsageDaily.upsert.mockResolvedValue({ messages: 9_999 });

    const d = await reserveOrgMessage('user-1');

    expect(d.allowed).toBe(true);
    expect(d.limit).toBeNull();
    expect(d.remaining).toBeNull();
    // The counter is still written — it is the usage meter, not just a cap.
    expect(db.orgUsageDaily.upsert).toHaveBeenCalled();
  });

  it('allows a send that lands exactly ON the limit', async () => {
    orgExists(5);
    db.orgUsageDaily.upsert.mockResolvedValue({ messages: 5 });

    const d = await reserveOrgMessage('user-1');

    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(0);
  });

  it('REFUSES the send that lands over the limit — the fail-closed verdict', async () => {
    orgExists(5);
    db.orgUsageDaily.upsert.mockResolvedValue({ messages: 6 });

    const d = await reserveOrgMessage('user-1');

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('messages');
    expect(d.limit).toBe(5);
    expect(d.remaining).toBe(0);
  });

  it('refunds the reservation when it refuses, so a rejected attempt never eats a slot', async () => {
    orgExists(1);
    db.orgUsageDaily.upsert.mockResolvedValue({ messages: 2 });

    await reserveOrgMessage('user-1');

    expect(db.orgUsageDaily.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { messages: { decrement: 1 } } }),
    );
  });

  it('counts atomically at the database (an increment, never a read-then-write)', async () => {
    orgExists(10);
    await reserveOrgMessage('user-1');
    const arg = db.orgUsageDaily.upsert.mock.calls[0][0];
    expect(arg.update).toEqual({ messages: { increment: 1 } });
    expect(arg.create.messages).toBe(1);
    // The unique key is what makes two concurrent sends serialize.
    expect(arg.where.organizationId_day).toEqual({ organizationId: 'org-1', day: expect.any(Date) });
  });

  it('refuses a suspended org regardless of its remaining quota (the per-tenant kill switch)', async () => {
    orgExists(100, { suspended: true, suspendedReason: 'abuse review' });

    const d = await reserveOrgMessage('user-1');

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('suspended');
    expect(d.message).toContain('abuse review');
    expect(db.orgUsageDaily.upsert).not.toHaveBeenCalled();
  });

  it('ALLOWS the send when the counter is unreachable (a DB blip must not become an outage)', async () => {
    orgExists(5);
    db.orgUsageDaily.upsert.mockRejectedValue(new Error('connection refused'));

    const d = await reserveOrgMessage('user-1');

    expect(d.allowed).toBe(true);
  });
});

describe('guardOrgSend', () => {
  it('throws a 429-shaped error (never a "busy" value a caller would queue)', async () => {
    orgExists(1);
    db.orgUsageDaily.upsert.mockResolvedValue({ messages: 2 });

    await expect(guardOrgSend('user-1')).rejects.toBeInstanceOf(OrgQuotaExceededError);
    await expect(guardOrgSend('user-1')).rejects.toMatchObject({ statusCode: 429, name: 'OrgQuotaExceededError' });
  });

  it('passes through for an org under its limit', async () => {
    orgExists(5);
    db.orgUsageDaily.upsert.mockResolvedValue({ messages: 2 });
    await expect(guardOrgSend('user-1')).resolves.toEqual({ organizationId: 'org-1' });
  });
});

describe('per-model token quota', () => {
  const withLimits = (limits: Record<string, number | null>) =>
    db.systemSetting.findUnique.mockImplementation(({ where }: any) =>
      where.key === MODEL_TOKEN_LIMITS_SETTING
        ? Promise.resolve({ key: where.key, value: JSON.stringify(limits) })
        : Promise.resolve(null));

  it('refuses when a model is ALREADY at its daily ceiling', async () => {
    orgExists(100);
    db.orgUsageDaily.upsert.mockResolvedValue({ messages: 1 });
    withLimits({ 'kimi-k3': 1000 });
    db.orgModelUsageDaily.findMany.mockResolvedValue([{ model: 'kimi-k3', tokensIn: 700, tokensOut: 400 }]);

    await expect(guardOrgSend('user-1')).rejects.toMatchObject({ name: 'OrgQuotaExceededError' });
  });

  it('allows while the model is under its ceiling', async () => {
    orgExists(100);
    db.orgUsageDaily.upsert.mockResolvedValue({ messages: 1 });
    withLimits({ 'kimi-k3': 1000 });
    db.orgModelUsageDaily.findMany.mockResolvedValue([{ model: 'kimi-k3', tokensIn: 100, tokensOut: 100 }]);

    await expect(guardOrgSend('user-1')).resolves.toEqual({ organizationId: 'org-1' });
  });

  it('a null per-model entry means unlimited for that model', async () => {
    orgExists(100);
    db.orgUsageDaily.upsert.mockResolvedValue({ messages: 1 });
    withLimits({ 'kimi-k3': null });
    db.orgModelUsageDaily.findMany.mockResolvedValue([{ model: 'kimi-k3', tokensIn: 9e9, tokensOut: 9e9 }]);

    await expect(guardOrgSend('user-1')).resolves.toEqual({ organizationId: 'org-1' });
  });

  it('recordOrgTokens upserts BOTH the per-model row and the day total', async () => {
    await recordOrgTokens('org-1', 'kimi-k3', 120, 80);

    expect(db.orgModelUsageDaily.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId_day_model: { organizationId: 'org-1', day: expect.any(Date), model: 'kimi-k3' } },
      update: { tokensIn: { increment: 120 }, tokensOut: { increment: 80 } },
    }));
    expect(db.orgUsageDaily.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { tokensIn: { increment: 120 }, tokensOut: { increment: 80 } },
    }));
  });

  it('recordOrgTokens never throws — the answer was already paid for and delivered', async () => {
    db.orgModelUsageDaily.upsert.mockRejectedValue(new Error('db down'));
    await expect(recordOrgTokens('org-1', 'kimi-k3', 10, 10)).resolves.toBeUndefined();
  });
});

describe('compute depth cannot bypass the reservation', () => {
  it('(a) the guard takes NO depth/mode/rung input — arity is the invariant', () => {
    // A parameter added here would be the only way depth could influence the
    // verdict. Pinning the arity makes that a deliberate, reviewed change.
    expect(guardOrgSend.length).toBe(1);
    expect(reserveOrgMessage.length).toBe(1);
  });

  it('(b) both human seams guard BEFORE the run starts, and the compute plan is decided AFTER it', () => {
    const root = path.join(__dirname, '..', '..');
    const seam = (rel: string, guardNeedle: string, runNeedle: string) => {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      const guardAt = src.indexOf(guardNeedle);
      const runAt = src.indexOf(runNeedle);
      expect(guardAt).toBeGreaterThan(-1);
      expect(runAt).toBeGreaterThan(-1);
      // The guard must be reached first — that is what makes depth unreachable
      // without paying for it.
      expect(guardAt).toBeLessThan(runAt);
    };

    // The web SSE send.
    seam(path.join('crossmodel', 'crossmodel.controller.ts'), 'guardOrgSend(userId)', 'const runKey = await startDetachedChatRun(');
    // The REST / agent-token seam.
    seam(path.join('crossmodel', 'platform', 'platform.service.ts'), 'guardOrgSend(userId)', 'const started = await startDetachedChatRun(');

    // And the plan that escalates cost is decided INSIDE the run, after the run
    // entry — so no rung can be selected before the reservation is paid.
    const svc = fs.readFileSync(path.join(root, 'crossmodel', 'chat-agent', 'chat-agent.service.ts'), 'utf8');
    const runEntry = svc.indexOf('export async function startDetachedChatRun');
    const plan = svc.indexOf('decideComputePlan(');
    expect(runEntry).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(runEntry);
  });

  it('(c) a machine wake is metered too — schedules/hooks cannot dodge the cap', () => {
    // Without this, a free-tier tenant could schedule its way past the limit.
    const svc = fs.readFileSync(
      path.join(__dirname, '..', 'chat-agent', 'chat-agent.service.ts'), 'utf8',
    );
    const guardAt = svc.indexOf('guardOrgSend(args.userId)');
    const gatedOn = svc.lastIndexOf('if (machineTriggered && args.userId)', guardAt);
    expect(guardAt).toBeGreaterThan(-1);
    expect(gatedOn).toBeGreaterThan(-1);
    // A human send reserves at its own seam; gating on machineTriggered is what
    // keeps it from being charged twice.
    expect(svc.slice(gatedOn, guardAt)).toContain('machineTriggered');
  });
});
/**
 * Org/tenant model (Phase 2 Cloud, todo ea95fa0b leg 1 item 2).
 *
 * THE INVARIANT: every user has exactly ONE default org, and it always exists by
 * the time a send needs it.
 *
 * Why an org at all, rather than a userId on the counter: the free tier is
 * enforced per TENANT. One model has to serve a solo user (personal org) and a
 * team (several members on one pool) with the SAME enforcement code path, so
 * Phase 3 RBAC and per-org branding hang off rows that already exist.
 *
 * TWO WAYS THE INVARIANT IS HELD — deliberately both:
 *  1. EAGER: every user-creation path calls ensurePersonalOrg inside its own
 *     transaction (register, admin create, Digby Kids child). The org exists the
 *     moment the account does, which is what the signup UI reads back.
 *  2. LAZY: ensurePersonalOrgForUser is idempotent and is also called from the
 *     send guard. That is what covers (a) the ~every existing prod account that
 *     predates this migration — none of them has an org row, and a backfill
 *     migration would have had to slugify emails in SQL, (b) any future creation
 *     path somebody adds without remembering to call this, and (c) seed data.
 *     A missing org therefore self-heals on first use instead of refusing the
 *     user's message.
 *
 * LIMITS: a NULL dailyMessageLimit means UNLIMITED, and that is now the ONLY
 * posture this file creates. Every NEW org is created with `dailyMessageLimit:
 * null` — there is no env default, no hosted-only branch and no creation knob
 * (owner directive 2026-11-07T06:40Z: "we dont want to limit by messages or
 * anything for digby.ai"; the one usage limit is the lifetime spend cap in
 * spend-cap.service.ts). An operator can still cap or suspend ONE specific
 * abusive tenant through the admin surface (setOrgDailyLimit /
 * setOrgSuspension below) — that is a deliberate act on a named org, never a
 * default applied to everyone.
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/app-error';

/** The default org a user's sends bill against. */
export interface DefaultOrg {
  id: string;
  slug: string;
  suspended: boolean;
  suspendedReason: string | null;
  /** null = unlimited — the ONLY value this module ever CREATES (see LIMITS). */
  dailyMessageLimit: number | null;
}

/**
 * A URL-safe handle from an email local-part (or name). Kept short and stable —
 * it is a public-ish identifier in URLs and in the future branding surface.
 * Falls back to 'org' when the local part has nothing usable, so a slug is
 * ALWAYS produced (a null slug would fail the NOT NULL column).
 */
export function slugify(input: string): string {
  const base = String(input ?? '')
    .toLowerCase()
    .split('@')[0]
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'org';
}

/**
 * ABUSE CONTROL — suspend or reinstate a tenant (Phase 2 Cloud leg 1 item 4).
 *
 * Why this exists at all: org-quota.service refuses every send from a suspended
 * org (reason 'suspended'), and the column + reason have shipped since the leg-1
 * migration — but until this function there was NO writer anywhere in the tree.
 * The kill switch could be read and could never be thrown. An abuse control you
 * cannot apply is not a control.
 *
 * Suspending is deliberately the ONE-way-safe direction: it is reversible
 * (suspended:false clears the reason too), it never deletes usage history, and
 * it does not touch the org's members or their accounts — a suspended tenant can
 * still sign in and read their data, they simply cannot send.
 *
 * The reason is REQUIRED when suspending: an operator who cannot say why, in the
 * message the end user will read, has not made an abuse decision yet. Reinstating
 * clears it, so a lifted suspension leaves no stale explanation behind.
 */
export async function setOrgSuspension(
  orgId: string,
  suspended: boolean,
  reason?: string | null,
): Promise<DefaultOrg> {
  const trimmed = String(reason ?? '').trim();
  if (suspended && !trimmed) {
    throw new AppError(400, 'A reason is required to suspend a workspace');
  }

  // updateMany scoped by id: a missing org is a clean 404 rather than a Prisma
  // P2025 thrown from a deep call, and the count tells us which happened.
  const { count } = await prisma.organization.updateMany({
    where: { id: orgId },
    data: {
      suspended,
      // Clearing on reinstate keeps "why was this suspended" from outliving the
      // suspension and mis-explaining a live workspace to its users.
      suspendedReason: suspended ? trimmed : null,
    },
  });
  if (count === 0) throw new AppError(404, 'Workspace not found');

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true, suspended: true, suspendedReason: true, dailyMessageLimit: true },
  });
  if (!org) throw new AppError(404, 'Workspace not found');
  return org;
}

/**
 * FREE-TIER CONTROL — set one tenant's daily message limit (Phase 2 Cloud).
 *
 * The counterpart of setOrgSuspension, and it exists for the same reason: the
 * quota guard has always READ `organizations.dailyMessageLimit`
 * (org-quota.service.ts), but nothing in the tree ever WROTE it. Every org was
 * therefore NULL — unlimited — so the free tier's actual limit was not a policy
 * anyone could decide; it was whatever the column defaulted to. Readable and
 * unsettable is the same defect class as a kill switch with no thrower.
 *
 * `null` restores UNLIMITED, which is the deliberate self-host and
 * pre-existing-account posture (see the LIMITS note at the top of this file):
 * metering only engages where an operator has decided a number. 0 is a VALID
 * hard stop, distinct from null — it refuses every send without suspending the
 * tenant (so the member still signs in and reads their data).
 */
export async function setOrgDailyLimit(
  orgId: string,
  dailyMessageLimit: number | null,
): Promise<DefaultOrg> {
  // Defensive even though the route validates: a negative limit would make the
  // guard's `used >= limit` comparison true on an empty day, and a non-integer
  // would compare unpredictably against a counter.
  if (dailyMessageLimit !== null) {
    if (!Number.isInteger(dailyMessageLimit) || dailyMessageLimit < 0) {
      throw new AppError(400, 'Daily message limit must be a whole number of 0 or more, or null for unlimited');
    }
  }

  const { count } = await prisma.organization.updateMany({
    where: { id: orgId },
    data: { dailyMessageLimit },
  });
  if (count === 0) throw new AppError(404, 'Workspace not found');

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true, suspended: true, suspendedReason: true, dailyMessageLimit: true },
  });
  if (!org) throw new AppError(404, 'Workspace not found');
  return org;
}

/** Display name for a personal org — the person's name if we have it, else the handle. */
function personalOrgName(email: string, firstName?: string | null): string {
  const named = [firstName].filter(Boolean).join(' ').trim();
  return named || `${slugify(email)}'s workspace`;
}

/**
 * Create the user's personal org + OWNER membership.
 *
 * Runs inside the caller's transaction when given a `tx`, so a user row and its
 * org commit or roll back together — a half-created account with no org would
 * take a lazy path on every send forever.
 *
 * SLUG COLLISIONS are expected (two people called `paul@`): we probe outward
 * with a short random discriminator rather than a sequence, because a sequence
 * leaks how many accounts share a local-part and racing inserts would collide
 * on the same next integer anyway. The unique index is the real arbiter; we
 * retry a bounded number of times and then fail loudly.
 */
export async function ensurePersonalOrg(
  userId: string,
  email: string,
  firstName?: string | null,
  tx?: PrismaTx,
): Promise<DefaultOrg> {
  const client = tx ?? prisma;

  const existing = await client.membership.findFirst({
    where: { userId, isDefault: true },
    select: { organization: { select: { id: true, slug: true, suspended: true, suspendedReason: true, dailyMessageLimit: true } } },
  });
  if (existing?.organization) return existing.organization;

  const base = slugify(email);
  for (let attempt = 0; attempt < 8; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomUUID().slice(0, 6)}`;
    try {
      const org = await client.organization.create({
        data: {
          name: personalOrgName(email, firstName),
          slug,
          personal: true,
          ownerId: userId,
          // NO MESSAGE LIMIT, EVER (owner 2026-11-07T06:40Z: "we dont want to
          // limit by messages or anything for digby.ai"). A newly created org is
          // hard-wired UNLIMITED: there is no env knob, no hosted-only branch and
          // nothing to misconfigure. The one usage limit is the lifetime spend cap
          // (spend-cap.service.ts), and an operator who needs to stop ONE abusive
          // tenant uses the admin surface — a named decision, never a default.
          dailyMessageLimit: null,
          memberships: { create: { userId, role: 'OWNER', isDefault: true } },
        },
        select: { id: true, slug: true, suspended: true, suspendedReason: true, dailyMessageLimit: true },
      });
      return org;
    } catch (err: any) {
      // P2002 = unique violation. Either the slug raced (retry with a new one) or
      // a concurrent call already created THIS user's membership (unique on
      // [userId, organizationId] does not catch it — isDefault is not unique — so
      // re-read and adopt the row the other call made).
      if (err?.code !== 'P2002') throw err;
      const raced = await client.membership.findFirst({
        where: { userId, isDefault: true },
        select: { organization: { select: { id: true, slug: true, suspended: true, suspendedReason: true, dailyMessageLimit: true } } },
      });
      if (raced?.organization) return raced.organization;
      // else: slug collision on the org insert — loop and pick another slug.
    }
  }
  throw new AppError(500, 'Could not create a workspace for this account');
}

/**
 * The send-path entry point: return the user's default org, creating it on
 * demand. NEVER throws for a merely-missing org (that would refuse a real
 * user's message over bookkeeping); it only throws if creation genuinely fails.
 */
export async function ensurePersonalOrgForUser(userId: string): Promise<DefaultOrg> {
  const existing = await prisma.membership.findFirst({
    where: { userId, isDefault: true },
    select: { organization: { select: { id: true, slug: true, suspended: true, suspendedReason: true, dailyMessageLimit: true } } },
  });
  if (existing?.organization) return existing.organization;

  // Lazily heal a pre-migration / seed / un-wired account. The user row must
  // exist (memberships.userId is an FK) — if it does not, the caller is using a
  // stale id and there is nothing sensible to do but report it.
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, firstName: true } });
  if (!user) throw new AppError(401, 'Account not found');
  logger.info(`org: no default org for ${userId} — creating personal org lazily`, { source: 'org' });
  return ensurePersonalOrg(userId, user.email, user.firstName);
}

/** Prisma client or an interactive-transaction handle (the folder-tree-ops convention). */
type PrismaTx = typeof prisma | Prisma.TransactionClient;
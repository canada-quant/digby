/**
 * ORG ACCESS unit tests (Phase 3 Enterprise RBAC, todo c45f065e).
 *
 * This is the module that turns `memberships.role` into an authorization
 * decision, so the tests are about the DECISION TABLE, not about HTTP:
 *
 *  - the capability table is pinned EXHAUSTIVELY (every role × every
 *    capability, asserted by name). A future capability added to the union but
 *    not to the table, or a role added to the schema but not to the table, fails
 *    here rather than silently granting or denying the wrong people;
 *  - the NON-MEMBER answer is 404 and never 403 — the isolation property. A 403
 *    would confirm the org id exists, turning these endpoints into a cross-tenant
 *    existence oracle; the test asserts the status explicitly so a "friendlier"
 *    refactor to 403 breaks the suite;
 *  - a MEMBER who lacks a capability gets 403, because by then membership is
 *    already proven and there is no tenancy fact left to hide;
 *  - membership is resolved from the `(userId, organizationId)` pair on every
 *    call, so a client cannot assert membership via a token claim and a revoked
 *    member loses access on their next request rather than at token expiry;
 *  - rank exists only to stop peers acting on each other: OWNER > ADMIN >
 *    BILLING = MEMBER, and an unknown role ranks BELOW everything so a value
 *    this code does not understand can never outrank an admin.
 *
 * Hermetic: the REAL org-access module runs (mocking it is exactly the review
 * defect org-admin.routes.test.ts records — a re-implemented predicate passes
 * while the real one regresses); only prisma and logger are mocked, per the
 * org-suspension.test.ts idiom. No DB, no app boot.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    membership: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../../config/database';
import { AppError } from '../../../middleware/app-error';
import {
  DEFAULT_MEMBER_ORG_ROLE,
  ORG_CAPABILITIES,
  ORG_ROLES,
  capabilitiesOf,
  isOwnerRole,
  isSeniorRole,
  normalizeOrgRole,
  orgRoleLabel,
  outranksForMemberAction,
  requireOrgCapability,
  requiresSeniorGrant,
  resolveMembership,
  roleCan,
  roleRank,
  type OrgCapability,
} from './org-access';

const db = prisma as unknown as { membership: { findUnique: jest.Mock; findMany: jest.Mock; count: jest.Mock } };

beforeEach(() => {
  jest.clearAllMocks();
  db.membership.findUnique.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CAPABILITY TABLE — exhaustive and pinned
// ─────────────────────────────────────────────────────────────────────────────
describe('capability table — pinned exhaustively', () => {
  /**
   * The expected matrix, written out in full ON PURPOSE (no loop that derives
   * expectations from the implementation — that would assert nothing). If a
   * capability is added, every row here must be revisited deliberately, which is
   * the "fails loudly" property the acceptance criteria demand.
   */
  const EXPECTED: Record<(typeof ORG_ROLES)[number], OrgCapability[]> = {
    OWNER: [
      'org:read',
      'org:update',
      'member:read',
      'member:invite',
      'member:role',
      'member:remove',
      'billing:read',
      'billing:update',
      'member:grant-senior',
    ],
    ADMIN: ['org:read', 'org:update', 'member:read', 'member:invite', 'member:role', 'member:remove', 'billing:read'],
    BILLING: ['org:read', 'billing:read', 'billing:update'],
    MEMBER: ['org:read'],
  };

  it('defines exactly the four schema roles and every capability', () => {
    expect([...ORG_ROLES]).toEqual(['OWNER', 'ADMIN', 'BILLING', 'MEMBER']);
    expect([...ORG_CAPABILITIES].sort()).toEqual(
      [
        'billing:read',
        'billing:update',
        'member:grant-senior',
        'member:invite',
        'member:read',
        'member:remove',
        'member:role',
        'org:read',
        'org:update',
      ].sort(),
    );
  });

  it('every role × capability pair matches the pinned matrix (no derivation, no slack)', () => {
    for (const role of ORG_ROLES) {
      const expected = new Set(EXPECTED[role]);
      for (const capability of ORG_CAPABILITIES) {
        // Asserted per pair with a labelled message so a failure names the exact cell.
        expect({ role, capability, allowed: roleCan(role, capability) }).toEqual({
          role,
          capability,
          allowed: expected.has(capability),
        });
      }
      // And no capability outside the union may sneak in.
      expect([...capabilitiesOf(role)].sort()).toEqual([...expected].sort());
    }
  });

  it('the OWNER is a superset of ADMIN, which is a superset of MEMBER', () => {
    const owner = capabilitiesOf('OWNER');
    const admin = capabilitiesOf('ADMIN');
    const member = capabilitiesOf('MEMBER');
    for (const c of admin) expect(owner.has(c)).toBe(true);
    for (const c of member) expect(admin.has(c)).toBe(true);
    // Monotonicity is not decoration: it is what makes "OWNER: everything" a
    // checkable claim rather than a comment.
    expect([...owner].sort()).toEqual([...ORG_CAPABILITIES].sort());
  });

  it('BILLING is the exact mirror of ADMIN on money, and has no people powers', () => {
    expect(roleCan('BILLING', 'billing:update')).toBe(true);
    expect(roleCan('BILLING', 'billing:read')).toBe(true);
    // ADMIN may READ billing but not change it; BILLING may not touch people.
    expect(roleCan('ADMIN', 'billing:update')).toBe(false);
    for (const c of ['member:read', 'member:invite', 'member:role', 'member:remove', 'member:grant-senior'] as OrgCapability[]) {
      expect({ capability: c, allowed: roleCan('BILLING', c) }).toEqual({ capability: c, allowed: false });
    }
  });

  it('a plain MEMBER can see the org but never its roster', () => {
    expect(roleCan('MEMBER', 'org:read')).toBe(true);
    expect(roleCan('MEMBER', 'member:read')).toBe(false);
  });

  it('only OWNER may grant or revoke a senior role', () => {
    expect(roleCan('OWNER', 'member:grant-senior')).toBe(true);
    expect(roleCan('ADMIN', 'member:grant-senior')).toBe(false);
    expect(roleCan('BILLING', 'member:grant-senior')).toBe(false);
    expect(roleCan('MEMBER', 'member:grant-senior')).toBe(false);
  });

  it('denies by default for a null, empty or unknown role', () => {
    for (const bad of [null, undefined, '', 'SUPERUSER', 'owner ']) {
      // 'owner ' (trailing space) is not a role — normalize with trim, not by
      // trusting whatever a future migration writes into the column.
      for (const c of ORG_CAPABILITIES) {
        expect({ bad, c, allowed: roleCan(bad, c) }).toEqual({ bad, c, allowed: false });
      }
    }
  });

  it('accepts a lowercase role (defensive, never required by the schema)', () => {
    expect(roleCan('admin', 'member:invite')).toBe(true);
    expect(roleCan('owner', 'billing:update')).toBe(true);
  });
});

describe('roleRank — seniority for the "not your peer" rule', () => {
  it('orders OWNER > ADMIN > BILLING = MEMBER', () => {
    expect(roleRank('OWNER')).toBeGreaterThan(roleRank('ADMIN'));
    expect(roleRank('ADMIN')).toBeGreaterThan(roleRank('BILLING'));
    expect(roleRank('BILLING')).toBe(roleRank('MEMBER'));
    expect(roleRank('MEMBER')).toBeGreaterThan(0);
  });

  it('ranks an unknown role BELOW everyone (a value this code cannot read must not outrank an admin)', () => {
    expect(roleRank('SOMETHING_NEW')).toBeLessThan(roleRank('MEMBER'));
    expect(roleRank(null)).toBe(0);
  });
});

describe('role predicates used by the routes (so no route names a role literal)', () => {
  it('isSeniorRole covers exactly OWNER and ADMIN', () => {
    expect(ORG_ROLES.filter((r) => isSeniorRole(r))).toEqual(['OWNER', 'ADMIN']);
  });

  it('isOwnerRole covers exactly OWNER', () => {
    expect(ORG_ROLES.filter((r) => isOwnerRole(r))).toEqual(['OWNER']);
  });

  it('requiresSeniorGrant fires when seniority is on EITHER side of the change', () => {
    expect(requiresSeniorGrant('MEMBER', 'OWNER')).toBe(true); // promotion to owner
    expect(requiresSeniorGrant('OWNER', 'MEMBER')).toBe(true); // demotion of an owner
    expect(requiresSeniorGrant('ADMIN', 'MEMBER')).toBe(true); // stripping an admin
    expect(requiresSeniorGrant('MEMBER', 'ADMIN')).toBe(true); // minting an admin
    expect(requiresSeniorGrant('MEMBER', 'BILLING')).toBe(false); // ordinary reseat
    expect(requiresSeniorGrant('BILLING', 'MEMBER')).toBe(false);
  });

  it('orgRoleLabel falls back to MEMBER for garbage (never echoes attacker input into an error)', () => {
    expect(orgRoleLabel('BILLING')).toBe('BILLING');
    expect(orgRoleLabel('anything-else')).toBe('MEMBER');
    expect(orgRoleLabel(undefined)).toBe('MEMBER');
  });

  it('normalizeOrgRole canonicalizes a known role and returns null for anything else', () => {
    // null (not MEMBER) for an unknown value is what keeps an unreadable role
    // POWERLESS: coercing it to MEMBER would hand it org:read on a guess during a
    // blue/green schema window where the column holds a role this build lacks.
    expect(normalizeOrgRole('admin')).toBe('ADMIN');
    expect(normalizeOrgRole('BILLING')).toBe('BILLING');
    expect(normalizeOrgRole('FUTURE_ROLE')).toBeNull();
    expect(normalizeOrgRole('')).toBeNull();
    expect(normalizeOrgRole(null)).toBeNull();
  });

  it('outranksForMemberAction: strictly senior always; OWNER may act on OWNER; peers may not', () => {
    expect(outranksForMemberAction('OWNER', 'ADMIN')).toBe(true);
    expect(outranksForMemberAction('OWNER', 'OWNER')).toBe(true); // top rank: the last-owner guard protects the org
    expect(outranksForMemberAction('ADMIN', 'OWNER')).toBe(false);
    expect(outranksForMemberAction('ADMIN', 'MEMBER')).toBe(true);
    expect(outranksForMemberAction('ADMIN', 'ADMIN')).toBe(false); // peers may not touch each other
    expect(outranksForMemberAction('MEMBER', 'BILLING')).toBe(false); // same rank
    expect(outranksForMemberAction('BILLING', 'MEMBER')).toBe(false);
    expect(outranksForMemberAction('MEMBER', 'OWNER')).toBe(false);
    // An unreadable role never outranks anything, and nothing acts on it either.
    expect(outranksForMemberAction('FUTURE_ROLE', 'MEMBER')).toBe(false);
  });

  it('the invite default is the LEAST-power seat', () => {
    expect(DEFAULT_MEMBER_ORG_ROLE).toBe('MEMBER');
    expect([...capabilitiesOf(DEFAULT_MEMBER_ORG_ROLE)]).toEqual(['org:read']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveMembership — the one indexed read
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveMembership', () => {
  it('reads ONE row on the unique (userId, organizationId) pair and returns only what authz needs', async () => {
    db.membership.findUnique.mockResolvedValue({ organizationId: 'org-a', userId: 'u-1', role: 'ADMIN' });
    const m = await resolveMembership('u-1', 'org-a');
    expect(m).toEqual({ organizationId: 'org-a', userId: 'u-1', role: 'ADMIN' });
    const arg = db.membership.findUnique.mock.calls[0][0];
    // The compound-unique selector, not a findFirst with a role predicate: one
    // row, one index, and no way to "find the admin membership" by accident.
    expect(arg.where).toEqual({ userId_organizationId: { userId: 'u-1', organizationId: 'org-a' } });
    expect(arg.select).toEqual({ organizationId: true, userId: true, role: true });
  });

  it('returns null (not a throw) for a genuine non-member', async () => {
    db.membership.findUnique.mockResolvedValue(null);
    await expect(resolveMembership('u-2', 'org-a')).resolves.toBeNull();
  });

  it('returns null without touching the database for an empty id', async () => {
    await expect(resolveMembership('', 'org-a')).resolves.toBeNull();
    await expect(resolveMembership('u-1', '')).resolves.toBeNull();
    expect(db.membership.findUnique).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireOrgCapability — 404 for strangers, 403 for members without the power
// ─────────────────────────────────────────────────────────────────────────────
describe('requireOrgCapability', () => {
  it('404s a NON-MEMBER — never 403', async () => {
    db.membership.findUnique.mockResolvedValue(null);
    // THE ISOLATION PROPERTY. A 403 would mean "this org exists and is not
    // yours", which confirms the id and lets an outsider enumerate tenants by
    // probing uuids (they leak via links, screenshots and support threads).
    // 404 makes a foreign tenant indistinguishable from a nonexistent one.
    await expect(requireOrgCapability('u-1', 'org-b', 'org:read')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Workspace not found',
    });
  });

  it('404s identically for MEMBER-level capabilities and for admin ones (no oracle by status)', async () => {
    db.membership.findUnique.mockResolvedValue(null);
    for (const capability of ORG_CAPABILITIES) {
      const err = await requireOrgCapability('u-1', 'org-b', capability).catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect({ capability, status: err.statusCode, message: err.message }).toEqual({
        capability,
        status: 404,
        message: 'Workspace not found',
      });
    }
  });

  it('403s a MEMBER who lacks the capability, naming the capability but leaking no org data', async () => {
    db.membership.findUnique.mockResolvedValue({ organizationId: 'org-a', userId: 'u-1', role: 'MEMBER' });
    const err = await requireOrgCapability('u-1', 'org-a', 'member:read').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(403);
    expect(err.message).toContain('MEMBER');
    expect(err.message).toContain('member:read');
    // Nothing about the org itself (name, slug, plan, member count) may appear.
    expect(err.message).not.toMatch(/org-a|slug|plan/);
  });

  it('returns the membership when the capability is held', async () => {
    db.membership.findUnique.mockResolvedValue({ organizationId: 'org-a', userId: 'u-1', role: 'ADMIN' });
    await expect(requireOrgCapability('u-1', 'org-a', 'member:invite')).resolves.toEqual({
      organizationId: 'org-a',
      userId: 'u-1',
      role: 'ADMIN',
    });
  });

  it('resolves membership AGAIN on every call (a revoked member loses access immediately)', async () => {
    db.membership.findUnique.mockResolvedValueOnce({ organizationId: 'org-a', userId: 'u-1', role: 'ADMIN' });
    await requireOrgCapability('u-1', 'org-a', 'member:read');
    // The row is gone on the next request — no cached role, no token claim.
    db.membership.findUnique.mockResolvedValueOnce(null);
    await expect(requireOrgCapability('u-1', 'org-a', 'member:read')).rejects.toMatchObject({ statusCode: 404 });
    expect(db.membership.findUnique).toHaveBeenCalledTimes(2);
  });

  it('a BILLING member may act on billing but not on people', async () => {
    db.membership.findUnique.mockResolvedValue({ organizationId: 'org-a', userId: 'u-1', role: 'BILLING' });
    await expect(requireOrgCapability('u-1', 'org-a', 'billing:update')).resolves.toMatchObject({ role: 'BILLING' });
    await expect(requireOrgCapability('u-1', 'org-a', 'member:remove')).rejects.toMatchObject({ statusCode: 403 });
  });
});
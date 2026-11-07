/**
 * ORG ACCESS — the ONE place a `memberships.role` value is interpreted
 * (Phase 3 Enterprise RBAC, todo c45f065e).
 *
 * THE GAP THIS CLOSES. `Membership` and the `OrgRole` enum shipped with the
 * Phase 2 Cloud migration, and since then the role column has been written
 * exactly once (org.service.ts ensurePersonalOrg stamps the creator OWNER) and
 * READ BY NO AUTHORIZATION DECISION ANYWHERE. A role nobody consults is a
 * comment, not a permission system: any authenticated user who learns an org id
 * could act on it. This file turns the column into the authority.
 *
 * WHY ONE TABLE AND NOT `role === 'OWNER'` CHECKS AT EACH CALL SITE. Every
 * hand-written role comparison is a place the four roles and the growing set of
 * capabilities can disagree with each other; the first bug is "the billing route
 * forgot that ADMIN also means no billing:update". So the mapping lives here as
 * DATA, `roleCan` is a set lookup with no branching, and a structural test
 * (org-members.routes.test.ts) fails the suite if a new ad-hoc role comparison
 * appears anywhere else under this directory. Adding a capability therefore
 * fails LOUDLY — the exhaustive capability-table test pins every
 * role × capability pair, so a new one cannot be silently unhandled.
 *
 * WHY NON-MEMBERSHIP IS 404 AND NEVER 403 — the isolation property. A 403 means
 * "you asked for something that exists and you may not have it", which confirms
 * the org id is real. Org ids are uuids in URLs that leak through browser
 * history, screenshots, support tickets and copied links, so a 403 here would
 * hand an outsider a cross-tenant EXISTENCE ORACLE: probe ids, distinguish
 * "exists but not mine" (403) from "does not exist" (404), enumerate an
 * arbitrary number of other tenants. Collapsing both into 404 means a tenant the
 * caller is not in is INDISTINGUISHABLE from a tenant that was never created,
 * which is the property the whole endpoint family rests on. The same reasoning
 * is why a member who lacks a capability DOES get a 403: at that point the
 * caller has already proven they belong to the org, so there is no tenancy fact
 * left to hide.
 *
 * WHY MEMBER'S org:read IS NOT A HOLE. Every user is placed in exactly one
 * personal org and bills against it, so "which org am I in" has to be readable
 * by everyone or the tenant switcher cannot render. org:read exposes the org
 * itself — never the roster: member:read is a separate capability precisely so
 * a plain member cannot enumerate their colleagues, which is a privacy decision
 * rather than a convenience one.
 *
 * SERVER-SIDE BY CONSTRUCTION: `req.user` carries no org claim (middleware/auth
 * .ts builds it from the JWT: id/userId/email/role/isChild/parentId). The org a
 * request acts on is always the `:orgId` in its path, resolved against the
 * database here — a client cannot assert membership by putting a claim in a
 * token, and revoking a member takes effect on their very next request instead
 * of at token expiry.
 */
import type { OrgRole } from '@prisma/client';
import prisma from '../../../config/database';
import { AppError } from '../../../middleware/app-error';

/**
 * Every role the enum defines, in RANK ORDER (highest first). Kept as a runtime
 * array so the capability-table test can iterate it and fail when a role is
 * added to the schema but not to the table below (a `Record<OrgRole, …>` forces
 * the type error; this array is what forces the TEST).
 */
export const ORG_ROLES = ['OWNER', 'ADMIN', 'BILLING', 'MEMBER'] as const;

export type OrgRoleName = (typeof ORG_ROLES)[number];

/**
 * What a role may DO. Named `verb:noun` and deliberately coarse: a capability is
 * a user-visible power ("may add staff"), not an endpoint. Several routes share
 * one capability (all five member operations are covered by three), which is
 * what keeps the table readable and makes "what can an ADMIN do?" answerable
 * without reading any route.
 */
export type OrgCapability =
  /** See the org itself (name, slug, plan). Held by every member. */
  | 'org:read'
  /** Change org-wide settings (name/slug). Never suspending — that is an operator lever. */
  | 'org:update'
  /** See the member roster. Deliberately NOT implied by org:read (privacy). */
  | 'member:read'
  /** Add an existing user to the org. */
  | 'member:invite'
  /** Change another member's role. */
  | 'member:role'
  /** Remove another member from the org. */
  | 'member:remove'
  /** See billing details (plan, spend, invoices). */
  | 'billing:read'
  /** Change billing details (payment method, billing contact, plan purchase). NOT member management. */
  | 'billing:update'
  /**
   * Grant or revoke a SENIOR role (OWNER or ADMIN) on another member. Held by
   * OWNER ALONE — not by ADMIN, which holds member:role. Two capabilities
   * instead of one because "may reshuffle the staff" and "may mint a peer of
   * the owner" are different powers: with a single capability an ADMIN could
   * promote a second account to OWNER and then act through it, which is the
   * escalation chain this split breaks. Expressed as data rather than a
   * `role === 'OWNER'` branch so the routes stay literal-free (structural test).
   */
  | 'member:grant-senior';

/**
 * The capability table — THE authority for this whole module family.
 *
 * Read it as an answer to "what can each role do", not as an endpoint list:
 *   - OWNER   everything, including granting/revoking OWNER itself;
 *   - ADMIN   runs the tenant day to day but may only READ billing. A member
 *             manager who can also redirect payments is a single compromised
 *             account away from taking the money with them, so billing:update
 *             stays out of ADMIN deliberately;
 *   - BILLING the mirror image: money, no people. It cannot invite, promote or
 *             remove anyone, so an accountant account cannot grant itself more
 *             access (a BILLING member promoting themselves to OWNER is exactly
 *             the escalation this table makes impossible);
 *   - MEMBER  org:read only. They may see the tenant they belong to (the
 *             switcher needs it) and nothing about its people.
 */
const CAPABILITIES: Record<OrgRoleName, ReadonlySet<OrgCapability>> = {
  OWNER: new Set<OrgCapability>([
    'org:read',
    'org:update',
    'member:read',
    'member:invite',
    'member:role',
    'member:remove',
    'billing:read',
    'billing:update',
    // OWNER alone can mint/strip seniority — see the capability's doc comment.
    'member:grant-senior',
  ]),
  ADMIN: new Set<OrgCapability>([
    'org:read',
    'org:update',
    'member:read',
    'member:invite',
    'member:role',
    'member:remove',
    // Read-only billing — see the table's comment for why update is withheld.
    'billing:read',
    // NOT member:grant-senior: an ADMIN may reshuffle MEMBER/BILLING seats but
    // may not mint an OWNER (or a peer ADMIN) — that is how a single admin
    // account would otherwise escalate itself into ownership.
  ]),
  BILLING: new Set<OrgCapability>(['org:read', 'billing:read', 'billing:update']),
  MEMBER: new Set<OrgCapability>(['org:read']),
};

/** Every capability, for the exhaustive table test and for future admin UIs. */
export const ORG_CAPABILITIES: readonly OrgCapability[] = [
  'org:read',
  'org:update',
  'member:read',
  'member:invite',
  'member:role',
  'member:remove',
  'billing:read',
  'billing:update',
  'member:grant-senior',
];

/** The capabilities of one role. Returns an empty set for an unknown value — deny by default. */
export function capabilitiesOf(role: string | null | undefined): ReadonlySet<OrgCapability> {
  const key = String(role ?? '').toUpperCase() as OrgRoleName;
  return CAPABILITIES[key] ?? new Set<OrgCapability>();
}

/**
 * Canonicalize a role value, or null when this code does not recognize it.
 *
 * WHY null AND NOT A MEMBER DEFAULT: `memberships.role` is an enum in the
 * database, so a value outside this set can only arrive if the schema gains a
 * role this build does not know yet (a blue/green window), or the column was
 * edited by hand. Silently treating that as MEMBER would grant org:read on a
 * guess; null holds ZERO capabilities (deny by default) and ranks below everyone,
 * so an unreadable role can never outrank an admin. The failure is loud in
 * exactly the right direction — the affected member is refused and asks, rather
 * than being handed powers nobody intended.
 */
export function normalizeOrgRole(role: string | null | undefined): OrgRoleName | null {
  const key = String(role ?? '').toUpperCase();
  return (ORG_ROLES as readonly string[]).includes(key) ? (key as OrgRoleName) : null;
}

/** Does `role` hold `capability`? Pure, total, and the ONLY role→power decision. */
export function roleCan(role: string | null | undefined, capability: OrgCapability): boolean {
  return capabilitiesOf(role).has(capability);
}

/**
 * Seniority, used ONLY for the "you may not act on someone at or above your own
 * rank" rule. BILLING and MEMBER deliberately share rank 1: neither may touch
 * the other, and neither may touch an ADMIN — equal-or-higher is refused, so a
 * shared rank is exactly the intended "peers cannot act on each other" outcome.
 */
export function roleRank(role: string | null | undefined): number {
  switch (String(role ?? '').toUpperCase()) {
    case 'OWNER':
      return 3;
    case 'ADMIN':
      return 2;
    case 'BILLING':
    case 'MEMBER':
      return 1;
    default:
      // Unknown/garbage role: least privilege. A row written by a future
      // migration this code does not understand must never outrank an ADMIN.
      return 0;
  }
}

/** Human label for error text and UI ("a BILLING member"). Falls back to MEMBER's text. */
export function orgRoleLabel(role: string | null | undefined): OrgRoleName {
  const key = String(role ?? '').toUpperCase();
  return ((ORG_ROLES as readonly string[]).includes(key) ? key : 'MEMBER') as OrgRoleName;
}

/**
 * Is this one of the TWO senior roles (OWNER or ADMIN)? Kept as a true
 * predicate rather than two literal comparisons at each call site so the set of
 * senior roles is stated once — the same reason the capability table exists.
 */
export function isSeniorRole(role: string | null | undefined): boolean {
  const key = String(role ?? '').toUpperCase();
  return key === 'OWNER' || key === 'ADMIN';
}

/** The single role that may never be removed while it is the last of its kind. */
export function isOwnerRole(role: string | null | undefined): boolean {
  return String(role ?? '').toUpperCase() === 'OWNER';
}

/**
 * The role every newly added member starts at. Exported (rather than a literal at
 * the insert site) so "an invite grants the LEAST power" is stated in the module
 * that owns role semantics — and so the structural test can hold the whole
 * directory to the one-place rule.
 */
export const DEFAULT_MEMBER_ORG_ROLE = 'MEMBER' as const;

/**
 * Does this role change require the OWNER-only `member:grant-senior` capability?
 * True the moment SENIORITY is on either side of the change: granting a senior
 * role is minting power, and revoking one is disarming someone. A change between
 * two non-senior seats (MEMBER ⇄ BILLING) is ordinary `member:role` work.
 */
export function requiresSeniorGrant(currentRole: string | null | undefined, nextRole: string | null | undefined): boolean {
  return isSeniorRole(currentRole) || isSeniorRole(nextRole);
}

/**
 * May `actorRole` act on a member who currently holds `targetRole`?
 *
 * The rule is "not on someone at or above your own rank", with ONE deliberate
 * exception: two OWNERs may act on each other. Without it, an owner could never
 * remove or demote another owner, so the LAST-OWNER 400 guard below would be
 * unreachable dead code — and every owner who ever leaves a workspace would
 * need a database edit to do it. The top rank has no superior to appeal to, so
 * the orphan guard (not the rank rule) is what protects the workspace; an ADMIN
 * (rank 2) still never outranks an OWNER (rank 3), which is the case that
 * actually matters.
 */
export function outranksForMemberAction(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  if (isOwnerRole(actorRole) && isOwnerRole(targetRole)) return true;
  return roleRank(actorRole) > roleRank(targetRole);
}

/** A resolved membership row — just what authorization needs, never the user's data. */
export interface OrgMembership {
  organizationId: string;
  userId: string;
  /**
   * The canonical role name, or the RAW stored value when this build does not
   * recognize it. Not narrowed to OrgRoleName on purpose: a role this build
   * cannot read must flow through to `capabilitiesOf` (empty set) and
   * `roleRank` (0) as an unknown, instead of being coerced into MEMBER — which
   * would grant org:read on a guess during a blue/green schema window.
   */
  role: OrgRoleName | string;
}

/**
 * The caller's membership of ONE org, or null. One indexed read on the
 * `@@unique([userId, organizationId])` pair, so it is a single-row lookup on the
 * hot path of every org-scoped request.
 */
export async function resolveMembership(userId: string, orgId: string): Promise<OrgMembership | null> {
  if (!userId || !orgId) return null;
  const row = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId: orgId } },
    select: { organizationId: true, userId: true, role: true },
  });
  if (!row) return null;
  return {
    organizationId: row.organizationId,
    userId: row.userId,
    // Canonical when known, raw when not — see OrgMembership.role.
    role: normalizeOrgRole(row.role) ?? String(row.role),
  };
}

/**
 * THE GATE every org-scoped handler calls first. Returns the membership on
 * success; throws on refusal.
 *   not a member        → 404 'Workspace not found'  (see the file header: a 403
 *                         would confirm the org id exists across tenants)
 *   member, no capability → 403, naming the capability but never the org's data
 *
 * Ordering is load-bearing: membership is resolved BEFORE the capability check,
 * and the non-member branch never mentions the org, so the two answers cannot be
 * distinguished by message, status or timing intent.
 */
export async function requireOrgCapability(
  userId: string,
  orgId: string,
  capability: OrgCapability,
): Promise<OrgMembership> {
  const membership = await resolveMembership(userId, orgId);
  if (!membership) throw new AppError(404, 'Workspace not found');
  if (!roleCan(membership.role, capability)) {
    throw new AppError(
      403,
      `Your ${orgRoleLabel(membership.role)} role in this workspace does not allow ${capability}`,
    );
  }
  return membership;
}

/** The Prisma column type, re-exported so routes never import @prisma/client directly. */
export type { OrgRole };
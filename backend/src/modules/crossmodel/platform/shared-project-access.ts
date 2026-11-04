/**
 * SHARED-PROJECT-DISPATCH (supervisor SOTA round 3, 2026-10-20) — the pure
 * rules for starting a coding session (a lane) in a project the caller does
 * not OWN but is a member of.
 *
 * The incident (ticket 22d667e7, 2026-10-18): a project-supervisor chat whose
 * account is an EDITOR on a shared (transferred) project could create goals
 * and todos there (goals.service requireProjectWrite admits editor/admin) but
 * start_coding_session refused it FOUR ways — "Project not found or no access"
 * for a project it could list, and "goal … not found in your account" for the
 * goal it had created seconds earlier. Two causes: resolveCodingSessionTarget
 * (platform.service) had no membership leg (owner-only lookups), and the
 * charter lookups scoped goals / todos by the CALLER's userId while goals are
 * stamped with the PROJECT OWNER's id (goals.service createGoal). The plan →
 * dispatch loop dead-ended for every shared or transferred project.
 *
 * The rules (owner decision 2026-10-20, "autonomously do all of this" — ON by
 * default):
 *  - only the project OWNER and members with WRITE access (role editor or
 *    admin) may start a lane; a VIEWER stays read-only and can never cause a
 *    spawn;
 *  - the session's RUN IDENTITY is the PROJECT OWNER — the chat row, the
 *    preferences / model stamp, spend and quota all stay with the owner (the
 *    member's role only authorizes the start);
 *  - every member-caused spawn is audited: spawnedByUserId + the member's
 *    role ride the audit row and the tool envelope;
 *  - every refusal names the caller's role.
 *
 * Kill switch SPAWN_MEMBER_ACCESS_DISABLED=1 restores the owner-only resolver
 * and the userId-scoped charter lookups (the refusal still names the role).
 *
 * LEAF: pure helpers only (no prisma, no logger) — platform.service,
 * platform-tools and session-topology do the I/O.
 */

export type SharedProjectRole = 'owner' | 'admin' | 'editor' | 'viewer';

const onFlag = (v: unknown): boolean => /^(1|true|on|yes)$/i.test(String(v ?? '').trim());

/** SPAWN_MEMBER_ACCESS_DISABLED=1 — owner-only spawns + caller-scoped charter lookups, as before 2026-10-20. */
export function spawnMemberAccessDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.SPAWN_MEMBER_ACCESS_DISABLED);
}

/** True for a role that may start a lane (owner / admin / editor). Pure. */
export function isWriterRole(role: string | null | undefined): role is 'owner' | 'admin' | 'editor' {
  return role === 'owner' || role === 'admin' || role === 'editor';
}

/** How a refusal names the caller's role. Pure. */
export function describeCallerRole(role: SharedProjectRole | null | undefined): string {
  switch (role) {
    case 'owner': return 'owner';
    case 'admin': return 'admin (member)';
    case 'editor': return 'editor (member)';
    case 'viewer': return 'viewer (read-only member)';
    default: return 'none — not the owner and not a member';
  }
}

/**
 * The refusal a start_coding_session caller gets when the project does not
 * resolve for it as a WRITER. `role` null = no relationship at all (the
 * existence-safe "not found or no access" wording is kept — the tool's 404
 * recovery keys on it). Pure.
 */
export function spawnAccessRefusal(opts: { projectId: string; role: SharedProjectRole | null; memberAccessDisabled?: boolean }): string {
  const pid = String(opts.projectId ?? '');
  const role = opts.role;
  if (role === 'viewer') {
    return `Cannot start a coding session in project "${pid}": your role on it is ${describeCallerRole(role)} — only the owner, an admin or an editor can start lanes there. Ask the project owner to raise your role to editor, or to start the session.`;
  }
  if ((role === 'editor' || role === 'admin') && opts.memberAccessDisabled) {
    return `Cannot start a coding session in project "${pid}": your role on it is ${describeCallerRole(role)}, and member-started sessions are switched off on this instance (SPAWN_MEMBER_ACCESS_DISABLED=1) — the project owner must start it.`;
  }
  return `Project not found or no access (projectId: "${pid}"; your role on it: ${describeCallerRole(role)}).`;
}

/**
 * The line a member-caused spawn carries on its tool envelope: whose identity
 * the session runs as, that spend / quota are the owner's, that it runs with
 * the OWNER's coding credentials + GitHub token (review fix 2026-10-20: the
 * credential exposure is stated, not implied — session-credentials injects
 * the session owner's account-wide CodingCredentials), and that the start is
 * audited under the caller. Pure.
 */
export function memberSpawnNote(opts: { role: SharedProjectRole; ownerUserId: string; projectId: string }): string {
  return `SHARED PROJECT: you are ${describeCallerRole(opts.role)} on project ${opts.projectId}, so this session runs as the PROJECT OWNER (account ${String(opts.ownerUserId).slice(0, 8)}) — its model, spend and quota are the owner's, it runs with the owner's coding credentials and GitHub token (keep its prompt to this project's work), and the start is audited with your account as spawnedBy.`;
}

/**
 * Can a caller read a charter row (a goal / todo) by id? The row is readable
 * when the caller owns it, or — member access on — when the caller has ANY
 * role on the row's project (`projectRole`, resolved by the caller with
 * getProjectAccess; null = none). Off ⇒ owner only (the pre-fix lookup). Pure.
 */
export function charterRowReadable(
  row: { userId?: string | null; projectId?: string | null } | null | undefined,
  callerUserId: string,
  projectRole: SharedProjectRole | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!row) return false;
  if (row.userId && row.userId === callerUserId) return true;
  if (spawnMemberAccessDisabled(env)) return false;
  return !!projectRole;
}

/**
 * The charter lookup (goal / todo by id) every spawn-path caller shares —
 * dependency-injected so the rule is unit-testable without prisma:
 *  1. the caller-owned row (byte-identical to the pre-fix lookup — an owner
 *     never pays a second read);
 *  2. member access on: the row by id (callers scope it by { id, projectId }
 *     when the project is known), returned only when the caller has a role on
 *     the row's project (`projectRole`) — a row the caller cannot read stays
 *     "not found", existence never leaks.
 * Never throws: any lookup error is "not found" (the caller's refusal path).
 */
export async function lookupCharterRow<T extends { userId?: string | null; projectId?: string | null }>(
  deps: {
    findOwned: () => Promise<T | null | undefined>;
    findById: () => Promise<T | null | undefined>;
    projectRole: (projectId: string) => Promise<SharedProjectRole | null | undefined>;
  },
  callerUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T | null> {
  try {
    const owned = await deps.findOwned();
    if (owned) return owned;
    if (spawnMemberAccessDisabled(env)) return null;
    const row = await deps.findById();
    if (!row || !row.projectId) return null;
    if (row.userId && row.userId === callerUserId) return row;
    const role = (await deps.projectRole(String(row.projectId)).catch(() => null)) ?? null;
    return charterRowReadable(row, callerUserId, role, env) ? row : null;
  } catch {
    return null;
  }
}

/**
 * SUPERVISION SCOPE — the ONE place that answers "is this project inside the
 * Fleet Supervisor's scope?" (ticket dca83b85).
 *
 * `crossModelProject.supervised === false` is the owner's fleet-supervision
 * opt-out. It is NOT a display flag: an opted-out project emits nothing to the
 * owner-scope wildcard hook (hooks.service), gets no digest (project-digest),
 * no watchdog alert (attention-watchdog) and — since this leaf — is excluded
 * from every FLEET composition surface (board roll-up, attention block,
 * liveness block/snapshot, and therefore the owner briefing that is written
 * from them).
 *
 * WHAT THE FLAG DOES NOT DO (deliberate, unchanged):
 *  - it never silences an explicitly wired DIRECT hook (a user subscribed that
 *    lane to a chat on purpose) nor a PROJECT-scope hook (the project's own
 *    supervisor lane is independent plumbing: `projectSupervisorEnabled`);
 *  - it never means "no project supervisor" — the two settings are
 *    independent, so `projectSupervisorEnabled: true` on an opted-out project
 *    keeps that project's OWN supervisor working inside its own project flow.
 *
 * FAIL-OPEN: an absent/unreadable project row is SUPERVISED (`!== false`),
 * matching the schema default and every other site in the repo — an ungrouped
 * chat, a deleted row mid-read or a partial select must never silently drop
 * work out of the fleet's view.
 *
 * Pure leaf ON PURPOSE: the composition services and their jest suites import
 * this module, so it never drags prisma/logger/env behind it.
 */

/** The minimum a row must carry to answer the question. */
export interface SupervisionShape {
  supervised?: boolean | null;
}

/**
 * TRUE only when the project explicitly opted OUT of fleet supervision.
 * `undefined`/`null` (legacy rows, partial selects) read as supervised.
 */
export function isUnsupervisedProject(project: SupervisionShape | null | undefined): boolean {
  return project?.supervised === false;
}

/**
 * The opted-out project ids from an already-fetched row set — the shape every
 * composition surface needs to subtract them from a `projectId: { notIn }`
 * filter without inventing a second SQL predicate per call site.
 */
export function unsupervisedProjectIds(
  projects: ReadonlyArray<{ id: string; supervised?: boolean | null }> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const p of projects ?? []) {
    if (p && p.id && isUnsupervisedProject(p)) out.add(p.id);
  }
  return out;
}

/**
 * The chat-id leg of the same subtraction: owner-question rows carry a chatId
 * (the flagging run's session) and an optional forChatId, never a projectId —
 * a caller holding `(chatId, projectId)` pairs uses this to drop questions
 * raised inside opted-out projects.
 */
export function chatIdsInUnsupervisedProjects(
  chats: ReadonlyArray<{ id: string; projectId?: string | null }> | null | undefined,
  optedOut: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const c of chats ?? []) {
    if (c && c.id && c.projectId && optedOut.has(c.projectId)) out.add(c.id);
  }
  return out;
}
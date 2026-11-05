/**
 * FLEET TOOL SCOPE (ticket 03d14b78) — the follow-up to dca83b85's
 * supervision-scope leaf: the FLEET SUPERVISOR's account-wide TOOL READS must
 * obey the same opt-out the composition surfaces already do.
 *
 * THE RESIDUAL THIS CLOSES. dca83b85 filtered the fleet's *composed* surfaces
 * (board roll-up, attention block, liveness table, owner briefing, needs-you
 * union) so an opted-out project never reached them. But the Fleet Supervisor's
 * own tool surface — `list_chats` / `goal_list` / `todo_list` / `list_projects`
 * with no scope argument — still answered ACCOUNT-WIDE, and those results are
 * composed into the model's context on ANY manual pull. An opted-out project's
 * names, ids and work therefore still entered a Fleet machine turn even though
 * its hooks/digests/briefings were filtered.
 *
 * WHO IS FILTERED — and who is emphatically NOT:
 *   - FILTERED: a machine run whose chat is the FLEET Supervisor chat
 *     (`crossModelChat.isSupervisor === true`). That is the fleet-wide seat
 *     that reads every project; it is the one seat whose account-wide reads are
 *     a supervision act.
 *   - NOT FILTERED: a PROJECT supervisor (`isProjectSupervisor === true`) — it
 *     works INSIDE its own project, including an opted-out one, and its scoped
 *     reads must keep working. Also untouched: a direct owner-anchored run
 *     (`userTurnAt` set on a non-machine turn) and every ordinary chat.
 *
 * WHAT IT DOES. The filter is SUBTRACTIVE and scope-only:
 *   - account-wide listings drop rows whose projectId is opted out, BEFORE any
 *     model-facing composition — no names, no ids, no per-project counts, and
 *     no "excluded projects" metadata (the opt-out is the owner's business,
 *     not a fact to leak back into the transcript through an exclusion hint);
 *   - an EXPLICIT lookup naming an opted-out project is REFUSED with a scope
 *     refusal rather than silently returning it (a silent empty list would read
 *     as data loss, the class this repo has fixed repeatedly) and rather than
 *     leaking the project back.
 *
 * FAIL-OPEN, exactly like supervision-scope: an unreadable project row is
 * SUPERVISED, the framework project is PERMANENTLY supervised (identity is
 * re-asserted on read for legacy flipped rows), and any lookup error degrades
 * to "nothing is out of scope" — an outage must never quietly narrow the
 * fleet's view of live work.
 *
 * Pure-ish leaf: it reads prisma lazily and pulls no service chain, so the
 * composition services and their jest suites can import it.
 */

import { isFrameworkProjectRow, instanceOwnRepoSlugSoft } from './framework-project';
import { unsupervisedProjectIds } from './supervision-scope';

/** Bound on the opted-out scan (pathology guard, mirrors the fleet views). */
const FLEET_TOOL_SCOPE_MAX = 500;

/**
 * The seat classification the four list tools need. `fleet` is the ONLY filtered
 * seat; `project` and `other` are untouched (see the module docblock).
 */
export type FleetToolSeat = 'fleet' | 'project' | 'other';

/**
 * Resolve the seat for a tool call from the RUN's chat row. A read failure
 * degrades to 'other' (unfiltered) — the same fail-open posture every
 * supervision site uses: an outage must not silently narrow a lane's reads.
 */
export async function fleetToolSeat(chatId: string | null | undefined): Promise<FleetToolSeat> {
  if (!chatId) return 'other';
  try {
    const { default: prisma } = await import('../../../config/database');
    const row = await prisma.crossModelChat.findUnique({
      where: { id: chatId },
      select: { isSupervisor: true, isProjectSupervisor: true },
    });
    if (!row) return 'other';
    if ((row as any).isSupervisor === true) return 'fleet';
    if ((row as any).isProjectSupervisor === true) return 'project';
    return 'other';
  } catch {
    return 'other';
  }
}

/**
 * TRUE when this call is a Fleet Supervisor ACCOUNT-WIDE read that must be
 * supervision-scoped: the fleet seat on a MACHINE run. A human turn anchored on
 * the fleet chat (the owner typing into it) reads the owner's own account and
 * is never narrowed — the same "machine supervision vs the owner's own read"
 * split dca83b85's `automatic` flag draws in archived-target-retire.
 */
export function fleetToolScopeApplies(
  seat: FleetToolSeat,
  ctx: { userTurnAt?: Date | null; machineTriggered?: boolean },
): boolean {
  if (seat !== 'fleet') return false;
  // Machine = the executor's origin-aware flag OR the absence of a user-turn
  // anchor — the exact predicate ops-tools.chatReadIsMachine uses.
  return ctx?.machineTriggered === true || !ctx?.userTurnAt;
}

/**
 * The opted-out project ids for a user — the ONE read the tool handlers use to
 * subtract them. TOTAL: any failure degrades to an EMPTY set (supervised by
 * default; fail-open).
 *
 * The framework project is re-asserted supervised on READ: a legacy row flipped
 * before the write guard shipped (or a direct DB edit) must never drop the
 * platform surface out of the Fleet's tool view.
 */
export async function fleetOutOfScopeProjectIds(userId: string): Promise<Set<string>> {
  try {
    const { default: prisma } = await import('../../../config/database');
    const rows = await prisma.crossModelProject.findMany({
      where: { userId, supervised: false },
      select: { id: true, supervised: true, repoUrl: true },
      take: FLEET_TOOL_SCOPE_MAX,
    });
    const ownRepo = instanceOwnRepoSlugSoft();
    return unsupervisedProjectIds(
      (rows as Array<{ id: string; supervised?: boolean | null; repoUrl?: string | null }>)
        .filter((p) => !isFrameworkProjectRow(p, ownRepo)),
    );
  } catch {
    return new Set<string>();
  }
}

/**
 * The scope refusal for an EXPLICIT read naming an opted-out project. Prose
 * (not JSON) on purpose: it is a refusal, not a payload, and callers parse
 * payloads from the first brace.
 *
 * It deliberately does NOT echo the project's name or id back — the caller
 * already typed an id, but re-stating it (and any Did-you-mean) would put the
 * opted-out surface back into the transcript.
 */
export function outOfScopeProjectRefusal(tool: string): string {
  return `${tool} REFUSED: that project is outside Fleet supervision (the owner took it out of the fleet's view), so it is not readable from this seat. Nothing was listed and the id is deliberately not echoed. Its own project supervisor and the owner still read it normally — do not retry this id, do not re-derive it from a project name, and do not report the project as missing or deleted. Work the projects that ARE in scope.`;
}

/**
 * TRUE when a service error IS the scope refusal (goals.service throws it as
 * AppError 403 on the explicit projectId / goalId paths). The tool layer
 * converts it to the refusal string so every out-of-scope read answers the
 * same way list_chats does — never as a bare "Tool failed".
 */
export function isOutOfScopeRefusal(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string } | null;
  return !!e && typeof e === 'object' && e.statusCode === 403
    && typeof e.message === 'string' && e.message.includes('outside Fleet supervision');
}

/** Drop project rows (the list_projects shape — rows ARE projects). */
export function dropOutOfScopeProjects<T extends { id?: string | null; supervised?: boolean | null }>(
  rows: readonly T[] | null | undefined,
  optedOut: ReadonlySet<string>,
): T[] {
  const all = rows ?? [];
  if (!optedOut.size) return all as T[];
  return (all as T[]).filter((r) => {
    if (!r?.id) return true;
    if (optedOut.has(String(r.id))) return false;
    // Defense in depth: a row that says supervised:false is out of scope even if
    // the id set could not be built for it (partial read / stale set).
    return r.supervised !== false;
  });
}
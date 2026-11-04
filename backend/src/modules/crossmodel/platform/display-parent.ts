/**
 * Display-only sidebar nesting (lane lifecycle, 2026-10-21, branch lanefix/nesting).
 *
 * WHY: the owner's crossmodel folder rendered every ticket lane ("ticket <id8>: …"),
 * family lane ("family av-mishap: …") and Fleet-spawned lane FLAT, as if nothing had
 * dispatched them. The sidebar nests only on crossmodel_chats.parentChatId, and the
 * only writer of that column is the start_coding_session TOOL (its calling chat). The
 * ticket drain spawns through platform.service startCodingSession with no parent at
 * all, and a Fleet spawn's parent is the Fleet chat — forced ungrouped and hidden in
 * the sidebar, so the lane can never nest in its folder.
 *
 * WHAT: a SEPARATE column, displayParentChatId = the project's Project Supervisor,
 * stamped once when startCodingSession creates an agent-origin session. The sidebar
 * (frontend/lib/chat-lineage.ts nestParentId) nests on parentChatId when that parent
 * is in the list, else on this field. parentChatId is deliberately NOT stamped: it
 * drives the parent's daily fire-cap billing (schedule.service), implicit parent
 * autonomy (autonomy.service / session-tools), [CHILD RUN FAILED] wakes
 * (child-failure-escalation), deliverable hand-off targeting (a supervisor parent
 * skips the result row) and the child reapers — making the PS every ticket lane's
 * parent would change all of them. This field changes only the sidebar, and
 * display-parent.isolation.test.ts pins that no other module reads it.
 *
 * Kill switch DISPLAY_PARENT_NESTING_DISABLED=1: nothing is written, nothing is
 * selected (the list rows are today's byte-for-byte), the sidebar nests on
 * parentChatId only and GET /projects/:id rows carry no lineage again.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { killSwitchOn } from '../../../utils/kill-switch';

/** DISPLAY_PARENT_NESTING_DISABLED=1 — no display parent is written or returned. */
export function displayParentNestingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return killSwitchOn(env.DISPLAY_PARENT_NESTING_DISABLED);
}

/**
 * The folder's Project Supervisor chat for this owner — the OLDEST unarchived one
 * (one per project by the partial unique index; the order is only a tiebreak).
 * Does NOT require projectSupervisorEnabled: a paused supervisor chat is still the
 * folder's supervisor row in the sidebar (spark-cluster 590d604e). Null when none.
 */
export async function resolveProjectSupervisorChatId(projectId: string, userId: string): Promise<string | null> {
  if (!projectId || !userId) return null;
  const row = await prisma.crossModelChat.findFirst({
    where: { projectId, userId, isProjectSupervisor: true, archivedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return row?.id ?? null;
}

/**
 * Stamp the display parent of a freshly created machine-spawned session. Returns
 * the supervisor id it wrote, or null (switch set, no supervisor, the chat IS the
 * supervisor, a value was already there, or any error). Never throws — a sidebar
 * hint must never fail a spawn. The write is guarded on a NULL column, so a value
 * is set once and never overwritten.
 */
export async function stampDisplayParent(opts: { chatId: string; projectId: string; userId: string }): Promise<string | null> {
  if (displayParentNestingDisabled()) return null;
  try {
    const ps = await resolveProjectSupervisorChatId(opts.projectId, opts.userId);
    if (!ps || ps === opts.chatId) return null;
    const res = await prisma.crossModelChat.updateMany({
      where: { id: opts.chatId, displayParentChatId: null },
      data: { displayParentChatId: ps },
    });
    return res.count > 0 ? ps : null;
  } catch (err: any) {
    logger.warn(`display-parent: stamp failed for ${String(opts.chatId).slice(0, 8)}: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Lane-home resolution for the ticket-dispatch service (leaf module).
 *
 * Extracted 2026-10-15 (ticket abc76ebc): two consumers need "which user
 * owns ticket lanes" — the dispatcher itself (spawn/queue decisions) and the
 * feedback close-gate's origin/main fallback (closure-evidence.ts), which
 * rides the LANE-HOME owner's GitHub token when the ticket's own owner has
 * none. A leaf module keeps closure-evidence's DYNAMIC import from pulling
 * ticket-dispatch.service (config/redis + delegation-tasks import weight,
 * and a cycle risk once ticket-dispatch imports closure-manifest).
 *
 * Pure resolution (no side effects); every failure degrades to null and the
 * caller's own fallback applies. No behavior change vs the inlined
 * resolveTicketLaneHome() it replaces.
 */

import prisma from '../../../config/database';
// The logger is loaded LAZILY (TICKET-FAMILY-ROUTING review, 2026-10-20): the
// ticket-family leaf resolves the lane home at FILING time (a noisy-family
// member is queued only when the fresh-lane drain can carry it), and a static
// logger import drags config/env — which process.exit(1)s a bare Jest worker —
// into every importer of that leaf. Only the not-found warn needs it.
function warnLater(message: string): void {
  void import('../../../utils/logger').then((m) => m.default.warn(message)).catch(() => {});
}

export interface TicketLaneHome {
  userId: string;
  projectId: string;
}

/**
 * Where ticket lanes live: TICKET_LANE_PROJECT_ID (owned by its project's
 * owner), else the standing lane chat's project (the framework repo
 * project). null = no home → the caller falls back to the standing-lane
 * path.
 */
export async function resolveTicketLaneHome(): Promise<TicketLaneHome | null> {
  const pid = String(process.env.TICKET_LANE_PROJECT_ID ?? '').trim();
  if (pid) {
    const p = await prisma.crossModelProject.findUnique({
      where: { id: pid },
      select: { id: true, userId: true },
    });
    if (p) return { userId: p.userId, projectId: p.id };
    warnLater(
      `ticket-dispatch: TICKET_LANE_PROJECT_ID ${pid.slice(0, 8)} not found — using the standing lane's project`,
    );
  }
  const laneId = String(process.env.PLATFORM_ENGINEER_CHAT_ID ?? '').trim();
  if (!laneId) return null;
  const chat = await prisma.crossModelChat.findUnique({
    where: { id: laneId },
    select: { userId: true, projectId: true },
  });
  return chat?.projectId ? { userId: chat.userId, projectId: chat.projectId } : null;
}

/**
 * idle-chat-archiver (durable cron, ticket bb86cee8 — owner ask 2026-09-14:
 * "how can we properly start auto archiving old sessions from the main
 * framework project folder? over 200 sessions now").
 *
 * Per-project OPT-IN via crossmodel_projects.autoArchiveIdleDays (null = off,
 * set through the project update path with a 1..365 bound). Hourly from the
 * worker's cron loop (DB-only — claimable on every worker incl. the 0-slot
 * one): for every enabled project, chats whose updatedAt is older than the
 * project's window are archived through THE SAME path the sidebar's Archive
 * button uses — platform.service archiveChat, which stamps
 * crossmodel_chats.archivedAt, flips the coding satellite to 'archived', and
 * writes the chat.archive audit row. Restore clears the stamp losslessly, so
 * a mis-archived chat is one click from back. This module NEVER hand-rolls a
 * parallel prisma update that would skip the audit (the rule-(e) precedent
 * only flipped the satellite — that gap is exactly what this job fixes).
 *
 * Per-candidate re-verification (run-reaper rule (e) discipline — the scan is
 * a hint, a fresh read decides). A candidate is SKIPPED when it:
 *   - is the Fleet Supervisor chat (isSupervisor) or a Project Supervisor
 *     chat (isProjectSupervisor) — pinned system rows, never auto-archived;
 *   - woke up since the scan (updatedAt moved inside the window);
 *   - has any ENABLED CodingSchedule (a cadence silently firing into a hidden
 *     chat is the surprise archiveChat's 409 blocks on the interactive path);
 *   - has an ACTIVE ChatShareLink — archiving does NOT deactivate share links
 *     today, so a publicly-shared chat stays live rather than becoming an
 *     archived-but-still-public surprise;
 *   - has a coding satellite that is running/provisioning.
 * archiveChat's own 409/400-class refusals (a run started or a schedule got
 * enabled in the race window after our read) are skip-and-log — one candidate
 * NEVER aborts the pass.
 *
 * Bounded: IDLE_ARCHIVE_SCAN_CAP candidates examined per pass TOTAL across all
 * enabled projects, oldest-updatedAt first — a backlog (the owner's 200+
 * sessions) drains over hourly passes, and the one-line summary says when
 * more remain.
 */

import prisma from '../../config/database';
import logger from '../../utils/logger';
import { archiveChat } from './platform/platform.service';
import { archiveCascadeDisabled } from './platform/lane-family-facts';

/** Candidates examined per pass, total across all enabled projects. */
export const IDLE_ARCHIVE_SCAN_CAP = 200;
/**
 * Third review (2026-10-22): the children archiveChat's cascade may take across
 * the WHOLE pass (one budget shared by every archive, not 50 per archived chat),
 * and each child must be idle the folder's own N days too (cascadeIdleMs) — a
 * child active hours ago never follows its N-day-idle parent. Passed only while
 * the archive cascade is on (ARCHIVE_CASCADE_DISABLED=1 = the pre-cascade call).
 */
export const IDLE_ARCHIVE_CASCADE_MAX_PER_PASS = 50;

const DAY_MS = 86_400_000;

interface EnabledProject {
  id: string;
  autoArchiveIdleDays: number | null;
}

export async function runIdleChatArchiverOnce(): Promise<void> {
  let projects: EnabledProject[];
  try {
    projects = await prisma.crossModelProject.findMany({
      where: { autoArchiveIdleDays: { not: null } },
      select: { id: true, autoArchiveIdleDays: true },
    });
  } catch (err: any) {
    logger.warn(`idle-chat-archiver: project scan failed (non-fatal): ${err?.message ?? err}`);
    return;
  }
  if (!projects.length) return; // feature off everywhere — the common case stays silent

  let remaining = IDLE_ARCHIVE_SCAN_CAP;
  let scanned = 0;
  let archived = 0;
  let skipped = 0;
  let moreRemain = false;
  const cascadeBudget = archiveCascadeDisabled() ? null : { remaining: IDLE_ARCHIVE_CASCADE_MAX_PER_PASS };
  // Fifth review (2026-10-22): one restore-audit memo per pass for every cascade the pass starts (cascade on only).
  const restoreAuditCache = cascadeBudget ? new Map<string, boolean>() : null;

  for (const project of projects) {
    if (remaining <= 0) { moreRemain = true; break; }
    const days = project.autoArchiveIdleDays!;
    const cutoff = new Date(Date.now() - days * DAY_MS);
    try {
      // Oldest-updatedAt first so a backlog drains in age order over passes.
      const candidates: Array<{ id: string }> = await prisma.crossModelChat.findMany({
        where: { projectId: project.id, archivedAt: null, updatedAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { updatedAt: 'asc' },
        take: remaining,
      });
      // A full-budget query means this project may hold more than we took.
      if (candidates.length === remaining) moreRemain = true;
      for (const c of candidates) {
        remaining--;
        scanned++;
        try {
          // Fresh read — the scan row is a hint; everything is re-verified
          // against live state before the archive lands.
          const chat = await prisma.crossModelChat.findUnique({
            where: { id: c.id },
            select: {
              id: true, userId: true, archivedAt: true, updatedAt: true,
              isSupervisor: true, isProjectSupervisor: true,
            },
          });
          if (!chat || chat.archivedAt || chat.updatedAt.getTime() > cutoff.getTime()) { skipped++; continue; }
          if (chat.isSupervisor || chat.isProjectSupervisor) { skipped++; continue; }
          const [enabledSchedules, shareLink, satellite] = await Promise.all([
            prisma.codingSchedule.count({ where: { sessionId: chat.id, enabled: true } }),
            prisma.chatShareLink.findUnique({
              where: { chatId: chat.id },
              select: { isActive: true, expiresAt: true },
            }),
            prisma.chatCodingState.findUnique({
              where: { id: chat.id },
              select: { status: true },
            }),
          ]);
          if (enabledSchedules > 0) { skipped++; continue; }
          // Archiving does NOT deactivate share links — a chat the world can
          // still read through a live link stays live (same active semantics
          // as sharing.controller getSharedChat: isActive && not expired).
          if (shareLink && shareLink.isActive && (!shareLink.expiresAt || shareLink.expiresAt.getTime() > Date.now())) {
            skipped++;
            continue;
          }
          if (satellite && (satellite.status === 'running' || satellite.status === 'provisioning')) { skipped++; continue; }

          // THE archiver — the archivedAt stamp, the satellite flip, and the
          // chat.archive audit all happen inside archiveChat, identically to
          // the interactive path (the owner is the actor: the cron acts on
          // their folder under their own setting).
          await archiveChat({ userId: chat.userId, chatId: chat.id, archived: true, ...(cascadeBudget ? { cascadeBudget, cascadeIdleMs: days * DAY_MS, ...(restoreAuditCache ? { restoreAuditCache } : {}) } : {}) });
          archived++;
          logger.info(`idle-chat-archiver: archived chat ${chat.id} (project ${project.id}, idle > ${days}d)`);
        } catch (err: any) {
          // 409/400-class refusals (a run started / a schedule got enabled in
          // the race window) are skip-and-log; so is anything else — one
          // candidate NEVER aborts the pass.
          skipped++;
          const status = err?.statusCode;
          if (status && status < 500) {
            logger.info(`idle-chat-archiver: chat ${c.id} refused (${status}: ${err?.message ?? err}) — skipped`);
          } else {
            logger.warn(`idle-chat-archiver: chat ${c.id} archive attempt failed (non-fatal): ${err?.message ?? err}`);
          }
        }
      }
    } catch (err: any) {
      logger.warn(`idle-chat-archiver: project ${project.id} pass failed (non-fatal): ${err?.message ?? err}`);
    }
  }

  logger.info(
    `idle-chat-archiver: pass complete — ${projects.length} project(s) enabled, ${scanned} candidate(s) examined, ` +
    `${archived} archived, ${skipped} skipped` +
    (moreRemain ? `, MORE REMAIN (cap ${IDLE_ARCHIVE_SCAN_CAP}/pass — backlog drains over passes)` : ''),
  );
}

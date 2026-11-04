/**
 * Content reports (M2-prep — App Store 1.2/1.4, Play UGC policy).
 *
 * A MINIMAL, purpose-built surface for the store-review story: the app must
 * offer a visible "report content" action and the operator must be able to
 * review what was reported. It deliberately does NOT ride the
 * user_feature_requests feedback lane — that table is the product-feedback
 * pipeline (feature requests/bugs from users AND agent-filed tickets, with
 * dedup/rate-caps); a content report is a moderation-queue entry keyed to
 * the REPORTED MESSAGE, not feedback about the product.
 *
 * reporterId is SetNull: a moderation trail SURVIVES its reporter's account
 * deletion (anonymized) — the same convention as MessageFeedback.userId.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';

export const REPORT_REASONS = [
  'hate_speech',
  'harassment',
  'sexual_content',
  'violence',
  'self_harm',
  'dangerous_acts',
  'misinformation',
  'illegal',
  'spam',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_SURFACES = ['mobile', 'web'] as const;
export type ReportSurface = (typeof REPORT_SURFACES)[number];

const NOTE_MAX = 2000;

export interface CreateContentReportArgs {
  userId: string;
  chatId: string;
  messageId: string;
  reason: ReportReason;
  note?: string;
  surface?: ReportSurface;
  appVersion?: string;
}

export async function createContentReport(args: CreateContentReportArgs): Promise<{ id: string }> {
  const { userId, chatId, messageId, reason, note, surface, appVersion } = args;

  if (note && note.length > NOTE_MAX) {
    throw new AppError(400, `Note must be at most ${NOTE_MAX} characters`);
  }

  // Ownership: a report references content the reporter was SHOWN — their own
  // chat. This is not a tool to probe other users' chats. (messageId is a
  // soft ref — a message may be gone by review time; the report row persists.)
  const chat = await prisma.crossModelChat.findFirst({
    where: { id: chatId, userId },
    select: { id: true },
  });
  if (!chat) {
    throw new AppError(404, 'Chat not found');
  }

  const report = await prisma.contentReport.create({
    data: {
      reporterId: userId,
      chatId,
      messageId,
      reason,
      ...(note ? { note } : {}),
      ...(surface ? { surface } : {}),
      ...(appVersion ? { appVersion } : {}),
    },
    select: { id: true },
  });

  logger.info(`Content report filed: chat ${chatId} reason ${reason}`);

  return report;
}

/** Operator-side listing (the moderation queue; admin-gated at the route). */
export async function listContentReports(opts: {
  status?: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return prisma.contentReport.findMany({
    ...(opts.status ? { where: { status: opts.status } } : {}),
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      reporterId: true,
      chatId: true,
      messageId: true,
      reason: true,
      note: true,
      status: true,
      surface: true,
      appVersion: true,
      createdAt: true,
      reviewedAt: true,
      reviewAction: true,
    },
  });
}

/** Operator-side resolution (mark reviewed). */
export async function resolveContentReport(
  id: string,
  reviewAction: string
): Promise<{ resolved: boolean }> {
  if (reviewAction.length > 200) {
    throw new AppError(400, 'Review action must be at most 200 characters');
  }
  const existing = await prisma.contentReport.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new AppError(404, 'Report not found');

  await prisma.contentReport.update({
    where: { id },
    data: { status: 'reviewed', reviewedAt: new Date(), reviewAction },
  });
  return { resolved: true };
}

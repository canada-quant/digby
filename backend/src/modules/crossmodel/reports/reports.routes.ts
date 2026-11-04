/**
 * Content-report routes (M2-prep — App Store 1.2/1.4, Play UGC policy).
 *
 * Mounted in app.ts BEHIND the single app-level `authenticate` guard:
 *   POST /api/crossmodel/reports            — file a report (any authed user;
 *                                             the service checks chat ownership)
 *   GET  /api/crossmodel/reports            — the moderation queue (ADMIN only)
 *   POST /api/crossmodel/reports/:id/review — resolve a report (ADMIN only)
 *
 * rejectChild: child accounts don't file content reports (Digby Kids is a
 * locked-down pipeline; moderation surface is adult-only).
 */

import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { rejectChild, AuthRequest } from '../../../middleware/auth';
import { validate } from '../../../middleware/validate';
import {
  createContentReport,
  listContentReports,
  resolveContentReport,
  REPORT_REASONS,
  REPORT_SURFACES,
} from './reports.service';

export const reportsRoutes = Router();
reportsRoutes.use(rejectChild);

const createReportSchema = z.object({
  body: z.object({
    chatId: z.string().min(1, 'chatId is required'),
    messageId: z.string().min(1, 'messageId is required'),
    reason: z.enum(REPORT_REASONS),
    note: z.string().max(2000).optional(),
    surface: z.enum(REPORT_SURFACES).optional(),
    appVersion: z.string().max(32).optional(),
  }),
});

const listReportsSchema = z.object({
  query: z.object({
    status: z.string().max(24).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
});

const reviewReportSchema = z.object({
  body: z.object({
    reviewAction: z.string().min(1, 'reviewAction is required').max(200),
  }),
});

/** Admin gate (the users.routes adminOnly pattern, guard-provided req.user). */
const adminOnly = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'ADMIN') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};

/**
 * @swagger
 * /api/crossmodel/reports:
 *   post:
 *     summary: Report a message (content moderation)
 *     description: >
 *       Files a content report for store-compliance guideline 1.2/1.4 — the
 *       mobile app's visible "report content" action. The chat must belong to
 *       the reporter (a report flags content the user was shown).
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
reportsRoutes.post('/', validate(createReportSchema), async (req, res, next) => {
  try {
    const user = (req as AuthRequest).user;
    if (!user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { chatId, messageId, reason, note, surface, appVersion } = req.body;
    const report = await createContentReport({
      userId: user.id,
      chatId,
      messageId,
      reason,
      ...(note !== undefined ? { note } : {}),
      ...(surface !== undefined ? { surface } : {}),
      ...(appVersion !== undefined ? { appVersion } : {}),
    });
    return res.status(201).json({ success: true, data: { reportId: report.id } });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/crossmodel/reports:
 *   get:
 *     summary: List content reports (moderation queue, admin only)
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
reportsRoutes.get('/', adminOnly, validate(listReportsSchema), async (req, res, next) => {
  try {
    const { status, limit } = (req as AuthRequest).query as {
      status?: string;
      limit?: number;
    };
    const reports = await listContentReports({
      ...(status !== undefined ? { status } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return res.json({ success: true, data: { reports } });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/crossmodel/reports/{id}/review:
 *   post:
 *     summary: Resolve a content report (admin only)
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
reportsRoutes.post(
  '/:id/review',
  adminOnly,
  validate(reviewReportSchema),
  async (req, res, next) => {
    try {
      const { reviewAction } = req.body;
      const result = await resolveContentReport(String(req.params.id || ''), reviewAction);
      return res.json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }
);

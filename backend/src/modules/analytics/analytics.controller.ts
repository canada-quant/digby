import { Request, Response, NextFunction } from 'express';
import analyticsService from './analytics.service';
import { dateRangeSchema, trackEventSchema } from './analytics.validation';

/**
 * @swagger
 * /api/analytics/overview:
 *   get:
 *     summary: Get analytics overview
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Analytics overview metrics
 */
export const getOverview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const overview = await analyticsService.getOverview();
    
    res.json({
      success: true,
      data: overview,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/analytics/user-growth:
 *   get:
 *     summary: Get user growth data
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *         description: Number of days (default: 30)
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *         description: Start date (ISO format)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *         description: End date (ISO format)
 *     responses:
 *       200:
 *         description: User growth data
 */
export const getUserGrowth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = dateRangeSchema.parse(req.query);
    const data = await analyticsService.getUserGrowth(query);
    
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/analytics/activity:
 *   get:
 *     summary: Get activity overview
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *         description: Number of days (default: 30)
 *     responses:
 *       200:
 *         description: Activity data
 */
export const getActivityOverview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = dateRangeSchema.parse(req.query);
    const data = await analyticsService.getActivityOverview(query);
    
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/analytics/feature-usage:
 *   get:
 *     summary: Get feature usage statistics
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Feature usage data
 */
export const getFeatureUsage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await analyticsService.getFeatureUsage();
    
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/analytics/events:
 *   get:
 *     summary: Get analytics events
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *         description: Number of days (default: 30)
 *     responses:
 *       200:
 *         description: List of analytics events
 */
export const getEvents = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = dateRangeSchema.parse(req.query);
    const events = await analyticsService.getEvents(query);
    
    res.json({
      success: true,
      data: events,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/analytics/track:
 *   post:
 *     summary: Track analytics event
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - event
 *             properties:
 *               event:
 *                 type: string
 *               properties:
 *                 type: object
 *     responses:
 *       201:
 *         description: Event tracked successfully
 */
export const trackEvent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.userId;
    const data = trackEventSchema.parse(req.body);
    const event = await analyticsService.trackEvent(userId, data);
    
    res.status(201).json({
      success: true,
      data: event,
      message: 'Event tracked successfully',
    });
  } catch (error) {
    next(error);
  }
};
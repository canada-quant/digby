import { Request, Response, NextFunction } from 'express';
import dashboardService from './dashboard.service';

/**
 * @swagger
 * /api/dashboard/stats:
 *   get:
 *     summary: Get dashboard statistics
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard statistics
 */
export const getStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await dashboardService.getStats();
    
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @swagger
 * /api/dashboard/activities:
 *   get:
 *     summary: Get recent activities
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Number of activities to return (default: 10)
 *     responses:
 *       200:
 *         description: Recent activities
 */
export const getRecentActivities = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const activities = await dashboardService.getRecentActivities(limit);
    
    res.json({
      success: true,
      data: activities,
    });
  } catch (error) {
    next(error);
  }
};

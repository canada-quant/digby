import prisma from '../../config/database';
import { DateRangeQuery, TrackEventInput } from './analytics.validation';

interface DataPoint {
  date: string;
  count: number;
}

export class AnalyticsService {
  /**
   * Get user growth over time
   */
  async getUserGrowth(query: DateRangeQuery) {
    const days = query.days || 30;
    const endDate = query.endDate ? new Date(query.endDate) : new Date();
    const startDate = query.startDate 
      ? new Date(query.startDate)
      : new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

    // Get users created in date range, grouped by day
    const users = await prisma.user.findMany({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
        deletedAt: null,
      },
      select: {
        createdAt: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // Group by date
    const dataByDate = new Map<string, number>();
    
    // Initialize all dates with 0
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      dataByDate.set(dateStr, 0);
    }

    // Count users per date
    users.forEach(user => {
      const dateStr = user.createdAt.toISOString().split('T')[0];
      dataByDate.set(dateStr, (dataByDate.get(dateStr) || 0) + 1);
    });

    // Convert to array format
    const data: DataPoint[] = Array.from(dataByDate.entries()).map(([date, count]) => ({
      date,
      count,
    }));

    return {
      data,
      total: users.length,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    };
  }

  /**
   * Get activity overview
   */
  async getActivityOverview(query: DateRangeQuery) {
    const days = query.days || 30;
    const endDate = query.endDate ? new Date(query.endDate) : new Date();
    const startDate = query.startDate 
      ? new Date(query.startDate)
      : new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

    // Get activity counts
    const activities = await prisma.activity.findMany({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        action: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // Group by date
    const dataByDate = new Map<string, number>();
    
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      dataByDate.set(dateStr, 0);
    }

    activities.forEach(activity => {
      const dateStr = activity.createdAt.toISOString().split('T')[0];
      dataByDate.set(dateStr, (dataByDate.get(dateStr) || 0) + 1);
    });

    const data: DataPoint[] = Array.from(dataByDate.entries()).map(([date, count]) => ({
      date,
      count,
    }));

    // Get activity breakdown by action
    const actionCounts = new Map<string, number>();
    activities.forEach(activity => {
      actionCounts.set(activity.action, (actionCounts.get(activity.action) || 0) + 1);
    });

    const breakdown = Array.from(actionCounts.entries()).map(([action, count]) => ({
      action,
      count,
    }));

    return {
      timeline: data,
      breakdown,
      total: activities.length,
    };
  }

  /**
   * Get feature usage statistics
   */
  async getFeatureUsage() {
    const [
      usersCount,
      chatsCount,
      contentCount,
      kanbanCount,
      crmCount,
      activitiesCount,
    ] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.aIChat.count(),
      prisma.content.count(),
      prisma.kanbanBoard.count(),
      prisma.cRMContact.count(),
      prisma.activity.count(),
    ]);

    return [
      { feature: 'Users', count: usersCount },
      { feature: 'AI Chats', count: chatsCount },
      { feature: 'Content', count: contentCount },
      { feature: 'Kanban', count: kanbanCount },
      { feature: 'CRM', count: crmCount },
      { feature: 'Activities', count: activitiesCount },
    ];
  }

  /**
   * Get analytics events
   */
  async getEvents(query: DateRangeQuery) {
    const days = query.days || 30;
    const endDate = query.endDate ? new Date(query.endDate) : new Date();
    const startDate = query.startDate 
      ? new Date(query.startDate)
      : new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

    const events = await prisma.analyticsEvent.findMany({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 100,
      select: {
        id: true,
        eventType: true,
        eventData: true,
        userId: true,
        createdAt: true,
      },
    });

    return events;
  }

  /**
   * Track analytics event
   */
  async trackEvent(userId: string, data: TrackEventInput) {
    const event = await prisma.analyticsEvent.create({
      data: {
        eventType: data.event,
        eventData: data.properties || {},
        userId,
      },
    });

    return event;
  }

  /**
   * Get overview metrics
   */
  async getOverview() {
    const now = new Date();
    const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      activeUsers30d,
      activeUsers7d,
      totalActivities,
      activitiesToday,
      totalEvents,
    ] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.user.count({ 
        where: { 
          deletedAt: null,
          createdAt: { gte: last30Days }
        } 
      }),
      prisma.user.count({ 
        where: { 
          deletedAt: null,
          createdAt: { gte: last7Days }
        } 
      }),
      prisma.activity.count(),
      prisma.activity.count({
        where: {
          createdAt: {
            gte: new Date(now.setHours(0, 0, 0, 0)),
          },
        },
      }),
      prisma.analyticsEvent.count(),
    ]);

    return {
      users: {
        total: totalUsers,
        active30d: activeUsers30d,
        active7d: activeUsers7d,
      },
      activities: {
        total: totalActivities,
        today: activitiesToday,
      },
      events: {
        total: totalEvents,
      },
    };
  }
}

export default new AnalyticsService();

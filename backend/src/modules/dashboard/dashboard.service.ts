import prisma from '../../config/database';

export class DashboardService {
  /**
   * Get dashboard statistics
   */
  async getStats() {
    const [
      totalUsers,
      activeUsers,
      totalChats,
      totalContent,
      publishedContent,
      totalContacts,
      totalBoards,
    ] = await Promise.all([
      // Total users (not deleted)
      prisma.user.count({
        where: { deletedAt: null },
      }),

      // Active users (created in last 30 days)
      prisma.user.count({
        where: {
          deletedAt: null,
          createdAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
        },
      }),

      // Total AI chats
      prisma.aIChat.count(),

      // Total content
      prisma.content.count(),

      // Published content
      prisma.content.count({
        where: { status: 'PUBLISHED' },
      }),

      // Total CRM contacts
      prisma.cRMContact.count(),

      // Total Kanban boards
      prisma.kanbanBoard.count(),
    ]);

    return {
      users: {
        total: totalUsers,
        active: activeUsers,
      },
      chats: {
        total: totalChats,
      },
      content: {
        total: totalContent,
        published: publishedContent,
      },
      crm: {
        contacts: totalContacts,
      },
      kanban: {
        boards: totalBoards,
      },
    };
  }

  /**
   * Get recent activities
   */
  async getRecentActivities(limit: number = 10) {
    const activities = await prisma.activity.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return activities;
  }
}

export default new DashboardService();

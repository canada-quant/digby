import apiClient from '../api-client';

export interface DashboardStats {
  users: {
    total: number;
    active: number;
  };
  chats: {
    total: number;
  };
  content: {
    total: number;
    published: number;
  };
  crm: {
    contacts: number;
  };
  kanban: {
    boards: number;
  };
}

export interface Activity {
  id: string;
  userId: string;
  action: string;
  metadata: any;
  createdAt: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
}

export const dashboardApi = {
  getStats: async () => {
    const response = await apiClient.get<{ success: boolean; data: DashboardStats }>('/dashboard/stats');
    return response.data.data;
  },

  getRecentActivities: async (limit?: number) => {
    const response = await apiClient.get<{ success: boolean; data: Activity[] }>('/dashboard/activities', {
      params: { limit },
    });
    return response.data.data;
  },
};

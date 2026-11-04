import apiClient from '../api-client';

export interface DataPoint {
  date: string;
  count: number;
}

export interface AnalyticsOverview {
  users: {
    total: number;
    active30d: number;
    active7d: number;
  };
  activities: {
    total: number;
    today: number;
  };
  events: {
    total: number;
  };
}

export interface UserGrowthData {
  data: DataPoint[];
  total: number;
  startDate: string;
  endDate: string;
}

export interface ActivityData {
  timeline: DataPoint[];
  breakdown: { action: string; count: number }[];
  total: number;
}

export interface FeatureUsage {
  feature: string;
  count: number;
}

export interface AnalyticsEvent {
  id: string;
  event: string;
  properties: any;
  userId: string;
  createdAt: string;
  user: {
    name: string;
    email: string;
  };
}

export interface DateRangeQuery {
  days?: number;
  startDate?: string;
  endDate?: string;
}

export const analyticsApi = {
  getOverview: async () => {
    const response = await apiClient.get<{ success: boolean; data: AnalyticsOverview }>('/analytics/overview');
    return response.data.data;
  },

  getUserGrowth: async (params?: DateRangeQuery) => {
    const response = await apiClient.get<{ success: boolean; data: UserGrowthData }>('/analytics/user-growth', { params });
    return response.data.data;
  },

  getActivityOverview: async (params?: DateRangeQuery) => {
    const response = await apiClient.get<{ success: boolean; data: ActivityData }>('/analytics/activity', { params });
    return response.data.data;
  },

  getFeatureUsage: async () => {
    const response = await apiClient.get<{ success: boolean; data: FeatureUsage[] }>('/analytics/feature-usage');
    return response.data.data;
  },

  getEvents: async (params?: DateRangeQuery) => {
    const response = await apiClient.get<{ success: boolean; data: AnalyticsEvent[] }>('/analytics/events', { params });
    return response.data.data;
  },

  trackEvent: async (event: string, properties?: any) => {
    const response = await apiClient.post<{ success: boolean; message: string }>('/analytics/track', { event, properties });
    return response.data;
  },
};
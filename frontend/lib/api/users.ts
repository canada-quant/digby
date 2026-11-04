import apiClient from '../api-client';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'USER';
  createdAt: string;
  updatedAt: string;
  _count?: {
    aiChats: number;
    content: number;
    crmContacts: number;
  };
}

export interface UsersQueryParams {
  page?: number;
  limit?: number;
  search?: string;
  role?: 'ADMIN' | 'USER';
}

export interface UsersListResponse {
  users: User[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface CreateUserData {
  email: string;
  password: string;
  name: string;
  role?: 'ADMIN' | 'USER';
}

export interface UpdateUserData {
  name?: string;
  email?: string;
  role?: 'ADMIN' | 'USER';
}

export const usersApi = {
  list: async (params?: UsersQueryParams) => {
    const response = await apiClient.get<{ success: boolean; data: UsersListResponse }>('/users', { params });
    return response.data.data;
  },

  get: async (id: string) => {
    const response = await apiClient.get<{ success: boolean; data: User }>(`/users/${id}`);
    return response.data.data;
  },

  create: async (data: CreateUserData) => {
    const response = await apiClient.post<{ success: boolean; data: User; message: string }>('/users', data);
    return response.data;
  },

  update: async (id: string, data: UpdateUserData) => {
    const response = await apiClient.put<{ success: boolean; data: User; message: string }>(`/users/${id}`, data);
    return response.data;
  },

  delete: async (id: string) => {
    const response = await apiClient.delete<{ success: boolean; message: string }>(`/users/${id}`);
    return response.data;
  },

  changeRole: async (id: string, role: 'ADMIN' | 'USER') => {
    const response = await apiClient.patch<{ success: boolean; data: User; message: string }>(`/users/${id}/role`, { role });
    return response.data;
  },
};

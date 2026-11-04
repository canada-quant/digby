import apiClient from '../api-client';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export interface Chat {
  id: string;
  title: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  lastMessage?: string;
}

export interface ChatsListResponse {
  chats: Chat[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface CreateChatData {
  title: string;
}

export interface AddMessageData {
  content: string;
}

export interface UpdateChatData {
  title: string;
}

export const aiChatApi = {
  list: async (params?: { page?: number; limit?: number }) => {
    const response = await apiClient.get<{ success: boolean; data: ChatsListResponse }>('/ai-chats', { params });
    return response.data.data;
  },

  get: async (id: string) => {
    const response = await apiClient.get<{ success: boolean; data: Chat }>(`/ai-chats/${id}`);
    return response.data.data;
  },

  create: async (data: CreateChatData) => {
    const response = await apiClient.post<{ success: boolean; data: Chat; message: string }>('/ai-chats', data);
    return response.data;
  },

  addMessage: async (id: string, data: AddMessageData) => {
    const response = await apiClient.post<{ success: boolean; data: Chat }>(`/ai-chats/${id}/messages`, data);
    return response.data.data;
  },

  update: async (id: string, data: UpdateChatData) => {
    const response = await apiClient.put<{ success: boolean; data: Chat; message: string }>(`/ai-chats/${id}`, data);
    return response.data;
  },

  delete: async (id: string) => {
    const response = await apiClient.delete<{ success: boolean; message: string }>(`/ai-chats/${id}`);
    return response.data;
  },
};

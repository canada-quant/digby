import { z } from 'zod';
import { uuidString } from '../../utils/zod-uuid';

// Create chat schema
export const createChatSchema = z.object({
  title: z.string().min(1, 'Title is required').max(100),
});

// Add message schema
export const addMessageSchema = z.object({
  content: z.string().min(1, 'Message content is required'),
});

// Update chat schema
export const updateChatSchema = z.object({
  title: z.string().min(1, 'Title is required').max(100),
});

// List chats query schema
export const listChatsQuerySchema = z.object({
  page: z.string().transform(Number).optional().default(1),
  limit: z.string().transform(Number).optional().default(10),
});

// Chat ID param schema
export const chatIdSchema = z.object({
  id: uuidString('Invalid chat ID'),
});

export type CreateChatInput = z.infer<typeof createChatSchema>;
export type AddMessageInput = z.infer<typeof addMessageSchema>;
export type UpdateChatInput = z.infer<typeof updateChatSchema>;
export type ListChatsQuery = z.infer<typeof listChatsQuerySchema>;

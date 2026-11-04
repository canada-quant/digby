import { z } from 'zod';
import { uuidString } from '../../utils/zod-uuid';

// Create user schema
export const createUserSchema = z.object({
  email: z.email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(2, 'Name must be at least 2 characters'),
  role: z.enum(['ADMIN', 'USER']).optional().default('USER'),
});

// Update user schema
export const updateUserSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').optional(),
  email: z.email('Invalid email address').optional(),
  role: z.enum(['ADMIN', 'USER']).optional(),
});

// List users query schema
export const listUsersQuerySchema = z.object({
  page: z.string().transform(Number).optional().default(1),
  limit: z.string().transform(Number).optional().default(10),
  search: z.string().optional(),
  role: z.enum(['ADMIN', 'USER']).optional(),
});

// Change role schema
export const changeRoleSchema = z.object({
  role: z.enum(['ADMIN', 'USER']),
});

// User ID param schema
export const userIdSchema = z.object({
  id: uuidString('Invalid user ID'),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

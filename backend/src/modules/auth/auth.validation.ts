import { z } from 'zod';

/** The register password floor — change-password enforces the same rule. */
export const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MIN_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;

export const registerSchema = z.object({
  email: z.email('Invalid email address').transform(e => e.toLowerCase().trim()),
  password: z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE).transform(p => p.trim()),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.email('Invalid email address').transform(e => e.toLowerCase().trim()),
  password: z.string().min(1, 'Password is required').transform(p => p.trim()),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1, 'Password is required to delete your account'),
});

/**
 * POST /api/auth/change-password. Both passwords are trimmed exactly like
 * login / register trim theirs (the stored hash is of the trimmed value, and
 * login trims before comparing). The length floor is checked AFTER the trim
 * so a run of spaces cannot pass as a password. Error messages never echo a
 * value (the error handler returns zod issues verbatim).
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string({ error: (iss) => (iss.input === undefined ? 'Current password is required' : undefined) }).transform(p => p.trim()).pipe(z.string().min(1, 'Current password is required')),
    newPassword: z.string({ error: (iss) => (iss.input === undefined ? 'New password is required' : undefined) }).transform(p => p.trim()).pipe(z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE)),
  })
  .refine(d => d.newPassword !== d.currentPassword, {
    message: 'New password must be different from your current password',
    path: ['newPassword'],
  });

export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;

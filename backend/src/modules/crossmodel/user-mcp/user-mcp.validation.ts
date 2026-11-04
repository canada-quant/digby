/**
 * User-added MCP servers (ticket e294f9a4) — zod shapes for the
 * /api/crossmodel/mcp-servers REST surface. Shape-only; the business rules
 * (URL policy, header names, the per-user cap) live in user-mcp.service.ts so
 * they answer precise 400 messages. Convention: { body } objects consumed by
 * middleware/validate.
 */

import { z } from 'zod';
import { uuidString } from '../../../utils/zod-uuid';

const transport = z.enum(['auto', 'streamable_http', 'sse']);

const serverFields = {
  name: z.string().max(200),
  url: z.string().max(2048),
  transport: transport.optional(),
  authHeader: z.string().max(100).optional(),
  authValue: z.string().max(8192).optional(),
  enabled: z.boolean().optional(),
  machineWrites: z.boolean().optional(),
  templateId: z.string().max(64).nullable().optional(),
};

export const createUserMcpServerSchema = z.object({
  body: z.object(serverFields).strict(),
});

export const updateUserMcpServerSchema = z.object({
  body: z.object({
    name: serverFields.name.optional(),
    url: serverFields.url.optional(),
    transport: serverFields.transport,
    authHeader: serverFields.authHeader,
    authValue: serverFields.authValue,
    enabled: serverFields.enabled,
    machineWrites: serverFields.machineWrites,
    disabledTools: z.array(z.string().max(200)).max(500).optional(),
  }).strict(),
  params: z.object({ id: uuidString() }),
});

export const testDraftUserMcpServerSchema = z.object({
  body: z.object({
    url: serverFields.url,
    transport: serverFields.transport,
    authHeader: serverFields.authHeader,
    authValue: serverFields.authValue,
  }).strict(),
});

export const userMcpServerIdSchema = z.object({
  params: z.object({ id: uuidString() }),
});

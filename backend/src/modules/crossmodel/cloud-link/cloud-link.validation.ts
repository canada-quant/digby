/**
 * Digby Edge (Phase 3) — zod schemas for the /api/crossmodel/cloud-link REST
 * surface. Shape-only checks live here; business rules (http(s) URL, code
 * validity at the cloud) live in cloud-link.service.ts. Conventions match
 * model-endpoints.validation.ts.
 */

import { z } from 'zod';
import { uuidString } from '../../../utils/zod-uuid';

export const pairCloudLinkSchema = z.object({
  body: z.object({
    cloudUrl: z.string().min(1, 'cloudUrl is required').max(500),
    pairingCode: z.string().min(1, 'pairingCode is required').max(32),
    instanceName: z.string().max(120).optional(),
  }),
});

/** Device activation (edge side): mint the code here; the cloud redeems it. */
export const startEdgePairingCodeSchema = z.object({
  body: z.object({
    cloudUrl: z.string().min(1, 'cloudUrl is required').max(500),
    instanceName: z.string().max(120).optional(),
  }),
});

// Digby Edge (Phase 5) — cloud→edge messaging: the paired CLOUD pushes a
// message into one of THIS instance's chats (delivered as UNTRUSTED machine
// traffic — see cloud-link.service receiveCloudMessage). The message cap
// mirrors MAX_WEBHOOK_MESSAGE_LEN (webhook.service.ts); depth is the
// cloud→edge→cloud loop-bound counter (the service rejects > 3).
export const receiveCloudMessageSchema = z.object({
  body: z.object({
    chatId: uuidString('Invalid chat ID'),
    message: z.string().min(1, 'message is required').max(20_000),
    sourceLabel: z.string().max(120).optional(),
    depth: z.number().int().min(0).max(10).optional().default(0),
  }),
});

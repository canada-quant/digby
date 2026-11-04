/**
 * Digby Edge (Phase 3) — zod schemas for the /api/crossmodel/instances REST
 * surface. Shape-only checks live here; business rules (code validity,
 * ownership) live in instances.service.ts. Conventions match
 * model-endpoints.validation.ts ({ body } objects consumed by
 * middleware/validate).
 */

import { z } from 'zod';

export const completePairingSchema = z.object({
  body: z.object({
    code: z.string().min(1, 'code is required').max(32),
    instanceName: z.string().min(1, 'instanceName is required').max(120),
    protocolVersion: z.number().int().min(1).max(100).optional(),
  }),
});

/** Device activation (cloud side): the admin enters the edge-shown code. */
export const redeemPairingSchema = z.object({
  body: z.object({
    code: z.string().min(1, 'code is required').max(32),
  }),
});

/**
 * Fleet Management — zod schemas for the /api/crossmodel/fleet REST surface.
 * Conventions match platform.validation.ts ({ body | query } objects consumed
 * by middleware/validate).
 */

import { z } from 'zod';

// POST /fleet/supervisor/messages — send to the supervisor chat (queues on busy).
// uploadIds: staged /crossmodel/upload ids (images/PDFs/docs). A busy send
// QUEUES with them (ac65d51e): the ids persist on the pending row and the
// drain re-resolves them into the run.
// The message cap carries a HUMAN message (ticket eb7a3919): a bare max(8000)
// rendered as an opaque "Validation error" toast. The error handler returns
// ZodError issues as { error: 'Validation error', details: [...] } — the
// client (SupervisorChatTab) surfaces details[0].message, so this text is
// what a user over the limit actually reads. Keep the limit in sync with the
// frontend's MAX_SUPERVISOR_MESSAGE_CHARS pre-send gate.
// 2026-09-12 (ticket df145eb3): 8,000 → 100,000 for HUMAN-typed messages —
// users legitimately paste very large context (~100k chars). This endpoint is
// the human supervisor pane; machine-origin limits (schedule_self prompt 8000,
// webhook 20_000, confirmation slices) are separate and UNCHANGED. 100_000
// matches the long-standing platformSendMessageSchema human cap
// (platform.validation.ts) — the pipeline and express.json (75mb) already
// carry messages this size.
export const FLEET_MESSAGE_MAX_CHARS = 100_000;
export const fleetSendMessageSchema = z.object({
  body: z.object({
    content: z.string().min(1, 'content is required').max(
      FLEET_MESSAGE_MAX_CHARS,
      `Message is too long — the supervisor chat accepts at most ${FLEET_MESSAGE_MAX_CHARS.toLocaleString('en-US')} characters. Trim it or split it into parts.`,
    ),
    uploadIds: z.array(z.string().min(1).max(64)).max(8).optional(),
  }),
});

// Shared paged-read query: `before` is an opaque cursor (message id for the
// thread, ISO timestamp for the log — validated in the service), limit 1..100.
const fleetPageQuery = z.object({
  before: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// GET /fleet/supervisor/thread?before&limit&includeMachine — includeMachine is
// the pane's opt-in to see machine-triggered turns (default stays filtered).
// Query strings arrive as TEXT: z.coerce.boolean() runs Boolean(input), which
// maps 'false' → true (adversarial review, PR #291) — so parse the literal
// strings explicitly.
export const fleetThreadQuerySchema = z.object({
  query: fleetPageQuery.extend({
    includeMachine: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  }),
});

// GET /fleet/log?before&limit
export const fleetLogQuerySchema = z.object({ query: fleetPageQuery });

/**
 * Per-chat inbound webhook — router wiring (2026-08-23, feedback 111ab0e4).
 *
 * Two routers, two postures (see webhook.controller.ts):
 *
 *  - webhookOpenRoutes: mounted in crossmodel-open.routes.ts at /webhooks,
 *    BEFORE the app-level authenticate guard. ORDERING CONTRACT: this router
 *    must never add request-ending middleware — non-matching requests fall
 *    through cleanly to the guard. The fire route self-authenticates with the
 *    per-chat `dgw_` bearer token (constant-time sha256 compare).
 *  - webhookAuthedRoutes: mounted in app.ts AFTER the single guard, with NO
 *    internal authenticate — owner-only token lifecycle.
 */

import { Router } from 'express';
import { rejectChild } from '../../middleware/auth';
import * as controller from './webhook.controller';

/** OPEN — external systems fire here. Rate-limited per chat in app.ts. */
export const webhookOpenRoutes = Router();

webhookOpenRoutes.post('/:chatId/fire', controller.fireWebhook);

/** AUTHED — owner-only management (the app-level guard covers these). */
export const webhookAuthedRoutes = Router();

// Digby Kids: child sub-accounts are confined to the locked-down kid pipeline
// — they must never mint an external wake channel into the adult chat-agent
// (same guard as share links, sharing.routes.ts). Reads the guard's req.user.
webhookAuthedRoutes.use(rejectChild);

webhookAuthedRoutes.get('/chats/:id/webhook', controller.getChatWebhook);
webhookAuthedRoutes.post('/chats/:id/webhook', controller.createChatWebhook);
webhookAuthedRoutes.delete('/chats/:id/webhook', controller.deleteChatWebhook);

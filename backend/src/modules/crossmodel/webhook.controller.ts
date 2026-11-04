/**
 * Per-chat inbound webhook — HTTP handlers (2026-08-23, feedback 111ab0e4).
 *
 * TWO postures, one module:
 *  - fireWebhook: PUBLIC (mounted in the open router, before the app-level
 *    guard) — self-authenticates with the per-chat `dgw_` bearer token. This
 *    is the endpoint external systems (monitors, CI, deploy hooks) call.
 *  - get/create/delete: OWNER-ONLY (mounted behind the guard) — the token
 *    lifecycle. Non-owners get the same 404 as a missing chat (repo
 *    convention: ownership failures mask existence).
 *
 * The fire handler is deliberately thin: verify token → validate body → hand
 * to platform.service sendChatMessage (dynamic import — keeps this module's
 * static graph light for the open router and for jest workers) so a webhook
 * wake behaves EXACTLY like a user send: idle chat starts a run, a busy plain
 * chat queues (pending_chat_messages, drained FIFO), a busy coding chat
 * steers into the active run. Origin is stamped 'webhook' (machine traffic).
 */

import { Request, Response } from 'express';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import {
  MAX_WEBHOOK_MESSAGE_LEN,
  createOrRotateWebhook,
  frameWebhookPayload,
  getWebhook,
  revokeWebhook,
  verifyWebhookToken,
  webhookFireUrl,
} from './webhook.service';

/**
 * Per-message mode override — SAFE allowlist only (hardening round 2,
 * 2026-08-23). deep_research / deep_research_all are REJECTED with the
 * controller's existing invalid-mode 400: the daily council quota
 * (reserveDeepResearchQuota) is enforced only at the interactive stream
 * site, so a webhook-initiated L3 run would burn unmetered council runs.
 * (sendChatMessage additionally clamps a stored/auto-routed deep_research
 * to 'thinking' for webhook-origin sends — defense in depth.)
 */
const WEBHOOK_MODES = new Set(['single_thinking', 'thinking', 'auto']);

/** One uniform answer for every token failure — no webhook-existence leak. */
const INVALID_TOKEN = { error: 'Invalid webhook token' };

/**
 * POST /api/crossmodel/webhooks/:chatId/fire   [public — per-chat bearer token]
 * Body: { message: string, mode?: 'single_thinking'|'thinking'|'auto' }
 * Headers: Authorization: Bearer dgw_…
 *
 * 200 { success, chatId, delivery: 'started'|'queued'|'steered', position? }
 * 400 missing/oversized message or bad mode · 401 bad token · 409 queue full
 * 429 per-chat rate limit (app.ts) · 503 unexpected send failure
 */
export async function fireWebhook(req: Request, res: Response) {
  try {
    const { chatId } = req.params;
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    if (!presented) return res.status(401).json(INVALID_TOKEN);

    const hook = await verifyWebhookToken(chatId, presented);
    if (!hook) return res.status(401).json(INVALID_TOKEN);

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'message is required' });
    if (message.length > MAX_WEBHOOK_MESSAGE_LEN) {
      return res.status(400).json({ error: `message is too long (max ${MAX_WEBHOOK_MESSAGE_LEN} characters)` });
    }
    const mode = req.body?.mode;
    if (mode !== undefined && (typeof mode !== 'string' || !WEBHOOK_MODES.has(mode))) {
      return res.status(400).json({ error: `mode must be one of: ${[...WEBHOOK_MODES].join(', ')}` });
    }

    const { sendChatMessage } = await import('./platform/platform.service');
    const result: any = await sendChatMessage({
      // The webhook's authority IS the chat — post as the owner, like the
      // scheduler does (fireScheduleTarget resolves userId from the chat row).
      // No userTurnAt: a machine wake must never anchor pending confirmations.
      userId: hook.chat.userId,
      chatId,
      // Injection hardening (round 2, 2026-08-23): the payload flows verbatim
      // into an agentic run that may hold autonomy grants — frame it as
      // UNTRUSTED external data (BEGIN/END + rules) HERE, upstream of every
      // delivery path (fresh run, busy-chat queue, busy-coding steer), so all
      // of them inherit the frame. The raw payload stays intact inside it.
      content: frameWebhookPayload(message, hook.label),
      ...(mode ? { mode } : {}),
      origin: { kind: 'webhook' },
    });

    // sendChatMessage shapes: coding steer {delivery:'steer'} · busy queue
    // {position} · immediate start (plain {mode} / coding {profile}) — all
    // carry queued:true ("accepted into the run pipeline").
    const delivery: 'started' | 'queued' | 'steered' =
      result?.delivery === 'steer' ? 'steered'
        : typeof result?.position === 'number' ? 'queued'
          : 'started';
    return res.json({
      success: true,
      chatId,
      delivery,
      ...(delivery === 'queued' ? { position: result.position } : {}),
    });
  } catch (err: any) {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) {
      logger.error(`webhook fire failed for ${req.params.chatId}: ${err?.message ?? err}`, { source: 'webhook' });
    }
    return res.status(status).json({ error: err?.message ?? 'Webhook delivery failed' });
  }
}

// ── Owner-only token lifecycle (behind the app-level guard) ──────────────────

/** Chat lookup with the repo's owner-or-404 convention. Null ⇒ response sent. */
async function loadOwnedChat(req: Request, res: Response): Promise<{ id: string } | null> {
  const userId = req.user!.id;
  const chat = await prisma.crossModelChat.findUnique({
    where: { id: req.params.id },
    select: { id: true, userId: true },
  });
  if (!chat || chat.userId !== userId) {
    res.status(404).json({ error: 'Chat not found' });
    return null;
  }
  return chat;
}

/**
 * GET /api/crossmodel/chats/:id/webhook — webhook status for the owner.
 * Never returns token material — only the display prefix + lifecycle fields.
 */
export async function getChatWebhook(req: Request, res: Response) {
  try {
    const chat = await loadOwnedChat(req, res);
    if (!chat) return;
    const hook = await getWebhook(chat.id);
    if (!hook) {
      // The URL is not secret (the token is) — hand it over so the owner can
      // see exactly what a created webhook would look like.
      return res.json({ exists: false, webhookUrl: webhookFireUrl(chat.id) });
    }
    return res.json({
      exists: true,
      isActive: hook.isActive,
      label: hook.label,
      tokenPrefix: hook.tokenPrefix,
      webhookUrl: webhookFireUrl(chat.id),
      lastUsedAt: hook.lastUsedAt,
      createdAt: hook.createdAt,
      updatedAt: hook.updatedAt,
    });
  } catch (err: any) {
    logger.error(`getChatWebhook error: ${err?.message ?? err}`, { source: 'webhook' });
    return res.status(500).json({ error: 'Failed to load webhook' });
  }
}

/**
 * POST /api/crossmodel/chats/:id/webhook — create the chat's webhook, or rotate
 * its token with { rotate: true }. Body: { label?: string, rotate?: boolean }.
 * The plaintext token is returned ONCE — only its sha256 hash is stored.
 * 409 when a webhook already exists and rotate was not requested.
 */
export async function createChatWebhook(req: Request, res: Response) {
  try {
    const chat = await loadOwnedChat(req, res);
    if (!chat) return;
    const label = req.body?.label;
    if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > 120)) {
      return res.status(400).json({ error: 'label must be a string of at most 120 characters' });
    }
    const rotate = req.body?.rotate === true;
    const existing = await getWebhook(chat.id);
    if (existing && !rotate) {
      return res.status(409).json({
        error: 'A webhook already exists for this chat — POST with { "rotate": true } to mint a new token (the old one stops working immediately).',
      });
    }
    const { record, plaintextToken } = await createOrRotateWebhook({
      chatId: chat.id,
      // Create: take the label as given. Rotate: keep the old label unless a
      // new one was explicitly passed (null clears deliberately).
      ...(existing ? (label !== undefined ? { label } : {}) : { label: label ?? null }),
    });
    return res.status(existing ? 200 : 201).json({
      success: true,
      rotated: !!existing,
      token: plaintextToken, // shown ONCE — store it in the calling system's secret store
      tokenPrefix: record.tokenPrefix,
      webhookUrl: webhookFireUrl(chat.id),
      label: record.label,
      isActive: record.isActive,
      createdAt: record.createdAt,
    });
  } catch (err: any) {
    logger.error(`createChatWebhook error: ${err?.message ?? err}`, { source: 'webhook' });
    return res.status(500).json({ error: 'Failed to create webhook' });
  }
}

/**
 * DELETE /api/crossmodel/chats/:id/webhook — revoke (delete) the webhook.
 * The token dies with the row; there is no plaintext to invalidate elsewhere.
 */
export async function deleteChatWebhook(req: Request, res: Response) {
  try {
    const chat = await loadOwnedChat(req, res);
    if (!chat) return;
    const revoked = await revokeWebhook(chat.id);
    if (!revoked) return res.status(404).json({ error: 'No webhook exists for this chat' });
    return res.json({ success: true, message: 'Webhook revoked' });
  } catch (err: any) {
    logger.error(`deleteChatWebhook error: ${err?.message ?? err}`, { source: 'webhook' });
    return res.status(500).json({ error: 'Failed to revoke webhook' });
  }
}

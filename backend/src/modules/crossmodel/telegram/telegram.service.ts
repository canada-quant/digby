/**
 * Telegram Bot Service
 *
 * Single shared "Digby" bot model (created once in BotFather → TELEGRAM_BOT_TOKEN).
 * There is NO per-user OAuth token — users link by pressing Start on the bot via a
 * deep link that carries a one-time link token. We then map their Telegram chatId
 * to their Digby userId (TelegramLink) so the bot can answer them and Digby can
 * push notifications.
 *
 * This service wraps the Telegram Bot HTTP API and the Redis-backed link tokens.
 */

import axios from 'axios';
import { randomBytes } from 'crypto';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';

const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME  = process.env.TELEGRAM_BOT_USERNAME;        // e.g. "DigbyBot" (no @)
const LINK_TTL_SECS = 600;                                     // 10-minute single-use link token
const TG_MSG_LIMIT  = 4000;                                    // Telegram hard limit is 4096

export function isConfigured(): boolean {
  return !!BOT_TOKEN;
}

export function getBotUsername(): string | null {
  return BOT_USERNAME || null;
}

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

/**
 * Send a text message to a Telegram chat. Splits messages over the size limit.
 *
 * Returns true ONLY when every chunk was accepted by the Bot API; false when
 * the bot is unconfigured or any chunk failed (the remaining chunks are
 * skipped, as before). 2026-09-08: the return value exists for the notify_user
 * account tool (platform/account-tools.ts), which must tell the model honestly
 * whether the push landed — the pre-existing callers (telegram.controller,
 * owner-questions) ignore it, so this is backward compatible.
 */
export async function sendMessage(chatId: string | number, text: string): Promise<boolean> {
  if (!BOT_TOKEN) {
    logger.warn('Telegram sendMessage: TELEGRAM_BOT_TOKEN not set');
    return false;
  }
  const chunks = splitMessage(text, TG_MSG_LIMIT);
  for (const chunk of chunks) {
    try {
      // Plain text (no parse_mode) — avoids 400s from unescaped markdown in model output.
      await axios.post(apiUrl('sendMessage'), { chat_id: chatId, text: chunk, disable_web_page_preview: true }, { timeout: 15000 });
    } catch (err: any) {
      logger.warn(`Telegram sendMessage failed: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
      return false;
    }
  }
  return true;
}

/** Show the "typing…" indicator while Digby thinks. Best-effort. */
export async function sendTyping(chatId: string | number): Promise<void> {
  if (!BOT_TOKEN) return;
  try {
    await axios.post(apiUrl('sendChatAction'), { chat_id: chatId, action: 'typing' }, { timeout: 8000 });
  } catch { /* non-critical */ }
}

/** Split a long message into <= limit chunks, preferring line/space boundaries. */
export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── Link tokens (Redis, single-use, 10-min TTL) ────────────────────────────────

/** Mint a one-time deep-link token bound to a Digby userId. */
export async function mintLinkToken(userId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await redisClient.setEx(`telegram_link:${token}`, LINK_TTL_SECS, userId);
  return token;
}

/** Consume a deep-link token, returning the bound userId (single-use). */
export async function consumeLinkToken(token: string): Promise<string | null> {
  const key = `telegram_link:${token}`;
  const userId = await redisClient.get(key);
  if (userId) await redisClient.del(key);
  return userId || null;
}

/** Build the deep link a user taps to connect their Telegram to Digby. */
export function buildConnectUrl(token: string): string | null {
  if (!BOT_USERNAME) return null;
  return `https://t.me/${BOT_USERNAME}?start=${token}`;
}

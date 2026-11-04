/**
 * Digby Edge (Phase 3) — cloud-link service (EDGE side).
 *
 * Manages THIS instance's singleton link TO a cloud: pair (server-side redeem
 * of the cloud's pairing code → store the CloudLink row → start the tunnel
 * client), status (sanitized — tokenEnc is NEVER returned), unlink (stop the
 * client, best-effort tell the cloud to self-revoke via the dgi_ token, delete
 * the row). The tunnel client itself lives in backend/src/cloud-link/
 * tunnel-client.ts and holds the outbound WSS connection.
 *
 * Singleton: one cloud_link row max. Re-pairing REPLACES any existing row —
 * the old tunnel token dies with it.
 */

import os from 'os';
import { createHash } from 'crypto';
import axios from 'axios';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import { encryptValue, decryptValue } from '../coding/credentials.service';
import { cloudLinkTunnel } from '../../../cloud-link/tunnel-client';
import {
  SUPPORTED_PROTOCOL_VERSION, generatePairingCode, canonicalPairToken,
} from '../instances/instances.service';
import { frameWebhookPayload } from '../webhook.service';

const PAIR_TIMEOUT_MS = 10_000;
/** Device-activation code TTL — mirrors the cloud's pair/start code lifetime. */
const EDGE_PAIR_TTL_SECONDS = 600;
/** Local record of the minted device code: `edge:paircode:<sha256(dgp_<KEY>)>`. */
const EDGE_PAIRCODE_KEY_PREFIX = 'edge:paircode:';

/**
 * Path matcher for the app.ts /cloud-link/receive rate limiter (Phase 5).
 * Case-insensitive + trailing-slash tolerant so it covers exactly the paths
 * Express's default router also matches (the WEBHOOK_FIRE_PATH_RE discipline
 * in webhook.service.ts — an exact-match regex here was a limiter bypass).
 */
export const CLOUD_LINK_RECEIVE_PATH_RE = /^\/cloud-link\/receive\/?$/i;

/**
 * Rate-limit key for the receive limiter: per TARGET CHAT + caller IP, read
 * from the parsed body (app.ts's express.json runs before the limiter). Same
 * per-chat fairness posture as webhookFireLimiterKey — one noisy cloud
 * integration can't burn another chat's bucket, and pre-auth 403s count only
 * against the caller's own IP bucket.
 */
export function cloudLinkReceiveLimiterKey(bodyChatId: unknown, ip: string | undefined): string {
  const chatId = typeof bodyChatId === 'string' && bodyChatId ? bodyChatId : 'unknown';
  return `chat:${chatId}:${ip ?? 'noip'}`;
}

export interface CloudLinkStatus {
  state: string;          // 'unlinked' when no row exists
  cloudUrl: string | null;
  instanceName: string | null;
  connected: boolean;     // live tunnel socket flag
  lastError: string | null;
}

/**
 * Normalize a user-entered cloud URL: trim, prepend https:// when no scheme
 * ("digby.example.com" works), lowercase scheme+host (the URL constructor does both),
 * strip trailing slashes. Anything that still isn't a valid http(s) URL is a
 * clear 400, not a confusing downstream connection failure.
 */
export function normalizeCloudUrl(raw: string): string {
  let s = String(raw || '').trim();
  if (!s) {
    throw new AppError(400, 'cloudUrl is required — expected something like https://digby.example.com.');
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch {
    throw new AppError(400, `cloudUrl "${s.slice(0, 80)}" is not a valid URL — expected something like https://digby.example.com.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError(400, `cloudUrl must be http:// or https:// (got "${u.protocol}//").`);
  }
  return u.toString().replace(/\/+$/, '');
}

/** Current link status — tokenEnc is NEVER part of it. */
export async function getCloudLinkStatus(): Promise<CloudLinkStatus> {
  const row = await prisma.cloudLink.findFirst({ orderBy: { createdAt: 'desc' } });
  if (!row) {
    return { state: 'unlinked', cloudUrl: null, instanceName: null, connected: false, lastError: null };
  }
  return {
    state: row.state,
    cloudUrl: row.cloudUrl,
    instanceName: row.instanceName,
    connected: cloudLinkTunnel.isConnected(),
    lastError: row.lastError,
  };
}

/**
 * Pair this instance TO a cloud: redeem the pairing code server-side at the
 * cloud's OPEN pair/complete endpoint, store the returned dgi_ token
 * (AES-256-GCM at rest), and start the tunnel client. The cloud's error is
 * surfaced verbatim-ish (status + its error message) — the token only ever
 * exists in the success path and is never echoed back out.
 */
export async function pairToCloud(
  userId: string,
  cloudUrlRaw: string,
  pairingCode: string,
  instanceNameRaw?: string,
): Promise<CloudLinkStatus> {
  const cloudUrl = normalizeCloudUrl(cloudUrlRaw);
  const code = String(pairingCode || '').trim();
  if (!code) throw new AppError(400, 'pairingCode is required');
  const instanceName = (instanceNameRaw || '').trim().slice(0, 120) || os.hostname() || 'digby-edge';

  let data: any;
  try {
    const resp = await axios.post(`${cloudUrl}/api/crossmodel/instances/pair/complete`, {
      code,
      instanceName,
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    }, { timeout: PAIR_TIMEOUT_MS });
    data = resp.data?.data;
  } catch (err: any) {
    if (err?.response) {
      const status = err.response.status;
      const message = typeof err.response.data?.error === 'string'
        ? err.response.data.error
        : `Cloud rejected the pairing (HTTP ${status})`;
      throw new AppError(status === 401 ? 401 : 502, message);
    }
    throw new AppError(502, `Cloud unreachable (${err?.code || err?.message || 'connection failed'})`);
  }

  if (!data?.instanceId || typeof data?.token !== 'string' || !data.token.startsWith('dgi_')) {
    throw new AppError(502, 'Cloud returned a malformed pairing response — re-pair or check both instances run the same protocol version.');
  }

  // Singleton: replace any existing row (and its dead token) atomically enough
  // for a single-row table — delete-then-create inside one transaction.
  await prisma.$transaction([
    prisma.cloudLink.deleteMany({}),
    prisma.cloudLink.create({
      data: {
        cloudUrl,
        tokenEnc: encryptValue(data.token),
        instanceName,
        pairedByUserId: userId,
        state: 'linked',
        lastError: null,
      },
    }),
  ]);
  logger.info(`cloud-link: paired to ${cloudUrl} as "${instanceName}" by user ${userId.slice(0, 8)}`);

  await cloudLinkTunnel.restart();
  return getCloudLinkStatus();
}

// ── Device-activation pairing (the edge mints the code, the cloud redeems) ──

/**
 * POST /cloud-link/code/start (JWT + ADMIN): the Netflix/YouTube-TV flow —
 * the person standing at the edge never types a URL into the cloud. Mints a
 * one-time XXXX-XXXX code (same alphabet/format as the cloud's pair/start),
 * records sha256 + metadata locally (`edge:paircode:<hash>`, 10-min TTL),
 * replaces any stale pending/error link row with a state='pending' one (no
 * token yet — tokenEnc fills in when the tunnel lands), and puts the tunnel
 * client into pending-pair mode: it dials the cloud's relay with
 * `Authorization: Bearer dgp_<KEY>` every ~3s until the cloud admin redeems
 * the code (POST /instances/pair/redeem) or the TTL lapses.
 *
 * The redeem→dial ordering doesn't matter: an early dial gets the relay's
 * uniform 401 and the client simply retries.
 */
export async function startEdgePairingCode(
  userId: string,
  cloudUrlRaw: string,
  instanceNameRaw?: string,
): Promise<{ code: string; expiresAt: Date }> {
  const cloudUrl = normalizeCloudUrl(cloudUrlRaw);
  const existing = await prisma.cloudLink.findFirst({ orderBy: { createdAt: 'desc' } });
  if (existing && existing.state === 'linked') {
    throw new AppError(409, 'This instance is already linked to a cloud — unlink first');
  }
  const instanceName = (instanceNameRaw || '').trim().slice(0, 120) || os.hostname() || 'digby-edge';

  const { display, key } = generatePairingCode();
  const codeHash = createHash('sha256').update(canonicalPairToken(key)).digest('hex');
  await redisClient.setEx(
    `${EDGE_PAIRCODE_KEY_PREFIX}${codeHash}`,
    EDGE_PAIR_TTL_SECONDS,
    JSON.stringify({ cloudUrl, instanceName, userId }),
  );
  const expiresAt = new Date(Date.now() + EDGE_PAIR_TTL_SECONDS * 1000);

  // Singleton: a fresh code REPLACES any stale pending/error row (a linked row
  // 409'd above). The tunnel token is unknown until the cloud redeems the
  // code and the relay answers the dial with a `paired` frame.
  await prisma.$transaction([
    prisma.cloudLink.deleteMany({}),
    prisma.cloudLink.create({
      data: {
        cloudUrl,
        tokenEnc: '',
        instanceName,
        pairedByUserId: userId,
        state: 'pending',
        lastError: null,
      },
    }),
  ]);
  logger.info(`cloud-link: device pairing code issued for ${cloudUrl} as "${instanceName}" by user ${userId.slice(0, 8)}`);

  await cloudLinkTunnel.startPendingPairing(key, expiresAt.getTime());
  return { code: display, expiresAt };
}

/**
 * Unlink: stop the tunnel, best-effort tell the cloud to revoke (its OPEN
 * DELETE /instances/self authenticates with the dgi_ token — unreachable cloud
 * never blocks the local unlink), delete the row.
 */
export async function unlinkFromCloud(): Promise<CloudLinkStatus> {
  const row = await prisma.cloudLink.findFirst({ orderBy: { createdAt: 'desc' } });
  cloudLinkTunnel.stop();
  if (row) {
    try {
      const token = decryptValue(row.tokenEnc);
      await axios.delete(`${row.cloudUrl}/api/crossmodel/instances/self`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: PAIR_TIMEOUT_MS,
      });
    } catch (err: any) {
      logger.warn(`cloud-link: cloud-side revoke failed (proceeding anyway): ${err?.message}`);
    }
    await prisma.cloudLink.delete({ where: { id: row.id } });
    logger.info(`cloud-link: unlinked from ${row.cloudUrl}`);
  }
  return getCloudLinkStatus();
}

// ── Cloud→edge message receive (Digby Edge, Phase 5) ────────────────────────

/**
 * Loop bound for cloud→edge→cloud message chains: mirrors the fleet hook
 * ladder's MAX_HOOK_DEPTH (platform/hooks.service.ts). The paired cloud
 * increments depth on every machine-triggered hop; a chain deeper than this
 * dies HERE with a 400 instead of ping-ponging two instances forever.
 */
export const MAX_CLOUD_MESSAGE_DEPTH = 3;

export interface CloudMessageDelivery {
  delivery: 'started' | 'queued' | 'steered';
  position?: number;
}

/**
 * Deliver a cloud-pushed message into one of THIS instance's chats. The
 * message is posted as the chat's OWNER via the normal sendChatMessage
 * pipeline (idle → run starts; busy plain chat → queue; busy coding chat →
 * steer), with two machine-traffic markings:
 *   - origin { kind: 'webhook' } and NO userTurnAt — a cloud push can never
 *     anchor a pending confirmation (same posture as the dgw_ webhook fire);
 *   - the content is wrapped ONCE in the UNTRUSTED webhook frame
 *     (frameWebhookPayload) with the cloud-supplied source label + the relay
 *     depth in the header text (the origin type carries no extra fields).
 * Guards: the link must be state='linked' (409 otherwise) and depth must not
 * exceed MAX_CLOUD_MESSAGE_DEPTH (400 'hook depth exceeded').
 */
export async function receiveCloudMessage(input: {
  chatId: string;
  message: string;
  sourceLabel?: string;
  depth?: number;
}): Promise<CloudMessageDelivery> {
  const row = await prisma.cloudLink.findFirst({ orderBy: { createdAt: 'desc' } });
  if (!row || row.state !== 'linked') {
    throw new AppError(409, 'This instance is not linked to a cloud');
  }
  const depth = input.depth ?? 0;
  if (depth > MAX_CLOUD_MESSAGE_DEPTH) {
    throw new AppError(400, 'hook depth exceeded');
  }
  const chat = await prisma.crossModelChat.findUnique({
    where: { id: input.chatId },
    select: { id: true, userId: true },
  });
  if (!chat) throw new AppError(404, 'Chat not found');

  const source = (input.sourceLabel || '').trim() || 'the paired cloud instance';
  // Dynamic import (mirrors webhook.controller's fire path): keeps the
  // platform service's heavy graph out of this module's static imports.
  const { sendChatMessage } = await import('../platform/platform.service');
  const result: any = await sendChatMessage({
    // The cloud's authority over this instance IS the pairing — post as the
    // chat's owner, like the webhook fire and the scheduler do.
    userId: chat.userId,
    chatId: chat.id,
    content: frameWebhookPayload(input.message, `${source} (cloud→edge relay depth ${depth})`),
    origin: { kind: 'webhook' },
  });

  // Same delivery mapping as webhook.controller's fire response.
  const delivery: CloudMessageDelivery['delivery'] =
    result?.delivery === 'steer' ? 'steered'
      : typeof result?.position === 'number' ? 'queued'
        : 'started';
  logger.info(`cloud-link: received cloud message for chat ${chat.id.slice(0, 8)} (depth ${depth}, ${delivery})`);
  return { delivery, ...(delivery === 'queued' ? { position: result.position } : {}) };
}

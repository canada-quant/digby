/**
 * Digby Edge (Phase 3) — connected-instance pairing + registry (CLOUD side).
 *
 * Pairing mirrors the iMessage agent flow (imessage/imessage.service.ts):
 * an ADMIN mints a single-use 10-minute code (Redis), the edge redeems it at
 * the OPEN pair/complete endpoint for a long-lived `dgi_` tunnel token. The
 * cloud only ever VERIFIES that token (the edge presents it on the relay WS
 * upgrade), so we store a SHA-256 hash — never the plaintext; the plaintext is
 * returned exactly once at pair/complete and kept by the edge (AES-256-GCM at
 * rest in its own cloud_link row).
 *
 * Errors are uniform: any bad/expired/redeemed code is the same 401, so the
 * open endpoint cannot enumerate users or probe code state. Presence is
 * Redis-backed (`inst:presence:<id>`, written by the relay on connect and
 * refreshed on every client ping) so this web process can report `online`
 * without sharing memory with the relay process.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';

const PAIR_TTL_SECONDS = 600;          // pairing code valid for 10 minutes
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
export const PRESENCE_KEY_PREFIX = 'inst:presence:';
export const SUPPORTED_PROTOCOL_VERSION = 1;
/**
 * Device-activation pairing (edge mints the code, cloud redeems): the redeem
 * endpoint parks a claim here; the relay consumes it (GETDEL) when the edge
 * dials the tunnel with `Bearer dgp_<code>`. Same 10-min TTL as pair/start.
 */
export const PAIR_CLAIM_KEY_PREFIX = 'inst:pairclaim:';
/**
 * app.ts rate-limiter path matcher for BOTH pairing endpoints that burn a
 * code namespace (OPEN pair/complete + authed pair/redeem) — case-insensitive
 * + trailing-slash tolerant, same discipline as CLOUD_LINK_RECEIVE_PATH_RE.
 */
export const INSTANCE_PAIR_PATH_RE = /^\/instances\/pair\/(complete|redeem)\/?$/i;

export interface ConnectedInstanceSummary {
  id: string;
  ownerUserId: string;
  name: string;
  protocolVersion: number;
  status: string;
  online: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export function hashInstanceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Normalize a user-entered pairing code: strip separators, uppercase. */
function normalizeCode(input: string): string {
  return (input || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Shared with the edge side (cloud-link device-activation code minting). */
export function generatePairingCode(): { display: string; key: string } {
  const bytes = randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i++) raw += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
  return { display: `${raw.slice(0, 4)}-${raw.slice(4)}`, key: raw };
}

/**
 * Canonical form of a device-activation bearer token: `dgp_<KEY>` with the
 * code normalized (dashes/case tolerant) — the redeem endpoint, the relay
 * claim lookup, and the edge's dial all hash exactly this string.
 */
export function canonicalPairToken(rawTokenOrCode: string): string {
  const body = rawTokenOrCode.startsWith('dgp_') ? rawTokenOrCode.slice(4) : rawTokenOrCode;
  return `dgp_${normalizeCode(body)}`;
}

/** Step 1 (web UI, JWT + ADMIN): mint a short-lived pairing code. Shown once. */
export async function startPairing(ownerUserId: string): Promise<{ code: string; expiresAt: Date }> {
  const { display, key } = generatePairingCode();
  await redisClient.setEx(`inst_pair:${key}`, PAIR_TTL_SECONDS, ownerUserId);
  const expiresAt = new Date(Date.now() + PAIR_TTL_SECONDS * 1000);
  logger.info(`instances: pairing code issued for ownerUserId=${ownerUserId}`);
  return { code: display, expiresAt };
}

/**
 * Step 2 (edge, OPEN endpoint): redeem the pairing code for a `dgi_` tunnel
 * token. The code is single-use — consumed ATOMICALLY (GETDEL) so two racing
 * completes can never both mint a token off one code. Returns null on any
 * invalid/expired code (the controller turns that into the uniform 401).
 * The plaintext token is returned ONCE; only its sha256 hash is stored.
 */
export async function completePairing(
  code: string,
  instanceName: string,
  protocolVersion?: number,
): Promise<{ instanceId: string; token: string } | null> {
  const ownerUserId = await redisClient.getDel(`inst_pair:${normalizeCode(code)}`);
  if (!ownerUserId) return null;

  const token = `dgi_${randomBytes(24).toString('hex')}`; // dgi_ + 48 hex chars
  const version = Number.isInteger(protocolVersion) && (protocolVersion as number) >= 1
    ? Math.min(protocolVersion as number, SUPPORTED_PROTOCOL_VERSION)
    : SUPPORTED_PROTOCOL_VERSION;

  const row = await prisma.connectedInstance.create({
    data: {
      ownerUserId,
      name: String(instanceName || '').trim().slice(0, 120) || 'unnamed edge',
      tokenHash: hashInstanceToken(token),
      protocolVersion: version,
      status: 'pending', // flips to online on the first tunnel connect
    },
  });

  logger.info(`instances: edge paired ownerUserId=${ownerUserId} instanceId=${row.id} name=${row.name}`);
  return { instanceId: row.id, token };
}

/**
 * Resolve an instance row from its `dgi_` bearer token (relay WS auth).
 * Lookup by unique hash, then a timingSafeEqual re-compare so the equality
 * check itself never becomes an oracle. Returns null for unknown tokens.
 */
export async function resolveInstanceByToken(token: string): Promise<{
  id: string; ownerUserId: string; name: string; status: string; protocolVersion: number;
} | null> {
  if (!token) return null;
  try {
    const hash = hashInstanceToken(token);
    const row = await prisma.connectedInstance.findUnique({ where: { tokenHash: hash } });
    if (!row) return null;
    const a = Buffer.from(hash, 'utf8');
    const b = Buffer.from(row.tokenHash, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return row;
  } catch {
    return null;
  }
}

/** Owner-scoped list for the admin UI — NEVER carries tokenHash. Revoked
 *  rows are excluded by default (they're history); `includeRevoked` opts in. */
export async function listInstances(
  ownerUserId: string,
  opts: { includeRevoked?: boolean } = {},
): Promise<ConnectedInstanceSummary[]> {
  const rows = await prisma.connectedInstance.findMany({
    where: { ownerUserId, ...(opts.includeRevoked ? {} : { status: { not: 'revoked' } }) },
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(rows.map(async (r) => ({
    id: r.id,
    ownerUserId: r.ownerUserId,
    name: r.name,
    protocolVersion: r.protocolVersion,
    status: r.status,
    online: !!(await redisClient.get(`${PRESENCE_KEY_PREFIX}${r.id}`).catch(() => null)),
    lastSeenAt: r.lastSeenAt,
    createdAt: r.createdAt,
    revokedAt: r.revokedAt,
  })));
}

/**
 * Revoke (owner-scoped). Returns false when the id does not exist OR belongs
 * to another owner — the controller maps both to the same 404 (no cross-owner
 * enumeration). A live tunnel dies on its next ping: the relay re-checks
 * status per heartbeat and hard-closes a revoked instance.
 */
export async function revokeInstance(id: string, ownerUserId: string): Promise<boolean> {
  const result = await prisma.connectedInstance.updateMany({
    where: { id, ownerUserId, status: { not: 'revoked' } },
    data: { status: 'revoked', revokedAt: new Date() },
  });
  if (result.count > 0) {
    await redisClient.del(`${PRESENCE_KEY_PREFIX}${id}`).catch(() => {});
    logger.info(`instances: revoked ${id.slice(0, 8)} by owner ${ownerUserId.slice(0, 8)}`);
    return true;
  }
  // Already-revoked rows of this owner still count as "found" (idempotent DELETE).
  const existing = await prisma.connectedInstance.findFirst({ where: { id, ownerUserId }, select: { id: true } });
  return !!existing;
}

/**
 * Self-revoke via the `dgi_` bearer token (OPEN route DELETE /instances/self).
 * This is how an edge's unlink tells the cloud to drop the pairing without
 * holding a cloud user JWT. Uniform false for any bad token.
 */
export async function revokeByToken(token: string): Promise<boolean> {
  const row = await resolveInstanceByToken(token);
  if (!row) return false;
  await prisma.connectedInstance.update({
    where: { id: row.id },
    data: { status: 'revoked', revokedAt: new Date() },
  });
  await redisClient.del(`${PRESENCE_KEY_PREFIX}${row.id}`).catch(() => {});
  logger.info(`instances: self-revoked ${row.id.slice(0, 8)} via tunnel token`);
  return true;
}

// ── Device-activation pairing (the edge mints the code, the cloud redeems) ──

/**
 * POST /instances/pair/redeem (JWT + ADMIN): the cloud admin enters the code
 * shown on the EDGE's "Pair to a cloud" screen. No instance row exists yet —
 * this parks a claim in Redis (`inst:pairclaim:<sha256(dgp_<KEY>)>`, 10-min
 * TTL) that the relay consumes (GETDEL) when the edge's pending-pair dial
 * arrives. Returns null when the code is malformed (controller → 400).
 */
export async function redeemPairingCode(
  code: string,
  cloudUserId: string,
): Promise<{ pending: true; expiresAt: Date } | null> {
  const canonical = canonicalPairToken(code);
  if (canonical.length !== 'dgp_'.length + 8) return null; // XXXX-XXXX → 8 chars
  await redisClient.setEx(
    `${PAIR_CLAIM_KEY_PREFIX}${hashInstanceToken(canonical)}`,
    PAIR_TTL_SECONDS,
    JSON.stringify({ cloudUserId }),
  );
  const expiresAt = new Date(Date.now() + PAIR_TTL_SECONDS * 1000);
  logger.info(`instances: pair claim parked for cloudUserId=${cloudUserId.slice(0, 8)} (awaiting edge dial)`);
  return { pending: true, expiresAt };
}

/**
 * Relay-side half of device activation: consume a `dgp_` bearer token's claim
 * ATOMICALLY (GETDEL — a code mints at most one instance) and create the
 * connected_instances row on the spot (status flips to online when the relay
 * attaches the socket right after). Returns null for unknown/expired/already-
 * consumed codes — the relay maps that to the SAME uniform 401 as any bad
 * dgi_ token (no enumeration of claim state). `name` comes from the edge's
 * `?name=` WS query param, sanitized to ≤60 chars.
 */
export async function mintInstanceFromPairClaim(
  rawToken: string,
  name?: string,
): Promise<{ instance: ConnectedInstanceRow; token: string } | null> {
  const canonical = canonicalPairToken(rawToken);
  const raw = await redisClient.getDel(`${PAIR_CLAIM_KEY_PREFIX}${hashInstanceToken(canonical)}`);
  if (!raw) return null;
  let cloudUserId: string | undefined;
  try { cloudUserId = JSON.parse(raw)?.cloudUserId; } catch { /* fall through */ }
  if (!cloudUserId) return null;

  const token = `dgi_${randomBytes(24).toString('hex')}`;
  const row = await prisma.connectedInstance.create({
    data: {
      ownerUserId: cloudUserId,
      name: String(name || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 60) || 'unnamed edge',
      tokenHash: hashInstanceToken(token),
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      status: 'pending', // flips to online when the relay attaches the socket
    },
  });
  logger.info(`instances: edge paired via device code ownerUserId=${cloudUserId} instanceId=${row.id} name=${row.name}`);
  return { instance: row, token };
}

/** The connected_instances row shape mintInstanceFromPairClaim returns. */
export interface ConnectedInstanceRow {
  id: string;
  ownerUserId: string;
  name: string;
  status: string;
  protocolVersion: number;
}

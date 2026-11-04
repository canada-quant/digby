/**
 * The visitor IP HASH — pure leaf (owner 2026-10-07: "ip addressed or unique hash"). A raw IP is NEVER stored or
 * shown: HMAC-SHA256(normalized client ip, key) → the first 32 hex chars. The key is `VISITOR_HASH_SECRET` when set,
 * else derived from JWT_SECRET with a fixed label (so the hash is stable across deploys and boxes without a new
 * secret, and cannot be reversed by hashing the IPv4 space without the server's secret).
 */
import crypto from 'crypto';

/** The fixed derivation label — changing it re-keys every stored hash (a fresh "unique hash" space). */
export const VISITOR_HASH_LABEL = 'digby-visitor-ip-hash-v1';
/** Stored hash length (hex chars) — 128 bits; the admin UI shows the first 8. */
export const IP_HASH_HEX_LEN = 32;

let memo: { secret: string; jwt: string; key: Buffer } | null = null;

/** The HMAC key. Reads env each call (cheap; memoized on the env values) so tests and rotations take effect. */
export function visitorHashKey(): Buffer {
  const secret = String(process.env.VISITOR_HASH_SECRET ?? '');
  const jwt = String(process.env.JWT_SECRET ?? '');
  if (memo && memo.secret === secret && memo.jwt === jwt) return memo.key;
  const key = secret
    ? Buffer.from(secret, 'utf8')
    : crypto.createHmac('sha256', jwt || 'digby-no-jwt-secret').update(VISITOR_HASH_LABEL).digest();
  memo = { secret, jwt, key };
  return key;
}

/** Normalize an address for hashing: strip the IPv4-mapped IPv6 prefix, a port and whitespace; lower-case. */
export function normalizeIpForHash(ip: unknown): string {
  let s = typeof ip === 'string' ? ip.trim().toLowerCase() : '';
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.replace(/:\d+$/, '');
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
  return s;
}

/** HMAC hash of a client IP, or null for a missing / 'unknown' address. Never returns the input. */
export function hashIp(ip: unknown): string | null {
  const s = normalizeIpForHash(ip);
  if (!s || s === 'unknown') return null;
  return crypto.createHmac('sha256', visitorHashKey()).update(s).digest('hex').slice(0, IP_HASH_HEX_LEN);
}

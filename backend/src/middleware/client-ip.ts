/**
 * The hops-anchored client-IP derivation (ticket 4a8fcbde secondary / todo
 * ead881f4) — the ONE leaf both auth attribution surfaces share, so the
 * login-failure path (error-handler.ts) and the JWT spike-sample path
 * (auth-signal.ts) cannot drift apart. It lives in its own module because
 * error-handler imports auth-signal (the spike recorder), never the reverse.
 *
 * Why not `req.ip`: app.ts sets `trust proxy 1`, which names exactly ONE
 * trusted hop — behind AWS ALB → nginx → Express the socket peer is the LAST
 * proxy in the chain, so req.ip is an ALB node (RFC1918), not the caller, and
 * ALB node rotation then reads as "attacker IP rotation" in every
 * distinct-IP escalation arm.
 *
 * Derivation — the SAME shape as quotaClientIp (crossmodel.controller.ts) and
 * clientIpForHash (visitor.service.ts): the trusted proxies APPEND (never
 * prepend) to X-Forwarded-For, so the entry the LAST trusted proxy appended
 * sits `hops` from the RIGHT of the chain — a position a client cannot move
 * by PREPENDING forged hops to its own request header (the first-hop position
 * is client-writable and is exactly the forgery this function must not trust).
 * Set QUOTA_TRUSTED_PROXY_HOPS=<n> (expected 2: ALB + nginx; the shared
 * Phase-0 hop-count knob for quota keying and every client-IP read).
 * Unset ⇒ undefined (the field is omitted, never guessed). A chain shorter
 * than the hop count, or a derived candidate that is itself private/loopback,
 * also yields undefined — the result is a diagnostic companion to req.ip,
 * never a replacement; req.ip stays the attribution of record.
 */
import { Request } from 'express';

export function peelClientIp(req: Pick<Request, 'ip' | 'headers' | 'socket'>): string | undefined {
  const hops = Number(process.env.QUOTA_TRUSTED_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 1) return undefined;
  const raw = (req.headers ?? {})['x-forwarded-for'];
  const chain = (Array.isArray(raw) ? raw.join(',') : String(raw ?? '')).split(',').map((p) => p.trim()).filter(Boolean);
  if (chain.length < hops) return undefined;
  // `hops` from the right: the entry the last trusted proxy appended (the
  // real client). Forged hops PREPENDED by the client sit LEFT of this
  // position and cannot move it; a private address here means the chain is
  // fully internal and there is no client to recover.
  const candidate = chain[chain.length - hops];
  if (!candidate || isPrivateOrLoopback(candidate)) return undefined;
  return candidate;
}

export function isPrivateOrLoopback(ip: string): boolean {
  if (/^(127\.|10\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.1[89]\.|::1$|fe80:|fc00:|fd)/i.test(ip)) return true;
  return /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

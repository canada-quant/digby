/**
 * Guest location context (owner 2026-09-23).
 *
 * Signed-in users carry a `location` memory fact (the page's geolocation
 * effect writes it), which the LOCATION-AWARE PLACE QUERIES doctrine resolves
 * "best place for tacos" against. Guests have no memory, so every local
 * question bounced back with "which city are you in?". Two sources, best
 * first:
 *   1. Browser-reported — the guest page asks for geolocation, reverse-
 *      geocodes to "City, Region, Country" and sends it as ?userLocation.
 *   2. Approximate IP lookup — when the browser gave nothing (denied /
 *      unsupported). Redis-cached 24h per IP, 2s timeout, fail-soft (no
 *      block at all on any error). Private/loopback IPs are never looked up.
 *
 * Kill switch: IP_GEO_DISABLED=1. Endpoint override: IP_GEO_URL (a template
 * containing `{ip}`, returning ipwho.is-shaped JSON {success, city, region,
 * country}).
 */

import redisClient from '../../config/redis';
import logger from '../../utils/logger';

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const LOOKUP_TIMEOUT_MS = 2000;
const DEFAULT_IP_GEO_URL = 'https://ipwho.is/{ip}?fields=success,city,region,country';

/**
 * Clamp a client-reported location label to something safe to put in a
 * prompt: printable, no brackets (can't forge a context block), ≤120 chars.
 * Returns undefined for empty/garbage input.
 */
export function sanitizeClientLocation(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return /\p{L}/u.test(cleaned) ? cleaned : undefined;
}

/** True for addresses an external geo lookup can say nothing useful about. */
export function isPrivateIp(ip: string): boolean {
  if (!ip || ip === 'unknown') return true;
  const v = ip.toLowerCase();
  if (v === '::1' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
  const m = v.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

/** Approximate "City, Region, Country" for an IP, or undefined. Never throws. */
export async function lookupIpLocation(ip: string): Promise<string | undefined> {
  if (process.env.IP_GEO_DISABLED === '1' || isPrivateIp(ip)) return undefined;
  const cacheKey = `ipgeo:${ip}`;
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached !== null && cached !== undefined) return cached || undefined; // '' = cached miss
  } catch { /* redis down — look up live */ }

  let label = '';
  try {
    const url = (process.env.IP_GEO_URL || DEFAULT_IP_GEO_URL).replace('{ip}', encodeURIComponent(ip));
    const resp = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (resp.ok) {
      const data: any = await resp.json();
      if (data && data.success !== false) {
        label = sanitizeClientLocation([data.city, data.region, data.country].filter(Boolean).join(', ')) || '';
      }
    }
  } catch (err) {
    logger.debug(`guest-location: IP lookup failed: ${(err as Error)?.message ?? err}`);
  }
  try { await redisClient.set(cacheKey, label, { EX: CACHE_TTL_SECONDS }); } catch { /* best-effort */ }
  return label || undefined;
}

/**
 * The `[USER LOCATION]` context block for a guest run, or undefined when no
 * source produced anything (the doctrine then asks the user, as before).
 */
export async function buildGuestLocationBlock(args: { clientLocation?: unknown; clientIp: string }): Promise<string | undefined> {
  const reported = sanitizeClientLocation(args.clientLocation);
  if (reported) {
    return `[USER LOCATION]\nThis signed-out visitor's browser reports their location as: ${reported}.\nUse it for local/place questions (restaurants, stores, weather, "near me") without asking which city — mention the area you searched so they can correct you.\n[/USER LOCATION]`;
  }
  const approx = await lookupIpLocation(args.clientIp);
  if (approx) {
    return `[USER LOCATION]\nApproximate location from this signed-out visitor's IP address (may be off by a city or more, e.g. on a VPN or mobile network): ${approx}.\nFor local/place questions, answer for this area rather than stalling — say briefly that you assumed "${approx}" and invite them to name a different city if that's wrong.\n[/USER LOCATION]`;
  }
  return undefined;
}

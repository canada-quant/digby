/**
 * Meta Conversions API — the server half of the Meta Pixel sign-up event (owner 2026-10-07: the Meta Pixel snippet +
 * the Events Manager "Set Up Complete registration Event" page: Event Time, Event Name, Event Source URL, Action
 * Source, Client User Agent (not hashed), Email).
 *
 * After a successful POST /api/auth/register the controller calls sendMetaCompleteRegistration() fire-and-forget. One
 * `CompleteRegistration` server event is posted to `graph.facebook.com/<version>/<pixel>/events` with the SAME
 * `event_id` the browser's `fbq('track','CompleteRegistration', {}, {eventID})` used (frontend/lib/meta-pixel.ts), so
 * Meta deduplicates the pair into one conversion.
 *
 * - INERT until `META_CAPI_ACCESS_TOKEN` is set (the Events Manager token; GitHub secret → deploy.yml → .env →
 *   docker-compose.app.yml backend env). The token rides the POST BODY, never the URL, so no logged error can carry it.
 * - Only the register route calls it — Digby Kids child accounts are created by a parent (children.controller) and
 *   never reach it.
 * - Email + user id are SHA-256 hashed (normalised: trimmed, lower-case) as Meta requires; the user agent, IP and the
 *   `_fbp` / `_fbc` cookies are sent as-is (Meta's documented "do not hash" fields).
 * - Never throws, never blocks the sign-up response (bounded by META_CAPI_TIMEOUT_MS).
 * Kill switch `META_CAPI_DISABLED=1`. `META_GRAPH_API_VERSION` overrides the Graph version (default v24.0).
 */
import crypto from 'crypto';
import logger from '../../utils/logger';

export const META_PIXEL_ID = '4660227547545860';
const DEFAULT_GRAPH_VERSION = 'v24.0';
const META_CAPI_TIMEOUT_MS = 5_000;

/** A browser-made event id we accept for deduplication (uuid / alnum, bounded). */
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function metaCapiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.META_CAPI_DISABLED !== '1' && !!(env.META_CAPI_ACCESS_TOKEN || '').trim();
}

export function sha256Normalized(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

/** Meta's click-id cookie shape: fb.<subdomain index>.<creation ms>.<fbclid>. */
const FBC_RE = /^fb\.\d\.\d{10,13}\.[A-Za-z0-9_-]{8,500}$/;
const FBCLID_RE = /^[A-Za-z0-9_-]{8,500}$/;

export function validFbc(v: unknown): string | undefined {
  return typeof v === 'string' && FBC_RE.test(v.trim()) ? v.trim() : undefined;
}

/**
 * The Meta ClickID (fbc) for a sign-up (owner 2026-10-08, Events Manager: "Send Meta ClickID to improve conversion
 * reporting" — 0% of CompleteRegistration events carried it). In order: the `_fbc` cookie (Meta's pixel or our own
 * frontend writes it from ?fbclid), the browser's copy in the register body (`metaFbc`), else BUILT from the fbclid
 * our own first-party visitor capture recorded (the dg_lt / dg_ft touch cookies — they survive an ad blocker that
 * stops Meta's script): `fb.1.<touch ms>.<fbclid>`, last touch first. Invalid shapes are dropped, never sent.
 */
export function chooseFbc(input: {
  cookie?: unknown;
  body?: unknown;
  touches?: Array<{ fbclid?: string; ts?: number } | null | undefined>;
  nowMs?: number;
}): string | undefined {
  const direct = validFbc(input.cookie) ?? validFbc(input.body);
  if (direct) return direct;
  for (const t of input.touches ?? []) {
    if (!t || typeof t.fbclid !== 'string' || !FBCLID_RE.test(t.fbclid)) continue;
    const ts = typeof t.ts === 'number' && t.ts > 1e12 && t.ts <= (input.nowMs ?? Date.now()) ? Math.floor(t.ts) : (input.nowMs ?? Date.now());
    return `fb.1.${ts}.${t.fbclid}`;
  }
  return undefined;
}

/** The browser's event id when it is well-formed, else a fresh server one (no dedup partner, still one event). */
export function resolveMetaEventId(raw: unknown): string {
  return typeof raw === 'string' && EVENT_ID_RE.test(raw) ? raw : `reg_${crypto.randomUUID()}`;
}

export interface MetaRegistrationInput {
  email: string;
  userId: string;
  eventId: string;
  eventSourceUrl?: string;
  clientUserAgent?: string;
  clientIpAddress?: string;
  fbp?: string;
  fbc?: string;
  nowMs?: number;
}

/** The Conversions API payload for one CompleteRegistration (no token — the sender adds it). */
export function buildCompleteRegistrationEvent(i: MetaRegistrationInput): Record<string, unknown> {
  const userData: Record<string, unknown> = {
    em: [sha256Normalized(i.email)],
    external_id: [sha256Normalized(i.userId)],
  };
  if (i.clientUserAgent) userData.client_user_agent = i.clientUserAgent;
  if (i.clientIpAddress) userData.client_ip_address = i.clientIpAddress;
  if (i.fbp) userData.fbp = i.fbp;
  if (i.fbc) userData.fbc = i.fbc;
  const event: Record<string, unknown> = {
    event_name: 'CompleteRegistration',
    event_time: Math.floor((i.nowMs ?? Date.now()) / 1000),
    event_id: i.eventId,
    action_source: 'website',
    user_data: userData,
  };
  if (i.eventSourceUrl) event.event_source_url = i.eventSourceUrl;
  return event;
}

/** The page the sign-up happened on — the Referer when it is an https digby page, else the site's sign-up URL. */
export function eventSourceUrlFrom(referer: string | undefined): string {
  if (referer && /^https:\/\/(www\.)?digby\.example\.com(\/|$)/.test(referer)) return referer.slice(0, 1000);
  return 'https://digby.example.com/login?signup=true';
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Post one CompleteRegistration. Resolves true on a 2xx, false otherwise; never throws. */
export async function sendMetaCompleteRegistration(
  input: MetaRegistrationInput,
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (!metaCapiEnabled(env)) return false;
  try {
    const version = (env.META_GRAPH_API_VERSION || DEFAULT_GRAPH_VERSION).trim();
    const fetchImpl: FetchLike = deps.fetchImpl ?? (fetch as unknown as FetchLike);
    const res = await fetchImpl(`https://graph.facebook.com/${version}/${META_PIXEL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [buildCompleteRegistrationEvent(input)], access_token: (env.META_CAPI_ACCESS_TOKEN || '').trim() }),
      signal: AbortSignal.timeout(META_CAPI_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      logger.warn(`Meta CAPI CompleteRegistration rejected: HTTP ${res.status} ${body}`);
      return false;
    }
    logger.info(`Meta CAPI CompleteRegistration sent (event ${input.eventId})`);
    return true;
  } catch (err) {
    logger.warn(`Meta CAPI CompleteRegistration failed: ${(err as Error)?.message || String(err)}`);
    return false;
  }
}

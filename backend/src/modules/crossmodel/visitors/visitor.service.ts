/**
 * First-party visitor analytics — the WRITE side (owner 2026-10-07: "i need a way to see activity on users/api
 * cost/ ip addressed or unique hash for users that use digby from what traffic source ie google ads facebook and
 * the user flow").
 *
 *  - ingestVisitBatch: the open POST /api/crossmodel/visit-events body (the web capture, frontend/lib/visitor-
 *    analytics.ts) → one upserted `visitors` row (ip HASH, coarse UA family, first / last touch, channel) + its
 *    `visit_events`. An obvious bot (ua.ts) stores nothing; navigator.webdriver marks the row isBot (kept, excluded
 *    from every admin count).
 *  - recordServerVisitEvent: the AUTHORITATIVE backend hooks (register / login / chat sent / first chat / Dig deeper
 *    / coding session started) — the client may be blocked. Server rows win: a server event deletes the client
 *    copies of the same type for the same visitor / user within ±5 min, and a client copy arriving after a server
 *    row in that window is dropped. Once-per-subject types (signup_complete, first_chat) carry a unique dedupeKey.
 *  - stitching: a request carrying the visitor id (the `dg_vid` cookie or the `X-Digby-Visitor` header) from an
 *    authenticated adult links visitor → user (visitor_links; many-to-many). A user's FIRST-touch attribution is the
 *    earliest-seen linked visitor's (visitor-analytics.service.ts).
 *
 * PRIVACY: a raw IP is never stored (ip-hash.ts HMAC); Digby Kids are never tracked — a child token / a DB child
 * stores nothing, and a visitor id that turns out to be a child's browser is ERASED unless an adult account already
 * owns it. Kill switch VISITOR_ANALYTICS_DISABLED=1: the endpoint answers 204 and nothing (client or server) is
 * written. Everything here is fail-open: it never throws into a request path.
 *
 * Writes are raw SQL ($executeRawUnsafe / $queryRawUnsafe, positional params only — never interpolated input) so the
 * first-touch COALESCE semantics are one statement; a Prisma mock without the raw methods makes every call a no-op.
 */
import { randomUUID } from 'crypto';
import { z } from 'zod';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { campaignOf, classifyChannel, hasSource, normalizePath, sanitizeTouch, Touch } from './attribution';
import { parseUserAgent, uaFamilyString } from './ua';
import { hashIp } from './ip-hash';

// ── switches + constants ─────────────────────────────────────────────────────

export function visitorAnalyticsDisabled(): boolean {
  const v = String(process.env.VISITOR_ANALYTICS_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export const VISITOR_COOKIE = 'dg_vid';
export const FIRST_TOUCH_COOKIE = 'dg_ft';
export const LAST_TOUCH_COOKIE = 'dg_lt';
export const VISITOR_HEADER = 'x-digby-visitor';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Event types the web client may send (an unknown type is dropped, never a 400 — old/new clients stay compatible). */
export const CLIENT_EVENT_TYPES = [
  'page_view', 'signup_view', 'login_view', 'signup_cta', 'signup_complete', 'login', 'chat_sent', 'coding_session_started',
] as const;
/** Event types the backend records itself (authoritative). */
export const SERVER_EVENT_TYPES = ['signup_complete', 'login', 'first_chat', 'chat_sent', 'dig_deeper', 'coding_session_started'] as const;
export type ClientEventType = typeof CLIENT_EVENT_TYPES[number];
export type ServerEventType = typeof SERVER_EVENT_TYPES[number];
/** One row per subject, ever (unique dedupeKey). */
export const ONCE_EVENT_TYPES: ReadonlySet<string> = new Set(['signup_complete', 'first_chat']);
const SERVER_TYPE_SET: ReadonlySet<string> = new Set(SERVER_EVENT_TYPES);
const CLIENT_TYPE_SET: ReadonlySet<string> = new Set(CLIENT_EVENT_TYPES);
/** Server ↔ client duplicate window. */
export const DEDUPE_WINDOW_MS = 5 * 60_000;
export const MAX_EVENTS_PER_BATCH = 50;
/** A client event's own timestamp is honoured inside [now − 24 h, now + 60 s]; outside it the row is stamped now. */
const CLIENT_TS_PAST_MS = 24 * 3_600_000;
const CLIENT_TS_FUTURE_MS = 60_000;
/** A send counts as a user's FIRST chat only when no earlier human message exists before this margin. */
const FIRST_CHAT_PRIOR_MARGIN_MS = 2 * 60_000;

// ── request helpers ──────────────────────────────────────────────────────────

/** The minimal request shape the hooks read (an Express Request satisfies it). */
export interface VisitorRequestLike {
  headers?: Record<string, unknown>;
  cookies?: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

function header(req: VisitorRequestLike | undefined, name: string): string | undefined {
  const v = req?.headers?.[name];
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

/** The visitor id a request carries: the X-Digby-Visitor header, else the dg_vid cookie. UUID-shaped or null. */
export function visitorIdFromRequest(req: VisitorRequestLike | undefined): string | null {
  const fromHeader = header(req, VISITOR_HEADER)?.trim();
  if (fromHeader && UUID_RE.test(fromHeader)) return fromHeader.toLowerCase();
  const c = req?.cookies?.[VISITOR_COOKIE];
  if (typeof c === 'string' && UUID_RE.test(c.trim())) return c.trim().toLowerCase();
  return null;
}

/** A touch cookie (dg_ft / dg_lt — URI-encoded JSON written by the web capture), sanitized; null when absent/junk. */
export function cookieTouch(req: VisitorRequestLike | undefined, name: string): Touch | null {
  const raw = req?.cookies?.[name];
  if (typeof raw !== 'string' || !raw || raw.length > 4000) return null;
  try {
    let s = raw;
    try { s = decodeURIComponent(raw); } catch { /* already decoded */ }
    return sanitizeTouch(JSON.parse(s));
  } catch {
    return null;
  }
}

/**
 * The client IP to hash — the same trust rule as crossmodel.controller quotaClientIp: with
 * QUOTA_TRUSTED_PROXY_HOPS=<n> the X-Forwarded-For entry the last trusted proxy appended (n from the right — a
 * client cannot forge it by prepending hops); unset (today) the first XFF entry, else req.ip.
 */
export function clientIpForHash(req: VisitorRequestLike | undefined): string {
  const raw = req?.headers?.['x-forwarded-for'];
  const chain = (Array.isArray(raw) ? raw.join(',') : String(raw ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  const hops = Number(process.env.QUOTA_TRUSTED_PROXY_HOPS);
  if (Number.isInteger(hops) && hops >= 1 && chain.length >= hops) return chain[chain.length - hops];
  return chain[0] || req?.ip || req?.socket?.remoteAddress || 'unknown';
}

// ── raw SQL access (fail-open) ───────────────────────────────────────────────

type RawDb = {
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T = unknown>(sql: string, ...params: unknown[]) => Promise<T>;
};

function db(): RawDb | null {
  const p = prisma as unknown as Partial<RawDb> | undefined;
  return p && typeof p.$executeRawUnsafe === 'function' && typeof p.$queryRawUnsafe === 'function' ? (p as RawDb) : null;
}

// ── caches (per process; bounded) ────────────────────────────────────────────

const CHILD_TTL_MS = 10 * 60_000;
const childCache = new Map<string, { child: boolean; at: number }>();
const linkCache = new Set<string>();
const chattedCache = new Set<string>();
const CACHE_CAP = 20_000;

function capSet(s: Set<string>): void { if (s.size > CACHE_CAP) s.clear(); }

/** Tests only. */
export function __resetVisitorCachesForTest(): void {
  childCache.clear();
  linkCache.clear();
  chattedCache.clear();
}

/** Is this user a Digby Kids child (DB truth, cached 10 min)? Fails CLOSED (true) when the read errors. */
export async function isChildUser(userId: string): Promise<boolean> {
  const hit = childCache.get(userId);
  if (hit && Date.now() - hit.at < CHILD_TTL_MS) return hit.child;
  const d = db();
  if (!d) return true;
  try {
    const rows = await d.$queryRawUnsafe<Array<{ isChild: boolean }>>('SELECT "isChild" FROM "users" WHERE "id" = $1 LIMIT 1', userId);
    const child = Array.isArray(rows) && rows[0] ? rows[0].isChild === true : true; // no such user ⇒ never record
    if (childCache.size > 5_000) childCache.clear();
    childCache.set(userId, { child, at: Date.now() });
    return child;
  } catch {
    return true;
  }
}

// ── visitor rows ─────────────────────────────────────────────────────────────

export interface VisitorUpsert {
  visitorId: string;
  ipHash: string | null;
  uaFamily: string | null;
  first: Touch | null;
  last: Touch | null;
  isBot: boolean;
  now: Date;
}

/**
 * Insert-or-refresh one visitor. FIRST TOUCH IS NEVER OVERWRITTEN: firstTouch / channel / campaign are written only
 * while the stored firstTouch is NULL (a row a server hook created before the client's first batch). lastTouch moves
 * only when the new touch carries a source. firstSeen keeps the earliest known time.
 */
export async function upsertVisitor(v: VisitorUpsert): Promise<void> {
  const d = db();
  if (!d) return;
  const channel = v.first ? classifyChannel(v.first) : null;
  const campaign = v.first ? campaignOf(v.first) : null;
  const last = v.last && hasSource(v.last) ? v.last : null;
  const lastChannel = last ? classifyChannel(last) : null;
  const firstSeen = v.first?.ts ? new Date(Math.min(v.first.ts, v.now.getTime())) : v.now;
  await d.$executeRawUnsafe(
    `INSERT INTO "visitors" ("id", "ipHash", "firstTouch", "lastTouch", "channel", "campaign", "lastChannel", "firstSeen", "lastSeen", "uaFamily", "isBot")
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT ("id") DO UPDATE SET
       "ipHash"      = COALESCE(EXCLUDED."ipHash", "visitors"."ipHash"),
       "channel"     = CASE WHEN "visitors"."firstTouch" IS NULL AND EXCLUDED."firstTouch" IS NOT NULL THEN EXCLUDED."channel" ELSE "visitors"."channel" END,
       "campaign"    = CASE WHEN "visitors"."firstTouch" IS NULL AND EXCLUDED."firstTouch" IS NOT NULL THEN EXCLUDED."campaign" ELSE "visitors"."campaign" END,
       "firstTouch"  = COALESCE("visitors"."firstTouch", EXCLUDED."firstTouch"),
       "lastTouch"   = COALESCE(EXCLUDED."lastTouch", "visitors"."lastTouch"),
       "lastChannel" = COALESCE(EXCLUDED."lastChannel", "visitors"."lastChannel"),
       "firstSeen"   = LEAST("visitors"."firstSeen", EXCLUDED."firstSeen"),
       "lastSeen"    = GREATEST("visitors"."lastSeen", EXCLUDED."lastSeen"),
       "uaFamily"    = COALESCE(EXCLUDED."uaFamily", "visitors"."uaFamily"),
       "isBot"       = "visitors"."isBot" OR EXCLUDED."isBot"`,
    v.visitorId, v.ipHash,
    v.first ? JSON.stringify(v.first) : null,
    last ? JSON.stringify(last) : null,
    channel, campaign, lastChannel,
    firstSeen, v.now, v.uaFamily, v.isBot,
  );
}

/** visitor → user (idempotent; cached). The visitor row must exist (FK). */
export async function linkVisitorToUser(visitorId: string, userId: string): Promise<void> {
  const key = `${visitorId}|${userId}`;
  if (linkCache.has(key)) return;
  const d = db();
  if (!d) return;
  await d.$executeRawUnsafe(
    'INSERT INTO "visitor_links" ("visitorId", "userId", "linkedAt") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    visitorId, userId, new Date(),
  );
  capSet(linkCache);
  linkCache.add(key);
}

/**
 * Digby Kids: a visitor id seen on a CHILD session is erased (its events cascade) unless an adult account already
 * owns it (a shared family browser keeps the parent's history). Never throws.
 */
export async function forgetChildVisitor(visitorId: string | null | undefined): Promise<void> {
  if (!visitorId) return;
  const d = db();
  if (!d) return;
  try {
    await d.$executeRawUnsafe(
      `DELETE FROM "visitors" v WHERE v."id" = $1 AND NOT EXISTS (
         SELECT 1 FROM "visitor_links" l JOIN "users" u ON u."id" = l."userId" WHERE l."visitorId" = v."id" AND u."isChild" = false)`,
      visitorId,
    );
  } catch (err: any) {
    logger.debug(`visitor-analytics: forgetChildVisitor failed (non-fatal): ${err?.message ?? err}`);
  }
}

// ── events ───────────────────────────────────────────────────────────────────

interface EventRow {
  visitorId: string | null;
  userId: string | null;
  type: string;
  path: string | null;
  props: Record<string, unknown> | null;
  source: 'client' | 'server';
  dedupeKey: string | null;
  spendSessionId: string | null;
  createdAt: Date;
}

export function dedupeKeyFor(type: string, userId: string | null | undefined, visitorId: string | null | undefined): string | null {
  if (!ONCE_EVENT_TYPES.has(type)) return null;
  if (userId) return `${type}:u:${userId}`;
  if (visitorId) return `${type}:v:${visitorId}`;
  return null;
}

async function insertEvents(rows: EventRow[]): Promise<number> {
  const d = db();
  if (!d || !rows.length) return 0;
  const params: unknown[] = [];
  const tuples = rows.map((r) => {
    const base = params.length;
    params.push(randomUUID(), r.visitorId, r.userId, r.type, r.path, r.props ? JSON.stringify(r.props) : null, r.source, r.dedupeKey, r.spendSessionId, r.createdAt);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
  });
  const n = await d.$executeRawUnsafe(
    `INSERT INTO "visit_events" ("id", "visitorId", "userId", "type", "path", "props", "source", "dedupeKey", "spendSessionId", "createdAt")
     VALUES ${tuples.join(', ')} ON CONFLICT ("dedupeKey") DO NOTHING`,
    ...params,
  );
  return Number(n) || 0;
}

/** A server row of `type` for this visitor / user inside ±DEDUPE_WINDOW_MS of `at`? */
async function serverRowNear(type: string, visitorId: string | null, userId: string | null, at: Date): Promise<boolean> {
  const d = db();
  if (!d || (!visitorId && !userId)) return false;
  const rows = await d.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM "visit_events" WHERE "type" = $1 AND "source" = 'server'
       AND (("visitorId" IS NOT NULL AND "visitorId" = $2) OR ("userId" IS NOT NULL AND "userId" = $3))
       AND "createdAt" BETWEEN $4 AND $5 LIMIT 1`,
    type, visitorId, userId, new Date(at.getTime() - DEDUPE_WINDOW_MS), new Date(at.getTime() + DEDUPE_WINDOW_MS),
  );
  return Array.isArray(rows) && rows.length > 0;
}

const PROP_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** ≤ 12 props; keys identifier-shaped; values a ≤ 200-char string, a finite number, a boolean or null. */
export function sanitizeProps(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 12) break;
    if (!PROP_KEY_RE.test(k)) continue;
    if (typeof v === 'string') out[k] = v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean' || v === null) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// ── the open endpoint's batch ────────────────────────────────────────────────

const looseTouch = z.record(z.string(), z.unknown()).nullable().optional();
export const visitBatchSchema = z.object({
  visitorId: z.string().regex(UUID_RE),
  events: z.array(z.object({
    type: z.string().min(1).max(40),
    path: z.string().max(2000).optional().nullable(),
    ts: z.number().optional().nullable(),
    props: z.record(z.string(), z.unknown()).optional().nullable(),
  })).max(MAX_EVENTS_PER_BATCH),
  attribution: z.object({ first: looseTouch, last: looseTouch }).optional().nullable(),
  webdriver: z.boolean().optional().nullable(),
});
export type VisitBatch = z.infer<typeof visitBatchSchema>;

export interface IngestInput {
  body: unknown;
  /** the authenticated user (optionalAuthenticate), if any */
  user?: { id?: string; userId?: string; isChild?: boolean } | null;
  req?: VisitorRequestLike;
  now?: Date;
}

export type IngestResult =
  | { status: 'stored'; events: number; visitorId: string }
  | { status: 'skipped'; reason: 'disabled' | 'bot' | 'child' | 'no_db' }
  | { status: 'invalid'; error: string };

/** The POST /visit-events body → rows. Never throws (a DB error is logged and reported as stored 0). */
export async function ingestVisitBatch(input: IngestInput): Promise<IngestResult> {
  if (visitorAnalyticsDisabled()) return { status: 'skipped', reason: 'disabled' };
  let body: unknown = input.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return { status: 'invalid', error: 'body is not JSON' }; }
  }
  const parsed = visitBatchSchema.safeParse(body);
  if (!parsed.success) return { status: 'invalid', error: parsed.error.issues[0]?.message ?? 'invalid body' };
  const batch = parsed.data;
  const visitorId = batch.visitorId.toLowerCase();
  const ua = parseUserAgent(header(input.req, 'user-agent'));
  if (ua.bot) return { status: 'skipped', reason: 'bot' };
  const userId = input.user?.id || input.user?.userId || null;
  // Digby Kids — the token claim first, then the DB (old tokens / a stale claim). A child's visitor id is erased.
  if (input.user?.isChild === true || (userId && await isChildUser(userId))) {
    await forgetChildVisitor(visitorId);
    return { status: 'skipped', reason: 'child' };
  }
  if (!db()) return { status: 'skipped', reason: 'no_db' };
  const now = input.now ?? new Date();
  try {
    await upsertVisitor({
      visitorId,
      ipHash: hashIp(clientIpForHash(input.req)),
      uaFamily: uaFamilyString(ua),
      first: sanitizeTouch(batch.attribution?.first, now.getTime()),
      last: sanitizeTouch(batch.attribution?.last, now.getTime()),
      isBot: batch.webdriver === true,
      now,
    });
    if (userId) await linkVisitorToUser(visitorId, userId);
    const rows: EventRow[] = [];
    for (const e of batch.events) {
      if (!CLIENT_TYPE_SET.has(e.type)) continue;
      const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : NaN;
      const createdAt = ts >= now.getTime() - CLIENT_TS_PAST_MS && ts <= now.getTime() + CLIENT_TS_FUTURE_MS ? new Date(Math.min(ts, now.getTime())) : now;
      // A client copy of a server-authoritative type yields to a server row in the window.
      if (SERVER_TYPE_SET.has(e.type) && !ONCE_EVENT_TYPES.has(e.type) && await serverRowNear(e.type, visitorId, userId, createdAt)) continue;
      rows.push({
        visitorId, userId, type: e.type,
        path: e.path ? normalizePath(e.path) : null,
        props: sanitizeProps(e.props),
        source: 'client',
        dedupeKey: dedupeKeyFor(e.type, userId, visitorId),
        spendSessionId: null,
        createdAt,
      });
    }
    const n = await insertEvents(rows);
    return { status: 'stored', events: n, visitorId };
  } catch (err: any) {
    logger.warn(`visitor-analytics: batch write failed (non-fatal): ${err?.message ?? err}`);
    return { status: 'stored', events: 0, visitorId };
  }
}

// ── server-side (authoritative) events ───────────────────────────────────────

export interface ServerVisitEventInput {
  type: ServerEventType;
  userId?: string | null;
  /** the caller already knows (streamQuery reads it) — skips the DB check */
  isChild?: boolean;
  req?: VisitorRequestLike;
  visitorId?: string | null;
  path?: string | null;
  props?: Record<string, unknown> | null;
  /** the run_spend sessionId this turn bills to — a guest's `anon-<session>` (guest cost → this visitor) */
  spendSessionId?: string | null;
  at?: Date;
}

/** Has this user already chatted (a first_chat row, or a human message older than the margin)? Cached. */
async function userHasChatted(userId: string, at: Date): Promise<boolean> {
  if (chattedCache.has(userId)) return true;
  const d = db();
  if (!d) return true;
  const rows = await d.$queryRawUnsafe<Array<{ hit: boolean }>>(
    `SELECT (EXISTS (SELECT 1 FROM "visit_events" WHERE "dedupeKey" = $1)
         OR EXISTS (SELECT 1 FROM "crossmodel_messages" m JOIN "crossmodel_chats" c ON c."id" = m."chatId"
                    WHERE c."userId" = $2 AND m."role" = 'user' AND COALESCE(m."metadata"->>'origin', 'user') = 'user'
                      AND m."createdAt" < $3)) AS hit`,
    `first_chat:u:${userId}`, userId, new Date(at.getTime() - FIRST_CHAT_PRIOR_MARGIN_MS),
  );
  const hit = Array.isArray(rows) && rows[0]?.hit === true;
  if (hit) { capSet(chattedCache); chattedCache.add(userId); }
  return hit;
}

/**
 * Record one authoritative backend event. Fire-and-forget: never throws, never awaited on a hot path's critical
 * section (callers `void` it). Digby Kids never recorded; the kill switch records nothing.
 */
export async function recordServerVisitEvent(input: ServerVisitEventInput): Promise<void> {
  try {
    if (visitorAnalyticsDisabled() || !db()) return;
    const userId = input.userId || null;
    const visitorId = input.visitorId ?? visitorIdFromRequest(input.req);
    if (userId && (input.isChild === true || (input.isChild === undefined && await isChildUser(userId)))) {
      await forgetChildVisitor(visitorId);
      return;
    }
    if (!userId && !visitorId) return;
    const at = input.at ?? new Date();
    if (visitorId) {
      // No bot drop here: a server event is an authenticated / real action (a native app's HTTP-library UA is not a
      // crawler) — only the family is skipped when the UA is missing or library-shaped.
      const ua = input.req ? parseUserAgent(header(input.req, 'user-agent')) : null;
      await upsertVisitor({
        visitorId,
        ipHash: input.req ? hashIp(clientIpForHash(input.req)) : null,
        uaFamily: ua && !ua.bot ? uaFamilyString(ua) : null,
        first: cookieTouch(input.req, FIRST_TOUCH_COOKIE),
        last: cookieTouch(input.req, LAST_TOUCH_COOKIE),
        isBot: false,
        now: at,
      });
      if (userId) await linkVisitorToUser(visitorId, userId);
    }
    const d = db()!;
    if (!ONCE_EVENT_TYPES.has(input.type)) {
      // Server rows win: drop the client copies of this type for the same subject in the window.
      await d.$executeRawUnsafe(
        `DELETE FROM "visit_events" WHERE "type" = $1 AND "source" = 'client'
           AND (("visitorId" IS NOT NULL AND "visitorId" = $2) OR ("userId" IS NOT NULL AND "userId" = $3))
           AND "createdAt" BETWEEN $4 AND $5`,
        input.type, visitorId, userId, new Date(at.getTime() - DEDUPE_WINDOW_MS), new Date(at.getTime() + DEDUPE_WINDOW_MS),
      );
    }
    // First chat — derived from the send, once per subject.
    let firstChat = false;
    if (input.type === 'chat_sent') {
      firstChat = userId ? !(await userHasChatted(userId, at)) : !!visitorId;
    }
    const rows: EventRow[] = [{
      visitorId, userId, type: input.type,
      path: input.path ? normalizePath(input.path) : null,
      props: sanitizeProps(input.props),
      source: 'server',
      dedupeKey: dedupeKeyFor(input.type, userId, visitorId),
      spendSessionId: input.spendSessionId || null,
      createdAt: at,
    }];
    if (firstChat) {
      rows.push({ ...rows[0], type: 'first_chat', dedupeKey: dedupeKeyFor('first_chat', userId, visitorId), createdAt: new Date(at.getTime() - 1) });
    }
    await insertEvents(rows);
    if (firstChat && userId) { capSet(chattedCache); chattedCache.add(userId); }
  } catch (err: any) {
    logger.debug(`visitor-analytics: server event ${input.type} failed (non-fatal): ${err?.message ?? err}`);
  }
}

/**
 * Register / login stitching (auth.controller, fire-and-forget): link the request's visitor to the account and
 * record the server event. A child login erases the browser's visitor id instead (unless an adult owns it).
 */
export async function recordAuthVisit(req: VisitorRequestLike | undefined, user: { id: string; isChild?: boolean | null }, type: 'signup_complete' | 'login'): Promise<void> {
  try {
    if (visitorAnalyticsDisabled()) return;
    if (user.isChild === true) {
      await forgetChildVisitor(visitorIdFromRequest(req));
      return;
    }
    await recordServerVisitEvent({ type, userId: user.id, isChild: user.isChild === false ? false : undefined, req, path: '/login' });
  } catch { /* never breaks auth */ }
}

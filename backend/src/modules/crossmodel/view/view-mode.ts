/**
 * Viewer mode (owner 2026-10-16: "clean up what users see on digby in a big way … very very very minimal
 * and doesnt tell you anything especially in coding sessions and supervisor sessions … I don't want anything
 * changed for the admin view … a mode on the admin account that is debug mode that shows everything how it
 * is today").
 *
 *   'full'    — today's view, byte-for-byte: an ADMIN with Debug mode ON (the default for every admin).
 *   'minimal' — every other viewer (users, guests, project members, and an admin who turned Debug mode OFF):
 *               the server strips the machinery before it leaves (view/minimal-view.ts) and the client renders
 *               the Grok-style view.
 *
 * Debug mode is a per-admin preference in the context store ([user, <id>, ui-prefs] / state, {debugMode}). Reads go
 * through Redis (`view:debug:<userId>`, shared by every backend box) so a flip takes effect on the very next request
 * whichever box serves it — the first cut cached it per process for 30 s, and prod's several backend processes kept
 * serving the old mode after a toggle (2026-10-16 live check). The store is the fallback; it is resolved once per
 * request (the SSE wrapper resolves before streaming), never per frame.
 *
 * Kill switch MINIMAL_VIEW_DISABLED=1 ⇒ every viewer is 'full' (today's behaviour for everyone).
 */

import { storeGet, storePut } from '../memory/context-store';
import { isProdInstance } from '../platform/instance-targets';

type RedisLike = { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<unknown> };
/** The shared Redis client, loaded lazily (config/redis validates the whole server env on import — callers that only
 *  resolve a user's view must not need it) and only when Redis is configured. Null ⇒ read the store. */
async function sharedRedis(): Promise<RedisLike | null> {
  if (!process.env.REDIS_URL) return null;
  try {
    const mod = await import('../../../config/redis');
    const client = (mod as any).default as RedisLike & { isOpen?: boolean };
    return client && client.isOpen !== false ? client : null;
  } catch {
    return null;
  }
}

export type ViewMode = 'full' | 'minimal';

export interface ViewerLike {
  id?: string | null;
  role?: string | null;
  email?: string | null;
}

/** The owner's account — the same fallback every inline admin check in this codebase carries. */
const OWNER_EMAIL = 'paul@sunday.market';

const PREFS_KEY = 'state';
const prefsNs = (userId: string) => ['user', userId, 'ui-prefs'];
const redisKey = (userId: string) => `view:debug:${userId}`;

export function minimalViewDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.MINIMAL_VIEW_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export function isAdminViewer(user: ViewerLike | null | undefined): boolean {
  if (!user) return false;
  if (String(user.role || '').toUpperCase() === 'ADMIN') return true;
  // The owner e-mail fallback is a PRODUCTION convenience. On a self-hosted
  // instance (open registration, no e-mail verification) honouring it would hand
  // super-admin to whoever registers that address — the ADMIN role is the only
  // authority there (self-host setup hardening 2026-10-20).
  if (!isProdInstance()) return false;
  return String(user.email || '').toLowerCase() === OWNER_EMAIL;
}

/** An admin's Debug mode. Default ON (an admin sees today's view until they turn it off). Never throws. */
export async function getDebugMode(userId: string): Promise<boolean> {
  const redis = await sharedRedis();
  try {
    const v = redis ? await redis.get(redisKey(userId)) : null;
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* Redis unavailable — read the store */ }
  let debugMode = true;
  try {
    const row = await storeGet<{ debugMode?: unknown }>(prefsNs(userId), PREFS_KEY);
    if (row && typeof row.debugMode === 'boolean') debugMode = row.debugMode;
  } catch { /* store unavailable — keep the default */ }
  try { if (redis) await redis.set(redisKey(userId), debugMode ? '1' : '0'); } catch { /* best effort */ }
  return debugMode;
}

export async function setDebugMode(userId: string, debugMode: boolean): Promise<void> {
  const existing = (await storeGet<Record<string, unknown>>(prefsNs(userId), PREFS_KEY).catch(() => null)) || {};
  await storePut(prefsNs(userId), PREFS_KEY, { ...existing, debugMode, debugModeUpdatedAt: new Date().toISOString() });
  const redis = await sharedRedis();
  try { if (redis) await redis.set(redisKey(userId), debugMode ? '1' : '0'); } catch { /* the store is the record; readers fall back to it */ }
}

/** Resolve the view for one viewer. Never throws — a failure resolves to the viewer's default. */
export async function resolveViewMode(user: ViewerLike | null | undefined): Promise<ViewMode> {
  if (minimalViewDisabled()) return 'full';
  if (!isAdminViewer(user)) return 'minimal';
  if (!user?.id) return 'full';
  return (await getDebugMode(user.id)) ? 'full' : 'minimal';
}

/**
 * The verification accounts (default the canonical prod test account) may ask for the FULL view per request —
 * header `X-Digby-View: full` or query `view=full` — so the synthetic suites (scripts/e2e/query-suite.py, the deploy
 * smoke) keep reading routing / tool / model facts. Without the ask they see exactly what a user sees, so the
 * minimal view is testable on the same account. Anyone else asking is ignored. Env VIEW_MODE_DEBUG_EMAILS
 * (comma list) replaces the default; an empty value disables the bypass.
 */
const DEFAULT_DEBUG_EMAILS = 'claudebot@digby.example.com';

export function viewModeDebugEmails(env: Record<string, string | undefined> = process.env): Set<string> {
  const raw = env.VIEW_MODE_DEBUG_EMAILS ?? DEFAULT_DEBUG_EMAILS;
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

interface RequestLike {
  user?: unknown;
  headers?: Record<string, unknown>;
  query?: unknown;
}

/** Resolve the view for one HTTP request (the viewer + an allowlisted account's per-request full-view ask). */
export async function resolveViewModeForRequest(req: RequestLike | null | undefined): Promise<ViewMode> {
  const user = (req?.user ?? null) as ViewerLike | null;
  if (user?.email && viewModeDebugEmails().has(String(user.email).toLowerCase())) {
    const header = String((req?.headers?.['x-digby-view'] as string | undefined) ?? '').trim().toLowerCase();
    let query = '';
    try { query = String(((req?.query ?? {}) as Record<string, unknown>).view ?? '').trim().toLowerCase(); } catch { /* re-parsing getter */ }
    if (header === 'full' || query === 'full') return 'full';
  }
  return resolveViewMode(user);
}

/** Test seam (kept for callers; nothing is cached in process any more). */
export function __resetViewModeCacheForTests(): void {
  /* no in-process cache */
}

/**
 * Instance-wide web-search provider configuration (ticket 6f4d42f2).
 *
 * On a self-hosted / Digby Edge instance there was NO way for an admin to
 * supply Bright Data credentials — the installer's env file is the only input
 * surface, and the edge installer never asks for them, so search_engine /
 * web_pipe / scrape tools failed outright with generic unreachable errors.
 * This service is the admin-settable store behind Admin → Settings → Web
 * search: a Bright Data API key (+ zone name), stored encrypted, resolved by
 * the search backend with env vars STILL TAKING PRECEDENCE when present
 * (backwards compatible with the cloud deploy, which configures the key via
 * docker env).
 *
 * Security model (mirrors coding/credentials.service.ts, per the ticket):
 *  - apiKeyEnc is AES-256-GCM at rest via the credentials.service helpers
 *    (key derived from JWT_SECRET) and is NEVER returned by any API response —
 *    the status read carries a masked preview (last 4 chars) only.
 *  - The zone is a NAME (web_unlocker1), not a secret — it is returned as-is.
 *  - provider is a slug ('brightdata' v1) so a second search provider can be
 *    added later without a migration.
 *
 * Resolution contract (pinned by search-provider-config.6f4d42f2.test.ts):
 *   resolveStoreBrightDataCredentials() — STORE-ONLY (the caller,
 *   brightdata-direct.ts, owns the env-first check so the env contract stays
 *   in one place). Best-effort: a DB error or an unreadable row resolves null
 *   (never throws — a broken store must not take down search on an instance
 *   whose creds come from env, because env is checked before this runs).
 *   resolveSearchCredentials() — the composite (env → store) the status read
 *   and the tests pin the ORDER on.
 *
 * Cache: the store read is cached in-process for 30 s (the model-endpoints
 * run-path-cache idiom — a coding/chat run hits the DB at most twice a
 * minute; mutations from THIS process clear it immediately, another worker's
 * converge within the TTL).
 */

import logger from '../../../utils/logger';
import { recordSearchConfigState } from './search-config-state';
import { noteWebSearchStoreArmed } from './instance-setup';

// BOTH heavy imports are LAZY (dynamic, cached): this service is reached from
// the search tier via dynamic import (brightdata-direct's credential
// resolution + mcp-search's pre-flight), and jest suites on that path mock
// axios/logger only. credentials.service statically imports config/database
// whose module load runs env validation → process.exit(1) on invalid env —
// an UNCATCHABLE exit that kills the jest worker. Keeping this module's load
// inert + the DATABASE_URL guard below means the store leg degrades to "no
// store creds" (never a crash) exactly like a DB outage; env-configured
// instances keep searching.
type CredentialsModule = typeof import('../coding/credentials.service');
let _credentials: CredentialsModule | null = null;
async function credentials(): Promise<CredentialsModule> {
  if (!_credentials) _credentials = await import('../coding/credentials.service');
  return _credentials;
}

type PrismaLike = NonNullable<typeof import('../../../config/database')['default']> extends infer T ? T : never;
let _prisma: PrismaLike | null = null;
async function db(): Promise<PrismaLike> {
  if (!_prisma) {
    _prisma = (await import('../../../config/database')).default;
  }
  return _prisma;
}

/** The one provider v1 knows: Bright Data (SERP + web unlocker). */
export const SEARCH_PROVIDER_BRIGHTDATA = 'brightdata';
/** Default Bright Data zone when neither env nor the store names one. */
export const DEFAULT_UNLOCKER_ZONE = 'web_unlocker1';

const CACHE_TTL_MS = 30_000;
const MAX_API_KEY_LEN = 512;
const MAX_ZONE_LEN = 64;
const ZONE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface StoreSearchCreds {
  token: string;
  zone: string | null;
}

export interface ResolvedSearchCreds {
  token: string;
  zone: string;
  /** 'env' = BRIGHTDATA_API_TOKEN (store ignored for the key) · 'store' = admin-set. */
  source: 'env' | 'store';
}

/** What Admin → Settings → Web search shows. NEVER carries the key itself. */
export interface WebSearchConfigStatus {
  provider: string;
  /** True when the store row exists (a key was saved), whether or not it is usable. */
  storeConfigured: boolean;
  /** False when the admin disabled the stored key (env creds are unaffected). */
  storeEnabled: boolean;
  /** True when the stored key no longer decrypts (JWT_SECRET rotated) — re-enter it. */
  storeReadable: boolean;
  /** Masked preview of the STORED key only ('••••1234'); null when none. The env key is the operator's own env — not echoed. */
  storePreview: string | null;
  zone: string | null;
  enabled: boolean;
  /** What the search backend resolves RIGHT NOW: 'env' | 'store' | null (not configured). */
  source: 'env' | 'store' | null;
  /** True when BRIGHTDATA_API_TOKEN is set in this process (store key ignored — precedence). */
  envPrecedence: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

// ── Store resolution (cached) ────────────────────────────────────────────────

interface StoreCache { at: number; value: StoreSearchCreds | null }
let _storeCache: StoreCache | null = null;

/** Clear the store-resolution cache (save path + tests). */
export function __clearSearchCredsCache(): void {
  _storeCache = null;
}

/**
 * The STORED Bright Data credentials, or null when none are usable (no row,
 * disabled, or unreadable after a JWT_SECRET rotation). Never throws — a DB
 * outage must degrade to "no store creds", and the env-first caller keeps
 * env-configured instances searching.
 */
export async function resolveStoreBrightDataCredentials(): Promise<StoreSearchCreds | null> {
  const now = Date.now();
  if (_storeCache && now - _storeCache.at < CACHE_TTL_MS) { noteWebSearchStoreArmed(!!_storeCache.value); return _storeCache.value; }
  let value: StoreSearchCreds | null = null;
  try {
    // No DB configured in this process (jest suites, broken env) = no store.
    if (!process.env.DATABASE_URL) { _storeCache = { at: now, value: null }; return null; }
    const [prisma, cred] = await Promise.all([db(), credentials()]);
    const row = await prisma.searchProviderConfig.findUnique({
      where: { provider: SEARCH_PROVIDER_BRIGHTDATA },
    });
    if (row && row.enabled) {
      try {
        const token = cred.decryptValue(row.apiKeyEnc);
        if (token.trim()) value = { token, zone: row.zone ? row.zone : null };
      } catch {
        // JWT_SECRET rotated since the key was saved — unreadable, resolve null.
        logger.warn('web-search config: stored Bright Data key no longer decrypts (JWT_SECRET rotated?) — re-enter it in Admin → Settings → Web search', { source: 'search-provider-config' });
      }
    }
  } catch (err: any) {
    // Best-effort store: a DB error is NOT "no credentials configured" for the
    // resolution contract — but it IS the only answer we can give. Callers
    // treat env as checked-first, so only store-only instances see this.
    logger.warn(`web-search config: store read failed — ${err?.message || err}`, { source: 'search-provider-config' });
  }
  _storeCache = { at: now, value };
  // The instance-setup leaf (Admin → Setup, the Integrations / Feeds tabs, the
  // model-facing "not configured" texts) reads env only — tell it what the
  // store resolved so a store-armed instance never reads as "not set up".
  noteWebSearchStoreArmed(!!value);
  return value;
}

let _primer: NodeJS.Timeout | null = null;
/**
 * Keep the leaf's store note fresh in THIS process (self-host setup hardening,
 * 2026-10-20): resolve the admin-store key now and every CACHE_TTL_MS, so the
 * feed sweep, the news scheduler and the setup checklist agree with the
 * search tier before any search has run. A process with the env token never
 * polls (env wins — production is untouched); never throws; the timer never
 * keeps the process alive.
 */
export function startWebSearchStorePrimer(): void {
  if ((process.env.BRIGHTDATA_API_TOKEN || '').trim()) { noteWebSearchStoreArmed(null); return; }
  if (_primer) return;
  const tick = () => { void resolveStoreBrightDataCredentials().catch(() => {}); };
  tick();
  _primer = setInterval(tick, CACHE_TTL_MS);
  _primer.unref?.();
}

/** Test seam. */
export function __stopWebSearchStorePrimer(): void {
  if (_primer) { clearInterval(_primer); _primer = null; }
}

/**
 * The composite resolution the search tier + status read use: env token first
 * (cloud-deploy backwards compatibility — the store can NEVER override env),
 * then the admin store. Null = this instance has no Bright Data credential.
 */
export async function resolveSearchCredentials(): Promise<ResolvedSearchCreds | null> {
  const envToken = (process.env.BRIGHTDATA_API_TOKEN || '').trim();
  if (envToken) {
    return { token: envToken, zone: envUnlockerZone(), source: 'env' };
  }
  const store = await resolveStoreBrightDataCredentials();
  if (store) {
    return { token: store.token, zone: envUnlockerZone() || store.zone || DEFAULT_UNLOCKER_ZONE, source: 'store' };
  }
  return null;
}

/** The env zone name, or '' when unset (env ZONE precedence over the store zone is preserved). */
function envUnlockerZone(): string {
  return (process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE || '').trim();
}

// ── Status read (admin) ──────────────────────────────────────────────────────

const mask = (v: string) => `••••${v.length > 4 ? v.slice(-4) : ''}`;

/** The Admin → Settings → Web search status. Never returns the key. */
export async function getWebSearchConfigStatus(): Promise<WebSearchConfigStatus> {
  const resolved = await resolveSearchCredentials();
  const row = await (async () => {
    try {
      if (!process.env.DATABASE_URL) return null;
      const prisma = await db();
      return await prisma.searchProviderConfig.findUnique({ where: { provider: SEARCH_PROVIDER_BRIGHTDATA } });
    } catch { return null; }
  })();
  const storePreview = row ? await (async () => {
    try { return mask((await credentials()).decryptValue(row.apiKeyEnc)); } catch { return null; }
  })() : null;
  return {
    provider: SEARCH_PROVIDER_BRIGHTDATA,
    storeConfigured: !!row,
    storeEnabled: !!row?.enabled,
    storeReadable: !!row && storePreview !== null,
    storePreview,
    zone: row?.zone ?? null,
    enabled: row ? row.enabled : false,
    source: resolved ? resolved.source : null,
    envPrecedence: !!(process.env.BRIGHTDATA_API_TOKEN || '').trim(),
    updatedAt: row ? row.updatedAt.toISOString() : null,
    updatedBy: row?.updatedBy ?? null,
  };
}

// ── Save (admin) ─────────────────────────────────────────────────────────────

export interface SaveWebSearchConfigInput {
  /** The Bright Data API key. Optional when only zone/enabled change. Never echoed back. */
  apiKey?: string;
  /** Zone name (e.g. web_unlocker1). Empty string clears it (default applies). */
  zone?: string;
  /** Enable/disable the stored key (env creds unaffected). */
  enabled?: boolean;
  /** Delete the stored configuration entirely. */
  clear?: boolean;
}

/**
 * Save (or clear) the stored Bright Data configuration. Throws Error with an
 * operator-actionable message on validation failures (the route maps it to a
 * 400). After a save the resolver cache is cleared, so the next search uses
 * the new key immediately in THIS process (workers converge within the TTL).
 */
export async function saveWebSearchConfig(
  input: SaveWebSearchConfigInput,
  updatedBy: string,
): Promise<WebSearchConfigStatus> {
  const by = String(updatedBy || 'admin').slice(0, 120);
  if (input.clear) {
    const prisma = await db();
    await prisma.searchProviderConfig.deleteMany({ where: { provider: SEARCH_PROVIDER_BRIGHTDATA } });
    __clearSearchCredsCache();
    logger.info(`web-search config: Bright Data configuration cleared (by ${by})`, { source: 'search-provider-config' });
    return getWebSearchConfigStatus();
  }

  let apiKeyEnc: string | undefined;
  if (input.apiKey !== undefined) {
    const key = String(input.apiKey).trim();
    if (!key) throw new Error('apiKey must not be empty (use clear to remove the configuration).');
    if (key.length > MAX_API_KEY_LEN) throw new Error(`apiKey too long (max ${MAX_API_KEY_LEN} chars).`);
    if (/[\n\r\0]/.test(key)) throw new Error('apiKey must be a single line.');
    apiKeyEnc = (await credentials()).encryptValue(key);
  }

  let zone: string | null | undefined;
  if (input.zone !== undefined) {
    const z = String(input.zone).trim();
    if (z === '') zone = null;
    else if (z.length > MAX_ZONE_LEN || !ZONE_RE.test(z)) {
      throw new Error(`zone must be 1-${MAX_ZONE_LEN} chars of letters, digits, dots, dashes or underscores (got "${z.slice(0, 40)}").`);
    } else zone = z;
  }

  const prisma = await db();
  const existing = await prisma.searchProviderConfig.findUnique({ where: { provider: SEARCH_PROVIDER_BRIGHTDATA } });
  if (!existing && apiKeyEnc === undefined) {
    throw new Error('No stored key to update — provide apiKey (the key is required the first time).');
  }
  if (existing) {
    await prisma.searchProviderConfig.update({
      where: { provider: SEARCH_PROVIDER_BRIGHTDATA },
      data: {
        ...(apiKeyEnc !== undefined ? { apiKeyEnc } : {}),
        ...(zone !== undefined ? { zone } : {}),
        ...(input.enabled !== undefined ? { enabled: !!input.enabled } : {}),
        updatedBy: by,
      },
    });
  } else {
    await prisma.searchProviderConfig.create({
      data: {
        provider: SEARCH_PROVIDER_BRIGHTDATA,
        apiKeyEnc: apiKeyEnc as string,
        zone: zone ?? null,
        enabled: input.enabled === undefined ? true : !!input.enabled,
        updatedBy: by,
      },
    });
  }
  __clearSearchCredsCache();
  // Keep the not-configured state leaf honest in THIS process: a fresh save
  // means the backend IS armed now (workers converge via the resolver cache).
  recordSearchConfigState({ at: Date.now(), anyBackendArmed: true });
  logger.info(`web-search config: Bright Data ${apiKeyEnc !== undefined ? 'key saved' : 'configuration updated'} (by ${by})`, { source: 'search-provider-config' });
  return getWebSearchConfigStatus();
}

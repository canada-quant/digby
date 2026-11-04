/**
 * Deploy health — ONE live https probe of the public site, shared by the REST
 * admin job-health endpoint (crossmodel.controller.ts getAdminJobHealth) and
 * the `get_fleet_telemetry` views 'jobHealth' + 'deploy' (fleet-telemetry.ts).
 *
 * Why (WI-M, 2026-09-25): the REST endpoint carried an inline probe
 * (frontend GET + backend GET → healthy / degraded / down) that the supervisor's
 * tool twin could not reach — view 'jobHealth' answered with a note pointing
 * at other views. Both surfaces now call `probeDeployHealth()` so the
 * supervisor and the admin page can never disagree about the same probe.
 *
 * Bounds: two GETs with an 8 s socket timeout each, run in parallel; the
 * result is cached in-process for DEPLOY_HEALTH_CACHE_MS (60 s) so a burst of
 * telemetry reads costs one probe. Read-only, never throws (a transport
 * failure reads as code 0 → 'down'/'degraded').
 *
 * Kill switch: DEPLOY_HEALTH_PROBE_DISABLED=1 skips the outbound https call
 * entirely (self-hosted edges with no route to digby.example.com) — the probe answers
 * status 'skipped' and the callers keep the rest of their picture.
 * DEPLOY_HEALTH_PROBE_BASE_URL overrides the probed origin (a PRODUCTION
 * instance defaults to https://digby.example.com — a NON-prod instance has NO default
 * and probes its own SELFHOST_PUBLIC_URL or answers 'skipped'; the backend leg appends /api/health, the backend's own
 * health route (app.ts) — 200 means db+redis connected, 503 means the process
 * is up but unhealthy. Healthy therefore REQUIRES backend 200. The previous
 * leg, /api/auth/login, is a POST-only route: a GET answered 404, which proved
 * only that something routed the request — a backend with db or redis down
 * still read 'healthy' (live-verified 2026-10-08: GET /api/auth/login → 404
 * while GET /api/health → 200 {db:'connected',redis:'connected'}).
 */
import https from 'https';
import http from 'http';

export const DEPLOY_HEALTH_CACHE_MS = 60_000;
export const DEPLOY_HEALTH_PROBE_TIMEOUT_MS = 8_000;
export const DEPLOY_HEALTH_DEFAULT_BASE_URL = 'https://digby.example.com';

export type DeployHealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown' | 'skipped';

export interface DeployHealth {
  status: DeployHealthStatus;
  checkedAt: string;
  /** HTTP status of GET <base>/ (0 = transport failure / timeout). Absent when skipped. */
  frontendCode?: number;
  /** HTTP status of GET <base>/api/health — 200 = backend healthy (db+redis connected), 503 = up-but-unhealthy, 0 = transport failure / timeout. Absent when skipped. */
  backendCode?: number;
  /** The origin that was probed (absent when skipped). */
  baseUrl?: string;
  /** true when this answer came from the in-process cache (age ≤ DEPLOY_HEALTH_CACHE_MS). */
  cached?: boolean;
  /** Present only when the probe was skipped by the kill switch. */
  reason?: string;
}

export interface ProbeDeployHealthOpts {
  now?: Date;
  /** Injected GET seam (tests): resolves to the HTTP status code, 0 on transport failure. */
  check?: (url: string) => Promise<number>;
  /** Bypass the in-process cache for this call. */
  fresh?: boolean;
}

export const isDeployHealthProbeDisabled = (): boolean => process.env.DEPLOY_HEALTH_PROBE_DISABLED === '1';

/**
 * The deploy-health probe origin. MAY RETURN '' on a non-prod instance with
 * neither DEPLOY_HEALTH_PROBE_BASE_URL nor SELFHOST_PUBLIC_URL set — that is
 * the isolation boundary's designed answer ("nothing to probe": probeDeployHealth
 * returns status 'skipped', never a digby.example.com fallback). Production keeps the
 * historical https://digby.example.com default; DEPLOY_HEALTH_PROBE_BASE_URL always wins.
 */

// Instance isolation boundary (ticket c75b5f34) — import-free leaf.
import { isProdInstance } from '../platform/instance-targets';

export function deployHealthBaseUrl(): string {
  const raw = String(process.env.DEPLOY_HEALTH_PROBE_BASE_URL || '').trim();
  if (raw) return raw.replace(/\/+$/, '');
  // Isolation boundary (c75b5f34): a NON-PROD instance never probes the
  // production site — its own public URL (SELFHOST_PUBLIC_URL, forwarded by
  // docker-compose.selfhost.yml) is the probe target; with neither set there
  // is nothing to probe and probeDeployHealth answers 'skipped'.
  if (!isProdInstance()) {
    const own = String(process.env.SELFHOST_PUBLIC_URL || '').trim();
    return own ? own.replace(/\/+$/, '') : '';
  }
  return DEPLOY_HEALTH_DEFAULT_BASE_URL;
}

/** The original controller probe, verbatim: status code or 0, never a rejection. */
export function httpStatusOf(url: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      // c75b5f34 follow-up (cross-family review finding 2): a self-hosted
      // instance's own probe target is its SELFHOST_PUBLIC_URL — plain http://
      // by default (Caddy on :8080, no TLS until the operator adds a domain).
      // The unconditional https.get read every http:// URL as code 0 ('down')
      // — the probe could never be healthy on the documented default. Split
      // on the scheme; anything but http(s):// still resolves 0 (never throws).
      const getter = url.startsWith('http://') ? http.get : https.get;
      const q = getter(url, { timeout: DEPLOY_HEALTH_PROBE_TIMEOUT_MS }, (rs) => { resolve(rs.statusCode || 0); rs.resume(); });
      q.on('error', () => resolve(0));
      q.on('timeout', () => { q.destroy(); resolve(0); });
    } catch { resolve(0); }
  });
}

/**
 * Pure classification shared by both surfaces. Healthy REQUIRES backend 200:
 * /api/health answers 503 when db or redis is down (app.ts isHealthy), and an
 * up-but-unhealthy backend must read degraded, not healthy. (The original rule
 * counted any non-5xx as backend-up proof — satisfiable by a fall-through 404
 * from anything at the edge, and by the POST-only login route's GET-404.)
 */
export function classifyDeployHealth(frontendCode: number, backendCode: number): DeployHealthStatus {
  if (frontendCode === 200 && backendCode === 200) return 'healthy';
  if (frontendCode === 200 || backendCode > 0) return 'degraded';
  return 'down';
}

let cache: { at: number; value: DeployHealth } | null = null;

/** Test seam: forget the cached probe. */
export function resetDeployHealthCache(): void { cache = null; }

export async function probeDeployHealth(opts: ProbeDeployHealthOpts = {}): Promise<DeployHealth> {
  const now = opts.now ?? new Date();
  const checkedAt = now.toISOString();
  if (isDeployHealthProbeDisabled()) {
    return { status: 'skipped', checkedAt, reason: 'DEPLOY_HEALTH_PROBE_DISABLED=1 — the outbound https probe is off on this instance' };
  }
  const baseUrl = deployHealthBaseUrl();
  // Isolation boundary (c75b5f34): a non-prod instance with no probe target
  // (neither DEPLOY_HEALTH_PROBE_BASE_URL nor SELFHOST_PUBLIC_URL) probes
  // NOTHING — never the production site by default.
  if (!baseUrl) {
    return { status: 'skipped', checkedAt, reason: 'no deploy-health probe target on this instance (isolation boundary — DIGBY_INSTANCE is not prod and neither DEPLOY_HEALTH_PROBE_BASE_URL nor SELFHOST_PUBLIC_URL is set; the production default is never used here)' };
  }
  if (!opts.fresh && cache && now.getTime() - cache.at <= DEPLOY_HEALTH_CACHE_MS && now.getTime() >= cache.at) {
    return { ...cache.value, cached: true };
  }
  const check = opts.check ?? httpStatusOf;
  let value: DeployHealth = { status: 'unknown', checkedAt, baseUrl };
  try {
    const [frontendCode, backendCode] = await Promise.all([check(`${baseUrl}/`), check(`${baseUrl}/api/health`)]);
    value = { status: classifyDeployHealth(frontendCode, backendCode), checkedAt, frontendCode, backendCode, baseUrl };
  } catch { /* unknown — never throws */ }
  cache = { at: now.getTime(), value };
  return { ...value, cached: false };
}

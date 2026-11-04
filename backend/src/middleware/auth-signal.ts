/**
 * Compensating attack signal for the warn-level JWT taxonomy (PR #176 follow-up).
 *
 * TokenExpiredError and JsonWebTokenError both log at warn so routine client
 * churn can't flood app_error_logs (one stuck client's expired token produced
 * ~3.5k error rows/48h — 44% of all error volume, 2026-08-08). But
 * JsonWebTokenError is also the exact fingerprint of forged/tampered tokens
 * (invalid signature, malformed JWT), and the ops scanners (auto-fix triage,
 * nightly telemetry) read level='error' only — so the demotion alone made a
 * sustained forgery campaign invisible to every automated scanner.
 *
 * This module keeps the per-request warn AND counts invalid-token failures per
 * source IP in Redis (1h TTL). When one IP crosses the spike threshold within
 * the window it emits exactly ONE error-level line (the counter passes the
 * threshold once per TTL window), so floods surface on the error-level radar
 * without re-opening the per-request flood.
 *
 * 2026-10-14 (FO retune, Fleet-Supervisor disposition): req.ip de-ALBs only one
 * hop (`trust proxy 1`), so ALL external traffic funnels through the two ALB AZ
 * node IPs — and the post-credential-rotation dead-token retry class (~100-120
 * already-rotated-out tokens/hour through exactly those two IPs, 401s correctly
 * returned, zero user impact) crossed the 30/60min threshold every hour and
 * re-flagged. That steady class is ACCEPTED BASELINE: baseline IPs (default
 * {"10.0.0.1","10.0.0.2"}, override via AUTH_SIGNAL_BASELINE_IPS —
 * comma-separated; empty/whitespace means UNSET (docker-compose `${VAR:-}`
 * passes '' for a host-unset var — reading that as "none" neutered the
 * retune fleet-wide on 2026-10-14), the explicit token 'none' = NO baseline
 * IPs) fire their ONE error line
 * only at a high tripwire, AUTH_SIGNAL_BASELINE_SPIKE_THRESHOLD (integer,
 * default 300; NaN/garbage → 300), while their Redis counter, TTL and
 * caller-sample store run exactly as before (monitoring loses nothing). Any
 * NON-baseline IP ("third IP") keeps the original INVALID_TOKEN_SPIKE_THRESHOLD
 * (30). Kill switch: AUTH_SIGNAL_BASELINE_DISABLED=1 treats every IP as
 * non-baseline (full pre-retune behavior). The tripwire line keeps the
 * byte-identical "Invalid-signature JWT spike:" prefix + caller= render, with
 * a "(baseline-IP tripwire)" marker appended.
 */

import { decode as decodeJwt } from 'jsonwebtoken';
import { Request } from 'express';
import logger from '../utils/logger';
import { peelClientIp } from './client-ip';

const WINDOW_SECONDS = 3600;
export const INVALID_TOKEN_SPIKE_THRESHOLD = 30;

/** Default baseline class: the two ALB AZ node IPs all external traffic funnels through. */
const DEFAULT_BASELINE_IPS = ['10.0.0.1', '10.0.0.2'] as const;
const DEFAULT_BASELINE_SPIKE_THRESHOLD = 300;

/**
 * The baseline-IP set (FO retune, 2026-10-14; empty-env fix same day — the
 * docker-compose `${VAR:-}` pass-through hands containers an EMPTY string when
 * the host env leaves the var unset, and reading that as "no baseline IPs"
 * silently neutered the retune on every box). AUTH_SIGNAL_BASELINE_IPS is a
 * comma-separated override; empty/whitespace = UNSET (the default ALB-node
 * pair); the explicit token 'none' = NO baseline IPs. Never throws.
 */
function resolveBaselineIps(): ReadonlySet<string> {
  const raw = process.env.AUTH_SIGNAL_BASELINE_IPS;
  if (raw === undefined || raw.trim() === '') return new Set(DEFAULT_BASELINE_IPS);
  if (raw.trim().toLowerCase() === 'none') return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * The baseline-IP tripwire (FO retune, 2026-10-14). NaN/garbage (or a
 * non-positive value, which could never fire sanely) falls back to 300.
 */
function resolveBaselineSpikeThreshold(): number {
  const n = parseInt(process.env.AUTH_SIGNAL_BASELINE_SPIKE_THRESHOLD || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BASELINE_SPIKE_THRESHOLD;
}

/**
 * Caller fingerprint for a spike line (FO caller-identification, 2026-10-13;
 * hops-anchored 2026-10-18, todo ead881f4). req.ip de-ALBs only ONE hop
 * (app.ts sets `trust proxy 1` on the ALB → nginx → Express chain), so an
 * external caller's spike `ip=` is an ALB AZ NODE, not the client — the
 * discriminating evidence is the hops-anchored X-Forwarded-For client
 * (peelClientIp — the same derivation the login-failure attribution uses; the
 * client-writable FIRST hop was the pre-fix read), the request path, the
 * user-agent, and the dead token's subject.
 * The subject is decoded WITHOUT verification: an invalid-signature token's
 * claims are identification hints only, never trusted, and never the raw
 * token. The query string is NEVER kept (the SSE stream carries ?token=<jwt>
 * — the path alone names the surface). All fields capped so the one-per-hour
 * error line stays small.
 */
export interface InvalidTokenSample {
  path?: string;
  method?: string;
  userAgent?: string;
  clientIp?: string;
  subject?: string;
}

const SAMPLE_CAP = { path: 160, method: 12, userAgent: 160, clientIp: 80, subject: 64 } as const;
const capField = (v: string, n: number): string => (v.length > n ? v.slice(0, n) : v);

export function buildInvalidTokenSample(
  req: { method?: string; originalUrl?: string; url?: string; headers?: Record<string, unknown> },
  token?: string,
): InvalidTokenSample {
  const sample: InvalidTokenSample = {};
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (path) sample.path = capField(path, SAMPLE_CAP.path);
  if (req.method) sample.method = capField(String(req.method).toUpperCase(), SAMPLE_CAP.method);
  const ua = req.headers?.['user-agent'];
  if (typeof ua === 'string' && ua) sample.userAgent = capField(ua, SAMPLE_CAP.userAgent);
  // Hops-anchored client IP (todo ead881f4, 2026-10-18): the FIRST hop of
  // X-Forwarded-For is client-writable — a forged token prober can prepend any
  // IP it likes and steer this identification field, and behind the ALB →
  // nginx → Express chain the honest first hop is only the client when the
  // chain is exactly the right length. The derivation lives in client-ip.ts
  // (peelClientIp) and anchors `hops` from the RIGHT of the chain — the same
  // position the login-failure attribution uses — so both auth surfaces name
  // the same client and a forged PREPENDED hop cannot move it. Unset hop
  // count / short chain / private candidate ⇒ the field is omitted (the
  // sample keeps path/method/UA/subject identification).
  const clientIp = peelClientIp(req as Pick<Request, 'ip' | 'headers' | 'socket'>);
  if (clientIp) sample.clientIp = capField(clientIp, SAMPLE_CAP.clientIp);
  if (token) {
    try {
      const payload = decodeJwt(token) as { userId?: unknown; sub?: unknown } | null;
      const sub =
        typeof payload?.userId === 'string' ? payload.userId : typeof payload?.sub === 'string' ? payload.sub : '';
      if (sub) sample.subject = capField(sub, SAMPLE_CAP.subject);
    } catch {
      /* a malformed token decodes to nothing — path/UA/XFF still identify */
    }
  }
  return sample;
}

/**
 * A DEAD token (2026-10-19): one whose own `exp` claim is already in the
 * past. After the 2026-10-12 JWT-secret rotation every token a stale browser
 * still holds fails signature verification FIRST (JsonWebTokenError, not
 * TokenExpiredError), so the stale-session class looked exactly like
 * forgery: a warn per window plus an hourly "Invalid-signature JWT spike"
 * error through the ALB node IPs. A token past its expiry grants nothing even
 * with a valid signature, so presenting one is never a meaningful probe — it
 * is a stale session (handled), not an attack signal. Decoded WITHOUT
 * verification (claims are hints, never trusted). Kill switch:
 * AUTH_DEAD_TOKEN_STALE_DISABLED=1 (every invalid signature is suspect again).
 */
export function isDeadTokenShape(token: string | undefined, now: number = Date.now()): boolean {
  if (!token || process.env.AUTH_DEAD_TOKEN_STALE_DISABLED === '1') return false;
  try {
    const payload = decodeJwt(token) as { exp?: unknown } | null;
    const exp = typeof payload?.exp === 'number' ? payload.exp : NaN;
    return Number.isFinite(exp) && exp * 1000 < now;
  } catch {
    return false;
  }
}

/**
 * Record one JsonWebTokenError 401 (NOT TokenExpiredError — expiry is genuinely
 * routine). Fire-and-forget: never throws, never blocks the 401 response.
 * When a caller `sample` is given it is stored (latest-wins, same TTL as the
 * counter) and rendered into the ONE threshold-crossing error line, so the
 * error-level row names the caller behind the ALB node IPs. Kill switch:
 * AUTH_SIGNAL_SAMPLE_DISABLED=1 skips the store and the render. Baseline IPs
 * (see the module header) fire their ONE line at the high tripwire instead of
 * INVALID_TOKEN_SPIKE_THRESHOLD — counting/storage are identical for every IP.
 */
export function recordInvalidTokenSignal(ip: string | undefined, source: string, sample?: InvalidTokenSample): void {
  void (async () => {
    try {
      // Lazy import: config/redis drags in config/env (which hard-exits without
      // env vars), and the auth middleware must stay importable in
      // dependency-free tests.
      const { default: redis } = await import('../config/redis');
      const key = `auth:invalid_token:${ip || 'unknown'}`;
      const sampleOn = process.env.AUTH_SIGNAL_SAMPLE_DISABLED !== '1';
      if (sample && sampleOn) {
        const rendered = JSON.stringify(sample);
        if (rendered !== '{}') {
          await redis.set(`${key}:sample`, rendered, { EX: WINDOW_SECONDS }).catch(() => undefined);
        }
      }
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, WINDOW_SECONDS);
      // Baseline-IP class (FO retune, 2026-10-14): the counter/TTL/sample above
      // run for EVERY IP exactly as before; only the error-line threshold moves.
      const baselineOn = process.env.AUTH_SIGNAL_BASELINE_DISABLED !== '1';
      const isBaseline = baselineOn && resolveBaselineIps().has(ip || 'unknown');
      const threshold = isBaseline ? resolveBaselineSpikeThreshold() : INVALID_TOKEN_SPIKE_THRESHOLD;
      if (count === threshold) {
        let caller = '';
        if (sampleOn) {
          const raw = await redis.get(`${key}:sample`).catch(() => null);
          if (raw) caller = ` caller=${raw}`;
        }
        logger.error(
          `Invalid-signature JWT spike: ${count} JsonWebTokenError 401s from ip=${ip || 'unknown'} ` +
          `within ${WINDOW_SECONDS / 60}min (${source}) — possible forged/tampered token probing` +
          `${isBaseline ? ' (baseline-IP tripwire)' : ''}${caller}`,
        );
      }
    } catch {
      /* the signal must never break or slow the auth path */
    }
  })();
}

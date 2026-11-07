import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { ZodError } from 'zod';
import logger from '../utils/logger';
import { logHandled } from '../utils/log-level';
import { buildInvalidTokenSample, recordInvalidTokenSignal } from './auth-signal';
import { peelClientIp } from './client-ip';
import { env } from '../config/env';
import { EncryptionKeyError } from '../modules/crossmodel/google/crypto';

// The hops-anchored client-IP derivation moved to its own leaf (client-ip.ts,
// todo ead881f4) so the JWT spike-sample path (auth-signal.ts) can share it —
// error-handler imports auth-signal, never the reverse. Re-exported here so
// existing imports of peelClientIp keep resolving.
export { peelClientIp };

// AppError lives in its own import-free leaf (2026-11-06, ea95fa0b leg 1) so a
// module that only needs the ERROR TYPE does not pull config/env into its import
// graph — env.ts runs its zod parse at module load and calls process.exit(1)
// when the vars are absent, which is the normal state in a hermetic jest run.
// That coupling killed 10 controller suites with "Jest worker encountered 4
// child process exceptions" the moment a new module imported the type from
// here. Re-exported so every existing import site is unchanged and the class
// IDENTITY (hence every `instanceof AppError`) is preserved.
import { AppError } from './app-error';
export { AppError };

/**
 * A query credential never belongs in a log row: the SSE stream takes
 * `?token=<jwt>` (EventSource cannot set headers) and the persisted
 * `context.url` of an error row used to carry the bearer verbatim. Pure.
 */
export function redactUrlForLog(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.replace(/([?&](?:token|access_token|refresh_token|refreshToken|api_key|apiKey)=)[^&#]*/gi, '$1[redacted]');
}

const LOGIN_PATH = /^\/api\/auth\/login(?:[/?#]|$)/;

/** POST /api/auth/login — the one route whose 401s are password guesses. */
export function isLoginAttempt(req: Pick<Request, 'method' | 'originalUrl' | 'url'>): boolean {
  if (String(req.method || '').toUpperCase() !== 'POST') return false;
  return LOGIN_PATH.test(String(req.originalUrl || req.url || ''));
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * The synthetic deploy-healthcheck probe's email hash (ticket 4a8fcbde):
 * sha256('healthcheck@test.com')[:16]. The GitHub workflow no longer POSTs
 * logins (it probes GET /api/health since 2026-10-18), but ANY stray probe
 * body that still hits /api/auth/login would otherwise re-arm the
 * auth_escalate_4h class — a liveness probe is not a password guess, so its
 * rows never belong in the auth-attack signal. Comparing the HASH (never the
 * address) keeps the middleware free of raw probe material.
 */
const PROBE_EMAIL_HASH = '0034506974bc51de';

/**
 * Login-failure attribution (PE-18): the row carries the client IP (req.ip —
 * honours `trust proxy`, so it is the caller behind the ALB, not the ALB) and a
 * HASH of the attempted email (never the address), so a brute-force burst from
 * one address is distinguishable from one confused user. Undefined when the
 * request is not a login.
 */
export function loginFailureMeta(req: Request): { ip: string | undefined; emailHash: string | undefined; clientIp: string | undefined } | undefined {
  if (!isLoginAttempt(req)) return undefined;
  const email = typeof (req as any).body?.email === 'string' ? String((req as any).body.email).trim().toLowerCase() : '';
  return { ip: req.ip || undefined, emailHash: email ? shortHash(email) : undefined, clientIp: peelClientIp(req) };
}

/** One loop_metrics row per failed login keyed by an ip hash (queryable spike
 *  signal). Dynamic import keeps this middleware import-light; never throws.
 *  The synthetic deploy-healthcheck probe (emailHash 0034506974bc51de) is
 *  SKIPPED — its 401s are a liveness signal, not password guessing (ticket
 *  4a8fcbde); see PROBE_EMAIL_HASH. */
function recordLoginFailure(meta: { ip: string | undefined; emailHash: string | undefined; clientIp?: string | undefined }): void {
  if (meta.emailHash === PROBE_EMAIL_HASH) return;
  void import('../modules/crossmodel/platform/loop-metrics.service')
    .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
      kind: LOOP_METRIC_KINDS.AUTH_LOGIN_FAILED,
      meta: {
        ipHash: meta.ip ? shortHash(meta.ip) : null,
        emailHash: meta.emailHash ?? null,
        ...(meta.clientIp ? { clientIpHash: shortHash(meta.clientIp) } : {}),
      },
    }))
    .catch(() => undefined);
}

/**
 * The stale-session class (handled, logged at info): an EXPIRED access token,
 * or a non-login 401 AppError (refresh token gone/expired, user deactivated).
 * Never a forged/malformed JWT (JsonWebTokenError) and never a failed login —
 * those can be attacks and stay warn. Pure.
 */
export function isStaleSessionError(err: Error, statusCode: number, isLogin: boolean): boolean {
  if (err.name === 'TokenExpiredError') return true;
  if (err.name === 'JsonWebTokenError') return false;
  return err instanceof AppError && statusCode === 401 && !isLogin;
}

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Express 5 forwards async rejections that happen AFTER a response is
  // committed (SSE streams flush headers early) — writing another status here
  // would throw ERR_HTTP_HEADERS_SENT inside the error middleware. Delegate to
  // the default finalizer, which tears the socket down cleanly.
  if (res.headersSent) return next(err);
  // Build rich context for the database error log. The logged status is the
  // status the CLIENT gets: a ZodError thrown inside a handler answers 400
  // below, so it is logged as 400 / warn (PE-04) — it used to read 500 / error.
  const userId = (req as any).user?.id || undefined;
  const isZod = err instanceof ZodError;
  const isEncryptionKeyError = err instanceof EncryptionKeyError;
  const statusCode = isZod ? 400 : err instanceof AppError ? err.statusCode : isEncryptionKeyError ? 503 : 500;
  const login = statusCode === 401 ? loginFailureMeta(req) : undefined;
  const logMeta = {
    message: err.message,
    stack: err.stack,
    url: redactUrlForLog(req.url),
    method: req.method,
    userId,
    statusCode,
    source: 'error-handler',
    ...(login ? { ip: login.ip, emailHash: login.emailHash } : {}),
  };

  // A STALE session is handled: an expired access token, or a refresh that
  // finds its token gone/expired or its user deactivated. The client is told
  // to sign in again, so it logs at info (logHandled) and the warn+ transport
  // never stores it — a stale browser token was ~46% of warn/error rows
  // (2026-10-17). Everything that can be an ATTACK stays warn: a forged or
  // malformed token (JsonWebTokenError — the forgery fingerprint) and a wrong
  // password on POST /api/auth/login. Validation (Zod 400) and permission
  // failures (403 and other non-401 4xx) stay warn too.
  const isJwtClientError = err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError';
  const isStaleSession = isStaleSessionError(err, statusCode, !!login);
  if ((err instanceof AppError && err.isOperational && statusCode >= 400 && statusCode < 500) || isJwtClientError || isZod) {
    if (isStaleSession) logHandled('Client error:', logMeta);
    else logger.warn('Client error:', logMeta);
    // Invalid-signature spike counter (see middleware/auth-signal.ts) — expiry
    // is routine, but forged/tampered tokens must stay visible at volume.
    if (err.name === 'JsonWebTokenError') recordInvalidTokenSignal(req.ip, 'error-handler', buildInvalidTokenSample(req));
    if (login) recordLoginFailure(login);
  } else {
    logger.error('Error:', logMeta);
  }

  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation error',
      // zod v4 renamed .errors → .issues (same array, same issue objects).
      details: err.issues,
    });
    return;
  }

  // Application errors
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
    });
    return;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  if (err.name === 'TokenExpiredError') {
    res.status(401).json({ error: 'Token expired' });
    return;
  }

  // Missing/malformed token-encryption key (ticket 387a5760): the message
  // names the env var and the operator fix — render it verbatim with 503
  // instead of the masked production "Internal server error".
  if (err instanceof EncryptionKeyError) {
    res.status(503).json({ error: err.message });
    return;
  }

  // Default error
  res.status(500).json({
    error: env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
};

export const notFound = (req: Request, res: Response): void => {
  res.status(404).json({
    error: `Route ${req.method} ${req.url} not found`,
  });
};

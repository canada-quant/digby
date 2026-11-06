/**
 * Client-error ingest (ticket d4e643a5, owner verbatim on ticket 81b229e1:
 * "also you should;d be capturing all these ui errors somewhere and auto filing
 * tickets without me telling you right?").
 *
 * THE GAP THIS CLOSES: `app_error_logs` was written by exactly one producer —
 * the backend winston Prisma transport (utils/logger.ts) — so the hourly
 * log-signal-sweep, which reads that table, was STRUCTURALLY unable to see a
 * client-side failure. A React render crash, a broken click handler or a
 * rejected promise reached the browser console and nothing else; the owner had
 * to notice it in a screenshot and file by hand.
 *
 * THE FIX REUSES THE EXISTING FILER rather than building a second one: this
 * handler persists the report through the SAME winston logger, which writes the
 * row to `app_error_logs` stamped `source: 'client-error'`. The existing hourly
 * log-signal-sweep then fingerprints it and auto-files a ticket under its
 * existing rules/caps/dedupe — there is deliberately NO second sweep here.
 *
 * Posture: PUBLIC + optionalAuthenticate (a crashing tab may be signed out, and
 * a crash inside the login flow has no token at all). Consequences, all
 * handled here rather than assumed away:
 *   - the payload is UNTRUSTED — everything is re-sanitized server-side
 *     (client-error-sanitize.ts: user text masked, credential shapes cut,
 *     every field capped) and the canonical backend secret scan runs on top;
 *   - it is an unbounded write surface — client-error-throttle.ts admits one
 *     row per signature per window with separate per-client and global
 *     per-minute budgets, so the same render-loop error 100× is ONE row;
 *   - it must never leak: the URL is reduced to origin+pathname (no query
 *     string, no fragment, no token), no cookies/headers/body are read, and
 *     nothing arrives back to the browser but a status code.
 *
 * Kill switch: CLIENT_ERROR_INGEST_DISABLED=1 ⇒ 204, nothing recorded.
 */
import { Request, Response, NextFunction } from 'express';
import express from 'express';
import logger from '../../../utils/logger';
import { hashedClientKey } from '../../../middleware/rate-limit-paths';
import { redactSecrets } from '../platform/secret-scan';
import { sanitizeClientError, type RawClientErrorInput } from './client-error-sanitize';
import { admitClientErrorReport, clientErrorIngestDisabled } from './client-error-throttle';

/** The `app_error_logs.source` stamp every persisted client report carries. */
export const CLIENT_ERROR_SOURCE = 'client-error';
/** The message prefix — keeps the sweep's fingerprint stable and greppable. */
export const CLIENT_ERROR_MESSAGE_PREFIX = 'client-error:';
/** Hard cap on the accepted JSON body (the global parser allows far more; this route does not need it). */
export const CLIENT_ERROR_MAX_BODY_BYTES = 16 * 1024;

/**
 * A SCOPED JSON parser for this route (adversarial review MINOR 6, 2026-11-06).
 *
 * app.ts mounts `express.json({ limit: '75mb' })` globally, so a hostile tab
 * could make the process BUFFER AND PARSE 75 MB before `clientErrorBodyTooLarge`
 * ever inspected `req.body` — 60 such requests per 10 min is the limiter's
 * budget, i.e. gigabytes of parse work for zero stored rows. A route-scoped
 * parser rejects the oversized body at the STREAM level, exactly like
 * `visitEventsBodyParser` does for POST /visit-events.
 *
 * `type: 'application/json'` (plus the sendBeacon text/plain shape a closing
 * tab produces) keeps the parser from swallowing other content types, so a
 * request that does not match still falls through to the global parser.
 */
export const clientErrorBodyParser = express.json({ limit: CLIENT_ERROR_MAX_BODY_BYTES, type: ['application/json', 'text/plain'] });

/** The `app_error_logs` context the row carries (bounded; never user content). */
export interface ClientErrorLogContext {
  source: string;
  clientSource: string;
  signature: string;
  occurrences: number;
  route?: string;
  url?: string;
  userAgent?: string;
  buildSha?: string;
  userId?: string;
  line?: number;
  column?: number;
}

/** True when the request body is over the route's cap (cheap pre-check before sanitizing). */
export function clientErrorBodyTooLarge(body: unknown, contentLength?: string): boolean {
  const declared = Number(contentLength ?? '');
  if (Number.isFinite(declared) && declared > CLIENT_ERROR_MAX_BODY_BYTES) return true;
  try {
    return JSON.stringify(body ?? null).length > CLIENT_ERROR_MAX_BODY_BYTES;
  } catch {
    return true;
  }
}

/**
 * Write one sanitized report through the EXISTING winston logger ⇒ one
 * `app_error_logs` row (PrismaErrorTransport, level warn+). Exported so the
 * test can assert the persisted shape without an HTTP round-trip.
 *
 * The OBJECT form is mandatory (utils/log-level.ts, log-signal family
 * 5ae52ca3): `logger.error(message, meta)` passes meta as a winston SPLAT
 * argument, and a browser error message is exactly the kind of string that
 * carries `%s` / `%d` / a literal `%` — splat would format the metadata object
 * INTO the message and destroy the context (source tag included). The object
 * form carries no splat args.
 */
export function recordClientError(input: RawClientErrorInput, userId?: string | null): ReturnType<typeof sanitizeClientError> {
  const clean = sanitizeClientError(input);
  // Second layer: the canonical backend secret set (provider keys, labelled
  // assignments, app passwords) — the browser-side and local scrubs know the
  // shapes a stack produces, this knows every shape the platform knows.
  const stacked = clean.stack ? redactSecrets(clean.stack).text : undefined;
  // FAIL-DIRECTION (adversarial review MINOR 7): never fall back to the RAW text.
  // If the canonical scrub ever returned an empty body the old `|| clean.message`
  // would have written the UNREDACTED message — the one path where a scrub
  // failure became a leak. An empty result drops the line instead.
  const message = redactSecrets(clean.message).text;
  if (!message) return clean;
  const context: ClientErrorLogContext = {
    source: CLIENT_ERROR_SOURCE,
    clientSource: clean.source,
    signature: clean.signature,
    occurrences: clean.occurrences,
    ...(clean.route ? { route: clean.route } : {}),
    ...(clean.url ? { url: clean.url } : {}),
    ...(clean.userAgent ? { userAgent: clean.userAgent } : {}),
    ...(clean.buildSha ? { buildSha: clean.buildSha } : {}),
    ...(userId ? { userId } : {}),
    ...(clean.line !== undefined ? { line: clean.line } : {}),
    ...(clean.column !== undefined ? { column: clean.column } : {}),
  };
  logger.log({
    level: 'error',
    message: `${CLIENT_ERROR_MESSAGE_PREFIX} ${message}`,
    ...(stacked ? { stack: stacked } : {}),
    ...context,
  });
  return clean;
}

export const clientErrorController = {
  /**
   * POST /api/crossmodel/client-error — 204 on accept/duplicate/throttle,
   * 413 over the body cap, 400 when the report carries nothing recordable.
   * Never echoes the payload back.
   */
  async report(req: Request, res: Response, next: NextFunction) {
    try {
      if (clientErrorIngestDisabled()) { res.status(204).end(); return; }
      if (clientErrorBodyTooLarge(req.body, req.headers['content-length'] as string | undefined)) {
        res.status(413).json({ error: 'Client error report too large.' });
        return;
      }
      const body = (req.body ?? {}) as RawClientErrorInput;
      const userId = (req as any).user?.id ?? null;
      // Sanitize FIRST: the throttle keys on the SANITIZED signature, so a
      // client cannot dodge dedupe by claiming a different `signature`.
      const clean = sanitizeClientError(body);
      if (!clean.message) { res.status(400).json({ error: 'message is required' }); return; }

      const verdict = admitClientErrorReport(clean.signature, hashedClientKey(req as any));
      if (!verdict.admit) {
        // Duplicate inside its window / over budget: accepted, nothing written.
        // 204 rather than an error — a crashing tab must never be pushed to retry.
        res.status(204).end();
        return;
      }
      recordClientError(body, userId);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
};

export default clientErrorController;
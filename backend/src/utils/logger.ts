import winston from 'winston';
import Transport from 'winston-transport';
import { env } from '../config/env';
import { redactUrlCredentialsDeep } from './redact-credentials';
import { ambientTelemetryRunId } from './run-telemetry-context';

// ── URL-credential scrub (backlog audit T7, 2026-09-28) ──────────────────────
// LAST line of defence before any transport: a git failure once carried
// `https://x-access-token:<token>@github.com/…` (execFile echoes the argv into
// err.message) through logger.warn into app_error_logs — 11 rows, two
// long-lived OAuth tokens. The git() wrapper scrubs at the source; this format
// masks the URL-userinfo shape in the message, the stack and every string leaf
// of the metadata for EVERY record, so a new caller that logs a raw error
// still cannot persist a token. Fail-open (a throw passes the record through).
// The record is scrubbed IN PLACE, key by key: winston keeps `level` /
// `message` under Symbol keys on the same object, and a rebuilt object would
// drop them (Object.entries walks string keys only) and silence the transports.
export const scrubCredentials = winston.format((info) => {
  try {
    for (const k of Object.keys(info)) {
      const v = (info as Record<string, unknown>)[k];
      const next = redactUrlCredentialsDeep(v);
      if (next !== v) (info as Record<string, unknown>)[k] = next;
    }
    return info;
  } catch {
    return info;
  }
});

// ── Chat-turn run attribution (audit 2026-10-06 T6-4, crosscutting X7) ────────
// A chat / supervisor turn has no agent_runs row, so a coding-tool failure or
// an agent-loop warn logged from inside it carried no runId. A record that
// names the turn's own sessionId and no runId takes the turn's minted
// telemetry run id (utils/run-telemetry-context). Fail-open; the kill switch
// CHAT_RUN_TELEMETRY_ID_DISABLED=1 is read inside ambientTelemetryRunId.
export const stampTelemetryRun = winston.format((info) => {
  try {
    const rec = info as Record<string, unknown>;
    if (rec.runId === undefined || rec.runId === null || rec.runId === '') {
      const id = ambientTelemetryRunId(rec.sessionId);
      if (id) rec.runId = id;
    }
  } catch { /* attribution never blocks a log line */ }
  return info;
});

// ── Database Transport ────────────────────────────────────────────────────────
// Persists error/warn logs to the app_error_logs table so they survive
// container restarts and are queryable via the admin API.
// Uses lazy-loaded Prisma to avoid circular imports at startup.

let _prisma: any = null;
function getPrisma() {
  if (!_prisma) {
    // Lazy import — database.ts may not be ready when logger.ts first loads
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _prisma = require('../config/database').default;
    } catch {
      return null;
    }
  }
  return _prisma;
}

/**
 * The app_error_logs `context` JSON from a record's metadata. An UNDEFINED value is skipped (audit 2026-10-06 T8-6,
 * crosscutting X6): JSON.stringify(undefined) is undefined, JSON.parse(undefined) threw, and the catch stored the
 * literal string "undefined" — every Fleet Supervisor tool-failure row carried context.runId = "undefined", so a
 * `context->>'runId' IS NULL` filter missed them. LOG_UNDEFINED_META_SKIP_DISABLED=1 restores the string.
 */
export function buildErrorLogContext(rest: Record<string, unknown>): Record<string, unknown> {
  const skipUndefined = process.env.LOG_UNDEFINED_META_SKIP_DISABLED !== '1';
  const context: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined && skipUndefined) continue;
    if (v instanceof Error) {
      context[k] = { message: v.message, stack: v.stack?.split('\n').slice(0, 3).join('\n') };
    } else {
      try { context[k] = JSON.parse(JSON.stringify(v)); } catch { context[k] = String(v); }
    }
  }
  return context;
}

class PrismaErrorTransport extends Transport {
  constructor(opts?: Transport.TransportStreamOptions) {
    super(opts);
  }

  log(info: any, callback: () => void) {
    setImmediate(() => this.emit('logged', info));

    const prisma = getPrisma();
    if (!prisma) { callback(); return; }

    const { level, message, timestamp, stack, service, ...rest } = info;

    // Build a safe context object from metadata
    const context = buildErrorLogContext(rest);

    // Determine source from context or stack
    const source = (context.source as string)
      || (typeof stack === 'string' && stack.match(/at\s+\S+\s+\(([^)]+)\)/)?.[1])
      || undefined;

    // Fire-and-forget — never block the main thread
    prisma.appErrorLog.create({
      data: {
        level: String(level).replace(/\u001b\[\d+m/g, ''), // strip ANSI color codes
        message: String(message).substring(0, 10000),
        stack: typeof stack === 'string' ? stack.substring(0, 10000) : undefined,
        context: Object.keys(context).length > 0 ? context : undefined,
        source: source ? String(source).substring(0, 255) : undefined,
      },
    }).catch(() => {
      // Silently ignore DB write failures — we don't want logging to crash the app.
      // The console transport still has the log.
    });

    callback();
  }
}

// ── Logger Setup ──────────────────────────────────────────────────────────────

const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    stampTelemetryRun(),
    scrubCredentials(),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'digby-api' },
  transports: [
    // Console transport — always active (Docker logs)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...metadata }) => {
          let msg = `${timestamp} [${level}]: ${message}`;
          if (Object.keys(metadata).length > 0) {
            try {
              msg += ` ${JSON.stringify(metadata)}`;
            } catch {
              // Axios errors / TLSSocket objects have circular refs — extract safe fields only
              const safe: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(metadata)) {
                if (v instanceof Error) {
                  safe[k] = { message: v.message, stack: v.stack?.split('\n')[0] };
                } else {
                  try { safe[k] = JSON.parse(JSON.stringify(v)); } catch { safe[k] = String(v); }
                }
              }
              try { msg += ` ${JSON.stringify(safe)}`; } catch { msg += ' [non-serializable metadata]'; }
            }
          }
          return msg;
        })
      ),
    }),

    // Database transport — persists error + warn to PostgreSQL
    new PrismaErrorTransport({ level: 'warn' }),
  ],
});

export default logger;

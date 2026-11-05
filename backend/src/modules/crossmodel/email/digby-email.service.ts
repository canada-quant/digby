/**
 * Digby email service (ticket 54f237bf) — send emails AS Digby from its own
 * address (digby@digby.ai), over SMTP.
 *
 * This is Digby's OWN sender identity — NOT the user's connected Gmail
 * (gmail_send_email, which sends from the user's account and is
 * human-attended-only). The whole point here is MACHINE capability: a
 * scheduled digest firing, a watchdog, or a lane must be able to send one
 * ("send me an email when X happens", "email me a daily digest of Y")
 * without a user turn.
 *
 * Transport: nodemailer against the Gmail workspace SMTP relay
 * (smtp.gmail.com:587 STARTTLS, user digby@digby.ai + an app password — the
 * OWNER provisions the app password; this module only reads env).
 *
 * Env config (ALL optional; without user+pass the service reports
 * notConfigured — every caller gets a clean, actionable result, never a
 * crash, never a hang):
 *   DIGBY_SMTP_HOST  (default smtp.gmail.com)
 *   DIGBY_SMTP_PORT  (default 587)
 *   DIGBY_SMTP_USER  (the mailbox, e.g. digby@digby.ai)
 *   DIGBY_SMTP_PASS  (the Gmail workspace app password)
 *   DIGBY_SMTP_FROM  (default digby@digby.ai — the From: address)
 *
 * Safety:
 *   - NEVER throws to the caller: every path returns {ok:true, messageId} or
 *     {ok:false, error}. A thrown error inside becomes an ok:false envelope.
 *   - Rate limit: an in-memory cap (default 30 sends/hour per instance) — a
 *     runaway agent loop must not blast people. Sliding window of send
 *     timestamps; resettable for tests.
 *   - No secrets in logs/metrics: the SMTP password is never logged, and
 *     metrics record only the recipient PREFIX (the local part before @,
 *     capped) + the recipient DOMAIN, mirroring gmail_send_email's
 *     recipient-privacy posture. Bodies are never logged or recorded.
 *   - Every attempt + outcome lands in loop_metrics (kind
 *     'digby_email_sent', LOOP_METRIC_KINDS.DIGBY_EMAIL_SENT).
 *
 * Import discipline (see account-tools.ts header): nodemailer is loaded via
 * DYNAMIC import inside sendDigbyEmail, so the static import graph stays
 * light and jest can mock the boundary. recordLoopMetric is a fire-and-
 * forget leaf (never throws, never blocks) — safe to import statically, the
 * same way fleet services use it.
 */

import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';

// ── Config (read lazily per call — test fixtures mutate process.env) ─────────

export interface DigbyEmailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export function digbyEmailConfig(): DigbyEmailConfig | null {
  const user = process.env.DIGBY_SMTP_USER?.trim() ?? '';
  const pass = process.env.DIGBY_SMTP_PASS?.trim() ?? '';
  if (!user || !pass) return null; // notConfigured — the actionable caller path
  const portRaw = Number(process.env.DIGBY_SMTP_PORT);
  return {
    host: process.env.DIGBY_SMTP_HOST?.trim() || 'smtp.gmail.com',
    port: Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 587,
    user,
    pass,
    // The From address defaults to the MAILBOX itself, never to Digby's production
    // address (self-host setup hardening 2026-10-20): production sets
    // DIGBY_SMTP_FROM=digby@digby.ai explicitly (docker-compose.app.yml), so it is
    // unchanged; a self-host sends as the account it configured.
    from: process.env.DIGBY_SMTP_FROM?.trim() || user,
  };
}

/** True when the SMTP credentials are present (the tool's env-gate). */
export function isConfigured(): boolean {
  return digbyEmailConfig() !== null;
}

/** The env var names an unconfigured caller must be told about. */
export const DIGBY_SMTP_ENV_VARS = ['DIGBY_SMTP_USER', 'DIGBY_SMTP_PASS'] as const;

// ── Validation ────────────────────────────────────────────────────────────────

export const EMAIL_SUBJECT_MAX = 200;
export const EMAIL_BODY_MAX = 100_000;
/** Cap on a recipient address's total length (RFC-ish sanity, not full 5322). */
const EMAIL_ADDR_MAX = 254;

/**
 * Lenient-but-real email shape: one @, a non-empty local part, a dot in the
 * domain, no whitespace, no commas (a comma-separated list is a different
 * failure we surface separately — this is ONE address per call). Deliberately
 * not a full RFC 5322 parser; the SMTP relay is the final arbiter.
 */
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export function isValidEmailAddress(addr: string): boolean {
  return typeof addr === 'string'
    && addr.length > 0 && addr.length <= EMAIL_ADDR_MAX
    && EMAIL_RE.test(addr);
}

// ── Rate limit (in-memory sliding window, per instance) ───────────────────────

export const DIGBY_EMAIL_HOURLY_CAP = 30;

/** Send timestamps (ms epoch) inside the current window; module-scoped state. */
let sendWindow: number[] = [];

/** Test seam: clear the rate-limit window between cases. */
export function __resetDigbyEmailRateLimitForTest(): void {
  sendWindow = [];
}

function takeRateSlot(now = Date.now()): { ok: true } | { ok: false; sentLastHour: number } {
  const windowStart = now - 3_600_000;
  sendWindow = sendWindow.filter((t) => t >= windowStart);
  if (sendWindow.length >= DIGBY_EMAIL_HOURLY_CAP) {
    return { ok: false, sentLastHour: sendWindow.length };
  }
  sendWindow.push(now);
  return { ok: true };
}

// ── Send ──────────────────────────────────────────────────────────────────────

export interface SendDigbyEmailInput {
  to: string;
  subject: string;
  text: string;
  cc?: string;
}

export type SendDigbyEmailResult =
  | { ok: true; messageId: string; from: string }
  | { ok: false; error: string };

/** Recipient privacy: keep only the local-part prefix + the domain in metrics/logs. */
function recipientPrefix(addr: string): string {
  const at = addr.indexOf('@');
  const local = at > 0 ? addr.slice(0, at) : addr;
  const domain = at > 0 ? addr.slice(at + 1) : '';
  return `${local.slice(0, 12)}@${domain}`;
}

async function logEmail(level: 'info' | 'warn', msg: string): Promise<void> {
  try {
    const logger = (await import('../../../utils/logger')).default;
    logger[level](msg);
  } catch { /* never let logging fail a send */ }
}

function recordOutcome(sessionId: string | undefined, meta: Record<string, unknown>): void {
  try {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.DIGBY_EMAIL_SENT, sessionId: sessionId || undefined, meta });
  } catch { /* telemetry must never break a send */ }
}

/**
 * Send one email AS Digby. NEVER throws — every failure is an {ok:false,
 * error} envelope the agent can relay honestly. Sends from DIGBY_SMTP_FROM
 * with reply-to = DIGBY_SMTP_USER (so a human reply lands in the mailbox the
 * instance actually controls).
 */
export async function sendDigbyEmail(
  input: SendDigbyEmailInput,
  opts: { sessionId?: string } = {},
): Promise<SendDigbyEmailResult> {
  const to = String(input?.to ?? '').trim();
  const subject = String(input?.subject ?? '').trim();
  const text = String(input?.text ?? '');
  const cc = input?.cc === undefined || input?.cc === null ? '' : String(input.cc).trim();

  // Validation first — garbage never reaches the transport, never consumes a
  // rate slot, never logs a body.
  if (!to || !isValidEmailAddress(to)) {
    return { ok: false, error: `invalid recipient "to" — must be exactly one email address (got ${JSON.stringify(String(input?.to ?? '').slice(0, 60))})` };
  }
  if (cc && !isValidEmailAddress(cc)) {
    return { ok: false, error: `invalid cc — must be exactly one email address or empty (got ${JSON.stringify(cc.slice(0, 60))})` };
  }
  if (!subject) return { ok: false, error: 'subject must not be empty' };
  if (subject.length > EMAIL_SUBJECT_MAX) {
    return { ok: false, error: `subject too long: ${subject.length} chars (max ${EMAIL_SUBJECT_MAX})` };
  }
  if (!text.trim()) return { ok: false, error: 'text body must not be empty' };
  if (text.length > EMAIL_BODY_MAX) {
    return { ok: false, error: `text body too long: ${text.length} chars (max ${EMAIL_BODY_MAX})` };
  }

  const config = digbyEmailConfig();
  if (!config) {
    const missing = DIGBY_SMTP_ENV_VARS.join(' and ');
    recordOutcome(opts.sessionId, { outcome: 'not_configured', to: recipientPrefix(to) });
    return {
      ok: false,
      error: `Digby email is not configured on this instance: set ${missing} (Gmail workspace SMTP — see docs/EMAIL_AS_DIGBY.md). Nothing was sent; do not claim an email went out.`,
    };
  }

  const slot = takeRateSlot();
  if (!slot.ok) {
    recordOutcome(opts.sessionId, { outcome: 'rate_limited', to: recipientPrefix(to), sentLastHour: slot.sentLastHour, cap: DIGBY_EMAIL_HOURLY_CAP });
    return {
      ok: false,
      error: `rate limit: this instance already sent ${slot.sentLastHour} Digby emails in the last hour (cap ${DIGBY_EMAIL_HOURLY_CAP}/hour). Batch further updates into one email or the chat answer; do not retry this run.`,
    };
  }

  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });
    const info = await transporter.sendMail({
      from: config.from,
      replyTo: config.user,
      to,
      ...(cc ? { cc } : {}),
      subject,
      text,
    });
    const messageId = typeof info?.messageId === 'string' ? info.messageId : '';
    recordOutcome(opts.sessionId, { outcome: 'sent', to: recipientPrefix(to), ...(cc ? { cc: recipientPrefix(cc) } : {}), messageId, subjectChars: subject.length, textChars: text.length });
    void logEmail('info', `digby-email: sent to=${recipientPrefix(to)} subjectChars=${subject.length} messageId=${messageId.slice(0, 80)}`);
    return { ok: true, messageId, from: config.from };
  } catch (err: any) {
    // Never leak the password or the body — only the error's own message.
    const msg = String(err?.message ?? err).slice(0, 300);
    recordOutcome(opts.sessionId, { outcome: 'send_failed', to: recipientPrefix(to), error: msg });
    void logEmail('warn', `digby-email: send failed to=${recipientPrefix(to)} error=${msg}`);
    return { ok: false, error: `SMTP send failed: ${msg}` };
  }
}

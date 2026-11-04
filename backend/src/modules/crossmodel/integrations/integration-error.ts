/**
 * Integration failure text — ONE readable line per failed upstream call (leaf:
 * imports only the credential redactor).
 *
 * WHY (2026-10-04): a failed connector call used to reach the model as "No
 * result from <Service> — the integration may not be connected … or nothing
 * matched" (coding/coding-integrations.ts `notFound`) or as nothing at all
 * (integration-context.ts drops '' legs), so the model could not tell the user
 * to reconnect, wait out a rate limit, or that the service was down. The Xero
 * client was fixed first (xero/xero-mcp.ts `XeroApiError`, whose text now comes
 * from here byte-for-byte); this module is the shared status → text mapping for
 * Slack, Asana, GitHub, Google and Plaid.
 *
 * Two failure families, never conflated:
 *  - the PROVIDER refused or failed (401/403 → reconnect, 429, 5xx, network,
 *    a stored connection with no usable token) — the user can act;
 *  - Digby's own CONNECTOR container (slack-mcp / asana-mcp / github-mcp /
 *    google-mcp) did not answer — platform-side; reconnecting will NOT help.
 *    An MCP client's axios status is the CONTAINER's status, never the
 *    provider's, so a container 401 (service-key mismatch) is a gateway
 *    failure, not a re-auth. Provider errors from a container arrive as TEXT
 *    ("Error …" content or an isError part) and are classified by wording
 *    (`classifyUpstreamErrorText`).
 *
 * Kill switch INTEGRATION_ERROR_SURFACE_DISABLED=1 restores every client's old
 * silent behaviour (null / '' on failure). Xero keeps its own switch
 * (XERO_ERROR_SURFACE_DISABLED).
 */

import { redactUrlCredentials } from '../../../utils/redact-credentials';

export type IntegrationErrorKind =
  | 'auth'            // the provider rejected the user's credentials → reconnect
  | 'no_token'        // a stored connection exists but no usable token (refresh / decrypt failed) → reconnect
  | 'rate_limited'    // the provider throttled the call → wait
  | 'down'            // the provider failed on its side (5xx / outage) → later
  | 'network'         // the provider could not be reached → retry
  | 'gateway'         // Digby's connector container did not answer → platform-side
  | 'not_configured'  // this Digby instance lacks the integration's server config → admin
  | 'other';          // anything else — the reason rides along verbatim

export interface IntegrationService {
  /** Display name, e.g. 'Slack'. */
  name: string;
  /** The exact place the user re-authorizes. */
  reconnectPath: string;
  /** The self-hosted MCP container, when the client calls one. */
  connector?: string;
  /** Why a stored connection has no usable token (rendered in parentheses). */
  noTokenReason?: string;
}

export const INTEGRATION_SERVICES = {
  xero:   { name: 'Xero',   reconnectPath: 'Account → Integrations → Xero → reconnect', noTokenReason: 'refresh failed' },
  slack:  { name: 'Slack',  reconnectPath: 'Account → Integrations → Slack → reconnect', connector: 'slack-mcp', noTokenReason: 'the stored token could not be read' },
  asana:  { name: 'Asana',  reconnectPath: 'Account → Integrations → Asana → reconnect', connector: 'asana-mcp', noTokenReason: 'refresh failed' },
  github: { name: 'GitHub', reconnectPath: 'Account → Integrations → GitHub → reconnect (or replace the Personal Access Token)', connector: 'github-mcp', noTokenReason: 'the stored token could not be read' },
  google: { name: 'Google', reconnectPath: 'Account → Integrations → Google → reconnect that account (or "Update permissions")', connector: 'google-mcp', noTokenReason: 'refresh failed' },
  plaid:  { name: 'Plaid',  reconnectPath: 'Account → Integrations → Plaid Banking → link the bank again', noTokenReason: 'the stored token could not be read' },
  // Discord has NO per-user OAuth — one shared bot token lives in the
  // discord-mcp container's env, so a rejected credential is always admin-side
  // and the reconnect line must not point the user at Account → Integrations.
  discord: { name: 'Discord', reconnectPath: 'an admin must re-issue the Discord bot token (DISCORD_BOT_TOKEN in the discord-mcp container)', connector: 'discord-mcp', noTokenReason: 'the shared bot token could not be read' },
} satisfies Record<string, IntegrationService>;

export function integrationErrorSurfaceDisabled(): boolean {
  return process.env.INTEGRATION_ERROR_SURFACE_DISABLED === '1';
}

/** One line, ≤120 chars, credentials masked (URL userinfo, ghp_…, Bearer …, xox…-). */
export function clipErrorDetail(detail: unknown, max = 120): string {
  const s = redactUrlCredentials(String(detail ?? ''))
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\bxox[abeprs]-[A-Za-z0-9-]+/g, 'xox-***')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, max);
}

/** HTTP status → kind for a DIRECT REST client (Xero, Plaid). null status = unknown (never "no token" here). */
export function kindFromHttpStatus(status: number | null): IntegrationErrorKind {
  if (status === 0) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (typeof status === 'number' && status >= 500) return 'down';
  return 'other';
}

const RATE_RE = /\b(?:rate[ _-]?limit(?:ed)?|ratelimited|too many requests|quota exceeded)\b|\b(?:HTTP|status(?:[ _]?code)?)\s*[:=]?\s*429\b/i;
const AUTH_RE = /\b(?:invalid_auth|not_authed|token_revoked|token_expired|account_inactive|missing_scope|invalid_grant|invalid credentials|invalid authentication credentials|unauthenticated|bad credentials|not authori[sz]ed|insufficient authentication scopes?|insufficient permission|requires authentication)\b|\b(?:HTTP|status(?:[ _]?code)?)\s*[:=]?\s*401\b/i;
const DOWN_RE = /\b(?:service unavailable|backend error|(?:internal )?server error|bad gateway|gateway time-?out)\b|\b(?:HTTP|status(?:[ _]?code)?)\s*[:=]?\s*5\d\d\b/i;

/**
 * Classify a provider error a connector container returned as TEXT. Only the
 * actionable classes are recognised; anything else (not found, a per-resource
 * permission, a bad argument) returns null and the caller keeps today's
 * behaviour for it. Rate limits win over auth (GitHub's "API rate limit
 * exceeded" is a 403).
 */
export function classifyUpstreamErrorText(text: string): 'auth' | 'rate_limited' | 'down' | null {
  const s = String(text ?? '');
  if (RATE_RE.test(s)) return 'rate_limited';
  if (AUTH_RE.test(s)) return 'auth';
  if (DOWN_RE.test(s)) return 'down';
  return null;
}

/** A connector container's error-shaped text answer ("Error listing projects: …", "Error: …"). */
export function isErrorShapedText(text: string | null | undefined): boolean {
  return typeof text === 'string' && /^\s*Error\b/.test(text);
}

/** Strip the container's "Error <fn>:" / "Error:" prefix so the detail is the provider's words. */
export function stripErrorPrefix(text: string): string {
  return String(text ?? '').replace(/^\s*Error\b[^:]{0,60}:\s*/, '').trim() || String(text ?? '').trim();
}

/** The line the model reads for a failed call (pure). `operation` is what was attempted ("message search call", "/Organisation"). */
export function integrationErrorText(
  service: IntegrationService,
  operation: string,
  kind: IntegrationErrorKind,
  status: number | null,
  detail: string,
): string {
  const S = service.name;
  const what = `${S} ${String(operation).replace(/^\//, '')}`;
  const d = clipErrorDetail(detail);
  const http = typeof status === 'number' && status > 0 ? `HTTP ${status}` : '';
  // "(HTTP 401: detail)" / "(HTTP 401)" / "(detail)" / "" — the Xero shape.
  const paren = http && d ? `(${http}: ${d})` : http || d ? `(${http || d})` : '';
  switch (kind) {
    case 'no_token':
      return `${what} could not be called: the ${S} connection has no valid token (${service.noTokenReason ?? 'refresh failed'}) — the user should reconnect ${S} in Account → Integrations.`;
    case 'auth':
      return `${what} was rejected by ${S}${paren ? ` ${paren}` : ''} — the ${S} connection needs re-authorizing: ${service.reconnectPath}.`;
    case 'network':
      return `${what} could not reach ${S} (network error${d ? `: ${d}` : ''}) — try again shortly.`;
    case 'rate_limited':
      return `${what} was rate-limited by ${S}${http ? ` (${http})` : d ? ` (${d})` : ''} — try again in a minute.`;
    case 'down':
      return `${what} failed on ${S}'s side${http ? ` (${http})` : d ? ` (${d})` : ''} — ${S} is unavailable right now; try again later.`;
    case 'gateway':
      return `${what} failed: Digby's ${service.connector ?? `${S} connector`} service did not answer${d ? ` (${d})` : ''} — a platform-side outage, not the user's ${S} connection (reconnecting will not help); try again shortly.`;
    case 'not_configured':
      return `${what} is unavailable: ${S} is not configured on this Digby instance${d ? ` (${d})` : ''} — an admin must set it up; reconnecting will not help.`;
    default:
      return `${what} failed${paren ? ` ${paren}` : ''}.`;
  }
}

/** A failed integration call the MODEL must see; `.message` is the one readable line. */
export class IntegrationApiError extends Error {
  constructor(
    public readonly service: IntegrationService,
    public readonly operation: string,
    public readonly kind: IntegrationErrorKind,
    public readonly status: number | null,
    detail: string,
  ) {
    super(integrationErrorText(service, operation, kind, status, detail));
    this.name = 'IntegrationApiError';
  }
}

/** Catch-block helper for READ tools: a surfaced failure returns its line, anything else keeps the old ''. */
export function surfacedOrEmpty(err: unknown): string {
  return err instanceof IntegrationApiError ? err.message : '';
}

/**
 * A connector-container transport failure (axios rejected, the SSE stream timed
 * out / ended / errored) → a gateway IntegrationApiError. The axios status here
 * is the CONTAINER's — a 401 means Digby's service key was refused, never the
 * user's token.
 */
export function connectorTransportError(service: IntegrationService, operation: string, err: any): IntegrationApiError {
  if (err instanceof IntegrationApiError) return err;
  const status = err?.response?.status;
  let detail: string;
  if (typeof status === 'number') {
    detail = status === 401 || status === 403
      ? `HTTP ${status} — the connector refused Digby's service key`
      : `HTTP ${status}`;
  } else if (err?.code) {
    detail = `network error: ${err.code}`;
  } else {
    detail = String(err?.message ?? err ?? 'unknown error');
  }
  return new IntegrationApiError(service, operation, 'gateway', null, detail);
}

/** "slack_search_messages" → "search messages call" (strips the service prefix). */
export function mcpOperationLabel(toolName: string, prefix: string): string {
  const bare = String(toolName).startsWith(prefix) ? String(toolName).slice(prefix.length) : String(toolName);
  return `${bare.replace(/_/g, ' ').trim()} call`;
}

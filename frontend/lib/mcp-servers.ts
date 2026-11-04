/**
 * User-added MCP servers (ticket e294f9a4) — pure helpers behind Account →
 * Integrations → MCP servers: the add-form draft (from scratch or from a
 * quick-start template), its validation, the auth header it sends, and the
 * health / probe wording. No React, no network — pinned by mcp-servers.test.ts.
 */

import type { McpHealthStatus, McpProbe, McpServer, McpServerInput, McpServerTemplate, McpTransportPref } from './api/mcp-servers';

/** How the user supplies credentials in the form. */
export type McpAuthMode = 'none' | 'bearer' | 'header';

export interface McpServerDraft {
  name: string;
  url: string;
  transport: McpTransportPref;
  authMode: McpAuthMode;
  /** Header name for 'header' mode (bearer always uses Authorization). */
  headerName: string;
  /** The token as the user pasted it (bearer: without the "Bearer " prefix). */
  token: string;
  templateId: string | null;
}

export const EMPTY_DRAFT: McpServerDraft = { name: '', url: '', transport: 'auto', authMode: 'none', headerName: 'Authorization', token: '', templateId: null };

/** A template → a pre-filled draft. OAuth-only vendors pre-fill the URL; the user may still paste a token where the vendor documents one. */
export function draftFromTemplate(t: McpServerTemplate): McpServerDraft {
  const kind = t.auth.kind;
  const authMode: McpAuthMode = kind === 'bearer' || kind === 'optional_bearer'
    ? 'bearer'
    : kind === 'header' ? 'header' : 'none';
  return {
    name: t.id === 'custom' ? '' : t.name,
    url: t.url ?? '',
    transport: t.transport,
    authMode,
    headerName: kind === 'header' ? (t.auth.headerName || 'Authorization') : 'Authorization',
    token: '',
    templateId: t.id,
  };
}

/** Does the template need a token before it can work? (optional_bearer / none / oauth: no) */
export function templateNeedsToken(t: McpServerTemplate): boolean {
  return t.auth.kind === 'bearer';
}

/** The badge a template card shows. */
export function templateAuthLabel(t: McpServerTemplate): string {
  if (t.urlRequired) return 'URL required';
  switch (t.auth.kind) {
    case 'none': return 'No sign-in';
    case 'optional_bearer': return 'Token optional';
    case 'bearer': return 'Token';
    case 'header': return t.auth.tokenLabel?.toLowerCase().includes('optional') ? 'Key optional' : 'API key';
    case 'oauth': return 'OAuth — coming soon';
  }
}

const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** Client-side validation (the server re-validates everything). Returns the first problem or null. */
export function validateDraft(d: McpServerDraft, opts: { requireName: boolean; editing?: boolean }): string | null {
  if (opts.requireName && !d.name.trim()) return 'Give the server a name.';
  if (d.name.trim().length > 60) return 'Name is too long (max 60 characters).';
  const url = d.url.trim();
  if (!opts.editing || url) {
    if (!url) return 'Enter the server URL.';
    let parsed: URL;
    try { parsed = new URL(url); } catch { return 'That is not a valid URL.'; }
    if (parsed.protocol !== 'https:') return 'Use an https:// URL.';
    if (parsed.username || parsed.password) return 'Put credentials in the token field, not in the URL.';
  }
  if (d.authMode === 'header' && !HEADER_NAME_RE.test(d.headerName.trim())) return 'The header name may only use letters, digits and dashes.';
  if (/[\r\n]/.test(d.token)) return 'The token must be a single line.';
  return null;
}

/** The header name + value the draft sends ({} for no auth / an empty token). */
export function authFromDraft(d: McpServerDraft): { authHeader: string; authValue: string } | null {
  const token = d.token.trim();
  if (d.authMode === 'none' || !token) return null;
  if (d.authMode === 'bearer') return { authHeader: 'Authorization', authValue: /^(bearer|basic|token)\s+/i.test(token) ? token : `Bearer ${token}` };
  return { authHeader: d.headerName.trim(), authValue: token };
}

/** The create / test-draft request body. */
export function inputFromDraft(d: McpServerDraft): McpServerInput {
  const auth = authFromDraft(d);
  return {
    name: d.name.trim(),
    url: d.url.trim(),
    transport: d.transport,
    ...(auth ? auth : {}),
    templateId: d.templateId,
  };
}

/**
 * The PATCH body for an edit: only what changed. A blank token keeps the
 * stored one; `clearToken` (or switching auth off) sends '' to remove it.
 */
export function patchFromDraft(d: McpServerDraft, server: McpServer, opts: { clearToken: boolean }): McpServerInput {
  const patch: McpServerInput = {};
  if (d.name.trim() && d.name.trim() !== server.name) patch.name = d.name.trim();
  if (d.url.trim()) patch.url = d.url.trim();
  if (d.transport !== server.transport) patch.transport = d.transport;
  const auth = authFromDraft(d);
  if (opts.clearToken || (d.authMode === 'none' && server.hasAuth)) {
    patch.authHeader = '';
    patch.authValue = '';
  } else if (auth) {
    patch.authHeader = auth.authHeader;
    patch.authValue = auth.authValue;
  } else if (d.authMode === 'header' && server.hasAuth && d.headerName.trim() !== server.authHeader) {
    patch.authHeader = d.headerName.trim(); // rename the header, keep the token
  }
  return patch;
}

export interface HealthBadge { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }

export function healthBadge(status: McpHealthStatus, enabled = true): HealthBadge {
  if (!enabled) return { label: 'Paused', tone: 'muted' };
  switch (status) {
    case 'healthy': return { label: 'Healthy', tone: 'ok' };
    case 'degraded': return { label: 'Flaky', tone: 'warn' };
    case 'unhealthy': return { label: 'Unhealthy', tone: 'bad' };
    default: return { label: 'Not checked', tone: 'muted' };
  }
}

/** One plain line for a server's state ("12 tools · checked 4 min ago" / the last error). */
export function healthLine(s: McpServer, now = Date.now()): string {
  const ago = (iso: string | null): string => {
    if (!iso) return 'never';
    const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };
  const tools = `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`;
  if (!s.enabled) return `${tools} · paused — not offered to Digby`;
  if (s.health.status === 'unhealthy' || s.health.status === 'degraded') {
    const next = s.health.nextCheckAt ? ` · next check ${Date.parse(s.health.nextCheckAt) <= now ? 'due' : `in ${Math.max(1, Math.round((Date.parse(s.health.nextCheckAt) - now) / 60_000))} min`}` : '';
    return `${s.health.lastError ?? 'Connection failed'} · checked ${ago(s.health.lastCheckAt)}${next}`;
  }
  if (s.health.status === 'unknown') return 'Not reached yet — press Test.';
  return `${tools} · checked ${ago(s.health.lastCheckAt)}${s.health.lastLatencyMs != null ? ` · ${s.health.lastLatencyMs} ms` : ''}`;
}

/** The result line under a Test / Add. */
export function probeSummary(p: McpProbe): string {
  if (p.ok) {
    const who = p.serverName ? `${p.serverName}${p.serverVersion ? ` ${p.serverVersion}` : ''}` : 'the server';
    return `Connected to ${who} over ${p.transport === 'sse' ? 'SSE' : 'Streamable HTTP'} in ${p.latencyMs} ms — ${p.toolCount} tool${p.toolCount === 1 ? '' : 's'}${p.truncated ? ' (list truncated)' : ''}.`;
  }
  const hint = p.oauth
    ? ' This server signs in with OAuth, which Digby does not support yet — use a personal access token / API key if the vendor offers one.'
    : p.errorClass === 'blocked_url' ? '' : p.errorClass === 'timeout' ? ' Check the URL and that the server is up.' : '';
  return `${p.error ?? 'Connection failed.'}${hint}`;
}

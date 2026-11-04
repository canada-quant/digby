/**
 * User-added MCP servers (ticket e294f9a4) — the add-form helpers: template
 * pre-fill, validation, the auth header the form sends, the edit PATCH (only
 * what changed; a blank token keeps the stored one), and the health / probe
 * wording.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_DRAFT, authFromDraft, draftFromTemplate, healthBadge, healthLine, inputFromDraft, patchFromDraft, probeSummary,
  templateAuthLabel, templateNeedsToken, validateDraft, type McpServerDraft,
} from './mcp-servers';
import type { McpServer, McpServerTemplate } from './api/mcp-servers';

const tpl = (over: Partial<McpServerTemplate>): McpServerTemplate => ({
  id: 'linear', name: 'Linear', description: 'Issues', url: 'https://mcp.linear.app/mcp', urlRequired: false, transport: 'streamable_http',
  auth: { kind: 'bearer', headerName: 'Authorization', tokenLabel: 'Linear API key' }, docsUrl: 'https://linear.app/docs/mcp', verifiedAt: '2026-10-06', category: 'productivity',
  ...over,
});

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: 's1', name: 'Linear', slug: 'linear', url: 'https://mcp.linear.app/mcp', transport: 'auto', authHeader: 'Authorization', hasAuth: true, authPreview: '••••1234',
  authUnreadable: false, enabled: true, machineWrites: false, templateId: 'linear', createdAt: '', updatedAt: '',
  health: {
    status: 'healthy', consecutiveFailures: 0, lastError: null, lastErrorClass: null, lastCheckAt: '2026-10-06T12:00:00Z', lastOkAt: '2026-10-06T12:00:00Z',
    nextCheckAt: '2026-10-06T12:30:00Z', lastLatencyMs: 120, transport: 'streamable_http', serverName: 'linear', serverVersion: '1', protocolVersion: '2025-06-18',
    toolsAt: null, toolsTruncated: false, callsOk: 0, callsFailed: 0, lastCallAt: null,
  },
  tools: [{ name: 'list_issues', exposedName: 'mcp_linear_list_issues', description: '', readOnly: true, destructive: false, enabled: true }],
  ...over,
});
const NOW = Date.parse('2026-10-06T12:04:00Z');

describe('templates → drafts', () => {
  it('a bearer template pre-fills name / URL / transport and asks for the token', () => {
    expect(draftFromTemplate(tpl({}))).toEqual({ name: 'Linear', url: 'https://mcp.linear.app/mcp', transport: 'streamable_http', authMode: 'bearer', headerName: 'Authorization', token: '', templateId: 'linear' });
    expect(templateNeedsToken(tpl({}))).toBe(true);
    expect(templateAuthLabel(tpl({}))).toBe('Token');
  });
  it('vendor-header, public, OAuth-only and URL-required templates', () => {
    const exa = draftFromTemplate(tpl({ id: 'exa', name: 'Exa', auth: { kind: 'header', headerName: 'x-api-key', tokenLabel: 'Exa API key (optional)' } }));
    expect(exa).toMatchObject({ authMode: 'header', headerName: 'x-api-key' });
    expect(templateAuthLabel(tpl({ auth: { kind: 'header', headerName: 'x-api-key', tokenLabel: 'Exa API key (optional)' } }))).toBe('Key optional');
    expect(draftFromTemplate(tpl({ auth: { kind: 'none' } })).authMode).toBe('none');
    expect(templateAuthLabel(tpl({ auth: { kind: 'none' } }))).toBe('No sign-in');
    expect(templateAuthLabel(tpl({ auth: { kind: 'oauth', note: 'x' } }))).toBe('OAuth — coming soon');
    const custom = tpl({ id: 'custom', name: 'Other MCP server', url: null, urlRequired: true, transport: 'auto', auth: { kind: 'optional_bearer', headerName: 'Authorization' } });
    expect(draftFromTemplate(custom)).toMatchObject({ name: '', url: '', transport: 'auto', authMode: 'bearer' });
    expect(templateAuthLabel(custom)).toBe('URL required');
  });
});

describe('validation + request bodies', () => {
  const d = (over: Partial<McpServerDraft>): McpServerDraft => ({ ...EMPTY_DRAFT, name: 'Linear', url: 'https://mcp.linear.app/mcp', ...over });
  it('validates name, https URL, credentials-in-URL and header names', () => {
    expect(validateDraft(d({}), { requireName: true })).toBeNull();
    expect(validateDraft(d({ name: '' }), { requireName: true })).toMatch(/name/);
    expect(validateDraft(d({ url: 'http://x.example.com' }), { requireName: true })).toMatch(/https/);
    expect(validateDraft(d({ url: 'nope' }), { requireName: true })).toMatch(/valid URL/);
    expect(validateDraft(d({ url: 'https://u:p@x.example.com' }), { requireName: true })).toMatch(/credentials/);
    expect(validateDraft(d({ authMode: 'header', headerName: 'bad header' }), { requireName: true })).toMatch(/header name/);
    expect(validateDraft(d({ url: '' }), { requireName: false, editing: true })).toBeNull(); // editing keeps the stored URL
  });
  it('bearer adds "Bearer " once; header sends the vendor header; an empty token sends nothing', () => {
    expect(authFromDraft(d({ authMode: 'bearer', token: ' lin_api_x ' }))).toEqual({ authHeader: 'Authorization', authValue: 'Bearer lin_api_x' });
    expect(authFromDraft(d({ authMode: 'bearer', token: 'Basic abc=' }))).toEqual({ authHeader: 'Authorization', authValue: 'Basic abc=' });
    expect(authFromDraft(d({ authMode: 'header', headerName: 'x-api-key', token: 'k' }))).toEqual({ authHeader: 'x-api-key', authValue: 'k' });
    expect(authFromDraft(d({ authMode: 'bearer', token: '' }))).toBeNull();
    expect(inputFromDraft(d({ authMode: 'bearer', token: 't', templateId: 'linear' }))).toEqual({ name: 'Linear', url: 'https://mcp.linear.app/mcp', transport: 'auto', authHeader: 'Authorization', authValue: 'Bearer t', templateId: 'linear' });
  });
  it('the edit PATCH carries only what changed; blank token keeps it; clear / no-auth removes it', () => {
    const s = server();
    expect(patchFromDraft(d({ name: 'Linear', url: '', transport: 'auto', authMode: 'bearer' }), s, { clearToken: false })).toEqual({});
    expect(patchFromDraft(d({ name: 'Linear Work', url: '', transport: 'sse', authMode: 'bearer', token: 'new' }), s, { clearToken: false }))
      .toEqual({ name: 'Linear Work', transport: 'sse', authHeader: 'Authorization', authValue: 'Bearer new' });
    expect(patchFromDraft(d({ url: '', authMode: 'bearer' }), s, { clearToken: true })).toEqual({ authHeader: '', authValue: '' });
    expect(patchFromDraft(d({ url: '', authMode: 'none' }), s, { clearToken: false })).toEqual({ authHeader: '', authValue: '' });
    expect(patchFromDraft(d({ url: 'https://mcp2.example.com/mcp', authMode: 'bearer' }), s, { clearToken: false })).toEqual({ url: 'https://mcp2.example.com/mcp' });
  });
});

describe('health + probe wording', () => {
  it('badges', () => {
    expect(healthBadge('healthy')).toEqual({ label: 'Healthy', tone: 'ok' });
    expect(healthBadge('degraded')).toEqual({ label: 'Flaky', tone: 'warn' });
    expect(healthBadge('unhealthy')).toEqual({ label: 'Unhealthy', tone: 'bad' });
    expect(healthBadge('unknown')).toEqual({ label: 'Not checked', tone: 'muted' });
    expect(healthBadge('healthy', false)).toEqual({ label: 'Paused', tone: 'muted' });
  });
  it('health line: tools + recency when healthy; the error + next check when failing; paused / never reached', () => {
    expect(healthLine(server(), NOW)).toBe('1 tool · checked 4 min ago · 120 ms');
    const failing = server({ health: { ...server().health, status: 'unhealthy', lastError: 'HTTP 401 — rejected', nextCheckAt: '2026-10-06T12:14:00Z' } });
    expect(healthLine(failing, NOW)).toBe('HTTP 401 — rejected · checked 4 min ago · next check in 10 min');
    expect(healthLine(server({ enabled: false }), NOW)).toBe('1 tool · paused — not offered to Digby');
    expect(healthLine(server({ health: { ...server().health, status: 'unknown' } }), NOW)).toBe('Not reached yet — press Test.');
  });
  it('probe summary names the server, transport, latency and tool count — or the honest error + an OAuth hint', () => {
    expect(probeSummary({ ok: true, latencyMs: 80, transport: 'streamable_http', serverName: 'linear', serverVersion: '1.2', protocolVersion: '2025-06-18', toolCount: 23, tools: [], truncated: false }))
      .toBe('Connected to linear 1.2 over Streamable HTTP in 80 ms — 23 tools.');
    expect(probeSummary({ ok: false, latencyMs: 5, transport: null, serverName: null, serverVersion: null, protocolVersion: null, toolCount: 0, tools: [], truncated: false, error: 'HTTP 401 — the server wants a sign-in token.', errorClass: 'auth', oauth: true }))
      .toMatch(/^HTTP 401 — the server wants a sign-in token\. This server signs in with OAuth/);
  });
});

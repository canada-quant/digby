/**
 * Account → Integrations → MCP servers (ticket e294f9a4) — the presentational
 * pieces rendered to static markup (react-dom/server, node-environment vitest —
 * the ModelEndpointsSection.test idiom): the health badge tones, the server
 * card (health line, token preview, tools with read-only / changes-data
 * labels, the machine-writes switch), the probe line and the template grid;
 * plus the mount in IntegrationsTab (source pin — a Radix tree needs a DOM).
 */

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

vi.mock('@/lib/api-client', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

import { McpHealthBadge, McpProbeLine, McpServerCard, McpTemplateGrid } from './McpServersSection';
import type { McpServer, McpServerTemplate } from '@/lib/api/mcp-servers';

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: 's1', name: 'Linear', slug: 'linear', url: 'https://mcp.linear.app/mcp', transport: 'auto', authHeader: 'Authorization', hasAuth: true, authPreview: '••••1234',
  authUnreadable: false, enabled: true, machineWrites: false, templateId: 'linear', createdAt: '', updatedAt: '',
  health: {
    status: 'healthy', consecutiveFailures: 0, lastError: null, lastErrorClass: null, lastCheckAt: '2026-10-06T12:00:00Z', lastOkAt: '2026-10-06T12:00:00Z',
    nextCheckAt: '2026-10-06T12:30:00Z', lastLatencyMs: 120, transport: 'streamable_http', serverName: 'linear', serverVersion: '1', protocolVersion: '2025-06-18',
    toolsAt: null, toolsTruncated: false, callsOk: 3, callsFailed: 0, lastCallAt: null,
  },
  tools: [
    { name: 'list_issues', exposedName: 'mcp_linear_list_issues', description: 'List issues', readOnly: true, readOnlySource: 'annotation', destructive: false, enabled: true },
    { name: 'read_page', exposedName: 'mcp_linear_read_page', description: 'Read', readOnly: true, readOnlySource: 'name', destructive: false, enabled: true },
    { name: 'create_issue', exposedName: 'mcp_linear_create_issue', description: 'Create an issue', readOnly: false, destructive: false, enabled: false },
    { name: 'delete_issue', exposedName: 'mcp_linear_delete_issue', description: 'Delete', readOnly: false, destructive: true, enabled: true },
  ],
  ...over,
});
const NOW = Date.parse('2026-10-06T12:04:00Z');
const html = (el: any) => renderToStaticMarkup(el);

describe('McpHealthBadge', () => {
  it.each([['healthy', true, 'ok', 'Healthy'], ['degraded', true, 'warn', 'Flaky'], ['unhealthy', true, 'bad', 'Unhealthy'], ['unknown', true, 'muted', 'Not checked'], ['healthy', false, 'muted', 'Paused']] as const)(
    '%s (enabled %s) → %s', (status, enabled, tone, label) => {
      const out = html(createElement(McpHealthBadge, { status, enabled }));
      expect(out).toContain(`data-mcp-health="${tone}"`);
      expect(out).toContain(label);
    },
  );
});

describe('McpServerCard', () => {
  it('shows the masked URL, the token preview, the health line and the tool count; never the token', () => {
    const out = html(createElement(McpServerCard, { server: server(), now: NOW }));
    expect(out).toContain('data-mcp-server="linear"');
    expect(out).toContain('https://mcp.linear.app/mcp');
    expect(out).toContain('token ••••1234');
    expect(out).toContain('4 tools · checked 4 min ago · 120 ms');
    expect(out).toContain('3 of 4 tools on');
    expect(out).toContain('Allow changes on scheduled runs');
    expect(out).not.toContain('data-mcp-tools'); // collapsed
  });

  it('expanded: every tool with its exposed name and a read-only / changes data / destructive label', () => {
    const out = html(createElement(McpServerCard, { server: server(), expanded: true, now: NOW }));
    expect(out).toContain('data-mcp-tools');
    expect(out).toContain('mcp_linear_list_issues');
    expect(out).toMatch(/mcp_linear_list_issues<\/code><span[^>]*>read-only</);
    expect(out).toMatch(/mcp_linear_read_page<\/code><span[^>]*>read-only \(by name\)/);
    expect(out).toMatch(/mcp_linear_create_issue<\/code><span[^>]*>changes data/);
    expect(out).toMatch(/mcp_linear_delete_issue<\/code><span[^>]*>destructive/);
  });

  it('an unhealthy server shows the honest error in red; an unreadable token says re-enter it', () => {
    const s = server({ authUnreadable: true, health: { ...server().health, status: 'unhealthy', lastError: 'HTTP 401 — the server rejected the credentials', nextCheckAt: '2026-10-06T12:14:00Z' } });
    const out = html(createElement(McpServerCard, { server: s, now: NOW }));
    expect(out).toContain('HTTP 401 — the server rejected the credentials · checked 4 min ago · next check in 10 min');
    expect(out).toMatch(/data-mcp-health-line="[^"]*" class="[^"]*text-destructive/);
    expect(out).toContain('can no longer be read');
  });

  it('renders the latest probe result', () => {
    const out = html(createElement(McpServerCard, { server: server(), now: NOW, probe: { ok: false, latencyMs: 3, transport: null, serverName: null, serverVersion: null, protocolVersion: null, toolCount: 0, tools: [], truncated: false, error: 'the server did not answer in time', errorClass: 'timeout' } }));
    expect(out).toContain('data-mcp-probe="fail"');
    expect(out).toContain('the server did not answer in time Check the URL and that the server is up.');
  });
});

describe('McpProbeLine + McpTemplateGrid', () => {
  it('probe ok line', () => {
    const out = html(createElement(McpProbeLine, { probe: { ok: true, latencyMs: 80, transport: 'sse', serverName: 'legacy', serverVersion: null, protocolVersion: '2024-11-05', toolCount: 1, tools: [], truncated: false } }));
    expect(out).toContain('data-mcp-probe="ok"');
    expect(out).toContain('Connected to legacy over SSE in 80 ms — 1 tool.');
  });

  it('template grid: one button per template with its auth label', () => {
    const templates: McpServerTemplate[] = [
      { id: 'deepwiki', name: 'DeepWiki', description: 'Docs', url: 'https://mcp.deepwiki.com/mcp', urlRequired: false, transport: 'streamable_http', auth: { kind: 'none' }, docsUrl: 'https://docs.devin.ai', verifiedAt: '2026-10-06', category: 'docs' },
      { id: 'notion', name: 'Notion', description: 'Pages', url: 'https://mcp.notion.com/mcp', urlRequired: false, transport: 'streamable_http', auth: { kind: 'oauth', note: 'OAuth only' }, docsUrl: 'https://developers.notion.com', verifiedAt: '2026-10-06', category: 'productivity' },
    ];
    const out = html(createElement(McpTemplateGrid, { templates, onPick: () => {} }));
    expect(out).toContain('data-mcp-templates');
    expect(out).toContain('DeepWiki');
    expect(out).toContain('No sign-in');
    expect(out).toContain('OAuth — coming soon');
    expect(html(createElement(McpTemplateGrid, { templates: [], onPick: () => {} }))).toBe('');
  });
});

describe('mount', () => {
  it('IntegrationsTab renders the MCP servers section (before WhatsApp)', () => {
    const src = readFileSync(fileURLToPath(new URL('./IntegrationsTab.tsx', import.meta.url)), 'utf8');
    expect(src).toContain("import McpServersSection from './McpServersSection';");
    expect(src.indexOf('<McpServersSection />')).toBeGreaterThan(0);
    expect(src.indexOf('<McpServersSection />')).toBeLessThan(src.indexOf('WhatsApp section'));
  });
});

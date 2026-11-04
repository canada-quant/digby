/**
 * User-added MCP servers (ticket e294f9a4) — the quick-start catalog's
 * invariants: every pre-filled URL passes the same URL guard a user's own
 * entry does, an unconfirmed URL is marked "URL required", every template
 * names the vendor doc it was confirmed on.
 */

import { MCP_SERVER_TEMPLATES, templateById } from './user-mcp-templates';
import { assertUserMcpUrl } from './url-guard';

describe('MCP quick-start templates', () => {
  it('ids are unique and stable; templateById resolves them', () => {
    const ids = MCP_SERVER_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['github', 'linear', 'notion', 'sentry', 'cloudflare', 'stripe', 'supabase', 'atlassian', 'asana', 'zapier', 'custom']) {
      expect(templateById(id)?.id).toBe(id);
    }
    expect(templateById('nope')).toBeNull();
    expect(templateById(null)).toBeNull();
  });

  it('every template either carries a URL that passes the URL guard, or is marked URL required', () => {
    for (const t of MCP_SERVER_TEMPLATES) {
      if (t.url === null) {
        expect(t.urlRequired).toBe(true);
        continue;
      }
      expect(t.urlRequired).toBe(false);
      expect(() => assertUserMcpUrl(t.url!)).not.toThrow();
    }
  });

  it('every template names an https vendor doc + a verification date; token kinds name their header', () => {
    for (const t of MCP_SERVER_TEMPLATES) {
      expect(t.docsUrl).toMatch(/^https:\/\//);
      expect(t.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.name.length).toBeGreaterThan(1);
      expect(t.description.length).toBeGreaterThan(10);
      if (t.auth.kind === 'bearer' || t.auth.kind === 'optional_bearer' || t.auth.kind === 'header') expect(t.auth.headerName).toBeTruthy();
      if (t.auth.kind === 'oauth') expect(t.auth.note).toBeTruthy();
    }
  });

  it('no stdio / filesystem servers — remote only', () => {
    for (const t of MCP_SERVER_TEMPLATES) expect(`${t.id} ${t.description}`).not.toMatch(/filesystem|stdio|npx /i);
  });
});

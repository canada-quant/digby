/**
 * /help link-rewriting pins: relative same-repo .md links in the synced docs
 * must become /help/<slug> routes (anchors preserved), while external,
 * in-doc-anchor, and non-allowlisted links are left alone (the renderer turns
 * the last group into plain text rather than a broken navigation).
 */

import { describe, expect, it } from 'vitest';
import { normalizePosixPath, rewriteDocHref, slugifyHeading } from './help-links';

// The synced allowlist (mirrors scripts/sync-help-docs.mjs).
const SLUG_BY_SOURCE = new Map([
  ['docs/SELF_HOST.md', 'self-host'],
  ['docs/DIGBY_EDGE_TESTING.md', 'edge-testing'],
  ['docs/IMESSAGE_AGENT.md', 'imessage-agent'],
  ['imessage-agent/README.md', 'imessage-agent-install'],
  ['macos-app/README.md', 'macos-app'],
  ['docs/DIGBY_MCP.md', 'digby-mcp'],
  ['docs/DIGBY_PLATFORM_API.md', 'platform-api'],
  ['docs/api-reference.md', 'api-reference'],
  ['docs/DEPTH_AND_DIG_DEEPER.md', 'depth'],
]);

describe('rewriteDocHref', () => {
  it('rewrites same-dir ./X.md links (the DIGBY_MCP → PLATFORM_API case)', () => {
    expect(rewriteDocHref('./DIGBY_PLATFORM_API.md', 'docs/DIGBY_MCP.md', SLUG_BY_SOURCE))
      .toBe('/help/platform-api');
  });

  it('preserves #anchor fragments', () => {
    expect(rewriteDocHref('./SELF_HOST.md#quick-start', 'docs/DIGBY_MCP.md', SLUG_BY_SOURCE))
      .toBe('/help/self-host#quick-start');
  });

  it('resolves ../ links against the source dir', () => {
    expect(rewriteDocHref('../docs/DIGBY_MCP.md', 'macos-app/README.md', SLUG_BY_SOURCE))
      .toBe('/help/digby-mcp');
  });

  it('treats bare docs/X.md as repo-relative', () => {
    expect(rewriteDocHref('docs/api-reference.md', 'docs/SELF_HOST.md', SLUG_BY_SOURCE))
      .toBe('/help/api-reference');
  });

  it('treats a leading slash as repo-relative', () => {
    expect(rewriteDocHref('/docs/IMESSAGE_AGENT.md', 'docs/SELF_HOST.md', SLUG_BY_SOURCE))
      .toBe('/help/imessage-agent');
  });

  it('returns null for docs outside the allowlist (renders as plain text)', () => {
    expect(rewriteDocHref('../macos-pkg/README.md', 'macos-app/README.md', SLUG_BY_SOURCE)).toBeNull();
    expect(rewriteDocHref('./BACKUPS.md', 'docs/SELF_HOST.md', SLUG_BY_SOURCE)).toBeNull();
  });

  it('leaves external, schemed, anchor-only, and non-md links alone', () => {
    expect(rewriteDocHref('https://example.com/x.md', 'docs/SELF_HOST.md', SLUG_BY_SOURCE)).toBeNull();
    expect(rewriteDocHref('//example.com/x.md', 'docs/SELF_HOST.md', SLUG_BY_SOURCE)).toBeNull();
    expect(rewriteDocHref('#requirements', 'docs/SELF_HOST.md', SLUG_BY_SOURCE)).toBeNull();
    expect(rewriteDocHref('./docker-compose.selfhost.yml', 'docs/SELF_HOST.md', SLUG_BY_SOURCE)).toBeNull();
    expect(rewriteDocHref(undefined, 'docs/SELF_HOST.md', SLUG_BY_SOURCE)).toBeNull();
  });
});

describe('slugifyHeading', () => {
  it('matches GitHub slugs (lowercase, punctuation stripped, spaces → hyphens)', () => {
    expect(slugifyHeading('Quick start')).toBe('quick-start');
    expect(slugifyHeading('Topology A — local server as CLOUD + Mac/dev checkout as EDGE (easiest)'))
      .toBe('topology-a--local-server-as-cloud--macdev-checkout-as-edge-easiest');
    expect(slugifyHeading('What you get')).toBe('what-you-get');
  });
});

describe('normalizePosixPath', () => {
  it('collapses . and .. segments', () => {
    expect(normalizePosixPath('docs/./X.md')).toBe('docs/X.md');
    expect(normalizePosixPath('macos-app/../docs/X.md')).toBe('docs/X.md');
    expect(normalizePosixPath('a/b/c/../../X.md')).toBe('a/X.md');
  });
});

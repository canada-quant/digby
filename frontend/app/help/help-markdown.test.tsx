/**
 * HelpMarkdown render pins (react-dom/server, the same pattern as
 * assistant-parts.test.tsx): the /help doc renderer must rewrite allowlisted
 * repo-doc links to /help/<slug> (anchor preserved), give headings GitHub-style
 * ids, render GFM (tables), and never turn non-allowlisted .md links into
 * broken navigations.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HelpMarkdown } from './help-markdown';

const DOCS = [
  { slug: 'digby-mcp', source: 'docs/DIGBY_MCP.md' },
  { slug: 'platform-api', source: 'docs/DIGBY_PLATFORM_API.md' },
];

const SAMPLE = [
  '# Doc Title',
  '',
  '## Quick start',
  '',
  'See the [Platform API](./DIGBY_PLATFORM_API.md#authentication), the [ops runbook](./BACKUPS.md),',
  'an [external spec](https://example.com/spec.md), and [below](#details).',
  '',
  '## Details',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
].join('\n');

const html = renderToStaticMarkup(
  createElement(HelpMarkdown, { content: SAMPLE, currentSource: 'docs/DIGBY_MCP.md', docs: DOCS }),
);

describe('HelpMarkdown', () => {
  it('renders headings with GitHub-style ids', () => {
    expect(html).toContain('id="quick-start"');
    expect(html).toContain('id="details"');
  });

  it('rewrites allowlisted repo-doc links to /help/<slug> (anchor preserved)', () => {
    expect(html).toContain('href="/help/platform-api#authentication"');
  });

  it('renders non-allowlisted repo-doc links as plain text (no broken nav)', () => {
    expect(html).not.toContain('BACKUPS.md</a>');
    expect(html).not.toContain('href="./BACKUPS.md"');
    expect(html).toContain('>ops runbook</span>');
  });

  it('leaves external links alone in a new tab', () => {
    expect(html).toContain('href="https://example.com/spec.md"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('keeps in-doc anchors same-tab', () => {
    expect(html).toContain('href="#details"');
  });

  it('renders GFM tables', () => {
    expect(html).toContain('<table');
    expect(html).toContain('<td');
  });
});

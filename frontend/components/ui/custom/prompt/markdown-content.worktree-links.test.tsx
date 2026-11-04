/**
 * Worktree interlinks through the renderer (owner 2026-09-17): beneath a
 * coding session (WorktreeOpenContext set) a bare repo path in prose renders
 * as an "open in Files tab" button; outside one the same text stays plain
 * monospace — never a dead anchor, never a navigation.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { MarkdownContent } from './markdown-content';
import { WorktreeOpenContext } from '@/lib/worktree-open-context';

const renderPlain = (md: string) => renderToStaticMarkup(createElement(MarkdownContent, null, md));
const renderInSession = (md: string) => renderToStaticMarkup(
  createElement(WorktreeOpenContext.Provider, { value: () => true }, createElement(MarkdownContent, null, md)),
);

describe('MarkdownContent — worktree interlinks', () => {
  it('in a coding session, a bare path becomes a Files-tab button carrying the path', () => {
    const html = renderInSession('Created docs/BACKUPS.md and updated backend/src/worker.ts.');
    expect(html).toContain('data-worktree-path="docs/BACKUPS.md"');
    expect(html).toContain('data-worktree-path="backend/src/worker.ts"');
    expect(html).toMatch(/<button[^>]*data-worktree-path="docs\/BACKUPS.md"[^>]*>docs\/BACKUPS.md<\/button>/);
    expect(html).not.toContain('href="#worktree:');
  });

  it('outside a session the same text renders as plain prose — no button, no link', () => {
    const html = renderPlain('Created docs/BACKUPS.md.');
    expect(html).not.toContain('data-worktree-path');
    expect(html).not.toContain('<a ');
    expect(html).toContain('docs/BACKUPS.md');
  });

  it('an explicit #worktree: link authored in markdown renders as a button in-session and as text outside', () => {
    const md = 'See [the backup notes](#worktree:docs%2FBACKUPS.md).';
    expect(renderInSession(md)).toMatch(/<button[^>]*data-worktree-path="docs\/BACKUPS.md"[^>]*>the backup notes<\/button>/);
    const plain = renderPlain(md);
    expect(plain).not.toContain('<a ');
    expect(plain).toContain('the backup notes');
  });

  it('code spans are never linkified', () => {
    const html = renderInSession('Run `cat docs/BACKUPS.md` now.');
    expect(html).not.toContain('data-worktree-path');
    expect(html).toContain('<code');
  });
});

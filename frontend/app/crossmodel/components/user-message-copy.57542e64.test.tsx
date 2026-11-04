/**
 * UserMessageCopyButton render pins (feedback ticket 57542e64, 2026-09-21) —
 * the copy shortcut on the user's OWN bubble, mirroring the assistant action
 * row's one-click copy. Same react-dom/server idiom as
 * plain-message-actions.test.tsx (node-env vitest, no jsdom): SSR the closed
 * control and pin its affordances, plus a source pin that the unified
 * transcript's user row mounts it.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { UserMessageCopyButton } from './code-transcript';

const VIEW = readFileSync(fileURLToPath(new URL('./CodeSessionView.tsx', import.meta.url)), 'utf8');

const render = () =>
  renderToStaticMarkup(createElement(UserMessageCopyButton, { content: 'ship it' }));

describe('UserMessageCopyButton (ticket 57542e64)', () => {
  it('renders one copy control with sr-only + aria labels and the Copy title', () => {
    const html = render();
    expect(html).toContain('aria-label="Copy"');
    expect(html).toContain('title="Copy message"');
    expect(html).toContain('sr-only');
    expect((html.match(/<button/g) || []).length).toBe(1);
  });

  it('is hover/focus-revealed on pointer devices but always visible on touch (the audit 2026-09-15 idiom)', () => {
    const html = render();
    expect(html).toContain('md:opacity-0 md:group-hover/msg:opacity-100 md:focus-within:opacity-100');
    // never the bare pointer-only idiom — touch has no hover
    expect(html).not.toContain('"opacity-0 group-hover:opacity-100');
  });

  it('sits under the bubble\'s right edge (absolute top-full right-2) so the row layout never shifts', () => {
    const html = render();
    expect(html).toContain('absolute top-full right-2');
  });

  it('source pin: the unified transcript mounts it on user rows with text, beside the shifted timestamps', () => {
    expect(VIEW).toContain('<UserMessageCopyButton content={m.content} />');
    // gated on actual text — an image/attachment-only row gets no dead control
    expect(VIEW).toContain("m.role === 'user' && !!m.content?.trim()");
    // the timestamps moved right-2 → right-10 to share the under-bubble line
    expect(VIEW).toContain('hidden md:block absolute top-full right-10 mt-0.5');
    expect(VIEW).toContain('md:hidden absolute top-full right-10 mt-0.5');
  });
});

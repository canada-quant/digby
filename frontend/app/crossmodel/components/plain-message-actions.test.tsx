/**
 * PlainMessageActions render pins (C3 kid flip, ticket 71b1fec6, design D5) —
 * the unified plain transcript's per-answer action row. Same react-dom/server
 * idiom as ChatFilesSection.test.tsx / PatiencePicker.test.tsx (node-env
 * vitest, no jsdom): SSR the closed row and pin which controls exist.
 *
 * The D5 kid rail: the legacy transcript shows Copy + Read aloud to EVERYONE
 * (kids included) but wraps the Report-issue control in `!isKid`. The unified
 * view must match — a kid account must never see the feedback surface.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { PlainMessageActions } from './code-transcript';

const render = (over: Partial<Parameters<typeof PlainMessageActions>[0]> = {}) =>
  renderToStaticMarkup(createElement(PlainMessageActions, {
    content: 'The answer is 42.',
    chatId: 'chat-1',
    ...over,
  }));

describe('PlainMessageActions (C3 kid flip — D5 rail)', () => {
  it('adults get Copy, Read aloud, and Report issue', () => {
    const html = render();
    expect(html).toContain('Copy');
    expect(html).toContain('Read aloud');
    expect(html).toContain('Report issue');
  });

  it('kids keep Copy + Read aloud but never see Report issue (legacy !isKid gate)', () => {
    const html = render({ isKid: true });
    expect(html).toContain('Copy');
    expect(html).toContain('Read aloud');
    expect(html).not.toContain('Report issue');
    expect(html).not.toContain('Feedback');
  });

  it('isKid: false behaves like omitted (adult row)', () => {
    expect(render({ isKid: false })).toBe(render());
  });
});

describe('PlainMessageActions — icon-only hover row (audit 2026-09-15)', () => {
  it('labels ride sr-only spans + aria-label, and the row is pointer-hover-revealed but visible on touch', () => {
    const html = render();
    expect(html).toContain('sr-only');
    expect(html).toContain('aria-label="Copy"');
    expect(html).toContain('aria-label="Read aloud"');
    expect(html).toContain('aria-label="Report issue"');
    // md-gated reveal — never the bare pointer-only idiom (p2 pins), and it
    // rides the message row's group so hovering the answer shows the row.
    expect(html).toContain('md:opacity-0 md:group-hover/msg:opacity-100 md:focus-within:opacity-100');
    expect(html).not.toContain('opacity-0 group-hover:opacity-100');
  });
});

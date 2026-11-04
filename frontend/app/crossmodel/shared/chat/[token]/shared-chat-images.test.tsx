/**
 * SharedChatImages render pins (generate_image tranche B, 2026-09-24) — the
 * public shared-chat page's generated-image figures. Same react-dom/server
 * idiom as plain-message-actions.test.tsx (node-env vitest, no jsdom).
 *
 * Pins: one framed figure per generated image, loading from the TOKEN-SCOPED
 * public byte route (never the authed /generated-files url, never a data:
 * URL even when an entry carries stray bytes); caption from `name` with the
 * "Generated image" fallback; lightbox collapsed on first render; no
 * owner-only Download / Open row; nothing rendered for an absent or empty
 * list; entries without a fileId dropped; token + id URL-encoded.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { SharedChatImages } from './shared-chat-images';
import type { SharedChatImage } from '@/lib/api/crossmodel';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
const TOKEN = 'tok123abc';

const render = (images?: SharedChatImage[] | null, token = TOKEN) =>
  renderToStaticMarkup(createElement(SharedChatImages, { token, images }));

const FOX: SharedChatImage = {
  fileId: 'f-img',
  url: `/api/crossmodel/shared/chat/${TOKEN}/image/f-img`,
  name: 'Generated · 1024×1024 · "a red fox"',
  prompt: 'a red fox in the snow',
  mediaType: 'image/png',
};

describe('SharedChatImages', () => {
  it('renders one framed figure per image from the token-scoped public byte route', () => {
    const html = render([FOX, { ...FOX, fileId: 'f-2', name: 'Second' }]);
    expect(html.match(/<figure/g)).toHaveLength(2);
    expect(html).toContain('data-image-source="generated"');
    expect(html).toContain('data-shared-chat-images="2"');
    expect(html).toContain(`src="${API_BASE}/crossmodel/shared/chat/${TOKEN}/image/f-img"`);
    expect(html).toContain(`src="${API_BASE}/crossmodel/shared/chat/${TOKEN}/image/f-2"`);
    // The transcript's framed-figure classes (bordered thumbnail, capped height).
    expect(html).toContain('max-h-72 max-w-full rounded-lg border border-border object-contain');
  });

  it('captions from `name` (alt too) and falls back to "Generated image"', () => {
    const html = render([FOX]);
    expect(html).toContain('<figcaption');
    expect(html).toContain('Generated · 1024×1024 · &quot;a red fox&quot;');
    expect(html).toContain('alt="Generated · 1024×1024 · &quot;a red fox&quot;"');
    const bare = render([{ fileId: 'f-3', url: '/x' }]);
    expect(bare).toContain('>Generated image</figcaption>');
    expect(bare).toContain('alt="Generated image"');
  });

  it('never uses the authed /generated-files url or a data: URL, even when an entry carries stray bytes', () => {
    const html = render([{ ...FOX, url: '/api/crossmodel/generated-files/f-img/inline', data: 'iVBORw0KGgo=' } as SharedChatImage]);
    expect(html).not.toContain('/generated-files/');
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('iVBORw0KGgo=');
    expect(html).toContain(`/crossmodel/shared/chat/${TOKEN}/image/f-img"`);
  });

  it('opens a lightbox on click but mounts it collapsed (SSR = trigger + <img> only), with no owner-only Download / Open row', () => {
    const html = render([FOX]);
    expect(html).toContain('cursor-zoom-in');
    expect(html).toContain('aria-label="Expand image: Generated · 1024×1024 · &quot;a red fox&quot;"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('data-generated-image-actions');
    expect(html).not.toContain('Download');
  });

  it('renders nothing for an absent, null, empty, or fileId-less list', () => {
    expect(render(undefined)).toBe('');
    expect(render(null)).toBe('');
    expect(render([])).toBe('');
    expect(render([{ fileId: '', url: '/x' }, null as unknown as SharedChatImage])).toBe('');
  });

  it('drops entries without a fileId but keeps the rest', () => {
    const html = render([{ fileId: '', url: '/x' }, FOX]);
    expect(html.match(/<figure/g)).toHaveLength(1);
    expect(html).toContain('data-shared-chat-images="1"');
  });

  it('URL-encodes the token and file id', () => {
    const html = render([{ fileId: 'f 1/?', url: '/x' }], 'a b/c');
    expect(html).toContain(`src="${API_BASE}/crossmodel/shared/chat/a%20b%2Fc/image/f%201%2F%3F"`);
  });
});

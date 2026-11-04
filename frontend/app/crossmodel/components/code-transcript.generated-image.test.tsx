/**
 * Generated images in the transcript (owner ask 2026-09-24: "add image
 * generation model and admin endpoint and defaults to generate images").
 *
 * Node-environment vitest idiom (no jsdom, no effects — same as
 * assistant-parts.test.tsx / ChatFilesSection.test.tsx): render AssistantParts
 * via react-dom/server and assert on the static markup.
 *
 * Contract under test:
 *   - a `source:'generated'` image part takes the framed-figure path with
 *     `data-image-source="generated"` (never the screenshot attribute), the
 *     caption falls back to "Generated image", there is NO bg-white behind a
 *     transparent PNG, and a Download + Open action row appears when the part
 *     carries the GeneratedFile id;
 *   - a url-only persisted part (the transcript reload strips no bytes — the
 *     part never had any) renders from its lazy inline route; a live part
 *     with base64 `data` renders instantly from the data: URL;
 *   - the markdown path (defence in depth when a model embeds the inline
 *     route anyway) recognises /generated-files/<uuid>/inline as an authed
 *     image while the download route stays a document card.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { AssistantParts, generatedImageFilename } from './code-transcript';
import { imagePartFromFrame } from '@/lib/image-frame-part';
import type { MessagePart } from '@/lib/api/coding';
import { MarkdownContent } from '@/components/ui/custom/prompt/markdown-content';
import { authedImageTarget, authedImageUrl, parseFileLinkHref } from '@/components/ui/custom/prompt/file-link-card';

const FILE_ID = '11111111-2222-3333-4444-555555555555';
const INLINE = `/api/crossmodel/generated-files/${FILE_ID}/inline`;
const DOWNLOAD = `/api/crossmodel/generated-files/${FILE_ID}/download`;

const generated = (over: Partial<MessagePart> = {}): MessagePart => ({
  type: 'image',
  mediaType: 'image/png',
  url: INLINE,
  name: 'Generated · 1024×1024 · "a red fox"',
  source: 'generated',
  fileId: FILE_ID,
  prompt: 'a red fox in the snow',
  ...over,
} as MessagePart);

const html = (parts: MessagePart[]) =>
  renderToStaticMarkup(createElement(AssistantParts, { parts, disableGrouping: true }));

describe('AssistantParts — generated image figure (2026-09-24)', () => {
  it('a url-only generated part renders a figure with the generated attribute, caption, Download and Open — and no bg-white', () => {
    const out = html([generated()]);
    expect(out).toContain('<figure');
    expect(out).toContain('data-image-source="generated"');
    expect(out).not.toContain('data-screenshot-source');
    // Lazy inline route is the <img src> (no base64 in the persisted part).
    expect(out).toContain(`src="${INLINE}"`);
    expect(out).toContain('Generated · 1024×1024');
    // Action row keyed on the file id.
    expect(out).toContain(`data-generated-image-actions="${FILE_ID}"`);
    expect(out).toContain('Download image-11111111.png');
    expect(out).toContain('Open image in a new tab');
    // Transparent PNGs must not sit on a white slab.
    expect(out).not.toContain('bg-white');
    // The lightbox stays collapsed on first render (ExpandableDataImage idiom).
    expect(out).toContain('cursor-zoom-in');
  });

  it('caption falls back to "Generated image" when the part carries no name', () => {
    const out = html([generated({ name: undefined })]);
    expect(out).toContain('Generated image');
    expect(out).toContain('alt="Generated image"');
  });

  it('a live part with base64 data renders instantly from the data: URL (url kept for the reload)', () => {
    const out = html([generated({ data: 'iVBORw0KGgo=' })]);
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(out).toContain('data-image-source="generated"');
  });

  it('no fileId → the figure renders but the action row does not', () => {
    const out = html([generated({ fileId: undefined })]);
    expect(out).toContain('data-image-source="generated"');
    expect(out).not.toContain('data-generated-image-actions');
    expect(out).not.toContain('Open image in a new tab');
  });

  it('regression: browser / computer screenshots keep their attribute, bg-white and captions', () => {
    const out = html([
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', source: 'browser', pageUrl: 'https://example.com' } as MessagePart,
      { type: 'image', mediaType: 'image/jpeg', data: 'aGVsbG8=', source: 'computer', app: 'Chrome' } as MessagePart,
    ]);
    expect(out.match(/data-screenshot-source="browser"/g) || []).toHaveLength(1);
    expect(out.match(/data-screenshot-source="computer"/g) || []).toHaveLength(1);
    expect(out).not.toContain('data-image-source');
    expect(out.match(/bg-white/g) || []).toHaveLength(2);
    expect(out).toContain('Final page');
    expect(out).toContain('Final screen · Your Mac');
    expect(out).not.toContain('data-generated-image-actions');
  });

  it('a plain attached image (no source) still renders the bare thumbnail, not a figure', () => {
    const out = html([{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' } as MessagePart]);
    expect(out).not.toContain('<figure');
    expect(out).toContain('alt="attached image"');
  });

  it('generatedImageFilename derives image-<id8>.<ext> from the sniffed mime', () => {
    expect(generatedImageFilename({ fileId: FILE_ID, mediaType: 'image/png' })).toBe('image-11111111.png');
    expect(generatedImageFilename({ fileId: FILE_ID, mediaType: 'image/jpeg' })).toBe('image-11111111.jpg');
    expect(generatedImageFilename({ fileId: FILE_ID, mediaType: 'image/webp' })).toBe('image-11111111.webp');
    expect(generatedImageFilename({})).toBe('image-generate.png');
  });
});

describe('markdown path — generated inline route as an authed image (defence in depth)', () => {
  const md = (s: string) => renderToStaticMarkup(createElement(MarkdownContent, null, s));

  it('parseFileLinkHref recognises /generated-files/<uuid>/inline as generated inline; download keeps the legacy shape', () => {
    expect(parseFileLinkHref(INLINE)).toEqual({ kind: 'generated', id: FILE_ID, route: 'inline' });
    expect(parseFileLinkHref(`${INLINE}/?token=abc`)).toEqual({ kind: 'generated', id: FILE_ID, route: 'inline' });
    expect(parseFileLinkHref(DOWNLOAD)).toEqual({ kind: 'generated', id: FILE_ID });
    expect(parseFileLinkHref(`/api/crossmodel/generated-files/${FILE_ID}/preview`)).toBeNull();
    expect(parseFileLinkHref(`/api/crossmodel/generated-files/not-a-uuid/inline`)).toBeNull();
  });

  it('authedImageTarget narrows generated inline (and any chat-file) — never a generated download', () => {
    expect(authedImageTarget(parseFileLinkHref(INLINE))).toEqual({ kind: 'generated', id: FILE_ID, route: 'inline' });
    expect(authedImageTarget(parseFileLinkHref(DOWNLOAD))).toBeNull();
    expect(authedImageTarget({ kind: 'chat-file', id: FILE_ID, route: 'download' })).toEqual({ kind: 'chat-file', id: FILE_ID, route: 'download' });
    expect(authedImageTarget(null)).toBeNull();
  });

  it('authedImageUrl builds the absolute inline byte URL for a generated image', () => {
    expect(authedImageUrl({ kind: 'generated', id: FILE_ID, route: 'inline' })).toMatch(new RegExp(`/crossmodel/generated-files/${FILE_ID}/inline$`));
    expect(authedImageUrl({ kind: 'chat-file', id: FILE_ID, route: 'inline' })).toMatch(new RegExp(`/crossmodel/files/${FILE_ID}/inline$`));
  });

  it('![img](…/inline) renders the authed image placeholder, not a broken <img src>', () => {
    const out = md(`![a red fox](${INLINE})`);
    expect(out).toContain('data-authed-file-image="loading"');
    expect(out).toContain('aria-label="a red fox"');
    expect(out).not.toContain(`<img src="${INLINE}"`);
  });

  it('[pic](…/inline) as a bare link also renders the authed image; the download route stays a document card', () => {
    expect(md(`[pic](${INLINE})`)).toContain('data-authed-file-image="loading"');
    const card = md(`[report.xlsx](${DOWNLOAD})`);
    expect(card).toContain('data-file-link-card="generated"');
    expect(card).not.toContain('data-authed-file-image');
  });
});

describe('live image frame → figure with actions (2026-09-24 review — both lanes map through lib/image-frame-part)', () => {
  const liveFrame = { mediaType: 'image/png', data: 'AAAA', name: 'Generated · "fox"', source: 'generated', url: INLINE, fileId: FILE_ID, prompt: 'a fox' };

  it('a LIVE frame with base64 + fileId renders the instant data: src AND the Download / Open row — no reload needed', () => {
    const part = imagePartFromFrame(liveFrame);
    expect(part).toMatchObject({ type: 'image', source: 'generated', data: 'AAAA', url: INLINE, fileId: FILE_ID, prompt: 'a fox' });
    const out = html([part!]);
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('data-image-source="generated"');
    expect(out).toContain(`data-generated-image-actions="${FILE_ID}"`);
    expect(out).toContain('Open image in a new tab');
  });

  it('a url-only REPLAYED frame (the durable log strips the base64) renders from the lazy inline route with the same actions', () => {
    const { data: _bytes, ...replayed } = liveFrame;
    const part = imagePartFromFrame(replayed);
    expect(part).not.toHaveProperty('data');
    const out = html([part!]);
    expect(out).toContain(`src="${INLINE}"`);
    expect(out).toContain(`data-generated-image-actions="${FILE_ID}"`);
  });

  it('CodeSessionView maps every image frame through imagePartFromFrame (source pin — the field whitelist that dropped fileId is gone)', () => {
    const src = readFileSync(fileURLToPath(new URL('./CodeSessionView.tsx', import.meta.url)), 'utf8');
    expect(src).toContain("import { imagePartFromFrame } from '@/lib/image-frame-part';");
    expect(src).toContain("else if (type === 'image') { const imagePart = imagePartFromFrame(data); if (imagePart) pushPart(imagePart); }");
    expect(src).not.toMatch(/type === 'image'\) \{ if \(typeof data\?\.data === 'string'/);
  });
});

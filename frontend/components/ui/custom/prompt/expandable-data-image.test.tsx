/**
 * Tests for ExpandableDataImage (ticket c6e8edda follow-up) — the shared
 * click-to-expand wrapper for base64 data-URL image parts in transcript rows
 * (AssistantParts + CodeSessionView history/queued echoes).
 *
 * Same idiom as image-lightbox.test.tsx: node-environment SSR
 * (renderToStaticMarkup — no jsdom, no effects, no synthetic clicks), so the
 * assertable contract is the COLLAPSED first render — a zoom trigger wrapping
 * the untouched thumbnail <img>, and NO eager dialog markup. The dialog's own
 * semantics are pinned in image-lightbox.test.tsx.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ExpandableDataImage } from './expandable-data-image';

const SRC = 'data:image/png;base64,aGVsbG8=';

const render = (alt?: string, className?: string) =>
  renderToStaticMarkup(createElement(ExpandableDataImage, { src: SRC, alt, className }));

describe('ExpandableDataImage — SSR markup', () => {
  it('renders the thumbnail img byte-for-byte (src, alt, caller classes)', () => {
    const html = render('photo.png', 'my-1.5 max-h-48 max-w-full rounded-lg object-contain');
    expect(html).toContain(`src="${SRC}"`);
    expect(html).toContain('alt="photo.png"');
    // The caller's thumbnail sizing passes through untouched (max-h-48 cap).
    expect(html).toContain('class="my-1.5 max-h-48 max-w-full rounded-lg object-contain"');
  });

  it('wraps the thumbnail in a zoom trigger labelled from the alt text', () => {
    const html = render('photo.png');
    expect(html).toContain('<button');
    expect(html).toContain('cursor-zoom-in');
    expect(html).toContain('aria-label="Expand image: photo.png"');
    expect(html).toContain('title="Expand image: photo.png"');
  });

  it('an alt-less image falls back to a generic expand label and empty alt', () => {
    const html = render();
    expect(html).toContain('aria-label="Expand image"');
    expect(html).toContain('alt=""');
  });

  it('mounts NO lightbox dialog before a click (collapsed first render)', () => {
    expect(render('photo.png')).not.toContain('role="dialog"');
  });
});

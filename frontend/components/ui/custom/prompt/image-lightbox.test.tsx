/**
 * Tests for the ImageLightbox (ticket c6e8edda).
 *
 * Same idiom as file-link-card.test.tsx: the repo's component tests run under
 * the node-environment SSR idiom (renderToStaticMarkup — no jsdom), so DOM
 * key/click events can't fire. The lightbox therefore exports its close
 * DECISIONS as pure helpers (lightboxKeyCloses / isBackdropSelfClick) and the
 * interactive contract is pinned at the logic level; SSR markup pins the
 * dialog semantics (role/aria-modal, the image src, the close button, the
 * backdrop zoom-out affordance). Body scroll lock + focus handoff are
 * effect-only (the mount useEffect) and not SSR-assertable — by design.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ImageLightbox, isBackdropSelfClick, lightboxKeyCloses } from './image-lightbox';

const SRC = 'blob:http://localhost/fake-object-url';

const render = (alt?: string) =>
  renderToStaticMarkup(createElement(ImageLightbox, { src: SRC, alt, onClose: () => {} }));

describe('lightboxKeyCloses — the keyboard close decision', () => {
  it('Escape closes', () => {
    expect(lightboxKeyCloses('Escape')).toBe(true);
  });

  it('no other key closes (Enter/Space/arrows/Tab must not dismiss)', () => {
    for (const key of ['Enter', ' ', 'Esc', 'ArrowDown', 'ArrowUp', 'Tab', 'a', '']) {
      expect(lightboxKeyCloses(key)).toBe(false);
    }
  });
});

describe('isBackdropSelfClick — the pointer close decision', () => {
  it('a press landing ON the backdrop element itself closes', () => {
    const backdrop = {};
    expect(isBackdropSelfClick(backdrop, backdrop)).toBe(true);
  });

  it('a click on a CHILD (the inner image / close button subtree) does NOT close', () => {
    const backdrop = {};
    const innerImage = {};
    expect(isBackdropSelfClick(innerImage, backdrop)).toBe(false);
  });

  it('a null/undefined target never closes', () => {
    expect(isBackdropSelfClick(null, {})).toBe(false);
    expect(isBackdropSelfClick(undefined, {})).toBe(false);
  });
});

describe('ImageLightbox — SSR markup', () => {
  it('renders the image src full-size (object-contain, capped at 95vw/95vh)', () => {
    const html = render('diagram');
    expect(html).toContain(`src="${SRC}"`);
    expect(html).toContain('max-w-[95vw]');
    expect(html).toContain('max-h-[95vh]');
    expect(html).toContain('object-contain');
  });

  it('is a modal dialog labelled from the alt text', () => {
    const html = render('floor plan');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Expanded image: floor plan"');
    expect(html).toContain('alt="floor plan"');
  });

  it('falls back to a generic label and empty alt without alt text', () => {
    const html = render();
    expect(html).toContain('aria-label="Expanded image"');
    expect(html).toContain('alt=""');
  });

  it('has an explicit close button advertising Esc', () => {
    const html = render();
    expect(html).toContain('aria-label="Close expanded image"');
    expect(html).toContain('title="Close (Esc)"');
  });

  it('the backdrop is a fixed overlay with the zoom-out affordance', () => {
    const html = render();
    expect(html).toContain('fixed inset-0');
    expect(html).toContain('bg-black/80');
    expect(html).toContain('cursor-zoom-out');
    expect(html).toContain('tabindex="-1"'); // focus target on open, no focus ring
  });
});

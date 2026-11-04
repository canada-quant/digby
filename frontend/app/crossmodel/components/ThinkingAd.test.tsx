/**
 * ThinkingAd size-cap tests (ticket c43b9cc5 — owner report: "google adx will
 * breakout and not listen always to your ad sizes… put it in a container that
 * isnt larger than 336x280").
 *
 * The repo's vitest idiom is a NODE environment (no jsdom — see
 * ChatFilesSection.test.tsx), so these tests target the component's PURE
 * exports (the declared GPT size list, the cap constants, the SafeFrame
 * config helper) plus the static container markup via react-dom/server —
 * the useEffect GPT wiring is exercised in production only.
 *
 * The three breakout vectors pinned here:
 *   1. 'fluid' in the size list (fluid creatives size to the container);
 *   2. declared sizes larger than the spot (468×60 / 400×480 / 300×600 …);
 *   3. SafeFrame rich-media expansion (allowed by default).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ThinkingAd, {
  AD_MAX_WIDTH,
  AD_MAX_HEIGHT,
  AD_RESERVE_HEIGHT,
  AD_RESERVE_TIMEOUT_MS,
  GPT_AD_SIZES,
  buildSafeFrameConfig,
} from './ThinkingAd';

describe('GPT_AD_SIZES (ticket c43b9cc5)', () => {
  it('declares ONLY sizes within the 336×280 cap', () => {
    expect(GPT_AD_SIZES.length).toBeGreaterThan(0);
    for (const entry of GPT_AD_SIZES) {
      expect(Array.isArray(entry)).toBe(true);
      const [w, h] = entry as unknown as [number, number];
      expect(w).toBeLessThanOrEqual(AD_MAX_WIDTH);
      expect(h).toBeLessThanOrEqual(AD_MAX_HEIGHT);
    }
  });

  it('contains NO fluid size (the breakout vector that sizes to the container)', () => {
    expect(GPT_AD_SIZES).not.toContain('fluid');
    expect(GPT_AD_SIZES.every((s) => Array.isArray(s))).toBe(true);
  });

  it('still declares the full-size 336×280 rectangle', () => {
    expect(GPT_AD_SIZES).toContainEqual([336, 280]);
  });

  it('drops every oversized size the owner complained about', () => {
    const oversized: Array<[number, number]> = [
      [468, 60], [400, 480], [300, 600], [400, 300], [400, 400], [320, 480], [320, 320], [300, 300],
    ];
    for (const size of oversized) expect(GPT_AD_SIZES).not.toContainEqual(size);
  });
});

describe('buildSafeFrameConfig (ticket c43b9cc5)', () => {
  it('locks BOTH SafeFrame expansion vectors (overlay + push)', () => {
    expect(buildSafeFrameConfig()).toEqual({
      safeFrame: { allowOverlayExpansion: false, allowPushExpansion: false },
    });
  });
});

describe('ThinkingAd container markup (ticket c43b9cc5)', () => {
  const html = renderToStaticMarkup(createElement(ThinkingAd));

  it('renders the GPT slot div', () => {
    expect(html).toContain('id="div-gpt-ad-1787251643252-0"');
  });

  it('hard-caps the slot container at 336×280 (the defensive CSS backstop)', () => {
    expect(html).toContain('max-width:336px');
    expect(html).toContain('max-height:280px');
  });

  it('keeps overflow hidden so a misconfigured creative can never push the layout', () => {
    expect(html).toContain('overflow-hidden');
  });

  it('centers the slot and the creative inside it (owner 2026-10-07: "center the google ads better")', () => {
    expect(html).toContain('items-center');
    expect(html).toContain('[&amp;_iframe]:mx-auto');
    expect(html).toContain('[&amp;_iframe]:block');
    expect(html).toContain('text-center');
  });
});

/**
 * Ticket 73a56b14 (owner): reserve the ad container's height so the async
 * creative fill never pushes the chat upwards. The initial (pending) render
 * must already carry the reservation; the constant must cover the tallest
 * possible filled content so the fill can never exceed it.
 */
describe('ThinkingAd reserved height (ticket 73a56b14)', () => {
  const html = renderToStaticMarkup(createElement(ThinkingAd));

  it('reserves the container height from the very first (pending) paint', () => {
    expect(html).toContain(`min-height:${AD_RESERVE_HEIGHT}px`);
  });

  it('reservation covers the tallest possible filled content (280 creative + caption + padding)', () => {
    // caption ≈ 19px (10px text ≈ 15px line + mb-1 4px) + pt-1/pb-3 = 16px.
    expect(AD_RESERVE_HEIGHT).toBeGreaterThanOrEqual(AD_MAX_HEIGHT + 35);
  });

  it('reservation matches the owner-requested 336px', () => {
    expect(AD_RESERVE_HEIGHT).toBe(336);
  });

  it('keeps the Ad Manager body-tag placeholder min-height on the slot div itself', () => {
    expect(html).toContain('min-height:50px');
  });

  it('has a sane ad-blocker fallback window (no permanent blank box, no premature collapse)', () => {
    expect(AD_RESERVE_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(AD_RESERVE_TIMEOUT_MS).toBeLessThanOrEqual(10000);
  });
});

describe('AdSense retirement consistency (ticket 73a56b14, PR #586 review B1)', () => {
  const adsTxt = readFileSync(new URL('../../../public/ads.txt', import.meta.url), 'utf8');
  const layoutSrc = readFileSync(new URL('../../layout.tsx', import.meta.url), 'utf8');

  it('ads.txt authorizes ONLY the Google Ad Manager account', () => {
    const lines = adsTxt.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines).toEqual(['google.com, pub-5522451507419838, DIRECT, f08c47fec0942fa0']);
  });

  it('the retired AdSense account is gone from the root layout (loader + meta tags)', () => {
    // #587 removed the ads.txt authorization while layout.tsx still loaded
    // ca-pub-4628533107230459 on every page — an inconsistent retirement that
    // de-authorizes a live-loaded account. The retirement must cover both.
    expect(layoutSrc).not.toContain('ca-pub-4628533107230459');
    expect(layoutSrc).not.toContain('adsbygoogle.js');
    expect(adsTxt).not.toContain('pub-4628533107230459');
  });
});

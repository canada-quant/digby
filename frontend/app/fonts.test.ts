// Self-hosted fonts (2026-10-20): the production build must never fetch
// Google Fonts — a font-download failure on box A failed two deploy waves in
// a row (runs 39371197292, 39373474506). Pins that layout.tsx does not go
// back to next/font/google and that every file fonts.css or the layout
// references actually ships in public/fonts/.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(path(rel), 'utf8');

describe('self-hosted fonts', () => {
  const layout = read('./layout.tsx');
  const css = read('./fonts.css');

  it('layout.tsx never imports next/font/google (no network fetch at build time)', () => {
    expect(layout).not.toMatch(/from ['"]next\/font\/google['"]/);
    expect(layout).toContain("import './fonts.css'");
  });

  it('every @font-face url and every preloaded font exists in public/fonts', () => {
    const urls = [...css.matchAll(/url\((\/fonts\/[0-9a-f]+\.woff2)\)/g)].map((m) => m[1]);
    const preloaded = [...layout.matchAll(/'(\/fonts\/[0-9a-f]+\.woff2)'/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    expect(preloaded).toHaveLength(4);
    for (const u of [...urls, ...preloaded]) expect(existsSync(path(`../public${u}`)), u).toBe(true);
    for (const p of preloaded) expect(urls, p).toContain(p);
  });

  it('keeps the three families, their fallback metrics and the variables globals.css reads', () => {
    for (const family of ['Geist', 'Newsreader', 'Geist Mono']) {
      expect(css).toContain(`font-family:${family};`);
      expect(css).toContain(`font-family:${family} Fallback;`);
    }
    for (const v of ['--text-family', '--serif-family', '--mono-family']) expect(css).toContain(`${v}:`);
    expect(layout).toContain('className="dg-font-vars"');
    expect(layout).toContain('dg-font-text');
  });
});

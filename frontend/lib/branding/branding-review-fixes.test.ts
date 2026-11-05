/**
 * Regression pins for the defects an INDEPENDENT REVIEW found in the first cut
 * of the branding core (2026-11-05, todo d2d32b57).
 *
 * Every test here corresponds to a defect that was LIVE on main in
 * f79dbb165e. The rule for this file: a test that would also pass on the
 * pre-fix code is worthless — so each one asserts the specific shape that was
 * wrong, not merely that branding "works" (lib/branding/branding.test.ts
 * already covers the happy paths).
 *
 * Review defects covered:
 *  D1 blocking — PWAInstallPrompt rendered OUTSIDE BrandingProvider, so a
 *     rebranded instance still said "Install Digby".
 *  D2 blocking — BrandLogo captured the scheme in useState's one-shot
 *     initialiser, so the light/dark variants never switched after mount.
 *  D3 blocking — 10 metadata titles still hardcoded "Digby" while the docs
 *     claimed the name reaches "every visible name"; crossmodel/layout's
 *     siteName contradicted lib/site/seo.ts for the same field.
 *  D4 — the spinner's promised "then the shipped mark" step did not exist.
 *  D5 — SVG logos returned 400 through next/image (no dangerouslyAllowSVG).
 *  D6 — the rebranded manifest dropped `any maskable` and kept Digby's
 *     shortcut icons.
 *  D7 — the production Docker stage read an ARG that never crossed `FROM`.
 *  D8 — a typo'd LOGO_LIGHT/DARK fell back to Digby's mark, not the
 *     operator's logo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandText, logoIsRaster, resolveBranding, DEFAULT_BRANDING, logoForScheme } from './index';

const FRONTEND_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(FRONTEND_ROOT, rel), 'utf8');

// ── D1 — every branding consumer is inside the provider ─────────────────────
describe('D1: the install prompt renders INSIDE the branding provider', () => {
  const layout = read('app/layout.tsx');

  it('PWAInstallPrompt sits between <BrandingProvider> and its close', () => {
    const open = layout.indexOf('<BrandingProvider');
    const prompt = layout.indexOf('<PWAInstallPrompt');
    const close = layout.indexOf('</BrandingProvider>');
    expect(open).toBeGreaterThan(-1);
    expect(prompt).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(-1);
    // The pre-fix layout had `close < prompt` — this ordering is the fix.
    expect(open).toBeLessThan(prompt);
    expect(prompt).toBeLessThan(close);
  });

  it('the prompt actually reads the branding (so the pin above means something)', () => {
    const prompt = read('src/components/PWAInstallPrompt.tsx');
    expect(prompt).toContain('useBranding');
    expect(prompt).toContain('Install {branding.name}');
    expect(prompt).toContain('branding.assets.icon192');
    // The Digby literal must be gone from the visible copy.
    expect(prompt).not.toContain('Install Digby for the best experience');
  });
});

// ── D2 — the scheme is derived per render ───────────────────────────────────
describe('D2: a light/dark logo switch takes effect without a remount', () => {
  const logo = read('components/ui/custom/BrandLogo.tsx');

  it('does NOT capture the resolved src in a useState initialiser', () => {
    // The exact pre-fix defect: `const [src, setSrc] = useState(configured)`.
    // A one-shot initialiser runs while resolvedTheme is still undefined, so
    // the LIGHT variant latches permanently.
    expect(logo).not.toMatch(/useState\(\s*configured\s*\)/);
    expect(logo).toContain('logoForScheme');
  });

  it('keys the failure fallback by SOURCE, not a bare boolean latch', () => {
    // Pre-fix: a single `failed` flag meant a broken light logo also
    // suppressed a perfectly good dark one after a theme switch.
    expect(logo).toContain('failedSrc');
    expect(logo).not.toMatch(/const\s*\[failed,\s*setFailed\]/);
  });

  it('the scheme selector itself distinguishes the two variants', () => {
    const b = resolveBranding({
      DIGBY_BRAND_LOGO: '/branding/asset/logo.png',
      DIGBY_BRAND_LOGO_LIGHT: '/branding/asset/l.png',
      DIGBY_BRAND_LOGO_DARK: '/branding/asset/d.png',
    });
    expect(logoForScheme(b, 'light')).toBe('/branding/asset/l.png');
    expect(logoForScheme(b, 'dark')).toBe('/branding/asset/d.png');
  });
});

// ── D3 — no hardcoded Digby metadata titles remain ──────────────────────────
describe('D3: metadata titles follow the branding name', () => {
  const wired: [string, string][] = [
    ['app/(site)/learn/page.tsx', 'BRANDING.name'],
    ['app/(site)/privacy/page.tsx', 'BRANDING.name'],
    ['app/(site)/terms/page.tsx', 'BRANDING.name'],
    ['app/help/page.tsx', 'BRANDING.name'],
    ['app/help/[slug]/page.tsx', 'branding.name'],
    ['app/crossmodel/layout.tsx', 'branding.name'],
    ['lib/site/seo.ts', 'branding.name'],
  ];

  it.each(wired)('%s reads the branding name', (file, needle) => {
    expect(read(file)).toContain(needle);
  });

  it('no "… · Digby" / "… — Digby" title literal survives', () => {
    // The exact pre-fix shapes the reviewer listed.
    for (const file of ['app/(site)/learn/page.tsx', 'app/(site)/privacy/page.tsx', 'app/(site)/terms/page.tsx', 'app/help/page.tsx']) {
      expect(read(file), file).not.toMatch(/title:\s*['"`][^'"`]*[·—]\s*Digby['"`]/);
    }
  });

  it('crossmodel/layout is internally consistent with lib/site/seo.ts', () => {
    // Both render the same openGraph.siteName; one said 'Digby', the other
    // branding.name — a self-contradicting metadata block.
    expect(read('app/crossmodel/layout.tsx')).not.toContain("siteName: 'Digby'");
    expect(read('app/crossmodel/layout.tsx')).toContain('siteName: branding.name');
  });

  it('data-driven page/article titles are rebranded at the boundary', () => {
    const seo = read('lib/site/seo.ts');
    expect(seo).toContain('brandText(p.title');
    expect(seo).toContain('brandText(a.title');
  });
});

// ── D3 helper — brandText semantics ─────────────────────────────────────────
describe('brandText — rewrites the product word only', () => {
  const acme = resolveBranding({ DIGBY_BRAND_NAME: 'Acme AI' });

  it('is a no-op on the shipped name (copy stays byte-identical)', () => {
    const s = 'Digby features — research, writing, files and code';
    expect(brandText(s, DEFAULT_BRANDING)).toBe(s);
  });

  it('rewrites the standalone word', () => {
    expect(brandText('Digby Code — an AI coding agent', acme)).toBe('Acme AI Code — an AI coding agent');
    expect(brandText('Digby vs ChatGPT', acme)).toBe('Acme AI vs ChatGPT');
  });

  it('leaves words that merely contain it alone', () => {
    expect(brandText('a Digbyish name and Digby2', acme)).toBe('a Digbyish name and Digby2');
  });

  it('handles empty input', () => {
    expect(brandText('', acme)).toBe('');
  });
});

// ── D4 — the spinner fallback ladder ────────────────────────────────────────
describe('D4: the spinner walks preferred → static twin → shipped mark', () => {
  const spinner = read('components/ui/custom/BrandSpinner.tsx');

  it('has THREE rungs, ending at the shipped mark', () => {
    expect(spinner).toContain('DEFAULT_BRANDING');
    expect(spinner).toContain('const steps = [');
    expect(spinner).toContain('branding.assets.spinnerStatic');
    // The pre-fix code stopped at the static twin via a bare boolean.
    expect(spinner).not.toMatch(/if\s*\(!failed\)\s*setFailed\(true\)/);
  });

  it('never loops back onto a URL that already 404d', () => {
    expect(spinner).toContain('failedSrc');
    expect(spinner).toContain('!== failedSrc');
  });
});

// ── D5 — SVG logos render (not a 400 from the optimizer) ────────────────────
describe('D5: SVG logos route around next/image', () => {
  it('logoIsRaster classifies by extension, ignoring query/hash', () => {
    expect(logoIsRaster('/branding/asset/logo.svg')).toBe(false);
    expect(logoIsRaster('/branding/asset/logo.SVG')).toBe(false);
    expect(logoIsRaster('/branding/asset/logo.svg?v=2')).toBe(false);
    expect(logoIsRaster('/branding/asset/logo.png')).toBe(true);
    expect(logoIsRaster('/branding/asset/logo.webp')).toBe(true);
  });

  it('BrandLogo branches on it instead of always using next/image', () => {
    const logo = read('components/ui/custom/BrandLogo.tsx');
    expect(logo).toContain('logoIsRaster');
    expect(logo).toMatch(/<img[\s\S]*?src=\{src\}/);
  });
});

// ── D6 — the rebranded manifest keeps maskable + rebrands shortcuts ────────
describe('D6: the operator manifest keeps maskable icons and loses Digby icons', () => {
  const route = read('app/branding/manifest/route.ts');

  it('carries purpose "any maskable" on the PWA icons', () => {
    expect(route).toContain("purpose: 'any maskable'");
  });

  it('rewrites shortcut icons to the operator icon', () => {
    expect(route).toContain('base.shortcuts');
    expect(route).toContain('shortcuts,');
  });

  it('still never overrides the installed-app id', () => {
    expect(route).not.toMatch(/^\s*id:/m);
  });
});

// ── D7 — the production Docker stage can actually see the ARG ──────────────
describe('D7: Dockerfile PRODUCTION stage declares the branding ARG', () => {
  const dockerfile = read('Dockerfile');
  const productionStage = dockerfile.slice(dockerfile.indexOf('AS production'));

  it('re-declares ARG DIGBY_BRANDING_DIR after the FROM (ARGs do not cross FROM)', () => {
    expect(productionStage).toContain('ARG DIGBY_BRANDING_DIR');
    expect(productionStage).toContain('ENV DIGBY_BRANDING_DIR=$DIGBY_BRANDING_DIR');
  });

  it('the build stage still declares it too (compose passes build args)', () => {
    const buildStage = dockerfile.slice(dockerfile.indexOf('AS build'), dockerfile.indexOf('AS production'));
    expect(buildStage).toContain('ARG DIGBY_BRANDING_DIR');
  });
});

// ── D8 — a typo'd per-scheme variant falls back to the OPERATOR logo ───────
describe('D8: per-scheme variants fall back to the operator logo, not Digby\'s', () => {
  it('an invalid LOGO_LIGHT keeps the operator logo', () => {
    const b = resolveBranding({
      DIGBY_BRAND_LOGO: '/branding/asset/logo.png',
      DIGBY_BRAND_LOGO_LIGHT: 'https://evil.example/l.png', // rejected
    });
    expect(b.assets.logo).toBe('/branding/asset/logo.png');
    expect(b.assets.logoLight).toBe('/branding/asset/logo.png');
    expect(logoForScheme(b, 'light')).toBe('/branding/asset/logo.png');
    expect(logoForScheme(b, 'light')).not.toBe(DEFAULT_BRANDING.assets.logo);
  });

  it('an invalid LOGO_DARK keeps the operator logo', () => {
    const b = resolveBranding({
      DIGBY_BRAND_LOGO: '/branding/asset/logo.png',
      DIGBY_BRAND_LOGO_DARK: '../escape.png',
    });
    expect(logoForScheme(b, 'dark')).toBe('/branding/asset/logo.png');
  });

  it('with no operator logo at all it still falls back to the shipped mark', () => {
    const b = resolveBranding({ DIGBY_BRAND_LOGO_DARK: 'nope' });
    expect(logoForScheme(b, 'dark')).toBe(DEFAULT_BRANDING.assets.logo);
  });
});

// ── cosmetic: no leftover dead imports ─────────────────────────────────────
describe('review cosmetics', () => {
  it('the share pages no longer import the spinner they replaced', () => {
    for (const f of ['app/crossmodel/shared/chat/[token]/page.tsx', 'app/crossmodel/shared/project/[token]/page.tsx']) {
      expect(read(f), f).not.toContain('Loader2');
    }
  });
});
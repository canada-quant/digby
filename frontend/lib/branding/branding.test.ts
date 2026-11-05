/**
 * Shared branding core — Phase 1 self-host rebranding (todo d2d32b57).
 *
 * Three layers pinned here:
 *  1. the PURE resolver (lib/branding) — defaults, overrides, and the
 *     validation that keeps an operator value from breaking a page or
 *     escaping the instance (off-site logo, markup injection, 200-char name);
 *  2. the operator ASSET route's path jail (app/branding/asset/[...path]) —
 *     traversal, dotfiles, non-image types;
 *  3. SOURCE pins that the surfaces actually read the core (so a future edit
 *     cannot quietly re-hardcode 'Digby' into a rebranded surface).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BRANDING, NAME_MAX, cleanHex, cleanPath, cleanText, logoForScheme, resolveBranding,
} from './index';
import { resolveBrandingAsset } from '../../app/branding/asset/[...path]/route';

// This file lives at lib/branding/, so the frontend root is two levels up.
const FRONTEND_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(FRONTEND_ROOT, rel), 'utf8');

// ── 1. defaults ──────────────────────────────────────────────────────────────
describe('branding — defaults are the shipped Digby identity', () => {
  it('an empty env resolves to exactly today\'s values', () => {
    const b = resolveBranding({});
    expect(b).toEqual(DEFAULT_BRANDING);
    expect(b.isDefault).toBe(true);
    expect(b.name).toBe('Digby');
    expect(b.assets.logo).toBe('/digbyhat.png');
    expect(b.assets.spinner).toBe('/digbyspin.gif');
    expect(b.theme.light).toBe('#ffffff');
    expect(b.theme.dark).toBe('#171717');
  });

  it('blank / whitespace values count as unset (never as an empty name)', () => {
    const b = resolveBranding({
      DIGBY_BRAND_NAME: '   ',
      DIGBY_BRAND_LOGO: '',
      DIGBY_BRAND_THEME_COLOR: '  ',
    });
    expect(b.name).toBe('Digby');
    expect(b.assets.logo).toBe('/digbyhat.png');
    expect(b.theme.light).toBe('#ffffff');
    expect(b.isDefault).toBe(true);
  });
});

// ── 2. overrides ─────────────────────────────────────────────────────────────
describe('branding — an operator override takes effect everywhere at once', () => {
  const env = {
    DIGBY_BRAND_NAME: 'Acme AI',
    DIGBY_BRAND_NAME_SHORT: 'Acme',
    DIGBY_BRAND_TAGLINE: 'Ask once. Get the best of every model.',
    DIGBY_BRAND_DESCRIPTION: 'Acme AI runs open models on our own hardware.',
    DIGBY_BRAND_LOGO_ALT: 'Acme AI logo',
    DIGBY_BRAND_LOGO: '/branding/asset/logo.png',
    DIGBY_BRAND_LOGO_COMPACT: '/branding/asset/mark.png',
    DIGBY_BRAND_LOGO_LIGHT: '/branding/asset/logo-light.png',
    DIGBY_BRAND_LOGO_DARK: '/branding/asset/logo-dark.png',
    DIGBY_BRAND_SPINNER: '/branding/asset/spinner.gif',
    DIGBY_BRAND_SPINNER_STATIC: '/branding/asset/spinner-static.png',
    DIGBY_BRAND_FAVICON_16: '/branding/asset/favicon-16.png',
    DIGBY_BRAND_ICON_512: '/branding/asset/icon-512.png',
    DIGBY_BRAND_THEME_COLOR: '#0B7285',
    DIGBY_BRAND_THEME_COLOR_DARK: '#001F26',
  };
  const b = resolveBranding(env);

  it('name, tagline, description, alt and the composed title', () => {
    expect(b.name).toBe('Acme AI');
    expect(b.shortName).toBe('Acme');
    expect(b.tagline).toBe('Ask once. Get the best of every model.');
    expect(b.description).toBe('Acme AI runs open models on our own hardware.');
    expect(b.logoAlt).toBe('Acme AI logo');
    expect(b.title).toBe('Acme AI — Private, Canadian AI Assistant');
    expect(b.isDefault).toBe(false);
  });

  it('full + compact + light/dark logo variants resolve', () => {
    expect(b.assets.logo).toBe('/branding/asset/logo.png');
    expect(b.assets.logoCompact).toBe('/branding/asset/mark.png');
    expect(logoForScheme(b, 'light')).toBe('/branding/asset/logo-light.png');
    expect(logoForScheme(b, 'dark')).toBe('/branding/asset/logo-dark.png');
  });

  it('spinner + static twin + icons resolve', () => {
    expect(b.assets.spinner).toBe('/branding/asset/spinner.gif');
    expect(b.assets.spinnerStatic).toBe('/branding/asset/spinner-static.png');
    expect(b.assets.favicon16).toBe('/branding/asset/favicon-16.png');
    expect(b.assets.icon512).toBe('/branding/asset/icon-512.png');
  });

  it('colours normalise to lowercase hex', () => {
    expect(b.theme.light).toBe('#0b7285');
    expect(b.theme.dark).toBe('#001f26');
  });

  it('a name alone implies alt text and a compact twin (one knob is enough)', () => {
    const one = resolveBranding({ DIGBY_BRAND_NAME: 'Acme AI' });
    expect(one.logoAlt).toBe('Acme AI');
    expect(one.shortName).toBe('Acme AI');
    expect(one.assets.logoCompact).toBe(one.assets.logo); // not Digby's hat
    expect(one.assets.spinnerStatic).toBe(one.assets.logo);
  });

  it('a custom logo with no static twin never falls back to Digby\'s mark', () => {
    const one = resolveBranding({ DIGBY_BRAND_LOGO: '/branding/asset/logo.png' });
    expect(one.assets.logo).toBe('/branding/asset/logo.png');
    expect(one.assets.spinnerStatic).toBe('/branding/asset/logo.png');
  });
});

// ── 3. validation + safe fallbacks ───────────────────────────────────────────
describe('branding — invalid values fall back instead of breaking a page', () => {
  it('a too-long name is rejected, not truncated into a broken layout', () => {
    const long = 'x'.repeat(NAME_MAX + 1);
    expect(resolveBranding({ DIGBY_BRAND_NAME: long }).name).toBe('Digby');
    expect(resolveBranding({ DIGBY_BRAND_NAME: 'x'.repeat(NAME_MAX) }).name).toBe('x'.repeat(NAME_MAX));
  });

  it('off-site / protocol-relative / traversal asset paths are refused', () => {
    for (const bad of [
      'https://evil.example/logo.png',
      '//evil.example/logo.png',
      'javascript:alert(1)',
      '/branding/../../etc/passwd',
      'logo.png',
      '',
    ]) {
      expect(resolveBranding({ DIGBY_BRAND_LOGO: bad }).assets.logo, bad).toBe('/digbyhat.png');
    }
  });

  it('markup in a text value is neutralised (never injected into metadata)', () => {
    const b = resolveBranding({ DIGBY_BRAND_NAME: '<script>alert(1)</script>Acme' });
    expect(b.name).not.toContain('<');
    expect(b.name).not.toContain('>');
    expect(b.name).toContain('Acme');
  });

  it('a non-hex colour falls back to the shipped colour', () => {
    expect(cleanHex('red', '#ffffff')).toBe('#ffffff');
    expect(cleanHex('#GGGGGG', '#ffffff')).toBe('#ffffff');
    expect(cleanHex('#abc', '#ffffff')).toBe('#abc');
  });

  it('the sanitisers keep a valid value verbatim', () => {
    expect(cleanText('Acme  AI', 'Digby', 40)).toBe('Acme AI');
    expect(cleanPath('/branding/asset/logo.png', '/x.png')).toBe('/branding/asset/logo.png');
  });

  it('a hostile title suffix cannot produce an off-site canonical', () => {
    const b = resolveBranding({ DIGBY_BRAND_TITLE_SUFFIX: 'x'.repeat(200) });
    expect(b.titleSuffix).toBe(DEFAULT_BRANDING.titleSuffix);
    expect(b.title).toBe(DEFAULT_BRANDING.title);
  });
});

// ── 4. the operator asset route's path jail ──────────────────────────────────
describe('branding asset route — jailed to the operator directory', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'digby-branding-'));
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'logo.png'), 'png-bytes');
    writeFileSync(join(dir, 'nested', 'mark.svg'), '<svg/>');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, 'notes.txt'), 'not an image');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('serves an image inside the directory', () => {
    expect(resolveBrandingAsset(dir, ['logo.png'])).toBe(join(dir, 'logo.png'));
    expect(resolveBrandingAsset(dir, ['nested', 'mark.svg'])).toBe(join(dir, 'nested', 'mark.svg'));
  });

  it('refuses traversal — raw and percent-encoded', () => {
    expect(resolveBrandingAsset(dir, ['..', 'etc', 'passwd'])).toBeNull();
    expect(resolveBrandingAsset(dir, ['%2e%2e', 'etc', 'passwd'])).toBeNull();
    expect(resolveBrandingAsset(dir, ['nested%2f..%2f..%2fetc%2fpasswd'])).toBeNull();
  });

  it('refuses dotfiles, non-image types and missing files', () => {
    expect(resolveBrandingAsset(dir, ['.env'])).toBeNull();
    expect(resolveBrandingAsset(dir, ['notes.txt'])).toBeNull();
    expect(resolveBrandingAsset(dir, ['missing.png'])).toBeNull();
    expect(resolveBrandingAsset(dir, [])).toBeNull();
  });

  it('an unconfigured directory serves nothing', () => {
    expect(resolveBrandingAsset('', ['logo.png'])).toBeNull();
  });

  it('the route sets nosniff and an explicit image Content-Type', () => {
    const src = read('app/branding/asset/[...path]/route.ts');
    expect(src).toContain("'X-Content-Type-Options': 'nosniff'");
    expect(src).toContain("'Content-Security-Policy'");
    expect(src).toContain('DIGBY_BRANDING_DIR');
  });
});

// ── 5. the manifest contract ─────────────────────────────────────────────────
describe('branding manifest route — operator values on the shipped base', () => {
  const src = read('app/branding/manifest/route.ts');

  it('never changes the installed-app id (changing it orphans every install)', () => {
    expect(src).toContain('public/manifest.json');
    expect(src).not.toMatch(/^\s*id:/m);
  });

  it('applies name, icons and both colour schemes', () => {
    expect(src).toContain('name: b.name');
    expect(src).toContain('short_name: b.shortName');
    expect(src).toContain('theme_color: b.theme.light');
    expect(src).toContain('color_scheme_dark');
  });
});

// ── 6. source pins — the surfaces actually read the core ─────────────────────
describe('branding — the surfaces are wired to the core (no re-hardcoding)', () => {
  const surfaces: [string, string][] = [
    ['app/layout.tsx', 'brandingFromEnv'],
    ['lib/site/seo.ts', 'brandingFromEnv'],
    ['app/(site)/_components/SiteChrome.tsx', 'brandingFromEnv'],
    ['app/crossmodel/shared/layout.tsx', 'brandingFromEnv'],
    ['app/login/page.tsx', 'useBranding'],
    ['app/error.tsx', 'useBranding'],
    ['app/crossmodel/page.tsx', 'useBranding'],
    ['app/crossmodel/components/rail-parts.tsx', 'useBranding'],
    ['app/crossmodel/shared/chat/[token]/page.tsx', 'useBranding'],
    ['app/crossmodel/shared/project/[token]/page.tsx', 'useBranding'],
    ['app/crossmodel/components/LiveRunStatus.tsx', 'useBranding'],
    ['app/crossmodel/components/InAppBrowser.tsx', 'useBranding'],
    ['src/components/PWAInstallPrompt.tsx', 'useBranding'],
  ];

  it.each(surfaces)('%s reads %s', (file, symbol) => {
    expect(read(file)).toContain(symbol);
  });

  it('the loader honours reduced motion by swapping to the static twin', () => {
    const src = read('components/ui/custom/BrandSpinner.tsx');
    expect(src).toContain('usePrefersReducedMotion');
    expect(src).toContain('spinnerStatic');
    expect(src).toContain('onError');
    // An <img>, never next/image (it re-encodes and kills a GIF's animation).
    expect(src).not.toContain("from 'next/image'");
  });

  it('every rebranded surface still renders the Digby default when unconfigured', () => {
    // The context's default value is the shipped identity, so a component
    // mounted outside the provider (a test, an error boundary above the
    // layout) can never render an empty name.
    expect(read('app/branding/BrandingProvider.tsx')).toContain('createContext<Branding>(DEFAULT_BRANDING)');
  });

  it('the static PWA manifest keeps its pinned identity (installed-app id)', () => {
    const manifest = JSON.parse(read('public/manifest.json'));
    expect(manifest.id).toBe('/crossmodel');
    expect(manifest.name).toBe('Digby');
  });
});
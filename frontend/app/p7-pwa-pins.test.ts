/**
 * P7 — PWA manifest + install-prompt pins (UI overhaul Phase 7 prep).
 *
 * SOURCE-LEVEL pins (the phase0/c1 idiom — anchor on stable identifiers):
 *
 * 1. manifest.json stays valid strict JSON with the P7 identity fields
 *    (id/start_url/scope/display) and the LIGHT theme_color/background_color —
 *    the manifest only supports one value, so it carries the light half of the
 *    pair; layout.tsx's media-queried viewport.themeColor carries both.
 *
 * 2. Orientation stays unlocked: P7 dropped the `portrait-primary` lock so
 *    tablet/desktop installs can go landscape. Re-adding a lock is a
 *    regression; only "any" is acceptable if the field returns.
 *
 * 3. No broken asset references: every icon / shortcut icon / screenshot `src`
 *    must exist in public/, and each PNG's declared `sizes` must match the
 *    file's actual IHDR dimensions. Narrow screenshots must share one aspect
 *    ratio (Chrome drops mixed-ratio entries from the rich install sheet).
 *
 * 4. Shortcuts exist and point inside the app scope.
 *
 * 5. PWAInstallPrompt keeps its guards: never prompts inside the installed app
 *    (display-mode: standalone), cleans up both listeners, snoozes after
 *    dismissal, and stays on P3 tokens (no raw zinc-* palette classes).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(FRONTEND_ROOT, rel), 'utf8');

const manifest = JSON.parse(read('public/manifest.json'));

/** PNG pixel dimensions from the IHDR chunk (width @16, height @20, big-endian). */
function pngSize(rel: string): { w: number; h: number } {
  const buf = readFileSync(join(FRONTEND_ROOT, rel));
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

type ImageEntry = { src: string; sizes?: string; type?: string };

function collectImageEntries(): { where: string; entry: ImageEntry }[] {
  const out: { where: string; entry: ImageEntry }[] = [];
  for (const icon of manifest.icons ?? []) out.push({ where: 'icons', entry: icon });
  for (const shot of manifest.screenshots ?? []) out.push({ where: 'screenshots', entry: shot });
  for (const sc of manifest.shortcuts ?? [])
    for (const icon of sc.icons ?? []) out.push({ where: `shortcut "${sc.name}"`, entry: icon });
  return out;
}

// ── 1. identity + light theme colors ─────────────────────────────────────────
describe('P7.1 — manifest identity + light theme colors', () => {
  it('parses as strict JSON with the pinned identity fields', () => {
    // id stays '/crossmodel' FOREVER — it is the installed-PWA identity, and
    // changing it would orphan every home-screen install. start_url is the
    // clean root since 2026-10-14 (proxy.ts rewrites / → /crossmodel).
    expect(manifest.id).toBe('/crossmodel');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('carries the LIGHT background (#ffffff) — dark rides the media-queried meta in layout.tsx', () => {
    expect(manifest.theme_color?.toLowerCase()).toBe('#ffffff');
    expect(manifest.background_color?.toLowerCase()).toBe('#ffffff');
    // Dark splash instant (owner 2026-09-17 "top bar still white in night
    // mode"): the manifest colour is read only before the document's own
    // theme-color pair is parsed; WebKit's `color_scheme_dark` manifest member
    // (2026-05, iOS 27) covers that instant. Unknown to older engines, ignored.
    expect(manifest.color_scheme_dark?.theme_color?.toLowerCase()).toBe('#171717');
    expect(manifest.color_scheme_dark?.background_color?.toLowerCase()).toBe('#171717');
    const layout = read('app/layout.tsx');
    expect(layout).toContain("media: '(prefers-color-scheme: light)'");
    expect(layout).toContain("media: '(prefers-color-scheme: dark)'");
    // A raw unqualified <meta name="theme-color"> would override the pair.
    expect(layout).not.toContain('<meta name="theme-color"');
  });
});

// ── 2. orientation stays unlocked ─────────────────────────────────────────────
describe('P7.2 — no orientation lock', () => {
  it('manifest has no orientation lock (absent, or explicitly "any")', () => {
    expect(
      manifest.orientation === undefined || manifest.orientation === 'any',
      `orientation is "${manifest.orientation}" — P7 unlocked orientation for tablet/desktop landscape; do not re-lock`,
    ).toBe(true);
  });
});

// ── 3. no broken asset references ─────────────────────────────────────────────
describe('P7.3 — every referenced image exists and matches its declared size', () => {
  it('all icon/screenshot/shortcut-icon srcs exist in public/', () => {
    const missing = collectImageEntries()
      .filter(({ entry }) => !existsSync(join(FRONTEND_ROOT, 'public', entry.src)))
      .map(({ where, entry }) => `${where}: ${entry.src}`);
    expect(missing, 'manifest references files missing from public/:\n' + missing.join('\n')).toEqual([]);
  });

  it('declared `sizes` match actual PNG pixel dimensions', () => {
    const wrong: string[] = [];
    for (const { where, entry } of collectImageEntries()) {
      if (!entry.src.endsWith('.png') || !entry.sizes) continue;
      const { w, h } = pngSize(join('public', entry.src));
      if (entry.sizes !== `${w}x${h}`) {
        wrong.push(`${where}: ${entry.src} declares ${entry.sizes} but is ${w}x${h}`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('narrow screenshots share one aspect ratio (Chrome drops mixed-ratio entries)', () => {
    const narrow = (manifest.screenshots ?? []).filter(
      (s: { form_factor?: string }) => s.form_factor === 'narrow',
    );
    expect(narrow.length).toBeGreaterThan(0);
    const ratios = new Set(
      narrow.map((s: ImageEntry) => {
        const { w, h } = pngSize(join('public', s.src));
        return (w / h).toFixed(4);
      }),
    );
    expect(ratios.size).toBe(1);
  });
});

// ── 4. shortcuts ──────────────────────────────────────────────────────────────
describe('P7.4 — app shortcuts', () => {
  it('has shortcuts, all inside the app scope', () => {
    expect(Array.isArray(manifest.shortcuts)).toBe(true);
    expect(manifest.shortcuts.length).toBeGreaterThanOrEqual(2);
    for (const sc of manifest.shortcuts) {
      expect(sc.name, 'every shortcut needs a name').toBeTruthy();
      // Clean public paths since 2026-10-14 (proxy.ts rewrites them into app/crossmodel).
      expect(sc.url, `shortcut "${sc.name}" url must be a clean in-scope app path`).toMatch(/^\/(?:$|files$|management$)/);
      expect(sc.url).not.toMatch(/^\/crossmodel/);
    }
  });
});

// ── 5. install prompt guards + tokens ─────────────────────────────────────────
describe('P7.5 — PWAInstallPrompt keeps its guards and P3 tokens', () => {
  const src = read('src/components/PWAInstallPrompt.tsx');

  it('never prompts inside the installed app', () => {
    expect(src).toContain('display-mode: standalone');
  });

  it('cleans up both window listeners', () => {
    expect(src).toContain('removeEventListener("beforeinstallprompt"');
    expect(src).toContain('removeEventListener("appinstalled"');
  });

  it('snoozes after dismissal (shared key for banner ✕ and the native sheet)', () => {
    expect(src).toContain('DISMISSED_KEY');
    expect(src).toContain('localStorage.setItem(DISMISSED_KEY');
  });

  it('uses P3 tokens — no raw zinc palette classes', () => {
    expect(src).not.toMatch(/\b(?:bg|text|border)-zinc-\d/);
    expect(src).toContain('bg-brand');
    expect(src).toContain('bg-card');
  });
});

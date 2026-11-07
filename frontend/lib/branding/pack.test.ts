/**
 * Runtime BRANDING PACK overlay — Phase 2 Cloud (todo 61dc8aaf).
 *
 * What these pin, and why each one matters:
 *
 *  1. MERGE IS AN OVERLAY, NOT A REPLACE. A winter pack that ships only a logo
 *     must keep the instance's name; a pack that sets an accent must not blank
 *     the operator's `DIGBY_BRAND_*` colours. Every omitted field falls through
 *     to the server snapshot — which itself falls back to shipped Digby — so
 *     there is ONE fallback chain and no "default pack" to get wrong.
 *  2. LIGHT/DARK AND REDUCED MOTION. A pack fills the SAME slots the core
 *     already reads, so `logoForScheme` picks `logoDark` in dark mode and
 *     `BrandSpinner` picks `spinnerStatic` under `prefers-reduced-motion`. The
 *     pack layer adds no second selector — these tests prove the slots land
 *     where those two selectors look, and that a pack shipping only an animated
 *     spinner still yields a REAL static twin instead of Digby's hat.
 *  3. PARSE IS TOTAL. The public payload is network input: an HTML 502, a
 *     half-migrated response, or garbage must degrade to "no pack" and leave the
 *     shipped identity in place. It must never throw — it runs inside a provider
 *     that wraps the entire app.
 *  4. ROLLBACK IS THE ABSENCE OF A PACK. `applyPack(base, null)` must return the
 *     server value BYTE-FOR-BYTE, which is what makes rolling back to default a
 *     one-row delete rather than an undo of an upload.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_BRANDING, logoForScheme, resolveBranding } from './index';
import { applyPack, packAssetUrl, parseActivePack, PACK_SLOTS, type ActivePack } from './pack';

const BASE = resolveBranding({
  DIGBY_BRAND_NAME: 'Acme',
  DIGBY_BRAND_TAGLINE: 'Acme does things.',
  DIGBY_BRAND_LOGO: '/branding/asset/acme.png',
  DIGBY_BRAND_THEME_COLOR: '#101010',
});

function pack(overrides: Partial<ActivePack> = {}): ActivePack {
  return {
    id: 'pack-1',
    name: 'Winter 2026',
    manifest: {
      name: 'Acme Winter',
      shortName: 'Acme W',
      tagline: '',
      description: '',
      logoAlt: '',
      titleSuffix: 'Winter Edition',
      theme: { light: '#eef6ff', dark: '#0b1a2a', backgroundLight: '#eef6ff', backgroundDark: '#0b1a2a' },
    },
    assets: [],
    activatedAt: '2026-11-07T09:00:00.000Z',
    ...overrides,
  };
}

describe('applyPack — a pack is an overlay on the server snapshot', () => {
  it('returns the server value unchanged when no pack is active (rollback path)', () => {
    expect(applyPack(BASE, null)).toBe(BASE);
    expect(applyPack(BASE, undefined)).toBe(BASE);
  });

  it('keeps the instance name when the pack does not set one', () => {
    const applied = applyPack(BASE, pack({ manifest: { ...pack().manifest, name: '' } }));
    expect(applied.name).toBe('Acme');
    expect(applied.title).toContain('Acme');
  });

  it('keeps the operator accent when the pack theme is empty', () => {
    const applied = applyPack(BASE, pack({
      manifest: { ...pack().manifest, theme: { light: '', dark: '', backgroundLight: '', backgroundDark: '' } },
    }));
    expect(applied.theme.light).toBe('#101010');
  });

  it('overrides only what the pack supplies', () => {
    const applied = applyPack(BASE, pack());
    expect(applied.name).toBe('Acme Winter');
    expect(applied.titleSuffix).toBe('Winter Edition');
    expect(applied.title).toBe('Acme Winter — Winter Edition');
    expect(applied.theme.light).toBe('#eef6ff');
    // Untouched by the pack → still the instance's own tagline.
    expect(applied.tagline).toBe('Acme does things.');
    // A pack in force is a rebrand: isDefault must not lie.
    expect(applied.isDefault).toBe(false);
  });

  it('ignores an asset slot it does not recognise (never writes an unknown key)', () => {
    const applied = applyPack(BASE, pack({
      assets: [
        { slot: 'logo' as any, mimeType: 'image/png', width: 64, height: 64, sha256: 'a', sizeBytes: 10 },
        { slot: 'evilSlot' as any, mimeType: 'image/png', width: 1, height: 1, sha256: 'b', sizeBytes: 1 },
      ],
    }));
    expect(applied.assets.logo).toBe(packAssetUrl('pack-1', 'logo'));
    expect(Object.keys(applied.assets).sort()).toEqual([...PACK_SLOTS].sort());
  });
});

describe('applyPack — light/dark and reduced motion land where the core looks', () => {
  it('a per-scheme logo pair is selected by logoForScheme in each mode', () => {
    const applied = applyPack(BASE, pack({
      assets: [
        { slot: 'logoLight', mimeType: 'image/png', width: 200, height: 64, sha256: 'l', sizeBytes: 10 },
        { slot: 'logoDark', mimeType: 'image/png', width: 200, height: 64, sha256: 'd', sizeBytes: 10 },
      ],
    }));
    const light = packAssetUrl('pack-1', 'logoLight');
    const dark = packAssetUrl('pack-1', 'logoDark');
    expect(logoForScheme(applied, 'light')).toBe(light);
    expect(logoForScheme(applied, 'dark')).toBe(dark);
  });

  it('falls back to the shared logo for a scheme the pack did not supply', () => {
    const applied = applyPack(BASE, pack({
      assets: [{ slot: 'logo', mimeType: 'image/png', width: 200, height: 64, sha256: 'x', sizeBytes: 10 }],
    }));
    const only = packAssetUrl('pack-1', 'logo');
    expect(logoForScheme(applied, 'light')).toBe(only);
    expect(logoForScheme(applied, 'dark')).toBe(only);
  });

  it('an animated spinner with no static twin gets the pack logo, not the shipped hat', () => {
    const applied = applyPack(BASE, pack({
      assets: [
        { slot: 'logo', mimeType: 'image/png', width: 200, height: 64, sha256: 'x', sizeBytes: 10 },
        { slot: 'spinner', mimeType: 'image/gif', width: 64, height: 64, sha256: 's', sizeBytes: 10 },
      ],
    }));
    // BrandSpinner picks `spinnerStatic` under prefers-reduced-motion — a plain
    // unset slot would fall through to DIGBY's spinnerStatic, i.e. Digby's hat
    // inside a seasonal skin. That is the defect this assertion locks out.
    expect(applied.assets.spinnerStatic).toBe(applied.assets.logo);
    expect(applied.assets.spinnerStatic).not.toBe(DEFAULT_BRANDING.assets.spinnerStatic);
  });

  it('a supplied static twin is respected as-is', () => {
    const applied = applyPack(BASE, pack({
      assets: [
        { slot: 'spinner', mimeType: 'image/gif', width: 64, height: 64, sha256: 's', sizeBytes: 10 },
        { slot: 'spinnerStatic', mimeType: 'image/png', width: 64, height: 64, sha256: 't', sizeBytes: 10 },
      ],
    }));
    expect(applied.assets.spinnerStatic).toBe(packAssetUrl('pack-1', 'spinnerStatic'));
  });

  it('a pack logo alone also becomes the compact mark', () => {
    const applied = applyPack(BASE, pack({
      assets: [{ slot: 'logo', mimeType: 'image/png', width: 200, height: 64, sha256: 'x', sizeBytes: 10 }],
    }));
    expect(applied.assets.logoCompact).toBe(applied.assets.logo);
  });
});

describe('parseActivePack — total on hostile input', () => {
  it('parses the real response shape', () => {
    const parsed = parseActivePack({
      success: true,
      data: { pack: { ...pack(), assets: [{ slot: 'logo', mimeType: 'image/png', width: 2, height: 2, sha256: 'h', sizeBytes: 3 }] } },
    });
    expect(parsed?.id).toBe('pack-1');
    expect(parsed?.assets).toHaveLength(1);
    expect(parsed?.manifest.name).toBe('Acme Winter');
  });

  it('returns null (not a throw) for every malformed shape', () => {
    for (const bad of [null, undefined, 0, 'html', [], {}, { data: null }, { data: {} }, { data: { pack: {} } }, { data: { pack: { id: 'x' } } }]) {
      expect(() => parseActivePack(bad)).not.toThrow();
      expect(parseActivePack(bad)).toBeNull();
    }
  });

  it('drops unknown slots rather than surfacing them', () => {
    const parsed = parseActivePack({
      data: { pack: { ...pack(), assets: [{ slot: 'nope', mimeType: 'x', width: 1, height: 1, sha256: '', sizeBytes: 0 }] } },
    });
    expect(parsed?.assets).toEqual([]);
  });

  it('reports "no pack" for the rollback response, so the caller keeps Digby', () => {
    expect(parseActivePack({ success: true, data: { pack: null } })).toBeNull();
  });
});
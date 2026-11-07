/**
 * Runtime BRANDING PACK overlay — Phase 2 Cloud (todo 61dc8aaf).
 *
 * WHAT PROBLEM THIS SOLVES. The shared core (todo d2d32b57) rebrands an instance
 * from `DIGBY_BRAND_*` values, which the root layout reads at MODULE SCOPE and
 * Next bakes into prerendered HTML. That is correct for a self-hoster (set the
 * values, rebuild the image) and useless for a seasonal skin an operator wants
 * to switch on this afternoon: nothing has changed in the build, so nothing
 * would change on the page.
 *
 * So the pack layer is deliberately a CLIENT overlay on top of the server
 * snapshot:
 *
 *   1. the server renders the instance branding exactly as before (first paint,
 *      SEO metadata and the no-JS view are untouched — no fork, no second path);
 *   2. `BrandingProvider` asks `/api/crossmodel/branding/pack` once on mount;
 *   3. if a pack is active, `applyPack` merges it over the server value and every
 *      consumer (`useBranding`, `BrandLogo`, `BrandSpinner`) re-renders with the
 *      seasonal identity.
 *
 * WHY THE MERGE IS FIELD-BY-FIELD AND NOT A REPLACE. A pack is an OVERLAY, not a
 * new identity: a winter pack that only ships a logo must keep the instance's
 * name, and a pack that sets an accent colour must not silently blank the
 * operator's `DIGBY_BRAND_*` link colours. Every field a pack omits falls through
 * to what the server resolved, which is itself a fallback to shipped Digby — so
 * there is exactly one fallback chain and no "default pack" concept to get wrong.
 *
 * WHY `isDefault` BECOMES false WHENEVER A PACK IS ON. `isDefault` drives
 * surface work like the manifest href switch (`/branding/manifest` vs the static
 * `manifest.json`) and lets a component skip re-theming. A pack IS a rebrand, so
 * reporting `true` there would be a lie that some surfaces act on.
 *
 * LIGHT/DARK AND REDUCED MOTION COME FOR FREE, BY CONSTRUCTION. A pack fills the
 * SAME `BrandingAssets` slots the core already reads: `logoLight`/`logoDark` are
 * picked by `logoForScheme` in `BrandLogo`, and `spinner`/`spinnerStatic` are
 * picked by `usePrefersReducedMotion` in `BrandSpinner`. The pack layer adds no
 * new selector logic — which is the point: there is one place in the app that
 * decides "which logo for this scheme" and one that decides "animate or not",
 * and a pack only supplies the files they choose between.
 */

import { DEFAULT_BRANDING, type Branding, type BrandingAssets } from './index';

/** The asset slots a pack may supply — mirrors `BrandingAssets` keys. */
export const PACK_SLOTS = [
  'logo',
  'logoCompact',
  'logoLight',
  'logoDark',
  'spinner',
  'spinnerStatic',
  'favicon16',
  'favicon32',
  'icon192',
  'icon512',
  'appleTouchIcon',
] as const;

export type PackSlot = (typeof PACK_SLOTS)[number];

/** The text/theme half a pack carries (mirror of the backend `PackManifest`). */
export interface PackManifest {
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  logoAlt: string;
  titleSuffix: string;
  theme: { light: string; dark: string; backgroundLight: string; backgroundDark: string };
}

export interface PackAssetRef {
  slot: PackSlot;
  mimeType: string;
  width: number | null;
  height: number | null;
  sha256: string;
  sizeBytes: number;
}

/** The public pack payload (`GET /api/crossmodel/branding/pack`). */
export interface ActivePack {
  id: string;
  name: string;
  manifest: PackManifest;
  assets: PackAssetRef[];
  activatedAt: string | null;
}

/** The asset URL for one slot of a pack. Same-origin, no caller-controlled path. */
export function packAssetUrl(packId: string, slot: PackSlot): string {
  return `/api/crossmodel/branding/pack/${encodeURIComponent(packId)}/asset/${slot}`;
}

/**
 * Merge an active pack over the server-resolved branding. PURE and total: it
 * never throws and never returns a field the shipped defaults cannot back.
 *
 * The input `base` is whatever the server resolved (env overrides or shipped
 * Digby). Fields the pack supplies win; everything else keeps `base`.
 */
export function applyPack(base: Branding, pack: ActivePack | null | undefined): Branding {
  if (!pack || !pack.manifest) return base;

  const m = pack.manifest;
  const assets: BrandingAssets = { ...base.assets };
  for (const a of pack.assets ?? []) {
    // Guard the slot on the way in: a stored row we do not recognise must be
    // ignored, never written into the assets map under an unknown key (that
    // would be an unreachable-but-live entry the type system would not catch).
    if ((PACK_SLOTS as readonly string[]).includes(a.slot)) {
      assets[a.slot] = packAssetUrl(pack.id, a.slot);
    }
  }

  // The spinner's static twin: a pack that ships an animated spinner but no
  // static twin would leave reduced-motion users with the shipped Digby hat.
  // Falling back to the pack's own logo keeps the skin coherent instead.
  if (assets.spinner !== base.assets.spinner && assets.spinnerStatic === base.assets.spinnerStatic) {
    assets.spinnerStatic = assets.logo;
  }
  // Same rule the core applies: a compact mark with nothing supplied follows the
  // full logo rather than reverting to Digby's.
  if (assets.logo !== base.assets.logo && assets.logoCompact === base.assets.logoCompact) {
    assets.logoCompact = assets.logo;
  }

  const name = m.name || base.name;
  return {
    ...base,
    name,
    shortName: m.shortName || base.shortName,
    tagline: m.tagline || base.tagline,
    description: m.description || base.description,
    logoAlt: m.logoAlt || name,
    // `title` is `${name} — ${titleSuffix}`; keep one derivation so a pack that
    // only changes its name still gets a coherent <title>.
    titleSuffix: m.titleSuffix || base.titleSuffix,
    title: `${name} — ${m.titleSuffix || base.titleSuffix}`,
    assets,
    theme: {
      light: m.theme?.light || base.theme.light,
      dark: m.theme?.dark || base.theme.dark,
      backgroundLight: m.theme?.backgroundLight || base.theme.backgroundLight,
      backgroundDark: m.theme?.backgroundDark || base.theme.backgroundDark,
    },
    // A pack in force is a rebrand by definition (see the file header).
    isDefault: false,
  };
}

/**
 * Parse an untrusted public payload into an `ActivePack`, or null.
 *
 * The endpoint is same-origin and ours, but it is still network input: a proxy
 * error page, an HTML 502, or a future half-migrated response must all degrade
 * to "no pack" and leave the shipped branding in place — never throw inside a
 * provider that wraps the whole app.
 */
export function parseActivePack(raw: unknown): ActivePack | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = (raw as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return null;
  const pack = (data as Record<string, unknown>).pack;
  if (!pack || typeof pack !== 'object') return null;
  const p = pack as Record<string, unknown>;
  if (typeof p.id !== 'string' || !p.id) return null;
  const manifest = p.manifest;
  if (!manifest || typeof manifest !== 'object') return null;

  const assets = Array.isArray(p.assets) ? p.assets : [];
  const refs: PackAssetRef[] = [];
  for (const a of assets) {
    if (!a || typeof a !== 'object') continue;
    const slot = (a as Record<string, unknown>).slot;
    if (typeof slot !== 'string' || !(PACK_SLOTS as readonly string[]).includes(slot)) continue;
    refs.push({
      slot: slot as PackSlot,
      mimeType: typeof (a as any).mimeType === 'string' ? (a as any).mimeType : 'application/octet-stream',
      width: typeof (a as any).width === 'number' ? (a as any).width : null,
      height: typeof (a as any).height === 'number' ? (a as any).height : null,
      sha256: typeof (a as any).sha256 === 'string' ? (a as any).sha256 : '',
      sizeBytes: typeof (a as any).sizeBytes === 'number' ? (a as any).sizeBytes : 0,
    });
  }

  const m = manifest as Record<string, unknown>;
  const theme = (m.theme && typeof m.theme === 'object' ? m.theme : {}) as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    id: p.id,
    name: text(p.name),
    manifest: {
      name: text(m.name),
      shortName: text(m.shortName),
      tagline: text(m.tagline),
      description: text(m.description),
      logoAlt: text(m.logoAlt),
      titleSuffix: text(m.titleSuffix),
      theme: {
        light: text(theme.light),
        dark: text(theme.dark),
        backgroundLight: text(theme.backgroundLight),
        backgroundDark: text(theme.backgroundDark),
      },
    },
    assets: refs,
    activatedAt: typeof p.activatedAt === 'string' ? p.activatedAt : null,
  };
}

/** The shipped identity, re-exported so a caller need not import two modules. */
export { DEFAULT_BRANDING };
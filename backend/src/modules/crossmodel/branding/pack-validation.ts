/**
 * PURE branding-pack validation — slots, sanitisers, per-asset rules
 * (todo 61dc8aaf, Phase 2 Cloud).
 *
 * WHY THIS FILE IS SEPARATE FROM THE SERVICE. Everything here is a pure function
 * of its arguments: no database, no logger, no env. Keeping it in its own module
 * means the rules that decide whether an upload is safe can be tested in
 * isolation (and re-used by an API surface or a CLI probe) without dragging in
 * `config/env`, which calls `process.exit(1)` when the environment is incomplete —
 * a unit test that imports the service just to reach `prepareAsset` would die at
 * import time with no useful diagnosis.
 *
 * The rules themselves are the same ones the frontend core applies to
 * `DIGBY_BRAND_*` values (text caps, hex-only colours). They are MIRRORED rather
 * than imported because the frontend library is not on the backend's module path;
 * `branding-pack.contract.test.ts` reads both sources and fails if the two drift.
 */

import { MAX_PACK_ASSET_BYTES, sniffImage } from './image-sniff';

/** The asset slots a pack may fill — mirrors `BrandingAssets` in
 *  frontend/lib/branding/index.ts. Pinned by the contract test. */
export const PACK_ASSET_SLOTS = [
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

export type PackAssetSlot = (typeof PACK_ASSET_SLOTS)[number];

/**
 * Per-slot requirements. A slot may declare a minimum size (an app icon that is
 * 48px looks broken at 512) and a maximum (a 4096px "logo" would ship megabytes
 * to every visitor). Every slot requires PROVABLE dimensions: a file whose header
 * cannot be read is not a validated asset.
 */
export const SLOT_RULES: Record<PackAssetSlot, { minSize: number; maxSize: number }> = {
  logo: { minSize: 32, maxSize: 2048 },
  logoCompact: { minSize: 16, maxSize: 1024 },
  logoLight: { minSize: 32, maxSize: 2048 },
  logoDark: { minSize: 32, maxSize: 2048 },
  spinner: { minSize: 16, maxSize: 1024 },
  spinnerStatic: { minSize: 16, maxSize: 1024 },
  favicon16: { minSize: 16, maxSize: 256 },
  favicon32: { minSize: 16, maxSize: 512 },
  icon192: { minSize: 192, maxSize: 1024 },
  icon512: { minSize: 192, maxSize: 2048 },
  appleTouchIcon: { minSize: 120, maxSize: 1024 },
};

/** Sanitiser caps — identical numbers to the frontend core's exported maxima. */
export const PACK_LIMITS = {
  nameMax: 40,
  shortNameMax: 16,
  taglineMax: 140,
  descriptionMax: 400,
  logoAltMax: 120,
  titleSuffixMax: 80,
  packNameMax: 80,
  packDescriptionMax: 300,
} as const;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Mirror of the frontend core's `cleanText` (same rule, same fallback). */
export function cleanPackText(raw: unknown, fallback: string, max: number): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s.length > max) return fallback;
  return s;
}

/** Mirror of the frontend core's `cleanHex`. */
export function cleanPackHex(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  return HEX.test(s) ? s.toLowerCase() : fallback;
}

/** The text/theme half of a pack — the shape the public endpoint serves. */
export interface PackManifest {
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  logoAlt: string;
  titleSuffix: string;
  theme: { light: string; dark: string; backgroundLight: string; backgroundDark: string };
}

export const DEFAULT_PACK_MANIFEST: PackManifest = {
  name: 'Digby',
  shortName: 'Digby',
  tagline: 'Ask once. Get the best of every AI.',
  description: 'Digby is a Canadian AI assistant — private, Canadian AI.',
  logoAlt: 'Digby',
  titleSuffix: 'Private, Canadian AI Assistant',
  theme: { light: '#ffffff', dark: '#171717', backgroundLight: '#ffffff', backgroundDark: '#171717' },
};

/**
 * Validate a manifest body into the stored shape. Unknown keys are dropped, every
 * field is sanitised with the frontend's own rules, and an out-of-contract value
 * falls back to the shipped Digby value rather than failing the whole pack — a
 * pack that gets the tagline cap wrong should still be usable, but it must never
 * put an unsanitisable value in front of a visitor.
 */
export function normalizeManifest(raw: unknown): PackManifest {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const theme = (src.theme && typeof src.theme === 'object' ? src.theme : {}) as Record<string, unknown>;
  const d = DEFAULT_PACK_MANIFEST;
  const name = cleanPackText(src.name, d.name, PACK_LIMITS.nameMax);
  return {
    name,
    // shortName defaults to the (sanitised) name — a seasonal pack that sets only
    // its name should not keep the literal word "Digby" in the installed-app row.
    shortName: cleanPackText(src.shortName, name.slice(0, PACK_LIMITS.shortNameMax), PACK_LIMITS.shortNameMax),
    tagline: cleanPackText(src.tagline, d.tagline, PACK_LIMITS.taglineMax),
    description: cleanPackText(src.description, d.description, PACK_LIMITS.descriptionMax),
    logoAlt: cleanPackText(src.logoAlt, name, PACK_LIMITS.logoAltMax),
    titleSuffix: cleanPackText(src.titleSuffix, d.titleSuffix, PACK_LIMITS.titleSuffixMax),
    theme: {
      light: cleanPackHex(theme.light, d.theme.light),
      dark: cleanPackHex(theme.dark, d.theme.dark),
      backgroundLight: cleanPackHex(theme.backgroundLight, d.theme.backgroundLight),
      backgroundDark: cleanPackHex(theme.backgroundDark, d.theme.backgroundDark),
    },
  };
}

export interface PreparedAsset {
  slot: PackAssetSlot;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  sha256: string;
  data: Buffer;
}

export interface AssetRejection {
  slot: PackAssetSlot;
  reason: string;
}

export type PrepareResult =
  | { ok: true; asset: PreparedAsset }
  | { ok: false; rejection: AssetRejection };

/**
 * Validate ONE uploaded file for its slot. This is the gate that makes a pack
 * servable: sniffed type, size ceiling, provable dimensions, per-slot bounds.
 */
export function prepareAsset(slot: PackAssetSlot, bytes: Buffer): PrepareResult {
  const reject = (reason: string): PrepareResult => ({ ok: false, rejection: { slot, reason } });

  const rules = SLOT_RULES[slot];
  if (!rules) return reject(`unknown asset slot "${String(slot)}"`);
  if (!bytes || bytes.length === 0) return reject('the file is empty');
  if (bytes.length > MAX_PACK_ASSET_BYTES) {
    return reject(`the file is ${Math.round(bytes.length / 1024)} KB — the limit is ${MAX_PACK_ASSET_BYTES / 1024} KB`);
  }
  // SVG is refused deliberately — see image-sniff.ts for the same-origin XSS
  // reasoning. Naming it explicitly turns a confusing "not a recognised image"
  // into an actionable message.
  if (/<svg[\s>]/i.test(bytes.subarray(0, 512).toString('utf8'))) {
    return reject('SVG is not accepted for a Cloud branding pack — upload a PNG, JPEG, GIF, WebP or ICO instead');
  }

  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    return reject('the bytes are not a recognised image (PNG, JPEG, GIF, WebP or ICO)');
  }
  if (sniffed.width === null || sniffed.height === null) {
    return reject(`could not read the image dimensions — the ${sniffed.mimeType} header looks truncated`);
  }

  const shortSide = Math.min(sniffed.width, sniffed.height);
  const longSide = Math.max(sniffed.width, sniffed.height);
  if (shortSide < rules.minSize) {
    return reject(
      `${sniffed.width}×${sniffed.height} is too small for "${slot}" — the short side must be at least ${rules.minSize}px`,
    );
  }
  if (longSide > rules.maxSize) {
    return reject(`${sniffed.width}×${sniffed.height} is too large for "${slot}" — the long side may be at most ${rules.maxSize}px`);
  }

  return {
    ok: true,
    asset: {
      slot,
      // NEVER the upload's own Content-Type: this is the sniffed truth, and it is
      // the value the public route will serve.
      mimeType: sniffed.mimeType,
      sizeBytes: bytes.length,
      width: sniffed.width,
      height: sniffed.height,
      sha256: require('crypto').createHash('sha256').update(bytes).digest('hex'),
      data: bytes,
    },
  };
}

/**
 * Activation-time completeness. A pack may be SAVED with gaps (draft), but it may
 * not be put in front of visitors without the assets that keep every surface
 * whole: a logo, and a static twin for the spinner so `prefers-reduced-motion`
 * never falls through to an empty frame.
 */
export function missingForActivation(slots: string[]): string[] {
  const have = new Set(slots);
  const missing: string[] = [];
  // A logo is mandatory; `logoCompact` falls back to it, so it is not required.
  if (!have.has('logo') && !have.has('logoLight') && !have.has('logoDark')) {
    missing.push('logo');
  }
  // The reduced-motion twin: required only when an animated spinner was supplied
  // (without a spinner at all the shipped Digby spinner stays in place).
  if (have.has('spinner') && !have.has('spinnerStatic')) {
    missing.push('spinnerStatic');
  }
  return missing;
}
/**
 * Shared branding core — Phase 1 of the Digby product family
 * (Self-Hosted → Cloud → Enterprise; todo d2d32b57, owner requirement
 * 2026-11-05).
 *
 * ONE pure resolver that every surface (browser metadata, PWA manifest, login,
 * loading/spinner, error, public-share pages, chat chrome) reads. An operator
 * rebrands a self-hosted instance with ENVIRONMENT VARIABLES + an asset
 * directory — never by editing source.
 *
 * Contract (pinned by lib/branding/branding.test.ts):
 *  - Unset / empty / invalid ⇒ today's Digby value, byte-for-byte. A bad value
 *    must never blank a logo, break metadata, or throw at boot.
 *  - Values are TEXT and SAME-ORIGIN PATHS only. A path with a scheme, a
 *    protocol-relative `//`, or a `..` segment is rejected (an operator value
 *    must never become an off-site script/image origin or escape a directory).
 *  - Every asset has a static twin so `prefers-reduced-motion` and a missing
 *    file both still render something (never a broken-image box).
 *
 * WHERE VALUES ARE READ: server-side `process.env` (var names below are the
 * contract — `DIGBY_BRAND_*`). Static routes bake them at BUILD time, which is
 * why docs/SELF_HOST.md tells operators to set them BEFORE `docker compose up
 * --build`. The only request-time read is the operator asset DIRECTORY
 * (app/branding/asset/[...path]/route.ts), so a logo file can be swapped
 * without a rebuild.
 */

/** The shipped identity — every default below is what Digby renders today. */
export const DEFAULT_DESCRIPTION =
  'Digby is a Canadian AI assistant: open-weight AI models running on Canadian hardware, your chats, memory and files stored in Canada, live web search, and double-checked answers.';

export interface BrandingAssets {
  /** Full horizontal/mark logo — login panel, error page, share headers, site chrome. */
  logo: string;
  /** Compact mark — the sidebar brand row, install prompt, small chrome. */
  logoCompact: string;
  /** Optional per-scheme overrides; absent ⇒ `logo` is used in both. */
  logoLight: string | null;
  logoDark: string | null;
  /** The animated loader (a GIF/SVG/APNG) and its static twin. */
  spinner: string;
  spinnerStatic: string;
  favicon16: string;
  favicon32: string;
  icon192: string;
  icon512: string;
  appleTouchIcon: string;
}

export interface BrandingTheme {
  /** Browser-chrome / PWA theme colour per scheme. */
  light: string;
  dark: string;
  /** PWA splash background per scheme. */
  backgroundLight: string;
  backgroundDark: string;
}

export interface Branding {
  /** Display name — "Digby" unless the operator set DIGBY_BRAND_NAME. */
  name: string;
  /** Home-screen / tight-space name (≤ 16 chars). Defaults to `name`. */
  shortName: string;
  /** One-line promise (login panel, site meta). */
  tagline: string;
  /** Meta description / manifest description. */
  description: string;
  /** Accessible text for logo imagery (alt / aria-label). */
  logoAlt: string;
  /** `<title>` default: `${name} — ${titleSuffix}`. */
  title: string;
  titleSuffix: string;
  assets: BrandingAssets;
  theme: BrandingTheme;
  /** True when nothing was overridden (lets a surface skip work). */
  isDefault: boolean;
}

/** The brand name's hard cap — a 200-char name destroys every header layout. */
export const NAME_MAX = 40;
export const SHORT_NAME_MAX = 16;
export const TAGLINE_MAX = 140;
export const DESCRIPTION_MAX = 400;
export const ALT_MAX = 120;
export const TITLE_SUFFIX_MAX = 80;

/** Hex colours only — anything else could break the manifest / meta tag. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** A same-origin absolute path: one leading slash, no scheme, no `//`, no `..`. */
const LOCAL_PATH = /^\/(?!\/)[A-Za-z0-9._~\-/ %]+$/;

/** Text sanitiser: trims, collapses whitespace, drops control chars and angle
 *  brackets (never let an operator value inject markup), enforces a cap. An
 *  out-of-contract value falls back instead of throwing. */
export function cleanText(raw: unknown, fallback: string, max: number): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s.length > max) return fallback;
  return s;
}

/** Path sanitiser: same-origin absolute path or the fallback. Rejects
 *  `https://…`, `//evil.example/x`, `javascript:…`, `a/../b`, and empty. */
export function cleanPath(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (!s || s.length > 300) return fallback;
  if (!LOCAL_PATH.test(s)) return fallback;
  if (s.includes('..')) return fallback;
  return s;
}

export function cleanHex(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  return HEX.test(s) ? s.toLowerCase() : fallback;
}

/** Defaults, in one place so tests and docs can read them. */
export const DEFAULT_BRANDING: Branding = {
  name: 'Digby',
  shortName: 'Digby',
  tagline: 'Ask once. Get the best of every AI.',
  description: DEFAULT_DESCRIPTION,
  logoAlt: 'Digby',
  title: 'Digby — Private, Canadian AI Assistant',
  titleSuffix: 'Private, Canadian AI Assistant',
  assets: {
    logo: '/digbyhat.png',
    logoCompact: '/digbyhat.png',
    logoLight: null,
    logoDark: null,
    spinner: '/digbyspin.gif',
    spinnerStatic: '/digbyhat.png',
    favicon16: '/favicon-16x16.png',
    favicon32: '/favicon-32x32.png',
    icon192: '/icon-192x192.png',
    icon512: '/icon-512x512.png',
    appleTouchIcon: '/apple-touch-icon.png',
  },
  theme: { light: '#ffffff', dark: '#171717', backgroundLight: '#ffffff', backgroundDark: '#171717' },
  isDefault: true,
};

export type BrandingEnv = Record<string, string | undefined>;

const pick = (env: BrandingEnv, key: string): string | undefined => {
  const v = env[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
};

/**
 * Resolve the operator's branding from an env map. PURE — no I/O, no globals,
 * so it is unit-testable and safe in a client bundle (the caller passes
 * `process.env` on the server, or a serialized snapshot in the provider).
 */
export function resolveBranding(env: BrandingEnv = {}): Branding {
  const d = DEFAULT_BRANDING;

  const name = cleanText(pick(env, 'DIGBY_BRAND_NAME'), d.name, NAME_MAX);
  const shortName = cleanText(pick(env, 'DIGBY_BRAND_NAME_SHORT'), name.slice(0, SHORT_NAME_MAX), SHORT_NAME_MAX);
  const titleSuffix = cleanText(pick(env, 'DIGBY_BRAND_TITLE_SUFFIX'), d.titleSuffix, TITLE_SUFFIX_MAX);
  const title = cleanText(pick(env, 'DIGBY_BRAND_TITLE'), `${name} — ${titleSuffix}`, NAME_MAX + TITLE_SUFFIX_MAX + 8);

  // The full logo resolves FIRST: the per-scheme variants fall back to it, not
  // to the shipped mark — a typo'd light variant must not reintroduce Digby's
  // hat on a rebranded instance (independent review 2026-11-05).
  const logo = cleanPath(pick(env, 'DIGBY_BRAND_LOGO'), d.assets.logo);

  const assets: BrandingAssets = {
    logo,
    logoCompact: cleanPath(pick(env, 'DIGBY_BRAND_LOGO_COMPACT'), ''),
    logoLight: pick(env, 'DIGBY_BRAND_LOGO_LIGHT') ? cleanPath(pick(env, 'DIGBY_BRAND_LOGO_LIGHT'), logo) : null,
    logoDark: pick(env, 'DIGBY_BRAND_LOGO_DARK') ? cleanPath(pick(env, 'DIGBY_BRAND_LOGO_DARK'), logo) : null,
    spinner: cleanPath(pick(env, 'DIGBY_BRAND_SPINNER'), d.assets.spinner),
    // The static twin defaults to the (possibly branded) logo — a spinner with
    // no static twin must still resolve to a real image.
    spinnerStatic: cleanPath(pick(env, 'DIGBY_BRAND_SPINNER_STATIC'), ''),
    favicon16: cleanPath(pick(env, 'DIGBY_BRAND_FAVICON_16'), d.assets.favicon16),
    favicon32: cleanPath(pick(env, 'DIGBY_BRAND_FAVICON_32'), d.assets.favicon32),
    icon192: cleanPath(pick(env, 'DIGBY_BRAND_ICON_192'), d.assets.icon192),
    icon512: cleanPath(pick(env, 'DIGBY_BRAND_ICON_512'), d.assets.icon512),
    appleTouchIcon: cleanPath(pick(env, 'DIGBY_BRAND_APPLE_TOUCH_ICON'), d.assets.appleTouchIcon),
  };
  // Compact defaults to the compact mark → the full logo, never to Digby's hat
  // when the operator supplied their own logo.
  if (!assets.logoCompact) assets.logoCompact = assets.logo;
  if (!assets.spinnerStatic) assets.spinnerStatic = assets.logo;

  const branding: Branding = {
    name,
    shortName,
    tagline: cleanText(pick(env, 'DIGBY_BRAND_TAGLINE'), d.tagline, TAGLINE_MAX),
    description: cleanText(pick(env, 'DIGBY_BRAND_DESCRIPTION'), d.description, DESCRIPTION_MAX),
    logoAlt: cleanText(pick(env, 'DIGBY_BRAND_LOGO_ALT'), name, ALT_MAX),
    title,
    titleSuffix,
    assets,
    theme: {
      light: cleanHex(pick(env, 'DIGBY_BRAND_THEME_COLOR'), d.theme.light),
      dark: cleanHex(pick(env, 'DIGBY_BRAND_THEME_COLOR_DARK'), d.theme.dark),
      backgroundLight: cleanHex(pick(env, 'DIGBY_BRAND_BACKGROUND_COLOR'), d.theme.backgroundLight),
      backgroundDark: cleanHex(pick(env, 'DIGBY_BRAND_BACKGROUND_COLOR_DARK'), d.theme.backgroundDark),
    },
    isDefault: true,
  };
  branding.isDefault = isDefaultBranding(branding);
  return branding;
}

function isDefaultBranding(b: Branding): boolean {
  const d = DEFAULT_BRANDING;
  return (
    b.name === d.name &&
    b.shortName === d.shortName &&
    b.tagline === d.tagline &&
    b.description === d.description &&
    b.logoAlt === d.logoAlt &&
    b.title === d.title &&
    JSON.stringify(b.assets) === JSON.stringify(d.assets) &&
    JSON.stringify(b.theme) === JSON.stringify(d.theme)
  );
}

/** Server-side helper: resolve from the live process env (build time for
 *  static routes, request time for dynamic ones). */
export function brandingFromEnv(env: BrandingEnv = process.env): Branding {
  return resolveBranding(env);
}

/** The logo to use for a given colour scheme (falls back to the main logo). */
export function logoForScheme(b: Branding, scheme: 'light' | 'dark'): string {
  return (scheme === 'dark' ? b.assets.logoDark : b.assets.logoLight) ?? b.assets.logo;
}

/**
 * Can this logo go through `next/image`? The optimizer refuses SVG unless
 * `dangerouslyAllowSVG` is set (next.config.ts does not set it — a 400, not a
 * render), so an operator SVG must render through a plain <img> instead.
 * Unknown extensions are treated as raster: the optimizer's own error path
 * already degrades to the shipped mark.
 */
export function logoIsRaster(src: string): boolean {
  const path = src.split(/[?#]/)[0].toLowerCase();
  return !path.endsWith('.svg');
}

/**
 * Substitute the product name inside AUTHORED copy (site page titles, ledes,
 * guide titles). Used only where the string is data rather than a JSX
 * expression, so the brand name still reaches metadata a self-hoster never
 * sees in source.
 *
 * Deliberately narrow: it rewrites the standalone word "Digby" (and nothing
 * else), and returns the input untouched when the operator kept the default,
 * so the shipped copy is byte-identical. It is NOT applied to long-form body
 * prose — that copy is editorial and stays as authored (docs/SELF_HOST.md says
 * so explicitly).
 */
export function brandText(raw: string, b: Branding = DEFAULT_BRANDING): string {
  if (!raw || b.name === DEFAULT_BRANDING.name) return raw;
  return raw.replace(/\bDigby\b/g, b.name);
}

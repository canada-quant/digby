import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brandingFromEnv } from '@/lib/branding';

/**
 * The PWA manifest for a REBRANDED instance (Phase 1, todo d2d32b57).
 *
 * The shipped identity keeps the static `public/manifest.json` untouched (its
 * P7 identity pins — id `'/crossmodel'`, light theme colours, icon size
 * checks — still read that file, and the installed-app id must never move).
 * A rebranded instance links THIS route instead (app/layout.tsx picks it when
 * `branding.isDefault === false`), which applies the operator's name, icons
 * and colours on top of the same base document so shortcuts, screenshots and
 * `id` stay identical — changing `id` would orphan every home-screen install.
 */
export const dynamic = 'force-static';

export function GET() {
  const b = brandingFromEnv();
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(readFileSync(join(process.cwd(), 'public', 'manifest.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    // A missing base file must still produce a usable manifest.
  }

  // Long-press shortcut icons point at Digby's icon in the base file; a
  // rebranded PWA must not show them (independent review 2026-11-05).
  const shortcuts = Array.isArray(base.shortcuts)
    ? (base.shortcuts as Record<string, unknown>[]).map((s) => ({
        ...s,
        icons: [{ src: b.assets.icon192, sizes: '192x192', type: 'image/png' }],
      }))
    : base.shortcuts;

  const manifest = {
    ...base,
    // `id` is deliberately NOT overridden — installed-app identity.
    name: b.name,
    short_name: b.shortName,
    description: b.description,
    background_color: b.theme.backgroundLight,
    theme_color: b.theme.light,
    color_scheme_dark: {
      background_color: b.theme.backgroundDark,
      theme_color: b.theme.dark,
    },
    // `purpose: 'any maskable'` is carried over from the base file: dropping it
    // makes Android letterbox the icon instead of masking it (review finding).
    icons: [
      { src: b.assets.favicon16, sizes: '16x16', type: 'image/png' },
      { src: b.assets.favicon32, sizes: '32x32', type: 'image/png' },
      { src: b.assets.appleTouchIcon, sizes: '180x180', type: 'image/png' },
      { src: b.assets.icon192, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: b.assets.icon512, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
    shortcuts,
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=60, must-revalidate',
    },
  });
}
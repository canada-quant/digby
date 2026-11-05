import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { NextRequest } from 'next/server';

/**
 * Operator branding assets — Phase 1 self-host rebranding (todo d2d32b57).
 *
 * Serves files from the operator's mounted asset directory so a logo / spinner
 * / icon can be SWAPPED WITHOUT REBUILDING the frontend image:
 *
 *   DIGBY_BRANDING_DIR=/srv/digby-branding    (docker-compose.selfhost.yml
 *                                              mounts ./branding there)
 *   GET /branding/asset/logo.png  →  <dir>/logo.png
 *
 * Point `DIGBY_BRAND_LOGO=/branding/asset/logo.png` at it. When the directory
 * (or the file) is absent this answers 404 and every consumer's own fallback
 * takes over (an <img> onError swap, or the shipped Digby asset) — a missing
 * file must never break a page.
 *
 * SECURITY (this route reads the operator's FILESYSTEM, so it is jailed):
 *  - `..` in any segment is refused, and the resolved path must stay inside
 *    the configured directory (resolve + startswith prefix check);
 *  - dotfiles are refused (`.env` inside a mounted dir is not a branding asset);
 *  - only image extensions are served, with an explicit Content-Type and
 *    `X-Content-Type-Options: nosniff`;
 *  - SVG is served as an image the browser may not script (`default-src 'none'`).
 */

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.apng': 'image/apng',
};

/** Resolve a request path inside `dir`, or null when it would escape. */
export function resolveBrandingAsset(dir: string, segments: string[]): string | null {
  if (!dir || !segments.length) return null;
  // Decode per segment: an encoded `..` must not sneak past the check.
  const parts: string[] = [];
  for (const raw of segments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null; // malformed escape
    }
    if (!seg || seg === '.' || seg === '..' || seg.startsWith('.') || seg.includes('/') || seg.includes('\\')) return null;
    parts.push(seg);
  }
  const root = resolve(dir);
  const target = resolve(root, ...parts);
  // Prefix check with the trailing separator so `/branding-evil/` cannot match.
  if (target !== root && !target.startsWith(root + sep)) return null;
  if (!TYPES[extname(target).toLowerCase()]) return null;
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  return target;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const dir = (process.env.DIGBY_BRANDING_DIR || '').trim();
  const file = resolveBrandingAsset(dir, path ?? []);
  if (!file) return new Response('Not found', { status: 404 });

  const type = TYPES[extname(file).toLowerCase()];
  const stream = createReadStream(file) as unknown as ReadableStream;
  return new Response(stream, {
    headers: {
      'Content-Type': type,
      'Content-Length': String(statSync(file).size),
      // Short cache: an operator replacing a logo should see it without a
      // CDN purge, while repeat page loads stay cheap.
      'Cache-Control': 'public, max-age=60, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
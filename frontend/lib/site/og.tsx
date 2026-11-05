import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { DEFAULT_BRANDING, brandingFromEnv } from '@/lib/branding';

/**
 * The social card renderer (2026-10-16 site review): one design for the
 * default card and every page's own card — the real propeller-hat logo (the
 * old card drew a top-hat emoji), the page's eyebrow and headline, and the
 * Canadian line. Rendered at build time (every caller is statically generated).
 */
export const OG_SIZE = { width: 1200, height: 630 };

/**
 * Inline the brand mark for the card. Shared branding core (todo d2d32b57):
 * an operator's mark is inlined when it is a file under public/; an asset
 * served from the operator directory (`/branding/asset/…`) is not readable
 * from disk here, so the shipped Digby mark is inlined instead — a card never
 * renders without a logo, and never fetches a URL at render time.
 */
function hatDataUrl(): string | null {
  const configured = brandingFromEnv().assets.logo;
  const local = configured.startsWith('/branding/') ? DEFAULT_BRANDING.assets.logo : configured;
  for (const candidate of [local, DEFAULT_BRANDING.assets.logo]) {
    try {
      return `data:image/png;base64,${readFileSync(join(process.cwd(), 'public', candidate)).toString('base64')}`;
    } catch {
      // try the next candidate; never fail a card over the logo
    }
  }
  return null;
}

export function renderOg({ eyebrow, title, footer = 'Models on Canadian hardware · data stored in Canada · answers double-checked' }: {
  eyebrow?: string; title: string; footer?: string;
}) {
  const hat = hatDataUrl();
  const size = title.length > 60 ? 60 : title.length > 36 ? 70 : 82;
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '64px 80px', background: '#171717', color: '#fafafa' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 40 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain <img> */}
          {hat ? <img src={hat} width={60} height={60} alt="" /> : null}
          <span>{brandingFromEnv().name}</span>
          {eyebrow ? <span style={{ marginLeft: 18, fontSize: 22, letterSpacing: 2, color: '#a3a3a3', textTransform: 'uppercase' }}>{eyebrow}</span> : null}
        </div>
        <div style={{ display: 'flex', fontSize: size, lineHeight: 1.05, letterSpacing: -1.5, maxWidth: 1040 }}>{title}</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 26, color: '#a3a3a3' }}>
          <span style={{ maxWidth: 820 }}>{footer}</span>
          <span style={{ color: '#fafafa' }}>{brandingFromEnv().isDefault ? 'digby.ai' : brandingFromEnv().name}</span>
        </div>
      </div>
    ),
    OG_SIZE,
  );
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

/**
 * The social card renderer (2026-10-16 site review): one design for the
 * default card and every page's own card — the real propeller-hat logo (the
 * old card drew a top-hat emoji), the page's eyebrow and headline, and the
 * Canadian line. Rendered at build time (every caller is statically generated).
 */
export const OG_SIZE = { width: 1200, height: 630 };

function hatDataUrl(): string | null {
  try {
    return `data:image/png;base64,${readFileSync(join(process.cwd(), 'public', 'digbyhat.png')).toString('base64')}`;
  } catch {
    return null; // never fail a card over the logo
  }
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
          <span>Digby</span>
          {eyebrow ? <span style={{ marginLeft: 18, fontSize: 22, letterSpacing: 2, color: '#a3a3a3', textTransform: 'uppercase' }}>{eyebrow}</span> : null}
        </div>
        <div style={{ display: 'flex', fontSize: size, lineHeight: 1.05, letterSpacing: -1.5, maxWidth: 1040 }}>{title}</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 26, color: '#a3a3a3' }}>
          <span style={{ maxWidth: 820 }}>{footer}</span>
          <span style={{ color: '#fafafa' }}>digby.example.com</span>
        </div>
      </div>
    ),
    OG_SIZE,
  );
}

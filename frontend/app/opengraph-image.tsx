import { OG_SIZE, renderOg } from '@/lib/site/og';
import { brandingFromEnv } from '@/lib/branding';

// Default social card (2026-10-14 SEO pass; redrawn 2026-10-16 with the real
// hat). Every landing page and guide ships its own card from the same renderer.
export const alt = `${brandingFromEnv().name} — ${brandingFromEnv().tagline}`;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return renderOg({ title: 'Private, Canadian AI.' });
}

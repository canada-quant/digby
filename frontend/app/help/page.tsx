import type { Metadata } from 'next';
import { getHelpIndex } from '@/lib/help-docs';
import { HelpIndex } from './help-index';
import { brandingFromEnv } from '@/lib/branding';

// Shared branding core (todo d2d32b57): server component, resolved at build.
const BRANDING = brandingFromEnv();

// Reads content/help from disk at request time (generated-but-committed docs —
// see scripts/sync-help-docs.mjs); never statically prerender a stale copy.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `Help & Docs — ${BRANDING.name}`,
  description: `${BRANDING.name} user and operator documentation: self-hosting, Digby Edge, iMessage & macOS, and the platform API.`,
};

export default function HelpPage() {
  const docs = getHelpIndex();
  return <HelpIndex docs={docs} />;
}

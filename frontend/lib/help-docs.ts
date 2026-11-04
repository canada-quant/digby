/**
 * Server-side reader for the committed help content (content/help/, generated
 * by scripts/sync-help-docs.mjs — the Docker build context is frontend/ only,
 * so repo-root docs/ is unavailable at image build time). Imported ONLY by the
 * /help server components; the Dockerfile copies content/ into the standalone
 * runtime image so these reads work in production.
 */

import { readFileSync } from 'fs';
import path from 'path';
import type { HelpDocMeta, HelpIndexEntry, HelpManifest } from './help-types';

const CONTENT_DIR = path.join(process.cwd(), 'content', 'help');

// Module-level cache — the corpus is ~60KB and identical for every request;
// content only changes on deploy (the files are committed build artifacts).
let manifestCache: HelpManifest | null = null;
const contentCache = new Map<string, string>();

export function getHelpManifest(): HelpManifest {
  if (!manifestCache) {
    manifestCache = JSON.parse(
      readFileSync(path.join(CONTENT_DIR, 'manifest.json'), 'utf8'),
    ) as HelpManifest;
  }
  return manifestCache;
}

const SLUG_RE = /^[a-z0-9-]+$/;

export function getHelpDocMeta(slug: string): HelpDocMeta | null {
  if (!SLUG_RE.test(slug)) return null;
  return getHelpManifest().docs.find((d) => d.slug === slug) ?? null;
}

export function getHelpDocContent(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return null;
  const cached = contentCache.get(slug);
  if (cached !== undefined) return cached;
  const meta = getHelpDocMeta(slug);
  if (!meta) return null;
  try {
    const content = readFileSync(path.join(CONTENT_DIR, meta.filename), 'utf8');
    contentCache.set(slug, content);
    return content;
  } catch {
    return null;
  }
}

/** Manifest entries + raw markdown for the index page's client-side search. */
export function getHelpIndex(): HelpIndexEntry[] {
  const entries: HelpIndexEntry[] = [];
  for (const meta of getHelpManifest().docs) {
    const content = getHelpDocContent(meta.slug);
    if (content != null) entries.push({ ...meta, content });
  }
  return entries;
}

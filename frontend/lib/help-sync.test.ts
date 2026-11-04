/**
 * /help sync pins (ambition-prompt map §5 guardrail, A6/C1 — asking-bigger,
 * 2026-10-15). The allowlist in scripts/sync-help-docs.mjs, the source docs,
 * and the committed frontend/content/help/ mirror must ALL move together:
 * the mirror is generated (never hand-edited) and the frontend Docker build
 * context is frontend/ only — so a source edit without
 * `cd frontend && npm run sync-help-docs` ships nothing to /help, and a mirror
 * edit without its source is silently overwritten on the next sync. This
 * suite parses the REAL allowlist out of the script (a hand-copied fixture
 * would itself drift) and fails on every divergence, including stale mirrors
 * for docs this test never names.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');
const MIRROR_DIR = path.join(FRONTEND_ROOT, 'content', 'help');

interface AllowlistEntry {
  source: string;
  slug: string;
  category: string;
  description: string;
}

// The allowlist entries, parsed from the generator script itself.
const SCRIPT = readFileSync(
  path.join(FRONTEND_ROOT, 'scripts', 'sync-help-docs.mjs'),
  'utf8',
);
const ALLOWLIST: AllowlistEntry[] = [
  ...SCRIPT.matchAll(
    /\{\s*source:\s*'([^']+)',\s*slug:\s*'([^']+)',\s*category:\s*'([^']+)',\s*description:\s*'([^']+)',?\s*\}/g,
  ),
].map((m) => ({
  source: m[1],
  slug: m[2],
  category: m[3],
  description: m[4],
}));

const mirrorFile = (slug: string) => path.join(MIRROR_DIR, `${slug}.md`);

describe('help-docs sync (allowlist ↔ source ↔ committed mirror)', () => {
  it('parses the allowlist out of sync-help-docs.mjs with unique slugs and sources', () => {
    // If this drops to 0 the entry shape in the script changed — update the
    // parser above, never delete this test.
    expect(ALLOWLIST.length).toBeGreaterThanOrEqual(10);
    const slugs = ALLOWLIST.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const sources = ALLOWLIST.map((e) => e.source);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('carries the asking-bigger doc (ambition map A6) in the Using Digby category', () => {
    const entry = ALLOWLIST.find((e) => e.slug === 'asking-bigger');
    expect(entry).toMatchObject({
      source: 'docs/ASKING_BIGGER.md',
      category: 'Using Digby',
    });
  });

  it('manifest.json is in sync with the allowlist (run `npm run sync-help-docs`)', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(MIRROR_DIR, 'manifest.json'), 'utf8'),
    );
    expect(manifest.docs.map((d: { slug: string }) => d.slug)).toEqual(
      ALLOWLIST.map((e) => e.slug),
    );
    for (const doc of manifest.docs) {
      const entry = ALLOWLIST.find((e) => e.slug === doc.slug);
      expect(entry, `manifest doc ${doc.slug} has no allowlist entry`).toBeDefined();
      expect(doc).toMatchObject({
        source: entry?.source,
        category: entry?.category,
        description: entry?.description,
        filename: `${doc.slug}.md`,
      });
    }
  });

  // Skip only in a frontend-only checkout where NO allowlisted source exists at
  // all (the Docker build context is frontend/ only). If exactly ONE source is
  // missing — a doc archived or moved while its allowlist entry + mirror remain
  // — the test runs and fails loudly below, because /help would keep serving
  // the stale mirror (the reviewer-found side door of a per-any-missing skip).
  it.skipIf(ALLOWLIST.every((e) => !existsSync(path.join(REPO_ROOT, e.source))))(
    'every committed mirror file is byte-identical to its allowlisted source (run `npm run sync-help-docs`)',
    () => {
      for (const entry of ALLOWLIST) {
        const sourcePath = path.join(REPO_ROOT, entry.source);
        if (!existsSync(sourcePath)) {
          throw new Error(
            `allowlisted source ${entry.source} is missing but its mirror content/help/${entry.slug}.md is still committed — remove the allowlist entry (and mirror) or restore the doc; the generator itself would fail here`,
          );
        }
        const source = readFileSync(sourcePath, 'utf8');
        const mirror = readFileSync(mirrorFile(entry.slug), 'utf8');
        expect(mirror, `${entry.source} → content/help/${entry.slug}.md`).toBe(source);
      }
    },
  );

  it('the mirror directory holds exactly the allowlisted files + manifest.json (no orphans, none missing)', () => {
    const files = readdirSync(MIRROR_DIR).sort();
    const expected = [...ALLOWLIST.map((e) => `${e.slug}.md`), 'manifest.json'].sort();
    expect(files).toEqual(expected);
  });
});

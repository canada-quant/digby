/**
 * Shared types for the /help knowledge-base surface. Kept fs-free so both the
 * server reader (lib/help-docs.ts) and the client components can import them.
 * Shape is produced by frontend/scripts/sync-help-docs.mjs → content/help/manifest.json.
 */

export interface HelpHeading {
  depth: number; // 2 | 3
  text: string;
  id: string; // GitHub-style slug, matches the ids rendered by help-markdown.tsx
}

export interface HelpDocMeta {
  slug: string;
  title: string;
  description: string;
  category: string;
  /** Repo-relative source path (e.g. "docs/SELF_HOST.md") — the link rewriter
   *  resolves relative .md links against this. */
  source: string;
  filename: string;
  headings: HelpHeading[];
}

export interface HelpManifest {
  generatedAt: string;
  docs: HelpDocMeta[];
}

/** Manifest entry + raw markdown — the index page's client-side search corpus. */
export interface HelpIndexEntry extends HelpDocMeta {
  content: string;
}

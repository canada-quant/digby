/**
 * Worktree-path interlinks in coding-session transcripts (owner 2026-09-17:
 * "how hard would it be for chat ui to interlink docs when it prints them so
 * you can just click the link and it opens it in the sidebar file viewer").
 *
 * Render-time only (like linkifySessionRefs): a bare repo-relative path in
 * assistant prose — `docs/BACKUPS.md`, `backend/src/worker.ts`,
 * `./scripts/deploy.sh`, or a bare doc filename like `README.md` — becomes a
 * markdown link whose href is `#worktree:<encoded path>`. The renderer maps
 * that href to a button which opens the file in the session's Files tab
 * (WorktreeOpenContext); outside a coding session the same text renders as
 * plain monospace, never a dead link.
 *
 * What counts as a path (deliberately conservative — a false link is worse
 * than a missed one):
 *   - one or more `segment/` parts followed by a filename with an extension
 *     (or a dotfile: `config/.env`), OR
 *   - a bare filename with a DOC-ish extension (md, mdx, txt, json, yaml,
 *     yml, toml) — `index.ts` alone is too ambiguous to link.
 *   - never inside code spans/fences, existing links/images, raw HTML
 *     (parser-parity via protectedRanges); never mid-URL or mid-path (the
 *     char before must not be a word/path char — `github.com/a/b/x.md` stays
 *     text); never an absolute path (`/app/dist/x.js`), `~/…`, or a path
 *     rooted in node_modules / .git (the viewer refuses those anyway).
 */

import { protectedRanges } from './session-links';

export const WORKTREE_LINK_PREFIX = '#worktree:';

const DOC_EXT = '(?:md|mdx|txt|json|ya?ml|toml)';
// segment: word chars, dots, dashes, plus signs, at-signs (scoped pkg dirs).
const SEG = '[\\w.+@-]+';
// last segment: `name.ext` (ext 1–10 alnum) or a dotfile `.name`.
const LAST = `(?:[\\w+@-][\\w.+@-]*\\.[A-Za-z0-9]{1,10}|\\.[\\w.+-]+)`;
const PATH_TOKEN_RE = new RegExp(
  // not preceded by a word/path/url char (mid-URL, mid-path, ~/, …)
  `(?<![\\w./:@~\\\\-])` +
  // optional ./ prefix (stripped from the link target)
  `(?:\\.\\/)?` +
  `(` +
    `(?:${SEG}\\/)+${LAST}` +          // with ≥1 directory segment
    `|` +
    `[\\w+-][\\w.+-]*\\.${DOC_EXT}` +  // bare doc filename
  `)` +
  // not followed by a word/path char (so `docs/X.md.` and `docs/X.md)` end cleanly)
  `(?![\\w/])`,
  'g',
);

const BANNED_ROOTS = new Set(['node_modules', '.git']);

/** Encode a worktree-relative path as the link href the renderer recognises. */
export function worktreeLinkHref(path: string): string {
  return `${WORKTREE_LINK_PREFIX}${encodeURIComponent(path)}`;
}

/** The worktree-relative path an href carries, or null when it is not ours. */
export function parseWorktreeLinkHref(href: unknown): string | null {
  if (typeof href !== 'string' || !href.startsWith(WORKTREE_LINK_PREFIX)) return null;
  try {
    const p = decodeURIComponent(href.slice(WORKTREE_LINK_PREFIX.length));
    return p && !p.startsWith('/') && !p.split('/').includes('..') ? p : null;
  } catch {
    return null;
  }
}

/** Does this text carry anything the linkifier would touch? (cheap pre-check) */
export function hasWorktreePathCandidates(text: string): boolean {
  PATH_TOKEN_RE.lastIndex = 0;
  const hit = PATH_TOKEN_RE.test(text);
  PATH_TOKEN_RE.lastIndex = 0;
  return hit;
}

/**
 * Rewrite bare worktree paths in `text` into `[path](#worktree:…)` links,
 * leaving protected markdown spans untouched. Idempotent: an already-linked
 * path sits inside a `link` node and is skipped.
 */
export function linkifyWorktreePaths(text: string): string {
  if (!text || !hasWorktreePathCandidates(text)) return text;
  const ranges = protectedRanges(text);
  PATH_TOKEN_RE.lastIndex = 0;
  return text.replace(PATH_TOKEN_RE, (match: string, pathPart: string, offset: number) => {
    if (ranges.some(([s, e]) => offset >= s && offset < e)) return match;
    const root = pathPart.split('/')[0];
    if (BANNED_ROOTS.has(root)) return match;
    // A trailing dot-only "extension" or a path ending in a slash never matches
    // the regex, so `pathPart` is a clean worktree-relative path here.
    return `[${pathPart}](${worktreeLinkHref(pathPart)})`;
  });
}

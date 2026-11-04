/**
 * Pure link helpers for the /help surface — repo-doc link rewriting and
 * GitHub-style heading slugs. Kept React-free so the sync script's logic and
 * the renderer (app/help/help-markdown.tsx) stay testably in sync; NOTE the
 * sync script (scripts/sync-help-docs.mjs, plain .mjs) duplicates the same
 * rules — update both together.
 */

/** GitHub-style heading slug (github-slugger parity: punctuation stripped,
 *  spaces → hyphens ONE-FOR-ONE) — keep in sync with scripts/sync-help-docs.mjs. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');
}

export function normalizePosixPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/**
 * Rewrite a relative same-repo .md link to /help/<slug> (anchor preserved).
 * Returns null when the href is not a repo doc link or the target is not in
 * the synced allowlist (the renderer then leaves it to the default transform,
 * and unresolved .md links render as plain text). Resolution mirrors the sync
 * script's link checker: `./`/`../` resolve against the current doc's repo
 * directory, a leading `/` is repo-relative, and a bare path tries the
 * source-dir resolution first, then the repo-relative one (covers `docs/X.md`).
 */
export function rewriteDocHref(
  href: string | undefined,
  currentSource: string,
  slugBySource: Map<string, string>,
): string | null {
  if (!href) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null; // schemed/protocol-relative
  const hashIdx = href.indexOf('#');
  const linkPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const hash = hashIdx >= 0 ? href.slice(hashIdx) : '';
  if (!/\.md$/i.test(linkPath)) return null;
  const sourceDir = currentSource.split('/').slice(0, -1).join('/');
  const repoRel = linkPath.startsWith('/')
    ? normalizePosixPath(linkPath.slice(1))
    : normalizePosixPath(sourceDir ? `${sourceDir}/${linkPath}` : linkPath);
  const slug = slugBySource.get(repoRel) ?? slugBySource.get(normalizePosixPath(linkPath));
  return slug ? `/help/${slug}${hash}` : null;
}

/**
 * Instance isolation boundary (ticket c75b5f34 — owner standing requirement).
 *
 * A self-hosted / Edge Digby instance runs its autonomous self-improvement
 * loop (merge → deploy → verify → auto-fix) against ITS OWN repo / DB / deploy
 * targets ONLY. Production and self-hosted are fully isolated: nothing on a
 * non-prod instance may resolve, push to, merge into, deploy to or probe a
 * PRODUCTION target — and the refusal is a HARD FAIL with a clear error,
 * never a silent fallback to the production default.
 *
 * Import-free leaf ON PURPOSE (ticket 6665fff6 doctrine): validators and
 * test suites import this module, so it must never drag the env-validating
 * chain (prisma → logger → config/env) behind it. Pure functions + one Error
 * subclass only.
 *
 * Identity: DIGBY_INSTANCE names the deployment kind. UNSET (or 'prod') is
 * the production/cloud instance — the backward-compatible default, so every
 * existing deployment keeps its current behavior until it opts into an
 * instance kind. 'selfhost' / 'edge' (or any other value) is a non-prod
 * instance: its loop targets must come from its OWN environment, and a
 * production target is refused.
 */

/** The env var that names the deployment kind ('prod' | 'selfhost' | 'edge' | …). */
export const DIGBY_INSTANCE_ENV = 'DIGBY_INSTANCE';
/** The canonical value for the production/cloud instance. */
export const PROD_INSTANCE = 'prod';
/**
 * The production deployment's own repo — the target a non-prod instance must
 * NEVER resolve. Kept as the single source of truth for the five historical
 * `|| 'example-org/crossmodel'` defaults (self-merge SELF_REPO, fleet-pulse,
 * infra-watch DEPLOY_REPO, feedback fix-state, closure-evidence).
 */
export const PROD_REPO = 'example-org/crossmodel';

/** Thrown when a non-prod instance resolves a production target. Hard fail. */
export class IsolationBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationBoundaryError';
  }
}

export type InstanceKind = string;

/** The deployment kind from env: unset/empty = 'prod' (backward compatible); value is normalized lowercase. */
export function instanceKind(env: NodeJS.ProcessEnv = process.env): InstanceKind {
  const raw = String(env[DIGBY_INSTANCE_ENV] ?? '').trim().toLowerCase();
  return raw || PROD_INSTANCE;
}

/** true only for the production instance (DIGBY_INSTANCE unset, empty or 'prod'). */
export function isProdInstance(env: NodeJS.ProcessEnv = process.env): boolean {
  return instanceKind(env) === PROD_INSTANCE;
}

/**
 * Normalize a GitHub repo reference — accepts 'owner/repo',
 * 'https://github.com/owner/repo', 'https://github.com/owner/repo.git' and
 * 'git@github.com:owner/repo.git' — to canonical lowercase 'owner/repo'.
 * null when the input names no GitHub repo (never a guess).
 */
export function normalizeGithubRepoTarget(input: string): string | null {
  const raw = String(input ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  // scp-like ssh spelling: git@github.com:owner/repo(.git)
  let m = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (m) return `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
  // c75b5f34 follow-up (cross-family review finding 1): any absolute URL
  // spelling is canonicalized through the WHATWG parser — a bare regex
  // cannot see through a default port (https://github.com:443/owner/repo:
  // new URL() drops the port, validateRepoUrl ACCEPTS it, git pushes to it)
  // or a trailing-dot host (github.com.), and those spellings used to fall
  // out as null = FAIL-OPEN in every guard built on this function. Host is
  // lowercased + trailing dots stripped; owner/repo read from the pathname.
  // A non-github URL is not a GitHub target (null).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase().replace(/\.+$/, '');
      if (host !== 'github.com') return null;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length < 2 || !parts[0] || !parts[1]) return null;
      return `${parts[0].toLowerCase()}/${parts[1].replace(/\.git$/, '').toLowerCase()}`;
    } catch { return null; }
  }
  m = raw.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m) {
    const parts = raw.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) m = [raw, parts[0], parts[1].replace(/\.git$/, '')] as unknown as RegExpMatchArray;
  }
  if (!m) return null;
  const owner = m[1]; const repo = m[2];
  if (!owner || !repo || owner === '.' || repo === '.') return null;
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** true when the input names the PRODUCTION repo (slug or URL, any case). */
export function isProdRepoTarget(input: string): boolean {
  const norm = normalizeGithubRepoTarget(input);
  return norm !== null && norm === PROD_REPO;
}

/** The shared refusal text for a production target on a non-prod instance. */
export function isolationRefusal(target: string, env: NodeJS.ProcessEnv = process.env): string {
  const kind = instanceKind(env);
  return `ISOLATION BOUNDARY (DIGBY_INSTANCE=${kind}): "${target}" is the PRODUCTION Digby repo/target — a ${kind !== PROD_INSTANCE ? `${kind} ` : ''}instance must never push to, merge into, deploy to or probe production. Point the autonomous loop at this instance's OWN repo (set SELF_REPO / GITHUB_REPO_SLUG to your fork) — there is no production fallback by design.`;
}

/**
 * HARD FAIL when a non-prod instance resolves the production repo target.
 * No-op on the production instance and for every non-prod target.
 */
export function assertRepoTargetAllowed(target: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isProdInstance(env)) return;
  if (isProdRepoTarget(target)) throw new IsolationBoundaryError(isolationRefusal(target, env));
}

/** Non-throwing twin of assertRepoTargetAllowed. */
export function repoTargetAllowed(target: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isProdInstance(env)) return true;
  return !isProdRepoTarget(target);
}

export type InstanceRepoTarget =
  | { ok: true; slug: string }
  | { ok: false; refusal: string };

/**
 * Resolve the instance's own GitHub repo slug from ITS environment — the
 * replacement for every historical `process.env.GITHUB_REPO_SLUG || 'example-org/crossmodel'`
 * default (the silent production fallback this module exists to remove).
 *
 * - production instance: the configured env var, else the production repo
 *   (the production default is CORRECT there — unchanged behavior);
 * - non-prod instance: the configured env var ONLY. Unset ⇒ an explicit
 *   refusal (nothing to read — the caller degrades loudly, e.g. the fleet
 *   pulse hides its shipping tile); configured to the production repo ⇒ a
 *   refusal (hard fail text, never a prod read).
 */
export function resolveInstanceRepoTarget(env: NodeJS.ProcessEnv = process.env, envVar: 'GITHUB_REPO_SLUG' | 'INFRA_WATCH_REPO' | 'SELF_REPO' = 'GITHUB_REPO_SLUG'): InstanceRepoTarget {
  const configured = String(env[envVar] ?? '').trim();
  if (isProdInstance(env)) {
    // Production keeps the historical default; a configured value is
    // canonicalized the same way as on non-prod (a URL spelling works too).
    if (!configured) return { ok: true, slug: PROD_REPO };
    const norm = normalizeGithubRepoTarget(configured);
    if (norm) return { ok: true, slug: norm };
    // Unrecognized shape: pass through lowercased (the historical behavior —
    // the caller's fetch will 404 loudly rather than silently re-targeting).
    return { ok: true, slug: configured.toLowerCase() };
  }
  if (!configured) {
    return {
      ok: false,
      refusal: `ISOLATION BOUNDARY (DIGBY_INSTANCE=${instanceKind(env)}): ${envVar} is not configured — refusing to fall back to the production repo ${PROD_REPO}. Set ${envVar} to this instance's own repo (your fork) to run the autonomous loop against it; without it this surface reports nothing.`,
    };
  }
  const norm = normalizeGithubRepoTarget(configured);
  if (!norm) {
    return { ok: false, refusal: `ISOLATION BOUNDARY: ${envVar}="${configured}" is not a GitHub repo slug ("owner/name" or a github.com URL) — cannot resolve this instance's own repo target.` };
  }
  if (norm === PROD_REPO) {
    return { ok: false, refusal: isolationRefusal(configured, env) };
  }
  return { ok: true, slug: norm };
}

/**
 * The instance's OWN repo slug as a plain string — the self-merge
 * `ownRepoSlug()` shape (a string the caller compares against a merge target).
 * Production: the configured env var, else the production repo (unchanged).
 * Non-prod: the configured env var ONLY — unset ⇒ '' (no own repo configured;
 * nothing matches, so no self-improvement surface silently retargets prod),
 * configured to the production repo ⇒ IsolationBoundaryError (HARD FAIL).
 */
export function resolveInstanceOwnRepoSlug(envVar: 'GITHUB_REPO_SLUG' | 'INFRA_WATCH_REPO' | 'SELF_REPO' = 'SELF_REPO', env: NodeJS.ProcessEnv = process.env): string {
  const r = resolveInstanceRepoTarget(env, envVar);
  if (r.ok) return r.slug;
  if (!String(env[envVar] ?? '').trim()) return '';
  throw new IsolationBoundaryError(r.refusal);
}

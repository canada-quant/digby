/**
 * Complaint-surface classifier (ticket a2540aaa) — a PURE leaf, imported by the
 * framework-signal sweep and test suites only.
 *
 * THE PROBLEM: the sweep's missed-bug detector files the CHAT's complaint as
 * about='digby_platform' because it reads the chat the complaint appeared in,
 * not the surface the complaint is ABOUT. A deckpose.com complaint from a chat
 * in the deckpose product's project landed in the platform queue (the live
 * 4e818bb9 instance), where the platform lane had to disposition-and-hand-off
 * instead of fixing.
 *
 * THE RULE: extract the non-platform domains the complaint text mentions and
 * match them to the owner's REPO-BOUND non-platform projects. A match routes
 * the complaint to that product project (about='user_project' +
 * userProjectId); anything else — no domains, only platform/generic domains,
 * an ambiguous or unmatched domain, a matchless platform chat — keeps
 * today's behavior (about='digby_platform'). MIS-FILING is safer than
 * MIS-ROUTING: only a confident tier decides otherwise.
 *
 * Tiers (ONE distinct match routes; first match wins among tiers):
 *   1. chatProject  — the chat's own product project matches a complaint domain
 *                     by its project-name / repo-slug tokens ("deckpose").
 *   2. candidates   — any other repo-bound non-platform project matches the
 *                     same way.
 *   3. env map      — PRODUCT_PROJECT_DOMAINS ("proj=domain.tld domain2.tld,…")
 *                     names the project for a domain the repo/name tokens
 *                     cannot imply (e.g. product "optcg" serving deckpose.com).
 *   ambiguous       — TWO OR MORE DISTINCT product projects match (across any
 *                     tiers) ⇒ platform: the surface itself is unclear.
 *   null            — platform (conservative fallback; callers stamp
 *                     about='digby_platform' exactly as before).
 *
 * Kill switch MISSED_BUG_SURFACE_ROUTING_DISABLED=1 restores the
 * platform-only filing byte-for-byte at BOTH ends (sweep stamping + dispatch
 * lane home) — a mis-route must be revertible from box env without a deploy.
 * The PLATFORM-project surface guard (ticket 9471d338) is never weakened
 * here: the platform project itself never matches, so its complaints can
 * never route away from the platform lane.
 */

export interface ProjectShape {
  id?: unknown;
  name?: unknown;
  repoUrl?: unknown;
  userId?: unknown;
}

export type SurfaceRouteTier = 'chat_project' | 'candidates' | 'env_map' | null;

export interface ResolvedSurface {
  /** 'user_project' ⇒ the caller stamps about='user_project' + userProjectId. */
  surface: 'digby_platform' | 'user_project';
  /** The routed project's id (tier 1/2: the project row; tier 3: the env key). */
  userProjectId?: string;
  /** The project's repo slug when it carries one ("owner/name"). */
  repoSlug?: string;
  tier: SurfaceRouteTier;
  /** One line of WHY (≤200 chars) — rides the ticket's context.surfaceRoute. */
  evidence?: string;
}

/** The platform repo — never a routing target (ticket 9471d338). */
const PLATFORM_NAME = 'crossmodel';

const MULTIPART_SUFFIXES = new Set(['co.uk', 'org.uk', 'com.au', 'co.jp', 'com.br', 'co.nz', 'com.mx']);

/**
 * Words too generic to imply a project from a project NAME (the repo slug
 * token has no stopwords — an exact slug leg is its own exact match).
 */
const NAME_TOKEN_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'app', 'inc', 'llc', 'labs', 'project', 'digby', 'crossmodel']);

/** Substring matches need room — "ai.com" must never imply project "ai". */
const SUBSTRING_MIN = 4;

export function missedBugSurfaceRoutingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MISSED_BUG_SURFACE_ROUTING_DISABLED === '1';
}

/** Registered domain of a hostname (last two labels; known multi-part suffixes take three). Pure. */
export function registeredDomain(hostname: string): string {
  const labels = String(hostname ?? '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length === 0) return '';
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTIPART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'<>)]*)?/gi;

/** The distinct registered domains any URL-ish token in the text carries. Pure. */
export function extractDomains(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(URL_RE)) {
    let host = m[0]
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .replace(/^www\./i, '')
      .toLowerCase();
    if (!host.includes('.')) continue;          // bare word, not a domain
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue; // IPv4 literal
    if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.example')) continue;
    const d = registeredDomain(host);
    if (d) out.add(d);
  }
  return [...out];
}

/** The domains that name Digby itself (the platform surface). Pure. */
export function isPlatformDomain(d: string): boolean {
  return d === 'digby.example.com' || d === 'digby' || d.endsWith('.digby.example.com') || d === 'digby.example.com.';
}

/** "https://github.com/owner/name.git" | "owner/name" | "git@github.com:owner/name" → "owner/name". Pure. */
export function repoSlugOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const m = s.match(/(?:github\.com[/:]|^)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Is this project the PLATFORM project (the Digby repo / the framework lane
 * home)? Platform projects never route complaints away (9471d338). Pure.
 */
export function isPlatformProjectShape(p: ProjectShape | null | undefined): boolean {
  if (!p) return false;
  if (typeof p.name === 'string' && p.name.trim().toLowerCase() === PLATFORM_NAME) return true;
  const slug = repoSlugOf(p.repoUrl);
  return !!slug && slug.toLowerCase() === 'canada-quant/digby';
}

/** Name/repo tokens a product project carries for domain matching. Pure. */
export function projectRepoTokens(p: ProjectShape): string[] {
  const tokens = new Set<string>();
  const slug = repoSlugOf(p.repoUrl);
  if (slug) {
    const repo = slug.split('/')[1]?.toLowerCase();
    if (repo) tokens.add(repo);
  }
  if (typeof p.name === 'string') {
    for (const w of p.name.toLowerCase().split(/[^a-z0-9.]+/)) {
      if (w.length >= 3 && !NAME_TOKEN_STOPWORDS.has(w)) tokens.add(w);
    }
  }
  return [...tokens];
}

/** A repo-bound non-platform project that any of the domains implies. Pure. */
function matchByTokens(domains: string[], p: ProjectShape): string | null {
  const slug = repoSlugOf(p.repoUrl);
  const tokens = projectRepoTokens(p);
  for (const d of domains) {
    const base = d.replace(/\.[a-z]{2,}$/, ''); // deckpose.com → deckpose
    if (!base) continue;
    for (const t of tokens) {
      if (t === base) return `domain ${d} matches project token '${t}'`;
      if (t.length >= SUBSTRING_MIN && base.length >= SUBSTRING_MIN && (t.includes(base) || base.includes(t))) {
        return `domain ${d} matches project token '${t}' (substring)`;
      }
    }
    if (slug) {
      const repo = slug.split('/')[1]?.toLowerCase();
      if (repo && base.length >= SUBSTRING_MIN && (repo.includes(base) || base.includes(repo))) {
        return `domain ${d} matches repo ${slug}`;
      }
    }
  }
  return null;
}

/** PRODUCT_PROJECT_DOMAINS: "proj-key=dom.one dom-two,other=dom3.tld". Pure. */
export function productProjectDomains(env: NodeJS.ProcessEnv = process.env): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const raw = String(env.PRODUCT_PROJECT_DOMAINS ?? '').trim();
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const key = pair.slice(0, i).trim();
    const doms = pair.slice(i + 1).split(/[\s|]+/).map((d) => d.toLowerCase()).filter(Boolean);
    if (!key || !doms.length) continue;
    const set = map.get(key) ?? new Set<string>();
    for (const d of doms) set.add(d);
    map.set(key, set);
  }
  return map;
}

/**
 * Classify ONE complaint. Returns the routed surface ('user_project') only on
 * a confident tier match; every other shape — no domains, platform-only
 * domains, unmatched domains, a platform project everywhere — falls back to
 * null (⇒ about='digby_platform', today's behavior). Domain evidence is not
 * special-cased per-host: it counts only when a workspace project's own
 * name/repo tokens (or the env map) imply the domain, so a generic hostname
 * matches nothing and stays platform. Pure; the sweep's run() supplies the
 * fetched rows.
 */
export function classifyComplaintSurface(input: {
  text: string;
  chatProject?: ProjectShape | null;
  candidateProjects: ReadonlyArray<ProjectShape>;
  env?: NodeJS.ProcessEnv;
}): ResolvedSurface {
  const env = input.env ?? process.env;
  const allDomains = extractDomains(input.text);
  if (!allDomains.length) return { surface: 'digby_platform', tier: null };
  const domains = allDomains.filter((d) => !isPlatformDomain(d));
  if (!domains.length) return { surface: 'digby_platform', tier: null };

  const chatProduct = !isPlatformProjectShape(input.chatProject) ? input.chatProject : null;
  // ONE distinct product match routes; TWO OR MORE DISTINCT product projects
  // matching the complaint text are AMBIGUOUS ⇒ platform (mis-filing is
  // safer than mis-routing). The same project matching through several
  // mechanisms (chat tokens AND the env map) is still ONE match — its tier
  // stays the first that identified it.
  const matchedIds = new Set<string>();
  let first: ResolvedSurface | null = null;
  const consider = (p: ProjectShape, tier: SurfaceRouteTier, why: string): void => {
    if (p.id == null && p.name == null) return; // not a matchable project row
    const id = String(p.id ?? p.name ?? '');
    if (matchedIds.has(id)) return;
    matchedIds.add(id);
    if (!first) {
      first = {
        surface: 'user_project',
        userProjectId: id,
        repoSlug: repoSlugOf(p.repoUrl) ?? undefined,
        tier,
        evidence: clip(why),
      };
    }
  };
  if (chatProduct) {
    const why = matchByTokens(domains, chatProduct);
    if (why) consider(chatProduct, 'chat_project', `${why} (chat's own project)`);
  }
  for (const p of input.candidateProjects) {
    if (isPlatformProjectShape(p)) continue;
    if (chatProduct && typeof p.id === 'string' && p.id === chatProduct.id) continue;
    const why = matchByTokens(domains, p);
    if (why) {
      consider(p, 'candidates', why);
      if (matchedIds.size > 1) return { surface: 'digby_platform', tier: null };
    }
  }
  const byEnv = productProjectDomains(env);
  if (byEnv.size) {
    for (const [key, doms] of byEnv) {
      const hit = domains.find((d) => doms.has(d) || doms.has(`*.${d}`));
      if (!hit) continue;
      // The env key names the project by id (preferred) or exact name; the
      // caller's candidate list is the resolver — a key nothing resolves to
      // (or one resolving to the platform) is ambiguous evidence ⇒ platform.
      const byId = input.candidateProjects.find((p) => typeof p.id === 'string' && p.id === key);
      const byName = input.candidateProjects.find(
        (p) => typeof p.name === 'string' && p.name.trim().toLowerCase() === key.toLowerCase(),
      );
      const p = byId ?? byName;
      if (!p || isPlatformProjectShape(p)) return { surface: 'digby_platform', tier: null };
      consider(p, 'env_map', `domain ${hit} maps to project '${key}' via PRODUCT_PROJECT_DOMAINS`);
      if (matchedIds.size > 1) return { surface: 'digby_platform', tier: null };
    }
  }
  return first ?? { surface: 'digby_platform', tier: null };
}

function clip(s: string): string {
  return s.length <= 200 ? s : `${s.slice(0, 197)}...`;
}

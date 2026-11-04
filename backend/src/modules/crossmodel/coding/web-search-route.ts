/**
 * WEB-SEARCH ROUTE POLICY (goal 9ecd595e / todo 9cd3fad1 — "WEB-2", WRP-1 defects D1, D2, D3, D5).
 *
 * THE INCIDENT (Polk County run, 2026-10-31), in the order it happened:
 *   1. three searches in a row were near-RESTATEMENTS of the headline ("Polk
 *      County 281 arrested…" → "\"Polk County\" 281 arrested human trafficking
 *      opera" → "WESH Polk County 281 arrests…"). The provider was never down;
 *      the ROUTE was. Budget burned on paraphrases (D1).
 *   2. the results that did come back were 2022–2023 stings shown against a
 *      story framed as fresh — no recency bound anywhere in the pipeline, so
 *      publication dates had to be eyeballed downstream (D2).
 *   3. the answer body carried "The aggregated fetch got throttled — going
 *      direct to the outlets instead": a single-provider dependency narrated to
 *      the user. Throttling needs a silent, bounded, provider-rotating ladder and
 *      an "here is what I could verify" degrade — never an apology (D3).
 *   4. a guessed CMS path ("…/news") 404'd and was reported as if the source
 *      were down. A 404 from a CONSTRUCTED url is our bug; the real URL must be
 *      resolved through search first (D5).
 *
 * This module is the POLICY half and imports nothing (a pure leaf, so the tool
 * executor can import it without touching the mcp-search mock contract in
 * tests). Every decision it makes is a value a test can pin:
 *
 *   - the paraphrase guard (`querySimilarity` + `planNextRoute`) — refuses a
 *     re-issue and names the next SOURCE CLASS instead;
 *   - the hard recency bound (`inferRecency`) — derived from the user's own
 *     framing, rendered as an `after:YYYY-MM-DD` bound and as the window label
 *     the answer may report;
 *   - the route ladder (`ROUTE_LADDER`) — SERP → news feed → direct outlet →
 *     primary domain, one class per attempt, never a repeat of the same class;
 *   - the bounded backoff (`backoffPlan`) — exponential, jittered, capped, with
 *     a total attempt budget so a run can never spin.
 *
 * Kill switch: WEB_SEARCH_ROUTE_LADDER_DISABLED=1 (read at the call site).
 */

/**
 * The source classes, in escalation order. A retry moves DOWN this list; it
 * never re-issues the same class with a reworded query (that is the incident).
 */
export const ROUTE_LADDER = ['serp', 'news_feed', 'direct_outlet', 'primary_domain'] as const;
export type RouteClass = (typeof ROUTE_LADDER)[number];

/** Human label per class — used in tool results and telemetry, never as an apology. */
export const ROUTE_LABEL: Record<RouteClass, string> = {
  serp: 'general web search',
  news_feed: 'news feed',
  direct_outlet: 'direct outlet fetch',
  primary_domain: 'official/primary source',
};

/** Two searches whose queries overlap at/above this are the SAME request reworded. */
export const PARAPHRASE_SIMILARITY = 0.6;
/** Below this a query shares nothing with the previous one — genuinely a new search. */
export const NEW_QUERY_SIMILARITY = 0.34;

/** Total search attempts one question may spend across every route (D3 budget). */
export const MAX_ROUTE_ATTEMPTS = 4;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'by', 'at',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'as', 'if', 'into', 'about', 'over', 'after', 'before', 'than', 'then', 'what', 'which',
  'who', 'when', 'where', 'why', 'how', 'all', 'any', 'some', 'latest', 'news', 'new',
  'search', 'find', 'look', 'get', 'show', 'tell', 'please',
]);

/**
 * Light suffix stem, so the RIFFED forms of one word compare equal — the
 * incident's own drift is exactly this ("arrested" in the headline, "arrests"
 * in the third attempt, "trafficking" in the second). Deliberately minimal:
 * trailing plural/-ed/-ing only, never a dictionary stemmer, because a wrong
 * stem merges two subjects and a missed one only costs a redundant search.
 */
function stem(tok: string): string {
  let t = tok;
  if (t.length >= 6 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length >= 5 && t.endsWith('ed')) t = t.slice(0, -2);
  else if (t.length >= 5 && t.endsWith('es')) t = t.slice(0, -2);
  else if (t.length >= 4 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  return t;
}

/** Distinctive lower-case tokens of a query (length ≥ 3, stopwords and the
 *  operators a searcher adds for emphasis removed, light-stemmed). */
export function queryTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9'_-]*/g) || []) {
    const tok = raw.replace(/^['"_-]+|['"_-]+$/g, '');
    if (tok.length >= 3 && !STOPWORDS.has(tok)) out.add(stem(tok));
  }
  return out;
}

/** Normalised query form — quotes, extra whitespace and the operators a model
 *  sprinkles in ("\"Polk County\" 281") all collapse, so two cosmetic variants of
 *  identical text compare as identical. */
export function normalizeQuery(query: string): string {
  return [...queryTokens(query)].sort().join(' ');
}

/**
 * Similarity of two queries in [0,1]: the Jaccard index of their distinctive
 * tokens (|∩| / |∪|). Chosen over containment because the incident's retries
 * ADDED words as often as they dropped them ("WESH Polk County 281 arrests" vs
 * "\"Polk County\" 281 arrested human trafficking opera"); Jaccard charges for
 * both the new tokens and the lost ones, so a genuine refinement (one extra
 * qualifier) stays under the paraphrase bar while a restatement does not.
 */
export function querySimilarity(a: string, b: string): number {
  const ta = queryTokens(a);
  const tb = queryTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** The highest similarity of `query` to any query already issued this run. */
export function closestIssued(query: string, issued: RouteAttempt[]): { query: string; similarity: number } | null {
  let best: { query: string; similarity: number } | null = null;
  for (const prev of issued || []) {
    const s = querySimilarity(query, prev.query);
    if (!best || s > best.similarity) best = { query: prev.query, similarity: s };
  }
  return best;
}

// ── D2: the hard recency bound ───────────────────────────────────────────────

export type RecencyWindow = 'day' | 'week' | 'month' | 'year';

export interface RecencyBound {
  /** The window the search was confined to, or null when the question is undated. */
  window: RecencyWindow | null;
  /** ISO date (YYYY-MM-DD) an `after:` operator carries, or null. */
  afterDate: string | null;
  /** What the answer may SAY was searched ("past week"), or null. */
  label: string | null;
  /** Which framing produced it — telemetry, and what makes a wrong bound debuggable. */
  source: string | null;
}

const DAY_MS = 86_400_000;

/**
 * Derive the recency window from the USER'S OWN framing (D2). The incident's
 * question was framed as current ("bust", "arrested", a headline), and stale
 * 2022–2023 results came back because nothing bounded the search.
 *
 * Order matters: the narrowest stated window wins. An explicit date beats a
 * relative word beats a freshness adjective. When nothing in the text is
 * time-shaped, the bound is null — inventing one would silently drop the right
 * answer for an undated question, and the caller falls back to today's window
 * only for an explicit news request.
 */
export function inferRecency(text: string, now: number = Date.now()): RecencyBound {
  const q = String(text ?? '').toLowerCase();
  const mk = (window: RecencyWindow, source: string): RecencyBound => {
    const days = window === 'day' ? 1 : window === 'week' ? 7 : window === 'month' ? 31 : 365;
    const after = new Date(now - days * DAY_MS).toISOString().slice(0, 10);
    const label = window === 'day' ? 'past 24 hours' : window === 'week' ? 'past week' : window === 'month' ? 'past month' : 'past year';
    return { window, afterDate: after, label, source };
  };

  // Explicitly stale framing cancels the freshness assumption.
  if (/\b(19|20)\d{2}\b/.test(q) && /\b(in|during|back in|from)\s+(19|20)\d{2}\b/.test(q)) {
    return { window: null, afterDate: null, label: null, source: 'explicit-year' };
  }
  if (/\b(today|tonight|just now|this morning|this afternoon|breaking|minutes ago|hours ago)\b/.test(q)) return mk('day', 'same-day framing');
  if (/\b(this week|past week|last week|weekly|past few days|this weekend)\b/.test(q)) return mk('week', 'this-week framing');
  if (/\b(this month|past month|last month|monthly|past few weeks)\b/.test(q)) return mk('month', 'this-month framing');
  if (/\b(this year|past year|last year|annual|yearly)\b/.test(q)) return mk('year', 'this-year framing');
  if (/\b(latest|current|currently|recent|recently|fresh|live|update|news|happening|developing)\b/.test(q)) return mk('week', 'freshness framing');
  // Headline framing: the incident's question was a NEWS HEADLINE ("Polk County
  // 281 arrested human trafficking bust") with no freshness adverb in it, so a
  // vocabulary-only detector would have left it unbounded and 2022–2023 stings
  // came back. A question naming a live EVENT noun is a news question.
  if (/\b(bust|busted|raid|raided|sting|arrest|arrests|arrested|indicted|indictment|charged|crackdown|manhunt|shooting|outbreak|recall|resigned|fired|elected|announced|announces|operation)\b/.test(q)) {
    return mk('week', 'news-event framing');
  }
  return { window: null, afterDate: null, label: null, source: null };
}

/** Apply the bound to a query as the `after:` operator (the one form every
 *  provider in the chain understands, and the shape news.service.ts already uses). */
export function withRecencyBound(query: string, bound: RecencyBound): string {
  if (!bound.afterDate) return query;
  if (/\bafter:\d{4}-\d{2}-\d{2}\b/.test(query)) return query; // already bounded
  return `${query} after:${bound.afterDate}`;
}

/**
 * Drop results whose publication date is older than the bound (D2's "filter the
 * candidate set, don't eyeball dates downstream"). A result with NO date is
 * KEPT — an undated page is not evidence of staleness, and dropping it would
 * lose real sources for questions where the provider omits dates. The count of
 * filtered rows comes back so the envelope can say what was removed.
 */
export function filterByRecency<T extends { date?: string | number | null }>(
  rows: T[],
  bound: RecencyBound,
  now: number = Date.now(),
): { kept: T[]; removed: number } {
  if (!bound.window) return { kept: rows, removed: 0 };
  const days = bound.window === 'day' ? 1 : bound.window === 'week' ? 7 : bound.window === 'month' ? 31 : 365;
  const cutoff = now - days * DAY_MS;
  let removed = 0;
  const kept = rows.filter((r) => {
    const raw = r?.date;
    if (raw === null || raw === undefined || raw === '') return true;
    const t = typeof raw === 'number' ? raw : Date.parse(String(raw));
    if (!Number.isFinite(t)) return true; // "3 days ago"-style text the provider gave: keep, do not guess
    if (t < cutoff) { removed += 1; return false; }
    return true;
  });
  return { kept, removed };
}

// ── D1 + D3: the route ladder ────────────────────────────────────────────────

export interface RouteAttempt {
  /** The query actually issued (recency-bounded form). */
  query: string;
  route: RouteClass;
  /** Did it come back with usable results? Only a FAILED attempt licenses a
   *  route change — a successful search is never second-guessed. */
  ok: boolean;
}

export interface RouteState {
  /** Attempts already made for this question, oldest first. */
  issued: RouteAttempt[];
  /** Route classes already tried, in order. */
  routes: RouteClass[];
  /** Attempts spent against MAX_ROUTE_ATTEMPTS. */
  attempts: number;
  /** True once the ladder has run out (the caller degrades honestly). */
  exhausted: boolean;
}

export function newRouteState(): RouteState {
  return { issued: [], routes: [], attempts: 0, exhausted: false };
}

export interface RoutePlan {
  /** 'search' = issue this query on this route; 'refuse' = do NOT issue (a
   *  paraphrase of a spent attempt) and tell the model what to do instead;
   *  'exhausted' = the budget is gone, degrade honestly. */
  action: 'search' | 'refuse' | 'exhausted';
  route: RouteClass | null;
  /** The query to issue (recency-bounded when the framing carried one). */
  query: string | null;
  /** Why this decision — telemetry and the message shown to the model. */
  reason: string;
  recency: RecencyBound;
  /** The nearest already-issued query, when the planner refused. */
  duplicateOf?: string;
  similarity?: number;
}

/**
 * Decide the NEXT action for one search question.
 *
 * D1: a query that restates an already-issued one is REFUSED — not silently
 * merged — and the refusal carries the next source class to try instead, which
 * is the whole point (the incident's model kept rewording because nothing told
 * it that rewording was the wrong move).
 *
 * D3: the attempt budget is spent here, so "bounded attempts" is a property of
 * the policy rather than a hope about the model's behaviour.
 */
export function planNextRoute(
  rawQuery: string,
  state: RouteState,
  now: number = Date.now(),
  maxAttempts: number = MAX_ROUTE_ATTEMPTS,
): RoutePlan {
  const recency = inferRecency(rawQuery, now);
  const bounded = withRecencyBound(rawQuery, recency);

  if (state.attempts >= maxAttempts) {
    return {
      action: 'exhausted', route: null, query: null, recency,
      reason: `the ${maxAttempts}-attempt search budget for this question is spent`,
    };
  }

  const near = closestIssued(rawQuery, state.issued);
  if (near && near.similarity >= PARAPHRASE_SIMILARITY) {
    const prev = state.issued.find((a) => a.query === near.query);
    // A restatement of a FAILED attempt must change the ROUTE; a restatement of
    // one that WORKED is redundant — the results are already in context.
    const next = prev && prev.ok ? null : nextRouteClass(state.routes);
    return {
      action: next ? 'refuse' : prev && prev.ok ? 'refuse' : 'exhausted',
      route: next,
      query: null,
      recency,
      reason: prev && prev.ok
        ? `this query restates "${prev.query.slice(0, 80)}" (${Math.round(near.similarity * 100)}% token overlap), which ALREADY returned results in this run — read those results instead of searching again`
        : next
          ? `this query restates a failed attempt (${Math.round(near.similarity * 100)}% token overlap) — re-issuing it spends budget without changing the route; use ${ROUTE_LABEL[next]} instead`
          : 'every search route for this question has already been tried',
      duplicateOf: near.query,
      similarity: near.similarity,
    };
  }

  return {
    action: 'search',
    route: nextRouteClass(state.routes) ?? 'serp',
    query: bounded,
    recency,
    reason: recency.window ? `bounded to the ${recency.label} (${recency.source})` : 'undated question — no recency bound',
  };
}

/** The next untried class on the ladder (null when every class is spent). */
export function nextRouteClass(routes: RouteClass[]): RouteClass | null {
  for (const r of ROUTE_LADDER) if (!routes.includes(r)) return r;
  return null;
}

/**
 * One search QUESTION's ladder state. A run asks several questions ("who
 * announced it" then "what did the sheriff's site say"); each gets its own
 * budget, so a 4-attempt ceiling can never gag a legitimate second question.
 * A query joins an existing cluster when it shares enough vocabulary with that
 * cluster's first query — i.e. it is the same subject being asked again.
 */
export interface RouteCluster {
  /** The cluster's opening query (its identity). */
  key: string;
  state: RouteState;
}

/**
 * Find the cluster a query belongs to, creating one when it opens a new
 * question. Matching is on the FIRST query of each cluster: a retry drifts
 * ("WESH Polk County 281 arrests"), but it stays close to where it started.
 */
export function clusterFor(query: string, clusters: RouteCluster[], threshold = NEW_QUERY_SIMILARITY): { cluster: RouteCluster; created: boolean } {
  let best: { cluster: RouteCluster; similarity: number } | null = null;
  for (const c of clusters) {
    const s = querySimilarity(query, c.key);
    if (!best || s > best.similarity) best = { cluster: c, similarity: s };
  }
  if (best && best.similarity >= threshold) return { cluster: best.cluster, created: false };
  const cluster: RouteCluster = { key: query, state: newRouteState() };
  clusters.push(cluster);
  return { cluster, created: true };
}

/** Cluster-aware plan: the executor's entry point. */
export function planNextRouteForRun(
  rawQuery: string,
  clusters: RouteCluster[],
  now: number = Date.now(),
  maxAttempts: number = MAX_ROUTE_ATTEMPTS,
): RoutePlan {
  const { cluster } = clusterFor(rawQuery, clusters);
  return planNextRoute(rawQuery, cluster.state, now, maxAttempts);
}

/** Record an issued attempt (mutates — callers own one state per question).
 *  `ok` says whether it produced usable results: a SUCCESSFUL search keeps the
 *  paraphrase guard quiet for a confirmatory follow-up, while only a FAILED one
 *  escalates the ladder. */
export function recordAttempt(state: RouteState, query: string, route: RouteClass, ok = false): void {
  state.issued.push({ query, route, ok });
  if (!state.routes.includes(route)) state.routes.push(route);
  state.attempts += 1;
  state.exhausted = state.attempts >= MAX_ROUTE_ATTEMPTS || nextRouteClass(state.routes) === null;
}

// ── D3: bounded backoff (silent) ─────────────────────────────────────────────

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8_000;
export const BACKOFF_JITTER_MS = 400;

/**
 * Exponential backoff with jitter for one retry (attempt is 1-based). Capped,
 * so a provider documenting a very long wait can never park a chat run.
 * `rand` is injectable for deterministic tests.
 */
export function backoffMs(attempt: number, rand: number = Math.random()): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.round((rand * 2 - 1) * BACKOFF_JITTER_MS); // ±jitter, so retries de-synchronise
  return Math.max(0, Math.min(BACKOFF_CAP_MS, exp + jitter));
}

/** Throttle / transient shapes that earn a silent retry or a route change
 *  rather than a user-facing apology (D3). */
export function isTransientSearchFailure(detail: { code?: string | null; status?: number | null; retryable?: boolean | null } | null | undefined): boolean {
  if (!detail) return false;
  const code = String(detail.code || '').toLowerCase();
  if (/rate_limit|rate-limit|throttl|bucket_rate|too_many|429/.test(code)) return true;
  if (detail.status === 429 || detail.status === 408) return true;
  if (typeof detail.status === 'number' && detail.status >= 500) return true;
  return detail.retryable === true;
}

// ── D5: resolve an official URL instead of guessing one ──────────────────────

/**
 * The search query that RESOLVES a domain's real page (D5). A constructed CMS
 * path ("sheriff.org/news") is a guess; `site:` against the domain is how the
 * real newsroom URL is found before anything is fetched.
 */
export function officialUrlSearchQuery(domain: string, subject?: string): string {
  const host = String(domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  const sub = String(subject || '').trim();
  return `site:${host} ${sub}`.trim();
}

/** Extract the best URL for `domain` from SERP text/HTML. Returns null when the
 *  SERP holds no link to that domain — the caller must then say the page was
 *  NOT FOUND, never that the source is down. */
export function resolveDomainUrl(serpText: string, domain: string): string | null {
  const host = String(domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
  if (!host) return null;
  const urls = String(serpText ?? '').match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
  const hits = urls
    .map((u) => u.replace(/[.,;:]+$/, ''))
    .filter((u) => {
      try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase() === host; } catch { return false; }
    })
    // A news/index path beats a bare homepage.
    .sort((a, b) => scorePath(b) - scorePath(a));
  return hits[0] ?? null;
}

function scorePath(u: string): number {
  const p = (() => { try { return new URL(u).pathname.toLowerCase(); } catch { return ''; } })();
  let s = 0;
  if (/news|press|media|release|update|story|article/.test(p)) s += 3;
  if (p.length > 1) s += 1;
  if (/\.(pdf|jpg|png|css|js)$/.test(p)) s -= 5;
  return s;
}

/**
 * What a search result tells the MODEL when the ladder is spent (D3's honest
 * degrade). Deliberately shaped as "here is what I could verify" plus the next
 * concrete move — never an apology, and never a claim that nothing exists.
 */
export function exhaustedSearchMessage(question: string, tried: RouteClass[], verifiedNote?: string): string {
  const classes = tried.length ? tried.map((r) => ROUTE_LABEL[r]).join(' → ') : 'none';
  return `Web search could not confirm this after ${tried.length || 0} route(s) (${classes}). `
    + `Answer from what IS verified${verifiedNote ? ` — ${verifiedNote}` : ''}, and state plainly which specifics you could not confirm. `
    + `Do NOT report the sources as down and do not narrate the retrieval: deliver the verified/unverified split. `
    + `Question: ${question.slice(0, 200)}`;
}

/** The news-feed route (a genuinely different source class from a SERP): a
 *  Google-News RSS query. Returned as a URL the scrape tool can fetch. */
export function newsFeedUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

/**
 * Parse a Google-News-RSS document into link/title/date rows. Kept here (pure)
 * so the news route is testable without a network or an XML dependency.
 */
export function parseNewsFeed(xml: string, limit = 10): Array<{ title: string; url: string; date: string | null; source: string | null }> {
  const out: Array<{ title: string; url: string; date: string | null; source: string | null }> = [];
  const items = String(xml ?? '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const item of items) {
    const pick = (tag: string): string | null => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(item);
      if (!m) return null;
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
        .trim();
    };
    const url = pick('link');
    if (!url || !/^https?:/i.test(url)) continue;
    out.push({ title: pick('title') || '(untitled)', url, date: pick('pubDate'), source: pick('source') });
    if (out.length >= limit) break;
  }
  return out;
}

/** One line per news item, as the tool result hands it to the model. */
export function renderNewsFeed(rows: Array<{ title: string; url: string; date: string | null; source: string | null }>, bound: RecencyBound): string {
  const head = bound.label ? `News feed (${bound.label}):` : 'News feed:';
  if (!rows.length) return `${head} no items matched.`;
  return `${head}\n${rows.map((r, i) => `[${i + 1}] ${r.title}${r.source ? ` — ${r.source}` : ''}${r.date ? ` · ${r.date}` : ''}\n${r.url}`).join('\n')}`;
}
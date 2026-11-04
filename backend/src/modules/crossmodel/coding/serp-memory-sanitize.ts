/**
 * SERP-payload sanitization for session-memory embeds (ticket f03b739c,
 * 2026-10-13).
 *
 * The incident: a run's search_engine call against BrightData returned a raw
 * SERP JSON body — organic results PLUS provider scaffolding: base64 webp
 * favicon blobs (`data:image/webp;base64,…`), sxsrf/fbs page-validation
 * tokens in result URLs, navigation/pagination arrays, encrypted-tbn image
 * URLs. That body flowed through the agent-loop tool-result OFFLOAD paths
 * (agent.ts storeFindings calls + compaction's transcript embed) into
 * session memory verbatim: the quality gate (worthEmbedding) passes anything
 * ≥200 chars, so every ~3.5k store chunk carried garbage that now competes
 * with real content in every future search_memory retrieval, wastes tokens
 * on retrieval, and pollutes compaction context.
 *
 * This module is the WRITE-BOUNDARY gate: pure, never throws, and applied to
 * a tool result BEFORE it is offered to session memory. Three shapes:
 *
 *  1. FAILED / provider-error bodies — the tool already reported a failure
 *     ("Web search failed — the search provider answered with an error…",
 *     ticket ca805a61 text, or the "Unexpected non-JSON response from
 *     BrightData" class): NEVER embed the body. The offload path stores a
 *     compact error record instead (tool, query, error class, no raw body).
 *  2. A parseable SERP JSON — distill it to the useful signal (organic
 *     titles + links + descriptions) and DROP the scaffolding arrays/keys
 *     wholesale. Falls through unchanged when nothing parseable is found
 *     (never guess at text it cannot structure).
 *  3. Everything else — unchanged (ordinary page content, run output…).
 *
 * Kill switch: SERP_MEMORY_SANITIZE_DISABLED=1 restores the pre-ticket
 * behavior byte-for-byte (read per call — an env flip needs no restart).
 */

/** Kill switch (per call, no restart needed). */
export function serpMemorySanitizeDisabled(): boolean {
  const v = process.env.SERP_MEMORY_SANITIZE_DISABLED || '';
  return v === '1' || /^true$/i.test(v);
}

/**
 * Failure-shaped tool-result heads that must NEVER be embedded. The
 * search tier (mcp-search.ts + serp-provider-guard.ts, tickets 9b944f30 /
 * ca805a61) converts a provider error into the first surface; a THROWN
 * gateway/transport error is shaped `Tool call failed: <message>. DO NOT
 * retry…` by tool-executor.ts:1744 — so the second surface (the
 * "Unexpected non-JSON response from Bright Data" class, ticket f03b739c's
 * hard-error incident) arrives WRAPPED and is matched there too. Matched at
 * the START of the (whitespace-trimmed) result, or within the head of a
 * `Tool call failed:` wrapper.
 */
const NEVER_EMBED_PREFIXES = [
  // tool-executor.ts search_engine provider-error surface (ca805a61)
  'Web search failed — the search provider answered with an error',
  // the mcp-gateway JSON-envelope failure class (f03b739c evidence)
  'Unexpected non-JSON response from Bright Data',
] as const;

/** The thrown-error wrapper shape (tool-executor.ts:1744). */
const TOOL_CALL_FAILED_RE = /^Tool call failed: /;

/** True when a tool result is one of the harness's explicit search-failure
 *  surfaces — its raw body must never reach session memory. */
export function isFailedSearchResult(result: string): boolean {
  const t = String(result || '').trimStart();
  if (!t) return false;
  if (NEVER_EMBED_PREFIXES.some(p => t.startsWith(p))) return true;
  // The wrapped form: `Tool call failed: Unexpected non-JSON response from
  // Bright Data … DO NOT retry this tool.` (reviewer B1 aggravation, PR #1462).
  if (TOOL_CALL_FAILED_RE.test(t)) {
    const head = t.slice(0, 400);
    return NEVER_EMBED_PREFIXES.some(p => head.includes(p));
  }
  return false;
}

/**
 * A result that CARRIES a SERP body (embedded verbatim after a wrapper the
 * search tier prepends, e.g. mcp-search.ts's `[Web Search Results]\nQuery:
 * …\n\n` header). The wrapper header is the ONLY provenance-true trigger:
 * it is authored by the search tier itself (mcp-search.ts searchWithBrightData),
 * so anything carrying it IS a SERP. Raw-body heuristics (base64 blobs, an
 * `organic`/`results` array key) are NOT sufficient on their own — reviewer
 * finding P4d (PR #1462): an ordinary audit JSON with a `results:[{title,
 * detail, verdict}]` array matched the key heuristic and lost 87% of its
 * content to a 24-char distillate. A bare JSON body therefore requires BOTH
 * the array key AND the SERP item shape (a `link`-bearing item) before it is
 * treated as a SERP.
 */
const WRAPPER_HEADER_RE = /^\[Web Search Results\]\nQuery: [^\n]+\n\n/;
const BASE64_IMAGE_RE = /data:image\/(?:png|jpe?g|webp|gif|x-icon|svg\+xml);base64,/;
const ORGANIC_KEY_RE = /"(?:organic|results)"\s*:\s*\[/;

/** True when a parseable JSON object (tolerating a stray non-JSON prefix)
 *  carries at least one array whose items look like SERP results — an object
 *  with BOTH a string `title`/`snippet`-class field AND a string `link`/`url`.
 *  This is the shape gate that keeps ordinary JSON (audit reports, listings)
 *  out of the distiller. Pure; never throws. */
function jsonCarriesSerpItems(body: string): boolean {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    if (start < 0) return false;
    try { parsed = JSON.parse(body.slice(start)); } catch { return false; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  for (const value of Object.values(parsed)) {
    if (!Array.isArray(value) || !value.length) continue;
    let hits = 0;
    for (const item of value.slice(0, 5)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const hasLink = typeof item.link === 'string' || typeof item.url === 'string';
      const hasText = typeof item.title === 'string' || typeof item.snippet === 'string'
        || typeof item.description === 'string';
      if (hasLink && hasText) hits++;
    }
    // ≥2 link+text items (or the single item being the whole array) = a SERP
    // result array, not a coincidental shape.
    if (hits >= 2 || (hits >= 1 && value.length === 1)) return true;
  }
  return false;
}

/** True when the text carries SERP scaffolding worth stripping. */
export function looksLikeSerpPayload(result: string): boolean {
  const t = String(result || '');
  if (!t) return false;
  // Provenance-true: the search tier's own wrapper header.
  if (WRAPPER_HEADER_RE.test(t)) return true;
  // Bare JSON: needs the array key AND the SERP item shape (P4d guard).
  const body = WRAPPER_HEADER_RE.test(t) ? t.replace(WRAPPER_HEADER_RE, '') : t;
  if (BASE64_IMAGE_RE.test(t) && ORGANIC_KEY_RE.test(body)) return true;
  if (ORGANIC_KEY_RE.test(body) && jsonCarriesSerpItems(body)) return true;
  return false;
}

// ── SERP JSON distillation ──────────────────────────────────────────────────

/** Keys whose values are pure SERP scaffolding — dropped wholesale from a
 *  distilled SERP. `organic`/`news`/`videos`/`images` etc. are kept (the
 *  result arrays) but each ITEM is filtered key-by-key below. */
const SCAFFOLDING_TOP_KEYS = new Set([
  'navigation', 'nav', 'paginator', 'pagination', 'pagination_data',
  'serpapi_pagination', 'page', 'pages', 'related_searches', 'related',
  'people_also_ask', 'ask', 'ads', 'ad', 'pla', 'knowledge_graph',
  'local_results', 'inline_images', 'images_results', 'shopping_results',
  'popular_products', 'discussions_and_forums', 'ai_overview',
  'spell', 'corrected_query', 'search_information', 'search_metadata',
  'search_parameters', 'searchinfo', 'total_results', 'results_cnt',
]);

/** Per-item keys that never carry retrieval value. */
const SCAFFOLDING_ITEM_KEYS = new Set([
  'favicon', 'icon', 'thumbnail', 'thumbnail_url', 'image', 'image_url',
  'source_icon', 'position', 'rank', 'group_position', 'detected_extensions',
  'sitelinks', 'sitelinks_searchbox', 'about_this_result', 'blocks',
]);

/** URL query params that are pure page-validation noise (Google class). */
const NOISE_URL_PARAM_RE = /[?&](?:sxsrf|fbs|ei|ved|usg|sa|sig|opi)\b/;

function cleanSerpUrl(u: unknown): string | undefined {
  if (typeof u !== 'string' || !u) return undefined;
  // Drop data-URI images and encrypted-tbn thumbnails outright.
  if (u.startsWith('data:')) return undefined;
  if (/[?&]tbm=shop|encrypted-tbn\d*\.gstatic\.com/.test(u)) return undefined;
  // Strip the page-validation noise params (sxsrf/fbs/ei/ved… — reviewer N1,
  // PR #1462: the ticket names this class and the strip was written but never
  // wired). One pass; keeps every other query param.
  const cleaned = u.replace(/[?&](?:sxsrf|fbs|ei|ved|usg|sa|sig|opi)=[^&#]*/gi, (m, off: number) =>
    (off === 0 ? '' : m.startsWith('?') ? '?' : '&') === '' ? ''
      : (u[off - 1] === '?' ? '?' : '&'));
  return cleaned !== u ? cleaned : u;
}

interface DistilledResult {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
  date?: string;
  /** Extra textual keys preserved verbatim (`key: value` lines) — reviewer
   *  P3/P12 (PR #1462): they were computed but never rendered. */
  extras?: string[];
}

/** Render one distilled result item, keeping only keys with value. */
function renderDistilled(items: DistilledResult[]): string {
  const out: string[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const lines: string[] = [];
    if (it.title) lines.push(String(it.title).trim());
    const link = cleanSerpUrl(it.link);
    if (link) lines.push(String(link).trim());
    if (it.snippet) lines.push(String(it.snippet).trim());
    if (it.source) lines.push(`— ${String(it.source).trim()}`);
    if (it.date) lines.push(`(${String(it.date).trim()})`);
    for (const e of it.extras ?? []) if (e.trim()) lines.push(e);
    const block = lines.filter(Boolean).join('\n');
    if (block) out.push(block);
  }
  return out.join('\n\n');
}

/** Mechanically strip the SERP noise classes that need no parse (reviewer P14,
 *  PR #1462): base64 data-URI blobs (the incident's dominant garbage — multi-KB
 *  webp favicons) and encrypted-tbn thumbnail URLs. Pure; never throws. */
export function mechanicallyStripSerpNoise(text: string): string {
  return String(text || '')
    .replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{40,}/g, '[base64 icon stripped]')
    .replace(/https?:\/\/encrypted-tbn\d*\.gstatic\.com\/[^\s"'`,\\]+/g, '[thumbnail stripped]');
}

/** Bounded repair for a TRUNCATED JSON body (reviewer P14, PR #1462): scan the
 *  structure outside strings, then salvage in two passes — (1) best-effort
 *  close-from-EOF: terminate the unterminated string and close every open
 *  bracket, which recovers the PARTIAL last item's complete keys; (2) the
 *  lastSafe cut: truncate at the last complete structural close and close
 *  what remains. The base64 strip runs FIRST so a truncated base64 run
 *  cannot eat the tail. The incident's primary class — a SERP whose JSON was
 *  cut mid-string (mid-base64-favicon) — never parses, so the distiller
 *  bailed and the raw body embedded verbatim (the reviewer's probe:
 *  8053→8053 chars, base64 + pagination + sxsrf all still present). Pure;
 *  returns undefined when nothing salvages. */
function tryParseSerpRepair(body: string): any | undefined {
  const s = mechanicallyStripSerpNoise(String(body || ''));
  if (!s) return undefined;
  const scan = (): { inStr: boolean; stack: string[]; lastSafe: number; stackAtSafe: string[] } => {
    let inStr = false, esc = false;
    const stack: string[] = [];
    let lastSafe = -1;
    const stackAtSafe: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') { stack.pop(); lastSafe = i; stackAtSafe.length = 0; stackAtSafe.push(...stack); }
    }
    return { inStr, stack, lastSafe, stackAtSafe };
  };
  const st = scan();
  if (st.lastSafe < 0 && !st.stack.length) return undefined; // nothing structural at all
  const closers = (stack: string[]) => stack.slice().reverse().map(c => (c === '{' ? '}' : ']')).join('');
  // (1) close-from-EOF — recovers the partial last item's complete keys.
  if (st.stack.length) {
    try { return JSON.parse(s + (st.inStr ? '"' : '') + closers(st.stack)); } catch { /* fall through */ }
  }
  // (2) lastSafe cut — drop everything after the last complete close.
  if (st.lastSafe < 0) return undefined;
  const cut = s.slice(0, st.lastSafe + 1);
  if (!st.stackAtSafe.length) {
    try { return JSON.parse(cut); } catch { return undefined; }
  }
  try { return JSON.parse(cut + closers(st.stackAtSafe)); } catch { return undefined; }
}

/** Parse the SERP JSON out of a result (tolerating the wrapper header and a
 *  stray non-JSON prefix). Undefined when unparseable. */
function parseSerpBody(raw: string): any | undefined {
  const body = WRAPPER_HEADER_RE.test(raw) ? raw.replace(WRAPPER_HEADER_RE, '') : raw;
  try { return JSON.parse(body); } catch { /* fall through */ }
  const start = body.indexOf('{');
  if (start >= 0) {
    try { return JSON.parse(body.slice(start)); } catch { /* fall through */ }
  }
  return undefined;
}

/**
 * Distill a parseable SERP JSON body (or a wrapper header + body) to its
 * useful signal: each result array's items rendered title/link/snippet/source
 * /date, scaffolding keys dropped wholesale, base64 icons and redirect-token
 * URLs stripped. Returns '' when nothing parseable or nothing survives — the
 * caller then keeps the original (never guesses).
 */
export function distillSerpPayload(result: string): string {
  const raw = String(result || '');
  if (!raw) return '';
  const parsed = parseSerpBody(raw);
  if (parsed) return distillParsedSerp(parsed);
  // Reviewer P14 (PR #1462): the incident's PRIMARY class is a body whose
  // JSON was TRUNCATED mid-string (mid-base64-favicon) — it never parses, so
  // the old distiller bailed and the raw body embedded verbatim (the
  // reviewer's probe: 8053→8053 chars, base64 + pagination + sxsrf intact).
  // Layered salvage: (1) bounded truncation repair — cut at the last complete
  // structural close, close the open brackets, distill what survived; when
  // even that fails (2) mechanically strip the parse-free noise classes so
  // the worst case is a much smaller body, never the raw one.
  const body = WRAPPER_HEADER_RE.test(raw) ? raw.replace(WRAPPER_HEADER_RE, '') : raw;
  const start = body.indexOf('{');
  const repaired = start >= 0 ? tryParseSerpRepair(body.slice(start)) : undefined;
  if (repaired) {
    const out = distillParsedSerp(repaired);
    if (out) return out;
  }
  const stripped = mechanicallyStripSerpNoise(raw);
  return stripped && stripped !== raw ? stripped : '';
}

/** The key-dropping distillation over an ALREADY-PARSED SERP object. */
function distillParsedSerp(parsed: any): string {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';

  const query = typeof parsed.query === 'string' ? parsed.query
    : typeof parsed.search_parameters?.q === 'string' ? parsed.search_parameters.q
    : undefined;
  const sections: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (SCAFFOLDING_TOP_KEYS.has(key)) continue;
    if (!Array.isArray(value)) continue;
    const items: DistilledResult[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      // Nested (dedupe: each result item keeps only useful keys)
      const keep: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(item)) {
        if (SCAFFOLDING_ITEM_KEYS.has(k)) continue;
        if (k === 'link') { const u = cleanSerpUrl(v); if (u) keep[k] = u; continue; }
        if (k === 'sub_items' && Array.isArray(v)) {
          const sub = renderDistilled(v.map((s: any) => ({
            title: s?.title, link: cleanSerpUrl(s?.link), snippet: s?.snippet,
          })));
          if (sub) keep.sub_items_text = sub;
          continue;
        }
        keep[k] = v;
      }
      if (!Object.keys(keep).length) continue;
      items.push({
        title: typeof keep.title === 'string' ? keep.title : undefined,
        link: typeof keep.link === 'string' ? keep.link : undefined,
        snippet: typeof keep.snippet === 'string' ? keep.snippet
          : typeof keep.description === 'string' ? keep.description : undefined,
        source: typeof keep.source === 'string' ? keep.source : undefined,
        date: typeof keep.date === 'string' ? keep.date : undefined,
      });
      // Preserve any other textual keys verbatim into the rendered block.
      const extras = Object.entries(keep)
        .filter(([k]) => !['title', 'link', 'snippet', 'description', 'source', 'date'].includes(k))
        .filter(([, v]) => typeof v === 'string' && v.trim() && !BASE64_IMAGE_RE.test(v))
        .map(([k, v]) => `${k}: ${v}`);
      if (extras.length) {
        items[items.length - 1] = { ...items[items.length - 1], ...Object.fromEntries(extras.map(e => [e.split(': ')[0], e.slice(e.indexOf(': ') + 2)])) } as DistilledResult;
      }
    }
    const text = renderDistilled(items);
    if (text) sections.push(text);
  }
  if (!sections.length) return '';
  const head = query ? `Query: ${query}` : '';
  const out = `${head}${head ? '\n\n' : ''}${sections.join('\n\n')}`;
  return out;
}

/** Result of the write-boundary gate: 'skip' = never embed (the caller
 *  stores the compact error record); 'store' = embed `content` (distilled
 *  when `distilled` is true, otherwise the original byte-for-byte). */
export interface MemorySanitizeResult {
  action: 'skip' | 'store';
  reason?: 'failed-search-result';
  content: string;
  distilled: boolean;
}

/**
 * The write-boundary gate for session-memory embeds of TOOL RESULTS.
 * Applied at every storeFindings offload site (agent.ts) and at compaction's
 * tool-result rendering. Pure; never throws; the kill switch returns the
 * original content unchanged (action 'store', distilled false).
 *
 *  - a FAILED search surface → action 'skip': never embed; the caller stores
 *    a compact error record instead (tool, query, error class).
 *  - a SERP payload (wrapper header, base64 icons, organic/results arrays) →
 *    distilled content (action 'store', distilled true); when distillation
 *    produces nothing parseable the ORIGINAL is kept (never guess).
 *  - anything else → unchanged (action 'store', distilled false).
 */
export function sanitizeForMemoryEmbed(result: string): MemorySanitizeResult {
  const raw = String(result ?? '');
  if (serpMemorySanitizeDisabled()) return { action: 'store', content: raw, distilled: false };
  if (!raw) return { action: 'store', content: raw, distilled: false };
  if (isFailedSearchResult(raw)) return { action: 'skip', reason: 'failed-search-result', content: '', distilled: false };
  if (looksLikeSerpPayload(raw)) {
    const distilled = distillSerpPayload(raw);
    if (distilled) return { action: 'store', content: distilled, distilled: true };
  }
  return { action: 'store', content: raw, distilled: false };
}

/** Build the compact error record stored INSTEAD of a failed search body:
 *  tool, query (if recoverable), error class head, timestamp — never the
 *  raw provider body. */
export function failedSearchCompactRecord(result: string, toolName?: string): string {
  const raw = String(result || '');
  const firstLine = raw.split('\n').find(l => l.trim())?.slice(0, 200) || 'search failed';
  const tool = toolName ? `${toolName}: ` : '';
  return `[${tool}search failed — compact error record, raw body not embedded (ticket f03b739c)]\n${firstLine}\nRecorded: ${new Date().toISOString()}`;
}

/** True when a URL query string carries Google page-validation noise tokens
 *  (sxsrf / fbs / ei / ved…). Exported for tests. */
export function carriesSerpNoiseTokens(u: string): boolean {
  return NOISE_URL_PARAM_RE.test(String(u || ''));
}

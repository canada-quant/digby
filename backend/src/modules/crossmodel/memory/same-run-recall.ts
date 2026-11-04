/**
 * SAME-RUN RAW RECALL (goal 9ecd595e / todo 6fa816ee — "RAG-1", WRP-1 defect D4).
 *
 * THE INCIDENT (Polk County run, 2026-10-31). A live chat run fetched a SERP,
 * an offload path wrote it into session memory ("The SERP was stored to
 * memory — retrieving the actual links from it"), and then — in the SAME run —
 * `search_memory` answered "Memory doesn't have it." The rows existed. The
 * hybrid read (vector leg + FTS leg → RRF → rerank) simply returned nothing
 * for that query, and an empty result rendered to the model as "not stored".
 *
 * TWO FAULTS, one leaf each side of the DB:
 *   (a) A live tool result the run already holds — and has just written — must
 *       never need an embed→rerank round-trip to be recalled. A (scope_type,
 *       scope_id) lookup is an INDEX READ: no embed, no vector, no rerank, no
 *       provider dependency. That is what this module's selection feeds (the
 *       SQL lives in unified-memory.memRecentRows, which this module never
 *       calls — it is pure).
 *   (b) A vector/semantic miss must never render as "no memory". If the scope
 *       holds rows that plausibly answer the query, they are returned (labelled
 *       `semantic miss — raw rows returned`) instead of a bare empty result.
 *
 * WHY A FRESHNESS WINDOW, NOT JUST OVERLAP. Returning the newest rows of a
 * long-lived session for every query would degrade real semantic recall into
 * recency. The raw path is therefore deliberately narrow: it engages only for
 * rows written INSIDE the same-run window (default 180 min — a long research
 * run with several searches fits, a chat from last week does not) AND only when
 * the row shares query vocabulary. Outside that window the hybrid pipeline is
 * strictly better and keeps the whole answer.
 *
 * REGRESSION DETECTOR. `MEMORY_SAME_RUN_RAW_RECALL` (loop-metric kind
 * memory_same_run_raw_recall) fires on every raw rescue with meta.path =
 * 'raw-first' (a fresh overlapping row won the read outright) or
 * 'raw-fallback' (the hybrid legs returned NOTHING for the scope — this is the
 * incident class, and it must stay at zero).
 *
 * Kill switch: SAME_RUN_RAW_RECALL_DISABLED=1 restores the pre-fix read
 * exactly (hybrid only, empty result stays empty). Read per call — an env flip
 * needs no restart.
 */

/** Kill switch (per call, no restart needed). */
export function sameRunRawRecallDisabled(): boolean {
  const v = process.env.SAME_RUN_RAW_RECALL_DISABLED || '';
  return v === '1' || /^true$/i.test(v);
}

/** Window (minutes) inside which a scoped raw row counts as "same run". A
 *  research chat can run for hours across several searches; 3 h covers a long
 *  live run without reaching into a previous session's day. */
export const SAME_RUN_WINDOW_MINUTES_DEFAULT = 180;
export function sameRunWindowMinutes(): number {
  const n = Number(process.env.SAME_RUN_WINDOW_MINUTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : SAME_RUN_WINDOW_MINUTES_DEFAULT;
}

/** Rows the raw path may return (the caller's k is honored, this is the bound). */
export const SAME_RUN_RAW_MAX_ROWS = 8;

/**
 * Minimum share of the query's distinctive tokens a raw row must carry before
 * a raw-FIRST read may short-circuit the hybrid pipeline. Deliberately low:
 * the model's `search_memory` query is a phrase ("Polk County 281 arrested
 * human trafficking bust"), the stored row is a SERP digest of the same
 * subject, so a couple of matching distinctive tokens is real evidence. The
 * freshness window is what keeps this from becoming "newest rows always win".
 */
export const RAW_FIRST_MIN_OVERLAP = 0.25;

/** Query tokens with no discriminative value for a memory lookup. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'as', 'at', 'if', 'into', 'about', 'over', 'after', 'before', 'than', 'then',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'any', 'some',
  'i', 'we', 'you', 'they', 'he', 'she', 'my', 'our', 'their', 'me', 'us', 'them',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'may', 'might', 'must',
  'have', 'has', 'had', 'not', 'no', 'yes', 'so', 'but', 'also', 'just', 'only', 'very',
  'search', 'memory', 'stored', 'store', 'find', 'get', 'show', 'tell', 'give', 'please',
]);

/** Distinctive lower-case tokens of a text (length ≥ 3, stopwords removed). */
export function recallTokens(text: string): Set<string> {
  const out = new Set<string>();
  const src = String(text ?? '').toLowerCase();
  for (const raw of src.match(/[a-z0-9][a-z0-9'_-]{2,}/g) || []) {
    const tok = raw.replace(/['_-]+$/g, '');
    if (tok.length >= 3 && !STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

/**
 * Share of `query`'s distinctive tokens carried by `text` (0 when either side
 * yields no tokens — an all-stopword query never raw-matches anything, so it
 * can never short-circuit the hybrid read).
 */
export function overlapRatio(query: string, text: string): number {
  const q = recallTokens(query);
  if (!q.size) return 0;
  const t = recallTokens(text);
  if (!t.size) return 0;
  let hit = 0;
  for (const tok of q) if (t.has(tok)) hit += 1;
  return hit / q.size;
}

/** One raw row as the memory store hands it over (a subset of MemHit). */
export interface RawRecallRow {
  source: string;
  ref?: string | null;
  title?: string | null;
  content: string;
  /** ms epoch (or a Date) — when the row was written. */
  createdAt: number | string | Date;
  /** ids let the caller de-duplicate against the hybrid legs. */
  id?: string;
}

export interface RawRecallPick<T extends RawRecallRow> {
  /** The rows to return — newest first, bounded. */
  rows: T[];
  /** 'raw-first' = a fresh overlapping row won the read outright;
   *  'raw-fallback' = the hybrid legs returned nothing and these rows answer. */
  path: 'raw-first' | 'raw-fallback';
  /** Highest overlap observed across the picked rows (0 for a pure fallback). */
  overlap: number;
  /** Age of the NEWEST picked row, in minutes. */
  ageMinutes: number;
}

/**
 * Pick the raw rows for a read.
 *
 * Returns null when the raw path must not engage — which is the whole point of
 * the leaf: the caller falls through to the unchanged hybrid pipeline.
 *
 *   mode 'first'    — pre-hybrid: engage only when at least one row is INSIDE the
 *                     freshness window AND clears RAW_FIRST_MIN_OVERLAP.
 *   mode 'fallback' — post-hybrid, hybrid returned nothing: engage when any row
 *                     is inside the window (overlap is preferred but not required —
 *                     an empty answer from a scope that holds today's rows is the
 *                     incident itself).
 *
 * Never throws; `now` is injectable so tests need no clock.
 */
export function pickRawRecall<T extends RawRecallRow>(
  rows: T[],
  query: string,
  mode: 'first' | 'fallback',
  opts: { now?: number; k?: number; windowMinutes?: number } = {},
): RawRecallPick<T> | null {
  if (!Array.isArray(rows) || !rows.length) return null;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const windowMs = (opts.windowMinutes ?? sameRunWindowMinutes()) * 60_000;
  const limit = Math.max(1, Math.min(SAME_RUN_RAW_MAX_ROWS, Math.floor(opts.k ?? SAME_RUN_RAW_MAX_ROWS)));

  const scored: Array<{ row: T; createdAt: number; overlap: number }> = [];
  for (const row of rows) {
    const created = typeof row.createdAt === 'number' ? row.createdAt : new Date(row.createdAt as any).getTime();
    if (!Number.isFinite(created)) continue; // an unparseable timestamp is not evidence of freshness
    const age = now - created;
    if (age > windowMs) continue; // outside the same-run window: the hybrid pipeline owns this row
    scored.push({ row, createdAt: created, overlap: overlapRatio(query, `${row.title ?? ''}\n${row.content ?? ''}`) });
  }
  if (!scored.length) return null;

  const overlapping = scored.filter((s) => s.overlap >= RAW_FIRST_MIN_OVERLAP);
  if (mode === 'first' && !overlapping.length) return null; // no vocabulary match → hybrid decides
  const pool = mode === 'first' ? overlapping : scored;
  // Freshest first, then by overlap: a same-run write is the row the model just made.
  pool.sort((a, b) => (b.createdAt - a.createdAt) || (b.overlap - a.overlap));
  const picked = pool.slice(0, limit);
  const newest = picked[0];
  return {
    rows: picked.map((p) => p.row),
    path: mode === 'first' ? 'raw-first' : 'raw-fallback',
    overlap: picked.reduce((m, p) => Math.max(m, p.overlap), 0),
    ageMinutes: Math.max(0, Math.round((now - newest.createdAt) / 60_000)),
  };
}

/** The label appended to a raw-rescued result so the MODEL sees why it looks
 *  different from a ranked hit (and can say so instead of "not stored"). */
export const RAW_RECALL_LABEL = '[raw recall — semantic miss, raw rows returned]';
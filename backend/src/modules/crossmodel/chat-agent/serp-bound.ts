/**
 * Bounded SERP context (feedback ticket ba968a07).
 *
 * searchWithBrightData returns the RAW BrightData Google SERP blob (30-80KB
 * typical: result links, nav/footer junk, related searches, duplicate URL
 * mentions). The chat agent used to inject that blob VERBATIM into three model
 * contexts per run and count raw URL OCCURRENCES for the "Found N sources"
 * progress line (users saw "Found 216 sources" for ~10 real results). The
 * adult chat lane's forced SERP died on 2026-09-03 (search-force removal) —
 * today's consumer is the Digby Kids path (crossmodel.controller.ts), which
 * still injects a deterministic SERP into the child-facing prompt. This module
 * remains the single choke point that bounds a SERP before it reaches any
 * model context:
 *
 *   - URLs are taken in order of first appearance, unwrapped (google /url?q=,
 *     bing /ck/, duckduckgo /l/, vertex grounding) and non-citation hosts
 *     (search-engine pages, the vendor doc host) are dropped — the SAME pure
 *     helpers the finalize-side Sources chips use (./sse-adapter), so what the
 *     models are grounded on and what the UI cites agree.
 *   - Duplicates collapse: a SERP mentions one result many times (anchor,
 *     bare link, cached/share echoes); only the first mention earns a line.
 *   - Each kept result becomes ONE compact line — `[label](url) — snippet` —
 *     never inventing a title (the markdown anchor's text when the SERP had
 *     one, else the same-line text before the URL, else just the URL).
 *   - Hard caps: at most SERP_BOUND_MAX_RESULTS results and
 *     SERP_BOUND_MAX_CHARS total characters; truncation is noted, never silent.
 *   - No parseable citation URL → the raw blob head-capped at
 *     SERP_BOUND_MAX_CHARS with resultCount 0 (grounding never silently
 *     vanishes); empty input → an empty block.
 *
 * Idempotent by construction: a bounded block re-parses to the SAME block —
 * the label rides the markdown anchor, the snippet rides the same line after
 * the URL, and snippet/label caps are fixpoint-stable — so double-bounding
 * through any wrapper choke point is safe.
 *
 * LEAF module: pure string work plus sse-adapter's pure URL helpers (that
 * module is itself import-free, so there is no cycle). No prisma, no logger,
 * no services.
 */

import { unwrapRedirectUrl, isNonCitationHost } from './sse-adapter';

/** At most this many distinct results survive into a model context. */
export const SERP_BOUND_MAX_RESULTS = 8;
/** Hard total cap on the returned block, truncation note included. */
export const SERP_BOUND_MAX_CHARS = 4000;
/** Per-result snippet cap in chars (whitespace-collapsed first). */
export const SERP_BOUND_SNIPPET_CHARS = 280;
/** Per-result label cap in chars. */
export const SERP_BOUND_LABEL_CHARS = 120;
/** Raw-char budget for the next-lines snippet fallback scan. */
const SNIPPET_FALLBACK_SCAN_CHARS = 900;

/** Same URL shape the finalize-side Sources chips extract. */
const URL_RE = /https?:\/\/[^\s"')\]}>]+/g;
/** Trailing sentence punctuation rides a prose URL but is not part of it. */
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;
/** A list marker / numbering at a line's start is not the result's label. */
const LIST_MARKER_RE = /^(?:[-*•·]|\[?\d{1,2}\]?[.)]?)\s+/;
/** Separators between a URL (or its anchor's close paren) and the snippet. */
const LEADING_SEPARATORS_RE = /^[\s)\-–—:•·|]+/;
/** The always-fits truncation marker (bounded blocks never exceed the cap,
 *  note included, because the assembler reserves room for it). */
const TRUNCATION_NOTE = '\n[... truncated — more results were gathered; search again for anything missing]';

interface SerpResult {
  url: string;
  label: string;
  snippet: string;
}

/** A label never breaks the markdown it is rendered into, is one line, and
 *  is capped — the cap is fixpoint-stable (a ≤cap label re-parses unchanged). */
function cleanLabel(raw: string): string {
  return raw
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SERP_BOUND_LABEL_CHARS);
}

/** Whitespace-collapse, drop leading separators (incl. an anchor's ')'), cap. */
function collapseSnippet(raw: string): string {
  const s = raw.replace(LEADING_SEPARATORS_RE, '').replace(/\s+/g, ' ').trim();
  return s.length > SERP_BOUND_SNIPPET_CHARS ? `${s.slice(0, SERP_BOUND_SNIPPET_CHARS - 1)}…` : s;
}

/** When the URL sits inside a markdown anchor `[text](url)`, the anchor text
 *  is the label — a real title from the SERP, never an invented one. */
function anchorLabelBefore(raw: string, urlStart: number): string | null {
  if (raw[urlStart - 1] !== '(') return null;
  // Window INCLUDES the close paren (slice end is exclusive): `[text](`.
  const window = raw.slice(Math.max(0, urlStart - 1 - (SERP_BOUND_LABEL_CHARS + 8)), urlStart);
  const m = window.match(/\[([^[\]\n]{1,200})\]\($/);
  return m ? m[1] : null;
}

/** Snippet window: the same-line text after the URL (stopping at any second
 *  URL on that line — rendered lines must contain exactly ONE URL so a bounded
 *  block re-parses to itself); when the URL stands alone on its line (the
 *  common BrightData shape), the following lines up to the next URL-bearing
 *  line, a blank line, or the scan budget. */
function extractSnippet(raw: string, urlEnd: number): string {
  const nl = raw.indexOf('\n', urlEnd);
  const lineEnd = nl === -1 ? raw.length : nl;
  const sameLineRaw = raw.slice(urlEnd, lineEnd);
  const nextUrlAt = sameLineRaw.search(/https?:\/\//);
  const sameLine = collapseSnippet(nextUrlAt === -1 ? sameLineRaw : sameLineRaw.slice(0, nextUrlAt));
  if (sameLine) return sameLine;
  const rest = raw.slice(lineEnd + 1, lineEnd + 1 + SNIPPET_FALLBACK_SCAN_CHARS);
  const picked: string[] = [];
  for (const line of rest.split('\n')) {
    if (!line.trim()) break; // a blank line ends the result's snippet
    if (/https?:\/\//.test(line)) break; // the next result's line is not this snippet
    if (line.startsWith(TRUNCATION_NOTE.trimStart())) break; // our own note is not a snippet (idempotence)
    picked.push(line);
  }
  return collapseSnippet(picked.join(' '));
}

/** Head-cap that NEVER cuts mid-token (adversarial review C5): a mid-hostname
 *  slice manufactures a partial URL ("https://www.goo") that no longer matches
 *  the non-citation host regex, so a re-bound would promote the fragment to a
 *  bogus result. Cut at the last whitespace before the budget (the slice only
 *  gets SHORTER, so the note still fits the hard cap); fall back to the hard
 *  cut only for a pathological single-token head. */
function headCapWithNote(text: string, budget: number): string {
  let cut = Math.min(text.length, budget);
  if (cut < text.length) {
    const boundary = Math.max(text.lastIndexOf(' ', cut), text.lastIndexOf('\n', cut));
    if (boundary > 0) cut = boundary;
  }
  return `${text.slice(0, cut)}${TRUNCATION_NOTE}`;
}

/** The bounded-render line for one result. Round-trips through the parser
 *  unchanged — that round-trip IS the idempotence property. */
function renderResultLine(r: SerpResult, idx: number): string {
  const link = r.label ? `[${r.label}](${r.url})` : r.url;
  return `${idx + 1}. ${link}${r.snippet ? ` — ${r.snippet}` : ''}`;
}

/**
 * Bound a raw SERP blob for injection into a model context.
 * Returns the bounded block and the number of KEPT results (0 when no
 * citation URL parsed — then text is the raw head, capped).
 */
export function boundSerpForContext(raw: string): { text: string; resultCount: number } {
  if (!raw || !raw.trim()) return { text: '', resultCount: 0 };

  const results: SerpResult[] = [];
  const seen = new Set<string>();
  // A re-bounded block ends with our own truncation note — preserve it (the
  // dropped results it stands for are unrecoverable by design, but the note
  // must survive a double-bound or idempotence breaks for truncated blocks).
  const hadTruncationNote = raw.trimEnd().endsWith(TRUNCATION_NOTE.trimStart());
  let prevUrlEnd = -1;
  let prevUrlLineStart = -1;
  for (const m of raw.matchAll(URL_RE)) {
    const urlStart = m.index!;
    const urlEnd = urlStart + m[0].length;
    const url = unwrapRedirectUrl(m[0].replace(TRAILING_PUNCT_RE, ''));
    const lineStart = raw.lastIndexOf('\n', urlStart - 1) + 1;
    // The label never swallows an EARLIER url on the same line — a dropped
    // junk host must not ride a kept result's label back into the context.
    const labelStart = lineStart === prevUrlLineStart ? Math.max(lineStart, prevUrlEnd) : lineStart;
    prevUrlLineStart = lineStart;
    prevUrlEnd = urlEnd;
    if (!url || seen.has(url) || isNonCitationHost(url)) continue;
    seen.add(url);
    const anchor = anchorLabelBefore(raw, urlStart);
    const label = anchor !== null
      ? cleanLabel(anchor)
      : cleanLabel(raw.slice(labelStart, urlStart).replace(LIST_MARKER_RE, ''));
    results.push({ url, label, snippet: extractSnippet(raw, urlEnd) });
  }

  if (results.length === 0) {
    // No parseable citation — ground on the raw blob's head, never vanish.
    if (raw.length <= SERP_BOUND_MAX_CHARS) return { text: raw, resultCount: 0 };
    return { text: headCapWithNote(raw, SERP_BOUND_MAX_CHARS - TRUNCATION_NOTE.length), resultCount: 0 };
  }

  const kept = results.slice(0, SERP_BOUND_MAX_RESULTS);
  const lines: string[] = [];
  let total = 0;
  let truncated = results.length > kept.length || hadTruncationNote;
  for (let i = 0; i < kept.length; i++) {
    const line = renderResultLine(kept[i], i);
    const cost = (lines.length ? 1 : 0) + line.length;
    // Reserve room for the note so a truncated block still fits the hard cap.
    if (total + cost > SERP_BOUND_MAX_CHARS - TRUNCATION_NOTE.length) { truncated = true; break; }
    lines.push(line);
    total += cost;
  }
  let text = lines.join('\n');
  if (truncated) text += TRUNCATION_NOTE;
  // Belt-and-braces: no accounting edge (e.g. one pathological giant URL) may
  // ever leak an over-cap block into a model context.
  if (text.length > SERP_BOUND_MAX_CHARS) {
    text = headCapWithNote(text, SERP_BOUND_MAX_CHARS - TRUNCATION_NOTE.length);
  }
  return { text, resultCount: lines.length };
}

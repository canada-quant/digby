/**
 * Render-time removal of leaked tool-call markup from an assistant row
 * (ticket 7345b333, 2026-11-02).
 *
 * WHAT THE OWNER SAW: ~50 near-identical copies of
 *
 *   <tool_call><function=todo_update><parameter=todoId>0946fc49</parameter>
 *   <parameter=progressNote>Calendar-gated, NOT stalled: …</parameter></function></tool_call>
 *
 * rendered full-width as ordinary message text in the Fleet Supervisor chat,
 * each followed by a "Used 1 tool" line — "all of this horrible looking text".
 *
 * TWO LAYERS, deliberately separate:
 *   1. SOURCE (backend, same change): the loops now recognise the ASCII-XML
 *      form, strip the WHOLE element (payload included), suppress it from the
 *      live stream, and end a run that emits a wall of it. No NEW row can
 *      carry this shape.
 *   2. RENDER (this leaf): rows PERSISTED BEFORE that shipped still hold the
 *      markup, and the owner's history has to read correctly on reload without
 *      waiting for a backfill. Stripping here is a display transform only —
 *      stored content is never modified.
 *
 * TWO SAFETY RULES, both learned the hard way (adversarial review, this
 * ticket — the first cut of this leaf violated both and was refuted):
 *   a. FENCED CODE IS NEVER TOUCHED. A run that illustrates the markup in a
 *      fence (this repo's own docs and bug reports do) must render it intact.
 *      Enforced by SEGMENTING on fences and re-emitting each fence verbatim,
 *      not by a placeholder round-trip (a block regex can span a placeholder
 *      and delete the fence with it).
 *   b. A BARE MENTION IS NOT A CALL. `I saw <tool_call> in the log…` is prose;
 *      only an opener carrying a real `function=`/`parameter=` child, and never
 *      closed, is a severed call — and only then does the tail get cut. Without
 *      that guard a single inline mention silently truncated the whole answer.
 *
 * NOT a general HTML sanitiser: it targets the unambiguous tool-call element
 * forms only.
 */

const FENCE_RE = /```[\s\S]*?(?:```|$)/g;

/** Complete element forms — payload included. */
const BLOCK_RES = [
  // A complete <tool_call>…</tool_call> element.
  /<\s*tool_call\s*>[\s\S]*?<\s*\/\s*tool_call\s*>/gi,
  // A complete <function=name>…</function> element without the wrapper.
  /<\s*function\s*=[^<>]*>[\s\S]*?<\s*\/\s*function\s*>/gi,
  // A complete <parameter=key>value</parameter> element.
  /<\s*parameter\s*=[^<>]*>[\s\S]*?<\s*\/\s*parameter\s*>/gi,
];
/** Leftover / partial tags once the payload-bearing forms are gone. */
const STRAY_TAG_RE = /<\/?\s*(?:tool_call|function|parameter)\b[^<>]*>/gi;
/** A SEVERED call: an opener carrying a real argument child, never closed. */
const DANGLING_HEAD_RE = /<\s*tool_call\s*>\s*<\s*(?:function|parameter)\s*=/i;
const CLOSER_RE = /<\s*\/\s*tool_call\s*>/i;

/**
 * True when `text` carries the ASCII-XML tool-call form outside a fenced block.
 * Mirrors the backend's `hasAsciiXmlToolCall` (an AND: the tag AND a child
 * attribute) — a bare mention alone is NOT markup-worthy.
 */
export function hasRenderableToolMarkup(text: string): boolean {
  if (!text) return false;
  const bare = text.replace(FENCE_RE, '````');
  return /<\s*tool_call\s*>/i.test(bare) && /<\s*(?:function|parameter)\s*=/i.test(bare);
}

/** Apply `fn` outside fenced blocks only, re-emitting every fence byte-identically. */
function outsideFences(text: string, fn: (segment: string) => string): string {
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text))) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
    if (!m[0]) break; // defensive: never spin on a zero-width match
  }
  return out + fn(text.slice(last));
}

/** Cut ONE severed call — only when the opener carries a real argument child. */
function cutDanglingCall(segment: string): string {
  const head = DANGLING_HEAD_RE.exec(segment);
  if (!head) return segment;
  if (CLOSER_RE.test(segment.slice(head.index))) return segment; // closed ⇒ already handled
  return segment.slice(0, head.index);
}

/**
 * `text` with every tool-call element removed, fences preserved byte-identically.
 * Idempotent; returns `text` unchanged when it carries no markup.
 */
export function stripToolMarkupForRender(text: string): string {
  if (!text || !hasRenderableToolMarkup(text)) return text;
  // EVERYTHING happens per non-fence segment, including the whitespace tidy —
  // running it over the whole string would rewrite a fence's own blank lines
  // and trailing spaces (measured: `a = 1\n\n\n\nb = 2   ` → `a = 1\n\nb = 2`).
  const stripped = outsideFences(text, (seg) => {
    const cleaned = cutDanglingCall(BLOCK_RES.reduce((acc, re) => acc.replace(re, ''), seg))
      .replace(STRAY_TAG_RE, '');
    if (cleaned === seg) return seg; // untouched segment stays byte-identical
    // Collapse the blank-line ridge a removed wall leaves behind.
    return cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  });
  return stripped.trim();
}
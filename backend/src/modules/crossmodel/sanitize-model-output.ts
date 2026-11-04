/**
 * Sanitize raw model output — strip leaked tool-call markup.
 *
 * Some open-source reasoning models (DeepSeek V4 Pro, Kimi K3) emit their
 * NATIVE tool-call special tokens as plain text when they decide to "call" a
 * tool on a code path that has no structured tool channel (e.g. the bare
 * streaming thinking endpoint). Those tokens use the fullwidth vertical bar
 * U+FF5C ("｜") as a delimiter and look like:
 *
 *   <<｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke name="web_search">
 *     <｜｜DSML｜｜parameter name="query" string="true">...</｜｜DSML｜｜parameter>
 *   </｜｜DSML｜｜invoke> </｜｜DSML｜｜tool_calls>
 *
 * or the DeepSeek native form:
 *
 *   <｜tool▁calls▁begin｜>...<｜tool▁calls▁end｜>
 *
 * The streaming parsers only read delta.content, so this raw markup gets
 * appended to the response and shown to the user as the "answer". This module
 * is the defensive net that strips it. U+FF5C never appears in normal prose,
 * so detection on it is safe.
 */

const BAR = '｜'; // ｜ fullwidth vertical line (special-token delimiter)

// ── the ASCII-XML tool-call form (ticket 7345b333, 2026-11-02) ───────────────
/**
 * MEASURED DEFECT this closes: a model emitted its tool calls as plain-text
 * ASCII XML in the owner's chat transcript —
 *
 *   <tool_call><function=todo_update><parameter=todoId>0946fc49</parameter>
 *   <parameter=progressNote>Calendar-gated, NOT stalled: …</parameter></function></tool_call>
 *
 * — ~50 near-identical copies in one turn. Every detector in this file was
 * blind to it: it carries NO fullwidth bar, NO `invoke name=`, and NO
 * `tool_calls` (PLURAL — the block tag is `tool_call`, SINGULAR), so
 * containsToolCallLeak said false, looksLikeAttemptedToolCall said false (so
 * the coding loop's bounded leak-retry never fired and the run kept spending),
 * and stripToolCallMarkup removed only the TAGS while leaving the ARGUMENT
 * PAYLOAD behind as visible prose:
 *
 *   strip('<tool_call><function=todo_update><parameter=todoId>0946fc49…')
 *     → '0946fc49Calendar-gated, NOT stalled: close bar is …'
 *
 * i.e. the strip made the wall unreadable rather than removing it. The shape is
 * ASCII + structurally unambiguous (a `tool_call` element whose children are
 * `function=` / `parameter=` elements), which no honest prose produces outside
 * a fenced code block — the fenced case is exempted at the RETRY gate below.
 */
const XML_CALL_TAG = '<\\s*tool_call\\s*>';
const XML_CHILD_ATTR = '<\\s*(?:function|parameter)\\s*=';
/** A complete ASCII-XML tool-call element, payload included. */
const XML_CALL_BLOCK_RE = /<\s*tool_call\s*>[\s\S]*?<\s*\/\s*tool_call\s*>/gi;
/**
 * A SEVERED call — an opener carrying a real argument child, never closed.
 * `\s*<\s*(?:function|parameter)\s*=` is REQUIRED: a bare `<tool_call>` mention
 * in prose (`I saw <tool_call> in the log…`) is a mention, not a call, and must
 * never eat the rest of the answer. Applied by index (see cutDanglingCall) so
 * the tail is cut in ONE linear pass, not re-scanned per opener.
 */
const XML_CALL_DANGLING_HEAD_RE = /<\s*tool_call\s*>\s*<\s*(?:function|parameter)\s*=/i;
/** A <function=name>…</function> element, payload included (a block without its tool_call wrapper). */
const XML_FUNCTION_BLOCK_RE = /<\s*function\s*=[^<>]*>[\s\S]*?<\s*\/\s*function\s*>/gi;
/** A <parameter=key>value</parameter> element — the payload carrier. */
const XML_PARAM_BLOCK_RE = /<\s*parameter\s*=[^<>]*>[\s\S]*?<\s*\/\s*parameter\s*>/gi;
/** Leftover / partial ASCII-XML tool-call tags (stray openers, severed streams). */
const XML_CALL_STRAY_TAG_RE = /<\/?\s*(?:tool_call|function|parameter)\b[^<>]*>/gi;

/**
 * True when the text structurally carries the ASCII-XML tool-call form — a
 * `tool_call` element together with a `function=`/`parameter=` child, complete
 * or severed mid-stream. Fenced code blocks are MASKED first so an honest
 * answer that ILLUSTRATES the markup (this repo's own docs do) is never
 * convicted; see looksLikeAttemptedToolCall, which gates the leak retry.
 */
export function hasAsciiXmlToolCall(text: string): boolean {
  if (!text) return false;
  const bare = maskFencedBlocks(text);
  return new RegExp(XML_CALL_TAG, 'i').test(bare) && new RegExp(XML_CHILD_ATTR, 'i').test(bare);
}

/** Replace fenced code blocks with a placeholder so illustration is never convicted. */
function maskFencedBlocks(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, '````');
}

/**
 * Apply `fn` to the text OUTSIDE fenced code blocks only, re-emitting each
 * fence byte-identically. Segment-wise on purpose: a placeholder round-trip can
 * (a) let a block regex span a fence and delete it, and (b) paste fence A where
 * fence B was. Splitting has neither failure mode.
 */
function outsideFences(text: string, fn: (segment: string) => string): string {
  const fence = /```[\s\S]*?(?:```|$)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
    if (!m[0]) break; // defensive: never spin on a zero-width match
  }
  return out + fn(text.slice(last));
}

/**
 * How many ASCII-XML tool CALLS the text carries (ticket 7345b333) — complete
 * blocks plus severed openers that carry a real argument child. A bare
 * `<tool_call>` a prose answer merely MENTIONS is not a call and is not
 * counted: a docs answer discussing the tag must never reach the volume break.
 * Fenced illustrations are masked, so they count 0.
 */
export function countAsciiXmlToolCalls(text: string): number {
  if (!text) return 0;
  const bare = maskFencedBlocks(text);
  const blocks = (bare.match(new RegExp(XML_CALL_BLOCK_RE.source, 'gi')) ?? []).length;
  // Severed openers (child present, never closed) — the remainder after the
  // complete blocks have been lifted out.
  const remainder = bare.replace(XML_CALL_BLOCK_RE, '');
  const dangling = remainingDanglingOpeners(remainder);
  return blocks + dangling;
}

/** Count severed openers that carry an argument child and have no closer after them. */
function remainingDanglingOpeners(text: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const head = XML_CALL_DANGLING_HEAD_RE.exec(text.slice(from));
    if (!head) break;
    const at = from + head.index;
    if (/<\s*\/\s*tool_call\s*>/i.test(text.slice(at))) break; // closed later — already counted as a block
    count += 1;
    from = at + head[0].length;
    if (count > 500) break; // bounded
  }
  return count;
}

/**
 * Extract normalised signatures of the ASCII-XML tool calls in `text`
 * (ticket 7345b333): `${tool}:${sorted key=value pairs}`, digits collapsed.
 * A decoder-locked model re-emits the SAME call with slightly reworded prose,
 * so the exact-signature repeat breaker (which counts structured tool calls)
 * never saw the loop. Fenced illustrations are masked, so docs answers yield [].
 */
export function asciiXmlToolCallSignatures(text: string): string[] {
  if (!text) return [];
  const bare = maskFencedBlocks(text);
  const out: string[] = [];
  const block = new RegExp(XML_CALL_BLOCK_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = block.exec(bare))) {
    const body = m[0];
    const fn = /<\s*function\s*=\s*([^\s<>]+)/i.exec(body)?.[1] ?? 'unknown';
    const params: string[] = [];
    const param = new RegExp(XML_PARAM_BLOCK_RE.source, 'gi');
    let p: RegExpExecArray | null;
    while ((p = param.exec(body))) {
      const key = /<\s*parameter\s*=\s*([^\s<>]+)/i.exec(p[0])?.[1] ?? '';
      const value = p[0].replace(/^<\s*parameter\s*=[^<>]*>/i, '').replace(/<\s*\/\s*parameter\s*>$/i, '');
      params.push(`${key}=${value.replace(/\s+/g, ' ').trim()}`);
    }
    const norm = params.sort().join('|').replace(/\d+/g, '#');
    out.push(`${fn.toLowerCase()}:${norm}`);
    if (out.length > 200) break; // bounded — a pathological turn cannot spin here
  }
  return out;
}

/**
 * Cut ONE severed call: an opener that carries a real argument child and is
 * never closed. Everything from that opener on is call payload, never prose —
 * measured on the incident: a stream severed mid-`<parameter=progressNote>`
 * stranded the half-written note as the visible answer.
 *
 * Linear on purpose (indexOf, not a per-opener `[\s\S]*$` rescan), and it
 * REQUIRES the `function=`/`parameter=` child, so a bare `<tool_call>` a prose
 * answer merely MENTIONS (`I saw <tool_call> in the log…`) is left alone.
 */
function cutDanglingCall(segment: string): string {
  const head = XML_CALL_DANGLING_HEAD_RE.exec(segment);
  if (!head) return segment;
  // Only a SEVERED call is cut — if a closer exists later in this same
  // (fence-free) segment, XML_CALL_BLOCK_RE has already handled it.
  const rest = segment.slice(head.index);
  if (/<\s*\/\s*tool_call\s*>/i.test(rest)) return segment;
  return segment.slice(0, head.index);
}

/**
 * Remove the ASCII-XML tool-call form — the WHOLE element, argument payload
 * included (ticket 7345b333). Removing only the tags leaves the payload behind
 * as visible prose, which is the exact wall the owner reported.
 *
 * FENCE-AWARE BY CONSTRUCTION: the rules run only on text OUTSIDE fenced code
 * blocks, and each fence is re-emitted byte-identically. A placeholder round-
 * trip would not do — a block regex can span a placeholder and delete the fence
 * with it, and a positional restore can paste fence A where fence B was.
 *
 * Order matters: complete blocks first (their payload must not survive as loose
 * text), then a severed opener, then bare function/parameter elements, then
 * stray tags. Idempotent; '' when the output was nothing but calls.
 */
export function stripAsciiXmlToolCalls(text: string): string {
  if (!text) return text;
  return outsideFences(text, (seg) => cutDanglingCall(
    // Complete blocks FIRST, so `cutDanglingCall` only ever sees a genuinely
    // severed opener (and never mistakes a closed block for one)…
    seg.replace(XML_CALL_BLOCK_RE, ''),
  )
    // …then the tag-level rules clean up what the block pass left behind.
    .replace(XML_FUNCTION_BLOCK_RE, '')
    .replace(XML_PARAM_BLOCK_RE, '')
    .replace(XML_CALL_STRAY_TAG_RE, ''));
}

/**
 * True if the text contains leaked tool-call special-token markup.
 * Used to suppress live streaming deltas the moment a leak starts.
 */
export function containsToolCallLeak(text: string): boolean {
  if (!text) return false;
  return (
    text.indexOf(BAR) !== -1 ||                       // fullwidth bar = special token
    /<\/?[^<>]*tool_calls>/i.test(text) ||            // <...tool_calls> tag
    /▁tool/i.test(text) ||                            // ▁tool (native sep marker)
    hasAsciiXmlToolCall(text)                         // <tool_call><function=…> (ticket 7345b333)
  );
}

/**
 * STRICTER than containsToolCallLeak: true only when the text structurally looks
 * like an ATTEMPTED tool call emitted as plain text — an `invoke name="…"` element
 * or a native `<｜…begin｜>` token block. containsToolCallLeak also fires on a bare
 * fullwidth bar or the lone word `tool_calls`, which an honest answer that
 * quotes/explains tool-call markup legitimately contains. Use THIS (not
 * containsToolCallLeak) to decide a no-tool-call turn was really a leaked call —
 * so a correct final answer that mentions the markup is never rejected/reworded.
 */
export function looksLikeAttemptedToolCall(text: string): boolean {
  if (!text) return false;
  return (
    /<[^<>]*\binvoke\b[^<>]*\bname\s*=/i.test(text) ||                  // <…invoke name="tool">
    /<[|｜][^<>]*\b(?:tool[_▁]?calls?)\b[^<>]*begin[|｜]?>/i.test(text) || // native begin-token block
    hasAsciiXmlToolCall(text)                                            // <tool_call><function=…> (ticket 7345b333)
  );
}

/**
 * Remove leaked tool-call markup from model output, returning clean prose.
 * If the entire output was markup, returns '' (callers treat empty content as
 * a graceful no-op so the other models still synthesize a final answer).
 */
export function stripToolCallMarkup(text: string): string {
  if (!text) return text;
  let out = text;
  // 0a) The ASCII-XML form FIRST, whole element (ticket 7345b333): its payload
  //     lives in element TEXT, so a later tag-only pass would strand it as prose.
  out = stripAsciiXmlToolCalls(out);
  // 0) Native begin...end token blocks: <｜tool▁calls▁begin｜> ... <｜tool▁calls▁end｜>
  out = out.replace(new RegExp(`<?${BAR}[^<>]*?begin${BAR}>[\\s\\S]*?<?${BAR}[^<>]*?end${BAR}>`, 'gi'), '');
  // 1) Complete tool_calls blocks (DSML-wrapped + plain), including a leading "<<"
  out = out.replace(/<+[^<>]*tool_calls>[\s\S]*?<\/[^<>]*tool_calls>/gi, '');
  // 2) Complete invoke blocks
  out = out.replace(/<+[^<>]*\binvoke\b[^<>]*>[\s\S]*?<\/[^<>]*\binvoke\b[^<>]*>/gi, '');
  // 3) Leftover structural tags (unclosed / partial streams)
  out = out.replace(/<+\/?[^<>]*\b(?:tool_calls|tool_call|invoke|parameter)\b[^<>]*>/gi, '');
  // 4) Special-token sequences delimited by the fullwidth bar: <｜...｜>
  out = out.replace(new RegExp(`<?${BAR}+[^<>${BAR}]*${BAR}+>?`, 'g'), '');
  // 5) Any remaining isolated fullwidth-bar runs
  out = out.replace(new RegExp(`${BAR}+`, 'g'), '');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

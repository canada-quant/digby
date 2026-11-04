/**
 * The delivered-answer scaffolding gate (ticket 4d161561 — "live-chat audit: internal text
 * leaked into answers", escalation ticket d36ad50a).
 *
 * The audit (`platform/live-chat-audit.ts` ANSWER_LEAK_RE, mirrored in
 * `scripts/e2e/query-suite.py` LEAK_RE) convicts a persisted human-turn answer that carries
 * model scaffolding. Before this leaf the delivered-answer path stripped only SOME of those
 * shapes: `[FOLLOWUPS]` / `[CANVAS]` (pipeline-utils parseFollowUps / parseCanvasTags) and the
 * fullwidth-bar native tool tokens (`sanitize-model-output.ts stripToolCallMarkup`). Nothing on
 * the answer path removed:
 *
 *   - `<function=name>` / `<function_call>` fragments (the Anthropic-style prose form) — the
 *     coding loop's detector keys on `<function_call>`, the sanitizer's rules key on
 *     `tool_calls` / `invoke` / `parameter`, so a bare `<function=x>` survived both;
 *   - ASCII special tokens like `<|tool_call|>` / `<|endoftext|>` (the sanitizer only knows the
 *     FULLWIDTH bar U+FF5C);
 *   - harness marker LINES a model echoes out of its own input context — `[HARNESS CLOCK]`,
 *     `[EVIDENCE LEDGER …]`, `[MACHINE-TRIGGERED RUN …]`, `[FRESHNESS CONTRACT …]`,
 *     `[SUPERVISOR STATE …]`, `[PARENT SESSION CONTEXT …]`, `[AGENT-SENT MESSAGE …]` — the
 *     harness-side strips for those run on the INPUT/wake path or are supervisor-gated, never
 *     on a plain chat's persisted answer;
 *   - a bare `{"name": "search_engine", "arguments": {…}}` function-call OBJECT (the chat
 *     loop only RETRIES on that shape, bounded, and delivers it as-is when the retry is
 *     unavailable or budget-exhausted);
 *   - a stray or MISMATCHED reasoning tag mid-answer (`…  plan …` / `…<thinking>`).
 *
 * WHAT THIS LEAF DELIBERATELY DOES NOT TOUCH (the false-positive classes the detector owns):
 *   - the harness's OWN delivered guard chrome — `[ACTION VERIFIER — …]` and
 *     `[HARNESS EVIDENCE GUARD — …]` banners are user-facing notices the harness appends, not
 *     model scaffolding (guard-chrome-redact.ts audit contract);
 *   - a fenced code block or a block-quoted line: text the model shows as an illustration is
 *     never deleted (the no-action-note.ts round-8 rule — markers are stripped only as
 *     STANDALONE, unquoted, un-fenced lines);
 *   - the word "DSML" in ordinary prose: a real DSML token block is removed (its markup carries
 *     the delimiters stripToolCallMarkup knows), a sentence ABOUT it is prose.
 *
 * Pure leaf: no DB, no logger, no clock. Deterministic and idempotent.
 */
import { stripToolCallMarkup, stripAsciiXmlToolCalls } from '../sanitize-model-output';

/** One strip that fired — the telemetry shape (`stripped` rows on the finalize metric). */
export interface ScaffoldingStrip {
  shape: 'reasoning-tag' | 'tool-call-markup' | 'special-token' | 'harness-marker' | 'tool-call-json' | 'process-narration';
  lines: number;
}

export interface ScaffoldingResult {
  text: string;
  stripped: ScaffoldingStrip[];
  /** Total occurrences removed across every shape (0 = the text was already clean). */
  removed: number;
}

// ── 1. reasoning tags ────────────────────────────────────────────────────────
// Matched pairs, MISMATCHED pairs (a model that opens with  and closes with
// </thinking> — the moonshot title-strip lesson), an unterminated opener to end-of-text, and
// any stray opener/closer left over. `redacted_reasoning` is the Anthropic-shaped variant some
// endpoints emit inside content.
const REASONING = 'think|thinking|reasoning|redacted_reasoning';
const REASONING_MATCHED_RE = new RegExp(`<(${REASONING})>[\\s\\S]*?<\\/\\1>`, 'gi');
const REASONING_MISMATCHED_RE = new RegExp(`<(?:${REASONING})>[\\s\\S]*?<\\/(?:${REASONING})>`, 'gi');
const REASONING_DANGLING_RE = new RegExp(`<(?:${REASONING})>[\\s\\S]*$`, 'i');
const REASONING_STRAY_RE = new RegExp(`<\\/?(?:${REASONING})>`, 'gi');

// ── 2. ASCII special tokens / function-call fragments ───────────────────────
// A known token name between ASCII pipes — `<|tool_call|>`, `<|endoftext|>`, `<|im_start|>`,
// `<|tool▁calls▁begin|>`. Restricted to token names so ordinary prose or a table cell that
// merely contains a pipe is never touched.
const SPECIAL_TOKEN_RE = new RegExp(
  '<\\|/?(?:tool|tools|tool_call|tool_calls|tool[_▁]calls|function|functions|function_call|'
  + 'channel|begin|end|start|assistant|user|system|im_start|im_end|endoftext|eot_id|constrain|'
  + 'quote|python_tag)[^<>|\\n]{0,40}?\\|>',
  'gi',
);
// <function=name …> … </function>, <function_call>…</function_call>, <tool_use>/<tool_result>
// stray tags, and the antml:invoke form a raw Anthropic block leaves behind.
const FUNCTION_BLOCK_RE = /<function_call[^<>]*>[\s\S]*?<\/function_call\s*>/gi;
const FUNCTION_TAG_RE = /<\/?(?:function|function_call|tool_use|tool_result|tool_calls|tool_call)\b[^<>]*>/gi;
const ANTHML_BLOCK_RE = /<[^<>]*\bantml:[^<>]*>[\s\S]*?<\/[^<>]*\bantml:[^<>]*>/gi;
const ANTHML_TAG_RE = /<[^<>]*\bantml:[^<>]*>/gi;
/** The coding sanitizer's candidate markers — only text carrying one of these goes through stripToolCallMarkup
 *  (that leaf also tidies whitespace, and a clean answer must stay byte-identical). */
const TOOL_MARKUP_CANDIDATE_RE = /｜|tool_calls?|\binvoke\b|\bparameter\b/i;

// ── 3. harness marker lines ─────────────────────────────────────────────────
/**
 * A bracketed harness marker, wherever it stands on a line: `[HARNESS CLOCK — …]`,
 * `[HARNESS NOTICE — …]`, `[MACHINE-TRIGGERED RUN — …]`, `[EVIDENCE LEDGER — …]`,
 * `[FRESHNESS CONTRACT — …]`, `[SUPERVISOR STATE …]`, `[PARENT SESSION CONTEXT …]`,
 * `[AGENT-SENT MESSAGE — …]`. Never applied to a fenced line, a block quote or the harness's own
 * delivered guard chrome (the two banner shapes below).
 */
const HARNESS_MARKER_RE = /\[\s*(?:HARNESS(?: [A-Z][A-Z ]{0,30})?|MACHINE-TRIGGERED RUN|EVIDENCE LEDGER|FRESHNESS CONTRACT|SUPERVISOR STATE|PARENT SESSION CONTEXT|PARENT SESSION DIGEST|AGENT-SENT MESSAGE)\b[^\]]{0,400}\]/g;
/** The cheap pre-check so a clean answer never pays for a regex sweep (and stays byte-identical). */
const HARNESS_MARKER_CANDIDATE_RE = /\[(?:HARNESS|MACHINE-TRIGGERED|EVIDENCE LEDGER|FRESHNESS CONTRACT|SUPERVISOR STATE|PARENT SESSION|AGENT-SENT MESSAGE)/i;
/** Delivered guard chrome — harness-authored, user-facing, kept byte-identical. */
const GUARD_CHROME_RE = /^ {0,3}\[(?:ACTION VERIFIER —|HARNESS EVIDENCE GUARD —)/;

/** CommonMark fence tracking (same shape as no-action-note.ts walkFences): a 0–3-space-indented run of 3+ backticks/tildes. */
function walkFences(lines: string[], visit: (line: string, fenced: boolean) => void): void {
  let fence: { ch: string; len: number } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence.ch && open[1].length >= fence.len && !open[2].trim()) fence = null;
      visit(raw, true);
      continue;
    }
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { ch: open[1][0], len: open[1].length };
      visit(raw, true);
      continue;
    }
    visit(raw, false);
  }
}

function stripHarnessMarkerLines(text: string): { text: string; lines: number } {
  if (!HARNESS_MARKER_CANDIDATE_RE.test(text)) return { text, lines: 0 };
  let removed = 0;
  const out: string[] = [];
  walkFences(text.split('\n'), (line, fenced) => {
    const quoted = /^ {0,3}>/.test(line);
    if (!fenced && !quoted && !GUARD_CHROME_RE.test(line) && HARNESS_MARKER_CANDIDATE_RE.test(line)) {
      HARNESS_MARKER_RE.lastIndex = 0;
      const rewritten = line.replace(HARNESS_MARKER_RE, () => { removed += 1; return ''; });
      if (rewritten !== line) {
        // A line the marker OPENS is harness plumbing end to end ([HARNESS CLOCK — …] Current time: …):
        // the marker's payload is harness text too, so the whole line goes.
        if (/^ {0,3}\[/.test(line)) { out.push(''); return; }
        // A marker spliced INTO the model's own prose: cut it out, keep the sentence.
        out.push(rewritten.replace(/[ \t]{2,}/g, ' '));
        return;
      }
    }
    out.push(line);
  });
  if (!removed) return { text, lines: 0 };
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), lines: removed };
}

// ── 4. bare function-call JSON objects ──────────────────────────────────────
/** The chat tool vocabulary a leaked call object names (the audit's five, plus the ids the agent loop hands the model). */
export const CHAT_TOOL_NAME_RE_SRC = 'search_engine|scrape_as_markdown|web_pipe|create_document|generate_image|'
  + 'list_chats|get_chat_messages|get_chat_status|get_run_receipts|get_fleet_telemetry|send_chat_message|'
  + 'schedule_message|list_schedules|todo_list|goal_list|file_feedback|triage_ticket|asana_search|'
  + 'asana_list_tasks|asana_create_task|slack_search|slack_post_message|gmail_search|drive_search|x_search|'
  + 'browser_task|computer_task|memory_search|search_memory|start_coding_session|run_command|read_file|'
  + 'write_file|edit_file|grep|glob|list_dir|ast_search|ast_rewrite|delegate|delegate_parallel';

const TOOL_CALL_JSON_RE = new RegExp(
  `"name"\\s*:\\s*"(?:${CHAT_TOOL_NAME_RE_SRC})"\\s*,\\s*"(?:arguments|parameters|params|args|input)"\\s*:`,
  'gi',
);
/** A name-only call object — `{"name": "search_engine"}`. The audit's own alternative names the tool
 *  without requiring an arguments key, so this shape must go too (a stream-cut call loses its arguments). */
const TOOL_NAME_ONLY_JSON_RE = new RegExp(`\\{\\s*"name"\\s*:\\s*"(?:${CHAT_TOOL_NAME_RE_SRC})"\\s*\\}`, 'gi');

/** The `{ … }` object enclosing `idx` (brace-balanced, quote-aware), or null. */
function enclosingObject(text: string, idx: number): { start: number; end: number } | null {
  let depth = 0;
  let start = -1;
  for (let i = idx - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '}') depth += 1;
    else if (c === '{') {
      if (depth === 0) { start = i; break; }
      depth -= 1;
    }
  }
  if (start < 0) return null;
  let d = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') d += 1;
    else if (c === '}') { d -= 1; if (d === 0) return { start, end: i }; }
  }
  return null;
}

function stripToolCallJson(text: string): { text: string; removed: number } {
  if (!/"name"\s*:/.test(text)) return { text, removed: 0 };
  let out = text;
  let removed = 0;
  // A name-only object first (its arguments key is absent — the shape a stream cut leaves), then the
  // full name+arguments object removed whole with its nested payload.
  TOOL_NAME_ONLY_JSON_RE.lastIndex = 0;
  out = out.replace(TOOL_NAME_ONLY_JSON_RE, () => { removed += 1; return ''; });
  // Bounded: a leaked answer carries a handful of calls, never thousands.
  for (let guard = 0; guard < 20; guard++) {
    TOOL_CALL_JSON_RE.lastIndex = 0;
    const m = TOOL_CALL_JSON_RE.exec(out);
    if (!m) break;
    const bounds = enclosingObject(out, m.index);
    if (!bounds) break;
    out = `${out.slice(0, bounds.start)}${out.slice(bounds.end + 1)}`;
    removed += 1;
  }
  return { text: out, removed };
}

// ── the gate ────────────────────────────────────────────────────────────────

function countMatches(re: RegExp, text: string): number {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let n = 0;
  while (g.exec(text)) {
    n += 1;
    if (n > 500) break; // bounded — a pathological answer cannot spin here
  }
  return n;
}

/**
 * The delivered-answer scaffolding gate: `text` with every model-scaffolding shape removed.
 * Returns the same string and an empty `stripped` list when the answer was already clean.
 * Pure, idempotent, never throws.
 */
export function stripAnswerScaffolding(input: string): ScaffoldingResult {
  const src = String(input ?? '');
  if (!src) return { text: src, stripped: [], removed: 0 };
  const stripped: ScaffoldingStrip[] = [];
  let text = src;

  // ── the ASCII-XML tool-call form (ticket 7345b333) FIRST ──────────────────
  // Its argument payload lives in element TEXT (`<parameter=x>…</parameter>`),
  // so every tag-only rule below would strip the delimiters and strand the
  // payload as visible prose — measured: the owner's `todo_update` leak became
  // "0946fc49Calendar-gated, NOT stalled: close bar is …" and shipped. Remove
  // the whole element here, before any tag-level rule can break it up.
  if (new RegExp('<\\s*tool_call\\s*>', 'i').test(text) || new RegExp('<\\s*(?:function|parameter)\\s*=', 'i').test(text)) {
    const xml = stripAsciiXmlToolCalls(text);
    if (xml !== text) {
      // ≥1 by construction (xml !== text means a rule fired): a 0 here would
      // make `removed` 0 and discard the strip at the final early return.
      const n = Math.max(
        1,
        countMatches(/<\s*tool_call\s*>/gi, text) || countMatches(/<\s*parameter\s*=/gi, text),
      );
      stripped.push({ shape: 'tool-call-markup', lines: n });
      text = xml;
    }
  }

  // reasoning tags — matched, mismatched, dangling, stray
  const reasoning = countMatches(REASONING_STRAY_RE, text);
  if (reasoning) {
    text = text
      .replace(REASONING_MATCHED_RE, '')
      .replace(REASONING_MISMATCHED_RE, '')
      .replace(REASONING_DANGLING_RE, '')
      .replace(REASONING_STRAY_RE, '');
    if (reasoning) stripped.push({ shape: 'reasoning-tag', lines: reasoning });
  }

  // function-call fragments + ASCII special tokens
  const fnCount = countMatches(FUNCTION_TAG_RE, text) + countMatches(FUNCTION_BLOCK_RE, text);
  if (fnCount) {
    text = text
      .replace(FUNCTION_BLOCK_RE, '')
      .replace(ANTHML_BLOCK_RE, '')
      .replace(ANTHML_TAG_RE, '')
      .replace(FUNCTION_TAG_RE, '');
    stripped.push({ shape: 'tool-call-markup', lines: fnCount });
  }
  const tokenCount = countMatches(SPECIAL_TOKEN_RE, text);
  if (tokenCount) {
    text = text.replace(SPECIAL_TOKEN_RE, '');
    stripped.push({ shape: 'special-token', lines: tokenCount });
  }

  // fullwidth-bar native tokens / tool_calls / invoke / parameter blocks — the coding sanitizer.
  // Candidate-gated: that leaf also tidies whitespace, and a clean answer must stay byte-identical.
  if (TOOL_MARKUP_CANDIDATE_RE.test(text)) {
    const cleaned = stripToolCallMarkup(text);
    if (cleaned !== text) {
      stripped.push({ shape: 'tool-call-markup', lines: 1 });
      text = cleaned;
    }
  }

  // harness marker lines (fence / quote / guard-chrome exempt)
  const markers = stripHarnessMarkerLines(text);
  if (markers.lines) {
    text = markers.text;
    stripped.push({ shape: 'harness-marker', lines: markers.lines });
  }

  // a bare function-call JSON object
  const json = stripToolCallJson(text);
  if (json.removed) {
    text = json.text;
    stripped.push({ shape: 'tool-call-json', lines: json.removed });
  }

  // process narration (WRP-1 D6 / ANS-3, 2026-10-31) — LAST, so every shape above
  // has already been removed and a line that is BOTH markup and narration is
  // counted once, against its real shape.
  const narration = stripProcessNarration(text);
  if (narration.lines) {
    text = narration.text;
    stripped.push({ shape: 'process-narration', lines: narration.lines });
  }

  const removed = stripped.reduce((n, s) => n + s.lines, 0);
  if (!removed) return { text: src, stripped: [], removed: 0 };
  const tidy = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: tidy, stripped, removed };
}

// ── 4. process narration (WRP-1 D6, goal 9ecd595e / ANS-3) ─────────────────
/**
 * THE GAP THIS CLOSES (measured 2026-10-31 on the reported Polk County answer):
 * the gate above is SHAPE-based — reason tags, tool markup, harness markers,
 * call JSON. Process narration is ordinary prose, so `stripAnswerScaffolding`
 * returned removed=0 on the reported body and all five lines shipped:
 *
 *   "The search surfaced older Polk County stings (108/160/219 arrests in 2022–23)
 *    — none match the 281 figure from your headline. Searching for the actual
 *    current story now."
 *   "The aggregated fetch got throttled — going direct to the outlets instead."
 *   "The SERP was stored to memory — retrieving the actual links from it."
 *   "Memory doesn't have it."
 *   "Polk County Sheriff's news page returned a 404 when I hit it directly"
 *
 * The run was RIGHT to refuse unverifiable specifics; what leaked is the
 * PLUMBING around that refusal. Those lines are valuable as run telemetry (they
 * stay on the tool/activity stream) but they are not the deliverable.
 *
 * DELIBERATELY CONSERVATIVE — a false positive here deletes real analysis, which
 * is worse than a leaked sentence. A line is removed only when ALL of:
 *   1. it is a STANDALONE, unquoted, un-fenced line (the no-action-note round-8
 *      rule the harness markers already follow);
 *   2. it is short (≤ MAX_NARRATION_CHARS) — a paragraph of sourced analysis that
 *      merely mentions a search is not narration;
 *   3. it carries a FIRST-PERSON retrieval cue ("I searched", "let me pull") or
 *      an unambiguous plumbing idiom (throttled, SERP, "stored to memory",
 *      "going direct", "hat's a … issue".
 * It never touches a line carrying an explicit unverified/verified marker, and
 * never touches a bullet or a paragraph that states a finding — so the
 * "unverified" answer shape survives untouched (the must-not-regress rule).
 */
const MAX_NARRATION_CHARS = 400;

/** First-person / plumbing cues strong enough to make a standalone line narration. */
const NARRATION_CUE_RE = new RegExp(
  [
    // A first-person retrieval verb is only a cue when it names a RETRIEVAL
    // OBJECT — "Let me check." is the author talking to the reader (an existing
    // 89fbdf3b pin keeps it), while "Let me pull the search results" is plumbing.
    '\\b(?:I|let me|I\'m|I am|we)\\s+(?:just\\s+)?(?:pulled|pull|pulling|searched|search|searching|retriev\\w*|fetch\\w*|check\\w*|look\\w*)\\b[^.!?\\n]{0,40}\\b(?:search|searched|query|queries|results|web|serp|memory|sources?|links?|pages?|outlets?)\\b',
    // an apology is never the deliverable
    '\\b(?:I\\s+)?apologi[sz]e\\b', '\\bapologies\\b',
    // bare plumbing nouns that never belong in a delivered answer.
    // NO 'the gateway' cue: in THIS product "the gateway" is ordinary technical
    // prose (self-host, Edge, LiteLLM) and a supervisor note may legitimately
    // discuss it — an over-broad cue here rewrites real notes (caught by the
    // chat-agent struck-note suite, 2026-10-31).
    '\\bSERP\\b', '\\bthrottl(?:ed|ing|e)\\b',
    // the incident's own phrasings
    '\\bstored to (?:session )?memory\\b', '\\bretrieving the (?:actual )?links\\b',
    '\\bgoing direct\\b', '\\bre-?run\\w* (?:the )?(?:search|query)\\b',
    '\\bno results (?:came back|returned)\\b', '\\bnothing came back\\b',
    '\\bmemory doesn\'t have (?:it|that)\\b', '\\breturned a 404\\b',
    '\\bthe (?:search|fetch|scrape) (?:surfaced|came back|returned)\\b',
    '\\bsearching (?:for|the) .{0,60}\\bnow\\b',
  ].join('|'),
  'i',
);

/**
 * THE TOOL-PILL SHAPE (measured gap, 2026-10-31 — Fleet Supervisor + ticket lane
 * 6763708c independently found these three lines SURVIVING the prose-cue pass):
 *
 *   Researched online · Polk County 281 arrested human trafficking bust Di
 *   Researched online · "Polk County" 281 arrested human trafficking opera
 *   Searched project memory · 281 arrested Polk County human trafficking Disney
 *
 * These are UI pill LABELS that leaked into the body — a retriever prefix, a
 * " · " separator, then the verbatim (often truncated mid-word) query tail.
 * They are the literal text the owner pasted when he wrote "this is
 * unnaccetable"; the prose lines above were not what he was looking at.
 *
 * Deliberately CLOSED-SET on the retriever target so ordinary prose that
 * happens to contain a middot ("Searched the county registry · 3 matches") is
 * NOT eaten: only this product's own retriever labels qualify.
 */
const RETRIEVER_PILL_RE = new RegExp(
  '^\\s*(?:researched|retrieved|searched)\\s+'
  + '(?:online|the\\s+web|the\\s+news\\s+feed|project\\s+memory|session\\s+memory|chat\\s+memory|memory|the\\s+code\\s+index|documents?)'
  + '\\s*·\\s*\\S',
  'i',
);

/** A line that states verification status is NEVER narration — the refusal shape must survive. */
const VERIFICATION_MARKER_RE = /\b(?:unverified|not verified|could not (?:verify|confirm)|verified|confirmed by|according to|per the)\b/i;

/** A bullet or numbered line is a finding, not process chatter. */
const LIST_LINE_RE = /^\s*(?:[-*+•]|\d+[.)])\s+/;

/**
 * Remove process-narration lines. Exported for the D6 regression test; the gate
 * calls it in sequence with the other shapes.
 */
export function stripProcessNarration(text: string): { text: string; lines: number } {
  if (!text) return { text, lines: 0 };
  // Kill switch (WRP-1 D6 / ANS-3): an answer-shape change ships revertible —
  // ANSWER_NARRATION_STRIP_DISABLED=1 restores the pre-fix gate exactly (the
  // shape strips above still run; only narration survives, as it did before).
  if (process.env.ANSWER_NARRATION_STRIP_DISABLED === '1') return { text, lines: 0 };
  let removed = 0;
  const out: string[] = [];
  // The same fence walker the harness-marker pass uses: a line INSIDE a fenced
  // block is an illustration and is never deleted, even when a bare `split('\n')`
  // would see the content line as standalone.
  walkFences(text.split('\n'), (line, fenced) => {
    const trimmed = line.trim();
    const eligible = !fenced
      && trimmed.length > 0
      && trimmed.length <= MAX_NARRATION_CHARS
      && !/^ {0,3}>/.test(line)          // quoted: an illustration
      && !/^\s*(?:```|~~~)/.test(line)   // never a fence delimiter itself
      && !LIST_LINE_RE.test(line)        // a finding
      && !VERIFICATION_MARKER_RE.test(line)
      && (RETRIEVER_PILL_RE.test(line) || NARRATION_CUE_RE.test(line));
    if (eligible) { removed += 1; return; }
    out.push(line);
  });
  if (!removed) return { text, lines: 0 };
  return { text: out.join('\n'), lines: removed };
}

/** The text-only convenience form (callers that do not record telemetry). */
export function stripAnswerScaffoldingText(input: string): string {
  return stripAnswerScaffolding(input).text;
}

// ── the persisted-row seam ─────────────────────────────────────────────────
/**
 * A harness-authored block the assistant row legitimately carries — the wake record the receipt
 * lane appends, which the readers' views already treat as transparent (harness-receipts.ts
 * isHarnessAppendixBlock). Never the model's words, so never stripped.
 */
const HARNESS_AUTHORED_BODY_RE = /^(?:ACTIONS TAKEN \(harness\):|Harness record:|Reported up \(harness\):|Not executed \(harness\):|WAKE: |\u{1F50D} Harness|\u{23F3} HARNESS NOTE:)/u;

/**
 * The last `\n\n`-separated paragraph when it is a harness appendix — the same split
 * harness-receipts.ts splitTrailingHarnessAppendix performs (kept local so this leaf stays
 * dependency-free for the chat-agent finalize and its test).
 */
function splitTrailingAppendix(text: string): { head: string; appendix: string } {
  const trimmed = text.replace(/\s+$/, '');
  const sep = trimmed.lastIndexOf('\n\n');
  if (sep === -1) return { head: text, appendix: '' };
  const tail = trimmed.slice(sep + 2);
  const firstLine = tail.split('\n')[0] ?? '';
  const isAppendix = /^\[(?:ACTION VERIFIER\b|harness\b)/i.test(firstLine)
    || HARNESS_AUTHORED_BODY_RE.test(firstLine);
  return isAppendix ? { head: trimmed.slice(0, sep).replace(/\s+$/, ''), appendix: tail } : { head: text, appendix: '' };
}

/**
 * THE SEAM FOR THE PERSISTED ROW (ticket 4d161561).
 *
 * The row's `content` is NOT only the model's text: chat-agent composes it from the finalize
 * text PLUS the structured blocks carried from the answer's parts and the "Deeper findings"
 * title — assembled AFTER the finalize strip, which is why the strip alone cannot guarantee a
 * clean row. The nightly audit reads THIS string, so it is scrubbed here: the head (model text
 * + carried blocks) through the gate, the trailing harness appendix preserved byte-identical
 * (it is the harness's own record, and the readers peel or ignore it by shape).
 *
 * Idempotent: content that already passed the gate comes back unchanged.
 */
export function scrubDeliveredRowContent(content: string): string {
  const src = String(content ?? '');
  if (!src) return src;
  const { head, appendix } = splitTrailingAppendix(src);
  const cleanHead = stripAnswerScaffolding(head).text;
  return appendix ? `${cleanHead}\n\n${appendix}` : cleanHead;
}
/**
 * Shared Pipeline Utilities
 *
 * Extracted from query-pipeline.ts and deep-research.pipeline.ts to eliminate
 * duplicated functions. Both pipelines (and moonshot.integration.ts) now import
 * from this single source of truth.
 *
 * Functions extracted:
 *   - rewriteFollowUp()       — rewrites AI-perspective follow-ups to user-perspective
 *   - splitCompoundFollowUp() — splits multi-question follow-ups into individual items
 *   - parseFollowUps()        — extracts [FOLLOWUPS] blocks from synthesis text
 *   - parseCanvasTags()       — extracts [CANVAS:...] blocks from synthesis text
 *   - detectCanvasPreambleWithoutContent() — detects preamble referencing canvas without actual tags
 *
 * 2026-06-15: Consolidated from 3 duplicate locations (query-pipeline, deep-research,
 * moonshot.integration) to prevent divergence. Any bug fix or enhancement to follow-up
 * or canvas parsing now applies everywhere automatically.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ParsedCanvas {
  type: string;
  language?: string;
  title: string;
  content: string;
}

// ── Follow-Up Rewriting ────────────────────────────────────────────────────────

/**
 * Rewrite AI-perspective follow-up phrasing into user-perspective commands.
 *
 * Models frequently emit follow-ups like "Would you like me to…" or "Should I…"
 * despite instructions. Since these become clickable buttons sent as the user's
 * next message, they need to read as user commands/questions.
 *
 * Also handles compound "Would you like to know about X and Y?" style questions
 * by splitting them into two separate follow-ups when two distinct noun phrases
 * are detected after 'about'.
 */
export function rewriteFollowUp(text: string): string {
  let s = text;
  s = s.replace(/^would you like (?:me to |to )/i, '');
  s = s.replace(/^do you want (?:me to |to )/i, '');
  s = s.replace(/^want me to /i, '');
  s = s.replace(/^should i /i, '');
  s = s.replace(/^shall i /i, '');
  s = s.replace(/^let me /i, '');
  s = s.replace(/^i could /i, '');
  s = s.replace(/^i can /i, '');
  s = s.replace(/^i'?ll /i, '');
  s = s.replace(/^i will /i, '');
  s = s.replace(/^i'?d (?:be happy|love|like) to /i, '');
  s = s.replace(/^how about i /i, '');
  s = s.replace(/^can i /i, '');
  s = s.replace(/^may i /i, '');
  s = s.replace(/\s+for you\s*([?.!]?)$/i, '$1');
  if (s.endsWith('?') && !/^(what|how|why|when|where|who|which|is |are |do |does |can |could |will |would )/i.test(s)) {
    s = s.slice(0, -1).trim();
  }
  if (s.length > 0) {
    s = s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s;
}

/**
 * Attempt to split a "know about X and Y" style compound question into two
 * separate follow-ups. Returns an array of one or two strings.
 *
 * Example: "Would you like to know about the costs and the timeline?" →
 *   ["What are the costs?", "What is the timeline?"]
 *
 * More conservatively: "Know about X and Y" →
 *   ["Tell me about X", "Tell me about Y"]
 */
function splitAboutAndQuestion(text: string): string[] {
  // Match patterns like "know about X and Y" or "learn about X and Y"
  const aboutAndMatch = text.match(
    /^(?:know|learn|find out|hear)\s+about\s+(.+?)\s+and\s+(.+?)\??$/i
  );
  if (!aboutAndMatch) return [text];

  const partA = aboutAndMatch[1].trim();
  const partB = aboutAndMatch[2].trim();

  // Only split if both parts are substantial noun phrases (≥ 4 chars, not just conjunctions)
  if (partA.length < 4 || partB.length < 4) return [text];
  // Avoid splitting if either part looks like a verb phrase (starts with a verb word)
  const verbStart = /^(do|does|is|are|was|were|has|have|had|will|would|can|could|should|shall|may|might)\b/i;
  if (verbStart.test(partA) || verbStart.test(partB)) return [text];

  return [
    `Tell me about ${partA}`,
    `Tell me about ${partB}`,
  ];
}

/**
 * Split a string that contains two or more complete questions separated by an
 * internal '?' into individual questions.
 *
 * Example: "What's the cost? What's the timeline?" →
 *   ["What's the cost?", "What's the timeline?"]
 * Example: "What are the risks? And how do we mitigate them?" →
 *   ["What are the risks?", "How do we mitigate them?"]
 *
 * Conservative guards keep precision high:
 *  - Only splits when a '?' appears before the final character (i.e. there really
 *    are multiple questions, not one trailing question mark).
 *  - Each resulting segment must be ≥ 12 chars after trimming so rhetorical
 *    fragments ("Why? Because…") don't get split into junk.
 *  - Leading conjunctions ("and", "or", "also", "then", "plus") are stripped from
 *    the second+ segments so the buttons read cleanly.
 * Returns the original (single-element) array when no safe split is found.
 */
function splitOnInternalQuestionMarks(text: string): string[] {
  const trimmed = text.trim();
  const firstQ = trimmed.indexOf('?');
  // No '?' at all, or the only '?' is the final char → nothing to split.
  if (firstQ === -1 || firstQ >= trimmed.length - 1) return [trimmed];

  const segments = trimmed.split(/\?+/).map(s => s.trim()).filter(Boolean);
  if (segments.length < 2) return [trimmed];

  const cleaned = segments.map(s =>
    s.replace(/^(?:and|or|also|then|plus|as well as)\s+/i, '').trim()
  );
  // Every segment must be a substantial question; otherwise bail (don't over-split).
  if (cleaned.some(s => s.length < 12)) return [trimmed];

  return cleaned.map(s => {
    // Re-capitalize (stripping a leading conjunction can expose a lowercased word)
    // and restore the question mark dropped by the split.
    const capped = s.charAt(0).toUpperCase() + s.slice(1);
    return capped.endsWith('?') ? capped : `${capped}?`;
  });
}

// ── Compound Follow-Up Splitting ───────────────────────────────────────────────

/**
 * Split a compound follow-up that contains multiple questions joined by
 * conjunctions like " and ", " as well as ", " plus ", " along with ",
 * ", and ", "; and ", " — and ", or " — ".
 * Only splits when both halves look like independent questions/commands
 * (each ≥ 12 chars and the overall text is long enough to be compound).
 *
 * Example: "What are the costs and what's the timeline?" →
 *   ["What are the costs?", "What's the timeline?"]
 *
 * Example: "What are the costs, and what's the timeline?" →
 *   ["What are the costs?", "What's the timeline?"]
 */
export function splitCompoundFollowUp(text: string): string[] {
  // Highest-precision case first: the follow-up packs two+ complete questions into
  // one string, separated by an internal '?' ("What's the cost? What's the timeline?"
  // or "What are the risks? And how do we mitigate them?"). A '?' that isn't the final
  // character almost always marks a real question boundary, so we split here BEFORE the
  // length guard — two short questions can be < 50 chars combined.
  // 2026-06-21: Added to fix user feedback "follow up is bunch of questions in one".
  const qSplit = splitOnInternalQuestionMarks(text);
  if (qSplit.length > 1) return qSplit;

  if (text.length <= 50) return [text];

  // First, attempt to split "know/learn about X and Y" style questions
  const aboutSplit = splitAboutAndQuestion(text);
  if (aboutSplit.length > 1) return aboutSplit;

  const splitPatterns = [
    // Original patterns
    /,?\s+and\s+(?:also\s+)?(?=what |how |why |when |where |who |which |can |could |tell |show |list |draft |create |compare |check |research |find |summarize |explain )/i,
    /,?\s+as well as\s+/i,
    /,?\s+plus\s+(?=what |how |why |when |where |who |which )/i,
    /,?\s+along with\s+(?=what |how |why |when |where |who |which )/i,
    // New patterns: ', and ', '; and ', ' — and ', ' — '
    /,\s+and\s+(?=what |how |why |when |where |who |which |can |could |tell |show |list |draft |create |compare |check |research |find |summarize |explain )/i,
    /;\s+and\s+(?=what |how |why |when |where |who |which |can |could |tell |show |list |draft |create |compare |check |research |find |summarize |explain )/i,
    /\s+—\s+and\s+(?=what |how |why |when |where |who |which |can |could |tell |show |list |draft |create |compare |check |research |find |summarize |explain )/i,
    /\s+—\s+(?=what |how |why |when |where |who |which |can |could |tell |show |list |draft |create |compare |check |research |find |summarize |explain )/i,
  ];
  for (const pattern of splitPatterns) {
    const parts = text.split(pattern).map(p => p.trim()).filter(p => p.length >= 12);
    if (parts.length >= 2) {
      return parts.map(p => {
        if (/^(what|how|why|when|where|who|which|is |are |do |does |can |could |will |would )/i.test(p) && !p.endsWith('?')) {
          return p.replace(/[.!]?$/, '?');
        }
        return p;
      });
    }
  }
  return [text];
}


// ── Follow-Up Reasoning-Leak Filter ─────────────────────────────────────────────
//
// The single most-recurring production bug: the utility model's chain-of-thought /
// prompt-echo leaking into a follow-up SUGGESTION button (e.g. "We need to generate
// 4 follow-up suggestions for the user. The user is Rome based on context…"). This
// was patched repeatedly inline in moonshot.integration.ts (2026-06-23/24/25/26).
// 2026-07-04: extracted here as a pure, exported, UNIT-TESTED predicate so the
// regression coverage lives next to sameIpSession/rewriteFollowUp and the exact
// patterns can't silently drift. Behavior is identical to the previous inline
// isMetaReasoning + isStructuralProse closures.
//
// A genuine clickable suggestion is a first-person user message ("Show me…",
// "What is…") — it never refers to "the user", "the context", the prompt's own
// scaffolding, opens with a reasoning hedge, or spans multiple sentences.

// A CoT fragment opens with a hedge/conjunction ("Possibly…", "Maybe…", "Or…",
// "Alternatively…", "Actually…"); a real suggestion opens with a question word or
// action verb (enforced by the include-filter in the caller).
// 2026-07-08: added second-person openers ("You're Paul Cozzolino — based on your
// Calendly handle…", "You are…", "Your profile…"). A genuine suggestion is written
// from the USER's perspective (they'd say "my", never "you're/your"); a line that
// addresses the user is the model narrating its own reasoning about them, which
// leaked into a live suggestion button.
const FOLLOWUP_META_LEADING_RE =
  /^(possibly|maybe|perhaps|wait|hmm+|i think|i guess|it seems|presumably|or|alternatively|actually|you'?re|you are|your)\b[\s,]/i;

// High-signal CoT / prompt-echo keyword markers — phrases a user-perspective
// suggestion would never contain but the model's own reasoning about the prompt does.
const FOLLOWUP_META_KEYWORD_RE =
  /\b(we need to|we should|let me|i'?ll|i will|i should|i'?ll follow|based on (the )?context|the user'?s?\b|follow the context|the context\b|q&a\b|profile context|suggested next|generate \d+ follow|follow-up suggestions|user context|personalize suggestions|occupation:|interests:|goals:|name:)\b/i;

/**
 * True when a follow-up candidate line reads like the model's own meta-reasoning /
 * prompt-echo rather than a user-facing suggestion, and should be discarded.
 *
 * Combines two guards:
 *  - meta-reasoning: opens with a hedge/conjunction, or contains a CoT/prompt-echo keyword.
 *  - structural prose: too long to be a clickable suggestion (>140 chars) or contains
 *    an internal sentence boundary ("The user is Rome. I'll connect…") — a genuine
 *    suggestion is ONE short question/command with no internal ". Capital" break.
 */
export function isLeakedReasoningFollowUp(line: string): boolean {
  // 2026-07-12: normalize curly/smart apostrophes (U+2018/U+2019) to a straight
  // apostrophe before testing. The leading-meta regex matches `you'?re`, `i'?ll`
  // etc. with a STRAIGHT apostrophe only — a synthesis model emitting "You’re Paul
  // Cozzolino — based on your Calendly handle…" (curly ’) slipped straight through
  // to a live suggestion button. Same class of bug fixed in memory.graph.ts via
  // normalizeQuotes(); apply it here too so the tested patterns match either form.
  const normalized = line.replace(/[‘’]/g, "'");
  if (FOLLOWUP_META_LEADING_RE.test(normalized) || FOLLOWUP_META_KEYWORD_RE.test(normalized)) return true;
  if (normalized.length > 140) return true;
  const sentenceBreaks = (normalized.match(/[.!?]\s+[A-Z]/g) || []).length;
  return sentenceBreaks >= 1;
}


// ── Follow-Up Parsing ──────────────────────────────────────────────────────────

export function parseFollowUps(text: string): { followUps: string[]; cleanText: string } {
  const followUps: string[] = [];
  // Case-insensitive (ticket 0d344f95): synthesis models don't always honor
  // the doctrine's exact uppercase '[FOLLOWUPS]' — a '[Followups]' variant
  // must still extract (chips) and strip (cleanText), matching the frontend's
  // /gi strips and the sse-adapter's case-insensitive live suppression.
  let match = text.match(/\[FOLLOWUPS\]([\s\S]*?)\[\/FOLLOWUPS\]/i);
  if (!match) {
    match = text.match(/\[FOLLOWUPS\]([\s\S]*)$/i);
  }
  if (match) {
    const lines = match[1].split('\n')
      .map((l: string) => l.replace(/^[-•*\d.]+\s*/, '').trim())
      .filter((l: string) => l.length > 8)
      // 2026-07-11: apply the same reasoning-leak guard the utility generateFollowUps()
      // path uses (moonshot.integration.ts). A synthesis model can emit a [FOLLOWUPS]
      // block containing its own meta-reasoning about the user ("You're Paul Cozzolino
      // — based on your Calendly handle…"), which previously reached the UI as a live
      // suggestion button because this parse path never filtered it. Filter on the raw
      // line (before rewrite) so the tested patterns match.
      .filter((l: string) => !isLeakedReasoningFollowUp(l))
      .map((l: string) => rewriteFollowUp(l));
    const splitLines: string[] = [];
    for (const line of lines) {
      splitLines.push(...splitCompoundFollowUp(line));
    }
    followUps.push(...splitLines.filter((l: string) => !isLeakedReasoningFollowUp(l)).slice(0, 5));
  }
  const cleanText = text
    .replace(/\[FOLLOWUPS\][\s\S]*?\[\/FOLLOWUPS\]/gi, '')
    .replace(/\[FOLLOWUPS\][\s\S]*$/gi, '')
    // Ticket 7af42393 — ORPHAN CLOSER, same rule the renderer now applies
    // (plain-session.ts stripForStorage/stripLiveTags). Every rule above keys
    // on the LITERAL opener, so a closer whose opener the model botched
    // survives. Specimen (chat 9430e12f, msg 6a8f46bc): `[ FOLOWUPS ]` (ONE
    // L, spaced) + a correctly spelled `[/FOLLOWUPS]`. This function is the
    // PERSIST + Telegram seam (stripAnswerMarkup, telegram.controller), so
    // without the rule the token is still stored and still sent to Telegram
    // even though the web reader no longer shows it.
    .replace(/\[\/FOLLOWUPS\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { followUps, cleanText };
}

/**
 * stripAnswerMarkup — remove the structured answer blocks ([CANVAS] regions +
 * [FOLLOWUPS] blocks, terminated or truncated at end-of-text) from assistant
 * text, leaving ordinary prose and [SEND_EMAIL] drafts untouched. Composes the
 * two tested parsers so every call site gets EXACTLY the content-finalize
 * treatment (chat-agent.service.ts; telegram.controller.ts inlines the same
 * composition). Added for the persisted transcript PARTS (ticket dc7fd17a):
 * agent-loop text parts accumulate the raw model stream — the sse-adapter only
 * cuts [FOLLOWUPS]/canvas from the FORWARDED SSE chunks — so persisting parts
 * unstripped leaked raw "[FOLLOWUPS]" markup into the reloaded chat detail
 * view, which renders parts verbatim and ignores the (clean) content field.
 */
export function stripAnswerMarkup(text: string): string {
  return parseFollowUps(parseCanvasTags(text).cleanText).cleanText;
}


// ── Canvas Tag Parsing ─────────────────────────────────────────────────────────

export function parseCanvasTags(text: string): { canvases: ParsedCanvas[]; cleanText: string } {
  const canvases: ParsedCanvas[] = [];
  const canvasRegex = /\[CANVAS:([^\]]+)\]([\s\S]*?)\[\/CANVAS\]/gi;
  let match: RegExpExecArray | null;
  while ((match = canvasRegex.exec(text)) !== null) {
    const attrStr = match[1];
    const content = match[2].trim();
    const attrs: Record<string, string> = {};
    for (const part of attrStr.split(',')) {
      const eqIdx = part.indexOf('=');
      if (eqIdx !== -1) {
        attrs[part.substring(0, eqIdx).trim()] = part.substring(eqIdx + 1).trim();
      }
    }
    let cleanContent = content;
    const canvasType = attrs['type'] || 'document';
    if (canvasType === 'code' || canvasType === 'mermaid') {
      cleanContent = content
        .replace(/^```[a-zA-Z0-9]*\s*\n?/, '')
        .replace(/\n?```\s*$/, '')
        .trim();
    }
    canvases.push({
      type: canvasType,
      language: attrs['lang'] || attrs['language'] || undefined,
      title: attrs['title'] || 'Untitled',
      content: cleanContent,
    });
  }
  // Fallback: bare [CANVAS]content[/CANVAS] without attributes
  if (canvases.length === 0) {
    const bareCanvasRegex = /\[CANVAS\]([\s\S]*?)\[\/CANVAS\]/gi;
    let bareMatch: RegExpExecArray | null;
    while ((bareMatch = bareCanvasRegex.exec(text)) !== null) {
      const content = bareMatch[1].trim();
      if (content.length > 10) {
        const headingMatch = content.match(/^#{1,3}\s+(.+)$/m);
        const inferredTitle = headingMatch
          ? headingMatch[1].replace(/[#*_`]/g, '').trim().substring(0, 60)
          : 'Untitled';
        canvases.push({ type: 'document', title: inferredTitle || 'Untitled', content });
      }
    }
  }
  const cleanText = text
    .replace(/\[CANVAS:[^\]]+\][\s\S]*?\[\/CANVAS\]/gi, '')
    .replace(/\[CANVAS\][\s\S]*?\[\/CANVAS\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { canvases, cleanText };
}


// ── Canvas Preamble Detection ──────────────────────────────────────────────────

/**
 * Detect when synthesis text contains a preamble that references a canvas
 * (e.g. "open the canvas below", "see the canvas", "view it in the canvas")
 * but does NOT contain any actual [CANVAS:...] tags.
 *
 * This catches the bug where the model writes "Here's your corporate structure
 * map — open the canvas below for a complete view" but never emits the
 * [CANVAS:...][/CANVAS] block, leaving the user with a broken promise.
 *
 * 2026-06-15: Added to address user feedback about "too short" responses that
 * promise a canvas but deliver only a preamble sentence.
 */
export function detectCanvasPreambleWithoutContent(text: string): boolean {
  const CANVAS_PROMISE_PATTERNS = [
    /canvas below/i,
    /open the canvas/i,
    /view (?:it |the (?:full |complete )?(?:content |document |artifact )?)?in (?:the )?canvas/i,
    /see the canvas/i,
    /check the canvas/i,
    /canvas (?:card |panel )?(?:below|above|attached)/i,
    /(?:full|complete|detailed) (?:version|content|document|artifact) (?:is )?in the canvas/i,
    /I['']ve (?:created|prepared|built|generated) (?:a |the )?canvas/i,
    /canvas (?:to |for )(?:view|edit|download)/i,
  ];
  const hasCanvasPromise = CANVAS_PROMISE_PATTERNS.some(p => p.test(text));
  if (!hasCanvasPromise) return false;
  const hasCanvasBlock = /\[CANVAS[:\]]/i.test(text);
  return !hasCanvasBlock;
}

/**
 * Detect a "planning stub" — a synthesis that is ENTIRELY a promise/plan to do
 * something (search, look up, check) rather than an actual answer.
 *
 * 2026-07-09: Re-ask analysis (chat b7f99171) surfaced a One Piece volume query
 * whose answer came back as "Let me search more specifically for the current One
 * Piece English volume release info." — a planning sentence, not an answer. It's
 * 84 chars, so the MIN_SYNTHESIS_LENGTH (80) guard let it through, and the user
 * had to re-ask ("try again"). This catches that class: a SHORT response that is
 * nothing but a meta/planning statement gets treated like a failed synthesis so
 * the pipeline falls back to the best real model response.
 *
 * Deliberately conservative — only fires when the WHOLE response is short
 * (< 320 chars, i.e. no real answer content followed the plan) so a long answer
 * that merely opens with "Let me walk through..." is never discarded.
 *
 * 2026-07-11: extended to catch multi-sentence planning stubs in the 320–600 char
 * band (finding: a 4-sentence "Let me look into X. I'll search for Y. This will
 * help me find Z. One moment while I gather the information." runs past 320 and
 * slipped through). Precision is preserved by NOT simply raising the char cap:
 * in the extended band the stub only fires when EVERY sentence is a plan/deferral
 * AND none carries answer content (a digit). A real answer that opens with a
 * planning phrase then delivers a fact has ≥1 non-deferral sentence, so it is
 * never discarded.
 */
export function isPlanningStub(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  // Hard ceiling: past this length there is always real answer content, so never a stub.
  if (t.length > 600) return false;
  // Strip a leading list/heading marker if present, then look at the opening clause.
  const firstLine = t.replace(/^[#>\-*\s]+/, '').split(/\n/)[0].trim();
  // High-signal INFORMATION-RETRIEVAL promises only. Deliberately excludes bare "check"
  // and "find" (both appear in real answers — "Let me check that for you, the answer
  // is 42"). Requires a web/lookup verb that signals the model deferred rather than
  // answered ("let me search…", "let me look that up", "I'll research…").
  const PLANNING_PATTERNS = [
    /^(?:ok(?:ay)?[,.\s-]+)?(?:let me|let'?s|i'?ll|i am going to|i'?m going to|i need to|i will|i'?ve got to|allow me to|give me a (?:sec|second|moment)|one moment|hold on|hang on)\b[\s,]*(?:while\s+i(?:'?ll|'?m)?\s+)?(?:can\s+)?(?:just\s+)?(?:go(?:ing)?\s+(?:and\s+)?)?(?:search|look(?:ing)?\s+(?:\w+\s+)?(?:up|into|for)|research|dig into|browse|pull up|find out|look (?:it|that|this) up|verify (?:this|that))\b/i,
    /^(?:searching|looking (?:up|into)|researching|digging into)\b[\s\S]*$/i,
  ];
  const opensWithPlan = PLANNING_PATTERNS.some(p => p.test(firstLine) || p.test(t));
  if (!opensWithPlan) return false;

  // Fast path (unchanged behaviour): a SHORT response that opens with a lookup plan is a
  // stub — a real answer that opens with a planning phrase then continues with content
  // almost always exceeds this.
  if (t.length <= 320) return true;

  // Extended band (320–600 chars): only a stub if it contains NO answer content — i.e.
  // EVERY sentence is a plan/deferral and none carries a concrete data point. This keeps
  // the peptides-style real answer ("Let me walk through… BPC-157 has shown…") safe: its
  // factual sentences are neither deferrals nor digit-free.
  const sentences = t.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const DEFERRAL_SENTENCE =
    /^(?:ok(?:ay)?[,.\s-]+)?(?:let me|let'?s|i'?ll|i am going to|i'?m going to|i need to|i will|i'?ve got to|allow me to|give me a|one moment|hold on|hang on|bear with me|just (?:a|one)|searching|looking|researching|digging|this (?:will|should|would) help|that (?:will|should|would) help|to (?:answer|help|give you|make sure)|so (?:i|that i))\b/i;
  const ANSWER_SIGNAL = /\d/; // any digit = concrete data (year, price, count, volume no.)
  const everySentenceIsDeferral = sentences.every(
    s => DEFERRAL_SENTENCE.test(s) && !ANSWER_SIGNAL.test(s),
  );
  return everySentenceIsDeferral;
}

// ── Model Not Found Retry ──────────────────────────────────────────────────────

/**
 * Retry an async function with exponential backoff when it fails with a
 * "Model not found" / NOT_FOUND / 404 error. This handles the daily ~6am UTC
 * provider maintenance window where all open-source models simultaneously
 * return 404 errors for 30-60 seconds.
 *
 * 2026-06-16: Added to fix severity-2 bug where daily 6am model 404 errors
 * cause complete open-source pipeline failure. Production logs show 5-10
 * consecutive failures across DeepSeek, GLM, and Kimi at ~6:17am UTC.
 *
 * @param fn - The async function to retry
 * @param label - Label for logging (e.g. "DeepSeek query")
 * @param maxRetries - Maximum number of retries (default: 2)
 * @param baseDelayMs - Base delay in ms for exponential backoff (default: 10000)
 */
export async function retryOnModelNotFound<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries: number = 2,
  baseDelayMs: number = 10000,
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const errMsg = String(
        err?.response?.data?.error?.message ||
        err?.response?.data?.message ||
        err?.message ||
        err?.response ||
        ''
      ).toLowerCase();
      const status = err?.response?.status || err?.status;

      // Only retry on "model not found" / 404 / NOT_FOUND patterns
      const isModelNotFound =
        status === 404 ||
        errMsg.includes('model not found') ||
        errMsg.includes('not_found') ||
        errMsg.includes('not deployed') ||
        errMsg.includes('inaccessible');

      if (!isModelNotFound || attempt >= maxRetries) {
        throw err;
      }

      // Exponential backoff with jitter to de-sync concurrent retries (thundering herd).
      // 2026-06-20: Cap jitter at baseDelayMs (still 0-5s for the production 10s base) so
      // callers/tests passing a small base don't wait up to a fixed 5s — previously the
      // flat random*5000 jitter dominated small-delay retries and made the unit tests flaky
      // by occasionally exceeding jest's 5s default timeout. Production timing is unchanged.
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * Math.min(5000, baseDelayMs));
      // Log using console.warn — avoids importing logger (which pulls in env.ts and
      // causes process.exit(1) in test environments without env vars)
      console.warn(
        `[retryOnModelNotFound] ${label}: model not found (attempt ${attempt + 1}/${maxRetries + 1}), ` +
        `retrying in ${Math.round(delay / 1000)}s — ${errMsg.substring(0, 100)}`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// ── Canvas Preamble Stripping ──────────────────────────────────────────────────

/**
 * Strip canvas-referencing preamble sentences from synthesis text when the model
 * promised a canvas but didn't emit [CANVAS:] tags. Removes sentences that
 * reference "canvas", "open the canvas", etc., leaving any remaining meaningful
 * content intact.
 *
 * When all sentences reference the canvas and stripping would leave an empty
 * string, a neutral confirmation ("Your document is ready below.") is returned
 * instead — the original text is a broken promise ("Open the canvas below")
 * pointing at a canvas that was never emitted, so echoing it just re-shows the
 * broken UX. A neutral line at least reads coherently.
 *
 * 2026-06-16: Added to fix canvas-preamble-without-content responses. Previously
 * the detection function existed but only logged; now we actively strip the broken
 * preamble so users see useful content instead of a broken promise.
 *
 * 2026-06-17: Fixed blank-bubble regression — fell back to original text when
 * stripping produced an empty result.
 *
 * 2026-06-29: When stripping is empty the original text is ONLY a canvas promise
 * (e.g. "Open the canvas below.") with no canvas behind it — returning it verbatim
 * re-shows the broken promise. Replace it with a neutral, self-consistent line.
 *
 * 2026-06-30: The earlier fallback "Here's your answer below." was itself misleading —
 * it promises content "below" when nothing was emitted (same broken-promise UX it was
 * meant to fix). When ALL we have is a canvas promise with no canvas, the honest signal
 * is that generation failed and a retry is worth it. This reads coherently on its own
 * and points the user at a concrete next step instead of a phantom artifact.
 */
const NEUTRAL_CANVAS_FALLBACK =
  "I wasn't able to put that together just now — could you ask me to try again?";

export function stripCanvasPreamble(text: string): string {
  // Split into sentences and filter out those referencing canvas
  const CANVAS_REF_PATTERNS = [
    /canvas below/i,
    /open the canvas/i,
    /view (?:it |the )?in (?:the )?canvas/i,
    /see the canvas/i,
    /check the canvas/i,
    /canvas (?:card|panel|above|attached)/i,
    /in the canvas/i,
    /I['']ve (?:created|prepared|built|generated) (?:a |the )?canvas/i,
    /canvas (?:to |for )(?:view|edit|download)/i,
  ];

  // Split on sentence boundaries (period + space, or newline)
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  const filtered = sentences.filter(sentence =>
    !CANVAS_REF_PATTERNS.some(p => p.test(sentence))
  );

  const result = filtered.join(' ').replace(/\s+/g, ' ').trim();

  // If stripping removed everything, the text was ONLY a canvas-promise preamble
  // with no canvas behind it. Returning it verbatim re-shows the broken promise
  // ("Open the canvas below" → no canvas), so swap in a neutral, self-consistent
  // line rather than a blank bubble or a dangling pointer.
  if (result.length === 0) {
    return NEUTRAL_CANVAS_FALLBACK;
  }

  return result;
}

// ── IP Normalization ───────────────────────────────────────────────────────────

/**
 * Normalize an IP address by stripping the IPv4-mapped IPv6 prefix.
 * Node.js/Express can return `::ffff:192.168.1.1` for `req.ip` while
 * `x-forwarded-for` returns `192.168.1.1`. This mismatch causes legitimate
 * users to get 403 errors on stream token IP verification.
 *
 * 2026-06-15: Added to fix stream token IP mismatch false-positives.
 */
export function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7);
  }
  return ip;
}

/**
 * Mask a client IP to its network prefix for privacy-conscious logging.
 *
 * 2026-06-28: We log IP mismatches for anonymous stream tokens (defense-in-depth),
 * but logging full user IP addresses into the application log (and onward into the
 * AppErrorLog table via the Winston transport) has privacy implications in some
 * jurisdictions. Since the IP check itself only compares the network PREFIX
 * (sameIpSession → /24 for IPv4, /64 for IPv6), the host portion carries no
 * diagnostic value — mask it. Returns e.g. "203.0.113.x" or "2001:db8:1:2:x".
 */
export function maskIp(ip: string): string {
  const n = normalizeIp(ip || '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(n)) {
    return `${n.split('.').slice(0, 3).join('.')}.x`;
  }
  if (n.includes(':')) {
    return `${n.split(':').slice(0, 4).join(':')}:x`;
  }
  return 'unknown';
}

/**
 * Loose same-session IP check for anonymous stream tokens.
 *
 * 2026-06-26: Mobile users on cellular / CGNAT networks frequently get a different
 * IP between POST /register and GET /stream (within the 3-min token TTL), which
 * produced false 403 "Stream token does not belong to this session" errors. The IP
 * check is only defense-in-depth — the token is a single-use, cryptographically
 * random UUID with a short TTL — so an exact match is needlessly strict.
 *
 * This compares the network prefix instead: the first 3 octets for IPv4 (a /24,
 * which covers the gateway pool that rotates a client's last octet) and the first 4
 * hextets for IPv6 (a /64, the typical single-subscriber allocation). A totally
 * different network (different ISP/region) still fails. Falls back to exact match
 * for unparseable values.
 */
export function sameIpSession(a: string, b: string): boolean {
  const na = normalizeIp(a);
  const nb = normalizeIp(b);
  if (na === nb) return true;

  const isV4 = (ip: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
  if (isV4(na) && isV4(nb)) {
    return na.split('.').slice(0, 3).join('.') === nb.split('.').slice(0, 3).join('.');
  }
  // IPv6 (or mixed) — compare the first 4 hextets (/64) when both look like IPv6.
  if (na.includes(':') && nb.includes(':')) {
    const prefix = (ip: string) => ip.split(':').slice(0, 4).join(':');
    return prefix(na) === prefix(nb);
  }
  return false;
}
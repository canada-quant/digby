/**
 * Thread-summary provenance guard (ticket 65aa3682, 2026-09-17).
 *
 * ROOT CAUSE: extractThreadStateNode (memory.graph.ts) rewrites a chat's
 * rolling threadSummary from ONLY the latest user/assistant texts (600 chars
 * each) plus the prior summary — no tool receipts, no evidence ledger. Under
 * that grounding gap the extraction LLM can confabulate operational specifics
 * and present them as established fact. Observed 2026-09-17 on the Fleet
 * Supervisor chat (c0e22e36) in the deploy-recovery window: the rewritten
 * summary carried a "Progress Recap (00:13:34Z)" heading describing a curl to
 * https://api.openai.com/v1/credits returning "$12.40", YAML file edits and a
 * "top-up already initiated" — NONE present in any input to the extraction —
 * which later runs (and the L2 cross-checker) then ingested as authoritative
 * [Conversation Thread] History. The L2 checker correctly flagged the content
 * as "UNVERIFIED/likely confabulated"; nothing reached the owner.
 *
 * This module is the deterministic backstop at WRITE time: high-specificity
 * artifacts — URLs/domains, dollar amounts, absolute paths, command-shaped
 * backtick spans — that appear in NONE of the extraction inputs are
 * fabrications BY CONSTRUCTION, and the sentence carrying them is dropped
 * before the summary is persisted. Membership is tested case-insensitively
 * against ALL extraction inputs (prior state JSON + user text + assistant
 * text), so anything the model legitimately carried forward or quoted passes.
 *
 * Deliberate limits (documented so nobody "fixes" them into false positives):
 *  - Vague prose claims ("top-up already initiated", "YAML edits") are NOT
 *    token-catchable — those are handled by the extraction prompt's grounding
 *    rules (THREAD_SUMMARY_GROUNDING_RULES) and the run-level integrity
 *    layer. This guard takes only the provable class.
 *  - Membership against the PRIOR STATE means a token already present in the
 *    stored summary can be carried forward (the guard cannot distinguish
 *    "quoted from prior state" from "prior state was already poisoned"). Rows
 *    poisoned before this guard shipped are cleaned by re-write after the
 *    poisoned exchange ages out of the window, or by manual store cleanup.
 */

/** Prompt rules interpolated into the thread-state extraction prompt (memory.graph.ts). */
export const THREAD_SUMMARY_GROUNDING_RULES = [
  '- GROUNDING (ticket 65aa3682): record ONLY what the provided texts explicitly state. NEVER invent operational specifics — shell/API commands, URLs or endpoints, dollar amounts, file paths, or whether an action was performed. If a text CLAIMS an action or result, record it AS a claim ("the assistant reported X"), never as an established or performed fact.',
  '- Write plain narrative prose — NO section headings and NO timestamped headings (e.g. "Progress Recap (00:13:34Z)").',
].join('\n');

export interface ThreadGroundingResult {
  /** Sanitized summary ('' when every sentence was stripped — the caller falls back to the prior summary). */
  text: string;
  /** Sentences removed for carrying high-specificity tokens absent from every extraction input. */
  strippedSentences: string[];
  /** Heading lines removed (timestamped-heading chrome — content-less by construction). */
  strippedHeadings: string[];
}

/* Token shapes the extraction model must never INVENT. Presence in a sentence
 * is only flagged when the token is ALSO absent from every input text. */

/** Full URLs with scheme. */
const URL_TOKEN_G = /https?:\/\/[^\s)\]}>'"]+/gi;
/** Bare domains (api.openai.com/v1/credits without the scheme). */
const DOMAIN_TOKEN_G = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|co)(?:\/[\w.@+~%-]*)*\b/gi;
/** Dollar amounts ($12.40, $100, $1,250.00). */
const MONEY_TOKEN_G = /\$\d[\d,]*(?:\.\d{1,2})?\b/g;
/** Absolute paths with 2+ segments (/etc/deploy/app.yml). */
const PATH_TOKEN_G = /\/[\w.@+~-]+(?:\/[\w.@+~-]+)+/g;
/** Backticked spans — only command/path-shaped ones are checked (see below). */
const BACKTICK_SPAN_G = /`([^`\n]{2,120})`/g;
/** A backtick span is command-shaped when it has shell structure or starts with a known CLI word. */
const COMMAND_SHAPE = /[\s/=$~]|^(?:curl|wget|git|npm|npx|pnpm|yarn|docker|kubectl|aws|gcloud|az|ssh|scp|psql|node|python\d?|bash|sh|fuser|systemctl|jq|make|cargo|pip\d?|brew)\b/i;
/** Markdown-marked heading line ending in a parenthesized clock time — chrome by construction. */
const HEADING_MARKED_RE = /^\s*(?:#{1,6}\s+|(?:\*\*|__))[A-Z][\w&/+ -]{1,60}?\(\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?\s*Z?\s*\)\s*(?:\*\*|__)?\s*$/;
/** Unmarked timestamped-heading line: only stripped when it ALSO names recap-class chrome
 * ("Progress Recap (00:13:34Z)") — a plain content sentence that happens to end in a
 * time paren ("The queue drained as one turn (00:33Z)") must be KEPT (no false positives). */
const HEADING_RECAP_CLASS_RE = /^\s*[A-Z][\w&/+ -]{0,60}?\b(?:recap|progress report|checkpoint|status report|summary)\b[\w&/+ -]{0,40}?\(\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?\s*Z?\s*\)\s*$/i;

function isTimestampedHeading(line: string): boolean {
  return HEADING_MARKED_RE.test(line) || HEADING_RECAP_CLASS_RE.test(line);
}

function specificTokens(sentence: string): string[] {
  const out = new Set<string>();
  for (const re of [URL_TOKEN_G, DOMAIN_TOKEN_G, MONEY_TOKEN_G, PATH_TOKEN_G]) {
    re.lastIndex = 0;
    for (const m of sentence.matchAll(re)) {
      // Strip trailing sentence punctuation the URL/path char classes capture
      // (reviewer C3, 65aa3682): a grounded URL ending the summary's last
      // sentence ("…shared https://example.com/docs.") must still match the
      // grounded input — the raw token carries the sentence-final period.
      const cleaned = m[0].replace(/[.,;:!?]+$/, '');
      if (cleaned) out.add(cleaned);
    }
  }
  BACKTICK_SPAN_G.lastIndex = 0;
  for (const m of sentence.matchAll(BACKTICK_SPAN_G)) {
    const span = m[1].trim();
    if (COMMAND_SHAPE.test(span)) out.add(span);
  }
  return [...out];
}

/**
 * Deterministic provenance guard for the rolling thread summary. Drops
 *  (1) timestamped-heading lines (content-less chrome the prompt now bans), and
 *  (2) sentences carrying a high-specificity token (URL/domain/$amount/path/
 *      command-shaped backtick span) that appears in NONE of `sourceTexts`
 *      (the extraction inputs: prior state JSON, user text, assistant text).
 * Membership is case-insensitive substring — the LENIENT direction (fewer
 * false positives): anything the model could have had any basis for passes.
 */
export function guardThreadSummaryGrounding(
  summary: string,
  sourceTexts: Array<string | null | undefined>,
): ThreadGroundingResult {
  const strippedHeadings: string[] = [];
  const strippedSentences: string[] = [];
  if (!summary || !summary.trim()) return { text: '', strippedSentences, strippedHeadings };
  const haystack = sourceTexts
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n')
    .toLowerCase();
  const grounded = (token: string) => haystack.includes(token.toLowerCase());

  // 1. Line pass — drop timestamped-heading chrome.
  const keptLines: string[] = [];
  for (const line of summary.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isTimestampedHeading(trimmed)) { strippedHeadings.push(trimmed); continue; }
    keptLines.push(trimmed);
  }

  // 2. Sentence pass — same universal split idiom as scrubTextAgainstRejections
  // (no lookbehind; URLs/$amounts contain no ". " so they survive intact).
  const sentences = keptLines
    .join(' ')
    .split(/(?:\.\s+|;\s+|\|\s+)/)
    .map((s) => s.trim())
    .filter(Boolean);
  const kept: string[] = [];
  for (const sentence of sentences) {
    const fabricated = specificTokens(sentence).find((t) => !grounded(t));
    if (fabricated) { strippedSentences.push(sentence); continue; }
    kept.push(sentence);
  }
  const text = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
  return { text, strippedSentences, strippedHeadings };
}

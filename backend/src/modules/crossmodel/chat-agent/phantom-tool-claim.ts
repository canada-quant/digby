/**
 * PHANTOM WEB-FAILURE CLAIM DETECTION (ticket 1ef71188, 2026-09-27).
 *
 * The class: an answer narrates a web attempt "just now" FAILING where the
 * run's parts show no web tool call backed it. A fabricated tool failure is
 * worse than an honest unsearched answer — it excuses a skipped search,
 * misattributes the omission to infrastructure, and pollutes the failure
 * signal (users stop reporting real bugs because they believe search is
 * flaky).
 *
 * The originating incident is UNPROVEN as an instance of this class (review
 * B1, telemetry re-probed 2026-09-28): the claim sentence sat in the answer
 * that finalized 21:24:48Z — a run that itself made 2 web_pipe calls — and
 * guest runs persist no per-part rows, so whether the claim text preceded
 * those calls is not recoverable. The FOLLOW-UP turn (first paint
 * 21:35:02Z) re-tested search healthy (3 calls) and self-filed the ticket,
 * so the platform search was never at fault; whether the claim was
 * fabricated or an exaggerated quality judgment on the run's own 2 calls is
 * unprovable from persisted sources. The detector targets the class; this
 * incident motivated it without proving it. Telemetry only — see the wiring
 * in chat-agent.service.ts; nothing here blocks or rewrites a delivery.
 *
 * PRECISION CONTRACT (mirrors tool-call-leak.ts): the detector must never
 * fire on honest text. Four signal classes must co-occur in ONE text
 * segment (a sentence-ish span):
 *   ATTEMPT     — first-person / possessive narration of a web attempt
 *                 ("I tried to pull…", "my search", "the search");
 *   FAILURE     — a failure outcome ("came back garbage", "returned
 *                 nothing", "failed", "timed out", …);
 *   RECENCY     — an anchor that scopes the claimed attempt to NOW ("just
 *                 now", "a moment ago", "right now") — an undated reference
 *                 may honestly describe an EARLIER TURN's search, which
 *                 this run's parts can neither back nor refute;
 *   WEB SCOPE   — the segment names a WEB action ("search", "web",
 *                 "scrape", "fetch", "online"…) — a NON-web tool's honest
 *                 failure narration ("I just tried calling list_chats and
 *                 it failed, so I cannot show your chats right now") must
 *                 never fire (review finding on the first cut: the signal
 *                 regexes matched any tool's failure prose while the
 *                 positional gate counted only web tools).
 * Plus the positional gate: ZERO web tool_calls in the run's parts BEFORE
 * the claiming text. A claim that FOLLOWS a web tool call this run is an
 * honest report of that call's real outcome (or a quality judgement on real
 * results) — never flagged.
 *
 * KNOWN GAPS (accepted, telemetry-only): two-sentence splits evade the
 * one-segment rule; a conditional ("the search would only come back
 * garbage") fires; quoting the user's own words can fire; a trimmed
 * tool_call part (tool_list_trimmed) leaves its tool_result unable to back
 * a later honest report. All undercount/overcount METRIC noise — never a
 * user-facing action.
 *
 * LEAF module (same pattern as platform-tool-names / tool-call-leak):
 * no imports, so it stays unit-testable without the chat-agent service's
 * config/env import-exit hazard. The web-tool name roster is MIRRORED from
 * chat-agent.service.ts WEB_GROUNDING_TOOLS (+ youtube_pipe) — a name this
 * mirror misses only means a missed count (fail-safe), never a false fire.
 */

/** Web tool names whose calls back a web-attempt narration (mirrors
 *  chat-agent.service.ts WEB_GROUNDING_TOOLS, plus youtube_pipe — all are
 *  "I went to the web" tools a failure claim could hide behind). */
const WEB_TOOL_NAMES: ReadonlySet<string> = new Set([
  'search_engine', 'scrape_as_markdown', 'browser_task', 'web_pipe', 'youtube_pipe',
]);

/** First-person / possessive narration of a web attempt (ATTEMPT signal). */
const ATTEMPT_RES: RegExp[] = [
  /\b(?:i|i'?ve)\s+(?:just\s+|now\s+|already\s+)?(?:tried|attempted|ran|pulled|fetched|searched)\b/i,
  /\bmy\s+(?:web\s+|quick\s+|fresh\s+)?(?:search|scrape|fetch|query|pull|attempt|look)\b/i,
  /\bthe\s+(?:web\s+)?(?:search|serp|scrape|fetch|query)\b/i,
  /\bsearch_engine\b|\bscrape_as_markdown\b|\bweb_pipe\b/i,
];

/** A failure outcome for that attempt (FAILURE signal). */
const FAILURE_RES: RegExp[] = [
  /\bcame\s+back\s+(?:garbage|empty|useless|junk|broken|with\s+(?:nothing|no\s+results|garbage|junk))\b/i,
  /\b(?:returned|returning|returns)\s+(?:nothing|garbage|junk|useless|empty|an\s+error|errors)\b/i,
  /\b(?:failed|failing|fails)\b/i,
  /\berror(?:ed|ing|s)?\s+out\b/i,
  /\btimed?\s+out\b/i,
  /\b(?:is|are|was|were)\s+(?:down|broken|unresponsive|flaky|flaking)\b/i,
  /\bdidn'?t\s+(?:work|return\s+(?:anything|results)|come\s+back|find\s+(?:anything|results))\b/i,
  /\bno\s+results\b/i,
  /\b(?:garbage|junk|useless|rubbish)\b/i,
];

/** An anchor scoping the claimed attempt to NOW, not an earlier turn (RECENCY signal). */
const RECENCY_RES: RegExp[] = [
  /\bjust\s+now\b/i,
  /\bjust\s+(?:tried|ran|searched|pulled|fetched|attempted)\b/i,
  /\ba\s+(?:moment|minute|second)\s+ago\b/i,
  /\bmoments\s+ago\b/i,
  /\bright\s+now\b/i,
  /\b(?:is|are)\s+coming\s+back\b/i,
];

/** The segment must name a WEB action (WEB-SCOPE signal): a NON-web tool's
 *  honest failure narration ("I just tried calling list_chats and it
 *  failed, so I cannot show your chats right now") must never fire — the
 *  ATTEMPT/FAILURE/RECENCY regexes alone match any tool's failure prose
 *  while the positional gate counts only web tools (review finding on the
 *  first cut). Word-start-anchored so "eyebrows" never matches "brows…". */
const WEB_SCOPE_RES = /\bweb\w*|\bsearch\w*|\bscrape\w*|\bfetch\w*|\bserp\b|\bbrows\w*|\bonline\b|\bcrawl\w*|\binternet\b|\bgoogle\b|\bduckduckgo\b/i;

/** Split a text block into sentence-ish segments (lookbehind keeps it simple
 *  and deterministic). Segments outside this length band cannot hold all
 *  three signals — the floor prevents sub-sentence fragments (which would
 *  let ATTEMPT and FAILURE match across unrelated clauses), the ceiling
 *  keeps one segment from spanning a whole multi-topic paragraph. */
function segments(text: string): string[] {
  return String(text || '')
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25 && s.length <= 400);
}

/** True when ONE segment carries all four signal classes (the claim shape). */
function isWebFailureClaimSegment(segment: string): boolean {
  return (
    ATTEMPT_RES.some((re) => re.test(segment))
    && FAILURE_RES.some((re) => re.test(segment))
    && RECENCY_RES.some((re) => re.test(segment))
    && WEB_SCOPE_RES.test(segment)
  );
}

export interface UnbackedWebClaimFinding {
  /**
   * 'midturn' — a streamed text PART claimed the failed attempt while no web
   *             tool call had run yet in this run (a mid-turn claim can
   *             self-correct later in the same turn);
   * 'final'   — the FINAL answer text carries the claim and the whole run
   *             made zero web tool calls.
   */
  tier: 'midturn' | 'final';
  /** Web tool calls occurred AFTER the claiming part — the run went to the
   *  web later (a self-correction signal worth segmenting the metric on). */
  selfCorrected: boolean;
  /** The matched segment, trimmed for telemetry. */
  excerpt: string;
}

/** Count web tool_calls in a parts array (pure; bad input → 0). */
function countWebCalls(parts: unknown): number {
  return Array.isArray(parts)
    ? parts.filter((p: any) => p?.type === 'tool_call' && WEB_TOOL_NAMES.has(String(p?.name || '').toLowerCase())).length
    : 0;
}

/** Text parts eligible for scanning: model text only — harness chrome
 *  (marker:'guard') and evidence-guard-struck drafts are never the model's
 *  delivered narration. */
function isScannableTextPart(p: any): boolean {
  return p?.type === 'text' && !p?.marker && !p?.struck && typeof p?.text === 'string' && p.text.trim().length > 0;
}

/**
 * Find an unbacked web-failure claim in a run's transcript: a narration
 * claiming a web attempt JUST failed, positioned where no web tool call had
 * run yet. Returns the first hit (deterministic), or null.
 *
 * Pure and total: any input shape returns a finding or null — never throws.
 */
export function findUnbackedWebFailureClaim(
  input: { parts?: unknown; finalText?: string } | null | undefined,
): UnbackedWebClaimFinding | null {
  try {
    if (!input) return null;
    const parts = Array.isArray(input.parts) ? (input.parts as any[]) : [];
    const totalWebCalls = countWebCalls(parts);

    // Pass 1 — streamed text parts, in order, against the web calls that
    // preceded EACH part (the incident's claim streamed mid-turn, before any
    // web call; the re-test came after).
    let webCallsBefore = 0;
    for (const p of parts) {
      if (p?.type === 'tool_call' && WEB_TOOL_NAMES.has(String(p?.name || '').toLowerCase())) {
        webCallsBefore += 1;
        continue;
      }
      if (!isScannableTextPart(p)) continue;
      const seg = segments(p.text).find(isWebFailureClaimSegment);
      if (seg && webCallsBefore === 0) {
        return {
          tier: 'midturn',
          selfCorrected: totalWebCalls > 0,
          excerpt: seg.slice(0, 200),
        };
      }
    }

    // Pass 2 — the final answer text, against the run's TOTAL web calls: the
    // delivered claim is only unbacked when the run never called a web tool
    // at all (a claim that follows real calls is an honest report of them).
    const finalText = typeof input.finalText === 'string' ? input.finalText : '';
    if (finalText.trim()) {
      const seg = segments(finalText).find(isWebFailureClaimSegment);
      if (seg && totalWebCalls === 0) {
        return { tier: 'final', selfCorrected: false, excerpt: seg.slice(0, 200) };
      }
    }
    return null;
  } catch {
    return null; // a detector must never break the finalize path
  }
}

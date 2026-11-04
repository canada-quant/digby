/**
 * Follow-Up Reference Enrichment (pure)
 *
 * Extracted from query-pipeline.ts (2026-07-02) so the follow-up context-injection
 * logic is unit-testable in isolation. query-pipeline.ts previously held this inline,
 * but it transitively pulls in config/env (which process.exit()s on missing keys) and
 * the entire model-integration tree, making the pure logic untestable. This module has
 * NO imports, so it runs under jest exactly like pipeline-utils.ts.
 *
 * Re-ask pattern analysis kept showing context loss on short follow-ups ("What about
 * Kat and Brunson", "And og duece clarkson"); this is the code path that keeps the
 * prior-turn topic attached to those messages. Logging is injected via an optional
 * callback so the caller (query-pipeline) still emits its observability line.
 */

export type ConversationMessage = { role: 'user' | 'assistant'; content: string };

export const FOLLOWUP_REFERENCE_PATTERNS = [
  // "what's X", "what is X", "whats X", "wahts X" (common typo), "wats X", "wat's X"
  /^(?:w[ah]+t(?:'?s| is| are))\s+(.+?)[\s?!.]*$/i,
  // "who is X", "who's X", "whos X"
  /^(?:who(?:'?s| is| are))\s+(.+?)[\s?!.]*$/i,
  // "what do you mean by X", "what did you mean by X"
  /^w[ah]+t (?:do|did) you mean (?:by|about)\s+(.+?)[\s?!.]*$/i,
  // "tell me more about X", "more about X", "explain X"
  /^(?:tell me )?(?:more about|explain)\s+(.+?)[\s?!.]*$/i,
  // "what about X", "how about X"
  /^(?:w[ah]+t|how) about\s+(.+?)[\s?!.]*$/i,
  // "why X", "why did you say X", "why did you mention X"
  /^why (?:did you (?:say|mention|suggest|recommend)\s+)?(.+?)[\s?!.]*$/i,
  // "can you explain X"
  /^can you (?:explain|elaborate on|clarify)\s+(.+?)[\s?!.]*$/i,
  // "what does X mean"
  /^w[ah]+t does\s+(.+?)\s+mean[\s?!.]*$/i,
  // "define X"
  /^define\s+(.+?)[\s?!.]*$/i,
  // "X?" — bare term with question mark (e.g. "teranet?", "colocation?")
  /^([a-zA-Z][a-zA-Z0-9 ]{1,40})\?$/,
];

// Max length of user message to consider for follow-up enrichment.
// Longer messages are likely self-contained and don't need enrichment.
export const MAX_FOLLOWUP_ENRICHMENT_LENGTH = 250; // increased from 180 (was 120) — re-ask patterns show context loss on follow-ups like "What happens if they remove your uterus" (48 chars) followed by "Sorry your ovaries" (18 chars). Longer threshold catches more implicit continuations. (2026-05-26)

/** Details about an applied enrichment, passed to the optional log callback. */
export interface EnrichmentLog {
  kind: 'explicit' | 'implicit';
  /** The referenced term, for explicit-reference enrichment. */
  term?: string;
  /** Length of the injected context/topic summary. */
  contextLen: number;
  /** The (truncated) original user message. */
  msg: string;
}

/**
 * Detect if the user's message is a short follow-up referencing a term from the
 * previous assistant response. If so, extract the relevant context and return
 * an enriched version of the message.
 *
 * Returns the original message unchanged if no enrichment is needed.
 * `onEnrich` (optional) is invoked only when enrichment is actually applied.
 */
export function enrichFollowUpReference(
  userMessage: string,
  conversationHistory: ConversationMessage[],
  onEnrich?: (info: EnrichmentLog) => void
): string {
  // Only enrich short messages that look like follow-up references
  if (userMessage.length > MAX_FOLLOWUP_ENRICHMENT_LENGTH) return userMessage;
  if (conversationHistory.length === 0) return userMessage;

  // Find the last assistant message (full, pre-truncation)
  let lastAssistantContent = '';
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    if (conversationHistory[i].role === 'assistant') {
      lastAssistantContent = conversationHistory[i].content;
      break;
    }
  }

  // ── Retry requests ("try again", "retry", "redo that") ────────────────────
  // 2026-07-09: Re-ask analysis (chat b7f99171) surfaced a bare "try again" sent
  // 1.1 min after a question whose answer came back as a useless planning stub
  // ("Let me search more specifically..."). The normal enrichment path attaches the
  // PRIOR ASSISTANT response as topic context, but here that response is the failure
  // itself (and is <100 chars, so the implicit path's `lastAssistantContent.length >=
  // 100` guard also declined). A retry doesn't want the failed answer — it wants the
  // ORIGINAL QUESTION re-run. Detect a bare retry and re-attach the last USER turn so
  // the models re-answer the real question instead of a contentless "try again".
  const RETRY_RE = /^(?:(?:please|pls|plz)\s+)?(?:try(?:\s+(?:again|once more|that\s+again|it\s+again))?|again|retry|redo(?:\s+(?:that|it))?|re-?do|one more time|do it again|go again|another (?:try|go|attempt))[\s.!?]*$/i;
  if (RETRY_RE.test(userMessage.trim())) {
    // Find the most recent prior USER message (the question being retried).
    let priorUserQuestion = '';
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      if (conversationHistory[i].role === 'user') {
        const c = conversationHistory[i].content.trim();
        // Skip if the prior "user" turn was itself a retry request (chained retries).
        if (c && !RETRY_RE.test(c)) { priorUserQuestion = c; break; }
      }
    }
    if (priorUserQuestion) {
      const enrichedMessage = `${userMessage}\n\n═══ CONVERSATION CONTEXT (the question to retry) ═══\nThe user is asking me to try again at answering their previous question:\n"${priorUserQuestion.substring(0, 800)}"\n═══ END CONVERSATION CONTEXT ═══\n\nIMPORTANT: My previous attempt at this question failed or was incomplete. Re-answer the question above thoroughly and completely — do NOT reply with a planning statement or a promise to search; produce the full answer.`;
      onEnrich?.({ kind: 'implicit', contextLen: priorUserQuestion.length, msg: userMessage.substring(0, 60) });
      return enrichedMessage;
    }
    return userMessage;
  }

  if (!lastAssistantContent || lastAssistantContent.length < 50) return userMessage;

  // Try to extract the referenced term from the user's message
  let referencedTerm = '';
  for (const pattern of FOLLOWUP_REFERENCE_PATTERNS) {
    const match = userMessage.match(pattern);
    if (match && match[1]) {
      referencedTerm = match[1].trim().replace(/[?!.]+$/, '').trim();
      break;
    }
  }
  // 2026-07-08: bare number/price references ("why not 200", "what about 200",
  // "how about section 200") — re-ask analysis (chat 38a4e008): after "best seats
  // during cirque du soleil" the user asked "why not 200", where 200 is a seat
  // SECTION from the prior answer. The "why …" pattern captures "not 200" as the
  // term, which never appears verbatim in the previous response, so no context was
  // attached. Treat a term that is purely a number (optionally led by "not") as an
  // implicit continuation instead of a named reference.
  const isBareNumberRef = /^(?:not\s+)?\$?\d[\d,.]*\+?$/.test(referencedTerm);
  if (isBareNumberRef) referencedTerm = '';

  // Implicit continuation enrichment — short follow-ups that reference the prior
  // topic without naming it ("how much would that cost", "why not 200", "been to all
  // these"). Returns an enriched message, or null when the message doesn't look like a
  // continuation. Defined as a closure so BOTH the no-term branch and the
  // term-extracted-but-not-found branch can fall back to it (2026-07-08).
  const tryImplicit = (): string | null => {
    // 2026-06-09: Added imperative verbs (make, do, change, add, remove, try, give, put,
    // keep, send, write, show, use, set, turn, update, fix, include, rewrite, redo, tweak)
    // to the implicit continuation pattern list. Re-ask patterns show users sending
    // short follow-ups like "Make it a bit more fun" (22 chars) or "Add more detail" (15 chars)
    // that clearly reference the previous response but start with imperative verbs not in
    // the original question-word-only pattern. Without these, the model loses context of
    // what "it" refers to, causing context loss and user re-asks.
    const implicitContinuationPatterns = [
      // 2026-07-08: added "why" — a bare "why …" / "why not …" almost always
      // challenges or asks about the prior answer ("why not 200", "why is that").
      /^(?:what|which|how|why|are there|is there|do they|does it|can it|could it|would it|will it|is it|are they|what about|how about|what kind|what type|what sort|how many|how much|how long|how often|where can|where do|when did|when will|when does)/i,
      /^(?:make|do|change|add|remove|try|give|put|keep|send|write|show|use|set|turn|update|fix|include|rewrite|redo|tweak)\b/i,
      // 2026-07-12: "Can you X" imperatives. Re-ask analysis (chat 45e30e99, 5 re-ask
      // clusters in 3.5 min on a Vancouver Island activities list): "Can you separate
      // comox and courtenay" and "Can you put this list in bullet form. No details
      // just names" are clearly follow-ups reformatting the prior list, but "Can you"
      // matched none of the openers so the model answered blind and the user had to
      // rephrase. "Can you explain/elaborate/clarify X" is already handled upstream by
      // FOLLOWUP_REFERENCE_PATTERNS (extracts the named term first), so this only fires
      // for the reformat/transform-the-prior-answer commands that carry no explicit term.
      /^can (?:you|we|i)\b/i,
      // 2026-06-24: Reaction / experience openers that reference the previous
      // list without naming it — re-ask analysis surfaced "been to all these"
      // (a reply to a list of hotel recommendations) and similar bare reactions
      // ("tried that", "love those", "seen them") slipping through with no
      // context, so the model answered as if the list never existed.
      /^(?:been|done|tried|seen|visited|stayed|had|got|love|like|prefer|hate|dislike|own|read|watched)\b/i,
      // Additive / alternative continuations — "or other california hotels…",
      // "and somewhere warmer", "also nearby" — these extend or pivot off the
      // prior answer and are meaningless without it.
      // 2026-07-01: Added "more"/"another"/"any more"/"anything else"/"else" —
      // re-ask analysis (chat 654b8006, 1.0 min gap): "More ideas this is hardly
      // anything" → user rephrased to "What about central saanich" after the AI
      // gave an insufficient response with no memory of the prior list. "More
      // ideas" is a bare request to extend the previous answer but matched none of
      // the openers, so the model answered as if there was no prior list.
      /^(?:or|and|also|plus|but|how about|what else|more|another|any more|anymore|anything else|something else|else|give me more|got any more)\b/i,
      // 2026-06-28: Correction / clarification openers that pivot the prior topic
      // without naming it. Re-ask analysis (chat 48db3121, 0.0 min gap): "sorry at
      // zara" → "most popular womens items to buy right now". "sorry at zara" is a
      // mid-thought correction referencing the previous topic, but it matched none of
      // the openers above and fell through with no context — so the model answered
      // blind. These openers ("sorry…", "actually…", "oops…", "wait…", "i mean…",
      // "no I meant…", "scratch that…") almost always refine the prior turn.
      // 2026-07-07: "doesn't have to be…" family. Re-ask analysis (chat 680e45b7,
      // 0.0 min gap): "Best swimming spots Vancouver island" → "Doesn't have to be
      // comox valley just on the island with that vibe". The user is relaxing a
      // geographic constraint on the prior answer, but "Doesn't…" matched none of
      // the openers and fell through with no context.
      /^(?:sorry|actually|oops|wait|nvm|nevermind|never mind|i mean|no i mean|scratch that|correction|rather|instead|doesn'?t have to be|does not have to be|not necessarily|not just)\b/i,
    ];
    // 2026-07-13: Bare prepositional QUALIFIER fragments that refine the prior
    // question without naming its topic. Re-ask analysis (chat d2cb18b9, 2.9 min
    // gap): "best things to do on sunshine coast" → "with kids". "with kids" is a
    // constraint added to the previous question, meaningless standalone, but it
    // opens with a preposition — matching none of the openers above — so it fell
    // through and the model answered blind (a generic "with kids" reply), forcing
    // the re-ask. This family covers "for beginners", "under $500", "in winter",
    // "without a car", "near the beach", "on a budget", "cheaper than that".
    //
    // Handled SEPARATELY (not in the opener array) with a tighter guard: a
    // prepositional opener alone is NOT enough, because self-contained questions
    // also start with prepositions ("In what year did the Berlin Wall fall?",
    // "For how long can I…"). We only treat it as a continuation when the fragment
    // is SHORT (≤40 chars — a real qualifier, not a full sentence) AND carries no
    // interrogative word of its own (what/when/where/who/why/how/which/whose) — a
    // genuine standalone question does; a bare "with kids" / "in winter" does not.
    const QUALIFIER_OPENER_RE = /^(?:with|without|for|under|over|near|around|in|on|at|by|during|between|below|above|up to|less than|more than|cheaper than|closer to|excluding|including|but not)\b/i;
    const INTERROGATIVE_RE = /\b(?:what|when|where|who|whom|whose|why|how|which)\b/i;
    const isQualifierFragment =
      userMessage.trim().length <= 40 &&
      QUALIFIER_OPENER_RE.test(userMessage) &&
      !INTERROGATIVE_RE.test(userMessage);
    // Anaphoric demonstratives anywhere in a short message ("…all of these",
    // "none of those", "any of them") almost always point back at the previous
    // response's list/options even when the opener isn't a question/imperative.
    const ANAPHORIC_REFERENCE_RE = /\b(?:these|those|them|all of (?:these|those|them))\b/i;
    const isImplicitContinuation = isQualifierFragment ||
      (userMessage.length <= 100 &&
        (implicitContinuationPatterns.some(p => p.test(userMessage)) ||
          ANAPHORIC_REFERENCE_RE.test(userMessage)));
    if (isImplicitContinuation && lastAssistantContent.length >= 100) {
      // Extract a short topic summary from the beginning of the last assistant response
      // (usually the first 1-2 sentences contain the main topic)
      const firstBlock = lastAssistantContent.substring(0, 500);
      const sentenceEnd = firstBlock.indexOf('. ', 50);
      const topicSummary = sentenceEnd > 0
        ? firstBlock.substring(0, sentenceEnd + 1).trim()
        : firstBlock.substring(0, 200).trim();
      const enrichedMessage = `${userMessage}\n\n═══ CONVERSATION CONTEXT (topic from my previous response) ═══\n${topicSummary}\n═══ END CONVERSATION CONTEXT ═══\n\nIMPORTANT: The user's question is a follow-up about the topic discussed in the previous response above. Answer in that context.`;
      onEnrich?.({ kind: 'implicit', contextLen: topicSummary.length, msg: userMessage.substring(0, 60) });
      return enrichedMessage;
    }
    return null;
  };

  // If no specific term was extracted (or it was a bare number cleared above), try the
  // implicit-continuation path.
  if (!referencedTerm || referencedTerm.length < 2) {
    return tryImplicit() ?? userMessage;
  }

  // Search for the referenced term in the last assistant message (case-insensitive)
  const termLower = referencedTerm.toLowerCase();
  const contentLower = lastAssistantContent.toLowerCase();
  const termIdx = contentLower.indexOf(termLower);

  // Term not found verbatim in the previous response — no enrichment. We deliberately do
  // NOT fall back to implicit-continuation here: an explicit "what's X?" for a term the
  // prior turn never mentioned is usually a NEW question, and injecting the old topic
  // would mislead the models (regression-guarded by the "what's Colossus?" test).
  if (termIdx === -1) return userMessage;

  // Extract surrounding context (up to 600 chars around the term)
  // Increased from 500 to 600 to capture more of the surrounding paragraph,
  // especially for table-like content where the term appears in a row with
  // associated data (e.g. "Teranet Victoria" in a cost comparison table).
  const contextRadius = 600;
  const contextStart = Math.max(0, termIdx - contextRadius);
  const contextEnd = Math.min(lastAssistantContent.length, termIdx + referencedTerm.length + contextRadius);
  let surroundingContext = lastAssistantContent.substring(contextStart, contextEnd).trim();

  // Clean up: try to start/end at sentence boundaries
  if (contextStart > 0) {
    const sentenceStart = surroundingContext.indexOf('. ');
    if (sentenceStart !== -1 && sentenceStart < 100) {
      surroundingContext = surroundingContext.substring(sentenceStart + 2);
    }
  }
  if (contextEnd < lastAssistantContent.length) {
    const lastPeriod = surroundingContext.lastIndexOf('. ');
    if (lastPeriod !== -1 && lastPeriod > surroundingContext.length - 150) {
      surroundingContext = surroundingContext.substring(0, lastPeriod + 1);
    }
  }

  // Build enriched message with context from the previous response.
  // The enrichment is injected INLINE in the user message (not just systemContext)
  // so that all 3 models AND the synthesizer see it as part of the question itself.
  // This is critical because models often ignore systemContext blocks when the user
  // message is a simple factual question they can answer from training data.
  // (Fix v187: models answered "what's Teranet?" from training data instead of
  // conversation context because the reference was only in systemContext)
  const enrichedMessage = `${userMessage}\n\n═══ CONVERSATION CONTEXT (from my previous response) ═══\nIn my previous response in this conversation, I mentioned "${referencedTerm}" in this context:\n"${surroundingContext.substring(0, 800)}"\n═══ END CONVERSATION CONTEXT ═══\n\nIMPORTANT: The user is asking about "${referencedTerm}" AS IT WAS USED in the previous response above. Answer about "${referencedTerm}" in THAT specific context. Do NOT answer about a different/unrelated entity that happens to share the same name. The conversation context above is the ground truth for what "${referencedTerm}" means in this conversation.`;

  onEnrich?.({ kind: 'explicit', term: referencedTerm, contextLen: surroundingContext.length, msg: userMessage.substring(0, 60) });

  return enrichedMessage;
}

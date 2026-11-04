/**
 * Draft-integrity annotation for the L2 [CROSS-CHECK DRAFTS] injection —
 * ticket 31738d9a (mishap, 2026-09-17).
 *
 * Incident: during the 2026-09-17 ~17:59Z Fleet Supervisor ensemble turn, the
 * injected kimi-k3 cross-checker draft asserted AS FACT that a spark-cluster
 * arena benchmark was "banked: 26/27 cells win", citing "msg 8a7957b6" (an id
 * absent from the orchestrator's evidence ledger) and "confirming" ticket
 * 3af26f08 resolved — under a headline clock of "2:25 PM EDT (18:25Z)", ~26
 * minutes in the FUTURE of the live harness clock 2026-09-17T17:59:06Z. Fresh
 * same-turn tool evidence showed the benchmark still mid-flight. Had the
 * orchestrator adopted the draft, the owner would have been told a multi-hour
 * benchmark was complete and won while it was still running.
 *
 * Three defect classes, three layers (the action-claim strip of 0cbfa36e and
 * the artifact-grounding rule of ce9ee48d already cover their own classes):
 *
 *  1. FUTURE CLOCK — a projected/estimated time written as an observation
 *     time. Deterministic: a draft stating a clock reading LATER than the
 *     live harness clock is self-refuting. Detection reuses the action
 *     verifier's findFutureObservedTimestamps (same parser that convicts the
 *     supervisor-note class — tolerance, future-intent and tool-provenance
 *     exemptions included); the service passes the draft's OWN tool-result
 *     texts as evidence haystacks so an honestly quoted future reading from
 *     the lane's web results is not flagged (ticket a688ba29 discipline).
 *     The remedy is ANNOTATION, not stripping: the ticket's remedy is
 *     "flagging/annotating future-clock drafts before injection" — the draft
 *     text survives, preceded by the banner this module composes.
 *
 *  2. PHANTOM ARTIFACT IDS — a labeled fleet id ("msg 8a7957b6", "ticket
 *     3af26f08", "oq_…") cited as a receipt while appearing NOWHERE in the
 *     lane's provided context (its user message, conversation history, system
 *     context, or its own tool results). The lane could not have READ it, so
 *     it is confabulated by construction — the deterministic complement to
 *     ce9ee48d's prompt-side grounding rule. findPhantomDraftIds returns the
 *     mentions absent from the corpus; the banner names them UNVERIFIED.
 *     (An id the lane genuinely scraped from the web appears in its tool
 *     texts and is NOT flagged; the header's artifact clause still tells the
 *     orchestrator such citations are not its evidence. Accepted residual: a
 *     confabulated id that coincidentally appears in a large tool text is not
 *     flagged — the banner is an annotation, not a conviction.)
 *
 *  3. STATE CLAIMS — "the benchmark is won", "the ticket is resolved": a lane
 *     with web + retrieval tools ONLY can never freshly verify fleet/platform
 *     state. Not deterministically strippable (relaying PAYLOAD state is the
 *     lane's job on supervisor turns), so this class is covered prompt-side
 *     (crossCheckLaneClockNote's provenance discipline in cross-check-scope.ts)
 *     and header-side (the STATE CLAIMS clause in crossCheckDraftsHeader).
 *
 * Kept in a leaf module (no imports) so it is unit-testable without pulling in
 * the chat-agent service's import graph — the cross-check-scope.ts /
 * cross-check-action-claims.ts pattern. The future-clock detection itself is
 * dependency-INJECTED (the service calls findFutureObservedTimestamps via its
 * established dynamic import of action-verifier) to keep this leaf light.
 */

/**
 * A labeled fleet-id mention in prose: "msg 8a7957b6", "ticket 3af26f08",
 * "ticket #18086326", "oq_77255d6a". LABELED shapes only — a bare 8-hex token
 * could be a commit sha or any web content; the labels are how drafts cite
 * fleet receipts. The capture group is the bare id (used for the corpus
 * presence check); the full match (label included) is what the banner names.
 */
const LABELED_ID_RE = /\b(?:msg\s+#?|message\s+#?|ticket\s+#?|oq_)([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4})\b/gi;

/**
 * Find labeled fleet-id mentions in a draft that appear NOWHERE in the given
 * corpus (the lane's provided context + its tool results). Matching is on the
 * bare id, case-insensitive; the returned strings are the full mentions as
 * written ("msg 8a7957b6"), deduped, capped at 6 so a pathological draft
 * cannot blow up the banner.
 */
export function findPhantomDraftIds(text: string, corpus: string): string[] {
  if (!text) return [];
  const hay = (corpus || '').toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  LABELED_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABELED_ID_RE.exec(text)) && out.length < 6) {
    const bare = m[1].toLowerCase();
    if (hay.includes(bare)) continue; // genuinely quotable — the lane READ it
    const mention = m[0].trim();
    const key = mention.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mention);
  }
  return out;
}

/**
 * Compose the per-draft [INTEGRITY FLAGS] banner prepended (by the service)
 * inside a [CROSS-CHECK DRAFTS] block when the deterministic checks fire.
 * Returns '' when there is nothing to flag — a clean draft is injected
 * byte-identical (the 0cbfa36e F1 guarantee, extended).
 *
 * `futureClocks` is the (possibly empty) output of the action verifier's
 * findFutureObservedTimestamps for this draft; `phantomIds` is the output of
 * findPhantomDraftIds. Both classes tell the orchestrator the same thing:
 * the flagged line is REFUTED-BY-CONSTRUCTION unless its own tools confirm it.
 */
export function crossCheckDraftIntegrityBanner(opts: {
  futureClocks: Array<{ token: string; minutesAhead: number }>;
  phantomIds: string[];
}): string {
  const parts: string[] = [];
  if (opts.futureClocks.length) {
    const clocks = opts.futureClocks
      .slice(0, 4)
      .map(c => `"${c.token}" (+${c.minutesAhead} min)`)
      .join(', ');
    parts.push(
      `this draft states clock time(s) LATER than the live harness clock — ${clocks} — a projected or estimated time presented as an observation; every claim it time-stamps is UNVERIFIED, not observed fact`,
    );
  }
  if (opts.phantomIds.length) {
    parts.push(
      `it cites id(s) NOT present anywhere in the check lane's provided context — ${opts.phantomIds.join(', ')} — the lane could not have read them, so as receipts they are confabulated`,
    );
  }
  if (!parts.length) return '';
  return (
    `[INTEGRITY FLAGS — harness-stamped at injection (ticket 31738d9a): ${parts.join('; ')}. ` +
    `Treat the flagged lines as refuted-by-construction unless YOUR OWN tools this run confirm them.]`
  );
}

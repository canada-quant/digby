/**
 * Action-claim defense for the L2 [CROSS-CHECK DRAFTS] injection — ticket
 * 0cbfa36e (mishap, 2026-09-15).
 *
 * Incident: during a Fleet Supervisor wake triggered by a peer supervisor's
 * agent-sent delta (messageOrigin 'agent' — machineWake is NOT set on that
 * path, so the L2 cross-checker runs), the kimi-k3 draft carried an
 * "ACTIONS TAKEN" section claiming it had sent two lane steers with realistic
 * receipt ids ("receipt msg 4e34bf2d", "receipt msg e591e73d"). Fresh
 * get_chat_messages pulls of both claimed target chats showed NO such
 * messages — both receipts were confabulated. The draft is injected into the
 * orchestrator's context with "adopt what they got right", so a phantom
 * action claim risks being folded into the durable wake note and acted on —
 * the phantom-dispatch failure class arriving via the ensemble channel.
 *
 * The invariant that makes this deterministic: a cross_checker-role lane has
 * NO fleet/platform/action tools at all (roles.ts grants WEB + RETRIEVE +
 * INTEGRATIONS + file_feedback, all read-only; workers never get platform
 * tools). Therefore ANY claim in a draft that the lane itself performed an
 * action — sent messages/steers, filed tickets, dispatched work, updated
 * state — is confabulated BY CONSTRUCTION, and the harness may strip it
 * without losing real information.
 *
 * Two layers live here (the doctrine-side "never claim actions" rule rides in
 * cross-check-scope.ts's lane note):
 *
 *  1. stripCrossCheckActionClaims — removes heading-anchored action-claim
 *     sections ("ACTIONS TAKEN", "STEPS TAKEN", "MESSAGES SENT", …) from a
 *     draft BEFORE injection. Deliberately conservative: only PAST-TENSE /
 *     COMPLETED-action titles match — "RECOMMENDED ACTIONS" / "NEXT
 *     ACTIONS" / "ACTION ITEMS" are proposals (legitimate analysis) and are
 *     kept. Inline claims that survive are covered by layer 2.
 *
 *  2. crossCheckDraftsHeader — the injected block header now states that
 *     action claims in a draft are NEVER adoptable: the lanes have no action
 *     tools, so such claims and their receipt/message ids are unverified and
 *     almost certainly confabulated; the only real actions are the main
 *     lane's own tool calls, proven by their receipts.
 *
 * Kept in a leaf module (no imports) so it is unit-testable without pulling in
 * the chat-agent service's import graph — the cross-check-scope.ts /
 * machine-wake.ts pattern.
 */

/**
 * A heading line whose ENTIRE content is a completed-action title. Optional
 * markdown ATX prefix (## …) and/or bold wrapper (**…**), optional trailing
 * colon. Past-tense vocabulary ONLY — proposal headings (recommended/next
 * actions, action items) must NOT match.
 */
const ACTION_HEADING = new RegExp(
  '^\\s{0,3}(?:#{1,6}\\s+)?(?:\\*\\*|__)?\\s*(?:' +
    '(?:summary\\s+of\\s+)?(?:actions?|steps)\\s+(?:taken|performed|executed|completed|done)|' +
    "what\\s+i(?:'ve|\\s+have)?\\s+(?:did|done|sent|dispatched|filed)|" +
    '(?:messages?|steers?|nudges?|dispatches?|notifications?|reminders|wake-?ups)\\s+(?:sent|dispatched|posted|made)|' +
    'tickets?\\s+(?:filed|created|opened)' +
  ')\\s*(?:\\*\\*|__)?\\s*:?\\s*$',
  'i',
);

/** A bullet/numbered list row — part of whatever section contains it. */
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,2}[.)])\s+\S/;

/**
 * A line that opens a NEW section, ending an in-progress strip: ATX heading,
 * horizontal rule, bold pseudo-heading (entire line is bold), or an ALL-CAPS
 * title line.
 */
function isSectionBoundary(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^#{1,6}\s+\S/.test(t)) return true; // ATX heading
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) return true; // horizontal rule
  if (/^(?:\*\*|__).{1,80}(?:\*\*|__):?$/.test(t)) return true; // bold pseudo-heading
  if (/^[A-Z0-9][A-Z0-9 ,&/()'’\-–—:]{2,79}:?$/.test(t) && /[A-Z]{3}/.test(t)) return true; // ALL-CAPS title
  return false;
}

/**
 * Remove heading-anchored action-claim sections from a cross-check draft.
 * Returns the cleaned text and how many sections were removed (0 = draft
 * unchanged modulo nothing — the original string is returned verbatim).
 *
 * Strip semantics: the claimed-action section runs from its heading until the
 * next section boundary (kept) or a plain paragraph following a blank line
 * (kept — analysis resumes); list rows and blank lines never end it. This
 * errs toward removing confabulated claims while preserving the critique the
 * checker exists for (ticket f08fcd6f).
 */
export function stripCrossCheckActionClaims(text: string): { text: string; stripped: number } {
  if (!text) return { text, stripped: 0 };
  const lines = text.split('\n');
  const out: string[] = [];
  let stripping = false;
  let sawBlank = false;
  let inFence = false;
  let stripped = 0;
  for (const line of lines) {
    // Fenced code blocks pass through verbatim: an example log/template inside
    // a ``` fence may legitimately contain action-heading vocabulary. The
    // toggle is suspended while stripping (adversarial review M1): a fence
    // opener inside a dropped section must NOT flip inFence — that would wedge
    // the state machine and drop the remainder of the draft's real analysis.
    if (/^\s*```/.test(line)) {
      if (!stripping) { inFence = !inFence; out.push(line); }
      continue;
    }
    if (inFence) {
      if (!stripping) out.push(line);
      continue;
    }
    if (ACTION_HEADING.test(line)) {
      stripping = true;
      sawBlank = false;
      stripped++;
      continue;
    }
    if (stripping) {
      const t = line.trim();
      if (!t) { sawBlank = true; continue; } // in-section blanks are dropped
      if (isSectionBoundary(line)) {
        stripping = false;
        if (out.length && out[out.length - 1].trim() !== '') out.push('');
        out.push(line);
        continue;
      }
      if (sawBlank && !LIST_ITEM.test(line)) {
        // A plain paragraph after a blank line: analysis has resumed — keep it.
        stripping = false;
        out.push('');
        out.push(line);
        continue;
      }
      continue; // claimed-action content — dropped
    }
    out.push(line);
  }
  // Clean-draft guarantee (adversarial review F1): a draft with NOTHING
  // stripped is returned BYTE-IDENTICAL — the blank-collapse/trim hygiene pass
  // only runs on text that actually lost a section.
  if (!stripped) return { text, stripped: 0 };
  const cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, stripped };
}

/**
 * The [CROSS-CHECK DRAFTS] block header injected into the orchestrator. The
 * first sentence is deliberately unchanged (ensemble reconcile contract); the
 * appended clauses are two never-trust framings:
 *  - ticket 0cbfa36e: action claims are NEVER adoptable — the lanes have no
 *    action tools, so such claims and their receipt/message ids are
 *    unverified and almost certainly confabulated; the only real actions are
 *    the main lane's own tool calls, proven by their receipts.
 *  - ticket ce9ee48d: artifact citations are NOT the orchestrator's evidence —
 *    the draft's tools and context are not the main lane's, so an artifact
 *    (block, recap, message, log, command output) a draft quotes or
 *    attributes but the main lane cannot see in ITS context is UNVERIFIED
 *    until confirmed against the main lane's own tool evidence. This is the
 *    FALSE-but-plausibly-sourced class: real fragments woven into a phantom
 *    artifact (contrast 0cbfa36e's true-but-unverifiable-by-design class).
 *  - ticket 31738d9a: STATE claims are never freshly verified by the lane —
 *    "the benchmark is won", "the ticket is resolved", "the lane is alive"
 *    read as authoritative, but the lane has no tools to probe fleet/platform
 *    state, so they are payload-derived at best and must be re-probed by the
 *    main lane. The clause also names the deterministic [INTEGRITY FLAGS]
 *    banner (cross-check-draft-integrity.ts) so the orchestrator trusts it.
 *  - ticket cbe682c0: CAPABILITY NEGATIONS are never adoptable — a lane that
 *    cannot see the platform tool surface (its role grant is web + retrieval
 *    only) is structurally incapable of proving "Digby has no way to X", yet
 *    that was exactly the confabulated shape that reached a user: asked to
 *    stop another chat's run, the ensemble answer said "no supported path"
 *    while the main lane's own stop_run tool existed and was deployed. A
 *    draft's "not supported"/"no path exists" about a Digby capability is the
 *    lane's reduced toolset mistaken for the platform's — discard it and
 *    settle the question against YOUR OWN tool surface.
 */
export function crossCheckDraftsHeader(count: number, opts: { webSearchConfigured?: boolean } = {}): string {
  // Self-host setup hardening (2026-10-20): on an instance with no search backend the drafts were not web-grounded.
  const how = opts.webSearchConfigured === false
    ? 'answered the same question from their own knowledge (this instance has no live web search)'
    : 'researched and answered the same question with their own live web tools';
  return `[CROSS-CHECK DRAFTS — ${count} independent model(s) ${how}. Verify against them: adopt what they got right, correct what they got wrong, and note real disagreements honestly. ACTION CLAIMS IN A DRAFT ARE NEVER ADOPTABLE: these lanes have NO fleet/platform/action tools (no messaging, dispatch, schedule, ticket, or supervisor-state tools — they can only read and analyze), so any draft claim that the lane ITSELF performed an action (sent a message/steer, filed a ticket, dispatched work, updated state) and any receipt or message id it cites as its own is UNVERIFIED and almost certainly confabulated — never record, repeat, or act on it. The only actions that exist are YOUR OWN tool calls this run, proven by their tool receipts. ARTIFACT CITATIONS IN A DRAFT ARE NOT YOUR EVIDENCE: the draft's tools and context are NOT yours — if a draft quotes or attributes an artifact you cannot see in YOUR context (a block, recap, message, log, or command output), treat that citation as UNVERIFIED and confirm it against your own tool evidence before repeating, recording, or acting on it. STATE CLAIMS IN A DRAFT ARE NEVER FRESHLY VERIFIED: the lane has no tools to probe fleet or platform state, so a draft saying something IS true right now (a benchmark won, a job finished, a ticket resolved, a lane alive) is payload-derived at best and possibly confabulated — re-probe it with YOUR OWN tools before adopting, repeating, or recording it. CAPABILITY NEGATIONS IN A DRAFT ARE NEVER ADOPTABLE (ticket cbe682c0): a draft CANNOT see the platform tool surface (its lane is web + retrieval only), so when it asserts Digby "has no way to" do something platform-side (stop another chat's run, cancel or pause a schedule, message another lane, change a setting), that is its reduced toolset mistaken for the platform's — the answer was wrong the day it shipped (stop_run existed and was deployed). Settle every capability question against YOUR OWN tool surface, never a draft's negation or its web-search "documentation". A draft may carry a harness-stamped [INTEGRITY FLAGS] banner: its flags are deterministic (a stated clock LATER than the live harness clock; a cited id absent from the lane's own context) — treat every flagged line as refuted-by-construction unless YOUR tools confirm it.]`;
}

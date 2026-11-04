/**
 * OWNER-CARD PAYLOAD-GAP ADMISSION (leaf, pure — no prisma/env imports).
 *
 * Extracted from owner-questions.ts (ticket 65cfec1b, 2026-10-18) so the
 * framework-signal sweep's read-time detector (framework-signal-detectors.ts
 * findIncompleteCards) can apply the SAME admission the platform applies at
 * WRITE time when a run flags a card — one definition of "complete", two
 * enforcement points. owner-questions.ts statically pulls config/database →
 * config/env (process.exit on missing env), so importing it from the pure
 * detector module would poison every jest graph that reaches the sweep; this
 * leaf is the shared seam (the credential-gate.ts / owner-question-secrets.ts
 * pattern).
 */

export interface OwnerCardGapInput {
  question: string;
  context?: string | null;
  options?: unknown;
  consoleAction?: boolean;
  /** Ticket 90a5b127 (the STRUCTURAL half — the durable fix for the
   *  wording-chase recurrence, finding 2.1): the flagger's own typed
   *  declaration that the ask is OPTIONAL. `true` completes the options axis
   *  by declaration; `false` declares it NOT optional and suppresses the
   *  prose optionality legs below (typed options / a yes_no declaration
   *  still complete — those are structure, not wording); null/undefined =
   *  not declared, the prose legs apply as a best-effort fallback. */
  optionalAsk?: boolean | null;
  /** Todo 77c88942's declared answer type ('choice' | 'yes_no' |
   *  'credential:<ENVKEY>' | 'free'/null). 'yes_no' completes the options
   *  axis (a ruling ask declares its own two-outcome decision space);
   *  'choice' needs the typed options (already covered by the options leg —
   *  a choice declaration WITHOUT options adds nothing to choose from);
   *  'credential:' and 'free' do NOT complete it (a credential ask is a
   *  single urgent action, not a choice — ticket 90a5b127 findings 1.1/1.2
   *  are exactly credential asks that must stay gapped). */
  expectedAnswerType?: string | null;
}

/** The imperative verbs a card's ask clause can carry — what the owner is
 *  told to DO. An optionality cue completes the options axis when it is
 *  attached to one of these (governs the ask), not when it modifies some
 *  other verb ("feel free to IGNORE this" — ticket 90a5b127 finding 1.2).
 *  Review F1 (session 55bf415a): upload/share/submit/drop/provide/attach
 *  added — "no rush to upload the log", "at your convenience provide the
 *  api key" are ask-attached postures the first cut wrongly gapped. */
const ASK_VERBS =
  /\b(paste|restart|reply|respond|approve|save|click|send|enter|type|confirm|acknowledge|check|verify|restore|apply|run|press|tap|select|choose|pick|toggle|flip|dismiss|grant|rotate|revoke|upload|share|submit|drop|provide|attach)\b/;

/** Optionality POSTURE wording (cue list). Scoped per-clause since 90a5b127:
 *  "if you want <outcome>" conditionals are NOT in this list — a condition
 *  the ask depends on ("if you want the fix to work, paste the env file") is
 *  urgency, not optionality (finding 1.2). */
const POSTURE_CUE =
  /\b(no rush|no hurry|not urgent|no urgency|no deadline|no need|no obligation|feel free|up to you|your call|your choice|your decision|at your convenience|at your leisure|at your discretion|whenever you'?re ready|whenever you are ready|whenever (?:is|it'?s) convenient|when (?:is|it'?s) convenient|when convenient|when ready|whenever you (?:like|want|prefer|have time)|if you (?:can|like|prefer|have time|wish)|if you(?:'d| would) like)\b/;

/** Complements after a posture cue in a posture-only clause. Review F1
 *  (session 55bf415a): the first cut's whitelist was too narrow —
 *  sentence-final "No rush." / "No rush!", prepositional tails ("no rush on
 *  this one") and time tails ("for now", "today", "this week") wrongly
 *  gapped optional asks the pre-90a5b127 leaf completed, and the sweep
 *  filed real tickets on them. The tail now completes UNLESS it names a
 *  DIFFERENT action: a "to <verb>" tail completes only for ask verbs
 *  ("feel free to paste it" vs "no need to worry", "feel free to ignore
 *  this" — ticket 90a5b127 finding 1.2), and a foreign-action verb anywhere
 *  in the tail rejects. */
const TAIL_PUNCTUATION_ONLY = /^[.,!?;:—–-]*$/;
const TAIL_ASK_REFERRING = /^\s*(?:otherwise|either|at all)\b/;
const TAIL_TO_ASK = /^\s*to\s+([a-z]+)/;
const TAIL_FOR_OBJECT = /^\s*(?:for|on|in|about)\s+(?:the|that|this|any|it|a|an)\b/;
const TAIL_TIME = /^\s*(?:for\s+)?(?:now|later|today|tonight|tomorrow|this (?:week|month|weekend)|whenever)\b/;
const TAIL_WHETHER = /^\s*(?:whether|if)\b/;
const FOREIGN_ACTION_VERBS = /\b(worry|bother|ignore|hesitate|stress|fret|panic|fuss|alarm|apologize)\b/;

/** Ticket 8f5989c7: a card's own SCOPE statement — the flagger enumerating
 *  the entire ask and declaring nothing beyond it ("Nothing else is needed
 *  from you", "that's all", "One thing only you can supply"). This is
 *  STRUCTURE about the decision space, not optionality wording: an urgent
 *  single-action credential ask with a scope statement has an EMPTY
 *  decision space — there is nothing to choose between, so the options
 *  axis is complete by the card's own declaration. Specimen
 *  oq_81ce2c39 (live row, prod probe 2026-10-23, deployed admission
 *  verdict ["options"]): a 792-char self-contained [cql-agx-orin64]
 *  credential ask — background (Hue power cycle worked, box rebooted
 *  03:58Z, memory leak uncontained, froze twice), the measured blocker
 *  ("sudo: a password is required" 01:00Z and 04:03Z), the exact move
 *  (paste into the card's credential field → encrypted vault → the lane
 *  applies the containment cap over SSH, verifies, rolls back safely) and
 *  the closing scope statement "Nothing else is needed from you." —
 *  superseded by its own lane 52 min after filing. Sixth FP in the family
 *  (84b11946 → 65cfec1b → cea10fa4 → 90a5b127 → a3a7dd88 → here), every
 *  one a vocabulary-chase class; 7-day census at fix time: 123 cards,
 *  exactly 1 flagged by the deployed detector = this specimen; zero true
 *  positives in the family's wild history. Suppressed by optionalAsk ===
 *  false like every prose leg — a flagger who typed "NOT optional" beats
 *  the wording (the 90a5b127 typed-beats-prose rule).
 *
 *  Review (2026-10-23, blocking findings): the first cut tested the cue
 *  against the WHOLE text, re-opening the exact hole 90a5b127 closed for
 *  optionality — a cue phrase in a clause that re-scopes it to HISTORY or
 *  a FOREIGN ACTOR is not a scope declaration ("that's all I could do",
 *  "no further action was taken", "nothing else was needed before the
 *  upgrade" describe what already happened, not the ask's extent). The cue
 *  is therefore judged CLAUSE-SCOPED with tail guards, the same shape as
 *  postureCompletes below.
 *
 *  Cross-review round 2 (2026-10-23, self-audit): clause-scoping alone is
 *  not ASK-scoping — one scope clause must not silence a card that goes on
 *  to ask something further. "No further action is needed on the deploy,
 *  BUT the S3 key is still missing — paste it below" and "Nothing else is
 *  needed from you for the deploy. Now paste the S3 key below." are
 *  genuinely incomplete cards the clause-scoped cut suppressed (measured
 *  on the merged leaf). A scope statement completes only when it CLOSES
 *  the ask: nothing owed remains, the cue is not scoped to one object
 *  while a further ask follows, and no contrastive marker governs a
 *  follow-up ask. "One thing only you can supply: the sudo password.
 *  Paste it below." still completes — the following ask elaborates the
 *  SAME enumerated ask, with no owed state, object restriction or
 *  contrastive between them. Present-tense cues only ("nothing else WAS
 *  needed" is history); conditional-lead clauses never declare. */
const ASK_SCOPE_COMPLETE =
  /\b(?:nothing (?:else|more) (?:is )?(?:needed|required|due|outstanding|pending)|nothing (?:else|more) from you|that'?s (?:all|everything)|that is (?:all|everything)|all (?:i|we) need|no (?:other|further) action|one thing only|the only (?:ask|request))\b/;

/** A tail after the scope cue that re-scopes the clause to HISTORY — an
 *  action participle, a past/limitation state or a past-time qualifier.
 *  "no further action WAS TAKEN" (what the lane did not do last night) vs
 *  "nothing else IS NEEDED from you" (the ask's extent). */
const SCOPE_TAIL_HISTORY =
  /\b(?:taken|done|tried|attempted|made|found|observed|seen|logged|recorded|sent|applied|possible|available|was|were|been|before|at the time|previously|earlier|back then)\b/;

/** A tail after the scope cue naming a FOREIGN ACTOR + past/modal verb —
 *  "that's all I could do", "that's everything we tried". The specimen's
 *  own "one thing only YOU CAN SUPPLY" must survive: 'can' is deliberately
 *  NOT in the modal list. */
const SCOPE_TAIL_FOREIGN_ACTOR =
  /\b(?:i|we|they|he|she|the lane|anyone|nobody)\s+(?:could|did|do|have|had|should|would|tried|managed|know|knew|saw|found)\b/;

/** A CONDITIONAL-lead clause is not a declaration ("if nothing else is
 *  needed ignore this") — the 90a5b127 finding-1.2 exclusion applied to
 *  scope cues. */
const SCOPE_CONDITIONAL_LEAD =
  /^(?:if|when|unless|whether|in case|assuming)\b/;

/** The cue clause scoped to ONE object ("no further action ON THE DEPLOY",
 *  "nothing else … FOR THE DEPLOY") — the statement is about that object,
 *  not the whole card. */
const SCOPE_OBJECT_RESTRICTED =
  /\b(?:on|for|about|regarding)\s+(?:the|that|this|a|an|pr\b|#)/;

/** The card itself asserting something is STILL OWED — the opposite of a
 *  closed scope ("the S3 key is still missing", "two keys are still owed").
 *  The verb complement is REQUIRED after "remains" (a bare "remains" would
 *  match everyday narration like "the box remains healthy"). */
const SCOPE_OWED_STATE =
  /\b(?:still (?:missing|owed|needed|outstanding|due|dark|failing|red)|remains? (?:to be done|owed|missing|unpaid|open|blocked|unresolved|due|outstanding)|are still owed|is still owed)\b/;

/** Actor-narration in the clause immediately after the cue ("that is all |
 *  we know") — the lane's own limits, not the ask's extent. Checked on the
 *  IMMEDIATE next clause only: background narration elsewhere in the card
 *  ("the lane tried to apply the fix itself…") commonly mentions the lane
 *  and must not void a genuine closure. */
const SCOPE_NEXT_CLAUSE_ACTOR =
  /\b(?:i|we|they|he|she|anyone|nobody|the lane)\s+(?:know|knew|saw|see|found|did|do|have|had|could|tried|managed)\b/;

/** Does the card body complete the options axis via a SCOPE statement?
 *  Clause-scoped AND ask-scoped (review 2026-10-23, rounds 1+2): the cue
 *  must govern the ask's extent in its own clause (not history, not a
 *  foreign actor's narration, not a conditional, not a question) AND it
 *  must CLOSE the ask — no owed state after it, and a further ask only
 *  when it elaborates the same enumerated ask (no object restriction on
 *  the cue, no contrastive marker governing the follow-up). */
function scopeCompletes(question: string, context: string | null | undefined): boolean {
  const text = `${question}\n${String(context ?? '')}`.toLowerCase();
  const sentences = splitSentences(text);
  for (let s = 0; s < sentences.length; s++) {
    // A question sentence is the ask itself, never a scope declaration.
    if (sentences[s].question) continue;
    const clauses = splitClauses(sentences[s].text);
    for (let c = 0; c < clauses.length; c++) {
      const clause = clauses[c];
      // An interrogative-lead clause ("is that all you need?") is the ask.
      if (INTERROGATIVE_LEAD.test(clause)) continue;
      // A conditional-lead clause ("if nothing else is needed…") never
      // declares scope.
      if (SCOPE_CONDITIONAL_LEAD.test(clause)) continue;
      const m = ASK_SCOPE_COMPLETE.exec(clause);
      if (!m) continue;
      const rest = clause.slice(m.index + m[0].length);
      if (SCOPE_TAIL_HISTORY.test(rest)) continue;
      if (SCOPE_TAIL_FOREIGN_ACTOR.test(rest)) continue;
      // Actor narration in the immediately following clause ("that is all
      // | we know") re-scopes the cue to the lane's limits.
      if (SCOPE_NEXT_CLAUSE_ACTOR.test(clauses[c + 1] ?? '')) continue;
      // ASK-SCOPING: the statement must close the ask. Anything still owed
      // after it voids the closure.
      const remainder = [
        ...clauses.slice(c + 1),
        ...sentences.slice(s + 1).map((x) => x.text),
      ].join(' ');
      if (SCOPE_OWED_STATE.test(remainder)) continue;
      const askFollows = wordIndex(remainder, ASK_VERBS) !== -1;
      if (!askFollows) return true;
      // A further ask elaborates the SAME enumerated ask only when the cue
      // was not scoped to one object — an object-restricted cue ("no
      // further action on the deploy") closes nothing outside that object.
      if (SCOPE_OBJECT_RESTRICTED.test(clause)) continue;
      return true;
    }
  }
  return false;
}

/** The stated decline path — "the core service is fully live without them".
 *  A NEGATED dependence ("the box cannot work without the key") asserts
 *  urgency, not optionality. Since 90a5b127 (finding 1.1) the negation guard
 *  covers the WHOLE span that governs the cue — not just wording immediately
 *  adjacent to it: "the deploy will not be fine without the api key",
 *  "the fleet never works without the credential", "the route no longer
 *  works without the key" are all urgent asks. Review F2 (session 55bf415a)
 *  narrowed the span's far edge: a negation in a COORDINATED TAIL after the
 *  cue ("…fully live without them AND HAS NO ERRORS", "…works without the
 *  token AND CANNOT LOSE DATA") governs a different verb, not the decline
 *  path — clause-global voiding wrongly gapped those true decline paths. */
const DECLINE_PATH_CUE = /\b(fine|works?|fully live|fully functional|fully operational) without\b/;
/** Negation before/inside the cued state voids the decline-path cue —
 *  not/never/no (incl. "no longer")/cannot/can't/won't/…-n't. Review
 *  amendment F2 (session 55bf415a, msg 3c8e4ebe): the contraction branch
 *  REQUIRES the apostrophe (`n['’]t`, ASCII or curly) — the earlier
 *  optional-apostrophe shape `[a-z]+n'?t` matched EVERYDAY words ending in
 *  "nt" (current/account/client/front/tenant/important/agent — even
 *  "incident", a word in this detector's own backgroundCues list) and
 *  false-gapped true decline paths like "the current lane is fully live
 *  without them" — a fresh generator of the exact FP family this ticket
 *  exists to end. Cross-review finding 1 (2026-10-20) closed the hole that
 *  shape left: an UN-APOSTROPHED contraction ("the box isnt fine without
 *  the key") is caught by an explicit WHOLE-WORD list instead — the list is
 *  closed and none of its members is an everyday word, so the "nt" class
 *  cannot return through it. */
const CLAUSE_NEGATION =
  /\b(?:not|never|no|cannot|can'?t|won'?t|[a-z]+n['’]t|isnt|arent|wasnt|werent|doesnt|dont|didnt|hasnt|havent|hadnt|couldnt|wouldnt|shouldnt|mustnt|neednt|aint)\b/;

/** True decline path: the cue fires and no negation governs the cued state
 *  (the span from the clause start through the cue phrase). */
function declinePathCompletes(clause: string): boolean {
  const m = DECLINE_PATH_CUE.exec(clause);
  if (!m) return false;
  return !CLAUSE_NEGATION.test(clause.slice(0, m.index + m[0].length));
}

/** A sentence that asks a question is the ask itself, not a decision space
 *  or a decline path ("does the app work without the key?" — finding 1.1). */
const SENTENCE_QUESTION = /\?\s*$/;

function splitSentences(text: string): Array<{ text: string; question: boolean }> {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => ({ text: s, question: SENTENCE_QUESTION.test(s) }))
    .filter((s) => s.text.trim().length > 0);
}

function splitClauses(sentence: string): string[] {
  return sentence
    // A spaced hyphen (" - "), em/en-dash or a line break separates clauses
    // the same way a comma does ("no need to worry - paste the key NOW" is
    // TWO clauses — ticket 90a5b127 finding 1.2); an intra-word hyphen
    // ("re-verify") has no spaces and never splits.
    .split(/[\n;:,]+|\s*[—–]\s*|\s+-\s+/)
    .map((c) => c.trim().replace(/^[-•*]\s*/, ''))
    .filter(Boolean);
}

/** An INTERROGATIVE-LEAD clause is a question, not a statement — it is the
 *  ask itself, with or without a terminal "?" ("does the app work without
 *  the key - paste it" — cross-review finding 3, 2026-10-20; the ticket's
 *  own 1.1 specimen carried the "?", this is the same shape without it).
 *  A clause starting with a bare auxiliary is interrogative in card prose;
 *  statement fragments always lead with their subject ("the route was fine
 *  without the key"). */
const INTERROGATIVE_LEAD =
  /^(?:do|does|did|is|are|was|were|will|would|can|could|should|shall|may|might|must|has|have|had)\b/;

/** First-word-index of a regex's match in the clause, or -1. */
function wordIndex(clause: string, re: RegExp): number {
  const m = re.exec(clause);
  return m ? m.index : -1;
}

/** Does ONE clause carry an optionality posture that governs the ASK? */
function postureCompletes(clause: string): boolean {
  const c = clause.toLowerCase();
  const m = POSTURE_CUE.exec(c);
  if (!m) return false;
  // Ask-attached: the clause tells the owner to do something AND carries the
  // posture — "restart the box at your discretion", "paste the output
  // whenever you're ready" (finding 2.1: these are genuinely optional asks
  // the old wording-chased list missed). A foreign-action verb in the SAME
  // clause as the ask verb does not change that the ask is governed — but
  // only when the ask comes FIRST: a foreign-action verb EARLIER in the
  // clause means the cue governs THAT action and the ask hangs off a
  // contrastive connector ("no need to worry BUT paste the key now" —
  // cross-review finding 2, 2026-10-20; the comma/dash-separated shape is
  // already split into two clauses by splitClauses).
  const askAt = wordIndex(c, ASK_VERBS);
  const foreignAt = wordIndex(c, FOREIGN_ACTION_VERBS);
  if (askAt !== -1 && (foreignAt === -1 || askAt < foreignAt)) return true;
  // Posture-only clause: judge the TAIL as a whole (review F1) — it
  // completes unless it names a DIFFERENT action than the ask.
  const rest = c.slice(m.index + m[0].length);
  if (TAIL_PUNCTUATION_ONLY.test(rest)) return true; // "no rush", "No rush."
  if (TAIL_TIME.test(rest) || TAIL_ASK_REFERRING.test(rest)
    || TAIL_FOR_OBJECT.test(rest) || TAIL_WHETHER.test(rest)) return true;
  const toAsk = TAIL_TO_ASK.exec(rest);
  if (toAsk) return ASK_VERBS.test(toAsk[1]); // "feel free to paste it" vs "…to worry"
  // Any other tail: it completes only if it does not name a foreign action —
  // "no rush on this one" (on+NP handled above; bare NPs pass through here),
  // vs "no need to worry" / "feel free to ignore this" (finding 1.2).
  return !FOREIGN_ACTION_VERBS.test(rest);
}

/** Does the card body complete the options axis via PROSE? (The structural
 *  legs — typed options, consoleAction, optionalAsk, yes_no — are handled by
 *  the caller.) Clause-scoped since 90a5b127: each clause of each sentence
 *  is judged on its own, so wording that negates, questions or modifies
 *  something else can no longer complete an urgent ask's options axis. */
function proseCompletesOptions(question: string, context: string | null | undefined): boolean {
  const text = `${question}\n${String(context ?? '')}`.toLowerCase();
  for (const sentence of splitSentences(text)) {
    for (const clause of splitClauses(sentence.text)) {
      // A question sentence never completes the options axis — it IS the ask.
      if (sentence.question) continue;
      // An interrogative-lead CLAUSE is a question even without a terminal
      // "?" ("does the app work without the key - paste it" — cross-review
      // finding 3): it is the ask, not a decision space or decline path.
      if (INTERROGATIVE_LEAD.test(clause)) continue;
      // Decline path: the cue fires only when no negation governs the cued
      // state (finding 1.1 — "will not be fine without", "never works
      // without", "isn't going to work without", "no longer works without",
      // "the box ISNT fine without" (cross-review finding 1); review F2 — a
      // negated tail verb "and has no errors" does NOT void).
      if (declinePathCompletes(clause)) return true;
      // Optionality posture governing the ask (finding 1.2 scoping).
      if (postureCompletes(clause)) return true;
    }
  }
  return false;
}

/** Which payload elements the platform's own admission would rule MISSING on a flagged card. */
export function detectOwnerCardPayloadGaps(input: OwnerCardGapInput): string[] {
  if (input.consoleAction) return []; // composed four-element body — complete
  const text = `${String(input.question ?? '')}\n${String(input.context ?? '')}`.toLowerCase();
  const missing: string[] = [];
  // Background: what is happening / why now. The question alone often reads
  // as complete to its author — the gap detector looks for the surrounding
  // state (tried / blocked / held / since / stalled / blocked-on words, or a
  // context field).
  const backgroundCues = /\b(what|happening|context|background|tried|attempted|blocked|held|stalled|since|waiting|deploy|lane|run|ticket|todo|goal|budget|cost|spend|error|failed|incident|box|server|repo|pr|merge|ci)\b/;
  // Ticket a3a7dd88: STRUCTURE beats vocabulary on the background axis too —
  // the flagger's TYPED OPTIONS complete it by declaration. The 65cfec1b
  // cue-list asks "does the card talk about deploys/boxes/runs?" but a
  // structured decision ask carries its background in domain vocabulary the
  // list cannot enumerate (specimen oq_892c91ae: a 1163-char self-contained
  // [ctrl.example.com] choice card — "CanLaw is LIVE on r-0, tailnet-only",
  // Hyperstack IPs, zai legs — 4 typed options with consequences,
  // expectedAnswerType 'choice', context empty because the whole card rides
  // inline; the owner DISMISSED it 16 min after filing because the ruling
  // was made). A flagger who typed out N decision options has already
  // written the decision space — and per the 65cfec1b options-axis pin
  // (typed options complete THAT axis unconditionally), the two axes
  // complete together: a bare cue-word ask WITH typed options now reads
  // complete at both levels (the diff's own pin). The true-positive shape —
  // a bare "paste X" ask with NO typed options, no background cue, no
  // context — still gaps, and every replay conviction holds. Fifth FP in
  // the family (84b11946 → 65cfec1b → cea10fa4 → 90a5b127 → here), all
  // vocabulary-chase classes; this leg ends the background axis's chase the
  // way 90a5b127's typed-declaration legs ended the options axis's.
  const hasTypedOptions = Array.isArray(input.options as any) && (input.options as any[]).length > 0;
  if (!input.context && !backgroundCues.test(text) && !hasTypedOptions) missing.push('background');
  // ── Options axis, in order of authority ────────────────────────────────────
  // (0) STRUCTURE beats prose (ticket 90a5b127 finding 2.1 — the durable
  //     fix for the wording-chase recurrence): typed options, a consoleAction
  //     body, the flagger's optionalAsk declaration, or a yes_no answer-type
  //     declaration complete the axis by declaration, no wording needed.
  //     (hasTypedOptions is computed at the background axis above — the
  //     a3a7dd88 structural leg shares it.)
  const expectedType = typeof input.expectedAnswerType === 'string' ? input.expectedAnswerType.trim().toLowerCase() : '';
  if (hasTypedOptions) return missing;
  if (expectedType === 'yes_no') return missing;
  if (input.optionalAsk === true) return missing;
  // (1) Classic option wording, anywhere in the card (65cfec1b): a card that
  //     spells out its decision space — "retry or wait", "pick either fix",
  //     an options: heading — completes via that wording. Deliberately NOT
  //     clause-scoped: these are decision-space words (option/choice/either/
  //     or/recommend/…), and every prior conviction in the replay suite gaps
  //     with none of them present. The word "optional" itself matches the
  //     "option" prefix (pre-existing behavior, kept: "not optional" errs
  //     toward not-filing, the safe direction for an FP-suppression axis).
  const optionCues = /\b(option|choice|alternative|recommend|suggest|prefer|pick|choose|go with|either|or\b)/;
  if (optionCues.test(text)) return missing;
  // (2) PROSE optionality — clause-scoped since 90a5b127 (findings 1.1/1.2).
  //     Suppressed when the flagger DECLARED the ask not optional
  //     (optionalAsk:false): the typed declaration beats the wording.
  if (input.optionalAsk !== false && proseCompletesOptions(String(input.question ?? ''), input.context)) {
    return missing;
  }
  // (3) Ticket 8f5989c7: the card's own SCOPE statement — the flagger
  //     enumerated the entire ask and declared nothing beyond it. An
  //     enumerated ask has an EMPTY decision space: there is nothing to
  //     choose between, so the options axis is complete by the card's own
  //     declaration (structure, not optionality — "Nothing else is needed
  //     from you" is scope, and it completes an URGENT ask just as well as
  //     an optional one). Clause-scoped with history/foreign-actor tail
  //     guards (review 2026-10-23) — a cue inside a failed-attempt
  //     narration is not a scope declaration. Honors optionalAsk:false
  //     like every prose leg (typed beats prose).
  if (input.optionalAsk !== false && scopeCompletes(String(input.question ?? ''), input.context)) return missing;
  missing.push('options');
  return missing;
}

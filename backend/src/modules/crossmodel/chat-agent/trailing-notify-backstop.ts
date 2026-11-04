/**
 * trailing-notify-backstop.ts — ticket 8aa5688f (2026-10-26).
 *
 * A scheduled (cron-fired) run in a PLAIN chat whose stored prompt mandates a
 * trailing notify_user ("post the digest, THEN call notify_user with a 1-3
 * line Telegram summary") could exhaust its tool-round budget on the data
 * pull (chatProfile('thinking') is 8 steps; agent.ts omits tools entirely on
 * the final step) and reach the tools-off FINAL TURN structurally unable to
 * execute the mandate — the failure was visible only in the run's own final
 * text ("notify_user could not be called — no tool access"), never to the
 * platform. Eight consecutive missed Telegram pings (Oct 18–25) on the
 * Sunday Market digest schedule; the Oct 25 run lost BOTH the digest and
 * the ping when mid-run compaction made the freshly-pulled detail unquotable.
 *
 * FIX (ticket option (b)): the PLATFORM executes the ping at the detached-run
 * finalize — the same seam and the same executeAccountTool('notify_user')
 * surface the Dig-deeper finalize push already uses (chat-agent.service.ts).
 * The ping never depends on the model having a spare round.
 *
 * GATES (all must hold — a false positive would double-ping the owner):
 *  1. machine-triggered run (schedule firing / busy-queue schedule drain),
 *     never a user turn;
 *  2. the run's SCHEDULED origin (firedByScheduleId, threaded by
 *     fireScheduleTarget and the busy-queue drain) — only schedule-owned runs;
 *  3. the schedule's OWN stored prompt carries a trailing notify_user
 *     mandate (scheduleMandatesTrailingNotify below). The composed wake
 *     message is NOT scanned — the capability doctrine's own trigger row
 *     quotes the mandate phrase, and a line that does is doctrine text about
 *     SCHEDULING (→ schedule_message), not an owner's digest mandate;
 *  4. the run produced NO delivered notify_user (modelAlreadyNotified below —
 *     receipts AND the parts tool-result envelopes: the receipt mint is
 *     skipped on intent-replay / read-cache legs (agent.ts 5606-5607) while
 *     the parts array still carries the envelope, so both are scanned —
 *     never double-ping);
 *  5. the run finalized with a REAL answer (non-empty finalText, not the
 *     QUIET_RUN_REPLY one-liner — "Nothing new." mornings must not ping) and
 *     was not cancelled;
 *  6. rate caps stay in force inside executeAccountTool (NOTIFY_USER_DAILY_CAP
 *     / NOTIFY_CHAT_HOURLY_CAP) — the backstop never bypasses them.
 *
 * SCHEDULED_NOTIFY_BACKSTOP_DISABLED=1 (box env, forwarded backend+worker)
 * reverts to byte-for-byte pre-fix behavior. Loop metric
 * SCHEDULED_NOTIFY_BACKSTOP (meta { scheduleId, outcome, detail }) fires on
 * every platform-executed ping so the acceptance probe (≥95% delivered pings
 * over 14 days) has an of-record signal that can tell delivered
 * (outcome 'ok') from refused (outcome 'refused') — the envelope is PARSED
 * (parseNotifyOutcome), never assumed.
 */

/** Kill switch (box env; forwarded via docker-compose.app.yml like the neighbours). */
export function scheduledNotifyBackstopDisabled(): boolean {
  const v = String(process.env.SCHEDULED_NOTIFY_BACKSTOP_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * Clauses a SCHEDULE's stored prompt is filtered on before mandate matching.
 * The capability doctrine's trigger row reads:
 *   "- check back / remind me / every morning / monitor → schedule_message on
 *    this chat (standalone prompt; to reach them outside the app end with
 *    \"then notify_user with the result\")"
 * — it contains the mandate phrase verbatim but is ADVICE ABOUT SCHEDULING,
 * not an owner's digest mandate; a supervisor prompt quoting that advice
 * would otherwise ping the owner from an internal lane every firing. The row
 * is identified by its schedule_message mention (the shipped doctrine line
 * carries no other stable marker — verified against
 * chat-agent/capability-doctrine.ts: the string 'capability-doctrine'
 * appears only in that file's own comments). The filter is line-grained: a
 * line that BOTH advises schedule_message and mandates notify_user is
 * dropped too — the safe side is a missed ping (the model path still works
 * when rounds allow), never an unsolicited one.
 */
const NON_MANDATE_LINE = /(?:schedule_message|capability-doctrine)/i;

/**
 * Does a SCHEDULE's OWN stored prompt mandate a trailing notify_user?
 *
 * Detection is deliberately narrow (three adversarial review rounds; see the
 * fixture set in trailing-notify-backstop.8aa5688f.test.ts for the exact
 * shapes pinned). The shape that matters — the incident prompt and the
 * doctrine's own recommended phrasing — is an explicit SEQUENCING
 * instruction. Rules:
 *  - whitespace is normalized first, so a "then\ncall notify_user" line-break
 *    gap still matches; the common abbreviation periods (e.g. / i.e. / etc.)
 *    are stripped first so they do not cut the sentence window;
 *  - (A) conjunction → [gap ≤80, no sentence period, no negation] → verb
 *      (call|invoke|use|send|ping|push|fire|notify) → notify_user;
 *  - (B) conjunction → notify_user by EXACT adjacency (at most a comma, a
 *      colon or a quote mark — NEVER intervening words: "then check that
 *      notify_user credentials still work" is a mention, not a mandate).
 *      The clause AFTER notify_user must look like a mandate continuation
 *      (with|for|about|to|the|a|an|on|immediately|now|right|and|, or sentence
 *      end) — "then notify_user is optional / is not required / is
 *      forbidden" are predicates, not mandates (round-3 B-3R-c);
 *  - (C) plain-English: conjunction → send/ping/push me the digest/summary/
 *      result/… via/through/with notify_user;
 *  - a single-word negation (never / do not / don't / avoid / without /
 *      unless / only if / only on / only when / except) in the LEADING
 *      window, the match itself, or ANY ;/, segment of the TRAILING clause
 *      rejects the match — "then do not notify_user" is a prohibition,
 *      "call notify_user only if urgent" is a restriction, and a
 *      restriction hiding in a later tail segment ("…, but only if
 *      something is urgent" / "…; do not call it twice") is still a
 *      restriction (re-review B-1: the first hardening cut scoped the veto
 *      to the first segment and let six natural phrasings fire). The
 *      conditional connectives (only if/on/when, except) are scoped by a
 *      numeric-bound rule in the TAIL only: when a length bound PRECEDES
 *      the connective in the same segment, the exception scopes the FORMAT
 *      ("keep it under 10 lines except on red days") and the mandate fires
 *      (round-3 R3-C). Phrasal prohibitions ("no need to" / "unnecessary
 *      to" / modal-not-verb) veto in the match or lead ONLY — in a trailing
 *      position the same words modify a later action ("call notify_user —
 *      no need to wait"). The trailing window stops at the first sentence
 *      period, so an unrelated "never …" in the NEXT sentence does not
 *      veto a real mandate;
 *  - imperative prohibitions about the ping (skip/omit/hold/suppress/forgo/
 *      drop + it/them/the call/the ping/the notification/the message/such a
 *      call) in ANY tail segment reject the match (round-3 R3-B: "…, but
 *      skip it on green days" was invisible to every veto class); an
 *      imperative about CONTENT ("skip the chart") stays detail and fires;
 *  - a negative predicate in the TRAILING clause rejects ONLY when its
 *      subject's HEAD NOUN is call-anaphoric (pronoun / the call / the ping /
 *      the notification / such a call / elided) — in ANY segment, adjacent or
 *      later (round-3 R3-A/R3-E: subject, not segment position, decides).
 *      The head noun is the subject with any prepositional tail cut, tested
 *      end-anchored — a call-synonym carrying a content-noun modifier or PP
 *      ("the call with the chart summary", "the alert for the chart", "the
 *      chart's ping") is a prohibition on the CALL, never content detail
 *      (round-4 R4-2); a predicate whose subject's head IS the content noun
 *      (the length, the chart, the summary, the digest, the report) is
 *      mandate-amplifying detail and never vetoes (f12ab026 residue 3
 *      doctrine, now symmetric across ; and ,); and the complement list is
 *      CLOSED — benign "not <other word>" descriptors ("not too long", "not
 *      more than 3 lines", "not final yet", "not a problem") never predicate
 *      and the mandate fires (round-3 R3-D);
 *  - contracted copulas are normalized before matching: a prohibition
 *      phrased with a contraction ("…, but it's not required today",
 *      "they're not wanted", "the ping's not needed") is rewritten to its
 *      full-copula form ("it is not required…") BEFORE the matchers run,
 *      gated on the predicate continuation so only tail-predicate shapes
 *      are touched — a possessive that is not a predicate ("the chart's
 *      data", "it's fine") passes through untouched (round-4 R4-1);
 *  - polarity-flipping idioms — "don't forget to call notify_user" / "never
 *      skip calling notify_user" — negate the forgetting, not the calling:
 *      the idiom (through its verb and notify_user) is rewritten to a
 *      canonical "call notify_user" BEFORE matching. A flip whose
 *      continuation is NOT a verb+notify_user ("don't forget notify_user is
 *      optional", "don't forget to NOT call") is left in place and reads as
 *      the negation it is (round-3 B-3R-d);
 *  - lines mentioning schedule_message / the doctrine marker are dropped
 *    before matching (NON_MANDATE_LINE above).
 * A CONDITIONAL mandate ("if something is urgent then call notify_user")
 * DOES match by design: the owner asked to be pinged on urgent firings, and
 * the quiet gate keeps quiet mornings silent.
 */
export function scheduleMandatesTrailingNotify(prompt: string): boolean {
  if (!prompt) return false;
  // Round-4 R4-1: the tail-predicate vocabulary, defined ONCE here so the
  // contraction normalizer below and TAIL_PREDICATE below stay in lockstep.
  // PRED_ADJ: copula + negative adjective ("is optional / forbidden / off").
  // PRED_NOT: copula + not/never + the closed complement list ("is not
  // required", "should never be used") — round-3 R3-D's closed list, verbatim.
  const PRED_ADJ =
    'optional|forbidden|out\\s+of\\s+scope|muted|disabled|unused|unnecessary|needless|pointless|unwanted|deprecated|disallowed|prohibited|skipped|omitted|off';
  // Round-7 R6-F2: HYPHENATED predicative idioms — "it's off-limits", "it is
  // out-of-scope", "not-needed" — are prohibitions whose predicate word is
  // hyphen-bonded: "out-of-scope" fails PRED_ADJ's out\s+of\s+scope, and the
  // contraction gate's (?![\w-]) boundary blocks "off" inside "off-limits",
  // so a prohibited ping whose predicate was hyphenated FIRED (H-F2a
  // old=false 63aa=false new=true at 444524425). Listed ONCE here and shared
  // by the normalizer and TAIL_PREDICATE below so they cannot drift.
  const PRED_IDIOM = 'off-limits|out-of-scope|not-needed';
  // The closed prohibition-complement list (round-3 R3-D), extracted so the
  // n't contraction normalizer below and PRED_NOT stay in lockstep.
  const COMPLEMENT =
    'required|needed|wanted|necessary|allowed|permitted|expected|supposed|called|used|warranted';
  const PRED_NOT = `(?:not|never)\\s+(?:be\\s+)?(?:${COMPLEMENT})`;
  // Round-4 R4-1: contracted copulas ("it's not required", "they're not
  // wanted", "the ping's not needed") were invisible to TAIL_PREDICATE and
  // subjectOf — both match only FULL copula words — so a prohibition on the
  // call read as no-predicate and the mandate fired a spurious ping, on the
  // flip's own anchor no less ("Don't forget to call notify_user …, but it's
  // not required today"). Contractions are normalized to full copulas BEFORE
  // matching, GATED on the predicate continuation so only tail-predicate
  // shapes are touched — a possessive that is not a predicate ("the chart's
  // data", "it's fine") passes through untouched, and the rewrite can never
  // mint a conjunction, a verb or a notify_user mention that was not there.
  // Round-5 R5-3: the gate must be PREDICATIVE position, not a bare adjective
  // sighting. Two guards on the lookahead, both minted-silence convictions at
  // 797dcef68 (old=true dca=true 797=false):
  //  (a) hyphen boundary — `(?![\w-])` after the predicate word, so "off"
  //      inside "off-peak entries" or "optional-grade" never matches;
  //      Round-7 R6-F2: an EXPLICIT hyphenated idiom (off-limits /
  //      out-of-scope / not-needed) passes this boundary by exception —
  //      those words are predicates even hyphen-bonded, and their absence
  //      left "it's off-limits for this lane" FIRED (H-F2a/H-F2d minted at
  //      444524425, H-F2b/H-F2e pre-existing);
  //  (b) attributive position — the predicate word must not be followed by a
  //      LATER copula/modal inside the same comma-free run of ≤5 words:
  //      "the alert's optional status line is included" / "the ping's not
  //      needed line items are listed" are ATTRIBUTIVE uses (the adjective
  //      modifies the following noun), and rewriting them synthesized a
  //      copula the original never had, minting a veto that silenced a real
  //      mandate. A CONJUNCTION inside the run opens a NEW clause —
  //      coordinators (and/but/or/yet/so/nor) and subordinators (when/if/
  //      since/because/while/… alike) — so "it's not required today and the
  //      digest is long" and "it's not required when the run is empty" keep
  //      their rewrite: the later copula belongs to a different clause, and
  //      the prohibition still vetoes (a conditional prohibition is still a
  //      prohibition on the ping).
  //      Round-7 R6-2: the subordinator vocabulary was INCOMPLETE —
  //      whereas/whilst/provided/given/in case/assuming/whenever/wherever/
  //      however open clauses too, and their absence let the later copula
  //      block the rewrite, so "it's not required today whereas the digest
  //      is long" FIRED (R6-2a…l minted at 444524425, twelve rows).
  const CLAUSE_BREAK =
    'and\\b|but\\b|or\\b|yet\\b|so\\b|nor\\b|when\\b|if\\b|since\\b|because\\b|while\\b|as\\b|unless\\b|until\\b|although\\b|though\\b|where\\b|once\\b|after\\b|before\\b'
    + '|whereas\\b|whilst\\b|provided\\b|given\\b|in\\s+case\\b|assuming\\b|whenever\\b|wherever\\b|however\\b';
  // Round-4 R4-1: the s/'re contraction rewrite, gated predicative.
  const CONTRACTED_COPULA = new RegExp(
    `([A-Za-z][\\w'\\u2019-]*)['\\u2019](s|re)\\s+(?=(?:${PRED_ADJ}|${PRED_NOT}|${PRED_IDIOM})(?!(?:[\\w-]))(?!\\s+(?:(?!${CLAUSE_BREAK})[\\w'-]+)(?:\\s+(?!${CLAUSE_BREAK})[\\w'-]+){0,4}\\s+(?:is|are|was|were|remains|stays|has|have|will|would|should|could|can|do|does|did)\\b))`,
    'gi',
  );
  // Round-7 R6-2 (isn't variants): "it isn't required" is the same
  // prohibition as "it's not required", but the apostrophe sits INSIDE the
  // copula (n't), so CONTRACTED_COPULA never saw it and the round-6 verdict's
  // isn't rows (R6-2k/l) escaped every round since the detector was written.
  // In the n't shape the "not" IS the contraction — the complement follows
  // directly — so the lookahead tests PRED_NOT's complement (and the
  // adjective/idiom shapes) with the same predicative guard.
  const CONTRACTED_NT = new RegExp(
    `\\b(\\w+)n['\\u2019]t\\s+(?=(?:${COMPLEMENT}|${PRED_ADJ}|${PRED_IDIOM})(?!(?:[\\w-]))(?!\\s+(?:(?!${CLAUSE_BREAK})[\\w'-]+)(?:\\s+(?!${CLAUSE_BREAK})[\\w'-]+){0,4}\\s+(?:is|are|was|were|remains|stays|has|have|will|would|should|could|can|do|does|did)\\b))`,
    'gi',
  );
  const text = String(prompt)
    .split('\n')
    .filter((line) => !NON_MANDATE_LINE.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .replace(/\be\.?\s?g\.?/gi, 'eg')
    .replace(/\bi\.?\s?e\.?/gi, 'ie')
    .replace(/\betc\.?/gi, 'etc')
    // Round-7: both contraction shapes normalized with the same predicative
    // gate (R4-1 s/'re + the R6-2 isn't family) before any matching.
    .replace(
      CONTRACTED_COPULA,
      (_m: string, w: string, c: string) => `${w} ${c.toLowerCase() === 're' ? 'are' : 'is'} `,
    )
    .replace(
      CONTRACTED_NT,
      (_m: string, w: string) => `${w} not `,
    )
    .trim();
  if (!text) return false;
  const CONJ = String.raw`\b(?:then|after\s+that|afterwards|finally|lastly)\b`;
  // Single-word negations — veto anywhere they appear (the round-1..3 list,
  // plus the "not called for" idiom). Re-review B-1: these are tested on
  // EVERY ;/, segment of the trailing clause, not just the first — the first
  // hardening cut's segment-1 scoping let "…, but only if something is
  // urgent" / "…; do not call it twice" fire (the as-shipped detector tested
  // the WHOLE trailing clause, and this restores that scope). Round-3 R3-C:
  // the conditional connectives extend past "only if" to "only on" /
  // "only when" / "except" — "but only on red mornings" and "with anything
  // except the full digest" are restrictions exactly the way "only if
  // urgent" is, and they escaped the list.
  const NEG_WORD = /\b(?:never|don't|dont|do\s+not|avoid|without|unless|only\s+if|only\s+on|only\s+when|except|not\s+called\s+for)\b/i;
  // Phrasal prohibitions (ticket f12ab026 residue 1: a NEG word list alone
  // missed "no need to call", "there is no need to", "we should not call",
  // "it is unnecessary to" — prohibitions phrased outside the list FIRED and
  // pinged the owner unsolicited). Tested against the MATCH and the LEAD
  // only: in those positions the phrase negates the CALL itself ("then no
  // need to call notify_user"). In a trailing position the same words
  // usually modify a LATER action ("call notify_user — no need to wait"), and
  // the ticket's residue cases are all lead-positioned, so the tail stays
  // under the single-word + predicate discipline only. The modal branch is
  // tested against the FULL match because "we should not call" spans the lead
  // AND the verb the matcher consumed.
  const NEG_PHRASE =
    /\b(?:(?:no|zero)\s+need\s+to|need\s+not|unnecessary\s+to|(?:is|are|was|were|should|would|could)\s+not\s+(?:to\s+)?(?:be\s+)?(?:call|invoke|use|send|ping|push|fire|notify)(?:ing)?)\b/i;
  // Polarity-flipping idioms, rewritten to a canonical mandate BEFORE
  // matching. The match must run THROUGH notify_user and be led by a verb
  // (or notify_user directly) — so "don't forget to NOT call notify_user"
  // (the continuation is NOT) and "don't forget notify_user is optional"
  // both stay un-rewritten and read as the negations they are. "never skip
  // calling notify_user" IS a mandate and is rewritten (round-3 B-3R-d: the
  // bare 'call' token ate the verb and 'don't skip calling' went silent).
  const FLIP = /\b(?:do\s+not|don't|dont|never)\s+(?:forget|skip|omit|miss)\s+(?:to\s+)?(?:(?:call|invoke|send|ping|push|fire|notify)(?:ing)?\s+)?notify_user\b/gi;
  // The rewrite SYNTHESIZES the conjunction anchor (ticket f12ab026 safe-direction
  // miss: "Post the digest as your reply. Don't forget to call notify_user with
  // a summary." went SILENT because the rewrite yielded a bare 'call
  // notify_user' with no CONJ to anchor branch (A)). Rewriting to ' then call
  // notify_user' routes the flip through the SAME (A) discipline — lead
  // negation, reporting-verb, tail predicate — so a flip whose continuation is
  // a prohibition ("don't forget to NOT call") still stays silent: its rewrite
  // ' then call notify_user' meets the original 'to NOT call' tail… which the
  // flip's own lead no longer negates. That shape is handled by the ORIGINAL
  // negation surviving the rewrite: the rewrite only replaces through
  // 'notify_user', leaving ' to NOT call notify_user' beyond it untouched —
  // see the FLIP regex note above; non-verb continuations never rewrite.
  const normalized = text.replace(FLIP, ' then call notify_user');
  // (A) conjunction → [gap, no sentence period, no negation] → verb → notify_user
  const withVerb = new RegExp(`${CONJ}([^.!?]{0,80}?)\\b(?:call|invoke|use|send|ping|push|fire|notify)\\s+notify_user\\b`, 'gi');
  // (B) conjunction → notify_user by EXACT adjacency (a comma/colon and a
  // quote mark are the only allowed separators — never intervening words).
  const bare = new RegExp(`${CONJ}\\s*[,;:]?\\s*["'\u201c\u201d]?\\s*notify_user\\b`, 'gi');
  // (C) plain-English: conjunction → send/ping/push me the digest/summary/…
  //     … via/through/with notify_user
  const via = new RegExp(
    `${CONJ}([^.!?]{0,80}?)\\b(?:send|ping|push|fire)\\s+(?:me\\s+)?(?:the\\s+)?(?:digest|summary|result|report|findings?|update)([^.!?]{0,60}?)\\b(?:via|through|with)\\s+notify_user\\b`,
    'gi',
  );
  // Interrogative/investigation framing (ticket f12ab026 residue 2): a
  // REPORTING verb in the lead whose phrase ENDS in interrogative content
  // directly before the mandate verb — "then check whether you can call
  // notify_user", "then report how to call notify_user", "then ask whether
  // it is possible to call" — is an instruction to INVESTIGATE the
  // capability, not to ping. The lead-END anchor keeps post-conjunction
  // conditionals firing ("then check if anything is red and call
  // notify_user": the lead ends "red and", not interrogatively).
  const REPORTING_VERB = /\b(?:check|verify|confirm|report|document|ask|determine|probe|test|see|find\s+out)\b/i;
  const INTERROG_END = /\b(?:whether|how|if|can|possible)\b(?:\s+(?:to|you|we|it|is|be))?\s*$/i;
  // A negative predicate in the clause AFTER a match — the FLIP rewrite can
  // produce "call notify_user is optional" from "don't forget notify_user is
  // optional"; a bare predicate ("then notify_user is optional") is caught by
  // BARE_TAIL_OK / BARE_TAIL_BAD below. Re-review N-1: the adjective list is
  // OPEN — "is unnecessary / is not wanted / is pointless" are prohibitions
  // too, so the class is any copula + negative adjective OR any copula +
  // not/never + a PROHIBITION complement. Round-3 R3-D closed the second
  // branch: `copula + not + \w+` matched benign descriptors about the CONTENT
  // ("which is not too long", "it is not more than 3 lines", "that is not
  // final yet") and silenced real mandates — the as-shipped detector fired on
  // all of them. The complement list is closed on the round-3 boundary and
  // pinned: required/needed/wanted/necessary/allowed/permitted/expected/
  // supposed/called/used/warranted (+ optional "be" for the modal shapes
  // "should never be used"). Positive "required/needed" are NOT vetoes —
  // "a 1-3 line length is required" is mandate-amplifying, the very
  // over-reach f12ab026 residue 3 complained about. WHERE a predicate vetoes
  // is subject-scoped (see segmentsOf / CONTENT_NOUN_HEAD below): the
  // notify_user-ADJACENT segment, or any segment whose subject is
  // call-anaphoric. Round-4 R4-1: built from the shared PRED_ADJ / PRED_NOT
  // strings (top of this function) so the contraction normalizer and this
  // test are the SAME vocabulary by construction — they cannot drift.
  // Round-7 R6-F2: the hyphenated idioms join BOTH grammar shapes —
  // "is off-limits" (copula + bare idiom) and "is not-needed" (copula + not
  // + idiom): the round-6 verdict's H-F2 family was a prohibited ping whose
  // predicate word was hyphen-bonded, invisible to both branches.
  // Round-8 R7-1: the source is extracted ONCE (TAIL_PRED_SRC) and shared
  // with the LIST_RIGHT list-separator guard in segmentsOf below, so the
  // shapes a list can be normalized INTO always end in a predicate this
  // same vocabulary reads — the two cannot drift.
  const TAIL_PRED_SRC =
    `\\b(?:is|are|was|were|remains|stays)\\s+(?:${PRED_ADJ}|${PRED_IDIOM})\\b|\\b(?:is|are|was|were|should|would|could|remains|stays)\\s+(?:${PRED_NOT}|not\\s+${PRED_IDIOM})\\b`;
  const TAIL_PREDICATE = new RegExp(TAIL_PRED_SRC, 'i');
  // Round-9 H-F4a: DISTRIBUTED NEGATION — "neither the ping nor the summary
  // is required" distributes the prohibition over BOTH conjuncts (≡ "the
  // ping or the summary is not required", the author's pinned R7-2d form),
  // but the neither…nor frame carries no not/never carrier, so PRED_NOT
  // never sees it and the mandate fired a spurious ping (old=false →
  // 33c=true; unpinned — `grep neither` over the 93-fixture suite = 0). A
  // neither…nor frame whose copula takes a REQUIRED-SIDE complement (the
  // PRED_NOT vocabulary) is predicated-prohibitive here; the subject
  // scoping below then reads its conjuncts ("neither the ping" / "the
  // summary") and vetoes exactly when one conjunct's head is a call word.
  // The OPTIONAL side is NOT distributed — "neither X nor Y is optional"
  // reads "both are mandatory", mandate-amplifying detail (that form stays
  // a plain PRED_ADJ match whose content-head subjects stay exempt) — and
  // the not-carrier form keeps its direct PRED_NOT match, so the minimal
  // pairs hold by construction.
  const NEITHER_DISTRIB = new RegExp(
    `\\bneither\\b[^.;!?\\n]{0,120}?\\bnor\\b[^.;!?\\n]{0,120}?\\b(?:is|are|was|were|remains|stays|should|would|could)\\s+(?:be\\s+)?(?:${COMPLEMENT})\\b`,
    'i',
  );
  // Round-11 R10-A2 (clause-conjunct neither frames): the round-10
  // clause-refusal path PRESERVES the scattered frame — "…; neither the run
  // is empty, nor the ping is required." — but its second segment "nor the
  // ping is required" carried NO predication shape: TAIL_PREDICATE matches
  // a copula at the segment START (this one opens with "nor") and
  // NEITHER_DISTRIB needs the neither…nor FRAME inside one segment, so a
  // call-word head ("the ping") never vetoed and the mandate fired a
  // spurious ping (NM-3b, round-10 FINAL, self-reproduced with the
  // author's own minimal pair NM-3 "…, nor the summary is required."
  // staying content-exempt by the same silence). The frame's negation
  // lives in the FRAME, so the second-conjunct shape "nor X <copula>
  // <REQUIRED-side complement>" is predicated-prohibitive here exactly
  // like NEITHER_DISTRIB — subject scoping in predicatedAboutCall then
  // reads "the ping"/"the summary" and vetoes exactly when the head is a
  // call word. The OPTIONAL side is NOT distributed ("nor the chart is
  // optional" stays mandate-amplifying), matching the NEITHER_DISTRIB
  // disposition by construction.
  const NOR_DISTRIB = new RegExp(
    `^\\s*\\bnor\\b[^.;!?\\n]{0,120}?\\b(?:is|are|was|were|remains|stays|should|would|could)\\s+(?:be\\s+)?(?:${COMPLEMENT})\\b`,
    'i',
  );
  // Round-12 R12-β (re-derived from the round-11 FINAL NOT-MERGE-SAFE's
  // bounded "one NEW blocking class" on the three fix surfaces): the
  // SUBJECT-AUX INVERSION of the same frame — "…, and nor is it required."
  // / "…, and nor is the ping required." / "…, and neither is it wanted." —
  // carries the negation in the inversion exactly like the normal-order
  // frame, but NOR_DISTRIB's subject-BETWEEN shape (`nor <subj> <copula>
  // <COMPLEMENT>`) cannot see it (between "nor" and "is" sits nothing), and
  // TAIL_PREDICATE needs a literal not/never. The frame FIRES at every head
  // (ed9 / round-10 head / round-11 head) — a spurious ping, unremediated in
  // every round. The matcher mirrors NOR_DISTRIB's disposition: REQUIRED-side
  // complement only (the OPTIONAL side stays undistributed — "nor is it
  // optional" reads "it is mandatory", mandate-amplifying), an OPTIONAL
  // leading connective + neither/nor lead (the ;/, split leaves the segment
  // as "and nor is it required"), and the subject is the POST-AUX capture —
  // subjectOf's subject-before-copula read returns the literal word "nor"
  // for an inverted segment, which would veto even the content minimal pair
  // ("nor is the summary required" must keep firing). predicatedAboutCall
  // swaps the capture in and runs the SAME conjunct head-noun discipline:
  // "nor is it / the ping required" vetoes; "nor is the summary required"
  // stays content-exempt and fires.
  const NOR_INVERT = new RegExp(
    `^(?:\\s*(?:and|but|or|yet|so)\\b[\\s,-]*)?\\s*\\b(?:nor|neither)\\b\\s+(?:is|are|was|were|remains|stays|should|would|could)\\s+(?:be\\s+)?([^.;!?\\n]{0,120}?)\\s+(?:${COMPLEMENT})\\b`,
    'i',
  );
  // The clause after an ADJACENT notify_user must look like a mandate
  // continuation — "is/are/was/should …" predicates are mentions/prohibitions.
  const BARE_TAIL_OK = /^\s*(?:$|[.!?;,]|with\b|for\b|about\b|to\b|the\b|a\b|an\b|on\b|immediately\b|now\b|right\b|and\b)/i;
  // …and its continuation must not be a false friend (ticket f12ab026
  // residue 4; anchors per the re-review's N-3): "for reference only",
  // "and Slack both work" and "now exists as a tool" are capability MENTIONS
  // wearing an allowed first word. The anchors keep real mandates that
  // merely CONTAIN the words firing: "with nothing urgent" (nothing vetoed
  // only at sentence end — the message follows), "the findings that exist",
  // "the summary that now exists".
  const BARE_TAIL_BAD =
    /\b(?:for\s+reference\s+only|with\s+nothing(?!\s+\w)|both\s+work|as\s+a\s+(?:tool|capability))\b/i;
  const clauseAfter = (m: RegExpMatchArray): string => {
    const rest = normalized.slice((m.index ?? 0) + m[0].length);
    // Round-6 verdict R6-1: the window was 80 chars — a comma-coordinated
    // subject list (normalized to its longer and-form in segmentsOf) pushed
    // the predicate past the cut and truncated it mid-word, so segPredicated
    // never matched and the veto was lost (R6-1c/R6-1i FIRED). 200 chars
    // covers the longest coordinated tails; the sentence-end split and the
    // subject scoping still bound what can veto.
    return (rest.split(/[.!?]/)[0] ?? '').slice(0, 200);
  };
  // Tail-clause scoping (re-review B-1/B-1'/N-3; round-3 R3-E; round-4 R4-E):
  // a tail clause is split into its ;/, segments — empties are dropped, so a
  // tail that OPENS with the boundary (", which is not required here") makes
  // its first non-empty segment the notify_user-ADJACENT one. Single-word
  // negations veto in EVERY segment (the as-shipped detector scanned the
  // whole trailing clause). Predicates veto in ANY segment — adjacent or
  // later — subject to the head-noun exemption below (there is NO
  // adjacent-unconditional rule: the committed r3b/E1 rows FIRE with a
  // content-head subject sitting in the adjacent segment). False friends
  // (BARE_TAIL_BAD) veto ONLY the notify_user-ADJACENT segment (round-4
  // R4-E: a later segment remarking "…and Slack both work" / "…as a tool"
  // is a separate remark about capabilities, not a prohibition on the call,
  // and must not silence a real mandate). Imperatives veto in EVERY segment
  // when their object is call-anaphoric (R3-B). A predicate about the
  // summary, the chart or "a 1-3 line length" is mandate-amplifying detail,
  // never a prohibition on the call (f12ab026 residue 3).
  // Round-3 R3-B: IMPERATIVE prohibitions (no copula, no listed negation) —
  // "skip it on green days", "omit the ping on quiet mornings", "hold the
  // notification until the owner asks", "suppress it for this lane" — were
  // invisible to every veto class: NEG_WORD had no imperative verbs,
  // TAIL_PREDICATE needs a copula. These now veto in EVERY segment when
  // their object is call-anaphoric (it/them/the call/the ping/such a
  // notification…); an imperative about CONTENT ("skip the chart" /
  // "omit the length line") stays mandate-amplifying and does not veto.
  const segmentsOf = (clause: string): string[] => {
    // Round-6 verdict R6-1: a comma-coordinated subject list — "the alert,
    // the digest and the summary are not wanted" — is ONE subject with ONE
    // predicate, but the ;/, split isolated each conjunct in its own
    // predicate-less segment: "but the alert" never reaches the subject test
    // (no copula), and "the digest and the summary are not wanted" is
    // all-content and exempt — the call-word conjunct smuggled past and the
    // mandate FIRED (A23-class rows, unsafe since f124d423c).
    // Round-7 verdict R7-1: the round-6 LIST_COMMA matched exactly ONE list
    // shape — determiner-led conjuncts, a completing and/or/nor, no Oxford
    // comma before it — so the round-6 conviction corpus kept firing in
    // every other list form: Oxford ("the chart, the ping, and the digest
    // are not required"), asyndetic ("the chart, the ping, the digest are…"),
    // unarticle'd ("chart, ping, and digest are…"), semicolon lists
    // ("…; the chart; the ping; the digest are…") and the leading-separator
    // form ("; the ping, the chart, and the summary are not required" — the
    // A23 row). The list rule is now decided PER SEPARATOR, not by one
    // glued shape: a comma or semicolon MERGES the text before it into the
    // following segment's subject iff BOTH guards pass.
    // Round-7 verdict R7-2: the round-6 LIST_COMMA also OVER-MERGED: it
    // looked only FORWARD from the comma, so "; the digest is fine, the
    // alert and the summary are not wanted" matched its (noun run +
    // coordinator + copula) lookahead and glued the benign "the digest is
    // fine" clause ONTO the list subject, killing the veto (444=false
    // correct → 3bf=true). The LEFT guard below is the boundary: the text
    // since the PREVIOUS separator must be verb-free — a real conjunct
    // ("the chart") carries no verb, a whole clause ("the digest is fine")
    // does — so a clause boundary stops the merge and the ;/, split (plus
    // the copula-requiring subject discipline) governs the clause exactly
    // as it does at 444 (R7-2b/g/c/h + the R7-2mp minimal pair).
    const VERB_RE = /\b(?:is|are|was|were|remains|stays|has|have|had|will|would|should|could|can|does|did|do|be|been|being)\b/i;
    // LEFT guard: the run since the previous separator, minus a leading
    // connective, must be a conjunct RUN — items (optionally determiner-led)
    // separated by commas or coordinators, NO verb — so a clause ("the
    // digest is fine") or the mandate itself never merges: the R7-2
    // content-clause boundary. The mandate ("then call notify_user with the
    // summary") is excluded by SHAPE — multi-word with an action verb fails
    // the single-item test — so no action-word blacklist is needed: a bare
    // "ping"/"call" is far more often a list CONJUNCT (the unarticle'd list
    // "chart, ping, and digest are not required" — R7-1e, where the
    // rightmost separator's left run IS the bare "ping" and position within
    // the local run cannot tell conjunct from imperative) than an
    // imperative, and the verb gate (VERB_RE) still rejects real clauses.
    // Coordinators are ALLOWED between items because earlier separators in
    // the same list have already merged into and-form (an Oxford list "the
    // chart, the ping, and the digest" merges right-to-left: "the ping"
    // first, then "the chart and the ping"). Relative pronouns,
    // coordinators and connectives are never items, so "…, which is
    // optional" and "…, and Slack both work" keep splitting as before.
    const ITEM_WORD_BLACKLIST =
      'and|or|nor|but|yet|so|which|that|who|whom|whose|where|when|while|if|because|since|although|though|however|whereas|then|also|both|only|just|still';
    const ITEM_RE = new RegExp(
      `^(?:(?:the|a|an)\\s+)?(?!\\b(?:${ITEM_WORD_BLACKLIST})\\b)[a-z][\\w'-]*$`,
      'i',
    );
    const isItem = (tok: string): boolean => {
      const t = tok.trim();
      if (!ITEM_RE.test(t)) return false;
      return !VERB_RE.test(t.replace(/^(?:the|a|an)\s+/i, '').toLowerCase());
    };
    const CONJUNCT_SEP = new RegExp(`\\s*,\\s*|\\s+(?:and|or|nor)\\s+`, 'i');
    const leftIsConjunctRun = (s: string): boolean => {
      const run = s
        .trim()
        .replace(/^(?:but|and|though|although|yet|while|if|when|however|also|then|or|so)\b[\s,-]*/i, '');
      if (!run) return false;
      return run.split(CONJUNCT_SEP).every((p) => isItem(p));
    };
    const PROHIB_TAIL = new RegExp(
      `\\b(?:not|never)\\b|(?:${PRED_ADJ}|${PRED_IDIOM}|${PRED_NOT}|not\\s+${PRED_IDIOM})`,
      'i',
    );
    const rightIsConjunctList = (s: string): boolean => {
      const run = s.trim();
      const boundary = run.search(/[;.!?\u2014\u2013]/);
      let tail = (boundary === -1 ? run : run.slice(0, boundary)).trim();
      if (!tail) return false;
      // Round-9 R8-C6/C8: a trailing COORDINATED APPENDIX — ", and the
      // summary is optional" / ", and the summary is fine" — after a
      // completed prohibition list defeated the chunk validation (the
      // appendix chunk carries a verb, so every separator failed the
      // item test, the R7-1 merge was refused and the ping veto never
      // re-formed — fingerprint of the round-7 R7-1a class, its fifth
      // form; old=false → 33c=true). The appendix only exists where the
      // stretch BEFORE it already ends in a completed clause (a verb is
      // present), so scan every comma and cut at the LAST one whose left
      // side is verbful; the Oxford COMPLETING comma (", and the digest
      // are not required") is preceded by a bare conjunct run ("but the
      // chart,") with NO verb and never cuts. The appendix itself then
      // lands as its own ;/, segment — a content clause about the
      // summary/chart, exempt by the subject discipline. The cut only
      // ever ENABLES the merge guards to re-read the prohibition list;
      // the left guard (verb-free mandate run), the item chain and the
      // PROHIB_TAIL copula test all still have to pass.
      const APPENDIX_SEP =
        /,\s*(?:(?:and|or|nor|but|yet|so)\s+)?(?:(?:the|a|an|my|our|your|his|her|its|their)\s+)?[a-z][\w'\u2019-]*(?:\s+[a-z][\w'\u2019-]*)*\s+(?:is|are|was|were|remains|stays|should|would|could)\b/gi;
      for (const apx of tail.matchAll(APPENDIX_SEP)) {
        const pre = tail.slice(0, apx.index).trim();
        if (VERB_RE.test(pre)) {
          tail = pre;
          break;
        }
      }
      // Round-9 R9-P5a (imperative appendix): ", and keep the report short" —
      // an appendix with NO copula is invisible to APPENDIX_SEP (its subject
      // run has no is/are/… to anchor on). When the stretch BEFORE a comma
      // already ends in a completed clause (a verb — the same precondition
      // every appendix exists under), the appendix chunk carries a verb of
      // its own, rightIsConjunctList's item validation fails at that
      // separator and the veto never re-forms.
      // Round-11 R10-A1 (fresh-verb imperative appendix): the guard was a
      // CLOSED verb allowlist {keep,limit,cap,hold,maintain,stay,remain} and
      // fresh imperative shapes escaped it — "…, and summarize the findings
      // in three lines." / "…, and send a copy to the archive." (IA-5/IA-6,
      // round-10 FINAL, self-reproduced with minimal pairs). The cut is
      // widened to ANY comma whose LEFT side is verbful AND whose RIGHT
      // side is VETO-FREE: the discarded stretch may carry NO prohibition
      // vocabulary (PROHIB_TAIL: not/never/off/forbidden/…, the PRED_NOT
      // complements, the hyphen idioms) and NO free-standing call-anaphoric
      // token (CALL_WORD_IN_SUBJECT — "…, and keep the ping out of the
      // report" keeps its exact pre-existing path), and a NEGATIVE
      // imperative lead (never / do not / don't) belongs to the NI branch
      // below and is never cut here. A veto-carrying appendix — "…, and the
      // ping is not required" — fails the veto-free test and stays whole
      // for the split/merge discipline, so the cut can only discard
      // mandate-amplifying content and can never DISARM a veto it carries.
      // The cut still only ENABLES the merge guards to re-read the list —
      // the left VERB_RE guard, the item chain and the PROHIB_TAIL copula
      // test all still have to pass.
      const POSITIVE_APPENDIX_RE =
        /\s*,\s+(?:(?:and|or|nor|but|yet|so)\s+)?(?=[a-z])/gi;
      for (const imp of tail.matchAll(POSITIVE_APPENDIX_RE)) {
        const pre = tail.slice(0, imp.index).trim();
        const post = tail.slice((imp.index ?? 0) + imp[0].length);
        const niLead = /^(?:never\b|do\s+not\b|don['\u2019]t\b|dont\b)/i.test(post);
        // Disarm-safety, symmetric with the NI branch's precondition below:
        //   LEFT carries a prohibition → the veto survives the cut, so ANY
        //     non-NI appendix is discarded (a veto-carrying one included —
        //     its veto is redundant with the left's; "…, and keep the ping
        //     out of the report" after a prohibition list still cuts and the
        //     list veto re-forms exactly as the closed keep-cut did).
        //   LEFT is clean → the appendix could be the ONLY veto carrier, so
        //     it is discarded ONLY when it is veto-free: no PROHIB_TAIL
        //     vocabulary, no free-standing call-anaphoric token (the
        //     round-3 imperative veto class still reads those), no NI lead.
        if (
          VERB_RE.test(pre)
          && (PROHIB_TAIL.test(pre)
            ? !niLead
            : !niLead && !PROHIB_TAIL.test(post) && !CALL_WORD_IN_SUBJECT.test(post))
        ) {
          tail = pre;
          break;
        }
      }
      // Round-10 fresh finding (exploratory probe, this run): the NEGATIVE
      // imperative appendix — ", and don't ping the owner twice." / ", and
      // never ping the owner." — is a copula-less PROHIBITION the merge
      // cannot read: rightIsConjunctList fails at that separator, the veto
      // never re-forms and the mandate fires a spurious ping (head=true,
      // ed9=true — pre-existing, 7th form of the appendix family). Cut it
      // ONLY when the stretch before the comma ALREADY ends in a prohibition
      // (PROHIB_TAIL): the cut then discards a redundant reinforcement of the
      // left veto and can never disarm a real one — with an all-content left
      // list ("…, and don't ping the owner") the left carries no veto, the
      // cut is refused and the appendix keeps its exact pre-existing path.
      const NEG_IMPERATIVE_APPENDIX_RE =
        /\s*,\s+(?:(?:and|or|nor|but|yet|so)\s+)?(?=never\b|do\s+not\b|don['\u2019]t\b|dont\b)/gi;
      for (const imp of tail.matchAll(NEG_IMPERATIVE_APPENDIX_RE)) {
        const pre = tail.slice(0, imp.index).trim();
        if (VERB_RE.test(pre) && PROHIB_TAIL.test(pre)) {
          tail = pre;
          break;
        }
      }
      // An empty chunk is the SEPARATOR ITSELF (a clause that opens with
      // its boundary — ", the ping, and …" — splits to a leading ""), never
      // a list item: filter it, validate the rest.
      const chunks = tail.split(/\s*[,;]\s*/).filter((c) => c.length > 0);
      if (chunks.length === 0) return false;
      for (let k = 0; k < chunks.length - 1; k++) if (!isItem(chunks[k])) return false;
      const last = chunks[chunks.length - 1];
      // The final copula is CAPTURED INTO lm[1] (head = subject words only):
      // slicing head as "everything before the captured tail" when the tail
      // started AFTER the copula left the copula INSIDE head, and the verb
      // check below then rejected every list at its own copula (the round-8
      // trace: right(" and the digest are not required")=false with head
      // "and the digest are"). The coordinator group is * so a 3+ item
      // chain — "the chart and the ping and the digest are not required" —
      // matches whole (with `?` a 4-item asyndetic list stranded its first
      // item outside every merge and a leading call item escaped).
      const lm = last.match(
        new RegExp(
          `^(?:(?:and|or|nor)\\s+)?(?:(?:the|a|an)\\s+)?(?!\\b(?:${ITEM_WORD_BLACKLIST})\\b)[a-z][\\w'-]*(?:\\s+(?:and|or|nor)\\s+(?:(?:the|a|an)\\s+)?[a-z][\\w'-]*)*\\s+((?:is|are|was|were|remains|stays|should|would|could)\\b[\\s\\S]*)$`,
          'i',
        ),
      );
      if (!lm) return false;
      const head = last.slice(0, last.length - lm[1].length);
      const words = head.match(/[a-z][\w'-]*/gi) ?? [];
      for (const w of words) {
        const lw = w.toLowerCase();
        if (/^(?:and|or|nor|the|a|an)$/.test(lw)) continue;
        if (new RegExp(`^(?:${ITEM_WORD_BLACKLIST})$`, 'i').test(lw)) return false;
        if (VERB_RE.test(lw)) return false;
      }
      return PROHIB_TAIL.test(lm[1]);
    };
    let out = clause;
    // Process separators right-to-left: RIGHT reads `out` (a merged pair
    // cascades leftward through a list), LEFT reads the ORIGINAL `clause`
    // (a merge never feeds a later LEFT match — insertions happen only at
    // indices already processed). A separator followed by an EXISTING
    // coordinator ("the ping, and the digest") drops the comma and keeps
    // the coordinator — never "and and"; an asyndetic separator ("the ping,
    // the digest") or a semicolon item ("the ping; the digest") inserts the
    // coordinator itself.
    for (let i = clause.length - 1; i >= 0; i--) {
      if (clause[i] !== ',' && clause[i] !== ';') continue;
      if (!rightIsConjunctList(out.slice(i + 1))) continue;
      const beforeAll = clause.slice(0, i);
      const prevSep = Math.max(beforeAll.lastIndexOf(';'), beforeAll.lastIndexOf(','));
      if (!leftIsConjunctRun(beforeAll.slice(prevSep + 1))) continue;
      const coordFollows = /^\s*(?:and|or|nor)\b/i.test(out.slice(i + 1));
      out = out.slice(0, i) + (coordFollows ? ' ' : ' and') + out.slice(i + 1);
    }
    // Round-8 R7-2 minimal pair (R7-2mp): a segment carrying TWO CLAUSES
    // coordinated by and/but/or/yet/so/nor — "the digest is fine and the
    // alert and the summary are not wanted" — had its subject read from the
    // FIRST copula ("the digest", content) while the prohibition lived in
    // the second clause; the call conjunct escaped and the mandate fired.
    // When a coordinator's left run AND its remaining right BOTH carry a
    // verb, it opens a clause boundary; a coordinated SUBJECT list ("the
    // alert and the summary are not wanted", or a list the merge above just
    // built) has no verb before the coordinator and never splits. Scanned
    // left-to-right so a non-boundary coordinator stays inside its run (no
    // duplicated "and" — the round-8 probe convicted the right-to-left cut).
    const COORD_SPLIT = /\s+(?:and|but|or|yet|so|nor)\s+/gi;
    const splitClauses = (seg: string): string[] => {
      const parts: string[] = [];
      let start = 0;
      COORD_SPLIT.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = COORD_SPLIT.exec(seg))) {
        const leftRun = seg.slice(start, m.index);
        if (VERB_RE.test(leftRun) && VERB_RE.test(seg.slice(m.index + m[0].length))) {
          parts.push(leftRun);
          start = m.index + m[0].length;
        }
      }
      parts.push(seg.slice(start));
      return parts;
    };
    // Round-9 CLASS 1 (serial-comma neither-list): "; neither the ping, the
    // chart, nor the digest is required" — the frame matches NEITHER_DISTRIB
    // whole, but the final ;/, split scatters it into predicate-less segments
    // ("neither the ping" / "the chart" / "nor the digest is required"): the
    // copula lands in the LAST segment whose subject is "nor the digest"
    // alone, the call conjuncts sit in predicate-less segments that neither
    // veto path reads, and the spurious ping fired (all old=false →
    // 33c=true → ed9=true; already true at 33c9b8ac, NOT minted by the ed9
    // delta). Pre-normalize a SERIAL neither-chain to its REPEATED-nor form
    // ("neither the ping nor the chart nor the digest is required") AFTER the
    // merge loop and BEFORE the split: the rewrite keeps the frame WHOLE in
    // ONE comma-free segment — the round-6 comma-subject-list normalization's
    // neither-kin, except the coordinator emitted is nor (not and) because
    // the neither-frame's negation lives in the FRAME, not the predicate
    // ("is required" stays POSITIVE — an and-form would strip the nor
    // NEITHER_DISTRIB itself needs and the list-merge PROHIB_TAIL gate
    // rejects a positive complement; the single-segment form needs neither —
    // NEITHER_DISTRIB predicates the whole frame and predicatedAboutCall
    // reads the conjuncts, the SAME veto path as the pinned two-item form).
    // Guards: the run must open with "neither " + an item-shaped first
    // conjunct (determiner-led noun phrase, NM_ITEM), and every rewritten
    // comma must be followed by another item-shaped conjunct optionally
    // headed by nor — so a neither-frame whose conjuncts are CLAUSES
    // ("neither the run is empty, nor the data is stale") never normalizes
    // (its commas keep splitting as clause boundaries), and the plain
    // two-item neither…nor form (no comma at all) is untouched
    // byte-for-byte. The walk ends at the first copula (the predicate rides
    // verbatim — predicates of any length) or at the first non-comma
    // terminator.
    {
      const NM_ITEM =
        /^(?:(?:the|a|an|my|our|your|his|her|its|their)\s+)?[a-z][\w'\u2019-]*(?:\s+(?:of\s+)?(?:the|a|an|my|our|your|his|her|its|their)?\s*[a-z][\w'\u2019-]*){0,3}$/i;
      const NM_ITEM_AT =
        /^(?:(?:the|a|an|my|our|your|his|her|its|their)\s+)?[a-z][\w'\u2019-]*(?:\s+(?:of\s+)?(?:the|a|an|my|our|your|his|her|its|their)?\s*[a-z][\w'\u2019-]*){0,3}/i;
      const neitherChain = out.match(/\bneither\s+((?:(?:the|a|an|my|our|your|his|her|its|their)\s+)?[a-z][\w'\u2019-]*)\s*,\s*/i);
      if (neitherChain && NM_ITEM.test(neitherChain[1])) {
        let ok = true;
        const pieces: string[] = [out.slice(0, neitherChain.index ?? 0) + `neither ${neitherChain[1]}`];
        let rest = out.slice((neitherChain.index ?? 0) + neitherChain[0].length);
        for (;;) {
          const lead = rest.match(/^\s*(?:nor\s+)?/i)![0];
          const cur = rest.slice(lead.length);
          const it = cur.match(NM_ITEM_AT);
          if (!it) { ok = false; break; }
          const after0 = cur.slice(it[0].length);
          let itemText = it[0].replace(/^nor\s+/i, '');
          // CLAUSE-CONJUNCT REFUSAL: the greedy allowance can match a span
          // that OPENS with a verb/copula/negation ("…, nor the data is
          // stale" after "neither the run is empty, " → candidate "is
          // stale" at the next link) — that is a CLAUSE conjunct, not an
          // item. Rewriting it would corrupt the frame; the chain REFUSES
          // (no rewrite) and the frame keeps its exact pre-existing
          // scattered behavior.
          const firstWord = itemText.split(/\s+/)[0] ?? '';
          if (
            VERB_RE.test(firstWord)
            || /^(?:is|are|was|were|remains|stays|should|would|could|has|have|had|will|can|may|must|do|does|did|not|never|be|been|being)$/i.test(firstWord)
          ) { ok = false; break; }
          // The item allowance is greedy and would swallow the copula +
          // predicate ("the digest is required" passes the item shape): cut
          // at the FIRST copula — the item is the pre-copula run, the
          // predicate rides verbatim, and the chain ENDS there.
          const cop = itemText.match(/\s+(?:is|are|was|were|remains|stays|should|would|could)\b[\s\S]*$/i);
          if (cop) {
            itemText = itemText.slice(0, cop.index).trim();
            if (!NM_ITEM.test(itemText)) { ok = false; break; }
            pieces.push(` nor ${itemText}`, cop[0], after0);
            break;
          }
          if (!NM_ITEM.test(itemText)) { ok = false; break; }
          pieces.push(` nor ${itemText}`);
          // Round-11 R10-A2 (NM-15): a SEMICOLON mid-frame — "neither the
          // ping, the chart; the digest is required." — ended the walk at
          // the ';' exactly like a period, scattering the frame ("neither
          // the ping" / "the chart" / "the digest is required": the call
          // conjuncts sat in predicate-less segments and the spurious ping
          // fired — round-10 FINAL, self-reproduced). A ';' following an
          // item-shaped conjunct is crossed like a ',' — the frame re-forms
          // whole and every downstream guard still gates what follows: a
          // clause conjunct after the ';' ("…; nor the run is empty") is
          // refused by the first-word verb/copula test below, and the cop
          // cut ends the frame at the first copula with the predicate
          // riding verbatim.
          const sep = after0.match(/^\s*([,;])\s*/);
          if (!sep) { pieces.push(after0); break; }
          rest = after0.slice(sep[0].length);
          if (!rest) { ok = false; break; }
        }
        if (ok) out = pieces.join('');
      }
    }
    return out
      .split(/[;,]/)
      .flatMap((s) => splitClauses(s.trim()))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };
  // Round-3 R3-A/R3-E subject vocabulary. A predicate segment's SUBJECT
  // decides whether it is a prohibition on the CALL or detail about the
  // CONTENT (f12ab026 residue 3 doctrine, now position-independent — the
  // semicolon/comma asymmetry is gone). Content subjects (never a
  // prohibition on the call): the message's own parts — length, chart,
  // summary, digest, report, findings, reply, body, text. Everything else —
  // elided subject (segment opens with the copula: "is optional on quiet
  // days"), anaphoric pronouns ("which/that/it/this/they"), call synonyms
  // ("the ping/the notification/the message/such a call" — the round-3 R3-A
  // class that previously escaped the subject list), gerunds ("calling it"),
  // prepositional tails ("for this lane is not required" — the PP modifies
  // the elided CALL, not the copula's subject) — reads as being about the
  // call and vetoes. The default is the SAFE direction: silence.
  // Round-4 R4-2: the exemption decides on the subject's HEAD NOUN — the
  // subject with any prepositional tail cut, tested END-ANCHORED. The
  // round-3 unanchored substring test exempted call-synonym subjects that
  // merely MENTION a content noun in a modifier or a PP — "the call with
  // the chart summary is not required", "the alert for the chart", "the
  // chart's ping" — real prohibitions on the ping that read as content
  // detail and fired spurious pings. The head noun is what the predicate is
  // ABOUT: "the chart's ping" is a ping, "the call with the chart summary"
  // is a call, and only a subject whose head IS the content ("the chart is
  // optional", "the length is optional") is mandate-amplifying detail.
  const CONTENT_NOUN_HEAD =
    /(?:length|charts?|summaries|summary|digests?|reports?|findings?|repl(?:y|ies)|answers?|notes?|details?|bod(?:y|ies)|texts?|tables?|attachments?|links?)$/i;
  // Round-5 R5-5: the PP cut must never SPLIT a hyphenated compound — the
  // plain alternation matched the "with" inside "alert-with-chart" and left
  // "the alert" as the head. The preposition is required to stand FREE
  // (spaces around it); a hyphen-bonded token is part of the compound word,
  // and "the alert-with-chart notes" is an ALERT (call) with notes attached,
  // not content. Convicted at 797dcef68 (X-B2.1 old=false f124=true r2=true
  // dca=true 797=false — a minted recall loss re-breaking a shape the early
  // rounds had fixed).
  const SUBJECT_PP = /(?:^|\s)(?:with|for|about|to|on|in|of|at|from)\b.*$/i;
  // Round-5 R5-4: a compound head [call-synonym + content noun] is a CALL —
  // "the ping summary", "the notification body", "the alert text" are the
  // ping's parts named by their call-synonym head, exactly like round-4's
  // "the summary ping" (A10) read as call-anaphoric in the other order. The
  // PR minted these as content (X-N2.1/X-N2.3 old=false f124=true), because
  // the end-anchored test sees only the final noun. The call word counts
  // only as a FREE-STANDING token (space-bounded, or possessive-attached) —
  // a HYPHEN-BONDED fragment never counts, so "the alert-with-chart notes"
  // (R5-5) keeps its content head while "the ping summary" (R5-4) does not.
  const CALL_WORD_IN_SUBJECT =
    /(?:^|\s)(?:call|ping|notification|alert|telegram|notify|message|mention|dm)(?:s|es)?(?=$|\s|['\u2019])/i;
  // A segment opening with one of these prepositions continues the CALL's
  // clause ("with a summary is not required for this lane" — the subject is
  // the notify_user call itself, elided), so its predicate is about the call.
  const SEG_PREP = /^(?:with|for|about|to|on|in|of|at|from)\b/i;
  const SEG_CONNECTIVE = /^(?:but|and|though|although|yet|while|if|when|however|also|then|or|so)\b[\s,-]*/i;
  // Round-9 H-F4a: the distributed-negation frame counts as predicated (it
  // carries its own copula + required-side complement); subject scoping in
  // predicatedAboutCall below decides whether the conjuncts name the call.
  // Round-11 R10-A2: the PRESERVED clause-refusal second conjunct ("nor the
  // ping is required") carries the frame's negation the same way — see the
  // NOR_DISTRIB note above NEITHER_DISTRIB's definition.
  const segPredicated = (seg: string): boolean =>
    TAIL_PREDICATE.test(seg)
    || NEITHER_DISTRIB.test(seg)
    || NOR_DISTRIB.test(seg)
    // Round-12 R12-β: the subject-aux INVERSION of the neither/nor frame —
    // "and nor is it required" / "and neither is it wanted" — carries the
    // frame's negation in the inversion; see NOR_INVERT above.
    || NOR_INVERT.test(seg);
  // The subject of a predicated segment: words before the copula/modal,
  // minus a leading connective. null = no copula (nothing to scope — the
  // segment cannot be a predicate at all); '' = the subject is elided or
  // prepositional (the call).
  const subjectOf = (seg: string): string | null => {
    const s = seg.replace(SEG_CONNECTIVE, '').replace(/^[\s\u2014\u2013-]+/, '').trim();
    if (SEG_PREP.test(s)) return '';
    const m = s.match(/^([\w\s'\u2019-]{0,120}?)\b(?:is|are|was|were|should|would|could|remains|stays)\b/i);
    return m ? (m[1] || '').trim() : null;
  };
  // R3-A/R3-D/R3-E: a predicate vetoes UNLESS its subject's HEAD NOUN is a
  // content noun — in ANY segment, adjacent or later. The closed complement
  // list (TAIL_PREDICATE) already separates prohibitions ("is not required")
  // from benign descriptors ("is not too long" / "is not more than 3 lines" /
  // "is not final yet" — none of those complements are listed, so they never
  // predicate and never veto: the mandate fires). Round-4 R4-2: the head noun
  // is the subject with any prepositional tail cut, tested END-ANCHORED —
  // "the call with the chart summary" and "the chart's ping" are prohibitions
  // on the CALL (their head is call/ping), never content detail, while only a
  // subject whose head IS the content ("the chart is optional") is exempt.
  const subjectHeadAboutCall = (subj: string): boolean => {
    // Round-5 R5-2: a COORDINATED subject's exemption is read conjunct by
    // conjunct — "the chart and the summary is optional" exempts only if
    // EVERY conjunct's head is content. Reading the LAST conjunct alone let
    // a call-word conjunct smuggle past ("the ping and the summary are not
    // required" — old=false f124=true … 63aa=true), and reading the FIRST is
    // the mirror-image defect, so both are gone: the veto is about the CALL
    // if ANY conjunct's head is a call word / non-content, and only a fully
    // content-head coordination stays mandate-amplifying detail. The same
    // hyphen-bonding rule as SUBJECT_PP: the split respects compound words.
    const COORD_SUBJECT_SPLIT = /\s+(?:and|or|nor)\s+/i;
    // Round-6 verdict R6-1: comma-coordinated subjects are normalized to
    // their and-form in segmentsOf BEFORE this split (see there), so the
    // conjunct-by-conjunct discipline below governs "and" lists and comma
    // lists symmetrically — the round-5 fix alone never saw comma lists
    // because segmentsOf's ;/, split isolated each conjunct in its own
    // predicate-less segment (A23-class rows, unsafe since f124d423c).
    const conjuncts = subj
      .split(COORD_SUBJECT_SPLIT)
      .filter((k) => k.trim().length > 0);
    return conjuncts.length === 0
      ? true
      : conjuncts.some((k) => {
        const head = k.replace(SUBJECT_PP, '').trim();
        // Round-5 R5-4: a compound [call-synonym + content noun] head is a
        // CALL — "the ping summary", "the notification body", "the alert
        // text" — the call-synonym token anywhere in the head compound makes
        // the subject about the ping (round-4 A10's "the summary ping" in
        // the other order, and the reviewer's X-N2.1/X-N2.3 convictions).
        // Round-6 verdict R6-4: a MEASUREMENT attribute is the exception —
        // "the message length / the alert length / the ping length" are
        // properties OF the message, not the ping (R6-4a/b/c: true at
        // 63aa07d37, silenced at 444524425) — so the length exemption is
        // decided BEFORE the call-word test that would convict the head.
        // Only LENGTH is exempt: the ping's PARTS ("the message body", "the
        // alert text") keep their call-anaphoric reading (X-N2.4) — a part
        // of the ping is the ping, a measurement of the message is not.
        const headTokens = head.split(/\s+/).filter(Boolean);
        const lastTok = headTokens[headTokens.length - 1] ?? '';
        if (
          headTokens.length >= 2
          && /^length$/i.test(lastTok)
          && headTokens.slice(0, -1).some((t) => CALL_WORD_IN_SUBJECT.test(`${t} `))
        ) {
          return false;
        }
        if (CALL_WORD_IN_SUBJECT.test(head)) return true;
        // Round-6 verdict R6-5: a call-FIRST hyphen compound AS THE WHOLE
        // HEAD — "the ping-with-chart", "the alert-with-summary" — is a
        // CALL. R5-4's free-standing rule saw only space-bounded tokens, so
        // the compound read as the single token "ping-with-chart", and the
        // round-6 R5-5 PP cut kept it one token ending in "chart" → content
        // → exemption → FIRE (MP5-2/R6-5b/c/e minted at 444524425). The
        // compound's FIRST hyphen segment names the ping — but ONLY when
        // the compound is the entire head (a leading article aside): AX10's
        // "call-with-chart summary" and X-B2.1's "alert-with-chart notes"
        // have a FREE content noun after the compound, and that noun is the
        // head (both stay pinned true).
        const bareHead = head.replace(/^(?:the|a|an)\s+/i, '');
        const firstHyphen = bareHead.split('-')[0] ?? '';
        if (/^[\w']+(?:-[\w'-]+)+$/.test(bareHead) && CALL_WORD_IN_SUBJECT.test(firstHyphen)) {
          return true;
        }
        return !CONTENT_NOUN_HEAD.test(head);
      });
  };
  const predicatedAboutCall = (seg: string): boolean => {
    if (!segPredicated(seg)) return false;
    let subj = subjectOf(seg);
    // Round-12 R12-β: an INVERTED neither/nor frame ("and nor is it
    // required") hands subjectOf the literal lead word — "nor" / "neither" —
    // because the aux PRECEDES the subject. The frame's subject is the
    // POST-AUX capture (NOR_INVERT group 1); swapping it in runs the SAME
    // head-noun discipline as every other predicated segment: "nor is it /
    // the ping required" vetoes, "nor is the summary required" stays
    // content-exempt and the mandate fires (the NM-3 minimal-pair symmetry).
    if (subj === 'nor' || subj === 'neither') {
      const inv = seg.match(NOR_INVERT);
      if (inv) subj = (inv[1] || '').trim();
    }
    // '' (elided/prepositional) and null (no copula — a false-friend like
    // "and Slack both work") both veto by elision, exactly as round-3 did.
    if (!subj) return true;
    return subjectHeadAboutCall(subj);
  };
  // Round-3 R3-B: IMPERATIVE prohibitions (no copula, no listed negation) —
  // "skip it on green days", "omit the ping on quiet mornings", "hold the
  // notification until the owner asks", "suppress it for this lane" — were
  // invisible to every veto class. These veto in EVERY segment when their
  // object is call-anaphoric (it/them/the call/the ping/the notification/
  // the alert/the telegram/such a call); "the message" counts as the ping
  // UNLESS immediately extended by a content compound ("the message body").
  // An imperative about CONTENT ("skip the chart", "omit the length line")
  // never matches — its object is not anaphoric — and stays detail.
  const NEG_IMPERATIVE =
    /\b(?:skip|omit|hold|suppress|forgo|drop|cancel)\s+(?:it|them|the\s+(?:call|ping|notification|alert|telegram)|the\s+message(?!\s+(?:body|text))|such\s+a\s+(?:call|ping|notification))\b/i;
  // Round-3 R3-C scoping: "only if/on/when" and "except" are restrictions on
  // the CALL when they ride a tail segment — UNLESS a numeric bound (under N
  // / no more than N / N lines / a 1-3 line …) PRECEDES the connective in
  // the SAME CONJUNCT: then the exception scopes the FORMAT ("keep it under
  // 10 lines except on red days" — the length rule varies, the ping does
  // not), the as-shipped detector fired, and the bare-token widening was
  // minting a recall loss (self-probe C4). Round-4 R4-C narrowed the scope
  // from segment to CONJUNCT: a coordinator (and/but/or/yet/so) between the
  // bound and the connective means the connective opens a NEW conjunct —
  // "keep it under 10 lines and only if urgent" is a length rule PLUS a call
  // gate, and the call gate still vetoes (the disarm minted a spurious ping
  // on old=false r2=false). Connective-before-bound ("only if the digest is
  // under 3 lines") or no bound at all ("but only on red mornings") still
  // vetoes — the restriction gates the call. Hard negations (never / do not
  // / without / unless / avoid) veto unconditionally, as they always have.
  const COND_CONNECTIVE = /\b(?:only\s+if|only\s+on|only\s+when|except)\b/i;
  const NUMERIC_BOUND =
    /\b(?:under|at\s+most|no\s+more\s+than|up\s+to|less\s+than|fewer\s+than|maximum(?:\s+of)?|max)\s+\d|\b\d+(?:\s*[-\u2013]\s*\d+)?\s*(?:line|word|char|sentence)s?\b/i;
  const COORD_CONJUNCT = /\b(?:and|but|or|yet|so)\b/i;
  // Hard negations veto unconditionally (any segment, any position — the
  // round-1..3 list minus the conditional connectives, which segNegated
  // scopes by the conjunct-scoped numeric-bound rule above).
  const NEG_WORD_HARD =
    /\b(?:never|don't|dont|do\s+not|avoid|without|unless|not\s+called\s+for)\b/i;
  const segNegated = (s: string): boolean => {
    if (NEG_WORD_HARD.test(s)) return true;
    if (!COND_CONNECTIVE.test(s)) return false;
    // Round-5 R5-1: EVERY conjunct carrying a connective is checked against
    // its OWN conjunct's preceding bound — the round-4 `findIndex` examined
    // only the FIRST connective-bearing conjunct, so a format exception in
    // conjunct 0 ("keep it under 10 lines except on red days") disarmed a
    // genuine call gate in conjunct 1 ("and only if urgent") and the mandate
    // fired a spurious ping (old=false f124=true r2=false dca=true). The
    // segment vetoes unless EVERY connective-bearing conjunct is disarmed by
    // a bound preceding the connective IN THAT CONJUNCT — one undisarmed
    // connective is a live call gate, and a live gate vetoes.
    const conjuncts = s.split(COORD_CONJUNCT);
    const armed = conjuncts.filter((k) => COND_CONNECTIVE.test(k));
    if (armed.length === 0) return true;
    return !armed.every((k) => {
      const b = k.match(NUMERIC_BOUND);
      const oc = k.match(COND_CONNECTIVE);
      return Boolean(b && oc && (b.index ?? 0) < (oc.index ?? 0));
    });
  };
  const tailVetoed = (m: RegExpMatchArray): boolean => {
    const segs = segmentsOf(clauseAfter(m));
    if (segs.length === 0) return false;
    if (segs.some((s) => segNegated(s))) return true;
    // Round-4 R4-E: false friends veto ONLY the notify_user-ADJACENT segment
    // (segs[0]) — they are capability mentions wearing an allowed first word
    // in the clause directly continuing notify_user; a LATER segment carrying
    // the same words ("…; and Slack both work") is a separate remark, not a
    // prohibition on the call, and must not silence a real mandate.
    if (BARE_TAIL_BAD.test(segs[0])) return true;
    return segs.some((s) => predicatedAboutCall(s) || NEG_IMPERATIVE.test(s));
  };
  const negated = (m: RegExpMatchArray | null): boolean => {
    if (!m) return true;
    const lead = `${m[1] ?? ''} ${m[2] ?? ''}`;
    return (
      NEG_WORD.test(m[0])
      || NEG_WORD.test(lead)
      || NEG_PHRASE.test(m[0])
      || NEG_PHRASE.test(lead)
      || tailVetoed(m)
      || (REPORTING_VERB.test(lead) && INTERROG_END.test(lead))
    );
  };
  // Every occurrence is tried (re-review N-2: a single .match() let an
  // early vetoed mention shadow a LATER genuine mandate — "Then check
  // whether you can call notify_user. Then call notify_user with the
  // summary." went silent). Fire on the first occurrence that survives its
  // own veto. The three matchers carry the g flag for matchAll.
  const fires = (re: RegExp): boolean => {
    for (const m of normalized.matchAll(re)) {
      if (!negated(m)) return true;
    }
    return false;
  };
  if (fires(withVerb)) return true;
  if (fires(via)) return true;
  for (const b of normalized.matchAll(bare)) {
    const tail = clauseAfter(b);
    if (!BARE_TAIL_OK.test(tail)) continue;
    if (tailVetoed(b)) continue;
    return true;
  }
  return false;
}

/**
 * Did THIS run already ping successfully? An ok notify_user receipt (the
 * NOTIFY_RECEIPT_TOOLS class — ids {channel}, never message text) is the
 * authoritative proof. But the receipt mint is SKIPPED on intent-replay and
 * read-cache legs (agent.ts: `if (receiptId && (servedFromReadCache ||
 * intentReplay)) delete ctx.receiptId`) while the run's parts array still
 * carries the tool_result envelope — so BOTH are scanned (review finding
 * B1: a receipts-only gate would double-ping exactly on the replay legs).
 * The envelope shape is account-tools' j() JSON: `"ok": true`.
 */
export function modelAlreadyNotified(receipts: unknown, parts?: unknown): boolean {
  const receiptHit = (Array.isArray(receipts) ? receipts : []).some(
    (r: any) => r && typeof r === 'object' && String(r.tool ?? '') === 'notify_user' && r.ok === true,
  );
  if (receiptHit) return true;
  return (Array.isArray(parts) ? parts : []).some(
    (p: any) => p
      && typeof p === 'object'
      && p.type === 'tool_result'
      && String(p.name ?? '') === 'notify_user'
      && /"ok":\s*true/.test(String(p.result ?? '')),
  );
}

/**
 * Parse executeAccountTool's notify_user envelope. The tool returns a JSON
 * STRING (account-tools j(): JSON.stringify(obj, null, 1)) — ok envelopes
 * read { ok: true, tool, channel, deliveredTo, chars } (possibly with an
 * appended outbound-redaction note that breaks JSON.parse), refusals read
 * { ok: false, tool, reason, message }. Review finding B2: reading `.ok`
 * off the string is always undefined, which made the metric's outcome a
 * constant. Parse properly; fall back to a substring test for the
 * appended-note shape. ok:null means unparsed (recorded, never assumed).
 */
export function parseNotifyOutcome(raw: unknown): { ok: boolean | null; detail: string } {
  const s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  if (!s) return { ok: null, detail: 'empty' };
  try {
    const parsed = JSON.parse(s) as { ok?: unknown; reason?: unknown; channel?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') {
      return parsed.ok
        ? { ok: true, detail: String(parsed.channel ?? 'telegram') }
        : { ok: false, detail: String(parsed.reason ?? 'refused') };
    }
  } catch { /* appended-note shape — substring test below */ }
  if (/"ok":\s*true/.test(s)) return { ok: true, detail: 'telegram' };
  if (/"ok":\s*false/.test(s)) return { ok: false, detail: 'refused' };
  return { ok: null, detail: 'unparsed' };
}

/** The QUIET_RUN_REPLY convention (view/minimal-view.ts): a "Nothing new." firing must not ping. */
const QUIET_RUN_REPLY_RE = /^\s*nothing new\.?\s*$/i;
export function isQuietRunReply(finalText: string): boolean {
  return QUIET_RUN_REPLY_RE.test(String(finalText ?? '').trim());
}

/**
 * Build the platform-side ping message. Deterministic, self-describing, and
 * capped well under NOTIFY_MESSAGE_MAX (3500): the owner must be able to tell
 * a backstop ping from the model's own. notify_user's own footer already
 * names the originating chat (account-tools reads the chat title), so the
 * backstop does NOT re-read it (review finding N2) — chatTitle stays null on
 * the wiring path and exists only for direct callers.
 */
export function buildScheduledNotifyMessage(chatTitle: string | null, finalText: string): string {
  const digest = String(finalText ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2400);
  const title = chatTitle && String(chatTitle).trim() ? ` in "${String(chatTitle).trim().slice(0, 80)}"` : '';
  return `Scheduled digest ready${title} — open the chat to read it. First lines:\n${digest}`;
}

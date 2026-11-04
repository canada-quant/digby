/**
 * run-outcome-line.ts — front-loaded machine-readable status line for
 * run_completed / run_failed hook-event summaries (ticket bf30c5d9, MAST FM-2.4).
 *
 * THE DEFECT: a run's terminal hook event renders its final answer into the
 * wake summary, but the answer is sliced TWICE — at the producers (300 chars:
 * run-executor "Final answer: …", chat-agent "Answer: …") and again by
 * hooks.service truncateSummary (SUMMARY_CAP 2000). A reviewer sub-session's
 * verdict block (per-claim table, MERGE-SAFE / NOT-MERGE-SAFE, blocking
 * findings) routinely lives PAST both cuts, so a parent acting on the wake
 * alone could merge over a blocking finding it never saw. First-hand
 * (bf30c5d9): parent b92ef13f's run_completed wake from reviewer b1f74238
 * arrived cut mid-sentence; the C1–C8 verdict block was beyond the cut and
 * survived only because the parent independently pulled the child transcript.
 *
 * THE FIX: producers call frontLoadRunOutcome() with the FULL final answer
 * BEFORE any slicing. The emitted summary's first line is then always
 *   RUN_OUTCOME: completed · VERDICT: MERGE-SAFE · BLOCKING: 0
 * (~60 chars) — immune to every downstream cut. This module is a zero-import
 * LEAF so the hot producers can import it statically with no cycle risk.
 *
 * EXTRACTION BIAS (safe direction): a false NOT-MERGE-SAFE costs the parent
 * one transcript pull; a false MERGE-SAFE could merge over a blocking finding.
 * So negative markers beat positive ones, an explicit `VERDICT:` line beats
 * prose scanning, and the wake template's harvest instruction
 * (get_chat_messages) stays authoritative for detail — this line is the
 * truncation-proof SIGNAL, not the full result.
 *
 * OWN-WORDS RULE (ticket 54af5c27): extraction runs on the lane's OWN words
 * only. A self-audit or verdict recap routinely QUOTES prior review history —
 * chat 13df1406's pass-2 answer carried "records the e8ed45c3 verdict:
 * NOT-MERGE-SAFE-as-described" inside a markdown table row and the whole-text
 * keyword scan hoisted that historical verdict into the event header,
 * asserting the OPPOSITE of the lane's actual outcome. Quoted/derived content
 * (fenced code blocks, blockquote lines, markdown table rows, inline code
 * spans) is therefore MASKED before every regex below runs. Residual limit:
 * a historical verdict restated in PLAIN prose (no markdown quoting at all)
 * still scans as the lane's words — a leaf heuristic cannot attribute bare
 * prose; the explicit `VERDICT:` status line remains the authoritative signal.
 *
 * QUOTED-SPAN RULE (ticket 11a35cfb): the run_completed digest stamped
 * "VERDICT: MERGE-SAFE · BLOCKING: 0" on a FIX lane whose final answer carried
 * NO verdict at all (chat d3d82b39, msg 4f2d6c12, 12:05Z 2026-10-17) — the
 * only merge-safe-shaped token anywhere in the answer was the QUOTED reviewer
 * sub-session TITLE "Adversarial review: isolation boundary diff ·
 * Merge-safety audit: prod-path" sitting in plain prose. A quoted span names
 * FOREIGN text (a title, a chat name, a branch name, a verdict relayed from
 * another chat) — it is not a verdict the lane issued. Double-quoted spans
 * (straight and typographic) are therefore masked like the 54af5c27
 * constructs, with ONE carve-out: a span the lane explicitly ATTRIBUTES as a
 * verdict — the pinned relay idiom 'Final verdict (read this run, message
 * 5cedea7b, 14:26Z): "VERDICT: SAFE TO MERGE"' from da70e157's build-lane
 * repro — still scans: that is the reviewer's CURRENT verdict and the build
 * lane's own summary. The attribution cue is the word "verdict" followed by a
 * COLON that introduces the quote (within 64 chars, same line): a
 * colon-introduced quote is the lane HANDING OVER the verdict, while a
 * "verdict" word merely sitting near an unrelated quote ("the reviewer
 * verdict came in: title now "MERGE-SAFE audit"") attributes nothing. A
 * non-colon relay shape ("Final verdict is "SAFE TO MERGE"") fails open to
 * n/a — the documented safe direction, same as a relayed BLOCK. Masking is
 * fail-closed: an unmatched opener masks to end of line.
 *
 * REVIEWER IDIOM (ticket da70e157): the platform's adversarial reviewers
 * write their verdicts as MARKDOWN HEADINGS in the BLOCK family —
 * "## **VERDICT: BLOCK** — 2 blocking findings" (chat ce911d93, four
 * occurrences 2026-10-17). The decoration classes below originally accepted
 * `> * • - –` but NOT `#`, so a heading verdict line never matched the
 * explicit-line lane; the whole-text fallback then either flipped to
 * MERGE-SAFE (occurrence #1: the unbounded MERGE-SAFE substring matched inside
 * the review-DIMENSION word "merge-safety" in "worker reports (security,
 * merge-safety)") or failed open to n/a (#3/#4) — on security-critical BLOCK
 * verdicts, the exact inversion of the signal supervisors steer by. Three
 * repairs: `#` joins every decoration class, the BLOCK family
 * (BLOCK/BLOCKED/FAIL/REJECT/REFUSE) joins the negative vocabulary on the
 * explicit line, and the whole-text positive fallback is word-bounded so the
 * dimension word can no longer read as a verdict. The digest header is DERIVED
 * from the same final answer in the same call — there is no independent
 * structured verdict field to cross-validate, so extraction correctness IS
 * the fix.
 */

export const RUN_OUTCOME_PREFIX = 'RUN_OUTCOME:';

/**
 * STRUCTURED VERDICT FIELD (ticket b36a150e, follow-up to 4baa7c3e / PR #1772):
 * a lane/reviewer emits a machine-readable JSON line in its final answer —
 *   {"verdict":"NOT-MERGE-SAFE","blocking":2,"source":"reviewer-final"}
 * — and extractRunVerdict reads it with precedence over the regex fallback.
 * WHY A FIELD, NOT MORE REGEX ARMS: the 8-round adversarial ladder over
 * NEGATIVE_RE/STANDING (4baa7c3e) showed every regex widening mints NEW
 * boundary classes of its own; the supervisor's ladder-close ruling therefore
 * capped the vocabulary (pinned as DOCUMENTED BOUNDARY in the 4baa7c3e test
 * file) and routed the residual classes here. Prose parsing stays as the
 * FALLBACK for lanes that emit no field.
 * THE CONTRACT (fail-safe, by construction):
 *   - the JSON object must live on ONE line, be the FIRST parse candidate from
 *     the FINAL SEGMENT of the text (last parse wins, the same recency
 *     principle as the last VERDICT: line), and carry a STRING "verdict"
 *     whose value is EXACTLY "MERGE-SAFE" or "NOT-MERGE-SAFE" (upper-case,
 *     no tail) — anything else is not a structured verdict and the field is
 *     absent (the regex fallback then runs, unchanged);
 *   - a structured NOT-MERGE-SAFE beats EVERYTHING except the producer's own
 *     verdictOverride (a guard-replaced run is the one producer that owns the
 *     verdict outright);
 *   - a structured MERGE-SAFE is an ASSERTION by the emitter that the prose
 *     around it may contradict — a false MERGE-SAFE could merge over a
 *     blocking finding, the module's documented dangerous direction — so it
 *     is accepted only when TWO gates pass. FIRST, the ATTRIBUTION gate
 *     (review F1): the field must live on text the masking contract counts as
 *     the AUTHOR'S OWN — a fence, blockquote, markdown table row, inline-code
 *     span, or quoted/relayed span is not the author's assertion (the
 *     54af5c27/11a35cfb OWN-WORDS contract; the doctrine bullet taught by this
 *     same change makes quoted examples of the field ordinary text in final
 *     answers, so the exposure is realistic). The gate is a SENTINEL
 *     DIFFERENTIAL through the real masker: the field's own span is replaced
 *     by a quote-free sentinel token, the full mask pass runs, and the field
 *     counts as attributed only if the sentinel SURVIVES — reusing the
 *     masker's exact fence/carry/relay semantics with no duplicated grammar
 *     (a hand-rolled "is this line quoted?" approximation would mint the next
 *     boundary class; the 4baa7c3e lesson). The NEGATIVE field deliberately
 *     SKIPS this gate: it is read pre-mask because a negative the lane
 *     relays/quotes is still a negative a supervisor must see — the
 *     fail-closed direction, identical to the B1 quoted-negative doctrine.
 *     SECOND, the prose gate: the OWN-WORDS prose must carry NO negative
 *     marker the fallback can see (NEGATIVE_RE over the doctrine-discounted
 *     view, the same test the explicit-VERDICT:-line lane applies, plus the
 *     B1 quoted-negative veto and the truncation veto). The prose wins ties
 *     against a structured positive, exactly as it does against an explicit
 *     VERDICT: MERGE-SAFE line. NOT-MERGE-SAFE fields also keep a "blocking"
 *     count when the JSON carries one (digits, clamped 0-99).
 *   - KEY ORDER (review F3): the canonical shape is verdict-first —
 *     {"verdict":…,"blocking":…,"source":…} in any subset order after the
 *     verdict key. A field whose "verdict" key comes AFTER another key
 *     ({"source":…,"verdict":…}) is NOT matched — the contract pins the
 *     machine shape exactly, and half-ordered variants are absent (the regex
 *     fallback runs). The "source" key may repeat after it (tolerated,
 *     ignored); unknown keys elsewhere are not part of the shape.
 *   - COUNT CORROBORATION (ticket 2f14eb79, three review rounds): a
 *     positive field's "blocking" count is honored — never as a verdict —
 *     and never overrides the author's OWN counts. The prose count has
 *     three author-own tiers (the explicit BLOCKING: n line, the verdict
 *     line's own count tail, labeled finding lines) and one narration tier
 *     (the count statement scan, which mined this ticket's false 2 from
 *     RESOLVED round history: "Round-1 blocking findings — both fixed").
 *     A field's count is read pre-mask on the raw text and honored ONLY
 *     when the prose count came from the statement tier ALONE, or when the
 *     prose tiers found nothing (a clean verdict where the field is the
 *     only count voice) — an attributed field can be bare prose
 *     mid-sentence or an early own-line field made stale by later findings,
 *     so it may never zero a labeled/explicit/tail count (review round 3,
 *     repros E/F/K/M4/M5). A field with NO count key asserts nothing (it
 *     does not erase an earlier field's count — round-3 N1). A field on a
 *     blockquote line or a markdown table row (leading '|' — the masker's
 *     own row rule) is foreign relay content and never corroborates; a
 *     pipe mid-line is the author's prose and stays corroborable (round-3
 *     N3). An unattributed NONZERO never touches the count (foreign text
 *     must not mint a count). The field still never flips a verdict (the
 *     attribution contract above is untouched — a masked-span field stays
 *     unread as a verdict, so the 3c354a95 documentation-example pins
 *     hold). The reviewer idiom — wrapping the machine line in backticks
 *     — is covered: the specimen's backticked field zero still reads
 *     BLOCKING: 0.
 */
export const STRUCTURED_VERDICT_RE =
  /\{[ \t]*"verdict"[ \t]*:[ \t]*"(MERGE-SAFE|NOT-MERGE-SAFE)"(?:[ \t]*,[ \t]*"blocking"[ \t]*:[ \t]*(\d{1,2}))?(?:[ \t]*,[ \t]*"source"[ \t]*:[ \t]*"[^"\n]{0,64}")?[ \t]*\}/g;

export type ExtractedRunVerdict = 'MERGE-SAFE' | 'NOT-MERGE-SAFE' | 'n/a';

/**
 * An explicit machine-readable verdict line: "VERDICT: MERGE-SAFE", markdown
 * tolerated. The decoration class accepts heading marks (`#`) and bold
 * (`*`) — ticket da70e157: the platform's adversarial reviewers write
 * "## **VERDICT: BLOCK** — …" and the heading-blind class never matched it,
 * so every BLOCK verdict fell to the (mis)leading whole-text fallback.
 */
const VERDICT_LINE_RE = /^[>\s*•\-–#]*VERDICT:\s*\*{0,2}([^\n*]+)/gim;
/**
 * BLOCK-family verdict VALUES (ticket da70e157) — BLOCK / BLOCKED / FAIL /
 * REJECTED / REFUSED / NO-GO. Tested ONLY against the explicit VERDICT: line's
 * captured value, never the whole text: reviewer prose uses the same words
 * POSITIVELY about fixes ("the fix blocks the leak", "blocks credential
 * exfiltration"), so the bare word must not join the whole-text fallback
 * vocabulary (that lane keeps its bf30c5d9/54af5c27-tested markers only).
 */
const BLOCK_VERDICT_RE = /\bBLOCK(?:ERS?|ED|ING|S)?\b|\bFAIL(?:URES?|ED|ING|S)?\b|\bREJECT(?:ED|S)?\b|\bREFUS(?:ED|ES?|AL)\b|\bVETO(?:ED|ES|S)?\b|\bNO[-\s]?GO\b/i;
/**
 * A NEGATED, zeroed or RESOLVED block value is a POSITIVE verdict —
 * "VERDICT: NO BLOCKING ISSUES", "VERDICT: 0 FAIL", "VERDICT: BLOCKING ISSUES
 * RESOLVED". Tested on the explicit value BEFORE BLOCK_VERDICT_RE so the
 * family match cannot invert it (da70e157: the safe direction for a
 * BLOCK-family word is negative, but an absent or cured blocker is the one
 * shape where positive is the truth). The resolved leg allows at most ONE
 * filler noun (issues/findings/problems/…) between the family word and the
 * resolution — a loose window would let "BLOCK — G1/G2/G3 ADDRESSED" read
 * positive over a live BLOCK.
 * Supervisor instance #2 (2026-10-18 12:48Z, chat db331d3e msg 04320233 —
 * a read-only E2E probe): "**VERDICT: fix verified working … Zero injection
 * failures.**" — the affirmative quantifier + a modifier noun + a BLOCK/
 * FAIL noun. BLOCK_VERDICT_RE matched the bare "FAILURES" tail and stamped
 * NOT-MERGE-SAFE over a POSITIVE verdict (the run had no merge-safety
 * content at all). The first alternation now allows up to TWO lowercase
 * modifier words between the affirmative quantifier and the family noun —
 * enough for "zero injection failures", "no merge blockers", "zero lint
 * failures"; "NOT" keeps firing upstream of this lane (NEGATIVE_RE and the
 * \bNOT\b test run first — "not all failures fixed" reads NOT-MERGE-SAFE,
 * pinned), and a negated absence ("without no blockers") is nonsense
 * English. The re-test guard below now removes EVERY absence span before
 * BLOCK_VERDICT_RE re-tests, so multiple absences ("no blockers, no
 * vetoes") do not each resurrect the other's match.
 * Ticket 5529ac5f (2026-10-25, chat 7d917a4e review of PR #1969): the
 * negator vocabulary was NON-prefix-blind — the reviewer house idiom
 * "two NON-BLOCKING LOW findings" on the verdict line's own paragraph
 * survived the strip and the raw-value BLOCK_VERDICT_RE re-test read the
 * NEGATED word as a BLOCK verdict, inverting the lane's own explicit
 * "Verdict: MERGE-SAFE — zero BLOCKING findings." line (live digest
 * stamped NOT-MERGE-SAFE over it). The NON- arm is STRICT-ATTACHED:
 * NON[-\s]?(family) with ZERO filler words, and its family list mirrors
 * BLOCK_VERDICT_RE's exactly (any word that arm can read negative raw
 * must strip when NON-prefixed — NON-FAILING included). A filler arm
 * ("non trivial failures remain") would strip a LIVE negative and mint
 * the DANGEROUS direction — pinned red in the 5529ac5f suite.
 */
const ABSENT_BLOCK_RE = /\b(?:NO|NOT|ZERO|0|WITHOUT|NIL)\s+(?:BLOCKS?|BLOCKERS?|BLOCKED|BLOCKING|FAILS?|FAILED|FAILURES?|REJECTS?|REJECTED|REFUSALS?|VETOES?)\b|\bNON[-\s]?(?:BLOCK(?:ERS?|ED|ING|S)?|FAIL(?:URES?|ED|ING|S)?|REJECT(?:ED|S)?|REFUS(?:ED|ES?|AL)|VETO(?:ED|ES?|S)?)\b|\b(?:NO|ZERO|0|WITHOUT|NIL)\s+(?:[a-z]+\s+){0,2}?(?:BLOCKS?|BLOCKERS?|BLOCKED|BLOCKING|FAILS?|FAILED|FAILURES?|REJECTS?|REJECTED|REFUSALS?|VETOES?)\b|\b(?:BLOCKS?|BLOCKERS?|BLOCKED|BLOCKING|FAILURES?|FAILED|REJECTED|REFUSALS?|VETOES?)\s+(?:ISSUES?|FINDINGS?|PROBLEMS?|CONCERNS?|BLOCKERS?)?\s*(?:ARE\s+)?(?:RESOLVED|FIXED|CURED|CLEARED|GONE|ADDRESSED)\b|\b(?:BLOCKING|BLOCKERS?|FAILURES?|VETOES?):\s*0\b/i;
/** Bounded free window between a positive verdict token and a CONDITION word
 * (ticket 4baa7c3e, round 2): any characters except a sentence boundary
 * (`.`, `!`, `?`) or a newline — the condition word must sit in the SAME
 * sentence as the token, within 40 chars. Round 1's punctuation-keyed class
 * could not span a closing paren plus a following dash/comma/colon
 * ("SAFE TO MERGE (all good) — once CI is green") nor a parenthetical tail
 * before the close ("(SAFE TO MERGE — verified) once CI is green"), because
 * it allowed only ONE separator unit. Letters and digits are deliberately
 * allowed here: the CONDITION arm has no absence-guard to bypass, so its
 * only failure mode is over-match — this module's documented safe direction
 * (a false NOT-MERGE-SAFE costs one transcript pull). The sentence-boundary
 * exclusion is the load-bearing rail (c90958af F3: "MERGE-SAFE. Once CI is
 * green we ship." stays positive) — the rail is the PERIOD, never the
 * newline: round 3 (adversarial review of 6e7b7affb, finding 1) restored
 * ONE optional line break inside the window (a markdown line-wrap is the
 * same sentence — 'SAFE TO MERGE\nonce CI is green' must stay negative,
 * and round 1, whose gap used \s*, already caught it); '\r' rides the
 * either-side character classes so CRLF pastes work. */
const COND_WINDOW_SRC = String.raw`(?:[^.!?\n]{0,40}?\n){0,2}[^.!?\n]{0,40}?`;
/** Punctuation-keyed gap between a positive verdict token and LIVE
 * standing-blocker narration (STANDING arm ONLY): up to three units of
 * punctuation, a bare paren, a full parenthetical, or the token's own
 * parenthetical tail before its closing paren. Deliberately NOT a free
 * window, unlike COND_WINDOW_SRC: this arm's absence guard
 * (no/zero/not/without…) must test the narration's FIRST word, so the gap
 * must never be able to absorb that word. "." joins no unit (the
 * sentence-boundary rule); unit composition is what lets one parenthetical
 * plus one dash span "(all good) — 2 blocking findings remain". Round 3
 * (review finding 1): the inter-unit wrappers tolerate \r\n — a wrapped
 * 'SAFE TO MERGE (all good)\n2 blocking findings remain' is the same
 * standing narration as its single-line twin (whitespace-only wrappers can
 * never swallow the guard word — it is not whitespace). Round 6 (review
 * finding 3): a lead-in word+colon unit — 'Note:', 'Caveat:', 'However:'
 * — is tolerated between the token and the narration; a caveat line is
 * exactly the qualification-lives-below-the-verdict-line class. */
const STAND_GAP_SRC = String.raw`(?:[ \t\r\n]*(?:[,;:]|[—–-]|\(|\)|\([^.)]{0,40}?\)|[^.!?\n()]{0,40}?\)|\b(?:note|caveat)\b\s*[—–:,.]|\b(?:however|but|although|though)\b\s*(?:[,:—–-]|\s))){0,3}[ \t\r\n]*`;
const CONDITION_WORDS_SRC = String.raw`\b(?:ONCE|IF|WHEN|AFTER|PROVIDED|ASSUMING|PENDING|CONDITIONAL(?:\s+ON)?)\b`;
/** A positive token qualified by LIVE standing-blocker narration — "SAFE TO
 * MERGE — 2 blocking findings remain" (ticket 4baa7c3e). No condition word
 * is needed: standing blockers mean "not safe yet" exactly like an unmet
 * condition. Round 2 (adversarial review of c154e084, finding 3): the
 * vocabulary is widened to the module's own documented live reviewer idioms
 * (the sibling STANDING_BLOCKER_RE, review d78f4850 F2) — an IDENTIFIER slot
 * between noun and verb ("blocker C stands", "blocker F2 still stands"),
 * auxiliaries ("two blockers are still standing"), and adjective forms
 * ("findings are still unresolved"). Guards keep POSITIVE absences
 * positive: the leading lookahead refuses not/no/none/zero/without/nil, the
 * count slot is 1-99 only ("0 findings remain" is an absence), and the
 * trailing lookahead refuses a resolution tail ("all blockers remain
 * fixed" is a resolution, not a standing blocker). */
const STANDING_QUALIFIER_SRC = String.raw`(?!(?:not|no|none|zero|without|nil)\s)(?:(?:the|both|all|these|those)\s+)?(?:(?:(?:a\s+)?couple\s+of|[1-9]\d?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|multiple|many|numerous|a|an|one\s+more)\s+)?(?:blocking\s+)?(?:findings?|blockers?|issues?|concerns?|regressions?)\s+(?:(?:[A-Z]\d{0,3}|\d{1,2}|one|two|three)(?:(?:\s*,\s*|\s+and\s+)+(?:[A-Z]\d{0,3}|\d{1,2}|one|two|three))*)?\s*(?:(?:are|is|was|were)\s+)?(?:still\s+)?(?:remain(?:s|ed)?|stand|stands|standing|unresolved|unfixed|open)\b(?!\s+(?:fixed|resolved|addressed|cleared|cured)\b)(?:\s+(?:open|unresolved|unfixed|broken))?`;
/** Round 3 (adversarial review of 6e7b7affb, findings 2-3): the sibling
 * STANDING_BLOCKER_RE's own documented reviewer idioms (d78f4850 F2), read
 * as a QUALIFIER of a positive token — "merge-safe — still a blocker",
 * "merge-safe — the blocker is not yet fixed", "merge-safe — F2 still
 * stands". Guard vocabulary is no/zero/none/without/nil (NOT 'not': "not
 * yet fixed" IS a standing narration, unlike "not one blocker remains"
 * which the main arm's guard keeps positive); a leading "there is/are", a
 * bare "the", and the standing NOUN + auxiliary ("the blocker is not yet
 * fixed", "the finding regressed", "the blocker was reintroduced") are
 * tolerated before the idiom; the regression idiom carries its own
 * resolution-tail guard ("the regression was fixed" is a resolution, not a
 * standing blocker). */
const STANDING_IDIOMS_SRC = String.raw`(?:(?:there\s+(?:is|are)\s+|the\s+)?)(?!(?:no|zero|none|without|nil)\s)(?:(?:(?:a\s+)?couple\s+of|[1-9]\d?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|multiple|many|numerous|a|an)\s+)?(?:(?:blockers?|findings?|issues?|concerns?|regressions?|tests?|[A-Z]\d{1,3})\s+)?(?:(?:is|are|was|were|has|have|had)\s+)?(?:(?:not\s+(?:yet\s+)?(?:been\s+)?(?:fixed|resolved|addressed|cured|cleared)\b(?![^.]{0,60}\b(?:pre-existing|out\s+of\s+scope|deferred|accepted|cosmetic)\b))|still\s+(?:an?\s+)?(?:blockers?|findings?|issues?|concerns?|regressions?|open|unfixed|unresolved|broken)\b|still\s+not\s+(?:yet\s+)?(?:been\s+)?(?:fixed|resolved|addressed|cured|cleared)\b|not\s+yet\s+(?:been\s+)?(?:fixed|resolved|addressed|cured|cleared)\b|(?:has|have|had)\s+not\s+(?:yet\s+)?(?:been\s+)?(?:fixed|resolved|addressed|cured|cleared)\b|(?:been\s+)?(?:regress(?:ed|ion|ions)\b|reintroduc\w*\b)(?!\s+(?:(?:was|were|is|has|have|had|been)\s+)*(?:fixed|resolved|addressed|cleared|cured)\b)|\b[A-Z]\d{1,3}\b[^.!?\n]{0,40}\bstill\s+stands?\b)`;
/** Negative merge-safety markers — scanned over the WHOLE text, they win ties.
 * Includes the off-format negative/conditional phrasings adversarial reviewer
 * f5bdeaf3 reproduced as false-MERGE-SAFE edges (observation O1): negated
 * ship/merge imperatives (CANNOT SHIP / WON'T SHIP / DON'T MERGE …), negated
 * MERGE-SAFE (isn't MERGE-SAFE), and CONDITIONAL positives (MERGE-SAFE once X
 * — which literally means "not safe yet"). A sentence boundary ("SAFE. Once")
 * does NOT trip the conditional lane.
 * Review d78f4850 finding 3 (2026-10-18): the conditional arm tolerated only
 * a dash or a plain space before the condition word, so "MERGE-SAFE, provided
 * CI is green", "MERGE-SAFE (pending CI)" and "safe to merge once CI is
 * green" read MERGE-SAFE once a historical veto was discounted. The arm now
 * tolerates [,;:()] (never "." — the sentence-boundary rule above stands) and
 * a second alternation covers the reversed SAFE TO MERGE spelling.
 * Ticket 4baa7c3e (2026-10-18, found by the abe2a3a2 review): those
 * conditional arms could not see past a closing paren — a CONDITIONAL
 * positive token inside a parenthetical ("Final verdict (SAFE TO MERGE) once
 * CI is green") or followed by one ("SAFE TO MERGE (all good) once CI is
 * green") defeated every arm and fell through to the positive fallback,
 * stamping MERGE-SAFE — the module's documented DANGEROUS direction. Both
 * spellings now route through COND_WINDOW_SRC (round 2: a free bounded
 * window — see its comment; round 1's single-separator class could not
 * compose a close-paren with a following dash/comma/colon, nor a
 * parenthetical tail before the close). The STANDING arm reads a positive
 * qualified by live blocker narration ("SAFE TO MERGE — 2 blocking findings
 * remain", with or without a condition word) negative through
 * STAND_GAP_SRC + the d78f4850-F2 vocabulary. */
const NEGATIVE_RE = new RegExp(
  'NOT[-\\s]MERGE[-\\s]SAFE|NOT\\s+SAFE\\s+TO\\s+MERGE|DO\\s+NOT\\s+MERGE|UNSAFE\\s+TO\\s+MERGE|NOT[-\\s]CLEAN'
  + "|(?:ISN'?T|IS\\s+NOT|AIN'?T)\\s+MERGE[-\\s]?SAFE"
  + "|(?:CAN(?:NOT|'T)|WON'?T|DON'?T|DO\\s+NOT|MUST\\s+NOT)\\s+(?:SHIP|MERGE)\\b"
  + '|MERGE[-\\s]?SAFE\\s*' + COND_WINDOW_SRC + CONDITION_WORDS_SRC
  + '|SAFE\\s+TO\\s+MERGE\\s*' + COND_WINDOW_SRC + CONDITION_WORDS_SRC
  + '|MERGE[-\\s]?SAFE\\s*' + STAND_GAP_SRC + STANDING_QUALIFIER_SRC
  + '|SAFE\\s+TO\\s+MERGE\\s*' + STAND_GAP_SRC + STANDING_QUALIFIER_SRC
  + '|MERGE[-\\s]?SAFE\\s*' + STAND_GAP_SRC + STANDING_IDIOMS_SRC
  + '|SAFE\\s+TO\\s+MERGE\\s*' + STAND_GAP_SRC + STANDING_IDIOMS_SRC,
  'i',
);
/** Positive merge-safety markers. */
const POSITIVE_RE = /MERGE[-\s]SAFE|SAFE\s+TO\s+MERGE/i;
/** 4baa7c3e round 5: the QUALIFIED-POSITIVE arms of NEGATIVE_RE in isolation
 * — a positive verdict token followed by a CONDITION word or live
 * standing-blocker narration, with NO plain negative vocabulary. Used by the
 * explicit-line lane to veto an unqualified positive whose qualification
 * lives elsewhere in the text (round-4 markdown shape) WITHOUT letting a
 * historical negative citation (doctrine-discounted by the fallback's
 * stripHistoricalVerdictAttributions) veto the lane's own explicit line. */
const QUALIFIED_POSITIVE_RE = new RegExp(
  'MERGE[-\\s]?SAFE\\s*' + COND_WINDOW_SRC + CONDITION_WORDS_SRC
  + '|SAFE\\s+TO\\s+MERGE\\s*' + COND_WINDOW_SRC + CONDITION_WORDS_SRC
  + '|MERGE[-\\s]?SAFE\\s*' + STAND_GAP_SRC + STANDING_QUALIFIER_SRC
  + '|SAFE\\s+TO\\s+MERGE\\s*' + STAND_GAP_SRC + STANDING_QUALIFIER_SRC
  + '|MERGE[-\\s]?SAFE\\s*' + STAND_GAP_SRC + STANDING_IDIOMS_SRC
  + '|SAFE\\s+TO\\s+MERGE\\s*' + STAND_GAP_SRC + STANDING_IDIOMS_SRC,
  'i',
);
/** Explicit "BLOCKING: n" / "BLOCKING FINDINGS: n" line (heading marks tolerated; spelled-out numbers too — da70e157 advisory ⑦). */
const BLOCKING_COUNT_RE = /^[>\s*•\-–#]*BLOCKING(?:\s+FINDINGS)?:\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/im;
/**
 * Lines that LABEL a finding as blocking ("- BLOCKING: …", "1. **BLOCKING** …").
 * da70e157: heading marks (`#`) join the decorations — reviewers write
 * "### BLOCKING 1 — the delivered value…" and those headings ARE the findings
 * (occurrence #1 counted 0 over two real blockers). The bare plural section
 * header "## BLOCKING FINDINGS" is excluded (a header is not a finding —
 * without the lookahead occurrence #4 would count 4 over 3). Overcount is the
 * safe direction: the verdict line is the load-bearing signal, the count is
 * best-effort context.
 */
const BLOCKING_LABEL_RE = /^[>\s*•\-–#]*(?:\d+[.)]\s*)?(?:\*\*)?BLOCKING(?!\s+FINDINGS\b)\b/gm;

/**
 * Mask content that is QUOTED/derived rather than lane-authored (ticket
 * 54af5c27 — see the OWN-WORDS RULE above): fenced code blocks, blockquote
 * lines, markdown table rows, and inline code spans. Line-based (not one
 * mega-regex) so an unterminated fence simply masks to end-of-text — the safe
 * direction. Masked lines are dropped, so no verdict/blocking regex below can
 * match inside them; surviving lines keep their offsets-insensitive shapes
 * (the regexes are line-anchored, not offset-anchored).
 *
 * QUOTED-SPAN RULE (ticket 11a35cfb): double-quoted spans (straight `"…"` and
 * typographic “…”/„…”) name FOREIGN text — a reviewer sub-session TITLE
 * ("… · Merge-safety audit: prod-path"), a chat name, a branch name, a verdict
 * relayed from another chat — and are masked the same way, with ONE carve-out:
 * a span the lane explicitly ATTRIBUTES as a verdict (the cue word "verdict"
 * — case-insensitive, "Final verdict"/"final verdict" included — within
 * VERDICT_ATTRIBUTION_WINDOW chars before the opening quote, same line) still
 * scans: that is the pinned da70e157 relay idiom
 * 'Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO
 * MERGE"', where the quoted verdict IS the reviewer's current word and the
 * build lane's own summary. Masking is fail-closed: an unmatched opener masks
 * to end of line (a foreign fragment can never survive by out-quoting the
 * mask); an apostrophe in "don't"/"won't" is NOT an opener (single quotes are
 * not masked at all).
 */
/** How far before a quoted span the word "verdict" may sit and still count as
 * the lane attributing that span AS a verdict (the relay idiom's longest
 * observed gap: "Final verdict (read this run, message 5cedea7b, 14:26Z): ").
 * Long enough for the idiom's parenthetical, short enough that a verdict word
 * on an EARLIER sentence cannot attribute a later unrelated quote. */
const VERDICT_ATTRIBUTION_WINDOW = 64;

function maskDerivedContent(text: string): string {
  return maskTextKeepRelays(text, true).text;
}
// (maskDerivedContent retained for the pinned-test corpus / external callers;
// the live path calls maskTextKeepRelays directly for the B1 veto flag.)
void maskDerivedContent;

/**
 * The full mask pass over one text (11a35cfb). Returns the masked view (the
 * primary view keeps RELAYED verdict spans; the no-relay view for the count
 * tiers blanks them) plus `quotedNegative` — whether any BLANKED (foreign)
 * quoted span carried a NEGATIVE_RE marker. That flag is the B1 veto: the
 * whole-text POSITIVE fallback declines to assert MERGE-SAFE over a masked
 * reviewer negative ("declines to assert", the da70e157 doctrine — the
 * reviewer's word cannot be silently erased by a mask). It does NOT touch
 * the lane's OWN explicit lines: a pinned 54af5c27 contract keeps a quoted
 * historical negative from overriding the lane's own explicit verdict line,
 * and that contract still governs the explicit tier.
 */
function maskTextKeepRelays(text: string, keepRelay: boolean): { text: string; quotedNegative: boolean; truncatedByOpenQuote: boolean } {
  const kept: string[] = [];
  let fenceMarker: string | null = null;
  let carryOpen = false;
  let quotedNegative = false;
  // F1 (round-3 addendum): STICKY — set once an inherited open state masks
  // non-empty content, NEVER reset by a later blank line. The transient
  // carryOpen-at-end-of-text veto was defeated by ANY trailing "\n" (the
  // empty final element reset the carry, the earlier own-positive then won
  // the fallback over the erased NOT-MERGE-SAFE: '…safe to merge.\n0.5" of
  // drift…\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 3\n' read MERGE-SAFE/0).
  let lostOwnContentByCarry = false;
  for (const line of text.split('\n')) {
    const fenceOpen = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (fenceMarker != null) {
      // Inside a fence: drop every line; the closer ends the mask. An
      // unterminated double quote inside a fence does not carry (the fence
      // owns the line — a quoted span cannot leak out of masked content).
      if (fenceOpen && fenceOpen[1][0] === fenceMarker[0] && fenceOpen[1].length >= fenceMarker.length) {
        fenceMarker = null;
      }
      continue;
    }
    if (fenceOpen) {
      // F2 (round-3 addendum): a fence OPEN genuinely ends the carried span
      // (the code block is its own quoted construct; the carry cannot own
      // it) — the same-paragraph masked lines above stay lost (sticky flag).
      if (carryOpen) carryOpen = false;
      fenceMarker = fenceOpen[1];
      continue;
    }
    // R2-2 (adversarial review): the carried open state ends at a BLANK line
    // — never extends to end-of-text. Real verdict blocks follow paragraph
    // breaks; a stray inch mark ('0.5" of drift') must not erase the lane's
    // own explicit VERDICT:/BLOCKING: lines below it. The blank-line reset
    // is LOAD-BEARING for the pinned shapes (a verdict after a paragraph
    // break keeps its voice) — but it does NOT un-lose content already
    // masked (the sticky lostOwnContentByCarry flag).
    if (carryOpen && line.trim() === '') carryOpen = false;
    const trimmed = line.trim();
    if (carryOpen && trimmed.startsWith('>')) { continue; } // blockquote inside a carried span — stay masked
    if (trimmed.startsWith('>')) continue; // blockquote — quoted content by definition
    if (trimmed.startsWith('|')) continue; // markdown table row — derived/quoted data
    // Inline code spans strip FIRST (they are quoted literals and may
    // themselves contain quote characters — an unmatched " inside a backtick
    // span must not mask past the span's closing backtick).
    const noCode = line.replace(/`[^`\n]*`/g, ' ');
    const dq = maskQuotedSpans(noCode, keepRelay, carryOpen);
    carryOpen = dq.carryOpen;
    if (dq.maskedByCarry) lostOwnContentByCarry = true;
    const sq = maskSingleQuotedPairs(dq.text);
    quotedNegative = quotedNegative || dq.quotedNegative || sq.quotedNegative;
    kept.push(sq.text);
  }
  return {
    text: kept.join('\n'),
    quotedNegative,
    // R2-2 + F1: own content was (or may have been) erased by a carried open
    // quote — either still open at end-of-text (truncated) or closed later
    // over lines that may have carried the lane's verdict. The caller
    // declines positive assertions over such a view (an own positive earlier
    // in the answer must not win the fallback over an erased NOT-MERGE-SAFE).
    truncatedByOpenQuote: carryOpen || lostOwnContentByCarry,
  };
}

/**
 * Re-mask RELAYED verdict spans (11a35cfb count tier): the primary view KEEPS
 * a span the lane attributes as a verdict (the da70e157 relay carve-out — the
 * verdict tier needs it), but the reviewer's words inside that span are still
 * FOREIGN for every other purpose. The blocking-COUNT tiers therefore run
 * their deliberate-count statement scan over this second view: every quoted
 * span — relay or not — blanked.
 */
function stripAllQuotedSpans(maskedText: string): string {
  return maskedText.split('\n').map((line) => maskQuotedSpans(line, false, false).text).join('\n');
}

/**
 * Mask double-quoted spans in one line (11a35cfb). A span whose opening quote
 * is introduced by a verdict ATTRIBUTION — the cue word "verdict" followed by
 * a COLON that hands the quote over, both within
 * VERDICT_ATTRIBUTION_WINDOW chars before the opening quote (same line) — is
 * a RELAYED VERDICT and kept verbatim (the pinned da70e157 relay idiom
 * 'Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO
 * MERGE"'). Any other quoted span is foreign text and blanked. The colon must
 * sit AFTER the cue word and BEFORE the quote — "the reviewer verdict came
 * in: title now "…" " has the colon but it introduces "title now", not a
 * verdict, and the cue-to-quote window still carries an unrelated noun chain.
 * Straight and typographic openers are treated as equivalent; any
 * straight/typographic double-quote character can close (these answers are
 * prose, not code — a mismatched curly/straight pair from a paste is foreign
 * text either way). An unmatched opener masks to end of line (fail-closed:
 * nothing after a dangling quote survives the mask).
 */
function maskQuotedSpans(line: string, keepRelay: boolean, carryOpen: boolean): { text: string; carryOpen: boolean; quotedNegative: boolean; maskedByCarry: boolean } {
  // Fast path: no double-quote character of any kind — nothing to mask
  // (an inherited open state cannot close without one, so it masks the line;
  // a non-empty line so masked is OWN content lost to the carry — F1).
  if (!/["“”„]/.test(line)) {
    return { text: carryOpen ? '' : line, carryOpen, quotedNegative: false, maskedByCarry: carryOpen && line.trim() !== '' };
  }
  const out: string[] = [];
  let i = 0;
  let quotedNegative = false;
  let maskedByCarry = false;
  let open = carryOpen;
  while (i < line.length) {
    if (open) {
      // Inside a span opened on an EARLIER LINE (or an unmatched opener): mask
      // to the first closer; no relay (the opener's line is gone, so the
      // same-line cue+colon attribution can no longer be evaluated). Any
      // non-empty content masked here is potentially OWN content (a verdict
      // line below a dangling quote) — reported as maskedByCarry (F1).
      const closeRel = line.slice(i).search(/["“”„]/);
      if (closeRel === -1) {
        return { text: out.join(''), carryOpen: true, quotedNegative, maskedByCarry: line.slice(i).trim() !== '' };
      }
      const closeAt = i + closeRel;
      const span = line.slice(i, closeAt);
      if (QUOTED_NEGATIVE_VETO_RE.test(span)) quotedNegative = true;
      if (span.trim() !== '') maskedByCarry = true;
      i = closeAt + 1;
      open = false;
      continue;
    }
    const openMatch = OPEN_QUOTE_RE.exec(line.slice(i));
    if (openMatch == null) { out.push(line.slice(i)); break; }
    const openAt = i + openMatch.index;
    const rest = line.slice(openAt + 1);
    const closeRel = rest.search(/["“”„]/);
    const closeAt = closeRel === -1 ? -1 : openAt + 1 + closeRel;
    const span = closeRel === -1 ? rest : rest.slice(0, closeRel);
    const before = line.slice(Math.max(0, openAt - VERDICT_ATTRIBUTION_WINDOW), openAt);
    // Adversarial review F1/B3/R2-1: the cue+colon AND the span itself must
    // be verdict-shaped, asymmetrically by direction — a POSITIVE value relays
    // only BARE (any tail is foreign/conditional text and masks); a NEGATIVE
    // value may carry a tail (NEGATIVE_RE wins the fallback tie, so a relayed
    // negative can only read NOT-MERGE-SAFE). BLOCK-family never relays.
    const isRelay = keepRelay && VERDICT_RELAY_RE.test(before)
      && (RELAY_POSITIVE_BARE_RE.test(span) || RELAY_NEGATIVE_RE.test(span));
    if (isRelay) {
      // A relayed verdict: keep the span verbatim (content AND quotes).
      out.push(line.slice(i, closeAt === -1 ? line.length : closeAt + 1));
    } else {
      // Foreign text: keep up to (not including) the opener, blank the span.
      out.push(line.slice(i, openAt));
      if (QUOTED_NEGATIVE_VETO_RE.test(span)) quotedNegative = true;
    }
    if (closeAt === -1) return { text: out.join(''), carryOpen: true, quotedNegative, maskedByCarry: rest.trim() !== '' };
    i = closeAt + 1;
  }
  return { text: out.join(''), carryOpen: open, quotedNegative, maskedByCarry };
}

/**
 * Mask BALANCED single-quoted pairs (adversarial review F3): 'Merge-safe
 * audit: prod-path' as a reviewer title fabricated MERGE-SAFE. An apostrophe
 * is an OPENER only when preceded by start/space/(/[ (so the apostrophes in
 * "isn't", "won't", "C2's", "reviewers'" are never openers), and a closer
 * only when followed by space/punctuation/end-of-line (so '90s-style
 * contractions do not close). Unmatched openers do NOT mask (single quotes
 * are too ambiguous to fail-closed on — a well-formed foreign PAIR is the
 * fabrication vector). A masked pair's negative marker feeds the B1 veto
 * like any other foreign span. Single-quoted spans never relay — the pinned
 * relay idiom is double-quoted; a single-quoted verdict declines to n/a
 * (safe fail-open).
 */
function maskSingleQuotedPairs(line: string): { text: string; quotedNegative: boolean } {
  if (!/'/.test(line)) return { text: line, quotedNegative: false };
  const out: string[] = [];
  let i = 0;
  let quotedNegative = false;
  while (i < line.length) {
    const openRel = line.slice(i).search(/(^|[\s([])'/);
    if (openRel === -1) { out.push(line.slice(i)); break; }
    const openAt = i + openRel + (openRel === 0 ? 0 : 1);
    const rest = line.slice(openAt + 1);
    const closeRel = rest.search(/['”"’](?=$|[\s.,;:!?)\]}—–-])/);
    if (closeRel === -1) { out.push(line.slice(i)); break; } // no well-formed pair — keep verbatim
    const span = rest.slice(0, closeRel);
    out.push(line.slice(i, openAt));
    if (QUOTED_NEGATIVE_VETO_RE.test(span)) quotedNegative = true;
    i = openAt + 1 + closeRel + 1;
  }
  return { text: out.join(''), quotedNegative };
}
/**
 * The relay idiom's attribution shape: the cue word "verdict", then (at most
 * a short parenthetical/id-number tail — colons inside it allowed, e.g. the
 * idiom's "14:26Z") a COLON that introduces the quote, with only whitespace
 * between that colon and the opening quote. Anchors the carve-out to handover
 * punctuation, not word proximity: "verdict came in: title now "X"" fails the
 * colon-to-quote gap (non-whitespace "title now" between), so the span masks.
 */
const VERDICT_RELAY_RE = /\bverdict\b[\s\S]{0,56}:\s*$/i;
/**
 * …AND the span itself must be VERDICT-SHAPED, ASYMMETRICALLY BY DIRECTION
 * (adversarial review rounds F1→B3→R2-1, ticket 11a35cfb):
 * - A POSITIVE value (MERGE-SAFE / SAFE TO MERGE / APPROVE / LGTM / SHIP IT /
 *   CLEAN / PASS) relays ONLY in BARE form — the value plus optional terminal
 *   punctuation, nothing after. A positive with ANY tail is foreign or
 *   conditional text ('SAFE TO MERGE — says the title of the review',
 *   'MERGE-SAFE — 2 blocking findings remain', 'SAFE TO MERGE once CI is
 *   green') and masks: relaying it stamps an unconditional MERGE-SAFE over a
 *   title, a condition or a count (R2-1, nine repros — the parent already
 *   declined every one).
 * - A NEGATIVE value (NOT-MERGE-SAFE / NOT SAFE TO MERGE / DO NOT MERGE /
 *   UNSAFE TO MERGE / CANNOT SHIP / CAN'T SHIP / WON'T SHIP) may relay WITH
 *   an arbitrary tail: the kept span feeds the whole-text fallback where
 *   NEGATIVE_RE wins ties, so a relayed negative can only read NOT-MERGE-SAFE
 *   (fail-closed) — 'DO NOT MERGE — the isolation boundary leaks', "won't
 *   ship until C2 is re-run" (B2 + the reviewer's tail gap).
 * - BLOCK-family NEVER relays: a kept 'BLOCK — but the fix is merge-safe'
 *   would let the fallback's positive marker win. BLOCK-family spans mask,
 *   and their block SHAPE sets the quotedNegative veto instead (see
 * QUOTED_NEGATIVE_VETO_RE — that also closes the P1 vocabulary hole).
 */
const RELAY_POSITIVE_BARE_RE = /^(?:VERDICT\s*:\s*)?(?:MERGE[-\s]SAFE|SAFE\s+TO\s+MERGE|APPROVE[DS]?|LGTM|SHIP\s+IT|CLEAN|PASS(?:ED)?)\s*[.!]?$/i;
const RELAY_NEGATIVE_RE = /^(?:VERDICT\s*:\s*)?(?:NOT[-\s]MERGE[-\s]SAFE|NOT\s+SAFE\s+TO\s+MERGE|DO\s+NOT\s+MERGE|UNSAFE\s+TO\s+MERGE|CANNOT\s+SHIP|CAN'?T\s+SHIP|WON'?T\s+SHIP)\b/i;
/**
 * The B1 veto vocabulary for BLANKED foreign spans: NEGATIVE_RE's prose
 * markers PLUS the block/rejection SHAPES NEGATIVE_RE deliberately excludes
 * (adversarial review P1: a quoted 'BLOCK — 2 blocking findings stand' or
 * 'REJECTED' must veto the lane's own positive prose exactly like a quoted
 * 'DO NOT MERGE' does). BLOCK is matched only as a verdict shape (followed
 * by a dash/colon/terminal), so ordinary quoted prose ('this code block is
 * fine') does not fire the veto.
 */
const QUOTED_NEGATIVE_VETO_RE = new RegExp(
  NEGATIVE_RE.source + '|\\bBLOCK(?:ED)?\\b\\s*(?:[—–:!.-]|$)|\\b(?:REJECT(?:ED|S)?|REFUS(?:E|ES|ED)|VETO(?:ES|ED)?)\\b|\\bNO[-\\s]?GO\\b|\\bHOLD\\s+(?:THE\\s+)?MERGE\\b|\\bFAILED\\b\\s*(?:[—–:!.-]|$)',
  'i',
);
const OPEN_QUOTE_RE = /["“„]/;

/**
 * A count on the verdict line's OWN tail — "**VERDICT: BLOCK** — 2 blocking
 * findings" (da70e157: occurrences #1/#3/#4 carry no separate BLOCKING: n line
 * anywhere; #4 spells the number out — "three blocking findings").
 */
const BLOCKING_IN_VERDICT_RE = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+blocking\b/i;
/**
 * A deliberate count statement anywhere in the lane's own words (ticket
 * 11a35cfb, SECOND live instance — chat 84887561, msg 51917e21, 20:27Z
 * 2026-10-17): the reviewer names the count in a SECTION HEADING — "## The
 * two BLOCKING findings (both survived my own re-derivation…)" — while the
 * findings themselves carry no BLOCKING label and the verdict line's tail
 * names no count ("VERDICT: BLOCK — the two-probe contract is structurally
 * defeated"). Pre-fix every tier missed it and the digest stamped
 * NOT-MERGE-SAFE · BLOCKING: 0 over two real blockers. The number word
 * BEFORE "blocking" (digits or one..twelve, optional "the") is the
 * deliberate count; the bare "## BLOCKING FINDINGS" section header still
 * matches nothing (no number word). The LAST such statement wins (recency —
 * the same principle as the last VERDICT: line). Runs on the masked text,
 * so a count inside a quoted/table/fenced span stays masked. Overcount is
 * the documented safe direction; the undercount here hid real blockers.
 */
const BLOCKING_COUNT_STATEMENT_RE = /\b(?:the\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+blocking(?![\w-])/gi;
const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * c90958af / cf2601d5: a historical citation of a past review's verdict is not
 * this run's own veto. Strips only attribution shapes from the already-masked
 * view used by the whole-text negative scan:
 *   - a parenthetical that "is/was/were in the transcript" — the ONLY
 *     parenthetical strip that remains (ticket abe2a3a2 deleted the bare
 *     `verdict (…)` form, which required no attribution grammar at all and
 *     erased LIVE parenthetical vetoes like "Final verdict (DO NOT MERGE):
 *     two blocking findings in the diff." down to n/a; a verdict token is
 *     dropped only when the sentence itself says it is transcript history);
 *   - a parenthetical that "is/was/were in the transcript";
 *   - one sentence that both relays a negative (`returned` + NEGATIVE_RE) AND
 *     says the findings were fixed / resolved;
 *   - ROUND 2 (msg 334257bc): a verdict attributed to a PAST review round
 *     ("Round-1 verdict: **NOT-MERGE-SAFE** — …") whose findings are narrated
 *     as fixed/resolved in the SAME or the NEXT sentence — the ticket-lane
 *     close-out template's audit shape, where the resolution lands in the
 *     FOLLOWING sentence ("All blocking findings fixed in commit X").
 * A live `VERDICT:` line, a quoted `Final verdict: "DO NOT MERGE"`, and a later
 * sentence that still says DO NOT MERGE are left in place.
 */

/** A verdict attributed to a PAST review round — "Round-1 verdict:", "the
 * first-cut review verdict:", "the earlier verdict:". "Final verdict" is
 * deliberately absent: that is the LIVE verdict's own title shape.
 * ROUND-BLINDNESS IS INTENTIONAL (d78f4850 advisory 1, matching the
 * c90958af round-2 commit message; re-confirmed unchanged by 528da78a):
 * any PLAIN numbered-round citation is a historical citation by
 * construction — the live verdict's title shapes are "Final verdict" / a
 * bare "VERDICT:" line, never "Round-N verdict".
 * THE `re-` PREFIX DELIBERATELY DOES NOT MATCH (review 528da78a finding 2,
 * 2026-10-18): "Round-2 RE-REVIEW verdict" is the LIVE re-review's own
 * title shape — the standard lifecycle of every ticket lane is
 * fix → re-review, and the re-review's verdict IS the current verdict.
 * Round 3 briefly made the prefix optional (d78f4850 finding 2); that
 * widened the discount over live re-review verdicts ("Round-2 re-review
 * verdict: NOT-MERGE-SAFE — the fix introduced a new race in the latch
 * path. The three round-1 blocking findings were fixed in 256c7399e."
 * lost its veto) and is reverted: a re-review verdict now survives on its
 * own title, without needing standing-blocker narration to protect it.
 * A plain "Round-N verdict" that is really a live current round still
 * survives only through its standing-blocker narration
 * (STANDING_BLOCKER_RE below). */
const PAST_ROUND_ATTRIBUTION_RE = /\b(?:round[-\s]?(?:\d+|one|two|three|four|five)|first[-\s]?(?:cut|round|pass)|second[-\s]?round|third[-\s]?round|initial|earlier|prior|previous|previously)\s+(?:(?:adversarial\s+)?(?:review(?:'?s)?\s+)?)?verdict\b|\bround[-\s]?(?:\d+|one|two|three|four|five)\s+(?:(?:adversarial\s+)?(?:review\s+)?(?:said|wrote|reported)\b)|(?:\b(?:prior|earlier|previous|initial)\s+round\s+(?:was|were|said|wrote|reported)\b)/i;

/**
 * Ticket 8071c98f arm 3 (ported to main by 3c354a95) — the CITATION-RELAY
 * grammar: a review cited BY NAME whose verdict is handed over with a colon
 * ("**Adversarial review** (independent sub-session db3a6628, diff + claim
 * manifest only): verdict NOT-MERGE-SAFE with one blocking finding"). The
 * colon is the handover punctuation — the pinned da70e157 relay idiom's
 * grammar, in prose form. Two shapes, both third-party-provenance-bearing:
 *  - a provenance-bearing review noun phrase ("independent/adversarial/
 *    sub-session/delegate review") optionally followed by a parenthetical,
 *    then a colon and the word `verdict`;
 *  - a bare "review (…)" whose PARENTHETICAL carries a third-party
 *    provenance token (sub-session/session/fresh context/fresh eyes/
 *    diff +/claim manifest/independent/adversarial/delegate).
 * The `re-` lookbehind exclusion (a RE-review is this run's live verdict,
 * never history) and the noun-less pairing requirement live at the call
 * site in stripHistoricalVerdictAttributions (the reviewed contract).
 */
const CITATION_RELAY_ATTRIBUTION_RE = /(?:(?<![\w-])(?:independent|adversarial|sub-session|delegate)\s+review\b\*{0,2}\s*(?:\([^)]{0,200}\)\s*)?|(?<![\w-])review\b\*{0,2}\s*\((?=[^)]{0,200}\b(?:sub-session|session|fresh\s+context|fresh\s+eyes|diff\s*\+|claim\s+manifest|independent|adversarial|delegate)\b)[^)]{0,200}\)\s*):\s*(?:final\s+)?verdict\b/i;

/** Findings narrated as fixed/resolved — the close-out audit's resolution
 * half. Two SHAPE RULES (audit generalization probe, 2026-10-18):
 *   - a resolution is either QUANTIFIED ("all/every/each/both findings
 *     fixed…", auxiliary optional) or PASSIVIZED with an auxiliary
 *     ("findings were fixed") — an ACTIVE-voice "the finding resolved the
 *     ambiguity" (the finding DID the resolving) is NOT a resolution of the
 *     blockers;
 *   - "addressed" followed by a LOCATOR ("addressed below/here/in the next
 *     section") is a POINTER to a discussion, not a completed resolution —
 *     and such a sentence usually narrates a standing blocker anyway.
 * NOUN SCOPE (review 528da78a finding 1, 2026-10-18): only FINDING and
 * BLOCKER nouns count as a resolution of a verdict sentence. Round 3
 * briefly added the generic nouns "issues"/"concerns" (both arms); that
 * let a DIFFERENT-TOPIC resolution ("The lint issues were fixed in
 * commit abc1234", "The docs issues were fixed in PR #1730") discount a
 * live verdict — even flip it to MERGE-SAFE when followed by own-positive
 * prose — and is reverted. `issues` in arm 1 (quantified, pre-existing
 * at 017510e13, adjudicated) and `blockers` in arm 2 are kept as-is.
 * Unrecognized resolution nouns fail CLOSED (the verdict keeps its
 * veto). */
const RESOLUTION_LOCATOR_TAIL = '(?!\\s*(?:below|above|here|there|in\\s+(?:the\\s+)?(?:next|following|detail[s]?|table|appendix|section)))';
const RESOLUTION_CUE_RE = new RegExp(
  '\\b(?:'
  + '(?:every|each|all|both)\\s+(?:\\d{1,2}\\s+|one\\s+|two\\s+|three\\s+|four\\s+|five\\s+|six\\s+)*(?:blocking\\s+)?(?:findings?|blockers?|issues?|of\\s+them)\\s*(?:(?:were|was|are|is|have|has|had)\\s+)?(?:been\\s+)?(?:fixed|resolved|addressed' + RESOLUTION_LOCATOR_TAIL + ')'
  + '|(?:findings?|blockers?)\\s+(?:were|was|are|is|have|has|had)\\s+(?:been\\s+)?(?:fixed|resolved|addressed' + RESOLUTION_LOCATOR_TAIL + ')'
  + '|(?:since|now)\\s+resolved'
  + '|(?:has|have)\\s+since\\s+been\\s+(?:fixed|resolved|addressed)'
  + ')\\b',
  'i',
);

/** A resolution cue only counts when its sentence carries no negation
 * ("not all findings were fixed" is a STANDING verdict, not a resolution).
 * Tested on the sentence with the negative-verdict tokens removed first, so
 * the "NOT" inside NOT-MERGE-SAFE / NOT SAFE TO MERGE cannot self-negate. */
const RESOLUTION_NEGATION_RE = /\b(?:not|no|none|neither|nor|never)\b/i;

/** A live adverse re-review narrates standing or regressed blockers — never
 * discount an attributed verdict sentence whose DISCOUNT WINDOW carries one.
 * Review d78f4850 finding 2 (2026-10-18): the vocabulary missed the
 * platform's own reviewer idioms — "blocker C stands" (identifier between
 * noun and verb), "remains unfixed", "the findings stand", "the blocker is
 * unresolved", "still a blocker". Broadened, with the identifier slot and a
 * bounded noun…unresolved window; the trailing \b keeps "standardize" out. */
const STANDING_BLOCKER_RE = /\b(?:regress(?:ed|ion|ions|ed again)?|reintroduc\w*|still\s+(?:open|uncovered|unfixed|broken|not\s+fixed|a\s+blocker)|not\s+(?:yet\s+)?(?:fixed|resolved|addressed)|standing\s+blockers?|(?:blockers?|findings?|issues?)\s+(?:\d{1,2}|[A-Z]\d{0,3}|one|two|three)?\s*(?:still\s+)?(?:stand|stands|remain|remains)(?:\s+(?:open|unresolved))?|\b(?:F\d{1,3}|[A-Z]\d{1,3})\b[^.]{0,40}\bstill\s+stands?\b|(?:blockers?|findings?|issues?|concerns?)\b[^.]{0,40}\bunresolved\b|remain(?:s|ed)?\s+(?:open|unfixed)|(?:race|defect|bug|issue|problem|failure|gap|hole)\s+(?:still\s+)?(?:stands|stand|remains|remain)(?:\s+(?:open|at\s+head|unresolved|live))?|(?:race|defect|bug|issue|problem|failure|gap|hole)\s+(?:is|are)\s+(?:still\s+)?(?:there|live|open|unresolved|standing|untouched|present)|(?:guard|pin|gate|suite|test)\s+(?:is|are)\s+(?:hollow|vacuous|gutted|dead|missing)|hollow\s+(?:guard|pin|gate|suite|test))\b/i;

/**
 * Ticket 8071c98f arm 4 (ported to main by 3c354a95) — the NOUN-LESS
 * "Fixed this run:" resolution cue. The ticket-lane close-out idiom resolves
 * the review with a this-run PROVENANCE marker and a colon that introduces
 * the work done, naming no finding/blocker noun ("Fixed this run: DAY2 rows
 * re-dated + non-vacuity assertions"). TOPIC GUARD: a noun-less resolution
 * carries no topic link, so the PROOF half must co-occur in the same
 * sentence (the deliberate-break observation idiom). Bounded: the marker may
 * not carry a possessive 's ("in this run's commit" — a pointer, not a
 * close-out).
 */
const THIS_RUN_RESOLUTION_RE = /\b(?:fixed|resolved|addressed)\s+this\s+run\b(?!\s*'\s*s)/i;
/**
 * The proof half — the DELIBERATE-BREAK OBSERVATION: MUTATION ACTION +
 * ADJACENT assertive confirmation verb (≤12 chars, no negation/modality/
 * deferral head between) + FINDING-DOMAIN OBJECT + FAIL/CATCH outcome.
 * The hyphenated self-composite (mutation-proved/verified) carries
 * action+verb in ONE token (the reviewer's historical-finding idiom). A
 * green/pass outcome under mutation is a VACUOUS pin (F8) and a
 * present-state localizer after the outcome ("FAILS the suite at head")
 * narrates the REAL repo state — both are excluded (lookaheads).
 */
const THIS_RUN_PROOF_RE = new RegExp(
  '\\bmutation[-\\s](?:proved|verified|verifies)\\b[^,;.]{0,80}\\b(?:regressions?|pins?|gates?|suites?|tests?|findings?|blockers?|assertions?|vacuity|checks?)\\b'
  + '|\\bmutation[-\\s](?:re-?check(?:s|ed)?|check(?:s|ed)?|proof|re-?run|run)\\b'
  + '(?![^,;]{0,12}\\b(?:failed|fails|failing|not|no|never|without|queued|pending|planned|scheduled|missing|tomorrow|will|would|shall|should|may|might|cannot|can\'t|couldn\'t|didn\'t|doesn\'t|hasn\'t|isn\'t|wasn\'t|to)\\b)'
  + '[^,;]{0,12}\\b(?:confirms?|confirmed|proves?|proved|verified|verifies|observes?|observed|shows?|showed)\\b'
  + '[^,;.]{0,80}\\b(?:regressions?|pins?|gates?|suites?|tests?|findings?|blockers?|assertions?|vacuity|checks?)\\b'
  + '[^,;.]{0,30}?\\b(?:now\\s+)?(?:fails?|failed|FAILS|catches?|caught|is\\s+red)\\b'
  + '(?![^.]{0,24}\\b(?:at\\s+(?:the\\s+)?(?:new\\s+|latest\\s+|current\\s+)?(?:head|tip)|on\\s+(?:main|origin|the\\s+(?:fix\\s+)?branch|the\\s+rebased\\s+branch|the\\s+latest\\s+commit)|after\\s+the\\s+(?:rebase|fix|patch|merge|deploy)|in\\s+(?:the\\s+)?(?:current|deployed)\\s+build|in\\s+CI|in\\s+prod(?:uction)?|under\\s+load|on\\s+the\\s+second\\s+run|today|currently|again)\\b)',
  'i',
);
const THIS_RUN_PROOF_ACTION_RE = /\b(?:confirms?|confirmed|proves?|proved|verified|verifies|observed|observes|shows?|showed|caught|catches)\b/i;
/** Round-5 (reviewer 09ec3c07 F2): a NOUN-LESS resolution names no findings,
 *  so nothing bounds its coverage — a PARTIAL fix ("one of the two
 *  findings", "only part of the fix") must fail CLOSED (the noun-ful arm's
 *  all/every/each/both quantifier is what makes it full-coverage). */
const PARTIAL_RESOLUTION_RE = /\b(?:one\s+of\s+(?:the\s+)?(?:two|three|four|five|\d{1,2})|only\s+(?:one|part|some|a\s+part|partial)|part\s+of\s+(?:the\s+)?(?:fix|findings?|work)|some\s+of\s+(?:the\s+)?(?:findings?|blockers?))\b/i;
/** TOPIC LINK (independent review finding 3): the noun-less resolution's
 *  finding-domain object must overlap the VETO sentence's own finding
 *  vocabulary ("the N1 pin" resolving a "latch race" veto = no overlap = no
 *  discount). Checked at the pairing site against the veto sentence. */
const FINDING_OBJECT_RE = /\b(?:[Ff]\d{1,3}|[A-Z]\d{1,3}|regressions?|pins?|gates?|suites?|tests?|findings?|blockers?|issues?|concerns?|assertions?|vacuity|latch|race)\b/g;

/**
 * Ticket 8071c98f arm 5 (ported to main by 3c354a95) — the TEST-DOMAIN and
 * MUTATION-QUALIFIED GATE-NARRATION carves. A "regression <test-noun>"
 * phrase is how a fix PINS a defect, never a standing blocker; the noun
 * "regression" as the subject of a pass/fail outcome about a TEST GATE is
 * finding narration ("reviewer mutation-proved a pre-N1 gate regression
 * passed 59/59") or its proof ("my mutation re-check confirms the pre-N1
 * regression now FAILS the suite"), never a statement that a blocker stands
 * at head. Both carves are bound to their provenance markers and both keep
 * BARE shapes vetoing (fail-closed, pinned in the 8071c98f suite).
 */
const REGRESSION_TEST_DOMAIN_RE = /\bregression\s+(?:pin|pins|test|tests|suite|suites|guard|guards|coverage)\b(?![^.]{0,250}\b(?:still|remains?|unresolved|broken|broke|open|fail(?:s|ed|ing)?|red|vacuous|vacuously|bypassed|gutted|hollow|dead|skipped|missing|deleted|no-?op|hides?|mask(?:s|ed|ing)?|has\s+a\s+hole|has\s+a\s+gap|lets?\s+the\s+\w+\s+through)\b)/gi;
const REGRESSION_GATE_NARRATION_RE = /\bmutation[-\s]?(?:re-?check(?:s|ed)?|check(?:s|ed)?|proved|proof)\b[^.]{0,60}\bregression\s+(?:passed|passes|failed|fails|now\s+FAILS)\b(?![^.]{0,40}\b(?:at\s+head|at\s+the\s+current\s+head|at\s+(?:the\s+)?(?:new\s+|latest\s+|current\s+)?(?:head|tip)|on\s+(?:main|origin|the\s+branch|the\s+fix\s+branch|the\s+rebased\s+branch|the\s+latest\s+commit|main\s+today)|in\s+the\s+current\s+build|in\s+the\s+deployed\s+build|after\s+the\s+rebase|after\s+the\s+fix|since\s+the\s+rebase|still|currently|as\s+of|right\s+now|today|again)\b)/gi;

/**
 * Ticket 8071c98f arm 2 (ported to main by 3c354a95) — the NOUN-MODIFIER
 * usage mask (specimen: chat 3ad495e3 msg d8810422): "live parenthetical
 * NOT-MERGE-SAFE vetoes degrade to n/a" — the verdict VALUE as an
 * attributive MODIFIER of a plural mechanism noun is a class NAME, not a
 * verdict anyone issued. Runs ONLY in the whole-text fallback lane, after
 * the historical/relay discounts, never on an explicit VERDICT: line or a
 * quoted relay span.
 * REVIEW FIX F2-EXT (adversarial review of this change, finding F2-EXT —
 * "The reviewer's DO NOT MERGE vetoes degrade to nothing" inverted to
 * MERGE-SAFE): a mechanism narration says WHERE THE STAMP GOES — a bounded
 * stamp-destination outcome. The outcome slot is therefore the n/a token
 * OR an ERASED span (the masker erased a backticked `n/a`, so no
 * letter/digit follows "to" — the d8810422 specimen's own shape). Any
 * VISIBLE word after "to" ("nothing", "silence", "a warning") keeps its
 * live veto.
 */
const VERDICT_NOUN_MODIFIER_RE = /\b(?:NOT[-\s]MERGE[-\s]SAFE|DO\s+NOT\s+MERGE|UNSAFE\s+TO\s+MERGE|NOT\s+SAFE\s+TO\s+MERGE)\s+(?:vetoes|verdicts|stamps|markers|tokens)\s+degrade[sd]?\s+to\s+(?:n\/a\b|(?![a-z0-9]))/gi;
/**
 * REVIEW FIX F2 (adversarial review finding F2 — "The reviewer asserts
 * NOT-MERGE-SAFE …" inverted to MERGE-SAFE): the value as the OBJECT of a
 * stamping verb is mechanism narration ONLY when a MECHANISM subject is
 * named inside the match — the class/stamp/field/token whose stamping is
 * being described. "The four classes now stamp NOT-MERGE-SAFE with the
 * field" is mechanism; "the reviewer asserts/carries NOT-MERGE-SAFE" is a
 * LIVE verdict (a reviewer is never a stamping mechanism). The subject
 * guard must be INSIDE the match so a live verdict sentence that merely
 * CONTAINS a mechanism noun elsewhere ("…stamp NOT-MERGE-SAFE", said the
 * reviewer about the class) still vetoes.
 */
const VERDICT_STAMPING_OBJECT_RE = /\b(?:class(?:es)?|stamp(?:s)?|field|token|marker|mechanism|detector|outcome\s+line)s?\s+(?:now\s+)?(?:stamp[sd]?|read[sd]?\s+as|carries|carry|degrades?\s+to|asserts?|asserted|vetoes|vetoed)\s+(?:the\s+|their\s+|all\s+|every\s+)?(?:NOT[-\s]MERGE[-\s]SAFE|DO\s+NOT\s+MERGE|UNSAFE\s+TO\s+MERGE|NOT\s+SAFE\s+TO\s+MERGE)\b/gi;

function stripHistoricalVerdictAttributions(text: string): string {
  // Ticket abe2a3a2: this function once ALSO stripped a bare `verdict (…)`
  // parenthetical with NO attribution grammar, which erased a LIVE
  // parenthetical veto ("Final verdict (DO NOT MERGE): …") down to n/a.
  // That strip is deleted: the one strip below requires the sentence itself
  // to attribute the parenthetical to the transcript, so a parenthetical
  // verdict with no attribution keeps its voice.
  const out = text.replace(/\(([^)]{0,200})\)\s+(?:is|was|were)\s+in\s+the\s+transcript/gi, ' ');
  const sentences = out.split(/(?<=[.!?])\s+/);
  const negG = new RegExp(NEGATIVE_RE.source, 'gi');
  // 8071c98f arm 4 (ported by 3c354a95): the noun-less "Fixed this run:" cue
  // joins the resolution set WITH a proof co-presence guard — a noun-less
  // resolution names no findings/blockers, so it carries no topic link to the
  // vetoed finding ("Fixed this run: docs updated" must not discount a
  // latch-race veto). The proof cue is RE-VERIFICATION ACTIONS ONLY; the KIND
  // is load-bearing: a NOUN-FUL resolution ("All blocking findings were
  // fixed in commit abc1234") is the LIVE reviewer-deliverable shape when
  // the attribution is a bare citation — the citation-relay arm pairs ONLY
  // with the noun-less this-run close-out; the landed round arm keeps its
  // noun-ful pairing. A PARTIAL noun-less fix fails CLOSED.
  const resolutionKind = (s: string): 'nounful' | 'nounless' | null => {
    if (RESOLUTION_NEGATION_RE.test(s.replace(negG, ' '))) return null;
    if (RESOLUTION_CUE_RE.test(s)) return 'nounful';
    if (PARTIAL_RESOLUTION_RE.test(s)) return null;
    if (THIS_RUN_RESOLUTION_RE.test(s) && THIS_RUN_PROOF_RE.test(s) && THIS_RUN_PROOF_ACTION_RE.test(s)) return 'nounless';
    return null;
  };
  const drop = new Array<boolean>(sentences.length).fill(false);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (!NEGATIVE_RE.test(s)) continue;
    const next = sentences[i + 1] ?? '';
    // The DISCOUNT WINDOW (review d78f4850 finding 1, 2026-10-18): the
    // verdict sentence, the resolution sentence, and the sentence AFTER the
    // resolution sentence. Standing/regressed-blocker narration anywhere in
    // that window — "with the exception of F3, which remains open" inside
    // the resolution sentence itself, "However F4 was regressed by the
    // merge" in the following one — kills the discount: the finding was NOT
    // resolved, so the attributed verdict is this run's live state, not
    // history. Previously the guard tested only the verdict sentence `s`,
    // so all of those lost a live veto.
    // 8071c98f arm 5: the window is computed on the TEST-DOMAIN-CARVED view —
    // a "regression test/pin/suite" phrase (a fix PINS a defect; it does not
    // narrate one standing) and mutation-qualified gate narration must not
    // look like standing blockers. Every other "regression" shape keeps its
    // guard.
    const carveWindow = (w: string): string =>
      w.replace(REGRESSION_TEST_DOMAIN_RE, ' ').replace(REGRESSION_GATE_NARRATION_RE, ' ');
    // 4baa7c3e rounds 6-7 (reviewer finding 4, then round-7 finding 1): a
    // same-sentence BARE full-coverage resolution ("…; both were fixed in
    // 256c7399e", "every one was fixed") resolves the same sentence's
    // narrated blockers — the BARE quantifier (no noun between it and the
    // auxiliary) means the antecedent is the sentence's own subject, so a
    // different-topic resolution ("both lint errors were fixed") cannot fire
    // it (the 528da78a noun-scope doctrine). Round 7 (review finding 1): the
    // carve-out may NOT neutralize the sentence's own standing narration when
    // that narration lives in a LATER SEMICOLON CLAUSE — "…; both were fixed;
    // F3 remains open" is a live veto in its most natural close-out phrasing,
    // and the except-lookahead cannot see past a ';'. The discount therefore
    // fires ONLY when the sentence carries NO standing narration the tail
    // test can see anywhere in itself: standingInS vetoes, fullCoverage or
    // not. (Round-8 review note: auxiliary standing forms the bare
    // STANDING_BLOCKER_RE tail test cannot see — "the latch race has not
    // been resolved", "F2 has not been fixed" — return to the main reading
    // here; documented as a boundary class, not a defect.)
    // 8071c98f dispatch-2 merge note: fullCoverage is a NOUN-FUL shape (a
    // bare quantifier resolving the sentence's own narrated finding nouns),
    // so it feeds resolutionInS but NEVER the noun-less citation-relay
    // pairing below — the XR-1/XR-3 reviewer contracts (citation grammar
    // pairs only with the noun-less this-run close-out) are preserved.
    const fullCoverageRe = /\b(?:both|all|every\s+one|each)\s+(?:were|was|are|is|have\s+been|has\s+been|had\s+been)\s+(?:fixed|resolved|addressed)\b(?![^;.]*\b(?:except|but|however|save\s+for|aside\s+from|other\s+than|while|though)\b)/i;
    const kindInS = resolutionKind(s);
    const fcMatch = fullCoverageRe.exec(s);
    const fullCoverageInS = fcMatch != null;
    const resolutionInS = kindInS != null || fullCoverageInS;
    // kindInNext keeps BOTH sides' landed gating: the next sentence is a
    // resolution candidate only when S itself carries no resolution at all.
    const kindInNext = kindInS == null && !fullCoverageInS ? resolutionKind(next) : null;
    const resolutionInNext = kindInNext != null;
    const window = resolutionInNext
      ? [s, next, sentences[i + 2] ?? '']
      : [s, next];
    // Round 7 (review finding 1): the positional rule. Standing narration
    // AFTER the resolution point ("…; both were fixed; F3 remains open") is
    // LIVE — the bare resolution did not cover it, and the veto must hold.
    // Standing BEFORE the resolution ("… 2 blocking findings remain; both
    // were fixed in 256c7399e.") is the narrated-then-resolved history the
    // bare quantifier resolves — historical.
    // Round 8 (round-7 review finding 4): an ABSENCE tail after the
    // resolution ("…; both were fixed; no blockers remain") is a
    // discount-confirmation, not standing — mask it before the tail test or
    // it vetoes the very discount it confirms.
    const tail = fcMatch != null
      ? s.slice(fcMatch.index + fcMatch[0].length).replace(/\b(?:no|zero|none|without)\s+(?:blocking\s+)?(?:blockers?|findings?|issues?|concerns?|regressions?)\s+(?:remain|remain\s+open|stand|stands|are\s+left)\b/gi, '')
      : '';
    const standingAfterResolution = fcMatch != null && STANDING_BLOCKER_RE.test(carveWindow(tail));
    const standingInS = STANDING_BLOCKER_RE.test(carveWindow(s)) && (!fullCoverageInS || standingAfterResolution);
    const standingBeyondS = window.slice(1).some((w) => STANDING_BLOCKER_RE.test(carveWindow(w)));
    const standingInWindow = standingInS || standingBeyondS;
    // Landed shape (fddd77b25): a `returned` relay whose own sentence says
    // the findings were fixed — and whose window narrates nothing standing.
    if (/\breturned\b/i.test(s) && resolutionInS && !standingInWindow) { drop[i] = true; continue; }
    // Round-2 shape: attributed to a PAST round, not narrating a standing
    // blocker, resolved in the same or the next sentence.
    const pastRound = PAST_ROUND_ATTRIBUTION_RE.test(s);
    // 8071c98f arm 3 (ported by 3c354a95): the CITATION-RELAY grammar joins
    // the attribution set — "**Adversarial review** (independent sub-session
    // db3a6628, …): verdict NOT-MERGE-SAFE with one blocking finding" cites
    // the review by name and hands its verdict over with a colon (the
    // handover punctuation; the pinned da70e157 relay idiom's grammar, in
    // prose form). The citation arm pairs ONLY with the NOUN-LESS this-run
    // close-out: a live reviewer deliverable ("Independent review (fresh
    // context, diff + manifest only): verdict NOT-MERGE-SAFE — two blocking
    // findings … All blocking findings were fixed …") carries the SAME
    // citation grammar, and its noun-ful resolution is the AUTHOR's
    // narration of the fix, not the review's own resolution — pairing the
    // citation grammar with noun-ful resolutions discounted LIVE reviewer
    // verdicts (XR-1/XR-3, two MERGE-SAFE inversions, review round 1 F3).
    // The re-review exclusion (the "re-" prefix that the docblock documents
    // as a deliberate fail-closed) is preserved by the lookbehind on the
    // arm. The round arm keeps both pairings: a round marker is a PROVENANCE
    // marker by construction. The noun-less pairing additionally requires a
    // TOPIC-LINK OVERLAP — the resolution's finding-domain object must
    // overlap the VETO sentence's own finding vocabulary.
    const resText = kindInS === 'nounless' ? s : next;
    const vetoObjects = new Set((s.match(FINDING_OBJECT_RE) ?? []).map((t) => t.toLowerCase()));
    const resObjects = (resText.match(FINDING_OBJECT_RE) ?? []).map((t) => t.toLowerCase());
    const topicLinked = resObjects.some((t) => vetoObjects.has(t));
    const citationRelay = CITATION_RELAY_ATTRIBUTION_RE.test(s)
      && (kindInS === 'nounless' || kindInNext === 'nounless')
      && topicLinked;
    if (!pastRound && !citationRelay) continue;
    if (standingInWindow) continue;
    if (resolutionInS) { drop[i] = true; continue; }
    if (resolutionInNext) drop[i] = true;
  }
  return sentences.filter((_, i) => !drop[i]).join(' ');
}

/**
 * Best-effort verdict + blocking-finding count from a run's FULL final answer.
 * Precedence: the STRUCTURED VERDICT FIELD (b36a150e — a machine-readable JSON
 * line, not-merge-safe wins outright, merge-safe gated by the prose negative
 * tests) → the LAST explicit `VERDICT:` line (a reviewer's final word beats an
 * early quoted one) → keyword scan with negative-beats-positive bias → n/a.
 * Blocking count: a structured field's own "blocking" value (when negative) →
 * explicit `BLOCKING: n` line → the verdict line's own "— n blocking findings"
 * tail (da70e157) → labeled finding lines → 0.
 * Every prose regex runs on maskDerivedContent(text) — the lane's OWN words
 * only; the structured field is read pre-mask (its own contract, above).
 */
export function extractRunVerdict(finalText: string): { verdict: ExtractedRunVerdict; blocking: number } {
  const masked = maskTextKeepRelays(String(finalText ?? ''), true);
  const text = masked.text;
  const quotedNegative = masked.quotedNegative;
  // R2-2 (adversarial review): an open quote never closed truncates the
  // masked view at the stray opener — everything after it (possibly the
  // lane's own verdict block) is gone. Positive assertions over the
  // surviving prefix would stamp MERGE-SAFE over an erased negative; decline
  // them. Explicit-line negatives and the quotedNegative veto still fire —
  // they can only read NOT-MERGE-SAFE, and a real verdict ABOVE the stray
  // quote must keep its voice.
  const truncatedByOpenQuote = masked.truncatedByOpenQuote;
  // STRUCTURED VERDICT FIELD (b36a150e): read with precedence over the
  // explicit-line and whole-text lanes. NEGATIVE fields are read on the RAW
  // text (pre-mask) — a negative the lane relays or quotes is still a
  // negative a supervisor must see (fail-closed, the B1 doctrine) — but
  // (3c354a95) a negative field must live on the author's OWN line: the
  // same sentinel-differential attribution gate the positive runs. The
  // instance-#3 fresh specimen (msg b16bfc50) was the lane's own DELIVERY
  // final DOCUMENTING the field — a backticked example
  // `{"verdict":"NOT-MERGE-SAFE","blocking":2}` in inline code — and the
  // pre-mask read hoisted the documented example over the lane's own
  // delivery. Attribution still fails-closed: an UNATTRIBUTED negative
  // (a fence, blockquote, table row, inline-code span, or quoted/relayed
  // foreign span) is not read as a field, and the value falls to the prose
  // tiers — where the mask has already erased the span (the same foreign
  // text cannot re-enter through prose) and, for a fenced blockquote
  // example, the quoted-negative veto declines to n/a. A field on the
  // author's own line (the live emitter contract, the b36a150e producer
  // replays) keeps its fail-closed win.
  // POSITIVE fields pass the same gate (review F1): the field must live on
  // text the masking contract counts as the author's OWN. The gate is a
  // SENTINEL DIFFERENTIAL through the real masker: replace the field's span
  // with a quote-free sentinel, run the full mask pass, count the field as
  // attributed only if the sentinel survives. Reuses the masker's exact
  // fence/blockquote/table/inline-code/quoted-span/relay/carry semantics —
  // no duplicated grammar (the 4baa7c3e lesson: every hand-rolled
  // approximation mints the next boundary class). Last parse wins (recency,
  // the same principle as the last VERDICT: line) — independently per
  // direction: the last NEGATIVE field is the fail-closed word, and the last
  // ATTRIBUTED positive field is the emitter's own final safe assertion.
  const SENTINEL = '\u0000SV\u0000';
  const attributedField = (raw: string, index: number, length: number): boolean => {
    // keepRelay=false — the NO-RELAY view: every quoted span is dropped,
    // INCLUDING verdict-attributed relays (the da70e157 relay idiom keeps a
    // span for the PROSE verdict regexes to scan, but a relayed span is
    // FOREIGN text — a field inside it is not this author's assertion; the
    // reviewer's F1 repro #8 is exactly a relayed field the lane quotes and
    // then disagrees with). A sentinel that survives THIS view sat on the
    // author's own unquoted, unfenced, un-tabled, non-code line.
    const before = raw.slice(0, index);
    const after = raw.slice(index + length);
    const probe = maskTextKeepRelays(before + SENTINEL + after, false).text;
    return probe.includes(SENTINEL);
  };
  let structuredNegative: { blocking: number | null } | null = null;
  let structuredUnattributedNegative = false;
  let structuredPositiveAttributed = false;
  // 2f14eb79 count corroboration: the LAST positive field's own "blocking"
  // value, read pre-mask on the raw text REGARDLESS of attribution (recency,
  // the same principle as the last VERDICT: line), tracked twice — the last
  // CORROBORABLE field (raw, excluding relay shapes) and the last field on
  // the AUTHOR'S OWN line (attributed, the live emitter contract). A field
  // never supplies a VERDICT (an unattributed/masked-span field stays unread
  // as a verdict per the b36a150e/3c354a95 attribution contract), but when
  // the own-words read is MERGE-SAFE the field's machine count can
  // corroborate the zero against the prose count tiers (see
  // mergeSafeBlocking below). Review round 2, optional hardening: a field
  // on a BLOCKQUOTED or TABLE-ROW line is a RELAY shape — the masker
  // doctrine calls those spans QUOTED/foreign ("the prior lane wrote …"),
  // so its zero never corroborates; inline-code and fenced spans are the
  // self-emission idioms (the ticket specimen wrapped its machine line in
  // backticks) and stay corroborable. An ATTRIBUTED field beats a later
  // unattributed one; an unattributed NONZERO never overrides — overcount
  // stays the safe direction.
  let lastCorroborablePositiveBlocking: number | null | undefined;
  let lastAttributedPositiveBlocking: number | null | undefined;
  const raw = String(finalText ?? '');
  for (const m of raw.matchAll(STRUCTURED_VERDICT_RE)) {
    const value = m[1] === 'NOT-MERGE-SAFE' ? 'NOT-MERGE-SAFE' : 'MERGE-SAFE';
    const blockingVal = m[2] != null ? Math.min(99, Number(m[2])) : null;
    if (value === 'MERGE-SAFE') {
      // Relay-shape exclusion (review round 2 hardening; round-3 N3 aligned
      // to the MASKER'S own line rules): a blockquote line (leading '>') or
      // a markdown table row (leading '|') is quoted/derived foreign
      // content — its field never corroborates. Aligned to the masker's
      // startsWith semantics: a pipe MID-line is the author's own prose
      // (the masker does not mask it), so a field on that line stays
      // corroborable.
      const at = m.index ?? 0;
      const lineStart = raw.lastIndexOf('\n', at) + 1;
      const lineEnd = raw.indexOf('\n', at);
      const physLine = raw.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      const trimmedLine = physLine.trim();
      const relayShape = trimmedLine.startsWith('>') || trimmedLine.startsWith('|');
      // Round-3 N1: a field with NO count key asserts nothing — it must not
      // ERASE an earlier field's count by resetting the tracker to null.
      if (!relayShape && blockingVal != null) lastCorroborablePositiveBlocking = blockingVal;
    }
    // 3c354a95: BOTH directions pass the attribution gate. An unattributed
    // field is NOT a field read at all — the value falls to the prose tiers
    // (the masked view never carried it), fail-closed in each direction the
    // prose tests already guarantee. The b36a150e producer replays (a live
    // emitter's own field on its own line) keep their precedence untouched.
    // REVIEW FIX F1: an unattributed NEGATIVE additionally raises the
    // decline-to-assert veto (see the structuredUnattributedNegative gate
    // below) — the prose tiers cannot see the erased span, so without the
    // veto an own-positive would win the fallback and stamp MERGE-SAFE over
    // the reviewer's negative.
    if (!attributedField(raw, m.index ?? 0, m[0].length)) {
      if (value === 'NOT-MERGE-SAFE') structuredUnattributedNegative = true;
      continue;
    }
    if (value === 'NOT-MERGE-SAFE') {
      structuredNegative = { blocking: blockingVal };
    } else {
      structuredPositiveAttributed = true;
      // Round-3 N1: same no-erasure rule — a no-count field must not reset
      // the attributed tracker (it asserts nothing).
      if (blockingVal != null) lastAttributedPositiveBlocking = blockingVal;
    }
  }
  let explicitLine: string | null = null;
  const countBlockingFromText = (): { blocking: number; explicit: string | null; statementOnly: boolean } => {
    let explicit: string | null = null;
    for (const m of text.matchAll(VERDICT_LINE_RE)) {
      explicit = m[1] ?? '';
      // The FULL physical line carrying the VERDICT: token. The decoration
      // class contains \s (which matches NEWLINES), so with the m-flag a match
      // may START on an earlier blank line — m.index therefore does NOT name
      // the verdict's own line. Anchor on the colon instead: everything from
      // the last newline before it to the next one is the verdict line (the
      // "— 2 blocking findings" tail lives there).
      if (m.index == null) { explicitLine = m[0] ?? null; continue; }
      const k = m[0].search(/VERDICT:/i);
      const verdictAt = m.index + (k < 0 ? 0 : k);
      const lineStart = text.lastIndexOf('\n', verdictAt) + 1;
      const lineEnd = text.indexOf('\n', verdictAt);
      explicitLine = lineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEnd);
    }
    const explicitCount = text.match(BLOCKING_COUNT_RE);
    const parseCount = (raw: string | undefined): number | null => {
      if (raw == null) return null;
      const asNum = Number(raw);
      if (!Number.isNaN(asNum)) return Math.min(99, asNum);
      const word = WORD_NUM[raw.toLowerCase()];
      return word != null ? word : null;
    };
    const tailMatch = !explicitCount && explicitLine != null ? explicitLine.match(BLOCKING_IN_VERDICT_RE) : null;
    const verdictTailCount = tailMatch ? parseCount(tailMatch[1]) : null;
    // 11a35cfb second instance: a deliberate count statement in the lane's own
    // words ("## The two BLOCKING findings…") — LAST one wins (recency). Only
    // consulted when the explicit BLOCKING: n line and the verdict line's own
    // tail are both absent, and only when it AGREES WITH OR EXCEEDS the labeled
    // lines (a stale early count must not undercount a later list of labeled
    // findings — overcount is the safe direction). Runs over the NO-RELAY view:
    // a relayed verdict span is KEPT verbatim in the primary view (the verdict
    // tier's carve-out), but the reviewer's count inside it is still foreign —
    // da70e157's QUOTED_BLOCK_VARIANT pins { n/a, 0 }, not a hoisted 2.
    // 8071c98f (ported by 3c354a95): the statement scan runs on the
    // DOCTRINE-DISCOUNTED view — a count statement inside a sentence the
    // verdict tier just discounted as history ("…: verdict NOT-MERGE-SAFE
    // with one blocking finding — … Fixed this run: …") is the RELAYED count,
    // not this run's live count; live verdict sentences still scan.
    const ownWords = stripAllQuotedSpans(stripHistoricalVerdictAttributions(text));
    let statementCount: number | null = null;
    if (!explicitCount && verdictTailCount == null) {
      for (const m of ownWords.matchAll(BLOCKING_COUNT_STATEMENT_RE)) {
        const c = parseCount(m[1]);
        if (c != null) statementCount = c;
      }
    }
    const labeledCount = Math.min(99, (text.match(BLOCKING_LABEL_RE) ?? []).length);
    // 2f14eb79 review round 2 (blocking finding 1, repros R1–R4): the
    // statement tier is NARRATION mining — the one tier an unattributed
    // (masked-span) field zero may override (it produced this ticket's false
    // 2 from RESOLVED round history). The explicit BLOCKING: n line, the
    // verdict line's own count tail, and labeled finding lines are the
    // author's OWN high-confidence counts — a foreign quoted field zero
    // never zeroes them. statementOnly names a count sourced from the
    // statement tier ALONE (no explicit line, no tail, no labeled findings).
    const statementOnly = !explicitCount && verdictTailCount == null && labeledCount === 0;
    return {
      blocking: explicitCount
        ? parseCount(explicitCount[1]) ?? 0
        : verdictTailCount != null
          ? verdictTailCount
          : statementCount != null
            ? Math.max(statementCount, labeledCount)
            : labeledCount,
      explicit,
      statementOnly,
    };
  };
  const { blocking, explicit, statementOnly } = countBlockingFromText();
  // 2f14eb79 count corroboration, review round 3 (fde4d0d0 blocking finding
  // 1, repros E/F/K/M4/M5): the count tiers and the field trackers measure
  // DIFFERENT things and must not silently rewrite each other. The author's
  // OWN counts — the explicit BLOCKING: n line, the verdict line's own count
  // tail, and labeled finding lines — are the highest-confidence prose
  // counts; a field (attributed OR not) may never zero them, because an
  // attributed field is only "the masker kept my line" — it can be bare
  // prose mid-sentence ("Round 1 emitted {…blocking:0}; this round found
  // two new blockers") or an EARLY own-line field made stale by later
  // findings (no recency check against prose counts). A field's count is
  // honored ONLY when it corroborates a count that came from the statement
  // tier ALONE (statementOnly) — the narration-mined tier that produced
  // this ticket's false 2 from RESOLVED round history — or when the prose
  // tiers found NOTHING (blocking from labeledCount 0 and no explicit
  // line/tail; a clean verdict where the field is the only count voice).
  // Overcount stays the safe direction: an unattributed NONZERO never
  // touches the count, and a field with NO count key asserts nothing (it
  // does not erase an earlier field's count — round-3 N1).
  const positiveFieldBlocking = lastAttributedPositiveBlocking != null
    ? (statementOnly ? lastAttributedPositiveBlocking : null)
    : lastCorroborablePositiveBlocking === 0 && statementOnly
      ? 0
      : null;
  const mergeSafeBlocking = positiveFieldBlocking != null ? positiveFieldBlocking : blocking;
  // Every count tier above runs over the masked text; a structured
  // NOT-MERGE-SAFE carrying its own "blocking" count outranks them (the
  // emitter stated its count machine-readably). The short-circuit sits AFTER
  // countBlockingFromText() so the structured field's fallback count (when it
  // carried none) sees every prose tier, and BEFORE the explicit-line lane —
  // a structured negative outranks even an explicit "VERDICT: MERGE-SAFE"
  // line (the field is the newer, machine-read contract; fail-closed).
  if (structuredNegative != null) {
    return { verdict: 'NOT-MERGE-SAFE', blocking: structuredNegative.blocking ?? blocking };
  }

  if (explicit != null) {
    const v = explicit.toUpperCase();
    // Cross-review defect 1 (2026-10-17): VERDICT_LINE_RE's capture stops at
    // the closing `**`, so a heading verdict's TRAILING qualification ("…** —
    // but NOT MERGE-SAFE until CI is green") never enters v. Pre-fix those
    // lines fell to the whole-text fallback where NEGATIVE_RE won; the
    // heading fix routed them into this lane and the value-only tests read
    // MERGE-SAFE over an explicit negative/conditional — the unsafe
    // direction. NEGATIVE therefore also tests the UPPERCASED FULL PHYSICAL
    // LINE (explicitLine, computed above for the count tier). Side effect,
    // documented and safe: "…— the earlier NOT-MERGE-SAFE concern is fixed"
    // reads NOT-MERGE-SAFE (over-negative fail-closed).
    const lineU = String(explicitLine ?? '').toUpperCase();
    if (NEGATIVE_RE.test(v) || /\bNOT\b/.test(v) || NEGATIVE_RE.test(lineU)) return { verdict: 'NOT-MERGE-SAFE', blocking };
    // 4baa7c3e rounds 4-6 (vertical shadowing + the over-negative class,
    // reviewer findings 4-5 of round 5): the verdict line may carry an
    // UNQUALIFIED positive while its qualification — or a current negative —
    // lives elsewhere in the body ("**VERDICT: SAFE TO MERGE** (all good)\n\n
    // once CI is green", "VERDICT: MERGE-SAFE\nDO NOT MERGE this yet."). The
    // veto runs the FULL NEGATIVE_RE over the DOCTRINE-DISCOUNTED view
    // (stripHistoricalVerdictAttributions — the same view the whole-text
    // fallback uses): a resolved historical citation ("Round-1 verdict:
    // NOT-MERGE-SAFE — 2 blocking findings remain; both were fixed") does
    // not veto the lane's own explicit line, while a CURRENT negative —
    // plain or qualified — does. Quoted foreign spans are already masked out
    // of `text` (maskTextKeepRelays), so the 54af5c27 quoted-historical
    // contract holds. Fail-closed both ways.
    if (NEGATIVE_RE.test(stripHistoricalVerdictAttributions(text))) return { verdict: 'NOT-MERGE-SAFE', blocking };
    const absentM = v.match(ABSENT_BLOCK_RE);
    // Replace EVERY absence span before the BLOCK-family re-test: with only
    // the first replaced, a second absence ("no blockers, no vetoes") kept
    // its family word alive and resurrected the NOT-MERGE-SAFE read.
    if (absentM && !BLOCK_VERDICT_RE.test(lineU.replace(new RegExp(ABSENT_BLOCK_RE.source, 'gi'), ' '))) {
      return { verdict: 'MERGE-SAFE', blocking: mergeSafeBlocking };
    }
    // da70e157: a BLOCK-family VALUE on the explicit line is a negative
    // verdict — "VERDICT: BLOCK" must never be read as MERGE-SAFE.
    if (BLOCK_VERDICT_RE.test(v)) return { verdict: 'NOT-MERGE-SAFE', blocking };
    // R2-2: decline a positive explicit verdict when an open quote truncated
    // the view — a LATER verdict line (last-wins) may have been erased after
    // the stray opener. Fail-closed; negatives above keep their voice.
    // REVIEW FIX F1 (explicit-line half): an UNATTRIBUTED structured negative
    // (the reviewer's field inside a fence/inline-code/blockquote/table/
    // quoted span) must also decline the positive explicit line — the field
    // used to outrank it (b36a150e pre-mask read), and after the attribution
    // gate the erased span is invisible to every prose test, so the lane's
    // own explicit positive would win. Decline to n/a, never MERGE-SAFE.
    if (!truncatedByOpenQuote && !structuredUnattributedNegative && (POSITIVE_RE.test(v) || /\b(CLEAN|SHIP|LGTM|PASS(?:ED)?|APPROVE[DS?]?)\b/.test(v))) return { verdict: 'MERGE-SAFE', blocking: mergeSafeBlocking };
    // Cross-review defect 2: an explicit value with NO recognized vocabulary
    // ("VERDICT: CHANGES REQUESTED", "VERDICT: REWORK") must not shadow the
    // whole-text scan and fail open to n/a — that reintroduced the ticket's
    // #3/#4 flavor for heading lines. Fall through to the fallback so the
    // body's own markers decide (the pre-fix behavior for these shapes).
  }
  // b36a150e structured-positive gate (review F1 tightened): a structured
  // MERGE-SAFE is the emitter's assertion, and the prose around it may
  // contradict it (a false MERGE-SAFE could merge over a blocking finding).
  // It is accepted only when BOTH gates pass: the ATTRIBUTION gate upstream
  // (structuredPositiveAttributed — the field lived on the author's own text
  // per the sentinel differential through the real masker; an unattributed
  // positive — fenced, blockquoted, a table row, inline-code, or quoted/
  // relayed foreign text — is NOT the author's assertion and falls through
  // to the regex fallback, where pre-change main read n/a) AND the prose
  // gate here: the whole-text fallback's own negative tests must all pass —
  // the B1 quoted-negative veto and the truncation veto decline to n/a
  // (a quoted foreign negative, or a possibly-erased later verdict, must
  // not be stamped MERGE-SAFE), and any negative marker the fallback can
  // see flips the read to NOT-MERGE-SAFE. This runs AFTER the explicit
  // VERDICT: lane so a lane that writes BOTH writes its own explicit line
  // (the pre-existing precedence is untouched), and BEFORE the prose
  // fallback so a field beats prose-only positives.
  // structured-negative attribution gate (3c354a95): an UNATTRIBUTED negative
  // field is not read as a field, but it must not silently VANISH either —
  // the prose tiers cannot see it (the mask erased the same span), so an
  // author's own positive would win the fallback and stamp MERGE-SAFE over
  // a negative a reviewer wrote (review F1: fence + "the build is
  // merge-safe" inverted to MERGE-SAFE). Like the B1 quoted-negative veto:
  // decline to assert. An unattributed negative therefore yields n/a —
  // never MERGE-SAFE — whenever the fallback's own negative tests would
  // otherwise pass. The b36a150e FAIL-CLOSED pair pins stay green: a live
  // own-line negative field wins outright BEFORE this veto.
  if (structuredUnattributedNegative) {
    return { verdict: 'n/a', blocking };
  }
  if (structuredPositiveAttributed) {
    const own = stripHistoricalVerdictAttributions(text);
    if (NEGATIVE_RE.test(own)) return { verdict: 'NOT-MERGE-SAFE', blocking };
    if (quotedNegative || truncatedByOpenQuote) return { verdict: 'n/a', blocking };
    return { verdict: 'MERGE-SAFE', blocking: mergeSafeBlocking };
  }
  // da70e157 residual guard (the whole-text fallback lane): "merge-safety" is
  // the REVIEW DIMENSION, not a verdict — occurrence #1's tail carried "the
  // two background worker reports (security, merge-safety)" in plain prose
  // and the unbounded MERGE[-\s]SAFE substring matched inside it, flipping
  // the fallback to MERGE-SAFE over a BLOCK verdict. Word-bound both
  // alternations; the bf30c5d9/54af5c27 fallback markers are unaffected, and
  // NEGATIVE still wins ties (the bf30c5d9 extraction bias).
  // Historical citations ("returned NOT-MERGE-SAFE … every finding was fixed",
  // "verdict (DO NOT MERGE) is in the transcript") are stripped before BOTH
  // scans. The positive fallback used to scan the original text, so
  // `\bMERGE-SAFE\b` matched inside the historical `NOT-MERGE-SAFE` token
  // after the negative scan had already dropped that sentence (c90958af).
  // 8071c98f arm 2 (ported by 3c354a95): the NOUN-MODIFIER and STAMPING-
  // OBJECT usage masks — a verdict VALUE modifying a plural mechanism noun
  // with a following verb ("live parenthetical NOT-MERGE-SAFE vetoes degrade
  // to n/a"), or sitting as the OBJECT of the mechanism's own stamping verb
  // ("all four classes now stamp NOT-MERGE-SAFE with the field"), names the
  // CLASS or the STAMP, not a verdict anyone issued. Runs ONLY in this
  // fallback lane, after the historical/relay discounts, and never on an
  // explicit VERDICT: line (the tier above) or a quoted relay span.
  let own = stripHistoricalVerdictAttributions(text);
  own = own.replace(VERDICT_NOUN_MODIFIER_RE, ' ').replace(VERDICT_STAMPING_OBJECT_RE, ' ');
  if (NEGATIVE_RE.test(own)) return { verdict: 'NOT-MERGE-SAFE', blocking };
  // B1 veto (adversarial review round 2): a masked FOREIGN span carried a
  // negative marker — the reviewer's quoted word ("DO NOT MERGE", "cannot
  // ship"). The mask correctly erased the span, but the lane's own positive
  // PROSE ("Our fix is merge-safe") must not then win the fallback and stamp
  // MERGE-SAFE over it: the combination inverted NOT-MERGE-SAFE→MERGE-SAFE
  // (parent read NOT-MERGE-SAFE via the raw quoted negative). Decline to
  // assert — n/a, the da70e157 "declines to assert" doctrine. The lane's own
  // EXPLICIT VERDICT: line (the block above) is untouched: a pinned 54af5c27
  // contract keeps a quoted historical negative from overriding the lane's
  // own explicit line, and this veto must not invert that.
  if (quotedNegative || truncatedByOpenQuote) return { verdict: 'n/a', blocking };
  if (/\bMERGE[-\s]SAFE\b|\bSAFE\s+TO\s+MERGE\b/i.test(own)) return { verdict: 'MERGE-SAFE', blocking: mergeSafeBlocking };
  return { verdict: 'n/a', blocking };
}

/**
 * The one-line machine-readable header. verdictOverride covers producers whose
 * honest verdict is not in any final answer (the evidence-guard REPLACED lane
 * emits GUARD-REPLACED — the run's claims are NOT DONE until re-verified).
 */
export function buildRunOutcomeLine(opts: {
  outcome: 'completed' | 'failed';
  finalText?: string;
  verdictOverride?: string;
}): string {
  const extracted = extractRunVerdict(opts.finalText ?? '');
  const verdict = opts.verdictOverride ?? extracted.verdict;
  return `${RUN_OUTCOME_PREFIX} ${opts.outcome} · VERDICT: ${verdict} · BLOCKING: ${extracted.blocking}`;
}

/**
 * The second front-loaded line (ticket 954b7910): the persisted final-answer
 * MESSAGE id, so the wake digest that quotes an answer always carries the one
 * citable id for it. Lineage: the 2026-09-14 digest hardening put the source
 * CHAT id on the wake because title-only digests bred "~3 invented ids per
 * wake"; the answer TEXT rode the digest but its message id never got the
 * same treatment — a supervisor whose lane-digest idiom ends "(msg …)" had no
 * lawful id to copy and invented one (chat 41bd202a: "No files found" (msg
 * 40c5cfc2) — id existed nowhere; action-verifier struck it pre-delivery).
 * The id must be the persisted crossModelMessage row id (coding finals
 * dual-write there — coding-data.service appendCodingMessage — which is the
 * table citedMessageRowExists probes, so a digest-carried id EXONERATES
 * instead of convicting). Only pass it when the digest actually quotes the
 * answer (a guard-replaced / cancelled / failed run quotes none).
 */
export const ANSWER_MSG_ID_PREFIX = 'ANSWER_MSG_ID:';

export function buildAnswerMsgIdLine(answerMessageId: string): string {
  return `${ANSWER_MSG_ID_PREFIX} ${answerMessageId} — the persisted final answer of this run (the row this digest quotes). When your note references this answer, cite this id's first 8 chars as 'msg <8 chars>'; never invent, reconstruct or lengthen a message id.`;
}

/**
 * The third front-loaded line (HARNESS-RECEIPTS-AND-CLAIMS, supervisor SOTA
 * round 3, 2026-10-20): what the run's typed finish_run claims came to,
 * DETERMINISTICALLY from the harness's check of them (coding/finish-run.ts
 * FinishRunRecord) — never from the lane's prose. A supervisor reading the
 * wake used to relay a lane's claims after the harness had already rejected
 * them (the verdict lived only in a finish_run loop_metrics row nobody read).
 *   CLAIMS: 3 receipted · 1 unverified (pr_merged 1234: no_receipt) · 2 asserted but undeclared (#338, ab12cd3)
 *   CLAIMS: not checked (no finish_run call) — 2 receipt-backed records this run
 * The record's shape is restated structurally (this module stays a zero-import
 * leaf). Kill switch RUN_OUTCOME_CLAIMS_LINE_DISABLED=1.
 */
export const RUN_CLAIMS_PREFIX = 'CLAIMS:';

export interface RunClaimsRecord {
  source: string;
  claims: number;
  verified: number;
  unverified: number;
  repaired?: number;
  unverifiable?: number;
  rejected?: Array<{ type: string; ref: string; reason: string }>;
  autoClaims?: number;
  /** Id-shaped tokens the finish_run SUMMARY asserts that no declared claim names (finish-run undeclaredSummaryTokens). */
  undeclared?: number;
  undeclaredSample?: string[];
}

/** RUN_OUTCOME_CLAIMS_LINE_DISABLED=1|true|on — no CLAIMS line (read per call). */
export function runOutcomeClaimsLineDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.RUN_OUTCOME_CLAIMS_LINE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** A model-typed claim ref, made safe for a one-line digest: id-ish characters only, bounded. */
const claimRefToken = (ref: unknown): string => String(ref ?? '').replace(/[^\w#.:/@-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || '?';

/** Build the CLAIMS line from a finish_run record ('' when there is none or the switch is on). Pure. */
export function buildRunClaimsLine(rec: RunClaimsRecord | null | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (!rec || typeof rec !== 'object' || runOutcomeClaimsLineDisabled(env)) return '';
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  if (rec.source === 'auto') {
    // No finish_run call (review fix 2026-10-20): NOTHING in the run's answer was checked — never an
    // "· 0 unverified" all-clear. The count is the receipt-derived records the auto-finish listed.
    const k = n(rec.autoClaims);
    return `${RUN_CLAIMS_PREFIX} not checked (no finish_run call) — ${k} receipt-backed record${k === 1 ? '' : 's'} this run`;
  }
  const receipted = n(rec.verified) + n(rec.repaired);
  const unverified = n(rec.unverified);
  const rejected = Array.isArray(rec.rejected) ? rec.rejected : [];
  const shown = rejected.slice(0, 3).map((r) => `${claimRefToken(r?.type)} ${claimRefToken(r?.ref)}: ${claimRefToken(r?.reason)}`);
  const more = unverified > shown.length && shown.length ? `; +${unverified - shown.length} more` : '';
  const detail = unverified && shown.length ? ` (${shown.join('; ')}${more})` : '';
  const unverifiable = n(rec.unverifiable) ? ` · ${n(rec.unverifiable)} unverifiable` : '';
  // Review fix (2026-10-20): ids the summary ASSERTS without declaring them as claims were never checked —
  // a run declaring 1 claim and asserting 3 more must not read "· 0 unverified" alone.
  const undeclaredN = n(rec.undeclared);
  const sample = (Array.isArray(rec.undeclaredSample) ? rec.undeclaredSample : []).slice(0, 3).map(claimRefToken);
  const undeclared = undeclaredN
    ? ` · ${undeclaredN} asserted but undeclared${sample.length ? ` (${sample.join(', ')}${undeclaredN > sample.length ? ', …' : ''})` : ''}`
    : '';
  return `${RUN_CLAIMS_PREFIX} ${receipted} receipted · ${unverified} unverified${detail}${unverifiable}${undeclared}`;
}

/**
 * Prepend the status line to a producer-built summary. IDEMPOTENT (a summary
 * already carrying the line is returned unchanged) so a re-wrap can never
 * double-prefix. Keep the RUN_OUTCOME line FIRST: every downstream cut
 * preserves a prefix. answerMessageId (optional) adds the ANSWER_MSG_ID line
 * directly under it — front-loaded for the same truncation-immunity reason.
 * claims (optional, 2026-10-20) adds the CLAIMS line after them.
 */
export function frontLoadRunOutcome(
  summary: string,
  opts: { outcome: 'completed' | 'failed'; finalText?: string; verdictOverride?: string; answerMessageId?: string | null; claims?: RunClaimsRecord | null },
): string {
  const s = String(summary ?? '');
  if (s.startsWith(RUN_OUTCOME_PREFIX)) return s;
  const claimsLine = buildRunClaimsLine(opts.claims);
  const head = buildRunOutcomeLine(opts)
    + (opts.answerMessageId ? `\n${buildAnswerMsgIdLine(opts.answerMessageId)}` : '')
    + (claimsLine ? `\n${claimsLine}` : '');
  return `${head}\n${s}`;
}

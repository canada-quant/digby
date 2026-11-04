/**
 * FOLLOW-THROUGH detectors (owner directive 2026-09-16, framework item 3).
 * Rides the attention watchdog's 15-minute sweep.
 *
 * Two shapes the 48h rollout watch and the program read-throughs kept finding
 * in supervisor notes, and that no existing lane could see because both are
 * TRUE statements with a missing consequence:
 *
 *  1. DIAGNOSIS WITHOUT ACTION — "lane 3f1c2a9b looks stalled (no receipts in
 *     6h)" … and the next wake says it again. The diagnosis is correct; the
 *     supervisor never sent the nudge, restarted the lane, reassigned the todo
 *     or filed the gap. The verifier cannot strike a true observation, and the
 *     stuck-note backstop only fires on three NEAR-IDENTICAL notes. Here: mine
 *     lane-stall diagnoses per sentence (a stall FRAME — "is/looks/remains
 *     stalled|stuck|idle…", "no receipts in…", "zero-tool", "keeps failing" —
 *     plus an 8-hex id directly after a lane noun) from supervisor notes older
 *     than a grace window, look for an action toward that lane since the RUN
 *     that wrote the note (a receipt naming the lane id, a todo_update on a
 *     todo assigned to it, an agent message posted into it), and when there is
 *     none, wake the supervisor once per lane per day with [FOLLOW-THROUGH] —
 *     act, or say why not in the diagnosis sentence itself. The action set
 *     includes RETIREMENT (ticket 02c0bc79): the owner's 2026-09-20 retire
 *     doctrine is "cancel_schedule on its recurring cadence, then archive_chat",
 *     so a doctrine-correct retirement of the diagnosed lane counts as
 *     follow-through — a cancel_schedule receipt resolved through the surviving
 *     coding_schedules row to that lane, or an archivedAt stamp on that lane
 *     within the run-slack window. A diagnosis with no action (including no
 *     retirement) still strikes; an archive/cancel naming a DIFFERENT chat
 *     never satisfies the diagnosis (target-id bound).
 *
 *  2. UNFILED DECISION — "publishing v0.8.2 is owner-gated on Gates 1–3" with
 *     no owner question open anywhere for that project (canlegal-bench,
 *     2026-09-16). The owner is never asked; the goal waits forever. Here:
 *     mine present-tense WAITING claims ("is owner-gated", "remains blocked on
 *     the owner", "waits on Paul's decision") that cite NO oq_ id, check the
 *     ledger for an open owner question on the supervisor chat / its project
 *     (any open question account-wide for the Fleet Supervisor, which restates
 *     project state), and when none exists file one (flagOwnerQuestion,
 *     machineTriggered — so the answered-topic preflight runs), then post a
 *     notice row in the supervisor chat naming the oq id (or the already-
 *     ANSWERED prior — the spark oq_bd1130d5 class — when the preflight finds
 *     one). A project supervisor's filing goes through Fleet-Supervisor triage
 *     first (owner-questions.ts); the notice says so. Negation is scoped PER
 *     FRAME (ticket f7e9df4c): a gating frame governed by a same-clause
 *     negation ("nothing waits on the owner", "no lane is owner-gated") is a
 *     negative status report — the desired steady state — and never files;
 *     only a frame with no negation in scope counts as a claim. Staleness is
 *     scoped TEMPORALLY (ticket be90502f): a question RESOLVED after the note
 *     was written means the board already moved past the decision the note
 *     describes — the open-question ledger check cannot see it (answered rows
 *     are not open) and the N8 answered-scan is a Jaccard topic match that
 *     differently-phrased questions fail, so without the guard the sweep
 *     re-filed an answered decision as a new card (oq_47ec4300: note 22:15Z,
 *     answer 23:44Z, duplicate filing 23:58Z). The skip posts the
 *     already-answered notice naming the resolved prior; resolutions PREDATING
 *     the note never suppress (the supervisor wrote the claim with the answer
 *     already available — either a genuinely new decision or a supervisor
 *     error the N8 preflight still judges). Filing INTENT is vetoed per
 *     sentence (ticket f26f12ab): a sentence that itself declines or defers
 *     the filing ("Not re-filed … no duplicate card", "declining to file",
 *     "deferring the card", "no owner question needed", "nothing to file")
 *     never auto-files, even when it also carries a live gating frame — the
 *     decline asserts the card exists (the ledger check covers it) or is
 *     unwanted, and the auto-filer must not contradict the note's own filing
 *     decision (oq_9f5995bf was exactly such a decline packaged as a card).
 *
 *  3. UNANSWERED OWNER ASK (tt-rd audit 2026-09-27, finding upward-chatter-5)
 *     — an owner status question ledgered as a kind:'ask' directive
 *     (supervisor-state appendDirective) that is still OPEN after
 *     OWNER_ASK_NUDGE_AFTER_MS (2 h) with no finalize-stamped, non-error
 *     supervisor reply after it wakes the supervisor ONCE ('[FOLLOW-THROUGH]
 *     the owner asked … and got no reply — answer now'); still open after
 *     OWNER_ASK_ESCALATE_AFTER_MS (8 h) → ONE line into the Fleet Supervisor
 *     chat ('[OWNER ASK UNANSWERED 8h] <project>: … — answer it yourself from
 *     the ledger or steer the project supervisor'). Dedupe per directive id
 *     via Redis (the NUDGE_DEDUPE_SEC pattern). The reply check reuses the
 *     project brief's reply-row rule (fleet/supervisor-reply-row.ts), so a
 *     harness envelope never counts as an answer. Independent of the note
 *     cursor: it runs even when the supervisor wrote no note at all (the
 *     tt-rd 19:16Z ask stayed open across ~140 wakes with no nudge). Telemetry
 *     `owner_ask_nudge` {stage: 'nudge' | 'escalate'}. Observe-and-route only.
 *
 * Posture: deterministic, per-user scoped (a supervisor's own chats, receipts
 * and questions), paused/detached project supervisors skipped, best-effort;
 * never throws into the cron loop. Kill switch FOLLOW_THROUGH_DISABLED=1.
 * Telemetry: loop_metrics `follow_through_nudge` and `decision_autofiled`
 * (meta.outcome).
 */

import { createHash } from 'crypto';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { recordLoopMetric } from '../platform/loop-metrics.service';
import { modelToolName } from '../coding/tool-scope';
// Supervisor OFF switch (owner 2026-09-26): a switched-off supervisor is
// neither nudged nor auto-filed for — the sweep drops it like a paused lane.
import { getFleetSupervisorEnabled, getProjectSupervisorsEnabled, recordSupervisorSwitchSkip } from '../platform/supervisor-switch';

const SOURCE = 'follow-through';

/** Notes younger than this are not judged — the supervisor may still be acting. */
export const FOLLOW_THROUGH_GRACE_MS = 90 * 60 * 1000;
/** Notes older than this are history, not a live diagnosis. */
export const FOLLOW_THROUGH_LOOKBACK_MS = 8 * 60 * 60 * 1000;
/** Receipts are credited from this long BEFORE the note row: the row is
 *  persisted lazily after the run's first tool result, so a same-run action
 *  can carry a timestamp a few seconds (or minutes) older than the note. */
export const FOLLOW_THROUGH_RUN_SLACK_MS = 15 * 60 * 1000;
export const FOLLOW_THROUGH_NOTE_FETCH = 12;
export const FOLLOW_THROUGH_MAX_SUPERVISORS = 300;
export const NUDGE_DEDUPE_SEC = 24 * 3600;
export const AUTOFILE_DEDUPE_SEC = 72 * 3600;
/** Detector 3 (tt-rd audit 2026-09-27): an open owner ask this old with no reply is nudged … */
export const OWNER_ASK_NUDGE_AFTER_MS = 2 * 60 * 60 * 1000;
/** … and this old is escalated ONCE to the Fleet Supervisor chat. */
export const OWNER_ASK_ESCALATE_AFTER_MS = 8 * 60 * 60 * 1000;
/** Asks older than this are history — the wake block hides them too (owner-asks.ts OPEN_OWNER_ASKS_MAX_AGE_MS × 1). */
export const OWNER_ASK_LOOKBACK_MS = 72 * 60 * 60 * 1000;
export const OWNER_ASK_DEDUPE_SEC = 24 * 3600;
// Detector 3b (ticket b03d7033): an ANSWERED ask whose order twin is still
// open — the owner's question got a reply (possibly explanation-only), the
// order it carried never got evidence. Nudge the owning supervisor this long
// after the ask; escalate to the Fleet Supervisor at the same 8h bar as
// detector 3. The gap this closes: the exchange dies in the lane's transcript
// with no action and no report-up, so the tier above never sees it.
export const OWNER_ASK_TWIN_NUDGE_AFTER_MS = 4 * 60 * 60 * 1000;
const ASK_TWIN_NUDGE_KEY = (chatId: string, twinId: string) => `follow-through:ask-twin-nudge:${chatId}:${twinId}`;
const ASK_TWIN_ESCALATE_KEY = (chatId: string, twinId: string) => `follow-through:ask-twin-escalate:${chatId}:${twinId}`;
const CURSOR_TTL_SEC = 30 * 86400;
const CURSOR_KEY = (chatId: string) => `follow-through:cursor:${chatId}`;
const NUDGE_KEY = (chatId: string, lane: string) => `follow-through:nudge:${chatId}:${lane}`;
const AUTOFILE_KEY = (chatId: string, hash: string) => `follow-through:autofile:${chatId}:${hash}`;
const ASK_NUDGE_KEY = (chatId: string, directiveId: string) => `follow-through:ask-nudge:${chatId}:${directiveId}`;
const ASK_ESCALATE_KEY = (chatId: string, directiveId: string) => `follow-through:ask-escalate:${chatId}:${directiveId}`;

/** Mirrors attention-watchdog SUPERVISOR_NOTE_ORIGINS — machine-authored supervisor notes only. */
const NOTE_ORIGINS = new Set(['schedule', 'hook', 'machine', 'agent', 'webhook']);

// ── Miners (pure, exported for tests) ────────────────────────────────────────

const SENTENCE_SPLIT_RE = /(?<=\.)\s+(?=[A-Z0-9*\[(\-•"“_`])|\n|\s\|\s/g;
const sentencesOf = (note: string): string[] => String(note ?? '').split(SENTENCE_SPLIT_RE).map((s) => s.trim()).filter((s) => s.length >= 12 && !s.startsWith('>'));

/** An 8-hex id (≥1 letter, so dates never qualify) DIRECTLY after a lane noun: "lane 3f1c2a9b", "session `9b9b9b9b`", "the bounty lane (deadbeef)". */
const LANE_REF_RE = /\b(?:lanes?|chats?|sessions?|workers?)\s+[`"'*(#]*(?=[0-9]*[a-f])([0-9a-f]{8})(?![0-9a-z])/gi;
function laneRefsIn(sentence: string): string[] {
  const out: string[] = [];
  LANE_REF_RE.lastIndex = 0;
  for (const m of sentence.matchAll(LANE_REF_RE)) out.push(m[1].toLowerCase());
  return out;
}
/** Stall FRAME: a present-tense state verb + stall word, or one of the framework's own stall idioms. Bare "idle"/"dead"/"looping" prose never qualifies. */
const STALL_RE = /\b(?:is|are|looks|appears|seems|remains|still|has\s+been|have\s+been|been|stays)\s+(?:stalled|stuck|silent|wedged|hung|unresponsive|idle|dead|quiet|zombie|not\s+progressing|looping|flapping|regressing)\b|\bno\s+(?:receipts?|progress|output|activity|commits?)\s+(?:in|for|since)\b|\bzero[- ]tool\b|\bkeeps?\s+failing\b|\bfailing\s+repeatedly\b|\bwent\s+quiet\b|\bstopped\s+responding\b|\bnothing\s+(?:delivered|landed|merged)\s+(?:in|for|since)\b|\bempty\s+finals?\b/i;
// A sentence that already carries the consequence, a stated reason for inaction, a resolution, history or a conditional is not a bare diagnosis.
const STALL_RESOLVED_RE = /\b(?:recover(?:ed|ing)|resumed|unstuck|no\s+longer|(?:was|were|had\s+been)\s+(?:stall|stuck|idle|silent|dead|hung|wedged|quiet|loop|spinn|flapp|unresponsive|zombie)|cleared|fixed|nudged|restarted|dispatched|reassigned|sent|filed|woke|woken|stopped\s+it|killed|archived|if|unless|would|will|going\s+to|by\s+design|as\s+designed|as\s+intended|expected|deliberately|intentionally|on\s+purpose|leaving\s+it|no\s+action\s+(?:needed|required|taken\s+on\s+purpose)|nothing\s+to\s+do|I\s+(?:sent|nudged|restarted|dispatched|filed|reassigned|woke|stopped|archived))\b|\((?:msg|receipt|ticket)\s+[0-9a-f]{8}/i;

export interface StallDiagnosis { laneId8: string; sentence: string }
/** Lane-stall diagnoses: one per lane per note; sentences carrying an action/reason/resolution/conditional register skip. */
export function mineStallDiagnoses(note: string): StallDiagnosis[] {
  const out: StallDiagnosis[] = [];
  const seen = new Set<string>();
  for (const sentence of sentencesOf(note)) {
    if (!STALL_RE.test(sentence) || STALL_RESOLVED_RE.test(sentence)) continue;
    for (const lane of laneRefsIn(sentence)) {
      if (seen.has(lane)) continue;
      seen.add(lane);
      out.push({ laneId8: lane, sentence: sentence.slice(0, 240) });
    }
  }
  return out;
}

const OQ_REF_RE = /\boq_[0-9a-f]{8}/i;
/** A present-tense WAITING frame — never a bare mention of the owner's decision. */
const GATING_RE = /\b(?:is|are|remains|stays|still|now|currently)\s+(?:owner[- ]gated|gated\s+on\s+(?:paul|the\s+owner)|blocked\s+on\s+(?:paul|the\s+owner)|awaiting\s+(?:paul|the\s+owner)|waiting\s+(?:on|for)\s+(?:paul|the\s+owner)|pending\s+(?:paul|the\s+owner))\b|\bowner\s+(?:decision|ruling|call|approval|sign-?off)\s+(?:is\s+)?(?:pending|outstanding|open|needed|required|still\s+needed)\b|\bwaits?\s+(?:on|for)\s+(?:paul|the\s+owner)\b|\bup\s+to\s+(?:paul|the\s+owner)\s+to\s+decide\b|\b(?:paul|the\s+owner)\s+(?:has|needs|still\s+needs)\s+to\s+(?:decide|rule|approve|sign\s+off)\b/i;
/** Resolution / history / mere-mention arms — a sentence carrying one is not a live claim.
 *  NEGATION is deliberately NOT handled here: a sentence-level negative arm vetoes every
 *  claim in the sentence, including a live one after a clause boundary ("No owner question
 *  is open; the publish call waits on Paul."). Negation is scoped per gating frame below
 *  (ticket f7e9df4c). */
/** Resolution / history / mere-mention arms — a sentence carrying one is not a live claim.
 *  NEGATION is deliberately NOT handled here: a sentence-level negative arm vetoes every
 *  claim in the sentence, including a live one after a clause boundary ("No owner question
 *  is open; the publish call waits on Paul."). Negation is scoped per gating frame below
 *  (ticket f7e9df4c).
 *  Ticket 05f5951e (2026-09-27): the STANDING-RULING arm — "stays blocked on the owner's
 *  standing no-benchmarks ruling" (the tt-rd note, auto-filed as oq_6969b9d7) is a status
 *  line ASSERTING a decision that already exists, the opposite of a decision request; it
 *  auto-filed anyway because the resolved-arm vocabulary had the participles
 *  (ruled/decided/approved) but not the ATTRIBUTIVE phrase. Shape: "standing" + ≤2 word
 *  modifiers + a ruling-family noun (ruling/directive/decision/decree/order/policy/
 *  instruction/precedent). THREE guards keep the genuine-ASK readings mining (review F1
 *  on PR #1096 — the demand phrasings place their demand word OUTSIDE the modifier
 *  window):
 *   (a) modifier function-word EXCLUSION (on/for/in/by/of/to/with/under/until/against/at/
 *       awaiting/pending): the STANCE reading ("standing on the owner") and the WAIT
 *       reading ("standing for a ruling") keep mining;
 *   (b) a DEMAND-VERB LOOKBEHIND immediately before "standing" ("pending a standing
 *       policy", "awaiting a standing directive", "must issue a standing decision") —
 *       a demanded standing-X does not exist yet, so the sentence IS a live ask;
 *   (c) a DEMAND-WORD LOOKAHEAD after the noun, bounded to the same clause (≤24 chars,
 *       no clause boundary): "a standing order is needed", "a standing ruling from the
 *       owner is required" — passive demand forms only; "requires" (ACTIVE — the ruling
 *       requires X of us) is deliberately NOT in the list, because "the standing ruling
 *       requires us to hold" is the EXISTS reading.
 *  A bare "standing question"/"standing item" has no ruling noun and keeps mining.
 *  Sentence-level like the other resolution arms: the acknowledged false-negative
 *  direction (a live claim sharing a sentence with a standing-ruling citation) is the
 *  safe one — the next non-citing note re-arms the net and a real open card blocks the
 *  sweep regardless (the DECLINE_RE doctrine). */
const GATING_RESOLVED_RE = /\b(?:answered|ruled|decided|approved|dismissed|was|were|had\s+been|no\s+longer|acting\s+on|per\s+(?:paul|the\s+owner)|thanks\s+(?:to|for)|following\s+(?:paul|the\s+owner)|in\s+line\s+with|filed\s+(?:an?\s+)?owner\s+question|flag_owner_question|I\s+filed|if|unless|would|will\s+be|(?<!\b(?:pending|awaiting|await|needs?|needed|requires?|required|requiring|requests?|requested|requesting|issue|issues|seeks?|sought|seeking|wants?|wanting)\s+(?:an?|the|his|her|their|its)?\s*)standing\s+(?:(?!on\b|for\b|in\b|by\b|of\b|to\b|with\b|under\b|until\b|against\b|at\b|awaiting\b|pending\b)[\w-]+\s+){0,2}(?:ruling|directive|decision|decree|order|policy|instruction|precedent)(?![^.;:\n]{0,24}\b(?:needed|required|requested|pending|awaited|owed|forthcoming)\b))\b/i;

/** DECLINE/DEFER-to-file arms (ticket f26f12ab): a sentence that itself says it is
 *  NOT filing a card — "Not re-filed … no duplicate card", "declining to file",
 *  "won't file", "deferring the card", "no owner question needed", "nothing to
 *  file" — is a META statement about the note's FILING intent, never an unfiled
 *  decision, even when it also carries an un-negated gating frame: "Not re-filing
 *  — the publish gate still waits on the owner (no duplicate card)" matched
 *  GATING_RE, cleared every negation scope, and auto-filed — the oq_9f5995bf
 *  class (the supervisor explicitly declined; the sweep filed anyway, and the
 *  card had to be housekeeping-closed). The veto is SENTENCE-LEVEL by design:
 *  the decline asserts the card already exists (then openOwnerQuestionExists /
 *  the 72h dedupe covers it) or that filing is unwanted — auto-filing
 *  contradicts the note's own statement either way. The acknowledged
 *  false-negative direction — a decline scoped to one gate sharing a sentence
 *  with a live claim about another ("Won't file for the stale gate; the publish
 *  gate waits on Paul") — is the SAFE direction here: auto-filing is a heuristic
 *  net, the next non-declining note re-arms it, and a real open card blocks the
 *  sweep regardless. Deliberately NOT folded into GATING_RESOLVED_RE: that
 *  regex's doctrine is resolution/history of the WAIT; this is intent about the
 *  FILING — a different axis, kept visible as its own veto. */
const DECLINE_RE = /\b(?:not\s+re-?fil(?:e|ed|ing)|no\s+duplicate\s+(?:card|question|owner\s+question)|declin(?:e|ed|ing)\s+to\s+(?:re-?)?(?:file|raise)|not\s+(?:filing|raising|re-?raising)|(?:won'?t|will\s+not|shall\s+not)\s+(?:re-?)?fil(?:e|ing)|defer(?:red|ring|s)?\s+(?:filing|raising|re-?filing|the\s+(?:card|question|owner\s+question))|no\s+(?:new\s+)?(?:card|owner\s+question)\s+(?:is\s+)?(?:needed|required|necessary)|no\s+need\s+to\s+(?:re-?)?(?:file|raise)|nothing\s+(?:else\s+)?to\s+file)\b/i;

/** Global mirror of GATING_RE — the matchAll target for the per-frame scope check (LANE_REF_RE idiom). */
const GATING_MATCH_RE = new RegExp(GATING_RE.source, 'gi');
/**
 * Gap word for the negation windows (ticket 68a1c868). A gap word may carry
 * INTERNAL dots when they read as an identifier — "ctrl.example.com",
 * "i-020850b4.prod.aws", "v0.8.2" — but a dot that ends a token or starts a
 * new CAPITALIZED token is a sentence boundary and always breaks the window:
 *   head  [^.;:,\n \t]+                 — dot-free head of the token
 *   tail  (?:\.[a-z0-9][^.;:,\n \t]*)* — ".lowercase-or-digit" identifier tails
 * "Nothing in ctrl.example.com is waiting on the owner." (the 68a1c868 incident:
 * auto-filed oq_2cc4131f at 2026-10-24T07:57Z against the ctrl.example.com
 * project supervisor) suppressed NOTHING under the old dot-excluding class
 * `[^.;:,\n \t]+` — the dotted project name could not be consumed as a gap
 * word, the negation scope died and a NEGATIVE status report read as an
 * affirmative owner-wait claim. The compositional class keeps every
 * terminator behavior: "Nothing happened. The gate waits…" (dot+space) and
 * "Nothing happened.The gate waits…" (dot+Capital) both still break the
 * window and keep mining. Because the tail's [a-z0-9] must stay case-SENSITIVE,
 * the three window regexes below are built WITHOUT the i flag, their word
 * alternations case-folded via ci() instead — an i-flag build would fold the
 * identifier class too ([a-z] ≡ [A-Z] under i, and \p{Ll} folds under iu),
 * which re-broke exactly this boundary (a dot before a Capital read as an
 * identifier tail). Known residual (both-direction safe, doubly
 * malformed text only): an unspaced dot before a LOWERCASE token — "Nothing
 * happened.the gate waits on the owner" — reads as an identifier tail and
 * suppresses where main mined; distinguishing that from a real ".cql" tail
 * needs a lexicon, and the shape requires two typos in one sentence (the
 * DECLINE_RE doctrine: the next non-declining note re-arms the net).
 */
const NEG_GAP_WORD_PLAIN_RE_SOURCE = '[^.;:,\n \t]*[a-z0-9][^.;:,\n \t]*';
const NEG_GAP_WORD_DOTTED_RE_SOURCE = '[^.;:,\n \t]*[a-z0-9][^.;:,\n \t]*(?:\\.[a-z0-9][^.;:,\n \t]*)+';
const NEG_GAP_WORD_RE_SOURCE = '[^.;:,\n \t]*[a-z0-9][^.;:,\n \t]*(?:\\.[a-z0-9][^.;:,\n \t]*)*';
/** ROUND 3 (review of PR #1947, finding F1, ticket 68a1c868, 2026-10-24): a
 *  PUNCTUATION-ONLY token that is neither a terminator nor a DASH — an ellipsis
 *  "…", a bare ")", a quote — is a consumable gap word again (round 2's
 *  alnum requirement had made it unconsumable, so "Nothing … waits on the
 *  owner." and "No lane … is owner-gated." mined at the tip while parent and
 *  round-1 suppressed — the ticket's own incident class reborn through
 *  typography). Dashes stay excluded here on purpose: a dash is not gap noise
 *  but a CLAUSE BOUNDARY (D2 — "Nothing in ctrl.example.com — the gate waits…" must
 *  mine) or the opening delimiter of a DASH ASIDE, which has its own frame
 *  below (DASH_PARENTHETICAL_FRAME_RE). The class contains no letters or
 *  digits — a WORD can never match it, so a connective lookahead on this arm
 *  is vacuous and omitted (the WORD/DOTTED arms carry the guards). */
const NEG_GAP_PUNCT_RE_SOURCE = '[^.;:,\\n \\t—–a-zA-Z0-9-]+';
/** Round 2 (cross-family review of 4b655f10, findings D1/D2, 2026-10-24): every gap word
 *  now requires an ALPHANUMERIC (head `…[a-z0-9]…`), so a STANDALONE dash — " — ", " - " —
 *  is no longer a consumable gap word and breaks the window like a semicolon: parent had
 *  absorbed the dash and let the negation reach across a genuinely affirmative post-dash
 *  clause ("Nothing in ctrl.example.com — the gate waits on the owner." wrongly suppressed —
 *  D2). An intra-token dash stays legal ("i-020850b4", "Gates 1–3" — matched as one word,
 *  so "Nothing on Gates 1–3 is waiting…" still suppresses). The plain/dotted SPLIT is the
 *  D1 guard in the generic window below: a plain word consumes its internal dots as
 *  noise, but a DOTTED identifier word is guarded by a connective lookbehind —
 *  "Nothing but deploy.example.com waits…" (exception idiom, must mine) puts the connective
 *  directly before the dotted word and the guard refuses the branch; "Nothing in
 *  ctrl.example.com is waiting…" (negative report) has a plain word before the dotted one and
 *  suppresses. A trailing optional dash class ends the window so an emphatic appositive
 *  ("Nothing — absolutely nothing — waits on the owner.") still negates its frame.
 *
 *  F2 SCOPE (round-3 review of PR #1947): "standalone dash is a clause boundary" is
 *  TRUE ONLY FOR A SPACE-DELIMITED DASH. A GLUED (unspaced) dash rides inside the
 *  gap-word token — "Nothing in ctrl.example.com—the gate waits on the owner." — the dotted
 *  class accepts "ctrl.example.com—the" as one word, so the negation spans it and the
 *  affirmative post-dash claim stays suppressed (parent 6defebc9a mined it — a
 *  pre-existing-from-round-2 FN residual, deliberately documented rather than fixed
 *  here: distinguishing a glued em-dash from an intra-token hyphen needs a lexicon,
 *  and the FN direction is the safe one; see the follow-through F3 residual ticket
 *  family). D2 and D1 both hold for the space-delimited forms. */
/** Case-insensitive word alternation for the case-SENSITIVE window regexes: each
 *  word rendered with per-letter case pairs, so "Nothing"/"nothing" both match
 *  while character classes ([a-z0-9]) keep their case semantics (an i flag
 *  would fold [a-z] to [A-Z] — the identifier tail must stay lowercase-only). */
const ci = (alternation: string): string =>
  alternation.split('|').map((word) => word.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`)).join('|');
const NEG_MARKER_RE_SOURCE = ci('nothing|nobody|none|no|not|never|zero');
const NOTHING_SUBJECT_RE_SOURCE = `${ci('nothing|nobody|none')}|[nN][oO][-\\s]+(?:[oO][nN][eE]|[tT][hH][iI][nN][gG])`;
/** Exception/contrastive connectives that re-arm or keep a claim mining (batch-enumerated
 *  class, review 875216b0 G2 — kept as a shared source so the guard windows test the
 *  same class; see the NOTHING_CLASS_FRAME_RE doctrine below). Built through ci() so
 *  the case-SENSITIVE windows still match a capitalized connective ("Nothing BUT the
 *  publish gate waits…" — review of 573adc97c, finding F2: a lowercase-only list in a
 *  no-i-flag build wrongly suppressed exactly the exception idioms parent mined).
 *  Declared BEFORE NEGATED_FRAME_RE because the round-2 review (D1, 2026-10-24) added
 *  a connective guard to the generic window too — a dotted gap word after a connective
 *  is an exception idiom, not a negation scope. */
const EXCEPTION_CONNECTIVE_RE_SOURCE = `(?:${ci('but|however|yet|though|although|while|whereas|except|other|more|apart|aside|save|besides|beyond|bar|excluding|barring|excepting|saving|minus|plus|less|short|outside|past|exclusive|outwith|otherwise')})`;
/** Multi-word exception connectors ("other than", "apart from", "less than", "short
 *  of", "exclusive of" …). The generic window's dotted-branch lookbehind inspects only
 *  the word IMMEDIATELY before the dotted identifier — for a multi-word connector that
 *  is the TAIL ("than"/"from"/"of"), which is not itself in the connective class, so
 *  "Nothing other than box.example.com waits…" slipped through as a negation scope (round-2
 *  D1, 2026-10-24). This arm matches the HEAD+TAIL pair ending right at the dotted word.
 *  A bare tail WITHOUT its head ("faster than digi.ai", "from cluster.example.com") does NOT
 *  match — a comparative or plain preposition before a dotted identifier is a negative
 *  report's own vocabulary (the 68a1c868 incident shape), never an exception idiom.
 *  "otherwise than" joins as its OWN arm (ticket efb63eb9, round-3 review of PR #1947
 *  finding F3, 2026-10-24): "otherwise" is already in the single-word exception class
 *  (EXCEPTION_CONNECTIVE_RE_SOURCE, the G2 batch enumeration), so the undotted 4–5-band
 *  form "Nothing otherwise than the publish gate waits…" already mined through
 *  NOTHING_CLASS_FRAME_RE's per-slot guard, but the phrase arm's HEAD+TAIL pair did not
 *  know it, so the DOTTED ≤3-band form "Nothing otherwise than digi.ai waits on the
 *  owner." fell to the generic window's dotted-branch lookbehind, saw only the TAIL
 *  "than" (not a connective), and suppressed a genuinely affirmative owner-wait claim
 *  (parent 6defebc9a mined it — an FN residual of the D1 fix itself, the safe direction
 *  but still a hole). It pairs with "than" ONLY — adversarial review of THIS fix
 *  (finding F1): "otherwise" is unidiomatic with "from"/"of", so sharing the general
 *  head|tail cross-product would have mined "Nothing otherwise from ctrl.example.com is
 *  waiting…" — a false positive in exactly the 68a1c868 incident class (an
 *  independently-measured 215k-sentence sweep found the whole F1 family built on
 *  otherwise+from/of; none is idiomatic supervisor prose). The POST-VERB suffix arm
 *  (GATE_BUT_EXCEPTION_RE) still EXCLUDES "otherwise" — its adverbial reading
 *  ("Nothing waits on the owner, otherwise than the publish gate." / "…, otherwise the
 *  gate is fine.") keeps that suffix at []-parity with main, as pinned in
 *  follow-through.service.test.ts; the asymmetry cannot leak a false negative into the
 *  pre-verb band, which has no adverbial reading. */
const EXCEPTION_CONNECTIVE_PHRASE_HEAD_TAIL_RE_SOURCE = `\\b(?:${ci('other|more|less|apart|aside|short|exclusive')})\\b[ \\t]+(?:${ci('than|from|of')})\\b[ \\t]+`;
const EXCEPTION_CONNECTIVE_OTHERWISE_THAN_RE_SOURCE = `\\b(?:${ci('otherwise')})\\b[ \\t]+(?:${ci('than')})\\b[ \\t]+`;
const EXCEPTION_CONNECTIVE_PHRASE_RE_SOURCE = `(?:${EXCEPTION_CONNECTIVE_PHRASE_HEAD_TAIL_RE_SOURCE}|${EXCEPTION_CONNECTIVE_OTHERWISE_THAN_RE_SOURCE})`;
/** The HEADS of the multi-word connectors above. NOTHING_CLASS_FRAME_RE guards
 *  each WORD slot with a connective lookahead (not a lookbehind — it cannot
 *  see a phrase that started a slot earlier), and blocking the head at slot 1
 *  kills the frame before it can span "other than …": this is exactly how the
 *  tip's `(?!…\\b)` guard kept "Nothing other than the publish gate waits…"
 *  mining (round 2, D1). The head list is the phrase arm's HEAD|TAIL heads,
 *  NOT the full EXCEPTION_CONNECTIVE_RE_SOURCE — nothing changed there, this
 *  is the same guard factored so the WORD arm and the new punct/dotted arms
 *  share it. "otherwise" is deliberately NOT added here (efb63eb9 review,
 *  finding F2): its slot-1 blocking is already carried by
 *  EXCEPTION_CONNECTIVE_RE_SOURCE in the SAME lookahead union — the word arm
 *  listed "otherwise" long before this ticket — so a duplicate alternation in
 *  this head list is dead code (measured over a 215k-sentence differential:
 *  zero sentences change). Its phrase-level guard lives ONLY in
 *  EXCEPTION_CONNECTIVE_OTHERWISE_THAN_RE_SOURCE. */
const EXCEPTION_CONNECTIVE_PHRASE_HEAD_RE_SOURCE = `(?:${ci('other|more|less|apart|aside|short|exclusive')})`;
/** A gating frame governed by an explicit negation in its own clause — "nothing waits on
 *  the owner", "no lane is owner-gated", "zero items wait on Paul" — is a NEGATIVE status
 *  report (the desired steady state), never an unfiled decision (ticket f7e9df4c: the
 *  CanLaw Supervisor's "Zero open owner questions; nothing waits on the owner." auto-filed
 *  oq_06b64479). The marker may carry at most ~3 same-clause words before the frame; a
 *  negation on the far side of a clause boundary never reaches across, so "No owner
 *  question is open; the publish call waits on Paul." stays a live claim. The marker itself is
 *  word-bounded on BOTH sides: a trailing "no"/"zero" inside a real noun (casino, volcano,
 *  domino, subzero) or "never" inside "whenever" is not a negation — without the leading \b
 *  those genuine claims were wrongly silenced (f7e9df4c reviewer finding).
 *
 *  ROUND 2 (cross-family review of the merged 4b655f10, findings D1/D2, ticket 68a1c868):
 *  the {0,3} window is now TWO-ARMED per gap word — a DOTTED identifier word
 *  (deploy.example.com, i-020850b4.prod.aws) is guarded by a connective lookbehind so an
 *  exception idiom ("Nothing but deploy.example.com waits…" = ONLY deploy.example.com waits) refuses
 *  the branch and the claim MINES (D1: dot tolerance had made "but deploy.example.com" two
 *  consumable gap words, so the affirmative exception suppressed — parent mined it), while
 *  a PLAIN word keeps consuming internal dots as noise so a negative status report
 *  ("Nothing in ctrl.example.com is waiting…") still suppresses. {0,3} counts WORDS (a dotted
 *  identifier is one word). A standalone dash is a CLAUSE BOUNDARY, not a gap word (D2:
 *  "Nothing in ctrl.example.com — the gate waits on the owner." mines — parent had absorbed the
 *  dash and wrongly suppressed a genuinely affirmative post-dash claim); a trailing
 *  optional dash ends the window so an emphatic appositive still negates ("Nothing —
 *  absolutely nothing — waits on the owner."). INTENTIONAL divergence vs parent: the
 *  undotted dash shape "Nothing here — the gate waits…" (parent SUPPRESSED, tip MINES) —
 *  parent's suppression was its own FN hole of the D2 class; mining is the safe direction
 *  (an affirmative owner-wait claim must file). Intra-token dashes stay legal
 *  ("i-020850b4", "Gates 1–3" are single words).
 *
 *  ROUND 3 (review of PR #1947, F1): each gap slot may ALSO be a single
 *  PUNCTUATION-ONLY token (NEG_GAP_PUNCT_RE_SOURCE — an ellipsis, a bare ")"):
 *  "Nothing … waits on the owner." and "No lane … is owner-gated." are negative
 *  status reports, not claims — round 2's alnum requirement had made the
 *  ellipsis unconsumable and re-broken them (the ticket's own FP class).
 *  The dotted branch's connective lookbehind sees THROUGH one such token, so
 *  an exception idiom still mines even when the writer dots it: "Nothing but
 *  … deploy.example.com waits on the owner." (the \b anchors hold at the ellipsis). */
const NEGATED_FRAME_RE = new RegExp(
  `\\b(?:${NEG_MARKER_RE_SOURCE})\\b` +
  `(?:[ \\t]+(?:(?<!\\b(?:${EXCEPTION_CONNECTIVE_RE_SOURCE})\\b[ \\t]+|${EXCEPTION_CONNECTIVE_PHRASE_RE_SOURCE}|\\b(?:${EXCEPTION_CONNECTIVE_RE_SOURCE})\\b[ \\t]+${NEG_GAP_PUNCT_RE_SOURCE}[ \\t]+)${NEG_GAP_WORD_DOTTED_RE_SOURCE}|${NEG_GAP_PUNCT_RE_SOURCE}|${NEG_GAP_WORD_PLAIN_RE_SOURCE})){0,3}` +
  `[ \\t]*[—–-]?[ \\t]*$`
);

/** NOTHING-CLASS absence subjects ("nothing", "nobody", "none", "no one"/"no-one",
 *  "no thing") govern WIDER spans than the generic negation markers above: "nothing
 *  else in this project waits on the owner" puts FOUR gap words between marker and
 *  frame — beyond NEGATED_FRAME_RE's {0,3} — and kept auto-filing after #851
 *  (ticket bdd71948, incident #2: oq_9f5995bf). This frame widens the nothing-class
 *  to FIVE gap words with the same comma/semicolon-excluding gap-word class (the
 *  comma exclusion holds the comma-bleed line by construction: "Nothing is queued,
 *  but the publish gate waits on the owner" dies at "queued," before any window
 *  question — adversarial review 875216b0, finding B1) plus a contrastive-connective
 *  guard (but / however / yet / though / although / while / whereas) which keeps a
 *  connective-led span BEYOND NEGATED_FRAME_RE's {0,3} reach mining ("Nothing but
 *  the usual four gates wait on the owner"); at ≤3 gap words the guard-less generic
 *  frame governs, so "Nothing but the usual waits on the owner" suppresses
 *  (main-parity — review 875216b0: "semantically defensible either way").
 *  The guard ALSO covers the exception-preposition class (except / other / more /
 *  apart / aside / save / besides / beyond / bar / excluding — the first word of a
 *  multi-word connector suffices: blocking "other" at gap position 1 kills the
 *  frame before it can span "other than …"): "Nothing except the publish gate
 *  waits on the owner" reads as "ONLY the publish gate waits" — an affirmative
 *  owner-wait claim, the same idiom class as F1 with the exception phrase
 *  PRE-verb and a connector other than "but". Mining is always semantically
 *  correct for it (the exception names the thing that DOES wait), so the guard
 *  cannot create a false positive (adversarial review 875216b0, finding G1:
 *  13/13 exception-idiom sentences in the 4–5-gap band were suppressed on the
 *  tip while origin/main mined them). Finding G2 (same review, next round):
 *  the class was under-enumerated — barring / excepting / saving / minus /
 *  plus / less than / short of demonstrated tip-[] / main-mines 9/9, and
 *  enumerate-and-guard loses one slice per respin. The guard now carries the
 *  class BATCH-ENUMERATED in one pass (supervisor daee2916 steer): every
 *  grammaticalized exception preposition (…plus barring / excepting / saving /
 *  minus / plus / outside / past / exclusive / outwith) and the
 *  emphatic-intensifier idioms (less than / short of / otherwise than),
 *  swept tip-vs-main-replay over the standard closed preposition inventory.
 *  THE STANDING CLASS RULE (reviewer META option b, made mechanical): a
 *  connector joins the guard IFF "Nothing CONN X VERBs" entails "X VERBs"
 *  (exception or emphatic-intensifier reading); every other 4–5-gap
 *  connector stays suppressed — an INTENTIONAL tip/main divergence, because
 *  main's {0,3} reach over-mines the band while the tip's suppression is
 *  semantically correct ("Nothing without / including / after the publish
 *  gate waits on the owner" does NOT assert the gate waits; the swept
 *  boundary inventory is pinned [] in follow-through.service.test.ts).
 *  The generic no/not/never/zero markers
 *  stay at {0,3}: wider windows there would suppress intensifier shapes main
 *  mines ("No doubt the publish gate waits on the owner"). Known residual
 *  (family a): an unmarked short contrast with no comma and no connective
 *  inside the gap still suppresses ("Nothing happened and the gate waits on
 *  the owner"); a span beyond five words still mines. Pre-existing FP shapes:
 *  "Nothing yet waits on the owner" is suppressed by the generic frame's
 *  1-word gap (main-parity), while the parenthesized-connective shapes
 *  "Nothing, though, waits on the owner" / "Nothing, however, waits on the
 *  owner" keep mining on both main and tip (the PARENTHETICAL_FRAME_RE guard
 *  below) — the class is tracked for follow-up. Ticket bdd71948. */
const NOTHING_CLASS_FRAME_RE =
  new RegExp(`\\b(?:${NOTHING_SUBJECT_RE_SOURCE})\\b(?:[ \\t]+(?:(?<!\\b(?:${EXCEPTION_CONNECTIVE_RE_SOURCE})\\b[ \\t]+|${EXCEPTION_CONNECTIVE_PHRASE_RE_SOURCE}|\\b(?:${EXCEPTION_CONNECTIVE_RE_SOURCE})\\b[ \\t]+${NEG_GAP_PUNCT_RE_SOURCE}[ \\t]+)${NEG_GAP_WORD_DOTTED_RE_SOURCE}|${NEG_GAP_PUNCT_RE_SOURCE}|(?!(?:${EXCEPTION_CONNECTIVE_RE_SOURCE}|${EXCEPTION_CONNECTIVE_PHRASE_HEAD_RE_SOURCE})\\b)${NEG_GAP_WORD_RE_SOURCE})){0,5}[ \\t]*$`);

/** A comma PARENTHETICAL aside directly after a nothing-class marker — "Nothing,
 *  as of this sweep, waits on the owner" — still negates the frame that follows
 *  the closing comma (the general frames die at the first comma by construction;
 *  the parenthetical reading is the only one the sentence has — the win review
 *  875216b0 called worth preserving). The aside may not open with a contrastive
 *  connective, so "Nothing, however, waits on the owner" keeps mining (the
 *  pre-existing FP class above) — NOR with the exception-preposition class
 *  (G1's comma-wrapped variant: "Nothing, except the publish gate, waits on
 *  the owner" asserts ONLY the gate waits; main's comma-excluding frames die
 *  at the first comma, so main mines and the tip must not suppress it). The
 *  guard list is the SAME batch-enumerated exception/intensifier class as
 *  NOTHING_CLASS_FRAME_RE above (G2: "Nothing, barring the publish gate,
 *  waits on the owner." demonstrated tip-[] / main-mines). One
 *  comma pair only, aside ≤60 chars: "Nothing,
 *  the gate waits on the owner" has no closing comma and stays a live claim
 *  (family-a sibling, main-parity). Ticket bdd71948.
 *
 *  11354cbe (68a1c868 residual, same root-cause family through a different
 *  door): the aside body was the raw dot-EXCLUDING class [^.;:,\n]{1,60}?,
 *  so an aside CARRYING a dotted identifier — "Nothing, per ctrl.example.com
 *  status, waits on the owner." — could not be consumed, the parenthetical
 *  guard died, and a negative status report mined as an affirmative claim
 *  (verified parent-parity at 6defebc9a: a pre-existing hole, not a 68a1c868
 *  regression). The body is now a run of the SAME compositional gap words
 *  the other two windows use (NEG_GAP_WORD_RE_SOURCE: dot-free head + any
 *  number of ".lower-or-digit" identifier tails) — zero-or-more
 *  space-terminated words plus one optional final word (the `?` MUST sit on
 *  a wrapping (?:…) group, never on the bare gap-word source, whose last
 *  atom is the identifier-tail `(?:\.[a-z0-9]…)*` — a bare `GAP?`
 *  re-quantifies THAT group and leaves the head `[^…]+` mandatory). EVERY
 *  gap word carries the SAME exception-connective guard as
 *  NOTHING_CLASS_FRAME_RE above (adversarial review of this fix, finding
 *  F1: guarding only the OPENING word let a mid-aside exception — "Nothing,
 *  per ctrl.example.com except the publish gate, waits on the owner." = ONLY the
 *  gate waits, an affirmative claim — be consumed as an ordinary gap word
 *  and wrongly suppressed). This also closes the dot-free mid-aside hole
 *  the old body carried ("Nothing, per the sweep except the publish gate,
 *  waits on the owner." now MINES where the parent consumed it) — an
 *  intentional divergence in the mining direction, the same class as
 *  875216b0 G1/F1: the exception names the thing that DOES wait; the cost
 *  is the family-consistent one — a standalone exception word used as a
 *  plain noun mid-aside ("per the bar chart above") re-mines, the identical
 *  trade-off NOTHING_CLASS_FRAME_RE's per-word guard already makes.
 *  Terminator behavior is inherited from the gap-word class: a dot ending a
 *  token or starting a CAPITALIZED token breaks the aside, and a dot-initial
 *  tail is not a word start ("Nothing, .cql status, waits on the owner."
 *  keeps mining, main-parity); the documented unspaced dot+lowercase
 *  residual (see NEG_GAP_WORD_RE_SOURCE above) now applies INSIDE asides
 *  too — "Nothing, per the last sweep.the gate, waits on the owner."
 *  suppresses where the old dot-excluding body mined (the doubly-malformed
 *  typo class, the same accepted trade-off as the sibling windows). The
 *  ≤60-char cap is kept as a comma-within-60-chars lookahead whose class is
 *  [\s\S], NOT `.` (review finding F3: `.` does not match \r / U+2028 /
 *  U+2029, which the old body class admitted — a bare line separator inside
 *  a dot-free aside would have re-opened the FP door); exact-60 suppresses
 *  and 61 mines, the same boundary as the old {1,60}. Whitespace-only
 *  asides: the two-space form "Nothing,  ,  waits on the owner." is
 *  parent-parity suppressed (the old space-permitting body consumed the
 *  bare space; a starred gap word cannot, and the optional final word is
 *  what absorbs a real last word); the one-space form "Nothing, , waits on
 *  the owner." MINED at the parent (its body demanded ≥1 non-comma char, so
 *  the bare ", ," defeated every window) and now suppresses — a benign,
 *  semantically-correct divergence (the parenthetical reading is still the
 *  only one the sentence has). A bare ",," with no space after the opening
 *  comma fails the mandatory [ \t]+ on both old and new. */
const PARENTHETICAL_FRAME_RE =
  new RegExp(`\\b(?:${NOTHING_SUBJECT_RE_SOURCE})\\b["'\`),:]*[ \\t]*,[ \\t]+(?!${EXCEPTION_CONNECTIVE_RE_SOURCE}\\b)(?=[\\s\\S]{0,60},[ \\t]*$)(?:(?!${EXCEPTION_CONNECTIVE_RE_SOURCE}\\b)${NEG_GAP_WORD_RE_SOURCE}[ \\t]+)*(?:(?!${EXCEPTION_CONNECTIVE_RE_SOURCE}\\b)${NEG_GAP_WORD_RE_SOURCE})?[ \\t]*,[ \\t]*$`);

/** ROUND 3 (review of PR #1947, finding F1, ticket 68a1c868, 2026-10-24): the
 *  DASH-DELIMITED sibling of the comma aside above — "Nothing — at present —
 *  waits on the owner." / "Nobody — per the ledger — is waiting on the owner."
 *  Round 2 made every gap word require an alnum, so a PAIR of space-delimited
 *  dashes (an aside) became two unconsumable tokens: the negation scope died,
 *  the tip auto-filed a phantom owner card where parent and round-1 filed
 *  nothing (the 68a1c868 incident class, oq_2cc4131f, reborn through
 *  typography). A single trailing dash cannot carry an aside (no closing
 *  delimiter) — it stays a CLAUSE BOUNDARY, so D2 holds: "Nothing in
 *  ctrl.example.com — the gate waits on the owner." still mines, and "Nothing —
 *  however — waits on the owner." (a contrastive aside) keeps mining exactly
 *  like its comma sibling "Nothing, however, waits…" — same guard, same
 *  pre-existing FP class, comma-arm parity by construction. THE BODY IS THE COMMA
 *  ARM'S POST-11354cbe BODY, VERBATIM (main b1b9c7625): a run of the same
 *  compositional gap words (NEG_GAP_WORD_RE_SOURCE — dotted identifiers inside
 *  a dash aside are consumable: "Nothing — per ctrl.example.com status — waits…"
 *  suppresses) with the SAME per-word exception-connective guard, so a MID-ASIDE
 *  exception ("Nothing — per the ledger except the publish gate — waits…" =
 *  ONLY the gate waits) MINES — the exact hole that fix's review finding F1
 *  closed on the comma arm; the same standalone-exception-word-as-noun
 *  trade-off applies ("per the bar chart above" re-mines, family-consistent).
 *  The ≤60-char cap is the same within-60 lookahead with the [\s\S] class
 *  (not `.` — \r/U+2028/U+2029). Em/en/ASCII hyphen and the " -- "/" --- "
 *  typewriter forms are one delimiter class, ordered longest-first. ONE PAIR
 *  ONLY: the closer must sit immediately before the frame (the body's word
 *  arms never match a dash), so "Nothing — at — present — waits…" has no
 *  consumable closer and mines. Intra-token hyphens are fine ("half-done" is
 *  one word — the aside survives them, better than a raw body class). The
 *  ASCII hyphen is a delimiter ONLY when space-delimited on BOTH sides (same
 *  D2 rule): glued "-at present-" has no space after the marker's dash, fails
 *  the mandatory `[ \\t]+`, never opens an aside — the word arm consumes the
 *  intra-token hyphen and the sentence suppresses as a plain negative report. */
const DASH_PARENTHETICAL_FRAME_RE =
  new RegExp(`\\b(?:${NOTHING_SUBJECT_RE_SOURCE})\\b["'\`),:]*[ \\t]*(?:---|--|—|–|-)[ \\t]+(?!${EXCEPTION_CONNECTIVE_RE_SOURCE}\\b)(?=[\\s\\S]{0,60}(?:---|--|—|–|-)[ \\t]*$)(?:(?!${EXCEPTION_CONNECTIVE_RE_SOURCE}\\b)${NEG_GAP_WORD_RE_SOURCE}[ \\t]+)*(?:(?!${EXCEPTION_CONNECTIVE_RE_SOURCE}\\b)${NEG_GAP_WORD_RE_SOURCE})?[ \\t]*(?:---|--|—|–|-)[ \\t]*$`);

/** A leading exception marker AFTER a nothing-gated match re-arms the claim:
 *  the post-verb idiom "nothing waits on the owner but the publish gate" reads
 *  as "ONLY the publish gate waits on the owner" — an affirmative owner-wait
 *  claim, which origin/main always mined (adversarial review 875216b0,
 *  finding F1). The prefix window cannot see an exception that follows the
 *  verb, so a suppressed match ALSO scans the text after itself: a sentence
 *  continuing with (optional ,/;) an exception connector is an exception, not
 *  a bare no-op. The connector set covers "but" AND the exception-preposition
 *  class (except / other than / more than / apart from / aside from / besides /
 *  beyond / save / bar / excluding — review 875216b0, finding G1 suffix: the
 *  post-verb shapes with connectors other than "but" were a pre-existing
 *  F1-class hole MAIN also carried, fixed here in the same pass — tip mines /
 *  main [], an intentional divergence in the safe direction). Finding G2
 *  extended the set with the remainder of the batch-enumerated class — but
 *  ONLY the connectors UNAMBIGUOUS in post-verb position (barring /
 *  excepting / minus / plus / exclusive of): the pre-verb guard takes the
 *  full class, while the suffix deliberately excludes "saving" (causal
 *  participle — "Nothing waits on the owner, saving 3 GPU-hours."), "less
 *  than" / "short of" (comparative), "outside" / "past" / "outwith"
 *  (locative/temporal — "Nothing waits on the owner past Friday."), and
 *  "otherwise" (adverbial). Those stay []-PARITY with main (pinned in
 *  follow-through.service.test.ts) — the pre-verb band has no such
 *  readings, so the asymmetry cannot leak a false negative there.
 *  Deliberate
 *  main-parity over-approximation: a trailing marker opening an independent
 *  clause ("nothing waits on the owner, but the gate is broken") is re-armed
 *  along with true exception phrases — telling them apart needs a verb
 *  lexicon, and every mis-classification in that direction is a false
 *  NEGATIVE vs main (the review's blocking direction). Residual: a post-verb
 *  modifier between the match and the exception ("nothing waits on the owner
 *  today, but the publish gate does") is NOT scanned and stays suppressed.
 *  The incident class ("nothing waits on the owner." — no exception) stays
 *  suppressed. Ticket bdd71948. */
const GATE_BUT_EXCEPTION_RE =
  /^[\s,;]*(?:but|except|other[ \t]+than|more[ \t]+than|apart[ \t]+from|aside[ \t]+from|besides|beyond|save|bar|excluding|barring|excepting|minus|plus|exclusive(?:[ \t]+of)?)\b/i;

/** True when the sentence carries at least one gating frame NOT governed by a
 *  negation: the generic per-frame scope (f7e9df4c), the widened nothing-class
 *  window and the comma-parenthetical aside (bdd71948). A negated frame is
 *  re-armed by a post-verb "but …" exception (bdd71948, review 875216b0 F1). */
function hasAffirmativeGatingClaim(sentence: string): boolean {
  GATING_MATCH_RE.lastIndex = 0;
  for (const m of sentence.matchAll(GATING_MATCH_RE)) {
    const before = sentence.slice(0, m.index ?? 0);
    if (!NEGATED_FRAME_RE.test(before) && !NOTHING_CLASS_FRAME_RE.test(before) && !PARENTHETICAL_FRAME_RE.test(before) && !DASH_PARENTHETICAL_FRAME_RE.test(before)) return true;
    if (GATE_BUT_EXCEPTION_RE.test(sentence.slice((m.index ?? 0) + m[0].length))) return true;
  }
  return false;
}

/** Gating claims that name NO owner-question id — the decision nobody filed. */
export function mineUnfiledDecisionClaims(note: string): string[] {
  const out: string[] = [];
  for (const sentence of sentencesOf(note)) {
    if (!GATING_RE.test(sentence) || OQ_REF_RE.test(sentence) || GATING_RESOLVED_RE.test(sentence) || DECLINE_RE.test(sentence)) continue;
    if (!hasAffirmativeGatingClaim(sentence)) continue; // every gating frame is negated — a "nothing waits on the owner" report (f7e9df4c; nothing-class window + parenthetical aside + post-verb-but re-arm: bdd71948)
    out.push(sentence.slice(0, 300));
  }
  return [...new Set(out)];
}

const normHash = (s: string): string => createHash('sha256').update(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).digest('hex').slice(0, 16);
const hhmmz = (d: Date): string => `${d.toISOString().slice(5, 16).replace('T', ' ')}Z`;

export function renderFollowThroughWake(d: StallDiagnosis, noteAt: Date, now: Date): string {
  const mins = Math.max(1, Math.round((now.getTime() - noteAt.getTime()) / 60000));
  return [
    `[FOLLOW-THROUGH] At ${hhmmz(noteAt)} you diagnosed lane ${d.laneId8} as stalled — "${d.sentence.slice(0, 200)}" — and ${mins} minutes later no action toward that lane is on record: no send_chat_message / start_coding_session / schedule receipt naming it, no todo_update on a todo assigned to it, no message posted into it, and no retirement (cancel_schedule on its cadence + archive_chat) of it.`,
    `A diagnosis is not an action. Do ONE of these now and cite the receipt/message id in your note: nudge the lane with the exact missing step (send_chat_message), reassign or re-scope its todo (todo_update on the todo assigned to that lane), restart it as a fresh session (start_coding_session), retire it per the owner's retire doctrine (cancel_schedule on its recurring cadence, then archive_chat), or file the framework gap (file_feedback). If no action is right, say so IN THE DIAGNOSIS SENTENCE ITSELF ("lane ${d.laneId8} is idle by design — no action") and record the reason in ${modelToolName('update_supervisor_state')}; the detector reads the sentence, not your state doc. Narration alone is not an acceptable reply.`,
  ].join('\n');
}

export function renderAutofiledNotice(sentence: string, noteAt: Date, oqId: string, triaged: boolean): string {
  const where = triaged
    ? `Filed ${oqId} for you — it goes to the Fleet Supervisor's triage first (up to 2h; it may answer it itself) and then to the owner's Inbox and Telegram if still open.`
    : `Filed ${oqId} for you (the owner sees it in the Inbox and on Telegram).`;
  return `[FOLLOW-THROUGH] Your note at ${hhmmz(noteAt)} said "${sentence.slice(0, 200)}" but no owner question was open for this chat or its project — nothing was actually asking. ${where} Cite ${oqId} whenever you refer to this decision, and next time file it yourself with flag_owner_question in the same wake you call something owner-gated.`;
}

export function renderAlreadyAnsweredNotice(sentence: string, noteAt: Date, prior: { id: string; answer?: string | null; status?: string; dismissedBy?: string | null }): string {
  // abca56ce: a non-owner dismissal is named, never narrated as the owner's act.
  const by = prior.status === 'dismissed' ? (prior.dismissedBy ?? 'owner') : 'owner';
  const byText = by === 'owner' ? 'the owner' : by === 'supervisor' ? 'the Fleet Supervisor (on the owner\'s behalf)' : by === 'agent' ? 'the filing chat' : 'the system (superseded)';
  return `[FOLLOW-THROUGH] Your note at ${hhmmz(noteAt)} said "${sentence.slice(0, 200)}" — but ${byText} already ${prior.status === 'dismissed' ? 'dismissed' : 'answered'} this in ${prior.id.slice(0, 11)}${prior.answer ? `: "${String(prior.answer).slice(0, 160)}"` : ''}. Nothing is waiting on the owner. Cite ${prior.id.slice(0, 11)} as ANSWERED and act on the ruling.`;
}

export function renderRefusedNotice(sentence: string, noteAt: Date, refused: string, refusedMessage?: string): string {
  const why = refused === 'multi_decision'
    ? 'it packs more than one decision — split it into one flag_owner_question per decision, each with typed options'
    : refused === 'cap' ? 'the owner-question cap is reached — answer or dismiss what is already open first'
      : refused === 'dismissed_recently' ? (refusedMessage ?? 'this topic was dismissed recently — do not re-raise it; act on what you have')
        : `it was refused (${refused})`;
  return `[FOLLOW-THROUGH] Your note at ${hhmmz(noteAt)} said "${sentence.slice(0, 200)}" but no owner question was open, and the auto-filing could not stand in for you: ${why}. Until a question is filed, nothing is asking the owner — do not write "owner-gated".`;
}

// ── Sweep ────────────────────────────────────────────────────────────────────

interface SupervisorRow { id: string; userId: string; title: string | null; projectId: string | null; isSupervisor: boolean | null; isProjectSupervisor: boolean | null }
interface NoteRow { id: string; content: string; createdAt: Date; metadata: any }

export interface OpenOwnerAskLike { id: string; text: string; at: string; messageId?: string }

/** Detector 3b reads: the chat's answered-ask-with-open-twin pairs (defaults to the platform module). */
export interface AnsweredAskTwinLike { askId: string; twinId: string; text: string; at: string; messageId?: string }

export interface FollowThroughDeps {
  now?: Date;
  enqueueDirectWake?: (opts: { targetChatId: string; prompt: string; meta?: Record<string, unknown> }) => Promise<unknown>;
  flagOwnerQuestion?: (input: any) => Promise<any>;
  /** Detector 3 reads: the chat's open kind:'ask' directives and the reply probe (both default to the platform modules). */
  listOpenOwnerAsks?: (chatId: string, opts: { maxAgeMs: number; now: Date }) => Promise<OpenOwnerAskLike[]>;
  hasSupervisorReplyAfter?: (chatId: string, at: Date) => Promise<boolean>;
  /** Detector 3b reads: the chat's answered kind:'ask' rows whose order twin is still open. */
  listAnsweredAsksWithOpenTwin?: (chatId: string, opts: { maxAgeMs: number; now: Date }) => Promise<AnsweredAskTwinLike[]>;
}

/** Detector 3 renders (pure, exported for tests). */
export function renderOwnerAskNudge(ask: OpenOwnerAskLike, askAt: Date, now: Date): string {
  const mins = Math.max(1, Math.round((now.getTime() - askAt.getTime()) / 60000));
  const id8 = ask.messageId ? ask.messageId.slice(0, 8) : ask.id.slice(0, 8);
  return `[FOLLOW-THROUGH] The owner asked "${ask.text.slice(0, 200)}" at ${hhmmz(askAt)} (msg ${id8}) and ${mins} minutes later has no reply from you on record — answer now, in plain words, from the ledger and the transcript, citing msg ${id8}. An owner question outranks every sweep and report-up; the harness marks it answered when your reply lands.`;
}
export function renderOwnerAskEscalation(projectLabel: string, ask: OpenOwnerAskLike, askAt: Date, now: Date): string {
  const hours = Math.max(1, Math.round((now.getTime() - askAt.getTime()) / 3600000));
  const id8 = ask.messageId ? ask.messageId.slice(0, 8) : ask.id.slice(0, 8);
  return `[OWNER ASK UNANSWERED ${hours}h] ${projectLabel}: the owner asked "${ask.text.slice(0, 200)}" at ${hhmmz(askAt)} (msg ${id8}) in that project's supervisor chat and it has no reply — answer it yourself from the ledger (goal_list / todo_list / the [BOARD]) in THIS chat, or steer the project supervisor to answer it now (send_chat_message); cite msg ${id8}.`;
}

/** Detector 3b renders (pure, exported for tests; ticket b03d7033). */
export function renderOwnerAskTwinNudge(pair: AnsweredAskTwinLike, askAt: Date, now: Date): string {
  const hours = Math.max(1, Math.round((now.getTime() - askAt.getTime()) / 3600000));
  const id8 = pair.messageId ? pair.messageId.slice(0, 8) : pair.askId.slice(0, 8);
  return [
    `[FOLLOW-THROUGH] The owner asked "${pair.text.slice(0, 200)}" at ${hhmmz(askAt)} (msg ${id8}) — your reply answered the QUESTION, but the ORDER it carried is still open with no evidence (${hours}h later).`,
    `An answer is not an action. Do ONE of these now and cite the receipt in your note: act on the order and record the returned id as the directive's evidence via ${modelToolName('update_supervisor_state')} (directive ${pair.twinId.slice(0, 8)}), or — if you believe no action is right — say so to the owner in that same thread, then close the directive with the owner's reply message id as evidence. An explanation-only reply that neither acts nor reports up leaves the order lost: never close it by explaining.`,
  ].join('\n');
}
export function renderOwnerAskTwinEscalation(projectLabel: string, pair: AnsweredAskTwinLike, askAt: Date, now: Date): string {
  const hours = Math.max(1, Math.round((now.getTime() - askAt.getTime()) / 3600000));
  const id8 = pair.messageId ? pair.messageId.slice(0, 8) : pair.askId.slice(0, 8);
  return `[OWNER ORDER UNMET ${hours}h] ${projectLabel}: the owner asked "${pair.text.slice(0, 200)}" at ${hhmmz(askAt)} (msg ${id8}) in that project's supervisor chat; it got a reply but the order it carried is still open with no recorded outcome. Steer that supervisor to act now (send_chat_message), or act yourself from the ledger and record the artifact; cite msg ${id8}.`;
}

/**
 * Detector 3b — ANSWERED ASK, UNMET ORDER TWIN (ticket b03d7033, 2026-10-20).
 * Runs per supervisor beside detector 3, independent of the note cursor.
 * Never throws. Reuses the owner_ask_nudge metric kind (stage 'twin_nudge' |
 * 'twin_escalate') and the abd733af failed-enqueue discipline (no dedupe key
 * when the wake did not land).
 */
async function sweepAnsweredAskTwins(sup: SupervisorRow, now: Date, deps: FollowThroughDeps, counters: { askTwinNudges: number; askTwinEscalations: number }): Promise<void> {
  const list = deps.listAnsweredAsksWithOpenTwin ?? (async (chatId: string, opts: { maxAgeMs: number; now: Date }) => (await import('../platform/supervisor-state.service')).listAnsweredAsksWithOpenTwin(chatId, opts));
  const wake = deps.enqueueDirectWake ?? (async (o) => (await import('../platform/hooks.service')).enqueueDirectWake(o));
  const projectMeta = sup.projectId ? { projectId: sup.projectId } : {};
  let pairs: AnsweredAskTwinLike[] = [];
  try { pairs = await list(sup.id, { maxAgeMs: OWNER_ASK_LOOKBACK_MS, now }); } catch { return; }
  for (const pair of pairs) {
    try {
      const askAt = new Date(Date.parse(pair.at) || now.getTime());
      const ageMs = now.getTime() - askAt.getTime();
      if (ageMs < OWNER_ASK_TWIN_NUDGE_AFTER_MS) continue;
      const nudgeKey = ASK_TWIN_NUDGE_KEY(sup.id, pair.twinId);
      if (!(await (redisClient as any).get(nudgeKey).catch(() => null))) {
        const res: any = await wake({ targetChatId: sup.id, prompt: renderOwnerAskTwinNudge(pair, askAt, now), meta: { origin: SOURCE, kind: 'owner_ask_twin_unmet', directiveId: pair.twinId, askDirectiveId: pair.askId, askMessageId: pair.messageId ?? null } });
        if (res && typeof res === 'object' && res.ok === false) {
          logger.warn(`${SOURCE}: owner-ask twin nudge enqueue not ok for ${sup.id.slice(0, 8)}: ${res.error ?? 'unknown error'}`, { source: SOURCE });
          recordLoopMetric({ kind: 'owner_ask_nudge', sessionId: sup.id, value: ageMs, unit: 'ms', meta: { stage: 'twin_nudge', chatId: sup.id, directiveId: pair.twinId.slice(0, 8), ageMs, outcome: 'enqueue_failed', error: res.error ?? null, ...projectMeta } });
        } else {
          await (redisClient as any).set(nudgeKey, pair.twinId, { EX: OWNER_ASK_DEDUPE_SEC }).catch(() => {});
          counters.askTwinNudges++;
          recordLoopMetric({ kind: 'owner_ask_nudge', sessionId: sup.id, value: ageMs, unit: 'ms', meta: { stage: 'twin_nudge', chatId: sup.id, directiveId: pair.twinId.slice(0, 8), ageMs, ...projectMeta } });
        }
      }
      if (ageMs < OWNER_ASK_ESCALATE_AFTER_MS || sup.isSupervisor) continue; // the Fleet Supervisor's own orders have no one above them
      const escKey = ASK_TWIN_ESCALATE_KEY(sup.id, pair.twinId);
      if (await (redisClient as any).get(escKey).catch(() => null)) continue;
      const fleet = await prisma.crossModelChat.findFirst({ where: { userId: sup.userId, isSupervisor: true, archivedAt: null }, select: { id: true } }).catch(() => null);
      if (!fleet) continue;
      const label = sup.title ? sup.title.replace(/\s+Supervisor$/i, '') : sup.projectId ? `project ${sup.projectId.slice(0, 8)}` : 'a project';
      const escRes: any = await wake({ targetChatId: fleet.id, prompt: renderOwnerAskTwinEscalation(label, pair, askAt, now), meta: { origin: SOURCE, kind: 'owner_ask_twin_escalated', directiveId: pair.twinId, supervisorChatId: sup.id, askMessageId: pair.messageId ?? null } });
      if (escRes && typeof escRes === 'object' && escRes.ok === false) {
        logger.warn(`${SOURCE}: owner-ask twin escalation enqueue not ok for ${fleet.id.slice(0, 8)}: ${escRes.error ?? 'unknown error'}`, { source: SOURCE });
        recordLoopMetric({ kind: 'owner_ask_nudge', sessionId: sup.id, value: ageMs, unit: 'ms', meta: { stage: 'twin_escalate', chatId: sup.id, fleetChatId: fleet.id, directiveId: pair.twinId.slice(0, 8), ageMs, outcome: 'enqueue_failed', error: escRes.error ?? null, ...projectMeta } });
        continue;
      }
      await (redisClient as any).set(escKey, pair.twinId, { EX: OWNER_ASK_DEDUPE_SEC }).catch(() => {});
      counters.askTwinEscalations++;
      recordLoopMetric({ kind: 'owner_ask_nudge', sessionId: sup.id, value: ageMs, unit: 'ms', meta: { stage: 'twin_escalate', chatId: sup.id, fleetChatId: fleet.id, directiveId: pair.twinId.slice(0, 8), ageMs, ...projectMeta } });
    } catch (err: any) {
      logger.warn(`${SOURCE}: owner-ask twin check failed for ${sup.id.slice(0, 8)}/${pair.twinId.slice(0, 8)}: ${err?.message ?? err}`, { source: SOURCE });
    }
  }
}

/**
 * Detector 3 — UNANSWERED OWNER ASK. Runs per supervisor, independent of the
 * note cursor. Never throws.
 */
async function sweepOwnerAsks(sup: SupervisorRow, now: Date, deps: FollowThroughDeps, counters: { askNudges: number; askEscalations: number }): Promise<void> {
  const list = deps.listOpenOwnerAsks ?? (async (chatId, opts) => (await import('../platform/supervisor-state.service')).listOpenOwnerAsks(chatId, opts));
  const replied = deps.hasSupervisorReplyAfter ?? (async (chatId, at) => (await import('../platform/owner-asks')).hasSupervisorReplyAfter(chatId, at));
  const wake = deps.enqueueDirectWake ?? (async (o) => (await import('../platform/hooks.service')).enqueueDirectWake(o));
  const projectMeta = sup.projectId ? { projectId: sup.projectId } : {};
  let asks: OpenOwnerAskLike[] = [];
  try { asks = await list(sup.id, { maxAgeMs: OWNER_ASK_LOOKBACK_MS, now }); } catch { return; }
  for (const ask of asks) {
    try {
      const askAt = new Date(Date.parse(ask.at) || now.getTime());
      const ageMs = now.getTime() - askAt.getTime();
      if (ageMs < OWNER_ASK_NUDGE_AFTER_MS) continue;
      if (await replied(sup.id, askAt)) continue; // answered — the ledger close is the harness's (closeAskOnReply); nothing to nudge
      const nudgeKey = ASK_NUDGE_KEY(sup.id, ask.id);
      if (!(await (redisClient as any).get(nudgeKey).catch(() => null))) {
        // 6d19f11f sibling seam (abd733af): enqueueDirectWake reports failure as
        // { ok: false } instead of throwing. A nudge counted as sent while its
        // wake never enqueued set the 24h dedupe key and silenced the ask for a
        // day — the same alert-silencing class. Not delivered ⇒ no dedupe key
        // (the next sweep re-evaluates the still-open ask) + a failure row.
        const res: any = await wake({ targetChatId: sup.id, prompt: renderOwnerAskNudge(ask, askAt, now), meta: { origin: SOURCE, kind: 'owner_ask_unanswered', directiveId: ask.id, askMessageId: ask.messageId ?? null } });
        if (res && typeof res === 'object' && res.ok === false) {
          logger.warn(`${SOURCE}: owner-ask nudge enqueue not ok for ${sup.id.slice(0, 8)}: ${res.error ?? 'unknown error'}`, { source: SOURCE });
          recordLoopMetric({ kind: 'owner_ask_nudge', sessionId: sup.id, value: ageMs, unit: 'ms', meta: { stage: 'nudge', chatId: sup.id, directiveId: ask.id.slice(0, 8), ageMs, outcome: 'enqueue_failed', error: res.error ?? null, ...projectMeta } });
        } else {
          await (redisClient as any).set(nudgeKey, ask.id, { EX: OWNER_ASK_DEDUPE_SEC }).catch(() => {});
          counters.askNudges++;
          recordLoopMetric({ kind: 'owner_ask_nudge', sessionId: sup.id, value: ageMs, unit: 'ms', meta: { stage: 'nudge', chatId: sup.id, directiveId: ask.id.slice(0, 8), ageMs, ...projectMeta } });
        }
      }
      if (ageMs < OWNER_ASK_ESCALATE_AFTER_MS || sup.isSupervisor) continue; // the Fleet Supervisor's own asks have no one above them
      const escKey = ASK_ESCALATE_KEY(sup.id, ask.id);
      if (await (redisClient as any).get(escKey).catch(() => null)) continue;
      const fleet = await prisma.crossModelChat.findFirst({ where: { userId: sup.userId, isSupervisor: true, archivedAt: null }, select: { id: true } }).catch(() => null);
      if (!fleet) continue;
      const label = sup.title ? sup.title.replace(/\s+Supervisor$/i, '') : sup.projectId ? `project ${sup.projectId.slice(0, 8)}` : 'a project';
      // Same abd733af seam as the nudge above: a failed escalation enqueue must
      // not set the 24h escalate key — the ask stays escalatable on the next
      // sweep once the fleet target is reachable again.
      const escRes: any = await wake({ targetChatId: fleet.id, prompt: renderOwnerAskEscalation(label, ask, askAt, now), meta: { origin: SOURCE, kind: 'owner_ask_escalated', directiveId: ask.id, supervisorChatId: sup.id, askMessageId: ask.messageId ?? null } });
      if (escRes && typeof escRes === 'object' && escRes.ok === false) {
        logger.warn(`${SOURCE}: owner-ask escalation enqueue not ok for fleet ${fleet.id.slice(0, 8)}: ${escRes.error ?? 'unknown error'}`, { source: SOURCE });
        recordLoopMetric({ kind: 'owner_ask_nudge', sessionId: sup.id, value: ageMs, unit: 'ms', meta: { stage: 'escalate', chatId: sup.id, fleetChatId: fleet.id, directiveId: ask.id.slice(0, 8), ageMs, outcome: 'enqueue_failed', error: escRes.error ?? null, ...projectMeta } });
        continue;
      }
      await (redisClient as any).set(escKey, ask.id, { EX: OWNER_ASK_DEDUPE_SEC }).catch(() => {});
      counters.askEscalations++;
      recordLoopMetric({ kind: 'owner_ask_nudge', sessionId: sup.id, value: ageMs, unit: 'ms', meta: { stage: 'escalate', chatId: sup.id, fleetChatId: fleet.id, directiveId: ask.id.slice(0, 8), ageMs, ...projectMeta } });
    } catch (err: any) {
      logger.warn(`${SOURCE}: owner-ask check failed for ${sup.id.slice(0, 8)}/${ask.id.slice(0, 8)}: ${err?.message ?? err}`, { source: SOURCE });
    }
  }
}

/** Any action toward the lane since the run that wrote the note: a receipt naming the lane id, a todo write on a todo assigned to it, an agent message posted into it — or a doctrine-correct RETIREMENT (ticket 02c0bc79): cancel_schedule on the lane's cadence (resolved through the surviving coding_schedules row) or archive_chat stamped on the lane within the run-slack window. */
async function actedTowardLane(sup: SupervisorRow, laneId8: string, noteAt: Date): Promise<boolean> {
  const since = new Date(noteAt.getTime() - FOLLOW_THROUGH_RUN_SLACK_MS);
  const receipts = await prisma.runToolReceipt.findMany({
    where: { chatId: sup.id, ok: true, createdAt: { gte: since } },
    select: { tool: true, ids: true },
    take: 200,
  }).catch(() => [] as any[]);
  const todoIds: string[] = [];
  const cancelledScheduleIds: string[] = [];
  for (const r of receipts as any[]) {
    let ids = '';
    try { ids = JSON.stringify(r.ids ?? {}).toLowerCase(); } catch { /* ignore */ }
    if (ids.includes(laneId8)) return true;
    if ((r.tool === 'todo_update' || r.tool === 'todo_create') && r.ids && typeof r.ids.todoId === 'string') todoIds.push(r.ids.todoId);
    // Ticket 02c0bc79: a cancel_schedule receipt names a SCHEDULE, never the
    // lane — collect its ids for the lane-resolving lookup below.
    if (r.tool === 'cancel_schedule' && r.ids && typeof r.ids.scheduleId === 'string' && r.ids.scheduleId) cancelledScheduleIds.push(r.ids.scheduleId);
  }
  if (todoIds.length) {
    const todo = await prisma.projectTodo.findFirst({
      where: { id: { in: todoIds }, userId: sup.userId, assigneeChatId: { startsWith: laneId8 } },
      select: { id: true },
    }).catch(() => null);
    if (todo) return true;
  }
  // Doctrine-correct retirement, cancel leg (ticket 02c0bc79): the owner's
  // 2026-09-20 retire doctrine is "cancel_schedule on its recurring cadence,
  // then archive_chat" — the cancel IS an action toward the diagnosed lane.
  // The receipt's ids carry the SCHEDULE id only (platform-tools.ts envelope),
  // so resolve it through the coding_schedules row the cancel disabled (cancel
  // PERSISTS the row — enabled:false — with sessionId == the lane chat id) and
  // credit only when that row belongs to the diagnosed lane. Prefix-tolerant on
  // both ends (the fleet's 8-char idiom): the tool accepts a ≥8-char schedule-id
  // prefix, and the lane binds by its 8-char prefix. Same-owner guard mirrors
  // the chat lookup below — another user's same-prefix schedule never credits.
  for (const sid of [...new Set(cancelledScheduleIds)]) {
    const sched = await prisma.codingSchedule.findFirst({
      where: { id: { startsWith: sid }, sessionId: { startsWith: laneId8 }, userId: sup.userId },
      select: { id: true },
    }).catch(() => null);
    if (sched) return true;
  }
  // An AGENT message posted into the lane after the note (send_chat_message stamps origin 'agent');
  // the owner typing into the lane is not the supervisor acting. Same-owner lanes only.
  const lane = await prisma.crossModelChat.findFirst({ where: { id: { startsWith: laneId8 }, userId: sup.userId }, select: { id: true, archivedAt: true } }).catch(() => null);
  if (lane) {
    // Doctrine-correct retirement, archive leg (ticket 02c0bc79): since audit
    // 94f608c1 (2026-10-16) archive_chat mints a run_tool_receipt
    // (SUPERVISOR_STATE_RECEIPT_TOOLS), but the stamp is still read here as the
    // belt-and-braces truth — the receipt proves the CALL, the archivedAt row
    // proves the STATE, and a follow-through credit must survive a
    // fire-and-forget receipt write failure. An archive stamped on the diagnosed
    // lane within the run-slack window (same-wake retirements carry a stamp a
    // few seconds/minutes BEFORE the lazily-persisted note row) is follow-through;
    // an archive PREDATING the note window is not — a pre-existing retirement is
    // no action toward a fresh diagnosis, and a sentence that itself says
    // "archived" never mines in the first place (STALL_RESOLVED_RE).
    if (lane.archivedAt && new Date(lane.archivedAt).getTime() >= since.getTime()) return true;
    const posted = await prisma.crossModelMessage.findFirst({
      where: { chatId: lane.id, createdAt: { gte: since }, role: 'user', metadata: { path: ['origin'], equals: 'agent' } },
      select: { id: true },
    }).catch(() => null);
    if (posted) return true;
  }
  return false;
}

/**
 * WORK MOVED SINCE THE NOTE (audit 2026-10-06 T3-8, schooltime F4 — note
 * e38d0e31 23:40 "30532e70 … capture is owner-gated"; the supervisor steered
 * the lane at 00:29, todo 30532e70 went in_progress at 00:27:56; the detector
 * still auto-filed oq_d2110692 at 01:12 and woke two supervisors). The
 * decision path had no acted-since check at all and the diagnosis path never
 * credited the lane's OWN progress. An 8-hex id in the sentence counts as
 * "acted on" when, since the note (minus the run slack): its TODO moved to
 * in_progress / done / dropped (startedAt or updatedAt in the window) or its
 * assignee ran; or the LANE chat it names started a run. Same-owner only;
 * every read fails toward "not moved" (the pre-fix behaviour). Kill switch
 * FOLLOW_THROUGH_ACTED_SINCE_DISABLED=1. Exported for tests.
 */
export function followThroughActedSinceDisabled(): boolean {
  return process.env.FOLLOW_THROUGH_ACTED_SINCE_DISABLED === '1';
}
/** 8-hex ids (≥1 letter) a sentence names — todo / goal / lane prefixes. Pure. */
export function idRefsIn(sentence: string): string[] {
  const out = new Set<string>();
  for (const m of String(sentence ?? '').matchAll(/(?<![0-9a-z_])(?=[0-9]*[a-f])([0-9a-f]{8})(?![0-9a-z])/gi)) out.add(m[1].toLowerCase());
  return [...out];
}
async function chatRanSince(chatId: string, since: Date): Promise<boolean> {
  try {
    const run = await prisma.agentRun.findFirst({ where: { sessionId: chatId, createdAt: { gte: since } }, select: { id: true } });
    return !!run;
  } catch {
    return false;
  }
}
export async function workMovedSinceNote(sup: { id: string; userId: string }, id8: string, noteAt: Date): Promise<boolean> {
  if (followThroughActedSinceDisabled() || !id8) return false;
  try {
    return await workMovedSinceNoteInner(sup, id8, noteAt);
  } catch {
    return false; // fail toward the pre-fix filing
  }
}
async function workMovedSinceNoteInner(sup: { id: string; userId: string }, id8: string, noteAt: Date): Promise<boolean> {
  const since = new Date(noteAt.getTime() - FOLLOW_THROUGH_RUN_SLACK_MS);
  const todo = await prisma.projectTodo.findFirst({
    where: { id: { startsWith: id8 }, userId: sup.userId },
    select: { status: true, updatedAt: true, startedAt: true, assigneeChatId: true },
  }).catch(() => null) as any;
  if (todo) {
    const moved = ['in_progress', 'done', 'dropped'].includes(String(todo.status))
      && [todo.startedAt, todo.updatedAt].some((d: any) => d && new Date(d).getTime() >= since.getTime());
    if (moved) return true;
    if (todo.assigneeChatId && todo.assigneeChatId !== sup.id && await chatRanSince(String(todo.assigneeChatId), since)) return true;
  }
  if (id8 === sup.id.slice(0, 8).toLowerCase()) return false; // the supervisor's own turns are not lane progress
  const lane = await prisma.crossModelChat.findFirst({ where: { id: { startsWith: id8 }, userId: sup.userId }, select: { id: true } }).catch(() => null);
  return !!lane && await chatRanSince(lane.id, since);
}

/** Fleet Supervisor: ANY open question of the owner counts (its digest restates project state that a project supervisor may already have filed). Project supervisor: its chat + its project's chats. */
async function openOwnerQuestionExists(sup: SupervisorRow): Promise<boolean> {
  if (sup.isSupervisor) {
    const any = await prisma.ownerQuestion.findFirst({ where: { userId: sup.userId, status: 'open' }, select: { id: true } }).catch(() => null);
    return !!any;
  }
  const chatIds = new Set<string>([sup.id]);
  if (sup.projectId) {
    const chats = await prisma.crossModelChat.findMany({ where: { projectId: sup.projectId, userId: sup.userId }, select: { id: true }, take: 500 }).catch(() => [] as any[]);
    for (const c of chats as any[]) chatIds.add(c.id);
  }
  const ids = [...chatIds];
  const row = await prisma.ownerQuestion.findFirst({
    where: { userId: sup.userId, status: 'open', OR: [{ chatId: { in: ids } }, { forChatId: { in: ids } }] },
    select: { id: true },
  }).catch(() => null);
  return !!row;
}

/** Stale-note guard (ticket be90502f, sighting oq_47ec4300): an owner question
 *  RESOLVED after the note was written means the board already moved past the
 *  decision the note describes — the open-question check above cannot see it
 *  (answered/dismissed rows are not open), and the N8 answered-scan is a
 *  Jaccard topic match that differently-phrased questions fail (the auto-filed
 *  text embeds the NOTE sentence, never the original question's wording), so
 *  without this guard the sweep re-filed an answered decision as a new card
 *  (note 22:15Z "one owner decision pending (scale-out)"; oq_5c7a97d8 answered
 *  23:44Z; duplicate filed 23:58Z). Scope mirrors openOwnerQuestionExists.
 *  Resolutions PREDATING the note never suppress: the supervisor wrote the
 *  claim with the answer already available, so it is either a genuinely new
 *  decision or a supervisor error the N8 preflight still judges. */
async function recentlyResolvedOwnerQuestion(sup: SupervisorRow, noteAt: Date): Promise<{ id: string; status: string; answer: string | null } | null> {
  const RESOLVED = { in: ['answered', 'dismissed'] as string[] };
  const select = { id: true, status: true, answer: true } as const;
  const orderBy = { resolvedAt: 'desc' as const };
  if (sup.isSupervisor) {
    return (await prisma.ownerQuestion.findFirst({
      where: { userId: sup.userId, status: RESOLVED, resolvedAt: { gt: noteAt } },
      orderBy, select,
    }).catch(() => null)) as any;
  }
  const chatIds = new Set<string>([sup.id]);
  if (sup.projectId) {
    const chats = await prisma.crossModelChat.findMany({ where: { projectId: sup.projectId, userId: sup.userId }, select: { id: true }, take: 500 }).catch(() => [] as any[]);
    for (const c of chats as any[]) chatIds.add(c.id);
  }
  const ids = [...chatIds];
  return (await prisma.ownerQuestion.findFirst({
    where: { userId: sup.userId, status: RESOLVED, resolvedAt: { gt: noteAt }, OR: [{ chatId: { in: ids } }, { forChatId: { in: ids } }] },
    orderBy, select,
  }).catch(() => null)) as any;
}

async function sweepSupervisor(sup: SupervisorRow, now: Date, deps: FollowThroughDeps, counters: { nudges: number; autofiled: number }): Promise<void> {
  const rows = (await prisma.crossModelMessage.findMany({
    where: { chatId: sup.id, role: 'assistant', createdAt: { gte: new Date(now.getTime() - FOLLOW_THROUGH_LOOKBACK_MS) } },
    orderBy: { createdAt: 'desc' },
    take: FOLLOW_THROUGH_NOTE_FETCH,
    select: { id: true, content: true, createdAt: true, metadata: true },
  })) as NoteRow[];
  const notes = rows.filter((r) => NOTE_ORIGINS.has(String(r?.metadata?.origin ?? '')));
  if (!notes.length) return;

  const cursorRaw = await (redisClient as any).get(CURSOR_KEY(sup.id)).catch(() => null);
  const cursorMs = Number(cursorRaw);
  const graceCut = now.getTime() - FOLLOW_THROUGH_GRACE_MS;
  if (cursorRaw == null || !Number.isFinite(cursorMs)) {
    // First sight of this supervisor: seed at the grace edge — a missing baseline never backfills history.
    await (redisClient as any).set(CURSOR_KEY(sup.id), String(graceCut), { EX: CURSOR_TTL_SEC }).catch(() => {});
    return;
  }
  const due = notes.filter((n) => n.createdAt.getTime() > cursorMs && n.createdAt.getTime() <= graceCut).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (!due.length) return;
  const wake = deps.enqueueDirectWake ?? (async (o) => (await import('../platform/hooks.service')).enqueueDirectWake(o));
  const flag = deps.flagOwnerQuestion ?? (async (i) => (await import('../platform/owner-questions')).flagOwnerQuestion(i));
  const projectMeta = sup.projectId ? { projectId: sup.projectId } : {};

  for (const note of due) {
    // (1) diagnosis without action
    for (const d of mineStallDiagnoses(note.content)) {
      try {
        if (d.laneId8 === sup.id.slice(0, 8).toLowerCase()) continue; // a supervisor diagnosing itself is the watchdog's job
        if (await actedTowardLane(sup, d.laneId8, note.createdAt)) continue;
        const key = NUDGE_KEY(sup.id, d.laneId8);
        if (await (redisClient as any).get(key).catch(() => null)) continue;
        // abd733af (6d19f11f sibling seam): a failed wake enqueue must not set
        // the dedupe key — the diagnosis would be silenced for NUDGE_DEDUPE_SEC
        // without any wake landing. Failure row instead; next sweep retries.
        const wres: any = await wake({ targetChatId: sup.id, prompt: renderFollowThroughWake(d, note.createdAt, now), meta: { origin: SOURCE, kind: 'diagnosis_without_action', laneId8: d.laneId8, noteId: note.id } });
        if (wres && typeof wres === 'object' && wres.ok === false) {
          logger.warn(`${SOURCE}: diagnosis-nudge enqueue not ok for ${sup.id.slice(0, 8)}/${d.laneId8}: ${wres.error ?? 'unknown error'}`, { source: SOURCE });
          recordLoopMetric({ kind: 'follow_through_nudge', sessionId: sup.id, meta: { laneId8: d.laneId8, noteId: String(note.id).slice(0, 8), minutesSince: Math.round((now.getTime() - note.createdAt.getTime()) / 60000), outcome: 'enqueue_failed', error: wres.error ?? null, ...projectMeta } });
          continue;
        }
        await (redisClient as any).set(key, note.id, { EX: NUDGE_DEDUPE_SEC }).catch(() => {});
        counters.nudges++;
        recordLoopMetric({ kind: 'follow_through_nudge', sessionId: sup.id, meta: { laneId8: d.laneId8, noteId: String(note.id).slice(0, 8), minutesSince: Math.round((now.getTime() - note.createdAt.getTime()) / 60000), ...projectMeta } });
      } catch (err: any) {
        logger.warn(`${SOURCE}: diagnosis check failed for ${sup.id.slice(0, 8)}/${d.laneId8}: ${err?.message ?? err}`, { source: SOURCE });
      }
    }
    // (2) unfiled decision
    const claims = mineUnfiledDecisionClaims(note.content);
    if (claims.length) {
      try {
        if (!(await openOwnerQuestionExists(sup))) {
          // Stale-note guard (ticket be90502f): the board resolved this decision
          // AFTER the note was written — skip the filing and post the
          // already-answered notice naming the prior instead of a duplicate card.
          const prior = await recentlyResolvedOwnerQuestion(sup, note.createdAt);
          if (prior) {
            const content = renderAlreadyAnsweredNotice(claims[0], note.createdAt, prior);
            await prisma.crossModelMessage.create({ data: { chatId: sup.id, role: 'assistant', content, metadata: { origin: SOURCE, kind: 'decision-autofiled', outcome: 'stale_answered', noteId: note.id } } }).catch(() => {});
            recordLoopMetric({ kind: 'decision_autofiled', sessionId: sup.id, meta: { outcome: 'stale_answered', noteId: String(note.id).slice(0, 8), oqId: prior.id, ...projectMeta } });
            continue;
          }
          for (const sentence of claims.slice(0, 2)) {
            const key = AUTOFILE_KEY(sup.id, normHash(sentence));
            if (await (redisClient as any).get(key).catch(() => null)) continue;
            // T3-8: the todo / lane the claim names already moved since the note
            // (the supervisor acted on it, or the work is running) — no card.
            let movedId: string | null = null;
            if (!followThroughActedSinceDisabled()) {
              for (const id8 of idRefsIn(sentence).slice(0, 4)) {
                // The diagnosis path's acted-since check (receipts naming the id,
                // todo writes, agent messages, retirement) + the work's own progress.
                if (await workMovedSinceNote(sup, id8, note.createdAt) || await actedTowardLane(sup, id8, note.createdAt).catch(() => false)) { movedId = id8; break; }
              }
            }
            if (movedId) {
              recordLoopMetric({ kind: 'decision_autofiled', sessionId: sup.id, meta: { outcome: 'acted_since', noteId: String(note.id).slice(0, 8), id8: movedId, ...projectMeta } });
              continue;
            }
            await (redisClient as any).set(key, note.id, { EX: AUTOFILE_DEDUPE_SEC }).catch(() => {});
            const res = await flag({
              chatId: sup.id,
              userId: sup.userId,
              question: `Decision needed — auto-filed from the ${sup.title ?? 'supervisor'} note at ${hhmmz(note.createdAt)}: "${sentence.slice(0, 300)}"`,
              context: `The supervisor wrote that this is waiting on you, but no owner question was open for that chat or its project, so nothing was actually asking. Answer with your decision (or dismiss if nothing is needed) — the supervisor is woken with your ruling either way. Auto-filed by the follow-through detector.`,
              machineTriggered: true,
            });
            let content: string | null = null;
            let outcome = String(res?.kind ?? 'unknown');
            if (res?.kind === 'created' || res?.kind === 'deduped') {
              const oqId = String(res.question?.id ?? '').slice(0, 11) || 'the owner question';
              // A project supervisor's machine filing is triaged by the Fleet Supervisor first (owner-questions.ts); the fleet's own filing is owner-direct.
              content = renderAutofiledNotice(sentence, note.createdAt, oqId, !sup.isSupervisor);
            } else if (res?.kind === 'refused' && res.refused === 'previously_answered' && res.prior) {
              content = renderAlreadyAnsweredNotice(sentence, note.createdAt, { id: String(res.prior.id ?? ''), answer: res.prior.answer, status: res.prior.status, dismissedBy: (res.prior as any).dismissedBy ?? null });
              outcome = 'previously_answered';
            } else if (res?.kind === 'refused') {
              content = renderRefusedNotice(sentence, note.createdAt, String(res.refused), res.refused === 'dismissed_recently' && res.message ? String(res.message) : undefined);
              outcome = `refused:${res.refused}`;
            }
            if (content) {
              await prisma.crossModelMessage.create({ data: { chatId: sup.id, role: 'assistant', content, metadata: { origin: SOURCE, kind: 'decision-autofiled', outcome, noteId: note.id } } }).catch(() => {});
            }
            counters.autofiled++;
            recordLoopMetric({ kind: 'decision_autofiled', sessionId: sup.id, meta: { outcome, noteId: String(note.id).slice(0, 8), oqId: res?.question?.id ?? res?.prior?.id ?? null, ...projectMeta } });
          }
        }
      } catch (err: any) {
        logger.warn(`${SOURCE}: unfiled-decision check failed for ${sup.id.slice(0, 8)}: ${err?.message ?? err}`, { source: SOURCE });
      }
    }
  }
  await (redisClient as any).set(CURSOR_KEY(sup.id), String(due[due.length - 1].createdAt.getTime()), { EX: CURSOR_TTL_SEC }).catch(() => {});
}

/** One sweep over every fleet + ENABLED, attached project supervisor. Never throws. */
export async function sweepFollowThrough(deps: FollowThroughDeps = {}): Promise<{ supervisors: number; nudges: number; autofiled: number; askNudges: number; askEscalations: number }> {
  const counters = { supervisors: 0, nudges: 0, autofiled: 0, askNudges: 0, askEscalations: 0 };
  const twinCounters = { askTwinNudges: 0, askTwinEscalations: 0 };
  if (process.env.FOLLOW_THROUGH_DISABLED === '1') return counters;
  const now = deps.now ?? new Date();
  let sups: SupervisorRow[] = [];
  try {
    sups = (await prisma.crossModelChat.findMany({
      // Detached project supervisors (projectId null) are never scanned — the watchdog's rule.
      where: { OR: [{ isSupervisor: true }, { isProjectSupervisor: true, projectId: { not: null } }], archivedAt: null },
      select: { id: true, userId: true, title: true, projectId: true, isSupervisor: true, isProjectSupervisor: true },
      take: FOLLOW_THROUGH_MAX_SUPERVISORS,
    })) as SupervisorRow[];
  } catch (err: any) {
    logger.warn(`${SOURCE}: supervisor listing failed: ${err?.message ?? err}`, { source: SOURCE });
    return counters;
  }
  sups = sups.filter((s) => s.isSupervisor || (s.isProjectSupervisor && s.projectId));
  // Paused (pause-never-delete) or archived projects: their supervisor stays flagged but must not be woken.
  const projectIds = [...new Set(sups.filter((s) => !s.isSupervisor && s.projectId).map((s) => s.projectId as string))];
  if (projectIds.length) {
    const projects = await prisma.crossModelProject.findMany({ where: { id: { in: projectIds } }, select: { id: true, projectSupervisorEnabled: true, archivedAt: true } }).catch(() => [] as any[]);
    const enabled = new Set((projects as any[]).filter((p) => p.projectSupervisorEnabled === true && !p.archivedAt).map((p) => p.id));
    sups = sups.filter((s) => s.isSupervisor || enabled.has(s.projectId as string));
  }
  // Supervisor OFF switch: drop the switched-off tier (one skip row per lane,
  // rate-limited inside). Fail-open — a read error keeps the lane.
  const [fleetOn, projectOn] = await Promise.all([
    getFleetSupervisorEnabled().catch(() => true),
    getProjectSupervisorsEnabled().catch(() => true),
  ]);
  if (!fleetOn || !projectOn) {
    sups = sups.filter((s) => {
      const target = s.isSupervisor ? 'fleet' : 'project';
      if ((target === 'fleet' && fleetOn) || (target === 'project' && projectOn)) return true;
      recordSupervisorSwitchSkip({ target, source: 'follow-through', chatId: s.id });
      return false;
    });
  }
  counters.supervisors = sups.length;
  for (const sup of sups) {
    try {
      await sweepOwnerAsks(sup, now, deps, counters);
    } catch (err: any) {
      logger.warn(`${SOURCE}: owner-ask sweep failed for ${sup.id.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    }
    try {
      await sweepAnsweredAskTwins(sup, now, deps, twinCounters);
    } catch (err: any) {
      logger.warn(`${SOURCE}: owner-ask twin sweep failed for ${sup.id.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    }
    try {
      await sweepSupervisor(sup, now, deps, counters);
    } catch (err: any) {
      logger.warn(`${SOURCE}: sweep failed for ${sup.id.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    }
  }
  if (counters.nudges || counters.autofiled || counters.askNudges || counters.askEscalations || twinCounters.askTwinNudges || twinCounters.askTwinEscalations) logger.info(`${SOURCE}: sweep supervisors=${counters.supervisors} nudges=${counters.nudges} autofiled=${counters.autofiled} askNudges=${counters.askNudges} askEscalations=${counters.askEscalations} askTwinNudges=${twinCounters.askTwinNudges} askTwinEscalations=${twinCounters.askTwinEscalations}`, { source: SOURCE });
  return counters;
}

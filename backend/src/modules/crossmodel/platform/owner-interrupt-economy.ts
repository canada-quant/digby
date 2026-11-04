/**
 * OWNER-INTERRUPT-ECONOMY (supervisor SOTA round 3, 2026-10-20) — fewer,
 * better owner interruptions. The owner_questions inbox already persists every
 * "needs owner" card; what nothing did was MEASURE or BUDGET the owner's
 * interrupt load (architecture review evidence: flagOwnerQuestion DMed the
 * owner on EVERY flag; the caps are per chat, never per owner; the N8
 * prior-answer scan covered only stop-asking answers on machine flags; a
 * supervisor's own cards skip triage; oq_c7736e9f was a reversible choice with
 * no default). This module holds the five pieces the flag / answer / sweep
 * paths share:
 *
 *   1. MEASURED — loop_metrics owner_question_flagged (one row per flag call:
 *      outcome, delivery, recall, reversible, advisory) and
 *      owner_question_resolved (one row per resolution: who, how fast, which
 *      surface). Kill switch OWNER_INTERRUPT_METRICS_DISABLED=1.
 *   2. PRIOR-DECISION RECALL (90 d, isSameDecisionQuestion) — a MACHINE re-ask
 *      that is a STRICT same-decision match of an answer the OWNER gave is
 *      refused citing that answer (an escape hatch, revisitReason, files it
 *      annotated instead); every other match (a human filer, a loose match, an
 *      owner-only class) files ANNOTATED: "you decided this on <date>" plus a
 *      "Same as before" reply that the answer path expands to the prior
 *      decision. Kill switch OWNER_PRIOR_DECISION_RECALL_DISABLED=1.
 *   3. ASK-VS-DECIDE — a supervisor's machine-turn card outside the owner-only
 *      classes gets an observe-only advisory on the tool result (decide it
 *      yourself and report). Never a refusal. Kill switch
 *      OWNER_ASK_VS_DECIDE_ADVISORY_DISABLED=1.
 *   4. REVERSIBLE DEFAULT — a card the flagger marks reversible WITH a
 *      recommended default, outside the owner-only classes, auto-applies that
 *      default after 24 h with no answer; the application is announced in the
 *      next digest. Kill switch OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED=1
 *      (nothing new arms, and an ALREADY-armed card is applied by no seam —
 *      not the sweep, not the P7 blocked-item path).
 *   5. PER-OWNER DECISION DIGEST — a card only the owner can answer (money,
 *      credentials, irreversible / destructive, external commitments,
 *      physically-human, cross-project scope) or one marked urgent / high
 *      cost-of-delay is DMed at once as before; every other card is batched
 *      into ONE per-owner digest DM, at most every 12 h, and no card waits
 *      longer than 12 h from reaching the owner's queue (its filing; a card
 *      the Fleet Supervisor held in triage, from the moment it surfaced).
 *      Kill switch OWNER_DECISION_DIGEST_DISABLED=1
 *      (every card DMs at once again; anything already queued is flushed by
 *      the next sweep, never dropped).
 *
 * OWNER DECISION (Paul, 2026-10-20): ship it; the batching / auto-default /
 * strict-refusal rules above are his. Fail toward delivery everywhere: a
 * store / queue failure sends the DM immediately (today's behaviour), a
 * recall-lookup failure files the card unannotated, and a card never
 * disappears — the Inbox lists every open card regardless of the DM path.
 *
 * Lazy prisma / store / telegram / loop-metrics imports (the owner-questions
 * discipline: a static config/database import process.exits a jest worker).
 */

import {
  classifyOwnerQuestionRouting,
  isSameDecisionQuestion,
  isCounterQuestionRow,
  parseStoredOptions,
  renderOptionsNumbered,
  renderCostOfDelay,
  shortQuestionRef,
  stripPriorDecisionAnnotation,
  clipQuestionKeepingAnnotation,
  PRIOR_DECISION_MARK,
  matchAnswerToOption,
} from './owner-questions';
import type { OwnerQuestionOption, OwnerQuestionRoutingReason, OwnerQuestionView } from './owner-questions';

// ── Kill switches (read per call) ────────────────────────────────────────────

export function ownerPriorDecisionRecallDisabled(): boolean {
  return process.env.OWNER_PRIOR_DECISION_RECALL_DISABLED === '1';
}
export function ownerDecisionDigestDisabled(): boolean {
  return process.env.OWNER_DECISION_DIGEST_DISABLED === '1';
}
export function ownerQuestionReversibleDefaultDisabled(): boolean {
  return process.env.OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED === '1';
}
export function ownerAskVsDecideAdvisoryDisabled(): boolean {
  return process.env.OWNER_ASK_VS_DECIDE_ADVISORY_DISABLED === '1';
}
export function ownerInterruptMetricsDisabled(): boolean {
  return process.env.OWNER_INTERRUPT_METRICS_DISABLED === '1';
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Prior-decision recall window (design: 90 d). */
export const PRIOR_DECISION_RECALL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/** How many answered rows the recall scans (newest first). */
export const PRIOR_DECISION_SCAN_LIMIT = 50;
/** The digest window: at most one digest per owner per window, and no batched
 *  card waits longer than this from filing (owner rule: 12 h). */
export const OWNER_DECISION_DIGEST_WINDOW_MS = 12 * 60 * 60 * 1000;
/** The digest sweep rides the attention-watchdog (900 s cadence): a digest is
 *  due one sweep early so the 12 h bound holds at that granularity. */
export const OWNER_DECISION_DIGEST_SLACK_MS = 15 * 60 * 1000;
/** Reversible recommended defaults apply after 24 h with no answer (owner rule). */
export const REVERSIBLE_DEFAULT_AFTER_DAYS = 1;
/** A flagger cost-of-delay at or above this (USD/day) is "high cost-of-delay"
 *  — sent immediately: a 12 h hold would idle ≥ half of it. */
export const HIGH_COST_OF_DELAY_USD_PER_DAY = 25;
/** The typed option the recall appends to a card that already carries options. */
export const PRIOR_DECISION_OPTION_ID = 'same_as_before';
/** Bounds per digest sweep pass. */
export const DIGEST_QUEUE_SCAN_LIMIT = 500;
export const DIGEST_OWNERS_PER_PASS = 50;
export const DIGEST_MAX_ITEMS = 15;
/** A queued entry the DM path could not deliver for this long is dropped (the
 *  card itself stays in the Inbox — only the push is abandoned). */
export const DIGEST_ENTRY_MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** Reversible-default rows applied per sweep pass. */
export const REVERSIBLE_DEFAULTS_PER_PASS = 50;
/** Armed-index rows read per sweep pass (oldest first; resolved / retired rows
 *  leave the index, so the window never fills with dead rows). */
export const REVERSIBLE_ARMED_SCAN_LIMIT = 500;
/** An armed default still unapplied this long past its 24 h due time is
 *  counted 'overdue' (one owner_reversible_default row per pass). */
export const REVERSIBLE_DEFAULT_OVERDUE_ALARM_MS = 2 * 60 * 60 * 1000;
/** The digest DM is kept to ONE Telegram message (the Bot API caps a message
 *  at 4096; telegram.service splits at 4000 and reports a partial send as a
 *  failure — a multi-chunk digest would be re-sent whole on a retry). */
export const DIGEST_TEXT_MAX = 3800;
/** Applied defaults listed per digest (the rest are counted). */
export const DIGEST_MAX_DEFAULTS = 10;

export const DIGEST_QUEUE_NS = ['owner-decision-digest', 'queue'];
export const DIGEST_CLAIM_NS = ['owner-decision-digest', 'claim'];
export const DIGEST_OWNER_NS = ['owner-decision-digest', 'owner'];
export const ECONOMY_MARKER_NS = ['owner-question-economy'];
export const REVERSIBLE_ARMED_NS = ['owner-question-economy', 'reversible-armed'];

// ── Owner-only interrupt classes ─────────────────────────────────────────────
// The routing classifier (classifyOwnerQuestionRouting) deliberately keeps
// money OUT of its owner-only list (budgets are pre-approved — a cost question
// triages to the supervisor). The owner's 2026-10-20 batching rule names the
// classes only he can answer — money, credentials, irreversible / destructive,
// external commitments — so the INTERRUPT class is wider: it is used ONLY for
// "send at once", "never auto-default" and "never refuse as already decided",
// where over-matching costs at most today's behaviour (an immediate DM, a card
// that waits for the owner). It never changes triage or answer authority.

/** Money: an amount or a spend / purchase / billing verb. */
export const MONEY_QUESTION_RE =
  /\$\s?\d|\b\d+(?:\.\d+)?\s?(?:usd|cad|eur|dollars?)\b|\b(?:spend(?:ing)?|budget|purchas\w*|buy(?:ing)?|subscri(?:be|ption)\w*|invoice\w*|payment\w*|pay\s+(?:for|the)|billing|credit\s+card|refund\w*|pric(?:e|es|ing)|costs?)\b/i;
/** Irreversible / destructive verbs (wider than the routing class). */
export const DESTRUCTIVE_QUESTION_RE =
  /\b(?:delet(?:e|ing)|drop(?:ping)?\s+(?:the\s+)?(?:table|database|db|bucket|branch|index)|purg(?:e|ing)|force[- ]push|reset\s+--hard|rm\s+-rf|destroy\w*|wip(?:e|ing)|terminat(?:e|ing)|decommission\w*|tear(?:ing)?\s+down|shut(?:ting)?\s*down|revok(?:e|ing)|irreversib\w*|cannot\s+be\s+undone|permanent(?:ly)?)\b/i;
/** Credentials (wider than the routing class's rotate / revoke / share verbs). */
export const CREDENTIAL_QUESTION_RE =
  /\b(?:credentials?|passwords?|passphrase|api[- ]?keys?|access\s+tokens?|secret\s+keys?|private\s+keys?|ssh\s+keys?|2fa|otp|mfa)\b/i;
/** External commitments: anything that binds the owner to someone outside.
 *  Verbs / documents, not bare nouns ("the HTTP client", "commit to main" are
 *  engineering, not commitments). */
export const EXTERNAL_COMMITMENT_RE =
  /\b(?:contracts?|agreements?|sign(?:ed|ing)?\s+(?:up|off|the|a|an)\b|commitments?|commit(?:ting)?\s+(?:us|you|ourselves|the\s+(?:company|team|business))\s+to|promis(?:e|ing)\s+(?:the|a|an|our|them|him|her)|announc(?:e|ement|ing)|press\s+release|go\s+public|on\s+(?:your|the\s+owner'?s?)\s+behalf|(?:reply|respond|write|email)\s+(?:to\s+)?(?:the\s+)?(?:customers?|clients?|investors?|partners?|vendors?)|legal|lawyers?|terms\s+of|nda)\b/i;

export type OwnerOnlyInterruptReason = OwnerQuestionRoutingReason | 'money' | 'external_commitment';

/**
 * Is this card one only the OWNER can answer (owner rule 2026-10-20)? Returns
 * the reason or null. Checks the routing classifier's owner-only classes, the
 * structural flags the flag path knows (credential gate, console action,
 * delivered secrets, a roster-named other project), then the wider money /
 * destructive / credential / external-commitment cues. The prior-decision
 * annotation is stripped first (it quotes an old answer, not this ask). Pure.
 */
export function ownerOnlyInterruptReason(
  question: string,
  context?: string | null,
  flags: { credentialGate?: boolean; consoleAction?: boolean; carriesSecrets?: boolean; namesOtherProject?: boolean } = {},
): OwnerOnlyInterruptReason | null {
  const q = stripPriorDecisionAnnotation(String(question ?? ''));
  const routing = classifyOwnerQuestionRouting(q, context ?? null);
  if (routing.route === 'owner') return routing.reason;
  if (flags.credentialGate || flags.carriesSecrets) return 'credentials';
  if (flags.consoleAction) return 'physically_human';
  if (flags.namesOtherProject) return 'cross_project_scope';
  const text = `${q}\n${String(context ?? '')}`;
  if (MONEY_QUESTION_RE.test(text)) return 'money';
  if (DESTRUCTIVE_QUESTION_RE.test(text)) return 'irreversible';
  if (CREDENTIAL_QUESTION_RE.test(text)) return 'credentials';
  if (EXTERNAL_COMMITMENT_RE.test(text)) return 'external_commitment';
  return null;
}

// ── Delivery: immediate vs digest ────────────────────────────────────────────

export type OwnerQuestionDelivery = 'immediate' | 'digest';

/**
 * The owner's batching rule (2026-10-20). Immediate: the digest is off, the
 * card is owner-only, the flagger marked it urgent, or its cost of delay is
 * high. Everything else: the per-owner digest. Pure.
 */
export function classifyOwnerQuestionDelivery(input: {
  ownerOnlyReason: string | null;
  urgent?: boolean;
  idleUsdPerDay?: number | null;
  digestDisabled?: boolean;
}): { delivery: OwnerQuestionDelivery; reason: string } {
  if (input.digestDisabled ?? ownerDecisionDigestDisabled()) return { delivery: 'immediate', reason: 'digest_disabled' };
  if (input.ownerOnlyReason) return { delivery: 'immediate', reason: `owner_only:${input.ownerOnlyReason}` };
  if (input.urgent === true) return { delivery: 'immediate', reason: 'urgent' };
  const idle = typeof input.idleUsdPerDay === 'number' && Number.isFinite(input.idleUsdPerDay) ? input.idleUsdPerDay : 0;
  if (idle >= HIGH_COST_OF_DELAY_USD_PER_DAY) return { delivery: 'immediate', reason: 'cost_of_delay' };
  return { delivery: 'digest', reason: 'batched' };
}

// ── Prior-decision recall ────────────────────────────────────────────────────

/** Negation carriers — DECISION_STOPWORDS drops them from the content set, so
 *  the strict test compares them separately ("with" vs "without" the
 *  migration is two decisions, never one). */
const NEGATION_TOKENS = new Set(['not', 'no', 'without', 'never', 'dont', 'don', 'nor', 'cannot', 'cant', 'won', 'wont', 'stop', 'skip', 'instead']);
const STRICT_STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'we', 'should', 'shall', 'would', 'could', 'can', 'will', 'do', 'does', 'did',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'have', 'has', 'had',
  'i', 'me', 'my', 'our', 'us', 'you', 'your', 'it', 'its',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'when',
  'where', 'why', 'how', 'if', 'then', 'else', 'than', 'so', 'such', 'as',
  'at', 'by', 'from', 'into', 'about', 'over', 'under', 'again', 'once',
  'just', 'also', 'please', 'per', 'via', 'now', 'yes',
  'need', 'needed', 'decision', 'decisions', 'question', 'answer', 'answered', 'owner',
]);

function strictTokens(s: string): { content: Set<string>; negation: Set<string> } {
  const toks = stripPriorDecisionAnnotation(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const content = new Set<string>();
  const negation = new Set<string>();
  for (const t of toks) {
    if (NEGATION_TOKENS.has(t)) negation.add(t);
    else if (!STRICT_STOPWORDS.has(t)) content.add(t);
  }
  return { content, negation };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/**
 * STRICT same-decision match (owner rule: refusals apply ONLY on a strict
 * match). Beyond isSameDecisionQuestion (which accepts subset coverage and
 * ignores negation carriers — its documented residuals), both questions must
 * carry the SAME content-token set (word order / casing / punctuation /
 * function words free) AND the same negation carriers, with ≥ 3 content
 * tokens. "Merge PR 601?" vs "Merge PR 601 and PR 602?" and "Ship with the
 * migration?" vs "Ship without the migration?" are NOT strict matches. Pure.
 */
export function isStrictSameDecision(a: string, b: string): boolean {
  const sa = stripPriorDecisionAnnotation(String(a ?? ''));
  const sb = stripPriorDecisionAnnotation(String(b ?? ''));
  if (!isSameDecisionQuestion(sa, sb)) return false;
  const ta = strictTokens(sa);
  const tb = strictTokens(sb);
  if (ta.content.size < 3) return false;
  return sameSet(ta.content, tb.content) && sameSet(ta.negation, tb.negation);
}

export interface PriorDecisionCandidate {
  id: string;
  question: string;
  answer?: string | null;
  status?: string | null;
  answeredBy?: string | null;
  chosenOption?: string | null;
  /** The prior card's stored options — the LABEL its chosenOption named is
   *  what "Same as before" maps onto the new card (ids are positional). */
  options?: unknown;
  expectedAnswerType?: string | null;
  resolvedAt?: Date | string | null;
}

export interface PriorDecisionMatch {
  row: PriorDecisionCandidate;
  strict: boolean;
  decidedOn: string; // YYYY-MM-DD (UTC)
}

function toMs(d: Date | string | null | undefined): number {
  if (!d) return NaN;
  return d instanceof Date ? d.getTime() : new Date(d).getTime();
}

/**
 * Pick the newest ANSWERED row the OWNER decided within the window that is the
 * same decision as `question`. Excludes supervisor / preset-default answers
 * (not the owner's decision), counter-questions (no ruling was made),
 * credential-typed rows (a key is never "the same as before") and empty
 * answers. Pure; exported for tests.
 */
export function pickPriorOwnerDecision(
  question: string,
  rows: PriorDecisionCandidate[],
  now: Date = new Date(Date.now()),
): PriorDecisionMatch | null {
  const cut = now.getTime() - PRIOR_DECISION_RECALL_WINDOW_MS;
  const eligible = (rows ?? [])
    .filter((r) => {
      if (!r || r.status !== 'answered') return false;
      if (r.answeredBy && r.answeredBy !== 'owner') return false;
      if (!String(r.answer ?? '').trim()) return false;
      if (String(r.expectedAnswerType ?? '').startsWith('credential')) return false;
      if (isCounterQuestionRow({ status: 'answered', answer: r.answer ?? null, chosenOption: r.chosenOption ?? null, answeredBy: r.answeredBy ?? null })) return false;
      const at = toMs(r.resolvedAt);
      return Number.isFinite(at) && at >= cut && at <= now.getTime() + 60_000;
    })
    .sort((a, b) => toMs(b.resolvedAt) - toMs(a.resolvedAt));
  for (const r of eligible) {
    const prior = stripPriorDecisionAnnotation(String(r.question ?? ''));
    if (!isSameDecisionQuestion(prior, question)) continue;
    return {
      row: r,
      strict: isStrictSameDecision(prior, question),
      decidedOn: new Date(toMs(r.resolvedAt)).toISOString().slice(0, 10),
    };
  }
  return null;
}

/** The answer text the annotation and the expansion carry: the typed-option
 *  bookkeeping suffix and any vault notice are stripped, newlines folded. */
export function priorDecisionAnswerCore(answer: string | null | undefined): string {
  return String(answer ?? '')
    .replace(/\s*\[option [^\]]*\]/g, '')
    .replace(/\s*\[CREDENTIAL VAULTED[^\]]*\]/g, '')
    .replace(/\s*\[same as before[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ANNOTATION_ANSWER_MAX = 300;
/** The compact annotation's answer clip (a question near its budget). */
const ANNOTATION_ANSWER_COMPACT_MAX = 120;
/** Ends a NEW question that had to be cut to fit its prior-decision note —
 *  never a silent cut (review 2026-10-20: the cut tail is where a re-ask
 *  carries the changed figures). */
export const QUESTION_TRUNCATED_FOR_NOTE_MARK = ' …[question truncated to fit the prior-decision note — the full text is in the asking chat]';

/**
 * The annotation appended to a card whose decision the owner already made —
 * kept on the QUESTION text (the Inbox card headline and the DM both show it;
 * the context is collapsed and never DMed). Starts with PRIOR_DECISION_MARK so
 * every dedupe / match path strips it (stripPriorDecisionAnnotation).
 * `compact` (a question near its budget): the answer is clipped to 120 chars
 * and a loose match cites the prior card by ref only. Pure.
 */
export function renderPriorDecisionAnnotation(match: PriorDecisionMatch, opts: { ownerOnlyReason?: string | null; compact?: boolean } = {}): string {
  const ref = `oq_${shortQuestionRef(match.row.id)}`;
  const answer = priorDecisionAnswerCore(match.row.answer).replace(/[«»]/g, '"').slice(0, opts.compact ? ANNOTATION_ANSWER_COMPACT_MAX : ANNOTATION_ANSWER_MAX);
  const what = match.strict
    ? `you decided this on ${match.decidedOn} (${ref})`
    : opts.compact
      ? `you decided a closely matching question on ${match.decidedOn} (${ref})`
      : `you decided a closely matching question on ${match.decidedOn} (${ref}: "${stripPriorDecisionAnnotation(String(match.row.question ?? '')).replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').slice(0, 140)}")`;
  const why = opts.ownerOnlyReason ? ' Asked again because this kind of decision needs your call each time.' : '';
  return `${PRIOR_DECISION_MARK} ${what}: «${answer}».${why} Reply "Same as before" to repeat it.`;
}

/**
 * The new question with its prior-decision annotation, fitted to `budget`
 * WITHOUT silently dropping the new question's content (review 2026-10-20):
 * the full note when it fits; else the compact note; else the question is
 * cut with an explicit QUESTION_TRUNCATED_FOR_NOTE_MARK before the compact
 * note. Pure.
 */
export function annotateQuestionWithPriorDecision(
  question: string,
  match: PriorDecisionMatch,
  opts: { budget: number; ownerOnlyReason?: string | null },
): string {
  const q = String(question ?? '');
  const full = renderPriorDecisionAnnotation(match, { ownerOnlyReason: opts.ownerOnlyReason });
  if (q.length + full.length <= opts.budget) return `${q}${full}`;
  const compact = renderPriorDecisionAnnotation(match, { ownerOnlyReason: opts.ownerOnlyReason, compact: true });
  if (q.length + compact.length <= opts.budget) return `${q}${compact}`;
  const room = Math.max(0, opts.budget - compact.length - QUESTION_TRUNCATED_FOR_NOTE_MARK.length);
  return `${q.slice(0, room)}${QUESTION_TRUNCATED_FOR_NOTE_MARK}${compact}`;
}

/** Parse the annotation back off a stored question (the answer path's
 *  "Same as before" expansion). Pure; null when the row carries none. */
export function parsePriorDecisionAnnotation(question: string): { decidedOn: string; questionRef: string; answer: string } | null {
  const q = String(question ?? '');
  const at = q.indexOf(PRIOR_DECISION_MARK);
  if (at < 0) return null;
  const tail = q.slice(at + PRIOR_DECISION_MARK.length);
  const m = /decided (?:this|a closely matching question) on (\d{4}-\d{2}-\d{2}) \((oq_[0-9a-f-]{4,40})/i.exec(tail);
  const open = tail.indexOf('«');
  const close = tail.lastIndexOf('»');
  if (!m || open < 0 || close <= open) return null;
  return { decidedOn: m[1], questionRef: m[2], answer: tail.slice(open + 1, close).trim() };
}

/** Owner replies that mean "repeat my prior decision". */
export const SAME_AS_BEFORE_ANSWER_RE =
  /^\s*(?:same\s+as\s+(?:before|last\s+time|then)|same(?:\s+answer)?(?:\s+again)?|as\s+before|repeat\s+(?:it|that|my\s+(?:last\s+)?(?:answer|decision)))\s*[.!]?\s*$/i;

/** The "Same as before" typed option (appended to a card that already has
 *  typed options, when there is room). Pure. */
export function priorDecisionOption(match: PriorDecisionMatch): OwnerQuestionOption {
  const answer = priorDecisionAnswerCore(match.row.answer).slice(0, 200);
  return {
    id: PRIOR_DECISION_OPTION_ID,
    label: 'Same as before',
    consequence: `repeat your ${match.decidedOn} decision: "${answer}"`.slice(0, 300),
  };
}

/** A yes/no RULING (the typed yes_no gate's own resolving shape). */
const YES_NO_RULING_RE = /^\s*(?:yes|yeah|yep|ok(?:ay)?|go|approve[d]?|no|nope|nah|don'?t|stop|decline[d]?)\b/i;

function normOptionLabel(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Map the owner's PRIOR decision onto one of THIS card's options — by LABEL,
 * never by option id or position (review 2026-10-20 BLOCKING: option ids are
 * positional by default — `opt_<n>` — so on a re-asked card with reordered
 * options the prior id can name the OPPOSITE choice). The prior label is the
 * label the prior row's chosenOption named in ITS OWN stored options; with no
 * resolvable prior option the prior answer text itself is the label (an option
 * pick is stored as "<label>" / "<label> [option …]"). Matched by normalized
 * label equality only — a bare id or number is never consulted. Null = no
 * option on this card carries that decision (the caller stores it as free
 * text, so a typed gate keeps the card open). Pure.
 */
export function mapPriorDecisionToOption(input: {
  priorRow?: { chosenOption?: string | null; options?: unknown } | null;
  answer: string;
  options: OwnerQuestionOption[] | null | undefined;
}): OwnerQuestionOption | null {
  const others = (input.options ?? []).filter((o) => o.id !== PRIOR_DECISION_OPTION_ID);
  if (!others.length) return null;
  let priorLabel = '';
  const chosen = input.priorRow?.chosenOption;
  if (chosen) priorLabel = parseStoredOptions(input.priorRow?.options).find((o) => o.id === chosen)?.label ?? '';
  const target = normOptionLabel(priorLabel || priorDecisionAnswerCore(input.answer));
  if (!target) return null;
  return others.find((o) => normOptionLabel(o.label) === target) ?? null;
}

/**
 * Append the "Same as before" option to typed options (≤ 6; never duplicated).
 * Free-text cards stay free text — the annotation's reply hint covers them,
 * and an injected lone option would replace the card's Approve / Decline.
 * A TYPED gate gets the option only when the prior decision satisfies it
 * (review 2026-10-20): a choice gate when the prior maps to one of its options
 * by label, a yes/no gate when the prior is a ruling (or maps) — otherwise
 * tapping the card's own button would leave the card open as reply_recorded.
 */
export function withPriorDecisionOption(
  options: OwnerQuestionOption[] | null,
  match: PriorDecisionMatch,
  opts: { expectedType?: string | null } = {},
): OwnerQuestionOption[] | null {
  if (!options || !options.length) return options;
  if (options.length >= 6) return options;
  if (options.some((o) => o.id === PRIOR_DECISION_OPTION_ID || /^same as before$/i.test(o.label))) return options;
  const t = opts.expectedType ?? null;
  if (t === 'credential') return options;
  if (t === 'choice' || t === 'yes_no') {
    const mapped = mapPriorDecisionToOption({ priorRow: match.row, answer: String(match.row.answer ?? ''), options });
    const ruling = t === 'yes_no' && YES_NO_RULING_RE.test(priorDecisionAnswerCore(match.row.answer));
    if (!mapped && !ruling) return options;
  }
  return [...options, priorDecisionOption(match)];
}

/**
 * Resolve an owner reply of "Same as before" (typed option or free text) on an
 * annotated card into the prior decision: the reply text the answer path then
 * stores, the option it maps to on THIS card (mapPriorDecisionToOption — by
 * LABEL, never by id / position; null = stored as free text), and the stamp
 * the stored answer carries. Null when the reply is not a same-as-before reply
 * or the card carries no annotation. Pure — the caller may pass the prior row
 * it fetched (full answer + chosen option + its options) to beat the 300-char
 * annotation clip.
 */
export function resolveSameAsBefore(input: {
  question: string;
  reply: string;
  options: OwnerQuestionOption[];
  priorRow?: { answer?: string | null; chosenOption?: string | null; options?: unknown; status?: string | null } | null;
}): { reply: string; option: OwnerQuestionOption | null; stamp: string } | null {
  const reply = String(input.reply ?? '').trim();
  const opt = matchAnswerToOption(input.options ?? [], reply);
  const isSame = (opt && opt.id === PRIOR_DECISION_OPTION_ID) || (!opt && SAME_AS_BEFORE_ANSWER_RE.test(reply));
  if (!isSame) return null;
  const parsed = parsePriorDecisionAnnotation(input.question);
  if (!parsed) return null;
  const priorRow = input.priorRow && input.priorRow.status === 'answered' ? input.priorRow : null;
  const fromRow = priorRow ? priorDecisionAnswerCore(priorRow.answer) : '';
  const answer = fromRow || parsed.answer;
  if (!answer) return null;
  const option = mapPriorDecisionToOption({ priorRow, answer, options: input.options });
  return {
    reply: option ? option.label : answer,
    option,
    stamp: `[same as before — repeating the owner's ${parsed.decidedOn} decision ${parsed.questionRef}]`,
  };
}

/**
 * Flag-time recall lookup: the owner's ANSWERED rows of the same project (the
 * N8 scope — every chat of the filing chat's project, else the filing chat)
 * within 90 d, newest first, picked by pickPriorOwnerDecision. Throws on a read
 * failure (the caller files unannotated — fail toward delivery).
 */
export async function findPriorOwnerDecision(
  prisma: any,
  input: { chatId: string; userId: string },
  question: string,
  now: Date = new Date(Date.now()),
): Promise<PriorDecisionMatch | null> {
  const since = new Date(now.getTime() - PRIOR_DECISION_RECALL_WINDOW_MS);
  let chatIds: string[] = [input.chatId];
  try {
    const chat = await prisma?.crossModelChat?.findUnique?.({ where: { id: input.chatId }, select: { projectId: true } });
    const projectId = typeof chat?.projectId === 'string' ? chat.projectId : null;
    if (projectId) {
      const projectChats = await prisma?.crossModelChat?.findMany?.({ where: { projectId, userId: input.userId }, select: { id: true }, take: 200 });
      if (Array.isArray(projectChats) && projectChats.length) {
        chatIds = [...new Set([input.chatId, ...projectChats.map((c: any) => String(c.id))])];
      }
    }
  } catch { /* scope probe best-effort — the filing chat alone */ }
  const rows = await prisma.ownerQuestion.findMany({
    where: { userId: input.userId, status: 'answered', chatId: { in: chatIds }, resolvedAt: { gte: since } },
    orderBy: { resolvedAt: 'desc' },
    take: PRIOR_DECISION_SCAN_LIMIT,
  });
  return pickPriorOwnerDecision(question, Array.isArray(rows) ? rows : [], now);
}

/** The refusal a MACHINE strict re-ask gets (owner rule). Pure. */
export function priorDecisionRefusalMessage(match: PriorDecisionMatch): string {
  const ref = `oq_${shortQuestionRef(match.row.id)}`;
  return `The owner already decided this exact question on ${match.decidedOn} (${ref}): "${priorDecisionAnswerCore(match.row.answer).slice(0, 300)}". `
    + 'Act on that decision — do not re-ask it. If something MATERIAL changed since then, re-call flag_owner_question with revisitReason:"<what changed>" '
    + 'and the card files with the prior decision shown beside it.';
}

// ── Ask-vs-decide (supervisor filer; observe-only) ───────────────────────────

/**
 * A supervisor filing an owner card on a machine turn: if the card is outside
 * the owner-only classes, the owner's standing directives let the supervisor
 * decide it — say so on the tool result (observe-only: the card still files).
 * Pure.
 */
export function askVsDecideAdvisory(input: {
  supervisorFiler: boolean | null;
  machine: boolean;
  ownerOnlyReason: string | null;
  reversible?: boolean;
  hasRecommendation?: boolean;
  disabled?: boolean;
}): { advise: boolean; reason: string; message?: string } {
  if (input.disabled ?? ownerAskVsDecideAdvisoryDisabled()) return { advise: false, reason: 'disabled' };
  if (input.supervisorFiler !== true) return { advise: false, reason: 'not_supervisor' };
  if (!input.machine) return { advise: false, reason: 'owner_present' };
  if (input.ownerOnlyReason) return { advise: false, reason: `owner_only:${input.ownerOnlyReason}` };
  const recommended = input.reversible === true && input.hasRecommendation === true;
  const reason = recommended ? 'reversible_with_recommendation' : 'not_owner_only';
  const lead = recommended
    ? 'You marked this card REVERSIBLE and already recommend a default — that is a decision you can make.'
    : 'This card is outside the owner-only classes (money, credentials, irreversible / destructive, external commitments, physically-human, cross-project scope).';
  return {
    advise: true,
    reason,
    message: `[ASK-VS-DECIDE — observe-only] ${lead} Under the owner's standing directives a supervisor decides such questions itself: decide, act, and report the decision; if you do, withdraw this card with dismiss_owner_question. The card was filed (nothing was refused).`,
  };
}

// ── Reversible recommended default ───────────────────────────────────────────

/**
 * Owner rule: the 24 h auto-default applies ONLY to a card flagged reversible
 * WITH a recommended default, outside the owner-only classes. A typed gate
 * arms only when the default IS its declared shape (a choice gate: one of the
 * typed options; yes/no: a ruling; a credential gate never). Pure.
 */
export function reversibleDefaultEligibility(input: {
  reversible: boolean;
  recommendedDefault: string;
  ownerOnlyReason: string | null;
  expectedType?: string | null;
  options?: OwnerQuestionOption[] | null;
  disabled?: boolean;
}): { armed: boolean; reason: string } {
  if (!input.reversible) return { armed: false, reason: 'not_requested' };
  if (input.disabled ?? ownerQuestionReversibleDefaultDisabled()) return { armed: false, reason: 'disabled' };
  const rec = String(input.recommendedDefault ?? '').trim();
  if (!rec) return { armed: false, reason: 'no_recommended_default' };
  if (input.ownerOnlyReason) return { armed: false, reason: `owner_only:${input.ownerOnlyReason}` };
  const t = input.expectedType ?? null;
  if (t === 'credential') return { armed: false, reason: 'credential_gate' };
  if (t === 'choice' && !matchAnswerToOption(input.options ?? [], rec)) return { armed: false, reason: 'default_not_an_option' };
  if (t === 'yes_no' && !YES_NO_RULING_RE.test(rec) && !matchAnswerToOption(input.options ?? [], rec)) return { armed: false, reason: 'default_not_a_ruling' };
  return { armed: true, reason: 'armed' };
}

/** Does a stored row's preset default satisfy its own typed gate? (the
 *  reversible arm only — applyDefaultAnswerIfDue keeps refusing typed gates
 *  for every other preset default). Pure. */
export function reversibleDefaultFitsTypedGate(expectedType: string | null, defaultOption: string, options: OwnerQuestionOption[]): boolean {
  if (!expectedType) return true;
  if (expectedType === 'credential') return false;
  if (expectedType === 'choice') return !!matchAnswerToOption(options, defaultOption);
  if (expectedType === 'yes_no') return YES_NO_RULING_RE.test(defaultOption) || !!matchAnswerToOption(options, defaultOption);
  return false;
}

// ── Economy marker (per question; context store) ─────────────────────────────

export interface OwnerQuestionEconomyMarker {
  urgent?: boolean;
  reversible?: boolean;
  recommendedDefault?: string;
  at?: string;
}

/** One row per ARMED reversible default — the sweep's own candidate set
 *  (review 2026-10-20: scanning owner_questions for open 1-day defaults read
 *  the same 50 oldest rows forever once legacy preset defaults / refused rows
 *  filled the window). Removed when the default applies, is retired, or the
 *  card resolves another way. */
export interface ReversibleArmedEntry {
  recommendedDefault?: string;
  at?: string;
}

/** Write the per-question marker (and, for a reversible default, its
 *  armed-index row — written only after the marker, so an index row always
 *  has its marker). Returns false on any failure (never throws). */
export async function writeEconomyMarker(questionId: string, marker: OwnerQuestionEconomyMarker): Promise<boolean> {
  try {
    const store = await import('../memory/context-store');
    const at = marker.at ?? new Date(Date.now()).toISOString();
    await store.storePut(ECONOMY_MARKER_NS, questionId, { ...marker, at } as any);
    if (marker.reversible === true) {
      const entry: ReversibleArmedEntry = { ...(marker.recommendedDefault ? { recommendedDefault: marker.recommendedDefault } : {}), at };
      await store.storePut(REVERSIBLE_ARMED_NS, questionId, entry as any);
    }
    return true;
  } catch {
    return false;
  }
}

/** Read the per-question marker. Null when absent; THROWS on a read failure so
 *  a caller can fail toward delivery (an unknown urgency is sent at once). */
export async function readEconomyMarker(questionId: string): Promise<OwnerQuestionEconomyMarker | null> {
  const store = await import('../memory/context-store');
  return (await store.storeGet<OwnerQuestionEconomyMarker>(ECONOMY_MARKER_NS, questionId)) ?? null;
}

/** Same read, never throws (null on failure) — for paths that only ADD
 *  behaviour when a marker is present (the reversible default). */
export async function readEconomyMarkerSafe(questionId: string): Promise<OwnerQuestionEconomyMarker | null> {
  try { return await readEconomyMarker(questionId); } catch { return null; }
}

// ── Digest queue ─────────────────────────────────────────────────────────────

export type DigestEntryKind = 'question' | 'auto_default';

export interface DigestEntry {
  userId: string;
  questionId: string;
  kind: DigestEntryKind;
  /** The wait anchor: the card's filing time (question) / the default's
   *  application time (auto_default). The 12 h bound runs from it. */
  anchorAt: string;
  queuedAt: string;
}

/**
 * Queue one card / announcement for the owner's next digest. Returns true
 * only when the entry is durably stored — the caller sends the DM at once on
 * false (fail toward delivery). The digest is sent ONLY by the attention
 * watchdog (worker cron), so with ATTENTION_WATCHDOG_DISABLED=1 nothing would
 * ever push a queued card — queue nothing then (review 2026-10-20): every card
 * DMs at once, as before this change. Never throws.
 */
export async function queueOwnerDigestEntry(input: { userId: string; questionId: string; kind: DigestEntryKind; anchorAt: Date }): Promise<boolean> {
  try {
    if (ownerDecisionDigestDisabled()) return false;
    if (process.env.ATTENTION_WATCHDOG_DISABLED === '1') return false;
    const anchorMs = input.anchorAt instanceof Date ? input.anchorAt.getTime() : new Date(input.anchorAt as any).getTime();
    const entry: DigestEntry = {
      userId: input.userId,
      questionId: input.questionId,
      kind: input.kind,
      anchorAt: new Date(Number.isFinite(anchorMs) ? anchorMs : Date.now()).toISOString(),
      queuedAt: new Date(Date.now()).toISOString(),
    };
    const store = await import('../memory/context-store');
    await store.storePut(DIGEST_QUEUE_NS, `${input.questionId}:${input.kind}`, entry as any);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is a digest due for an owner whose oldest pending entry is anchored at
 * `oldestAnchorMs`? Due one sweep early (the slack) so no card waits past the
 * window. The owner's two rules — "at most every 12 h" and "no question waits
 * longer than 12 h" — are both met by the ANCHORS: every entry queued after a
 * digest is anchored at or after it (a fresh card at filing, a triage-surfaced
 * card at the moment it SURFACED to the owner, an applied default at its
 * application), so the oldest entry's 12 h mark is never earlier than the
 * last digest + 12 h (less the one-sweep slack). Should they ever conflict (an
 * entry anchored before the last digest — one the previous pass did not list),
 * the WAIT bound wins: fail toward delivery. The sweep records the spacing
 * (sinceLastDigestMin / spacingOverridden) so the bound stays auditable. Pure.
 */
export function digestDue(input: { oldestAnchorMs: number; nowMs: number; windowMs?: number; slackMs?: number }): boolean {
  const windowMs = input.windowMs ?? OWNER_DECISION_DIGEST_WINDOW_MS;
  const slackMs = input.slackMs ?? OWNER_DECISION_DIGEST_SLACK_MS;
  if (!Number.isFinite(input.oldestAnchorMs)) return true; // unreadable anchor → never hold it
  return input.nowMs >= input.oldestAnchorMs + windowMs - slackMs;
}

export interface DigestQuestionItem {
  id: string;
  question: string;
  options?: unknown;
  idleUsdPerDay?: number | null;
  defaultAfterDays?: number | null;
  defaultOption?: string | null;
  createdAt?: Date | string | null;
}

export interface DigestDefaultItem {
  id: string;
  question: string;
  defaultLabel: string;
  appliedAt?: Date | string | null;
}

const DIGEST_QUESTION_CLIP = 400;

/**
 * The per-owner digest DM. Leads with the "Digby needs your decision" marker
 * the Telegram bare-reply router keys on (a bare reply with several cards
 * open gets that router's "use answer <ref>" prompt). Cards carry their [ref]
 * and NO ordinal (review 2026-10-20: the router reads "answer <N> …" as the
 * N-th open card NEWEST first — a digest numbered oldest first would route
 * "answer 1 2" to a different card); option numbers stay, scoped to their own
 * card. `compactOptions` drops option consequences (the fit's last step
 * before a hard clip). Pure.
 */
export function renderOwnerDecisionDigest(input: {
  questions: DigestQuestionItem[];
  defaults: DigestDefaultItem[];
  more?: number;
  moreDefaults?: number;
  load?: { asked: number; answeredByOwner: number; defaulted: number } | null;
  compactOptions?: boolean;
}): string {
  const lines: string[] = [];
  const n = input.questions.length;
  const head = n
    ? `🗂 Digby needs your decision — ${n} card${n === 1 ? '' : 's'} in this 12-hour digest`
    : '🗂 Digby decision digest';
  lines.push(`${head} (owner-only and urgent cards still arrive at once).`);
  for (const q of input.questions) {
    const options = parseStoredOptions(q.options).map((o) => (input.compactOptions ? { id: o.id, label: o.label } : o));
    const optionsBlock = options.length ? `\n${renderOptionsNumbered(options).split('\n').map((l) => `   ${l}`).join('\n')}` : '';
    const delay = renderCostOfDelay(q).replace(/^\n\n/, '').split('\n').filter(Boolean).map((l) => `   ${l}`).join('\n');
    lines.push('');
    lines.push(`• [${shortQuestionRef(q.id)}] ${clipQuestionKeepingAnnotation(q.question, DIGEST_QUESTION_CLIP)}${optionsBlock}${delay ? `\n${delay}` : ''}`);
  }
  if (input.more && input.more > 0) {
    lines.push('', `…and ${input.more} more in Digby → Management → Inbox.`);
  }
  if (input.defaults.length) {
    lines.push('', 'Defaults applied (reversible — tell the chat to change course if wrong):');
    for (const d of input.defaults) {
      const q = stripPriorDecisionAnnotation(String(d.question ?? '')).replace(/\s+/g, ' ').slice(0, 160);
      lines.push(`• [${shortQuestionRef(d.id)}] ${q} → "${String(d.defaultLabel ?? '').slice(0, 120)}"`);
    }
    if (input.moreDefaults && input.moreDefaults > 0) lines.push(`…and ${input.moreDefaults} more default${input.moreDefaults === 1 ? '' : 's'} applied (see Digby → Management → Inbox).`);
  }
  if (input.load) {
    lines.push('', `Your last 7 days: ${input.load.asked} card${input.load.asked === 1 ? '' : 's'} filed · ${input.load.answeredByOwner} answered by you · ${input.load.defaulted} resolved by a default.`);
  }
  if (n) {
    const ref = shortQuestionRef(input.questions[0].id);
    lines.push('', `Answer in Digby → Management → Inbox, or reply here with the card's [ref]: "answer <ref> <your answer or that card's option number>" — e.g. "answer ${ref} <your answer>".`);
  }
  return lines.join('\n');
}

/**
 * Render the digest so it fits ONE Telegram message (DIGEST_TEXT_MAX):
 * defaults beyond DIGEST_MAX_DEFAULTS are counted, then cards are moved to
 * "…and N more" from the newest end (the oldest — longest-waiting — stay),
 * then option consequences are dropped, and only then is the text hard-clipped
 * (a single giant card). Returns the text and how many cards it shows. Pure.
 */
export function fitOwnerDecisionDigest(input: {
  questions: DigestQuestionItem[];
  defaults: DigestDefaultItem[];
  more?: number;
  load?: { asked: number; answeredByOwner: number; defaulted: number } | null;
  maxChars?: number;
}): { text: string; shown: number } {
  const max = input.maxChars ?? DIGEST_TEXT_MAX;
  const defaults = input.defaults.slice(0, DIGEST_MAX_DEFAULTS);
  const moreDefaults = input.defaults.length - defaults.length;
  let shown = input.questions.length;
  const render = (count: number, compactOptions: boolean) => renderOwnerDecisionDigest({
    questions: input.questions.slice(0, count), defaults, moreDefaults, load: input.load,
    more: (input.more ?? 0) + (input.questions.length - count), compactOptions,
  });
  let text = render(shown, false);
  while (text.length > max && shown > 1) {
    shown--;
    text = render(shown, false);
  }
  if (text.length > max) text = render(shown, true);
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return { text, shown };
}

// ── Metrics ──────────────────────────────────────────────────────────────────

/** Record one loop_metrics row (dynamic import; never throws). */
export async function recordOwnerInterruptMetric(kind: string, meta: Record<string, unknown>, sessionId?: string): Promise<void> {
  try {
    if (ownerInterruptMetricsDisabled()) return;
    const m: any = await import('./loop-metrics.service');
    if (typeof m?.recordLoopMetric !== 'function') return;
    m.recordLoopMetric({ kind, ...(sessionId ? { sessionId } : {}), meta });
  } catch { /* telemetry never blocks the inbox */ }
}

/** owner_question_resolved — one row per resolution (latency from filing). */
export async function recordOwnerQuestionResolved(
  row: { id: string; chatId: string; userId?: string; createdAt?: Date | string | null },
  input: { outcome: 'answered' | 'dismissed'; by: string; surface: string },
): Promise<void> {
  const created = toMs(row.createdAt ?? null);
  const latencyMin = Number.isFinite(created) ? Math.max(0, Math.round((Date.now() - created) / 60_000)) : null;
  await recordOwnerInterruptMetric('owner_question_resolved', {
    outcome: input.outcome, by: input.by, surface: input.surface, latencyMin,
    questionId: String(row.id ?? '').slice(0, 11), chatId: String(row.chatId ?? '').slice(0, 8),
    ...(row.userId ? { userId: String(row.userId).slice(0, 8) } : {}),
  }, row.chatId);
}

// ── Sweeps (attention-watchdog seam, ≤ 15 min cadence) ───────────────────────

async function loadDb(): Promise<any> {
  return (await import('../../../config/database')).default;
}

async function logEconomy(level: 'info' | 'warn', msg: string): Promise<void> {
  try {
    const logger = (await import('../../../utils/logger')).default;
    logger[level](msg);
  } catch { /* logging must never break a sweep */ }
}

/** Apply-time outcomes that will never change on a later pass: the card
 *  reads owner-only now (e.g. context appended after filing), or the default
 *  no longer fits its typed gate. The sweep RETIRES such a default. Pure. */
export function isPermanentReversibleRefusal(reason: string): boolean {
  return String(reason ?? '').startsWith('owner_only:') || reason === 'typed_gate';
}

/**
 * Apply due reversible recommended defaults (24 h, owner rule). The candidate
 * set is the ARMED INDEX (REVERSIBLE_ARMED_NS, written with the marker at flag
 * time) — never a scan of owner_questions, whose oldest open 1-day defaults
 * (legacy preset defaults, refused rows) used to fill the window forever
 * (review 2026-10-20). Per index row: a card no longer open (answered,
 * dismissed, the P7 seam applied it) leaves the index; a due card is applied
 * through applyDefaultAnswerWithReason (re-checks the owner-only class, typed
 * gates only on their own shape, queues the digest announcement); a PERMANENT
 * refusal (isPermanentReversibleRefusal) RETIRES the default — the row's
 * default pair is cleared, the lane is told, one owner_reversible_default
 * 'refused' row — so it can never pin the index or be applied by another
 * seam; a transient failure stays for the next pass and is counted 'overdue'
 * once it is REVERSIBLE_DEFAULT_OVERDUE_ALARM_MS past due. Bounded per pass;
 * never throws.
 */
export async function sweepReversibleDefaults(opts: { now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date(Date.now());
  if (ownerQuestionReversibleDefaultDisabled()) return 0;
  let applied = 0;
  try {
    const store = await import('../memory/context-store');
    const listed = await store.storeListNamespace<ReversibleArmedEntry>(REVERSIBLE_ARMED_NS, { limit: REVERSIBLE_ARMED_SCAN_LIMIT });
    if (!listed.length) return 0;
    const prisma = await loadDb();
    const rows: any[] = await prisma.ownerQuestion.findMany({ where: { id: { in: listed.map((e) => e.key) } } });
    const byId = new Map((Array.isArray(rows) ? rows : []).map((r) => [String(r.id), r]));
    const { applyDefaultAnswerWithReason, retireReversibleDefault } = await import('./owner-questions');
    const dueAfterMs = REVERSIBLE_DEFAULT_AFTER_DAYS * 86_400_000;
    const unindex = (key: string) => store.storeDelete(REVERSIBLE_ARMED_NS, key).catch(() => {});
    let attempts = 0;
    let overdue = 0;
    for (const { key, value } of listed) {
      const row = byId.get(key);
      if (!row || row.status !== 'open') { await unindex(key); continue; }
      const created = toMs(row.createdAt ?? null);
      if (!Number.isFinite(created) || now.getTime() - created < dueAfterMs) continue;
      if (attempts >= REVERSIBLE_DEFAULTS_PER_PASS) break;
      attempts++;
      const outcome = await applyDefaultAnswerWithReason(row as OwnerQuestionView, now, {
        economyMarker: { reversible: true, ...(value?.recommendedDefault ? { recommendedDefault: value.recommendedDefault } : {}) },
      });
      if (outcome.applied) {
        applied++;
        await unindex(key);
        await recordOwnerInterruptMetric('owner_reversible_default', { phase: 'applied', questionId: key.slice(0, 11), waitMin: Math.round((now.getTime() - created) / 60_000) }, row.chatId);
        continue;
      }
      if (isPermanentReversibleRefusal(outcome.reason)) {
        const retired = await retireReversibleDefault(row as OwnerQuestionView, outcome.reason);
        await unindex(key);
        await recordOwnerInterruptMetric('owner_reversible_default', { phase: 'refused', reason: outcome.reason, retired, questionId: key.slice(0, 11) }, row.chatId);
        continue;
      }
      if (outcome.reason === 'not_open' || outcome.reason === 'lost_race' || outcome.reason === 'no_default') { await unindex(key); continue; }
      if (now.getTime() - (created + dueAfterMs) > REVERSIBLE_DEFAULT_OVERDUE_ALARM_MS) overdue++;
    }
    if (overdue > 0) {
      await recordOwnerInterruptMetric('owner_reversible_default', { phase: 'overdue', count: overdue });
      await logEconomy('warn', `owner-interrupt-economy: ${overdue} armed reversible default(s) still unapplied more than ${Math.round(REVERSIBLE_DEFAULT_OVERDUE_ALARM_MS / 3_600_000)} h past due (kept for the next pass)`);
    }
  } catch (err: any) {
    await logEconomy('warn', `owner-interrupt-economy: reversible-default sweep failed (non-fatal): ${err?.message ?? err}`);
  }
  return applied;
}

async function ownerLoadLastWeek(prisma: any, userId: string, now: Date): Promise<{ asked: number; answeredByOwner: number; defaulted: number } | null> {
  try {
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const [asked, answeredByOwner, defaulted] = await Promise.all([
      prisma.ownerQuestion.count({ where: { userId, createdAt: { gte: since } } }),
      prisma.ownerQuestion.count({ where: { userId, status: 'answered', resolvedAt: { gte: since }, OR: [{ answeredBy: 'owner' }, { answeredBy: null }] } }),
      prisma.ownerQuestion.count({ where: { userId, status: 'answered', resolvedAt: { gte: since }, answeredBy: 'default' } }),
    ]);
    if (![asked, answeredByOwner, defaulted].every((n) => typeof n === 'number')) return null;
    return { asked, answeredByOwner, defaulted };
  } catch {
    return null;
  }
}

/**
 * Send every owner's due digest. An owner's digest is due when the OLDEST
 * pending entry has waited the window (minus one sweep of slack) — so no
 * batched card waits past 12 h from reaching the owner's queue (filing; a
 * triage-held card from the moment it surfaced), and two digests are never
 * closer than the window less the slack (see digestDue). With the kill
 * switch ON the sweep FLUSHES whatever is still queued at once (nothing is
 * stranded by a revert). Per owner: claim (peer-sweeper safe), re-read the
 * rows (a card answered meanwhile is dropped — no interrupt needed), DM, then
 * clear the entries. A failed DM keeps the entries for the next pass (dropped
 * after 72 h: the card stays in the Inbox). Bounded per pass; never throws.
 */
export async function sweepOwnerDecisionDigest(opts: { now?: Date } = {}): Promise<{ owners: number; sent: number; dropped: number }> {
  const now = opts.now ?? new Date(Date.now());
  const out = { owners: 0, sent: 0, dropped: 0 };
  try {
    const store = await import('../memory/context-store');
    const flush = ownerDecisionDigestDisabled();
    // Stale claims (a crash between DM and clear) are released after an hour:
    // a duplicate digest beats a stranded one.
    await store.storePruneNamespace(DIGEST_CLAIM_NS, new Date(now.getTime() - 60 * 60 * 1000)).catch(() => 0);
    const listed = await store.storeListNamespace<DigestEntry>(DIGEST_QUEUE_NS, { limit: DIGEST_QUEUE_SCAN_LIMIT });
    if (!listed.length) return out;
    const byOwner = new Map<string, Array<{ key: string; entry: DigestEntry }>>();
    for (const { key, value } of listed) {
      const e = value as DigestEntry;
      if (!e || typeof e.userId !== 'string' || typeof e.questionId !== 'string') {
        await store.storeDelete(DIGEST_QUEUE_NS, key).catch(() => {});
        continue;
      }
      const list = byOwner.get(e.userId) ?? [];
      list.push({ key, entry: e });
      byOwner.set(e.userId, list);
    }
    const prisma = await loadDb();
    let ownersSeen = 0;
    for (const [userId, items] of byOwner) {
      if (ownersSeen >= DIGEST_OWNERS_PER_PASS) break;
      ownersSeen++;
      const anchors = items.map((i) => new Date(i.entry.anchorAt).getTime()).filter(Number.isFinite);
      const oldest = anchors.length ? Math.min(...anchors) : NaN;
      if (!flush && !digestDue({ oldestAnchorMs: oldest, nowMs: now.getTime() })) continue;
      out.owners++;
      const claimKey = `${userId}:${Number.isFinite(oldest) ? oldest : 'x'}`;
      const claimed = await store.storeCreate(DIGEST_CLAIM_NS, claimKey, { at: now.toISOString() }).catch(() => false);
      if (!claimed) continue; // a peer sweeper owns this digest
      const clear = async () => { for (const i of items) await store.storeDelete(DIGEST_QUEUE_NS, i.key).catch(() => {}); };
      try {
        const ids = [...new Set(items.map((i) => i.entry.questionId))];
        const rows: any[] = await prisma.ownerQuestion.findMany({ where: { id: { in: ids }, userId } });
        const byId = new Map(rows.map((r) => [String(r.id), r]));
        const questions: DigestQuestionItem[] = [];
        const defaults: DigestDefaultItem[] = [];
        for (const i of items) {
          const row = byId.get(i.entry.questionId);
          if (!row) continue;
          if (i.entry.kind === 'question') {
            if (row.status !== 'open') continue; // answered / dismissed meanwhile — nothing to interrupt for
            if (questions.some((q) => q.id === row.id)) continue;
            questions.push(row);
          } else if (row.status === 'answered' && row.answeredBy === 'default') {
            const options = parseStoredOptions(row.options);
            const matched = row.chosenOption ? options.find((o) => o.id === row.chosenOption) : null;
            defaults.push({ id: row.id, question: row.question, defaultLabel: matched?.label ?? String(row.defaultOption ?? priorDecisionAnswerCore(row.answer)), appliedAt: row.resolvedAt ?? null });
          }
        }
        if (!questions.length && !defaults.length) {
          await clear();
          out.dropped += items.length;
          continue;
        }
        const tg = await import('../telegram/telegram.service');
        const link = tg.isConfigured() ? await prisma.telegramLink.findUnique({ where: { userId } }) : null;
        if (!link) {
          // No push channel: the Inbox is the only surface (today's behaviour
          // for an unlinked owner) — nothing to hold.
          await clear();
          out.dropped += items.length;
          continue;
        }
        questions.sort((a, b) => toMs(a.createdAt ?? null) - toMs(b.createdAt ?? null));
        const capped = questions.slice(0, DIGEST_MAX_ITEMS);
        const load = await ownerLoadLastWeek(prisma, userId, now);
        // ONE Telegram message (review 2026-10-20): a multi-chunk digest whose
        // later chunk failed reported "not sent" and was re-sent WHOLE every
        // pass — the fit keeps it under DIGEST_TEXT_MAX.
        const { text } = fitOwnerDecisionDigest({ questions: capped, defaults, more: questions.length - capped.length, load });
        const ok = await tg.sendMessage(link.chatId, text);
        if (ok === false) {
          await store.storeDelete(DIGEST_CLAIM_NS, claimKey).catch(() => {});
          const stale = items.filter((i) => now.getTime() - new Date(i.entry.queuedAt).getTime() > DIGEST_ENTRY_MAX_AGE_MS);
          for (const i of stale) await store.storeDelete(DIGEST_QUEUE_NS, i.key).catch(() => {});
          await recordOwnerInterruptMetric('owner_decision_digest', { phase: 'send_failed', userId: userId.slice(0, 8), questions: questions.length, defaults: defaults.length, droppedStale: stale.length });
          continue;
        }
        await clear();
        out.sent++;
        // The spacing half of the owner's rule ("at most every 12 h"): read
        // the previous digest's time so the metric shows the gap and whether
        // the wait bound overrode it (digestDue — the wait bound wins).
        let sinceLastDigestMin: number | null = null;
        try {
          const prev = await store.storeGet<{ lastDigestAt?: string }>(DIGEST_OWNER_NS, userId);
          const prevMs = toMs(prev?.lastDigestAt ?? null);
          if (Number.isFinite(prevMs)) sinceLastDigestMin = Math.round((now.getTime() - prevMs) / 60_000);
        } catch { /* the spacing is telemetry only */ }
        await store.storePut(DIGEST_OWNER_NS, userId, { lastDigestAt: now.toISOString(), questions: questions.length, defaults: defaults.length } as any).catch(() => {});
        const oldestWaitMin = Number.isFinite(oldest) ? Math.round((now.getTime() - oldest) / 60_000) : null;
        const spacingFloorMin = Math.round((OWNER_DECISION_DIGEST_WINDOW_MS - OWNER_DECISION_DIGEST_SLACK_MS) / 60_000);
        await recordOwnerInterruptMetric('owner_decision_digest', {
          phase: flush ? 'flushed' : 'sent', userId: userId.slice(0, 8), questions: questions.length, defaults: defaults.length,
          entries: items.length, oldestWaitMin, sinceLastDigestMin,
          spacingOverridden: !flush && sinceLastDigestMin !== null && sinceLastDigestMin < spacingFloorMin,
        });
      } catch (err: any) {
        await store.storeDelete(DIGEST_CLAIM_NS, claimKey).catch(() => {});
        await logEconomy('warn', `owner-interrupt-economy: digest for user ${userId.slice(0, 8)} failed (kept for the next pass): ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    await logEconomy('warn', `owner-interrupt-economy: digest sweep failed (non-fatal): ${err?.message ?? err}`);
  }
  return out;
}

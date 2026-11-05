/**
 * "Needs owner" persistent inbox (ticket 7705fec2) — the owner_questions store.
 *
 * An agent run (chat pipeline OR coding session) flags a question/decision for
 * the owner with the flag_owner_question platform tool; the row persists in the
 * Management → Inbox surface (merged into GET /confirmations/pending as
 * kind:'owner_question' entries) until the owner answers or dismisses it via
 * the REST endpoints. Unlike staged confirmations these NEVER expire — the
 * whole point is that a "needs owner" item cannot silently vanish.
 *
 * Resolution feeds back to the agent: answerOwnerQuestion/dismissOwnerQuestion
 * append a transcript note to the ORIGINATING chat (the same CrossModelMessage
 * role:'assistant' + metadata.origin convention the orphan-recovery and
 * attention-watchdog notices use) AND WAKE the chat immediately (2026-08-30
 * live audit: the note alone waited for the chat's next scheduled wake — up to
 * a 2h sweep cadence — with the owner's answer sitting unread; the supervisor
 * never reacted to a reconciliation answer until its next wake). The wake runs
 * through the shared fireScheduleTarget machine-run path (coding chat → queued
 * run, plain chat → detached turn), budgeted against the chat's daily
 * machine-run cap and refunded when no run starts. Both the note post and the
 * wake are best-effort — a failure never fails the answer.
 *
 * Abuse discipline mirrors file_feedback (feedback.service): input length caps,
 * an exact-question dedup (a repeat sighting returns the EXISTING open row
 * instead of a duplicate), a dismissed-recently cooldown (the owner said stop),
 * a per-chat open cap, and a per-session hourly rate cap (the same DB-count
 * mechanism as file_feedback's session cap).
 *
 * Lazy prisma + lazy logger: a static import would pull config/database →
 * config/env (process.exit at import when env vars are missing) into EVERY jest
 * graph that reaches platform-tools.ts — the same discipline as
 * pending-confirmations.ts and platform-tools.ts's logPlatformTools.
 */

import { randomUUID } from 'crypto';
import { redactInboundSecrets, redactInboundSecretsWithNotes } from './secret-scan';
import type { SecretSpan } from './secret-scan';
import type { SpanRescueCounter, DeliverableSecret } from './owner-question-secrets';
import { OQ_SECRET_TOTAL_CAP } from './owner-question-secrets';
import { parseExpectedAnswerType, credentialLifted, answerLooksLikeCredential, rawEnvKeyHalf } from './credential-gate';
import { detectOwnerCardPayloadGaps } from './owner-card-gaps';
import { detectSpeclessConsoleAsk, OWNER_CONSOLE_ASK_DETECT_DISABLED_ENV } from './console-ask';
import { ownerDirectiveFanoutDisabled, ownerProvenanceStrictDisabled, ownerDismissRailsDisabled, ownerQuestionPayloadClassDisabled, ownerQuestionTriageEarlyReleaseDisabled } from './owner-authority-switches';
export { detectOwnerCardPayloadGaps };

type Prisma = typeof import('../../../config/database').default;
let _db: Prisma | null = null;
async function db(): Promise<Prisma> {
  if (!_db) _db = (await import('../../../config/database')).default;
  return _db;
}

async function logOwnerQuestions(level: 'info' | 'warn', msg: string): Promise<void> {
  try {
    const logger = (await import('../../../utils/logger')).default;
    logger[level](msg);
  } catch { /* logging must never break the inbox */ }
}

/** A typed decision option (remediation P2 N3): rendered numbered on the Inbox
 *  card + Telegram DM; the answer path matches id / label / 1-based number. */
export interface OwnerQuestionOption {
  id: string;
  label: string;
  consequence?: string;
}

/** Row shape returned by the reads (mirrors the Prisma model). */
export interface OwnerQuestionView {
  id: string;
  chatId: string;
  userId: string;
  question: string;
  context: string | null;
  status: string; // open | answered | dismissed
  answer: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  /** Typed options (N3) — null/undefined for free-text questions (most). */
  options?: unknown;
  chosenOption?: string | null;
  /** Lane linkage (v1#5) — a second chat the answer wakes + the gated goal/todo. */
  forChatId?: string | null;
  goalId?: string | null;
  todoId?: string | null;
  /** Cost-of-delay + default answer (P7 S2b) — all optional, flagger-supplied. */
  idleUsdPerDay?: number | null;
  defaultAfterDays?: number | null;
  defaultOption?: string | null;
  /** Todo 77c88942 item 2 (2026-10-16): the declared answer type — 'free'
   *  (null/legacy default: any non-empty text resolves), 'choice', 'yes_no',
   *  or 'credential:<ENVKEY>'. A credential gate resolves ONLY on stored
   *  state for that envKey (credential-gate.ts — a store_secret receipt OR
   *  the CodingCredential row, i.e. the card's key field / the Account UI;
   *  NEVER on answer text) — specimen oq_211513ed/oq_483730f8 both answered
   *  "yes public" 3 s apart and opened the credential-gated Schooltime todo. */
  expectedAnswerType?: string | null;
  /** Ticket 90a5b127: the flagger's typed declaration that the ask is
   *  optional (true/false/null = not declared) — completes the options axis
   *  of the payload-gap admission when true. */
  optionalAsk?: boolean | null;
  /** Who answered: 'owner' | 'default' (auto-answered) | 'supervisor'
   *  (answer_owner_question under standing directives — Review 2026-09-13
   *  issue 11). Null = pre-P7 rows / dismissed. */
  answeredBy?: string | null;
  /** Ticket abca56ce: who dismissed a dismissed row — 'owner' | 'supervisor'
   *  | 'agent' | 'system' (superseded). Null = pre-column rows (rendered as
   *  the owner — legacy) or the row is not dismissed. */
  dismissedBy?: string | null;
  /** Review 2026-09-13 issue 11: supervisor-first triage state — 'supervisor'
   *  while the Fleet Supervisor is first responder, 'surfaced' once the SLA
   *  elapsed and the owner was notified, null = never triaged. */
  triage?: string | null;
  /** The triage SLA deadline (null when never triaged). */
  triageUntil?: Date | null;
  /** View-only marker (set ONLY by the includeTriaged listings): the row is
   *  open, in supervisor triage, and its SLA has not elapsed — i.e. hidden
   *  from the owner's rail right now. */
  triaged?: boolean;
}

const QUESTION_MAX = 2000;
const CONTEXT_MAX = 4000;
const ANSWER_MAX = 8000;
/** Per-chat open cap: one chat may hold at most this many UNRESOLVED rows. */
export const OWNER_QUESTION_OPEN_CAP = 10;
/** Per-session hourly rate cap — mirrors file_feedback's SESSION_CAP_PER_HOUR
 *  mechanism (DB count over the last hour keyed on the session/chat id): a
 *  run's sessionId IS the chat id on both surfaces, so this IS the per-run
 *  cap. Refuse when REACHED (>= 3) so a run can flag at most 3 fresh
 *  questions per hour. */
export const OWNER_QUESTION_RATE_CAP_PER_HOUR = 3;
/** A dismissed question may not be re-flagged within this cooldown. */
export const DISMISSED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type FlagOwnerQuestionResult =
  | {
      kind: 'created'; question: OwnerQuestionView; supersededQuestionId?: string; secrets?: Array<{ ordinal: number; label: string }>;
      /** OWNER-INTERRUPT-ECONOMY (2026-10-20): how the owner hears of it —
       *  'immediate' DM, the 12 h 'digest', or supervisor 'triage' first. */
      delivery?: 'immediate' | 'digest' | 'triage';
      /** The prior owner decision this card was annotated with (recall). */
      priorDecision?: { questionId: string; decidedOn: string; strict: boolean };
      /** The reversible 24 h recommended default: armed, or why not. */
      reversibleDefault?: { armed: boolean; reason: string };
      /** Observe-only ask-vs-decide advisory for a supervisor filer. */
      advisory?: string;
    }
  | { kind: 'deduped'; question: OwnerQuestionView; appended?: boolean }
  | { kind: 'refused'; refused: 'invalid' | 'dismissed_recently' | 'cap' | 'multi_decision'; message?: string }
  /** N8 machine-preflight: a recently ANSWERED question already covers this
   *  topic and the owner said proceed / stop asking. */
  | { kind: 'refused'; refused: 'previously_answered'; prior: OwnerQuestionView }
  /** OWNER-INTERRUPT-ECONOMY prior-decision recall: a MACHINE re-ask that is a
   *  STRICT same-decision match of an answer the OWNER gave within 90 d. */
  | { kind: 'refused'; refused: 'previously_decided'; prior: OwnerQuestionView; decidedOn: string; message: string };

// ── Typed options + multi-decision heuristic (remediation P2 N3) ─────────────

const OPTION_LABEL_MAX = 200;
const OPTION_CONSEQUENCE_MAX = 300;
const OPTIONS_MAX = 6;

/**
 * Validate/normalize the tool-supplied options array. Returns null when no
 * usable options were supplied (free-text question — the common case);
 * malformed entries are dropped rather than failing the flag.
 */
export function normalizeOwnerQuestionOptions(raw: unknown): OwnerQuestionOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: OwnerQuestionOption[] = [];
  const seen = new Set<string>();
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const label = String((o as any).label ?? '').trim().slice(0, OPTION_LABEL_MAX);
    if (!label) continue;
    let id = String((o as any).id ?? '').trim().slice(0, 40);
    if (!id) id = `opt_${out.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const consequence = String((o as any).consequence ?? '').trim().slice(0, OPTION_CONSEQUENCE_MAX);
    out.push({ id, label, ...(consequence ? { consequence } : {}) });
    if (out.length >= OPTIONS_MAX) break;
  }
  return out.length ? out : null;
}

/** Tolerant read of a stored options Json back into typed options. */
export function parseStoredOptions(raw: unknown): OwnerQuestionOption[] {
  return normalizeOwnerQuestionOptions(raw) ?? [];
}

// ── Console-action ask (ticket 1b1c41bc) ────────────────────────────────────

/**
 * A card that asks the owner to perform an action in an EXTERNAL console
 * (Tailscale ACL, GCP service-account key, Gmail app password…). The owner
 * asked three times in one day for exactly this shape (2026-10-16: "You need
 * to send me what to put with more instructinos and better instructions
 * always…make sure to add this to frameowrk"): the card must carry the
 * EXACT paste-ready payload plus click-by-click steps, in the card body
 * itself — never a summary or a link. The flagger supplies these STRUCTURED
 * fields and the service composes the card body (composeConsoleActionBody)
 * so the four elements are harness-enforced on every surface, not
 * hand-formatted by the filing agent.
 */
export interface ConsoleActionSpec {
  /** Human name of the console ("Tailscale admin console"). */
  consoleName: string;
  /** The console URL the owner opens (https). */
  consoleUrl: string;
  /** ONE line: what this does + why it's safe. */
  whatAndWhySafe: string;
  /** The exact paste-ready payload (may be omitted for a pure click-path ask). */
  payload?: string;
  /** Language tag for the fenced code block (default "text"). */
  payloadLanguage?: string;
  /** Numbered click-by-click steps, each naming a UI element. */
  steps: string[];
}

export type ConsoleActionNormalized = ConsoleActionSpec;

/** Field caps — fail-CLOSED: an unusable consoleAction is refused, never
 *  silently degraded to a summary-shaped card (the exact failure this
 *  ticket exists to end). */
const CONSOLE_NAME_MAX = 120;
const CONSOLE_URL_MAX = 300;
const WHAT_WHY_MAX = 300;
const PAYLOAD_MAX = 6000;
const PAYLOAD_LANGUAGE_MAX = 24;
const CONSOLE_STEPS_MAX = 10;
const CONSOLE_STEP_MAX = 280;
/** Raised question budget for a composed console-action body (the payload
 *  alone can dwarf QUESTION_MAX — the 2000-char cap is what forced agents to
 *  summarize the payload instead of pasting it). Legacy QUESTION_MAX keeps
 *  governing every other question. */
export const CONSOLE_ACTION_QUESTION_MAX = 9000;

/** Typed options the harness injects when the flagger supplied none — the
 *  owner answers "saved / error / defer" in one tap, and the multi-decision
 *  heuristic (which would otherwise refuse the numbered steps text) sees
 *  typed options. Labels are also the answer text, so keep them
 *  self-contained. */
const CONSOLE_ACTION_DEFAULT_OPTIONS: ReadonlyArray<{ id: string; label: string; consequence: string }> = [
  { id: 'saved', label: 'Saved', consequence: 'the change is applied — proceed with the waiting work' },
  { id: 'error', label: 'Error', consequence: 'the console showed an error — paste it in a reply' },
  { id: 'defer', label: 'Defer', consequence: 'not now — the waiting work stays on hold' },
];

export type ConsoleActionValidation = { ok: true; value: ConsoleActionNormalized } | { ok: false; error: string };

/**
 * Validate/normalize the tool-supplied consoleAction object. Returns a
 * refusal reason on any unusable shape (missing console/steps, non-https
 * URL, payload over cap) — the caller refuses the flag so the agent retries
 * with the real content instead of filing a summary-shaped card. Pure;
 * exported for tests.
 *
 * SECURITY (ticket 1b1c41bc, review finding H): every agent-authored spec
 * field runs through redactInboundSecrets HERE — the composed body and the
 * stored spec would otherwise be the ONE lane-authored path into the owner's
 * inbox that bypasses the inbound secret scan (only question/context are
 * redacted at the create-path entry). A legitimate console payload (an ACL
 * JSON, an app-password setup link) contains no secrets and passes through
 * unchanged; a credential embedded in a payload is REFUSED (fail-closed,
 * ticket 26786762): the agent delivers the key via deliverSecrets and
 * references the reveal handle in the payload text. A payload that instead
 * ECHOES an explicitly delivered value is scrubbed to that handle at the
 * flag path (review H5, round 7).
 */
export function normalizeConsoleAction(raw: unknown): ConsoleActionValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'consoleAction must be an object' };
  const o = raw as Record<string, unknown>;
  const consoleName = redactInboundSecrets(String(o.consoleName ?? '').trim().slice(0, CONSOLE_NAME_MAX));
  if (!consoleName) return { ok: false, error: 'consoleAction.consoleName is required' };
  // Review finding B-2 (ticket 1b1c41bc): consoleUrl is agent-authored too —
  // a query-string token (…/setup?token=<key>) must not ride the card, the
  // DM or the stored spec unscanned. Redact AFTER the shape check, then
  // re-verify https (a redaction marker inside the URL mangles it — refuse
  // rather than store a broken link).
  const consoleUrlRaw = String(o.consoleUrl ?? '').trim();
  if (!consoleUrlRaw) return { ok: false, error: 'consoleAction.consoleUrl is required' };
  try { new URL(consoleUrlRaw); } catch { return { ok: false, error: 'consoleAction.consoleUrl is not a valid URL' }; }
  if (!/^https:/i.test(consoleUrlRaw)) return { ok: false, error: 'consoleAction.consoleUrl must be an https URL' };
  if (consoleUrlRaw.length > CONSOLE_URL_MAX) return { ok: false, error: `consoleAction.consoleUrl over ${CONSOLE_URL_MAX} chars` };
  const consoleUrl = redactInboundSecrets(consoleUrlRaw);
  if (consoleUrl !== consoleUrlRaw) {
    return { ok: false, error: 'consoleAction.consoleUrl carries credential material (redacted) — provide the bare console URL, never a link with a token' };
  }
  const whatAndWhySafe = redactInboundSecrets(String(o.whatAndWhySafe ?? '').trim().slice(0, WHAT_WHY_MAX));
  if (!whatAndWhySafe) return { ok: false, error: 'consoleAction.whatAndWhySafe is required' };
  let payload: string | undefined;
  if (o.payload !== undefined && o.payload !== null && String(o.payload).trim() !== '') {
    const raw = String(o.payload).replace(/\r\n/g, '\n');
    const p = redactInboundSecrets(raw);
    // Ticket 26786762: a payload carrying credential material was silently
    // redacted — the owner pasted a fenced block with "[REDACTED: looked
    // like a credential]" where the key was, the exact destruction class
    // this ticket exists to end. REFUSE instead (fail-closed): the agent
    // delivers the key via deliverSecrets and references the reveal handle
    // ("[SECRET 1]") in the payload text.
    if (p !== raw) {
      return { ok: false, error: 'consoleAction.payload carries credential material (it would be redacted at write time) — deliver the key via deliverSecrets and reference the reveal handle (e.g. "[SECRET 1]") in the payload, never embed the raw value' };
    }
    if (p.length > PAYLOAD_MAX) return { ok: false, error: `consoleAction.payload over ${PAYLOAD_MAX} chars` };
    payload = p;
  }
  const payloadLanguage = redactInboundSecrets(String(o.payloadLanguage ?? 'text').trim().slice(0, PAYLOAD_LANGUAGE_MAX)) || 'text';
  const rawSteps = Array.isArray(o.steps) ? o.steps : [];
  const steps: string[] = [];
  for (const s of rawSteps) {
    const t = redactInboundSecrets(String(s ?? '').trim().replace(/\s+/g, ' '));
    if (!t) continue;
    if (steps.length >= CONSOLE_STEPS_MAX) break;
    steps.push(t.slice(0, CONSOLE_STEP_MAX));
  }
  if (!steps.length) return { ok: false, error: 'consoleAction.steps is required (at least one click-by-click step)' };
  return { ok: true, value: { consoleName, consoleUrl, whatAndWhySafe, ...(payload !== undefined ? { payload } : {}), payloadLanguage, steps } };
}

/**
 * Compose the four-element card body (ticket 1b1c41bc) from a validated
 * spec: the paste-ready payload in a fenced code block (the card's markdown
 * renderer gives every fenced block a Copy button), numbered click-by-click
 * steps naming the console URL and each UI element, and the one-line
 * what/why-safe. Pure; exported for tests.
 */
export function composeConsoleActionBody(spec: ConsoleActionNormalized, originalQuestion: string): string {
  const ask = String(originalQuestion ?? '').trim();
  const lines: string[] = [];
  if (ask) lines.push(ask, '');
  lines.push(`**What this does + why it's safe:** ${spec.whatAndWhySafe}`, '');
  lines.push(`**Do this in ${spec.consoleName} — ${spec.consoleUrl}**`, '');
  if (spec.payload !== undefined) {
    lines.push(`**Paste exactly this (${spec.consoleName}):**`, '', '```' + spec.payloadLanguage, spec.payload, '```', '');
  }
  lines.push('**Click by click:**');
  spec.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  return lines.join('\n');
}

/** Parse a stored consoleAction Json back into a spec (null on any unusable
 *  shape — old rows / junk). Pure; exported for tests. */
export function parseStoredConsoleAction(raw: unknown): ConsoleActionNormalized | null {
  const v = normalizeConsoleAction(raw);
  return v.ok ? v.value : null;
}

/**
 * Cheap two-decision heuristic (N3): a question text carrying MORE than one
 * interrogative decision — '(1) … (2) …' enumerations, 'also decide', or two+
 * '?'-terminated sentences — is refused when no options were supplied, with a
 * nudge to split. Pure; exported for tests.
 */
export function looksLikeMultiDecisionQuestion(question: string): boolean {
  const q = String(question ?? '');
  if (/\(1\)[\s\S]*\(2\)/.test(q) || /(^|\s)1[.)]\s+[\s\S]*(\s)2[.)]\s+/.test(q)) return true;
  if (/\balso decide\b/i.test(q)) return true;
  const questionSentences = q.split(/\?+/).slice(0, -1).filter((s) => s.trim().length > 0);
  return questionSentences.length >= 2;
}

/** Numbered rendering shared by the Telegram DM + wake prompts. */
export function renderOptionsNumbered(options: OwnerQuestionOption[]): string {
  return options
    .map((o, i) => `${i + 1}. ${o.label}${o.consequence ? ` — ${o.consequence}` : ''}`)
    .join('\n');
}

/**
 * Match an owner's answer against a question's options: exact option id,
 * case-insensitive label, or a bare 1-based number. Returns the matched
 * option or null (free text). Pure; exported for tests.
 */
export function matchAnswerToOption(options: OwnerQuestionOption[], answer: string): OwnerQuestionOption | null {
  const a = String(answer ?? '').trim();
  if (!a || !options.length) return null;
  const byId = options.find((o) => o.id === a);
  if (byId) return byId;
  const lower = a.toLowerCase();
  const byLabel = options.find((o) => o.label.toLowerCase() === lower);
  if (byLabel) return byLabel;
  if (/^\d{1,2}$/.test(a)) {
    const n = parseInt(a, 10);
    if (n >= 1 && n <= options.length) return options[n - 1];
  }
  return null;
}

/**
 * CanLaw stall 2026-09-15: an owner reply that is ITSELF A QUESTION is not a
 * decision. Four owner replies on the CanLaw HALT cards ("would #2 be the
 * best…?", "well didn't we change the benchmark a ton?", "don't you have to
 * rebuild the SFT dataset now…? shouldn't you start that now…?") were stored
 * as `answered`, relayed to the lanes as "the OWNER just answered… act on this
 * answer now", and the lanes wrote "owner's HALT-band decision MADE" into the
 * ledger — a lane-authored halt laundered into an owner ruling that the
 * project supervisor then enforced for a day while the owner asked why nothing
 * was training.
 *
 * Interrogative = the reply ENDS with a question mark (trailing ellipsis /
 * punctuation / whitespace allowed) AND does not OPEN with a decisive token
 * ("yes", "no", "go", "approve", "halt", "stop", "option 2", "#2", a bare
 * number) — "yes go, but is the pack ready?" is still a decision. A reply that
 * matched a typed option is never a counter-question. Pure; exported for tests.
 */
// A sentence is interrogative when it ends in a question mark (ASCII or
// fullwidth), allowing closing quotes/brackets/ellipsis after it.
const INTERROGATIVE_TAIL_RE = /[?？]\s*[.…!)\]"'”’\s]*$/;
// Sentence boundary: whitespace after terminal punctuation.
const SENTENCE_SPLIT_RE = /(?<=[.!?？])\s+/;
// A decisive OPENING token — the reply states a choice before (or instead of)
// asking. Hedged leads stay non-decisive: "no idea, what's the cost?",
// "okay so what changed?", "ok but why?", "Go where?", "Stop what?", "yes?".
const DECISIVE_LEAD_RE =
  /^\s*(?:(?:yes|yeah|yep|yup|ok(?:ay)?|sure|absolutely|approved?|go(?:\s+ahead)?|proceed|ship(?:\s+it)?|launch|kill\s+it|drop\s+it|do\s+it|halt|stop|hold|pause|no|nope|neither|both|take\s+both)(?![\s,—-]*[?？])(?!\s+(?:idea|clue|so|but|and|where|what|when|which|why|how)\b)|option\s*[a-z0-9]+|(?:path|plan|choice|variant)\s+[a-z0-9]+|#\d+|\d+)\b/i;
// A bare option-shaped token with a question mark — "Option B?", "A?", "2?",
// "#2?" — is the owner picking, not asking.
const BARE_OPTION_RE = /^\s*(?:(?:option|path|plan|choice)\s*)?[a-z0-9]{1,2}\s*[?？]\s*$/i;
export function isCounterQuestionAnswer(answer: string, matchedOption: OwnerQuestionOption | null): boolean {
  if (matchedOption) return false;
  let raw = String(answer ?? '').trim();
  if (!raw) return false;
  // Ticket 50bcd1e7: a trailing credential-vault notice (appended to stored
  // owner answers that carried credential spans) is BOOKKEEPING, not the
  // owner's words — strip it before classification or a credential-carrying
  // counter-question ("here is the key [REDACTED…] — which one do you want?
  // [CREDENTIAL VAULTED — …]") stops reading as a question and gets treated
  // as a decision by every row-reader (gate sweeper, watchdog, digest,
  // status card). The notice always ends the stored text. Delta-review #2
  // (of 722064990): the capture-count notice plus the A7 unstored-value
  // WARNING is TWO trailing brackets — the strip now peels one or more.
  raw = raw.replace(/\s*(?:\[CREDENTIAL VAULTED — [^\]]*\]\s*)+$/, '').trim();
  // A trailing parenthetical aside ("…cost? (rough number is fine)") does not
  // turn the question into a statement — drop it before reading the tail; a
  // reply that is ENTIRELY parenthetical ("(why?)") keeps its text.
  const stripped = raw.replace(/\s*\([^()]{0,160}\)\s*$/, '').trim();
  const text = stripped || raw;
  if (BARE_OPTION_RE.test(text)) return false;
  // EVERY sentence must be a question: "Path C. But is the dataset ready?" and
  // "Take both. ETA?" state a decision first — decisions.
  const sentences = text.split(SENTENCE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length || !sentences.every((s) => INTERROGATIVE_TAIL_RE.test(s))) return false;
  return !DECISIVE_LEAD_RE.test(text);
}

/**
 * Row-level form for the surfaces that read owner_questions rows back (gate
 * sweeper, digest, watchdog, status card): an ANSWERED row counts as a
 * counter-question only when the owner answered it free-text (no typed option
 * chosen, not a supervisor or default answer) with a question. Pure.
 */
export function isCounterQuestionRow(row: {
  status?: string | null; answer?: string | null; chosenOption?: string | null; answeredBy?: string | null;
} | null | undefined): boolean {
  if (!row) return false;
  if (row.status && row.status !== 'answered') return false;
  if (row.chosenOption) return false;
  if (row.answeredBy === 'supervisor' || row.answeredBy === 'default') return false;
  return isCounterQuestionAnswer(String(row.answer ?? ''), null);
}

/**
 * The wake/note copy every counter-question relay carries — ONE place so the
 * inbox answer path, the transcript note and the ledger say the same thing.
 * Observe/route only: it stages no gate and records no ruling either way.
 */
export const COUNTER_QUESTION_WAKE_HEADER =
  '[Owner inbox — the OWNER replied to your flagged question WITH A QUESTION, not a decision]';
export const COUNTER_QUESTION_INSTRUCTION =
  'The owner\'s reply reads as a question back with no decision stated. If it ALSO states a decision in the owner\'s own words, act on that decision and answer the question; ' +
  'otherwise NO decision was made and none may be recorded as the owner\'s (not a GO, not a HALT). ' +
  'Answer the owner\'s question in your next note, plainly and with evidence. Until the owner states a decision in their own words, ' +
  'the standing directives apply: work that never needed the owner (anything under full autonomy and the pre-approved budgets) keeps moving; ' +
  'only a genuinely human-worthy action (irreversible/destructive, credentials, external sends, a real strategy fork) waits — and it waits ' +
  'on a RE-FILED question that carries your answer, never on this card. Never park work as "waiting on the owner" citing this reply.';

// ── Credential-gate conversational replies (2026-10-20) ─────────────────────
/** The owner typed WORDS — not the key — into a credential-gated card. The
 *  2026-10-20 ctrl.cql.ca specimen: "i never got the json policy to copy…" on
 *  a "paste the canlaw-bucket access key you created with the read-only policy
 *  I sent" card. Before: the reply was recorded on the row and noted in the
 *  lane's transcript, but the card showed the RED "needs a credential, not a
 *  text answer" toast (the 0dd7d3f2 fix covered choice / yes_no cards only),
 *  the draft stayed, and the lane was never woken — it sat idle with the
 *  owner's question in a transcript note it would read hours later, so the
 *  policy the owner was missing never arrived. Now an OWNER's conversational
 *  reply wakes the asking lane with this header + instruction (the credential
 *  twin of the free-text counter-question wake) and answers 'reply_recorded'
 *  (the info toast; the draft clears; the card stays open — the gate still
 *  needs the key). A paste-shaped reply (PEM / opaque token / the key field)
 *  keeps 'credential_pending' with no wake: "not stored" carries nothing for
 *  the lane, and the toast's "use the key field" is the right guidance there. */
export const CREDENTIAL_REPLY_WAKE_HEADER =
  '[Owner inbox — the OWNER replied to your credential-gated question WITH TEXT, not the key; the gate is still SHUT]';
export const CREDENTIAL_REPLY_INSTRUCTION =
  'The owner\'s reply is conversation, not the credential: NOTHING was stored, the gate opens ONLY when the key is stored (store_secret, the card\'s key field or the Account UI — stored state, never answer text), and no decision was made — not a GO, not a HALT. ' +
  'Answer the owner NOW, where they will see it: the owner reads the question CARD (and its Telegram copy), never this transcript. ' +
  'If the reply says they never received something you referred to (a policy JSON, console steps, an IAM snippet, a URL, "the instructions"), it never reached them — whatever is not on the card was not sent. ' +
  'Re-file the question with flag_owner_question carrying the COMPLETE paste-ready text on the card itself (consoleAction with payload + click-by-click steps for a console task; context otherwise), ' +
  'supersedes:<this question id> so one card replaces the other, and the same expectedAnswerType credential:<ENVKEY> so the owner\'s key still opens the gate. ' +
  'Never write "as I sent before". Until the key is stored the standing directives apply: work that never needed the key keeps moving; never park other work citing this reply.';
/** Kill switch: CREDENTIAL_REPLY_WAKE_DISABLED=1 restores the pre-2026-10-20
 *  behaviour — every text reply on a credential gate answers
 *  'credential_pending' (the red toast) and the asking lane is not woken. */
export function credentialReplyWakeDisabled(): boolean {
  return process.env.CREDENTIAL_REPLY_WAKE_DISABLED === '1';
}

// ── Choice/yes_no conversational replies (ticket f3a69ed3, 2026-10-21) ──────
/** The owner typed WORDS — not an option pick — onto a choice/yes_no card.
 *  The 2026-10-21 specimen: two plain-English instructions on open cards
 *  ("try to remote use mbp-1 now i stopped othger screenshare" on a
 *  credential card, "use my mbp-1 remote computer use to fix tailscale json"
 *  on a choice card) were both delivered ONLY as a transcript note — the
 *  asking lanes read them hours later, if ever, and from the owner's seat
 *  "nothing happened". Now an OWNER's non-resolving reply wakes the asking
 *  lane with the words (the free-text twin of the 2026-10-20 credential
 *  wake); the card still resolves only on its declared shape. Shares the
 *  CREDENTIAL_REPLY_WAKE_DISABLED kill switch so one switch restores both. */
export const CHOICE_REPLY_WAKE_HEADER =
  '[Owner inbox — the OWNER replied to your flagged question WITH TEXT, not one of the typed options; the card is still OPEN]';
export const CHOICE_REPLY_INSTRUCTION =
  'The owner\'s reply is conversation, not the decision: no option was picked and no ruling was made — not a GO, not a HALT. ' +
  'But the words are SIGNAL — read them as instructions/context and act on what they say where they are within your standing authority; what they ask that needs the owner stays gated on this card. ' +
  'Answer the owner NOW, where they will see it: the owner reads the question CARD (and its Telegram copy), never this transcript. ' +
  'If the reply answers what you were missing, re-file the question with flag_owner_question carrying the complete updated ask on the card itself, supersedes:<this question id> so one card replaces the other, and the same expectedAnswerType so the owner\'s pick still opens the gate. ' +
  'Never park work as "waiting on the owner" without citing this card; never treat the reply as an option it did not name.';

// ── Prior-decision annotation (OWNER-INTERRUPT-ECONOMY, 2026-10-20) ─────────
// A card re-asking a decision the owner already made carries "you decided this
// on <date>" appended to its QUESTION text (owner-interrupt-economy.ts
// renderPriorDecisionAnnotation). Every same-decision / topic / dedupe
// comparison strips it first, so an annotated card still matches its
// unannotated twin and the annotation's quoted answer never decides a match.

/** Leads every prior-decision annotation (owner-interrupt-economy.ts). */
export const PRIOR_DECISION_MARK = '\n\n↩ PRIOR DECISION —';

/**
 * The question text without its prior-decision annotation AND its
 * replaced-reply fold (both are appendices — the prior DECISION quote from a
 * re-ask, and the owner's REPLY quote from a superseded card, ticket
 * f3a69ed3 defect 2). Every path that compares, dedupes, topic-matches or
 * routes a card must normalize these away FIRST: topicTokens /
 * questionTopicOverlap / the anchor scan / classifyOwnerQuestionRouting /
 * normalizeDecisionText / the flag-time exact-question dedupe all call THIS
 * helper, so a folded card still matches its un-folded twin. Pure.
 */
export function stripPriorDecisionAnnotation(s: string): string {
  return stripCardAnnotations(s);
}

/** Clip a card's question for a DM while KEEPING its prior-decision
 *  annotation (the most useful line on a re-asked card — a plain head slice
 *  would cut exactly it) AND its replaced-reply fold (the owner's reply on
 *  the card this one superseded — ticket 913339d7, review obs 3: both the
 *  Telegram DM and the digest line pass row.question, and a folded card
 *  whose fold clips away there is exactly the "my reply vanished" shape
 *  f3a69ed3 fixed on the card). Whichever appendix comes FIRST is kept;
 *  neither present → plain head slice. Pure. */
export function clipQuestionKeepingAnnotation(question: string, max: number): string {
  const q = String(question ?? '');
  if (q.length <= max) return q;
  const priorAt = q.indexOf(PRIOR_DECISION_MARK);
  const foldAt = q.indexOf(REPLACED_REPLY_MARK);
  let at = -1;
  if (priorAt >= 0 && foldAt >= 0) at = Math.min(priorAt, foldAt);
  else if (priorAt >= 0) at = priorAt;
  else if (foldAt >= 0) at = foldAt;
  if (at < 0) return q.slice(0, max);
  const note = q.slice(at).slice(0, Math.max(0, Math.floor(max / 2)));
  const head = q.slice(0, Math.max(0, max - note.length - 1));
  return `${head}…${note}`;
}

// ── Recorded owner replies on a still-open typed gate (ticket f3a69ed3) ─────
// The 2026-10-21 specimen: the owner replied to TWO open cards with plain
// instructions ("try to remote use mbp-1 now i stopped othger screenshare"),
// both bounced by the typed gate as "conversation, not a decision" — and from
// the owner's seat his words vanished (a toast, then nothing ON the card; the
// card later superseded made even the row invisible). The typed gate itself
// is CORRECT (a credential gate opens only on stored state; a choice gate
// resolves only on an option) — the defect is that the reply was never shown
// back. Now every non-resolving owner reply is recorded on the OPEN row as a
// structured, parseable block the owner-facing surfaces render verbatim, with
// the one-line reason it did not resolve and where the reply went.

/** The head mark of the owner-facing recorded-reply block on the answer
 *  column of a still-OPEN row. Everything from here is owner-facing record,
 *  never a ruling. */
export const RECORDED_REPLY_MARK = '↩ YOUR REPLY (received ';

/** The appended fold on a REPLACEMENT card's question: the owner's reply on
 *  the card it replaces, carried forward so a supersede never hides it
 *  (defect 2 of f3a69ed3 — rule asks.card-contract's fold-in, made visible). */
export const REPLACED_REPLY_MARK = '\n\n↩ FROM YOUR EARLIER REPLY —';

/** The question text without its prior-decision annotation AND its
 *  replaced-reply fold — the normalized form every matching / dedupe /
 *  topic-overlap path compares on, so an annotated or folded card still
 *  matches its un-annotated twin. Pure. */
export function stripCardAnnotations(s: string): string {
  const text = String(s ?? '');
  const priorAt = text.indexOf(PRIOR_DECISION_MARK);
  const foldAt = text.indexOf(REPLACED_REPLY_MARK);
  let cut = -1;
  if (priorAt >= 0 && foldAt >= 0) cut = Math.min(priorAt, foldAt);
  else if (priorAt >= 0) cut = priorAt;
  else if (foldAt >= 0) cut = foldAt;
  return cut >= 0 ? text.slice(0, cut) : text;
}

/** The one-line reasons a typed gate did not resolve — plain English, no
 *  gate taxonomy, naming the channel that DOES resolve the card. NOTE: these
 *  strings are parsed back by parseOwnerRecordedReply — they must contain NO
 *  '; ' (the record's reason/delivery separator) and no ' — recorded, not
 *  yet an answer: ' (the words/reason separator). */
export const RECORDED_REPLY_REASON = {
  credential: 'this card opens only when the key itself is stored — paste it in the key field on the card (or store it via store_secret / Account → Coding credentials), words alone cannot open it',
  choice: 'this card resolves by picking one of the typed options',
  yesNo: 'this card resolves with a yes/no ruling (Approve / Decline, or Yes / No)',
} as const;

/** A recorded owner reply parsed off an OPEN row's answer column. `woken` is
 *  true when the record says the asking agent was woken with the reply (the
 *  credential conversational path); false means it reached the asking chat's
 *  transcript as context. Legacy records predate the wake — `legacy: true`. */
export interface ParsedOwnerRecordedReply {
  receivedAt: string;
  text: string;
  withheld: boolean;
  reason: string;
  woken: boolean;
  legacy: boolean;
}

/**
 * Parse an OPEN row's answer column as a recorded owner reply (ticket
 * f3a69ed3). Recognizes BOTH the current owner-facing block and the legacy
 * `[owner replied, gate still shut — …; reply was: "…"]` mismatch records
 * (2026-10-16→20 era rows still carry them). Returns null when the column is
 * anything else (a real answer, a preset-default stamp, null). Pure.
 */
export function parseOwnerRecordedReply(answer: unknown): ParsedOwnerRecordedReply | null {
  const raw = String(answer ?? '').trim();
  if (!raw) return null;
  // Current format — the owner-facing block:
  //   ↩ YOUR REPLY (received <ISO>): "<words>" — recorded, not yet an answer:
  //   <reason>; <delivery tail>
  // The words may be a withheld notice "(… — withheld …)" instead of a quote.
  if (raw.startsWith(RECORDED_REPLY_MARK)) {
    const head = '↩ YOUR REPLY (received ';
    const afterDate = raw.indexOf('): ', head.length);
    if (afterDate < 0) return null;
    const receivedAt = raw.slice(head.length, afterDate);
    const rest = raw.slice(afterDate + 3);
    const sep = rest.indexOf(' — recorded, not yet an answer: ');
    if (sep < 0) return null;
    const wordsPart = rest.slice(0, sep).trim();
    const tail = rest.slice(sep + ' — recorded, not yet an answer: '.length);
    const semi = tail.indexOf('; ');
    const reason = (semi >= 0 ? tail.slice(0, semi) : tail).trim();
    const delivery = semi >= 0 ? tail.slice(semi + 2) : '';
    const quoted = wordsPart.startsWith('"') && wordsPart.endsWith('"') && wordsPart.length >= 2;
    const text = quoted ? wordsPart.slice(1, -1) : wordsPart;
    return {
      receivedAt,
      text,
      withheld: !quoted,
      reason,
      woken: delivery.includes('woken'),
      legacy: false,
    };
  }
  // Legacy choice/yes_no mismatch record (todo 0dd7d3f2 era) — the reply was
  // delivered to the asking chat as a note but never shown to the owner:
  //   [owner replied, gate still shut — expected one of the typed options;
  //    reply was: "<words>"] [<vault notice>]
  // NOTE: tested BEFORE the credential-shape branch — both legacy shapes
  // start '[owner replied' and contain 'reply was:', so the discriminator is
  // the 'expected …' clause (choice/yes_no) vs the 'needs … credential
  // stored' clause (credential).
  if (raw.startsWith('[owner replied') && /expected (one of the typed options|a yes\/no ruling)/.test(raw) && raw.includes('reply was: "')) {
    const open = raw.indexOf('reply was: "') + 'reply was: "'.length;
    const close = raw.lastIndexOf('"');
    const expected = /expected (one of the typed options|a yes\/no ruling)/.exec(raw);
    return {
      receivedAt: '',
      text: close > open ? raw.slice(open, close) : '',
      withheld: false,
      reason: expected?.[1] === 'a yes/no ruling' ? RECORDED_REPLY_REASON.yesNo : RECORDED_REPLY_REASON.choice,
      woken: false,
      legacy: true,
    };
  }
  // Legacy credential mismatch record (the 2026-10-16→20 era):
  //   [owner replied (conversation, not the key), gate still shut — needs the
  //    X credential stored (…); reply was: "<words>" …]
  if (raw.startsWith('[owner replied') && raw.includes('reply was:')) {
    const open = raw.indexOf('reply was: "') + 'reply was: "'.length;
    const close = raw.lastIndexOf('"');
    return {
      receivedAt: '',
      text: close > open ? raw.slice(open, close) : '',
      withheld: false,
      reason: RECORDED_REPLY_REASON.credential,
      woken: raw.includes('the asking chat was woken'),
      legacy: true,
    };
  }
  return null;
}

/**
 * Build the owner-facing recorded-reply block for an OPEN row's answer
 * column (ticket f3a69ed3). The owner's words lead, the reason follows, the
 * delivery tail closes — and like the b71367e5 rule the WORDS give way when
 * the block exceeds `cap`, never the actionable reason/delivery tail. Pure.
 */
/**
 * The wrapper allowance (f3a69ed3): the owner-facing block's fixed overhead
 * — head + reason + delivery + vault notice — is ~200–550 chars, far larger
 * than the legacy record's ~83-char bracket. The ROW ceiling is therefore
 * ANSWER_MAX + this allowance. The two standing doctrines hold by
 * construction: the REPLY never exceeds ANSWER_MAX (capped upstream, and the
 * words give way first inside the builder), and the actionable tail (reason
 * + delivery + vault notice) is NEVER the part that clips.
 */
export const REPLY_RECORD_WRAPPER_ALLOWANCE = 600;

export function buildRecordedReplyRecord(opts: {
  receivedAt: Date;
  text: string;
  reason: string;
  /** 'woken' — the asking agent was woken with the reply; 'sent' — the reply
   *  reached the asking chat's transcript as context. */
  delivered: 'woken' | 'sent';
  vaultNotice?: string;
  cap?: number;
}): string {
  const ceiling = (opts.cap ?? ANSWER_MAX) + REPLY_RECORD_WRAPPER_ALLOWANCE;
  const head = `↩ YOUR REPLY (received ${opts.receivedAt.toISOString()}): `;
  const tail = ` — recorded, not yet an answer: ${opts.reason}; your reply was ${opts.delivered === 'woken' ? 'sent into the asking chat and the agent was woken with it' : 'sent into the asking chat as context'}.`;
  const notice = opts.vaultNotice ? ` ${opts.vaultNotice}` : '';
  // The WORDS give way when head + words + tail + notice would exceed the
  // ceiling — never the reason/delivery/notice (the actionable tail). The
  // clipped form is `"…" …"` — budget−3 chars + quote + ellipsis + quote —
  // exactly the budget, so the record never exceeds the ceiling.
  const budget = Math.max(0, ceiling - head.length - tail.length - notice.length);
  const clean = String(opts.text ?? '').replace(/"/g, "'");
  const clipped = clean.length + 2 > budget ? `"${clean.slice(0, Math.max(0, budget - 3))}…"` : `"${clean}"`;
  return `${head}${clipped}${tail}${notice}`;
}

/**
 * Parse the replaced-reply fold off a card's QUESTION text (defect 2 of
 * f3a69ed3): the owner's reply on the card this one replaced, appended at
 * flag time by the supersedes linkage. Pure; null when no fold is present.
 */
export function parseReplacedReplyFold(question: unknown): { fromQuestionId: string; text: string } | null {
  const raw = String(question ?? '');
  const at = raw.indexOf(REPLACED_REPLY_MARK);
  if (at < 0) return null;
  const line = raw.slice(at + REPLACED_REPLY_MARK.length).trim();
  const m = /^\(card (oq_[0-9a-f-]{8,36})\): "([\s\S]*)"$/.exec(line);
  if (!m) return null;
  return { fromQuestionId: m[1], text: m[2] };
}

// ── Machine-ask preflight (remediation P2 N8) ────────────────────────────────

/** Lowercase alphanumeric token set (no stopword removal — N8's spec is plain
 *  normalized-token overlap). */
function topicTokens(s: string): Set<string> {
  return new Set(
    stripPriorDecisionAnnotation(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean),
  );
}

/** Jaccard overlap of normalized token sets — the N8 topic-dedupe measure. Pure. */
export function questionTopicOverlap(a: string, b: string): number {
  const ta = topicTokens(a);
  const tb = topicTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/** N8 topic-dedupe threshold. */
export const TOPIC_OVERLAP_THRESHOLD = 0.6;

// ── Entity-anchored topic match (ticket b8bdc0e2) ────────────────────────────
// The mishap: the fleet supervisor flagged the SAME waiting run_command
// approval twice, 3 minutes apart, reworded — the second ask shared the entity
// (the lane's chat title) with the first but reworded everything else, landing
// under the 0.6 Jaccard bar and double-filing the owner's inbox. The anchor
// path below catches that shape WITHOUT lowering the global bar: a contiguous
// shared run of tokens containing at least one DISTINCTIVE token (long word /
// digit-bearing id), over a modest Jaccard floor.

/** Ordered normalized token list (kept in order — the anchor scan is a
 *  contiguous-run match, not a set measure). */
function topicTokenList(s: string): string[] {
  return stripPriorDecisionAnnotation(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

/** A token distinctive enough to anchor a topic match: long (≥8 chars —
 *  proper nouns, lane/chat names, identifiers) or digit-bearing (ticket,
 *  schedule, run, oq_ fragments, dates). Short common words never anchor. */
function isAnchorToken(t: string): boolean {
  return t.length >= 8 || /[0-9]/.test(t);
}

/** Minimum contiguous shared-token run (with ≥1 anchor token) that marks two
 *  machine asks as the same topic (ticket b8bdc0e2). */
export const TOPIC_ANCHOR_RUN_MIN = 2;
/** Jaccard floor the anchor path must still clear — an anchor alone never
 *  dedupes two questions that share almost nothing else. */
export const TOPIC_ANCHOR_OVERLAP_FLOOR = 0.25;

/**
 * Longest contiguous run of tokens shared by both questions (order-preserving)
 * that contains at least one anchor token. Pure. 0 = no anchored run.
 */
export function questionTopicAnchorRun(a: string, b: string): number {
  const ta = topicTokenList(a);
  const tb = topicTokenList(b);
  if (!ta.length || !tb.length) return 0;
  // DP over contiguous runs; prevAnchor[j] tracks whether the run ending at
  // (i-1, j-1) already contains an anchor token.
  let best = 0;
  let prevLen = new Array<number>(tb.length + 1).fill(0);
  let prevAnchor = new Array<boolean>(tb.length + 1).fill(false);
  for (let i = 1; i <= ta.length; i++) {
    const curLen = new Array<number>(tb.length + 1).fill(0);
    const curAnchor = new Array<boolean>(tb.length + 1).fill(false);
    const t = ta[i - 1];
    for (let j = 1; j <= tb.length; j++) {
      if (t === tb[j - 1]) {
        const len = prevLen[j - 1] + 1;
        const anchored = prevAnchor[j - 1] || isAnchorToken(t);
        curLen[j] = len;
        curAnchor[j] = anchored;
        if (anchored && len > best) best = len;
      }
    }
    prevLen = curLen;
    prevAnchor = curAnchor;
  }
  return best;
}

/**
 * N8 OPEN-question topic-dedupe predicate: the plain Jaccard bar, OR — ticket
 * b8bdc0e2 — an entity-anchored match (a contiguous shared run of ≥
 * TOPIC_ANCHOR_RUN_MIN tokens with at least one distinctive token, over the
 * TOPIC_ANCHOR_OVERLAP_FLOOR Jaccard floor). Used ONLY for the open-question
 * dedupe; the answered-scan refusal keeps the stricter plain bar (widening a
 * refusal is riskier than widening a dedupe). Pure.
 */
export function questionTopicDedupeMatch(a: string, b: string): boolean {
  const overlap = questionTopicOverlap(a, b);
  if (overlap >= TOPIC_OVERLAP_THRESHOLD) return true;
  return overlap >= TOPIC_ANCHOR_OVERLAP_FLOOR && questionTopicAnchorRun(a, b) >= TOPIC_ANCHOR_RUN_MIN;
}

/** Answers that mean "stop asking / proceed" (N8's answered-scan heuristic). */
export const STOP_ASKING_ANSWER_RE =
  /\b(stop asking|don'?t ask( me)?( again| this)?|no need to ask|never ask|just (do|proceed|go)|go ahead|proceed|approved|yes,? (do|go|proceed)|already (told|answered)|asked and answered)\b/i;

// ── Owner-wait line integrity (remediation P2 N10) — shared vocabulary ───────
// Canonical here (leaf module): the project digest AND the attention watchdog
// verify that any "awaiting owner / needs owner" line is backed by an OPEN
// owner_questions row, and drop unbacked ones (+ an owner_wait_line_dropped
// loop metric).

/** A blocked reason CLAIMING the owner is being waited on. */
// CanLaw stall 2026-09-15: the possessive and "halted per the owner" forms
// joined the claim set — "owner's HALT-band decision MADE" and "pending the
// owner's HALT-band decision" (the two CanLaw HALT todos) matched nothing here,
// so the digest/watchdog/card never even probed whether an owner question
// backed them. Up to three words may sit between "owner's" and the noun
// ("owner's HALT-band decision", "owner's GO/HOLD call").
export const OWNER_WAIT_CLAIM_RE =
  /\b(await(ing|s)?\s+(the\s+)?(owner|you)|needs?\s+(the\s+)?owner|waiting\s+(on|for)\s+(the\s+)?(owner|you)|owner\s+(decision|answer|approval|input)\s*(pending|needed|required)?|pending\s+(the\s+)?owner|owner['’]s\s+(?:[\w/-]+\s+){0,3}?(decision|call|ruling|verdict|approval|answer|halt|hold)|(halt(ed)?|hold|paused|stopped)\s+(per|by)\s+(the\s+)?owner(?![-'’\w]))\b/i;

/** An oq_ id embedded in a reason — accepted as the wait's backing when OPEN. */
export const INLINE_OQ_ID_RE = /oq_[0-9a-f][0-9a-f-]{7,45}/i;

// ── Supervisor-first triage (Review 2026-09-13 issue 11) ────────────────────
// The finding: 7 of 27 owner cards in two days were MACHINE lanes asking the
// owner to approve their OWN work (staging windows, gold-policy picks, GO/HOLD
// forks, $9/mo subscriptions) — duplicates and HOLD-by-inaction defaults
// included — after the owner had pre-approved the budgets and said "clear
// gates always on my behalf" (2026-09-12) and "approve both, stop asking me so
// much, figure it out autonomously" (2026-09-13). Option A: the Fleet
// Supervisor becomes the FIRST RESPONDER on approval-type questions filed by
// machine lanes. The row is created as usual (nothing blocks the lane), but
// carries triage='supervisor' + an SLA deadline: it is hidden from the owner's
// Decisions rail and Telegram, the supervisor is woken with an attention_needed
// alarm carrying the question id, and answers it with answer_owner_question
// under the standing directives. Only when the SLA elapses unanswered does the
// row SURFACE (triage='surfaced') and the owner gets the (once-delayed) DM.
// An owner-only allowlist — physically-human, irreversible/destructive, money
// beyond approval, external sends, credentials — is never triaged. Observe/
// route only: no new blocking gate on any lane's own work.

/** Default SLA (minutes) before an unanswered triaged question surfaces to the
 *  owner. Override: OWNER_QUESTION_TRIAGE_SLA_MIN. */
export const OWNER_QUESTION_TRIAGE_SLA_MIN_DEFAULT = 120;

/** The SLA in minutes — env-overridable, clamped to [1, 24h]; garbage → default. */
export function ownerQuestionTriageSlaMinutes(): number {
  const raw = Number(process.env.OWNER_QUESTION_TRIAGE_SLA_MIN);
  if (!Number.isFinite(raw) || raw < 1) return OWNER_QUESTION_TRIAGE_SLA_MIN_DEFAULT;
  return Math.min(Math.round(raw), 24 * 60);
}

export type OwnerQuestionRoute = 'owner' | 'supervisor';
export type OwnerQuestionRoutingReason =
  | 'physically_human'
  | 'irreversible'
  | 'money_beyond_approval'
  | 'external_send'
  | 'credentials'
  | 'cross_project_scope'
  | 'another_account_security'
  | 'machine_lane_approval';

/**
 * Ticket 661fb494 (2026-09-18 — the Nebius / GLM-5.3 cross-project directive
 * contamination): a lane asking whether a directive the owner posted in
 * ANOTHER project's chat applies to its OWN work is a SCOPE question, and
 * cross-project scope is the owner's call — the fleet triage generalizing
 * "the nebius nodes are to stay off" (posted in the inference project) into
 * "stop the canaries too" parked CanLaw's SFT-2 chain ~18h, and the spark
 * cluster's "stop all work on glm5.3" was applied to the inference project's
 * GLM-5.3 deployment. These route straight to the OWNER, never to supervisor
 * triage (the ticket's "else ask" triage rule, made deterministic).
 * Matched shapes: apply-forms aimed at the asking lane ("does that apply to
 * our SFT-2 chain?"), explicit scope nouns ("fleet-wide", "every project",
 * "another project", "cross-project"), and the generalization ask ("should
 * we also stop/pause/halt …?"). False-positive cost is one owner card (the
 * reason rides the flag's info line) — cheap next to a mis-scoped fleet
 * ruling; a purely cost-shaped ask carries no scope wording and still routes
 * to the supervisor per the pre-approved-budgets doctrine.
 *
 * Ticket b32e0da5 (2026-09-18 — adversarial-review follow-up, N1): the
 * generalization-ask verb list is narrowed to the INCIDENT verbs
 * stop/pause/halt. The shipped list (start/keep/use/follow/comply/adopt/
 * apply) owner-routed 7/16 ordinary approvals in the reviewer probe,
 * bypassing the supervisor triage the "stop asking me — figure it out"
 * standing directive wants answered under standing directives. A stop-shaped
 * generalization is the mis-scope risk class (both incidents were stops), so
 * it keeps failing toward the human; the benign verbs now triage. The same
 * ticket's N2 — a BARE project name this /i flag can't class ("does that
 * directive apply to CanLaw?") — is covered roster-backed at flag time; see
 * questionNamesAnotherOwnerProject below.
 */
export const CROSS_PROJECT_SCOPE_QUESTION_RE =
  /\bappl(?:y|ies|ied|ying|icab\w*)\b[^.!?;]{0,80}?\bto\s+(?:us|our|my|me|its|both|this\s+project|the\s+[\w-]+\s+project)\b|\bfleet[- ]wide\b|\bcross[- ]project\b|\bacross\s+(?:the\s+)?(?:fleet|all\s+projects|both\s+projects)\b|\b(?:every|all)\s+projects?\b|\b(?:an|the)\s+other\s+project\b|\banother\s+project\b|\bshould\s+(?:we|i)\s+also\s+(?:stop|pause|halt)\b/i;

/** The owner-only allowlist — a question matching ANY of these is never
 *  triaged to the supervisor. Order = precedence of the reported reason. */
export const OWNER_ONLY_QUESTION_CLASSES: ReadonlyArray<{ reason: OwnerQuestionRoutingReason; re: RegExp }> = [
  { reason: 'physically_human', re: /\b(sign(ing)?( identity)?|tap|click|plug|physically|on your (mac|phone|laptop)|your finger)\b/i },
  { reason: 'irreversible', re: /\b(irreversib\w*|destroy|wipe|terminate the (instance|reservation|node)|delete the (repo|database|account|bucket))\b/i },
  // Project-supervisor preflight 2026-09-14: the money class is NOT owner-only —
  // budgets are pre-approved (CanLaw "way over 150k") and cost cards are
  // forbidden, so cost-shaped questions route to the supervisor's triage like
  // any other approval on a lane's own work. (money_beyond_approval stays in the
  // reason type for telemetry compatibility; no class emits it.)
  { reason: 'external_send', re: /\b(send|post|publish|email) (it |them |this )?(to|on) (linkedin|twitter|x\b|customers?|investors?|the client)\b/i },
  { reason: 'credentials', re: /\b(rotate|revoke|share) (the )?(key|credential|token|password)\b/i },
  // Audit 96fb2f25 (specimen oq_e4869c75): a question whose subject is ANOTHER
  // ACCOUNT or ANOTHER USER'S data — the held-ticket class ("this ticket is on
  // another account (or quotes another user's chat)") — is a security/trust
  // boundary, never a supervisor triage call. The specimen: the Fleet
  // Supervisor answered an approve-dispatch ask over exactly that hold citing
  // only the generic "clear gates always on my behalf" directive, judging on
  // its own that the foreign account was synthetic. Another-account trust is
  // the owner's call alone.
  { reason: 'another_account_security', re: /\banother\s+(?:account|user|member)\b|\bother\s+(?:users|accounts|members)\b|\bquotes?\s+another\s+user(?:'s)?\s+(?:chat|messages?|account)\b/i },
  // Ticket 661fb494: LAST — the established owner-only classes keep precedence
  // of the reported reason when a question matches both.
  { reason: 'cross_project_scope', re: CROSS_PROJECT_SCOPE_QUESTION_RE },
];

// ── Payload owner-only class (ticket 1a56f816, 2026-10-30) ──────────────────
// The regex allowlist above is built from the QUESTION/context PROSE, and the
// specimen card had none of its cues: oq_3c246863 (2026-10-30T16:56:51Z) asked
// the owner to run sudo commands on a specific Mac mini and paste what steps 4
// and 5 printed. Its typed options were "Done — ran it, output pasted below" /
// "Error — it printed something odd" / "Defer" / "I don't have the sudo
// password / not at that machine right now" — the PHYSICALLY-HUMAN class by
// construction — but no "click/tap/sign" verb appeared anywhere, so
// classifyOwnerQuestionRouting returned 'supervisor' and the card was held in a
// 2 h triage window while the owner sat in the filing chat ASKING for exactly
// that payload ("you need to provide step by step instructions dont know what
// you just said to to run agents enable?"). A Fleet Supervisor could not answer
// it (answer_owner_question refuses owner-only classes) and could not release
// it (dismiss withdraws, never surfaces) — the hold was unbreakable.
//
// The class is decidable from the card's OWN STRUCTURED PAYLOAD, which the
// prose regex never reads:
//   1. its typed OPTIONS are reports of a HUMAN having physically acted
//      ("ran it", "output pasted below", "not at that machine", "don't have
//      the sudo password") — a first-responder supervisor can produce none of
//      them, so the card can only ever wait for the owner;
//   2. the text names a PHYSICAL DEVICE *and* either a credential the platform
//      does not hold (sudo / console / login / root password) or a
//      run-it-then-paste-the-output instruction.
// Both legs are deliberately NARROW (the conjunction in leg 2, and no bare
// "Defer" — the harness injects that label on every console card): the
// direction of a miss is one owner card, and the direction of an over-match is
// a supervisor triaging work it cannot do, which is the bug this closes.
// Kill switch OWNER_QUESTION_PAYLOAD_CLASS_DISABLED=1.

/** A typed option whose LABEL is a report that a human has physically acted —
 *  a COMPLETED report or an INABILITY to act, never an imperative.
 *
 *  REVIEW FIX (ticket 1a56f816, adversarial finding 1 — BLOCKING): the first
 *  cut shared one alternation with the imperative "run it", so it matched the
 *  commonest affirmative option label in the fleet ("Run it", "Go ahead and
 *  run it", "Re-run it", "Run it and paste the output") and would have
 *  owner-routed every ordinary approve-the-action card, bypassing supervisor
 *  triage wholesale — the exact over-match class ticket b32e0da5/N1 chased
 *  (7 of 16 ordinary approvals wrongly owner-routed). The discriminator is
 *  TENSE AND SHAPE: an imperative ("run it") is an instruction the machine
 *  lane executes; only a PAST-TENSE report ("done — ran it, output pasted
 *  below") or an inability report ("not at that machine", "don't have the
 *  sudo password") proves the card is waiting on a person. So: no bare
 *  run/execute verbs, and a "ran it" form must carry its report. The
 *  specimen's options still match on three independent alternatives
 *  ("output pasted below" / "printed something" / "don't have the sudo
 *  password"), so narrowing costs nothing on the incident.
 *  Also excludes the bare "Defer" label (CONSOLE_ACTION_DEFAULT_OPTIONS
 *  injects it on every console card and it says nothing about the class). */
export const HUMAN_ACTION_OPTION_RE =
  /\boutput\s+pasted\b|\bpasted\s+(?:it\s+)?(?:in\s+)?below\b|\bprinted\s+(?:something|this|the\s+following|it\s+out)\b|\bnot\s+at\s+(?:that|the)\s+machine\b|\bdon'?t\s+have\s+(?:the\s+)?(?:sudo|console|admin|login|root)\s+(?:password|pass|access)\b|\bat\s+(?:that|the)\s+machine\s+right\s+now\b|\b(?:i\s+)?ran\s+(?:it|this|them|the\s+commands?)\b[^.!?]{0,40}\b(?:output|result|below|printed|log)\b/i;

/** A device only a person can touch — never a cloud box the fleet drives (so
 *  "the EC2 box" / "box-a" / "the staging server" never match). */
export const PHYSICAL_DEVICE_RE =
  /\b(?:mac\s?mini|macbook|mac\s?book|laptop|iphone|ipad|android\s+phone|your\s+phone|the\s+phone|desktop|physical(?:ly)?\s+(?:machine|device|access)|at\s+(?:that|the)\s+machine|keyboard|screen\s?sharing|plug(?:ged)?\s+(?:it\s+)?in)\b/i;

/** A credential the platform cannot hold or read for a physical device. */
export const UNOBTAINABLE_CREDENTIAL_RE =
  /\bsudo\b|\b(?:console|admin|login|root|local)\s+password\b|\bpassword\s+(?:for|to)\s+(?:that|the)\s+(?:machine|mac|box|device|laptop)\b|\bfirmware\s+password\b|\bboot\s+password\b/i;

/** An instruction to run something and report what it printed. */
export const RUN_AND_PASTE_RE =
  /\bpaste\s+(?:what|whatever|the)\s+(?:\w+\s+){0,3}(?:output|result|reply|prints?|shows?|says?)\b|\b(?:run|type|execute|paste)\b[^.!?;]{0,120}\b(?:then|and)\b[^.!?;]{0,60}\b(?:paste|copy|send|report|tell\s+me|reply)\b/i;

/**
 * The PAYLOAD leg of the owner-only class admission (ticket 1a56f816). Returns
 * 'physically_human' when the card's own structured payload proves only a
 * person can answer it, else null. PURE; exported for tests and for the
 * answer-time / dismiss-rail re-checks (which read the STORED row).
 */
export function ownerOnlyPayloadClass(input: {
  question: string;
  context?: string | null;
  options?: OwnerQuestionOption[] | null;
}): OwnerQuestionRoutingReason | null {
  for (const o of input.options ?? []) {
    const label = `${o?.label ?? ''} ${o?.consequence ?? ''}`;
    if (HUMAN_ACTION_OPTION_RE.test(label)) return 'physically_human';
  }
  const text = `${stripPriorDecisionAnnotation(String(input.question ?? ''))}\n${String(input.context ?? '')}`;
  if (PHYSICAL_DEVICE_RE.test(text) && (UNOBTAINABLE_CREDENTIAL_RE.test(text) || RUN_AND_PASTE_RE.test(text))) {
    return 'physically_human';
  }
  return null;
}

/**
 * The owner-only verdict for a card as it is STORED (question / context /
 * options / declared answer type / console action). ONE definition for the
 * answer-time guard, the dismiss rails and the delivery legs, so a class added
 * to the payload leg can never be enforced on only one of them. PURE.
 * Kill switch OWNER_QUESTION_PAYLOAD_CLASS_DISABLED=1 (payload leg only).
 */
export function ownerOnlyRoutingForStoredRow(row: {
  question: string;
  context?: string | null;
  options?: unknown;
  expectedAnswerType?: string | null;
  consoleAction?: unknown;
}): OwnerQuestionRoutingReason | null {
  const routing = classifyOwnerQuestionRouting(row.question, row.context ?? null);
  if (routing.route === 'owner') return routing.reason;
  // The structural legs the flag path already upgrades on (credential gate,
  // console action) — re-derived from the row so the answerable-elsewhere
  // checks agree with the file-time routing.
  if (parseExpectedAnswerType(row.expectedAnswerType, row.question).type === 'credential') return 'credentials';
  if (parseStoredConsoleAction(row.consoleAction)) return 'physically_human';
  if (!ownerQuestionPayloadClassDisabled()) {
    const payload = ownerOnlyPayloadClass({
      question: row.question,
      context: row.context ?? null,
      options: parseStoredOptions(row.options),
    });
    if (payload) return payload;
  }
  return null;
}

/**
 * Route an owner question: 'owner' when it falls in the owner-only allowlist
 * (scanned over the question AND its context — context carries the dollar
 * figures and the verbs), else 'supervisor' (a machine lane's approval-type
 * ask the supervisor answers first under standing directives). PURE — the
 * caller applies the machine-triggered / non-supervisor-chat / kill-switch
 * conditions. Misclassification trade-off (review issue 11): an owner-only
 * ask wrongly triaged still surfaces to the owner after the SLA; the reason
 * is logged on the flag's info line so the class is auditable.
 */
export function classifyOwnerQuestionRouting(
  question: string,
  context?: string | null,
): { route: OwnerQuestionRoute; reason: OwnerQuestionRoutingReason } {
  // OWNER-INTERRUPT-ECONOMY review 2026-10-20: a re-asked card's prior-decision
  // annotation QUOTES the owner's old answer ("ok — wipe the cache") — it must
  // never decide this card's routing (flag-time triage, the answer-time
  // owner_only_class check, the dismiss rails, the dismissal cooldown).
  const text = `${stripPriorDecisionAnnotation(String(question ?? ''))}\n${String(context ?? '')}`;
  for (const cls of OWNER_ONLY_QUESTION_CLASSES) {
    if (cls.re.test(text)) return { route: 'owner', reason: cls.reason };
  }
  return { route: 'supervisor', reason: 'machine_lane_approval' };
}

/** Ticket b32e0da5 (N2): the cue set for the roster-backed scope check — a
 *  directive/applicability word must ride ALONGSIDE the named project, or
 *  every mention of a sibling project ("the CanLaw build is red — rerun it?")
 *  would owner-route, re-creating the N1 over-breadth one layer down. */
const NAMED_PROJECT_SCOPE_CUE_RE =
  /\b(?:directives?|appl(?:y|ies|ied|ying)|bind\w*|govern\w*|cover\w*|follow\w*|fleet[- ]wide|cross[- ]project|scope)\b/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ticket b32e0da5 (N2 — 2026-09-18): does the text name ANOTHER project of
 * the same owner in a directive/applicability ask? The regex guard cannot
 * recognize a BARE project name ("does that directive apply to CanLaw?",
 * "Does it bind CanLaw too?", "Should the inference project follow it?" — the
 * /i flag forbids proper-noun classes), yet that is exactly the "first
 * sentence names BOTH projects" shape the doctrine prescribes — the filing
 * project already rides the question's [Project] prefix, so one more named
 * project completes the pair. At flag time the owner's roster is knowable:
 * match any sibling project's name (word-boundary, case-insensitive, ≥3
 * chars — shorter names are too collision-prone) alongside a cue word. Fail
 * direction stays toward the human (one owner card); a missing/unreadable
 * roster keeps the regex route. BEST-EFFORT — a roster name the lane
 * abbreviates ("the inference project" for a project named "inference-prod")
 * still misses, backstopped by the fleet SCOPE RULE + the SLA.
 */
export async function questionNamesAnotherOwnerProject(
  prisma: any,
  input: { chatId: string; userId: string },
  text: string,
): Promise<boolean> {
  try {
    if (!NAMED_PROJECT_SCOPE_CUE_RE.test(text)) return false;
    const chat = await prisma?.crossModelChat?.findUnique?.({
      where: { id: input.chatId },
      select: { projectId: true },
    });
    const projects = await prisma?.crossModelProject?.findMany?.({
      where: { userId: input.userId },
      select: { id: true, name: true },
    });
    if (!Array.isArray(projects) || !projects.length) return false;
    const filingProjectId = typeof chat?.projectId === 'string' ? chat.projectId : null;
    for (const p of projects) {
      if (!p || p.id === filingProjectId) continue;
      const name = String(p.name ?? '').trim();
      if (name.length < 3) continue;
      if (new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(text)) return true;
    }
  } catch { /* roster probe is best-effort — keep the regex route */ }
  return false;
}

/** Is this row hidden from the owner RIGHT NOW (open, in supervisor triage,
 *  SLA not yet elapsed)? Pure; shared by the listings' view marker. */
export function isOwnerQuestionInTriage(
  row: { status?: string | null; triage?: string | null; triageUntil?: Date | string | null },
  now: Date = new Date(Date.now()),
): boolean {
  if (!row || row.status !== 'open' || row.triage !== 'supervisor' || !row.triageUntil) return false;
  const until = row.triageUntil instanceof Date ? row.triageUntil.getTime() : new Date(row.triageUntil).getTime();
  return Number.isFinite(until) && until > now.getTime();
}

/** Prisma where-fragment that EXCLUDES rows currently in supervisor triage
 *  (the default owner-facing view). Explicit null branches — never a bare
 *  NOT on a nullable column (SQL three-valued NULL semantics would drop the
 *  never-triaged rows). */
function notInTriageWhere(now: Date): Record<string, unknown> {
  return {
    OR: [
      { status: { not: 'open' } },
      { triage: null },
      { triage: { not: 'supervisor' } },
      { triageUntil: null },
      { triageUntil: { lte: now } },
    ],
  };
}

/** Loop-metric receipt from this module (dynamic import — see header). Never throws. */
async function recordOwnerQuestionMetric(kind: string, meta: Record<string, unknown>, sessionId?: string): Promise<void> {
  try {
    const m: any = await import('./loop-metrics.service');
    if (typeof m?.recordLoopMetric !== 'function') return;
    m.recordLoopMetric({ kind, ...(sessionId ? { sessionId } : {}), meta });
  } catch { /* telemetry never blocks the inbox */ }
}

/**
 * Ticket 661fb494: the " — filed from chat \"<title>\" (project: <name>)"
 * suffix for the triage wake. The supervisor's scope rule (a directive from
 * another project's chat never binds the asking lane's project) needs the
 * question's HOME project visible in the event body itself — the hook
 * envelope's source-chat title alone does not name the project.
 * TOTAL: any failure degrades to '' (the wake still fires, unscoped).
 */
async function triageOriginLabel(chatId: string): Promise<string> {
  try {
    const prisma = await db();
    const chat = await (prisma as any).crossModelChat?.findUnique?.({
      where: { id: chatId },
      select: { title: true, project: { select: { name: true } } },
    });
    if (!chat) return '';
    const title = String(chat.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || chatId.slice(0, 8);
    const projectName = String(chat.project?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'ungrouped';
    return ` — filed from chat "${title}" (project: ${projectName})`;
  } catch {
    return '';
  }
}

/**
 * Wake the Fleet Supervisor about a freshly triaged question: an
 * attention_needed hook event from the FILING chat (the supervisor's wildcard
 * hook picks it up; attention_needed is ALARM-class in hooks.service —
 * ALARM_EVENT_TYPES — so it bypasses the wake cap + debounce). The summary
 * carries the question (+ numbered options) and ENDS with the question id the
 * supervisor passes to answer_owner_question; the question is clipped so the
 * id always survives the hook summary cap. Best-effort — a failed wake just
 * means the SLA surfaces the row to the owner.
 */
async function wakeSupervisorForTriage(input: {
  chatId: string;
  questionId: string;
  question: string;
  options: OwnerQuestionOption[] | null;
}): Promise<void> {
  try {
    const hooks: any = await import('./hooks.service');
    if (typeof hooks?.emitHookEventSafe !== 'function') return;
    const optionsBlock = input.options?.length ? `\n${renderOptionsNumbered(input.options)}` : '';
    // Ticket 661fb494: the origin label sits BEFORE the trailing question id —
    // if the hook summary cap ever truncates, the id (the answer handle) is
    // the last thing that can be cut, and the body is clipped so it never is.
    const origin = await triageOriginLabel(input.chatId);
    const body = `${input.question.slice(0, 1100)}${optionsBlock}`.slice(0, 1450);
    const summary =
      `[OWNER-QUESTION TRIAGE — answer under standing directives or leave for the owner] ` +
      `${body}${origin} — question id ${input.questionId}`;
    await hooks.emitHookEventSafe(input.chatId, 'attention_needed', summary, {
      ownerQuestionId: input.questionId,
      triage: 'supervisor',
    });
  } catch (err: any) {
    await logOwnerQuestions('warn', `owner-questions: supervisor triage wake failed for ${input.questionId}: ${err?.message ?? err}`);
  }
}

/** flagOwnerQuestion's input (the flag_owner_question tool's arguments plus
 *  the harness-supplied chat / user / machine-turn facts). */
export interface FlagOwnerQuestionInput {
  chatId: string;
  userId: string;
  question: string;
  context?: string;
  /** Typed decision options (N3) — optional; free-text questions stay the norm. */
  options?: unknown;
  /** Lane linkage (v1#5): a second chat the answer wakes + the gated goal/todo. */
  forChatId?: string;
  goalId?: string;
  todoId?: string;
  /** True for machine-triggered runs (no user-turn anchor) — arms the N8 ask
   *  preflight (topic dedupe + answered-scan) AND, for a non-supervisor filing
   *  chat, the supervisor-first triage (Review 2026-09-13 issue 11). */
  machineTriggered?: boolean;
  /** Cost-of-delay (P7 S2b): the flagger's estimate of what waiting costs per
   *  day (USD) — rendered on the Telegram DM + Inbox card. Advisory only. */
  idleUsdPerDay?: number;
  /** Conservative default answer (P7 S2b): past defaultAfterDays OPEN days the
   *  escalation sweep auto-answers with defaultOption. BOTH must be supplied
   *  by the flagger or neither arms (double guard). */
  defaultAfterDays?: number;
  defaultOption?: string;
  /** Todo 77c88942 item 2 (2026-10-16): the expected answer TYPE —
   *  'credential:<ENVKEY>' | 'choice' | 'yes_no' | 'free'. A credential gate
   *  NEVER resolves on answer text (stored state for that envKey lifts it —
   *  a store_secret receipt OR the CodingCredential row); 'choice' requires
   *  a typed-option match; 'yes_no' requires an affirmative/negative ruling. */
  expectedAnswerType?: string;
  /** Ticket 90a5b127: the flagger's own typed declaration that the ask is
   *  OPTIONAL — TRUE completes the options axis of the payload-gap admission
   *  by declaration (the structural fix for the incomplete-card FP family's
   *  wording chase); FALSE suppresses the prose-optionality fallback;
   *  omit for prose detection. */
  optionalAsk?: boolean;
  /** Ticket 1b1c41bc: a card asking the owner to perform an action in an
   *  EXTERNAL console. When present, the service composes the four-element
   *  card body (paste-ready payload + click-by-click steps + what/why-safe
   *  line + typed saved/error/defer options) — the filing agent never
   *  hand-formats it. */
  consoleAction?: unknown;
  /** Todo fea78360 (monitor lesson 6): the OPEN owner card this card
   *  REPLACES (full oq_ id or ≥8-char prefix). The harness links both rows
   *  (supersedesId here, supersededBy on the old card) and auto-dismisses
   *  the predecessor at filing time — one decision, one live card. Fail-
   *  closed on an id that does not resolve to one of the owner's cards
   *  (refused invalid); the OWN-supersedes linkage survives the detector
   *  kill switch (it is support, not detection). */
  supersedes?: string;
  /** Ticket 26786762: credentials this card DELIVERS to the owner —
   *  {label?, value} entries (max 3). The value rides ONLY into the
   *  encrypted owner_question_secrets store (reveal is owner-authed REST,
   *  with a Reveal/Copy affordance on the card); the card text carries a
   *  numbered handle ("[SECRET 1] — <label>") and NEVER the value. Use this
   *  for shapes the secret scanner does not know; spans the scanner DOES
   *  know are rescued automatically (vaulted with the same reveal). */
  deliverSecrets?: unknown;
  /** OWNER-INTERRUPT-ECONOMY (2026-10-20): the flagger marks the card URGENT —
   *  the owner is DMed at once instead of in the 12 h digest. */
  urgent?: boolean;
  /** OWNER-INTERRUPT-ECONOMY: the choice is REVERSIBLE — with a
   *  recommendedDefault, outside the owner-only classes, the default applies
   *  after 24 h with no answer (announced in the next digest). */
  reversible?: boolean;
  /** The flagger's recommended answer for a reversible card (defaults to
   *  defaultOption when only that was supplied). */
  recommendedDefault?: string;
  /** Prior-decision recall escape hatch: what MATERIALLY changed since the
   *  owner last decided this — a machine strict re-ask then files (annotated)
   *  instead of being refused. */
  revisitReason?: string;
  /** Set ONLY by HARNESS per-event filers (never the flag_owner_question
   *  tool): when the platform event this card reports happened (a schedule
   *  paused, a block streak escalated, a purpose auto-demoted). Those callers
   *  ignore a refusal, so a strict match to an owner decision made BEFORE the
   *  event files annotated instead of refused (a paused schedule is never
   *  left with no card); a decision made after the event still refuses. */
  harnessEventAt?: Date | string;
}

/** What the economy legs decided for one flag call — the
 *  owner_question_flagged metric row (OWNER-INTERRUPT-ECONOMY). */
interface OwnerFlagTrace {
  delivery?: 'immediate' | 'digest' | 'triage';
  deliveryReason?: string;
  ownerOnlyReason?: string | null;
  priorRecall?: 'refused' | 'annotated';
  priorQuestionId?: string;
  priorStrict?: boolean;
  reversible?: string;
  advisory?: string;
  supervisorFiler?: boolean | null;
}

/**
 * Flag a question/decision for the owner (the flag_owner_question tool's
 * service half). Validation → dedup → dismissed-cooldown → open cap → rate
 * cap → create; refusals are structured, never thrown.
 * OWNER-INTERRUPT-ECONOMY (2026-10-20): every call records ONE
 * owner_question_flagged row (outcome + the economy legs' verdicts) — the
 * owner's interrupt load, measured per owner instead of per chat.
 */
export async function flagOwnerQuestion(input: FlagOwnerQuestionInput): Promise<FlagOwnerQuestionResult> {
  const trace: OwnerFlagTrace = {};
  const result = await flagOwnerQuestionCore(input, trace);
  void recordOwnerQuestionFlaggedMetric(input, result, trace).catch(() => {});
  return result;
}

async function recordOwnerQuestionFlaggedMetric(input: FlagOwnerQuestionInput, r: FlagOwnerQuestionResult, trace: OwnerFlagTrace): Promise<void> {
  try {
    const economy = await import('./owner-interrupt-economy');
    await economy.recordOwnerInterruptMetric('owner_question_flagged', {
      outcome: r.kind,
      ...(r.kind === 'refused' ? { refused: r.refused } : {}),
      delivery: trace.delivery ?? null,
      deliveryReason: trace.deliveryReason ?? null,
      priorRecall: trace.priorRecall ?? null,
      machine: input.machineTriggered === true,
      supervisorFiler: trace.supervisorFiler ?? null,
      advisory: trace.advisory ?? null,
      reversible: trace.reversible ?? null,
      ownerOnly: trace.ownerOnlyReason ?? null,
      urgent: input.urgent === true,
      ...(r.kind === 'created' || r.kind === 'deduped' ? { questionId: r.question.id.slice(0, 11) } : {}),
      ...(trace.priorQuestionId ? { priorQuestionId: trace.priorQuestionId.slice(0, 11), priorStrict: trace.priorStrict === true } : {}),
      chatId: String(input.chatId ?? '').slice(0, 8),
      userId: String(input.userId ?? '').slice(0, 8),
    }, input.chatId);
  } catch { /* telemetry never blocks the inbox */ }
}

/** Add one harness line to a card's context: FIRST (the owner reads the head
 *  of a collapsed context) — except after a leading stopped-schedule marker,
 *  which must stay the context's lead (SA0906). Capped at CONTEXT_MAX. Pure. */
function prependOwnerCardContextLine(context: string, line: string): string {
  const ctx = String(context ?? '');
  if (ctx.startsWith(STOPPED_SCHEDULE_MARKER_PREFIX)) {
    const nl = ctx.indexOf('\n');
    const head = nl >= 0 ? ctx.slice(0, nl) : ctx;
    const rest = nl >= 0 ? ctx.slice(nl + 1) : '';
    return `${head}\n${line}${rest ? `\n${rest}` : ''}`.slice(0, CONTEXT_MAX);
  }
  return `${line}${ctx ? `\n${ctx}` : ''}`.slice(0, CONTEXT_MAX);
}

async function flagOwnerQuestionCore(input: FlagOwnerQuestionInput, trace: OwnerFlagTrace): Promise<FlagOwnerQuestionResult> {
  const prisma = await db();
  // ── Ticket 26786762: agent→owner credential DELIVERY ──────────────────────
  // The inbound scan exists to keep secrets OUT of owner-facing card text —
  // but a card whose whole purpose is to HAND the owner a credential is the
  // sanctioned exception (the owner's own directive is the authorization;
  // specimen oq_f4472e5e: the owner asked for the LiteLLM key and received
  // "[REDACTED: looked like a credential]"). The value now routes to the
  // encrypted owner_question_secrets store at write time; the card text
  // carries a numbered reveal handle. Both legs:
  //   (a) IMPLICIT RESCUE — spans the scan WOULD destroy in question/context
  //       are captured and vaulted (bounded: single-line, ≤3, PEM/multi-line
  //       stays destroyed with a deliverSecrets nudge);
  //   (b) EXPLICIT DELIVERY — the deliverSecrets param, for scanner-unknown
  //       shapes; validated fail-closed (a refused delivery NEVER files a
  //       card that looks delivered).
  const secretDelivery = await import('./owner-question-secrets');
  if (secretDelivery.oqSecretDeliveryDisabled()) {
    // Advisory 8 (review): an EMPTY deliverSecrets delivers nothing — only a
    // non-empty array under the switch is a delivery that must refuse.
    const ds = input.deliverSecrets;
    if (Array.isArray(ds) ? ds.length > 0 : ds !== undefined && ds !== null) {
      return {
        kind: 'refused', refused: 'invalid',
        message: 'deliverSecrets is disabled (OWNER_SECRET_DELIVERY_DISABLED=1) — the owner card would redact the value at write time. Do not file the card as a delivery; leave the value in the vault or wait for the owner to pull it.',
      };
    }
  }
  const deliveryEnabled = !secretDelivery.oqSecretDeliveryDisabled();
  const explicitParsed = secretDelivery.oqSecretDeliveryDisabled()
    ? { ok: true as const, entries: [] }
    : secretDelivery.parseDeliverSecrets(input.deliverSecrets);
  if (!explicitParsed.ok) {
    return { kind: 'refused', refused: 'invalid', message: `deliverSecrets invalid: ${explicitParsed.error}` };
  }
  // Explicit values get the vault's own well-formedness pass (PEM/quote/escape
  // normalization). One refused entry refuses the WHOLE flag — a card that
  // delivers 2 of 3 values is the silent-drop mishap again.
  const explicitEntries: Array<{ label: string; value: string }> = [];
  for (const [i, e] of explicitParsed.entries.entries()) {
    const v = await secretDelivery.validateExplicitSecretValue(e.value);
    if (v === null) {
      // J2 (round 8): the full entry value set is in hand HERE (raw values
      // from the parse) — the refusal label gets the same echo-aware gate as
      // the store/manifest seams (a scanner-UNKNOWN value echoed in another
      // entry's label rode the refusal result raw; round 5's E fix was filed
      // on exactly this seam).
      const allValues = explicitParsed.entries.map((x) => x.value);
      return {
        kind: 'refused', refused: 'invalid',
        // Review BLOCKING E (round 5): refusal results ride the same
        // unredacted tool-result seam — the label is safe-labeled (the
        // index carries the reference), never the raw text.
        message: `deliverSecrets entry ${i + 1} (${secretDelivery.safeDeliverableLabel(e.label, allValues)}) is not storable (multi-line values must be a complete well-formed PEM block; quotes are stripped once) — deliver the real value or use a single line`,
      };
    }
    explicitEntries.push({ label: e.label, value: v });
  }
  // Secret-scrubbing review fix (question/context): the same inbound
  // redaction the answer path runs (INBOUND_SECRET_SCAN_DISABLED=1; never
  // throws) — but now with the span RESCUE: storable spans are captured and
  // replaced by numbered reveal handles instead of the destruction marker.
  // The stopped-schedule marker `[stopped-schedule:…]` that must LEAD a
  // context carries no credential label, so it survives intact.
  //
  // Review BLOCKING G2 (round 6) + H5 (round 7): an EXPLICITLY delivered
  // value echoed verbatim in question/context rides into the STORED card
  // text raw when the scanner does not know the shape (cfat_… class) — the
  // card text broadcasts to the Telegram DM and the fleet board, so a value
  // the card exists to deliver would leak on every ancillary surface. We
  // HOLD the exact value, so the scrub needs no scanner knowledge: each
  // echo is replaced by its own reveal handle BEFORE the span pass (which
  // then cannot rescue it a second time). The ≥8-char floor matches the
  // preview seam (every scanner pattern is ≥10 chars — no real credential
  // sits under it; shorter strings are prose, not values).
  // H5 fragment guard (round 7): a slot capped BEFORE the scrub (a 24-char
  // payloadLanguage, a 40-char option id) slices a FRAGMENT of the value —
  // the full-length echo check misses it. Scrub the fragment BEFORE any
  // slice happens (callers must pass the RAW slot text), and also match a
  // leading/trailing fragment of ≥8 chars against the candidates here.
  const rescueCounter: SpanRescueCounter = { next: 1 + explicitEntries.length, start: 1 + explicitEntries.length };
  const implicitKept: Array<{ ordinal: number; value: string; name: string }> = [];
  // J1 (round 8): the echo candidate set is EXPLICIT entries ∪ implicit-rescued
  // spans — implicitKept fills during the question/context passes below, and
  // the closure reads it at CALL time, so every LATER scrub site (options
  // label/id/consequence, defaultOption, goalId/todoId, every console slot)
  // sees both legs. The original specimen class (a scanner-known key
  // implicit-rescued from the question, echoed in an option label) leaked
  // here — the card delivered AND leaked at once. Each value maps to its OWN
  // ordinal so the replacement handle resolves on reveal (explicit: 1..E;
  // implicit: E+1.. as the rescue counter set).
  const echoScrub = (text: string): string => {
    let out = text;
    // R1-5 (round-1 review of 5c024656, probe D6; ticket 91b0f191): the
    // two-key prefix collision. The old single insertion-order loop let a
    // shorter candidate's FULL pass carve the head of a longer candidate's
    // occurrence into a handle; the longer candidate's slice(-8) fragment
    // leg then matched its own tail — interleaving handle text with the raw
    // middle of the value ('Use [SECRET 1]ZZZZYYYYX[SECRET 2] now'). Two
    // phases close it:
    //   (1) ALL full-value replacements first, LONGEST candidate first — a
    //       longer candidate consumes its whole occurrence before a shorter
    //       prefix candidate can split it;
    //   (2) fragment legs afterwards (also longest first), SKIPPED for a
    //       candidate whose full value already matched this call (its
    //       occurrences are already handles).
    // Longest-first ordering ALONE is not enough: without the phase split a
    // longer candidate's fragment leg can still fire inside a shorter
    // candidate's full occurrence (the mirror of the probe shape) — hence
    // fragments strictly after every full pass.
    const candidates: Array<{ value: string; ordinal: number }> = [
      ...explicitEntries.map((e, i) => ({ value: e.value, ordinal: i + 1 })),
      ...implicitKept.map((k) => ({ value: k.value, ordinal: k.ordinal })),
    ]
      .filter((c) => c.value.length >= 8)
      .sort((a, b) => b.value.length - a.value.length);
    const fullMatched = new Set<number>();
    for (const c of candidates) {
      // R6-2 (round-6 cross-family review — the F2 class in PHASE 1): a
      // delivered value that equals or contains '[SECRET n]' text (a legal
      // 8-char single-line value like 'SECRET 2') must never rewrite a REAL
      // handle an earlier, longer candidate inserted ('use [SECRET 2] now'
      // → 'use [[SECRET 1]] now' was the reproduced corruption). Phase 1 is
      // PLACEHOLDER-AWARE: full-value replacement only fires inside RAW
      // segments; placeholder spans are untouchable — same token split as
      // phase 2 and the final sweep. EVERY replacement phase is
      // placeholder-aware (learnings rule).
      const ph = secretDelivery.oqSecretPlaceholder(c.ordinal);
      const tokens = out.split(/(\[SECRET \d+\])/);
      if (!tokens.some((t, i) => i % 2 === 0 && t.includes(c.value))) continue;
      out = tokens.map((t, i) => (i % 2 === 0 ? t.split(c.value).join(ph) : t)).join('');
      fullMatched.add(c.ordinal);
    }
    for (const c of candidates) {
      if (fullMatched.has(c.ordinal)) continue;
      // Fragment: the slot text CONTAINS a leading or trailing slice of the
      // value (a cap-cut slot), or IS one. A2 (round 8 riding): the windows
      // are the module's own ≥8 echo floor (a 24-char payloadLanguage cap
      // can leave as few as 8 value chars).
      // F2 (round-3 follow-up): PLACEHOLDER-AWARE, same token split the
      // final sweep uses — a delivered value whose head-8/tail-8 is the
      // literal text 'SECRET n' must not split a REAL handle inserted by
      // phase 1 ('use [SECRET 2] now' → 'use [[SECRET 1]] now' was the
      // reproduced corruption). A fragment only fires inside a RAW segment;
      // placeholder spans are untouchable.
      const ph = secretDelivery.oqSecretPlaceholder(c.ordinal);
      for (const frag of [c.value.slice(0, 8), c.value.slice(-8)]) {
        if (frag.length < 8) continue;
        const tokens = out.split(/(\[SECRET \d+\])/);
        if (tokens.some((t, i) => i % 2 === 0 && t.includes(frag))) {
          out = tokens
            .map((t, i) => (i % 2 === 0 ? t.split(frag).join(ph) : t))
            .join('');
          break;
        }
      }
    }
    // F1 (round-3 review addendum — the junction-overlap carve) + PA-1
    // (round-5 BLOCK): when two LONGER candidates share a shorter
    // candidate's head AND tail, phase 1's full passes consume the longer
    // occurrences first and CARVE the shorter candidate's occurrence apart
    // before its own pass runs — it misses phase 1, and its phase-2
    // fragment legs (head-8/tail-8 only) cannot match the surviving
    // MIDDLE, so a ≥8-char raw slice of a delivered value rode the stored
    // text. Any ≥8-char window of a delivered value is value material (the
    // module's own echo floor), so a final sweep scrubs ANY surviving
    // window, longest match first. PLACEHOLDER-AWARE: the [SECRET n] spans
    // already inserted are split out as tokens (odd indices) and never
    // rewritten — a marker-shaped candidate can never corrupt a real
    // handle, and a match never spans a placeholder.
    // PA-1: the first cut enumerated EVERY (length, offset) window of every
    // candidate with a whole-text regex split in the innermost loop —
    // O(L²·T), 17 SECONDS on a max-length (8192-char) delivered value with
    // NOTHING echoed, an availability cliff on this public tool path. The
    // sweep is INDEXED instead: an 8-char-window index of the VALUE (built
    // once per candidate, O(L)), a single left-to-right scan of the RAW
    // segments (O(T) lookups), and a bounded extend-at-hit walk to the
    // longest match; replace it and rescan. Nothing-echoed now costs the
    // index build plus T missed lookups; the matched set is identical
    // (longest ≥8 window, per-raw-segment so placeholder spans and
    // straddles never match).
    for (const c of candidates) {
      // Index the value's 8-char windows → start offsets (once per candidate).
      const byWindow = new Map<string, number[]>();
      for (let s = 0; s + 8 <= c.value.length; s++) {
        const w = c.value.slice(s, s + 8);
        const hits = byWindow.get(w);
        if (hits) hits.push(s);
        else byWindow.set(w, [s]);
      }
      if (!byWindow.size) continue;
      const ph = secretDelivery.oqSecretPlaceholder(c.ordinal);
      // R6-1 (round-6 cross-family review — the PA-1 mirror): the previous
      // find-best-then-replace-then-RESCAN loop re-paid the whole
      // (position × offset × extend) scan after EVERY replacement —
      // quadratic exactly when the value carries many repeated 8-windows
      // (a legal 'b' + 'a'×8190 + 'b' delivery against a 2000-char text
      // measured 59,747 ms through the real seam). SINGLE PASS: every raw
      // segment is walked once, left to right; a hit extends to its
      // longest match at that position and is replaced immediately; the
      // scan resumes AFTER the inserted placeholder. Each text position is
      // visited once and every extension is paid at most once per replaced
      // span — worst case O(L + T + starts·T) ≈ 16M char-compares at the
      // documented caps: tens of milliseconds. End-state guarantee
      // unchanged: any ≥8 window of the value still inside a raw run is
      // itself an indexed value-window (closure — substrings of
      // value-windows are value-windows), so the scan must hit it; nothing
      // ≥8 survives, placeholders are never rewritten (odd tokens are
      // skipped), and a match never spans a placeholder.
      const tokens = out.split(/(\[SECRET \d+\])/);
      for (let ti = 0; ti < tokens.length; ti += 2) {
        const tok = tokens[ti];
        let pos = 0;
        let acc = '';
        let matched = false;
        while (pos + 8 <= tok.length) {
          const starts = byWindow.get(tok.slice(pos, pos + 8));
          if (!starts) { pos++; continue; }
          let bestM = 0;
          for (const s of starts) {
            let m = 8;
            while (pos + m < tok.length && s + m < c.value.length && tok[pos + m] === c.value[s + m]) m++;
            if (m > bestM) bestM = m;
          }
          // bestM ≥ 8 always — the map hit guarantees the 8-char window.
          acc += ph;
          pos += bestM;
          matched = true;
        }
        if (matched) tokens[ti] = acc + tok.slice(pos);
      }
      out = tokens.join('');
    }
    return out;
  };
  // R1-4b (round-1 review of 5c024656, probe D3; ticket 91b0f191): the J2
  // class — an agent-authored id riding a RESULT verbatim. `supersedes` (and
  // the refusal text quoting it) is the seam: a scanner-known key passed as
  // the id, or an echo of a delivered value, must never ride the refusal
  // back to the filing agent. echoScrub FIRST (a delivered-value echo still
  // becomes its [SECRET n] reveal handle), then the inbound scan; ordinary
  // ids pass through byte-identical so the refusal stays actionable.
  const safeAgentIdLabel = (id: string): string =>
    redactInboundSecrets(echoScrub(String(id ?? '').trim()));
  const questionSpans: SecretSpan[] = [];
  // Kill switch OFF → the pre-fix destruction marker (no rescue, no store).
  const questionRescue = secretDelivery.buildSpanRescuer(questionSpans, rescueCounter);
  const questionNoteFor = deliveryEnabled ? questionRescue.noteFor : () => '[REDACTED: looked like a credential]';
  // G2 echo-scrub FIRST, then the span pass — an echo is already a numbered
  // handle by the time the scanner sees the text (it cannot be rescued
  // twice), and the QUESTION_MAX slice applies to the final text as before.
  let question = redactInboundSecretsWithNotes(echoScrub(String(input.question ?? '').trim()), questionSpans, questionNoteFor).slice(0, QUESTION_MAX);
  implicitKept.push(...questionRescue.kept);
  const contextSpans: SecretSpan[] = [];
  const contextRescue = secretDelivery.buildSpanRescuer(contextSpans, rescueCounter);
  const contextNoteFor = deliveryEnabled ? contextRescue.noteFor : () => '[REDACTED: looked like a credential]';
  let context = redactInboundSecretsWithNotes(echoScrub(String(input.context ?? '').trim()), contextSpans, contextNoteFor).slice(0, CONTEXT_MAX);
  implicitKept.push(...contextRescue.kept);
  // Review BLOCKING 2 (ticket 26786762 rework): the EXPLICIT deliverSecrets
  // entries take ordinals 1..E — the agent writes "[SECRET 1]" for its first
  // delivered key per the tool doc, and that handle must resolve to THAT key
  // even when the scanner also rescues incidental spans from the text. The
  // implicit-rescue counter starts at E+1 (both next and start), so implicit
  // spans number E+1.. while their shared budget stays per-card.
  if (!question) return { kind: 'refused', refused: 'invalid' };
  // Ticket 1b1c41bc: the console-action ask. Fail-CLOSED: an unusable
  // consoleAction is refused with the reason (never silently degraded to a
  // summary-shaped card). The four elements are composed HERE so every answer
  // surface — card body, Inbox, Telegram DM, wake echo — carries the exact
  // paste-ready payload + click-by-click steps without the filing agent
  // hand-formatting anything.
  // J1 (round 8): the echo scrub runs BEFORE normalize — an echo of a
  // delivered/rescued value in a raw console slot would otherwise hit
  // normalize's own credential refusal (a scanner-known shape) or ride its
  // redaction, never becoming the reveal handle the card text promises.
  // consoleUrl is EXCLUDED here (a scrubbed URL is a broken link — it is
  // refused below when it echoes a candidate).
  const echoScrubRawSlots = (o: Record<string, unknown>): Record<string, unknown> => ({
    ...o,
    ...(typeof o.consoleName === 'string' ? { consoleName: echoScrub(o.consoleName) } : {}),
    ...(typeof o.whatAndWhySafe === 'string' ? { whatAndWhySafe: echoScrub(o.whatAndWhySafe) } : {}),
    ...(typeof o.payload === 'string' ? { payload: echoScrub(o.payload) } : {}),
    ...(typeof o.payloadLanguage === 'string' ? { payloadLanguage: echoScrub(o.payloadLanguage) } : {}),
    ...(Array.isArray(o.steps) ? { steps: o.steps.map((s) => typeof s === 'string' ? echoScrub(s) : s) } : {}),
  });
  const rawConsole = input.consoleAction !== undefined && input.consoleAction !== null
    && typeof input.consoleAction === 'object' && !Array.isArray(input.consoleAction)
    ? echoScrubRawSlots(input.consoleAction as Record<string, unknown>)
    : input.consoleAction;
  const consoleAction = rawConsole !== undefined && rawConsole !== null
    ? normalizeConsoleAction(rawConsole)
    : null;
  if (consoleAction && !consoleAction.ok) {
    // Ticket 1b1c41bc: refuse WITH the reason — the agent must retry with the
    // real content, never fall back to a summary-shaped card.
    return { kind: 'refused', refused: 'invalid', message: `consoleAction invalid: ${consoleAction.error}` };
  }
  const consoleSpec = consoleAction?.ok ? consoleAction.value : null;
  // ── Backlog CA-1 (ticket 1b1c41bc residual): OBSERVE-ONLY intake telemetry ──
  // A card that names a console surface and tells the owner to ACT there, filed
  // WITHOUT a consoleAction spec, renders as an ordinary short card — exactly the
  // 12:26:54Z oq_ea52c6ae shape the structured path exists to prevent. Detection
  // only: nothing is refused, nothing is rewritten (a false positive refusing a
  // legitimate non-console ask would be worse than the sloppy card). The 7-day
  // baseline this accrues is what gates any future enforcement (the 6f8b52b7 /
  // PR #1548 ladder). Runs on the ALREADY redacted + echo-scrubbed question and
  // context — never raw agent input. Kill switch OWNER_CONSOLE_ASK_DETECT_DISABLED=1.
  if (!consoleSpec && process.env[OWNER_CONSOLE_ASK_DETECT_DISABLED_ENV] !== '1') {
    const detected = detectSpeclessConsoleAsk(`${question}\n${context ?? ''}`);
    if (detected.detected) {
      void recordOwnerQuestionMetric('console_ask_specless', {
        chatId: input.chatId, kind: 'flag', surfaces: detected.surfaces, verbs: detected.verbs,
        questionChars: question.length, excerpt: detected.excerpt,
      });
    }
  }
  // Review BLOCKING G2 (round 6) + H5 (round 7): the payload is scrubbed
  // ONCE here — both the composed body and the ROW's stored consoleAction
  // field use this spec (the row's copy feeds the pending surface and the
  // wake echo; the raw payload would leak the value on both).
  // H5 (round 7) extends the scrub to EVERY agent-authored console slot —
  // steps[], whatAndWhySafe, consoleName, payloadLanguage (all scrub AFTER
  // normalize; the fragment-aware echoScrub catches a slot that was sliced
  // to its cap before this point). consoleUrl is different: a scrubbed URL
  // is a broken link, so it REFUSES (matching its existing credential-
  // material refusal) when it echoes a delivered value.
  // H5 (round 7) + J1 (round 8): a consoleUrl echoing a delivered OR
  // implicit-rescued value is REFUSED (a scrubbed URL is a broken link —
  // matching normalizeConsoleAction's existing credential-material refusal).
  const echoCandidatesNow = (): string[] => [
    ...explicitEntries.map((e) => e.value),
    ...implicitKept.map((k) => k.value),
  ];
  if (consoleSpec && echoCandidatesNow().some((v) => v.length >= 8 && consoleSpec.consoleUrl.split(v).length > 1)) {
    return {
      kind: 'refused', refused: 'invalid',
      message: 'consoleAction.consoleUrl echoes a delivered secret — provide the bare console URL, reference the reveal handle (e.g. "[SECRET 1]") in the payload instead',
    };
  }
  const scrubStr = (t: string): string => echoScrub(t);
  const scrubbedSpec = consoleSpec
    ? {
        ...consoleSpec,
        consoleName: scrubStr(consoleSpec.consoleName),
        whatAndWhySafe: scrubStr(consoleSpec.whatAndWhySafe),
        ...(typeof consoleSpec.payload === 'string' ? { payload: scrubStr(consoleSpec.payload) } : {}),
        payloadLanguage: scrubStr(consoleSpec.payloadLanguage ?? 'text'),
        steps: consoleSpec.steps.map(scrubStr),
      }
    : null;
  const questionBudget = consoleSpec ? CONSOLE_ACTION_QUESTION_MAX : QUESTION_MAX;
  if (consoleSpec) {
    // Review finding B-1 (ticket 1b1c41bc): legal maximal specs (payload 6000
    // + why 300 + name/URL caps + 10 steps) can compose a body OVER the
    // budget — and the steps are composed LAST, so a silent slice would cut
    // exactly the click-by-click steps the owner asked for (the ticket's own
    // failure class). Fail CLOSED like every other spec defect: refuse with
    // the sizes so the agent shrinks the payload or steps and retries.
    // 128 chars of headroom covers the [ProjectName] prefix + slack.
    const composed = composeConsoleActionBody(scrubbedSpec!, question);
    if (composed.length > questionBudget - 128) {
      return {
        kind: 'refused', refused: 'invalid',
        message: `consoleAction too large: the composed card body is ${composed.length} chars and the budget is ${questionBudget - 128} (payload ${consoleSpec.payload?.length ?? 0} + ${consoleSpec.steps.length} steps) — shrink the payload or split the steps, never drop them`,
      };
    }
    question = composed.slice(0, questionBudget);
  }
  // Owner 2026-09-18 (cross-project directive pollution): the owner answers
  // questions from the account-wide inbox, where a question about "the Nebius
  // nodes" from CanLaw read exactly like one from the inference project — his
  // inference-project ruling was then applied to CanLaw. Every question filed
  // from a project chat now names its project in its FIRST characters, so the
  // card, the Telegram DM and the fleet board all carry the scope. Best-effort:
  // a read failure files the question unprefixed, as before.
  try {
    const chat: any = await (prisma as any).crossModelChat?.findUnique?.({
      where: { id: input.chatId },
      select: { project: { select: { name: true } } },
    });
    const projectName = typeof chat?.project?.name === 'string' ? chat.project.name.trim().replace(/[\[\]]/g, '') : '';
    if (projectName && !question.toLowerCase().startsWith(`[${projectName.toLowerCase()}]`)) {
      question = `[${projectName}] ${question}`.slice(0, questionBudget);
    }
  } catch { /* scope prefix is best-effort */ }

  // Cost-of-delay + default answer (P7 S2b): validate independently, but the
  // auto-answer only ever arms when BOTH defaultAfterDays and defaultOption
  // survive validation (applyDefaultAnswerIfDue re-checks the pair too).
  const idleUsdPerDay =
    typeof input.idleUsdPerDay === 'number' && Number.isFinite(input.idleUsdPerDay) && input.idleUsdPerDay > 0
      ? Math.min(input.idleUsdPerDay, 1_000_000)
      : null;
  const defaultAfterDaysRaw = Math.round(Number(input.defaultAfterDays));
  // Ticket 50bcd1e7 (review F1): defaultOption is AGENT-AUTHORED (the flag
  // tool's own preset), and the auto-answer sweep later stores it as a row
  // answer — the inbound redaction that guards question/context must guard it
  // too, or an agent-authored credential-shaped preset rides into storage
  // unredacted and the sweeper-(b) replay could vault it with owner
  // provenance. Redact BEFORE validation (a REDACTED note can never be a
  // usable option label, which is exactly right: preset defaults are choices
  // the owner should recognize, never secrets).
  // Review BLOCKING G2 (round 6) + J1 (round 8): the preset default is
  // AGENT-AUTHORED and later stored as a row answer with owner provenance.
  // echoScrub FIRST (an implicit-rescued span must become its handle, not
  // hit the scan's destruction marker), then the inbound scan for any other
  // credential material.
  const defaultOptionRaw = redactInboundSecrets(echoScrub(String(input.defaultOption ?? '').trim())).slice(0, OPTION_LABEL_MAX);
  let defaultAfterDays: number | null =
    Number.isFinite(defaultAfterDaysRaw) && defaultAfterDaysRaw >= 1 && defaultAfterDaysRaw <= 90 && defaultOptionRaw
      ? defaultAfterDaysRaw
      : null;
  let defaultOption: string | null = defaultAfterDays !== null ? defaultOptionRaw : null;

  // Typed options (N3): normalize; a question packing >1 decision with NO
  // options is refused with a split nudge (the cheap two-decision heuristic).
  // Ticket 1b1c41bc: a console-action ask carries numbered click-by-click
  // STEPS in its composed body — the heuristic would refuse it as a
  // multi-decision — and its decision is one (did you save it?), so the
  // harness injects the saved/error/defer options when the flagger supplied
  // none. The agent's own options (when supplied) always win.
  // Review BLOCKING G2 (round 6) + H5 (round 7): option labels/consequences
  // AND option ids are AGENT-AUTHORED, stored on the row and rendered on
  // the card and the Telegram DM — scrub an echo of a delivered value (the
  // inbound scan never sees scanner-unknown shapes). The id is capped at 40
  // chars INSIDE normalizeOwnerQuestionOptions, so the scrub runs on the
  // RAW id BEFORE that slice (the fragment guard catches a sliced echo).
  // Ticket 5c024656 (round-9 F2): option label/consequence AND option id are
  // agent-authored and ride the stored row onto every broadcast surface
  // (Inbox card, Telegram DM, fleet board, wake echo). #1679's echoScrub
  // covers only an ECHO of a delivered/rescued value — a RAW scanner-known
  // credential in one of these slots with no delivery rode through
  // untouched (live-probed by the round-9 review at e1752b04d). Same wrap
  // as defaultOption above (line ~1160): echoScrub FIRST (a delivered-value
  // echo still becomes its [SECRET n] reveal handle), then the inbound scan
  // destroys any remaining raw credential material. The id is scanned on
  // the RAW text BEFORE normalizeOwnerQuestionOptions' 40-char slice (the
  // H5 fragment rule — a cap-cut id must not smuggle a value fragment).
  // R1-2 state: ids are deduped inside normalizeOwnerQuestionOptions on the
  // FINAL id — but two DIFFERENT raw ids (each carrying its own credential)
  // redact to the SAME marker, and that dedupe would silently drop the
  // second option (the owner loses a choice; review K1: opts(1), "Second"
  // gone from the row AND the DM). Disambiguate here, BEFORE normalize's
  // 40-char slice, keyed on the RAW id: identical raw ids keep the
  // long-standing duplicate-id dedupe contract (pinned by the P2 suite);
  // distinct raw ids that collide post-redaction get a -2/-3… suffix.
  const rawIdToRedacted = new Map<string, string>();
  const emittedOptionIds = new Set<string>();
  const disambiguateRedactedId = (rawId: string, redacted: string): string => {
    const prev = rawIdToRedacted.get(rawId);
    if (prev !== undefined) return prev; // same raw id twice → normalize dedupes
    let id = redacted;
    if (id && emittedOptionIds.has(id)) {
      for (let n = 2; n <= 9; n++) {
        const suffix = `-${n}`;
        const candidate = id.slice(0, 40 - suffix.length) + suffix;
        if (!emittedOptionIds.has(candidate)) { id = candidate; break; }
        id = candidate; // keep the last candidate; ≤6 options can never exhaust n≤9
      }
    }
    rawIdToRedacted.set(rawId, id);
    emittedOptionIds.add(id);
    return id;
  };
  let options = normalizeOwnerQuestionOptions(
    Array.isArray(input.options)
      ? input.options.map((o: any) => {
        // R1-1 (round-1 review): the typeof === 'string' guards let a
        // non-string slot value (array/number form from a tool call's
        // JSON.parse — agent.ts:1189 does no schema validation) bypass BOTH
        // the echo scrub and the inbound scan; normalizeOwnerQuestionOptions'
        // own String() then wrote the raw credential onto the row and every
        // broadcast surface. Coerce BEFORE the wrap so every present slot
        // value goes through both layers.
        if (!o || typeof o !== 'object') return o;
        const next: any = { ...o };
        if (o.label != null) next.label = redactInboundSecrets(echoScrub(String(o.label)));
        if (o.consequence != null) next.consequence = redactInboundSecrets(echoScrub(String(o.consequence)));
        if (o.id != null) next.id = disambiguateRedactedId(String(o.id), redactInboundSecrets(echoScrub(String(o.id))));
        return next;
      })
      : input.options,
  );
  if (!options && consoleSpec) {
    options = normalizeOwnerQuestionOptions(CONSOLE_ACTION_DEFAULT_OPTIONS.map((o) => ({ ...o })));
  }
  if (!options && looksLikeMultiDecisionQuestion(question)) {
    return { kind: 'refused', refused: 'multi_decision' };
  }

  // Todo 77c88942 item 2: the declared answer type. 'credential' (any shape)
  // is an OWNER-ONLY class — a supervisor can never answer it (there is no
  // text answer at all), and the answer surfaces must render the expected
  // shape. Unparseable values degrade to null (legacy free-text), never an
  // error: an old caller's junk is not worth a refused flag.
  const expected = parseExpectedAnswerType(input.expectedAnswerType, question);
  if (expected.type === 'choice' && !options) {
    // 'choice' without typed options is meaningless — degrade to free.
    expected.type = null;
  }

  // ── Todo fea78360 (monitor lesson 6): replacement-card resolution ─────────
  // One decision, one live card. The flagger may NAME the open card this one
  // replaces (supersedes: full oq_ id or ≥8-char prefix, owner-scoped,
  // fail-closed on an unresolvable id). A DECLARED replacement must file —
  // every dedupe layer below YIELDS to it (the flagger explicitly wants a
  // new card, not a fold-into-the-old-one) — so the resolution runs BEFORE
  // the dedupe. The kill switch drops the param (the card then dedupes like
  // any unlinked successor). The linkage itself (supersededBy + auto-dismiss
  // of the OPEN predecessor) runs post-create.
  let supersedesId: string | null = null;
  let supersedesTargetWasOpen = false;
  let supersedesTargetQuestion: string | null = null;
  // f3a69ed3 defect 2: the owner's recorded reply on the card being
  // replaced, parsed off its answer column at resolution time.
  let supersedesTargetReply: ParsedOwnerRecordedReply | null = null;
  const supersedesRaw = String(input.supersedes ?? '').trim();
  // fea78360: DECLARED means the flagger passed supersedes at all — it yields
  // past every dedupe layer (an intentional new card, not a re-ask) whether
  // or not the kill switch then drops the LINKAGE. The switch's emergency is
  // the auto-dismiss mechanics, never the flagger's filed-a-new-card intent.
  const supersedesDeclared = !!supersedesRaw;
  if (supersedesRaw && ownerCardSupersedesDisabled()) {
    void logOwnerQuestions('warn', `owner-questions: supersedes ${supersedesRaw.slice(0, 11)} dropped (OWNER_CARD_SUPERSEDES_DISABLED=1) — card files unlinked`);
  } else if (supersedesRaw) {
    // Resolve the named predecessor: owner-scoped findUnique on a full id,
    // prefix scan (≥8 chars) otherwise. Fail-CLOSED: an id that resolves to
    // nothing (or another owner's card) refuses the flag — the agent cited a
    // card that does not exist, exactly the phantom-id class the tool docs
    // already warn about. A non-open predecessor still LINKS (the chain
    // history is real) but is not dismissed again.
    try {
      let target: any = null;
      if (/^oq_[0-9a-f-]{36}$/i.test(supersedesRaw)) {
        target = await prisma.ownerQuestion.findUnique({ where: { id: supersedesRaw } });
      } else if (supersedesRaw.length >= 8) {
        const candidates = await prisma.ownerQuestion.findMany({
          where: { userId: input.userId, id: { startsWith: supersedesRaw } },
          orderBy: { createdAt: 'desc' },
          take: 5,
        });
        // An ambiguous prefix (2+ of the owner's cards) REFUSES — never pick.
        target = candidates.length === 1 ? candidates[0] : null;
      }
      if (!target || target.userId !== input.userId) {
        return {
          kind: 'refused', refused: 'invalid',
          // R1-4b (probe D3, the J2 class): never interpolate the RAW id —
          // a scanner-known key (or an echo of a delivered value) passed as
          // supersedes would ride the refusal result verbatim back to the
          // filing agent. safeAgentIdLabel: echoScrub FIRST (an echo becomes
          // its [SECRET n] reveal handle), then the inbound scan (remaining
          // material degrades to the destruction marker). Ordinary
          // unresolvable ids pass byte-identical — the refusal stays
          // actionable.
          message: `supersedes "${safeAgentIdLabel(supersedesRaw)}" does not resolve to one of your owner cards — pass the full oq_ id (or a ≥8-char prefix that matches exactly one card) from list_owner_questions, or omit supersedes`,
        };
      }
      supersedesId = target.id;
      supersedesTargetWasOpen = target.status === 'open';
      supersedesTargetQuestion = String(target.question ?? '');
      // Ticket f3a69ed3 (defect 2): a replacement must visibly CARRY the
      // owner's reply on the card it replaces — before, the auto-dismiss of
      // the predecessor hid the reply entirely (the oq_510a512a specimen:
      // the owner's instruction vanished when a replacement superseded the
      // card he had answered). Captured here (owner-origin only, the
      // structured block preferred, legacy mismatch records folded too) and
      // appended to the new card's question at create time.
      supersedesTargetReply = target.status === 'open' && target.answer
        ? parseOwnerRecordedReply(target.answer)
        : null;
    } catch (err: any) {
      // A read hiccup must not eat the flag: degrade to unlinked (the
      // observe-only chain metric still records the gap).
      void logOwnerQuestions('warn', `owner-questions: supersedes resolution failed (${err?.message ?? err}) — card files unlinked`);
      supersedesId = null;
    }
  }

  // Dedup: the SAME question already open on this chat → return the existing
  // row (a repeat sighting is not a new inbox item).
  // Todo fea78360 (monitor lesson 6): the dedupe is DECISION-LEVEL — the
  // comparison runs on the normalized decision text (project prefix +
  // boilerplate stripped, so a reworded re-ask still dedupes), and the new
  // flag's context is APPENDED to the open card instead of dropped (the
  // owner sees one card with everything, not a second card under the first).
  // A DECLARED replacement (supersedes) yields past every dedupe layer — it
  // is an intentional new card.
  // Ticket 26786762: a card carrying DELIVERED CREDENTIALS yields the same
  // way — a dedupe would fold it into an existing card and silently drop the
  // value (the placeholder handles would 404 on the old card's reveal). A
  // delivery is intentional content; the rate cap and open cap still apply.
  const carriesSecrets = implicitKept.length > 0 || explicitEntries.length > 0;

  // ── OWNER-INTERRUPT-ECONOMY (2026-10-20): owner-only class + recall ───────
  // ONE owner-only interrupt verdict (the owner's 2026-10-20 rule: money,
  // credentials, irreversible / destructive, external commitments, plus the
  // routing classes — physically-human, cross-project scope, another-account
  // security) drives "DM at once", "never auto-default" and "never refuse as
  // already decided" below. It never changes triage or answer authority. The
  // economy module is a lazy import (it reads this module statically); when
  // it cannot load, every leg degrades to today's behaviour.
  let economy: typeof import('./owner-interrupt-economy') | null = null;
  try { economy = await import('./owner-interrupt-economy'); } catch { economy = null; }
  let ownerOnlyReason: string | null = null;
  if (economy) {
    try {
      ownerOnlyReason = economy.ownerOnlyInterruptReason(question, context, {
        credentialGate: expected.type === 'credential', consoleAction: !!consoleSpec, carriesSecrets,
      });
      if (!ownerOnlyReason && await questionNamesAnotherOwnerProject(prisma, input, `${question}\n${context}`)) {
        ownerOnlyReason = 'cross_project_scope';
      }
    } catch {
      ownerOnlyReason = 'classifier_error'; // fail toward the owner (sent at once, never defaulted)
    }
  }
  trace.ownerOnlyReason = ownerOnlyReason;

  // Prior-decision recall (90 d, isSameDecisionQuestion): a decision the OWNER
  // already made is never silently re-asked. A MACHINE re-ask that is a STRICT
  // same-decision match outside the owner-only classes is refused citing the
  // answer (owner rule: strict match only; revisitReason is the escape hatch);
  // every other match files ANNOTATED — "you decided this on <date>" on the
  // question text plus a "Same as before" reply the answer path expands. A
  // declared replacement, a credential delivery, a console action and a
  // credential gate skip it (intentional new content / per-event asks). A
  // HARNESS per-event card (harnessEventAt) whose event postdates the owner's
  // decision is annotated, never refused — its callers ignore a refusal (r3
  // interactions finding 3: a re-paused schedule was left with no card). A
  // lookup failure files the card unannotated (fail toward delivery).
  // Kill switch OWNER_PRIOR_DECISION_RECALL_DISABLED=1.
  let priorMatch: import('./owner-interrupt-economy').PriorDecisionMatch | null = null;
  if (economy && !economy.ownerPriorDecisionRecallDisabled() && !supersedesDeclared && !carriesSecrets && !consoleSpec && expected.type !== 'credential') {
    try {
      priorMatch = await economy.findPriorOwnerDecision(prisma, { chatId: input.chatId, userId: input.userId }, question);
    } catch (err: any) {
      priorMatch = null;
      void logOwnerQuestions('warn', `owner-questions: prior-decision recall lookup failed (card files unannotated): ${err?.message ?? err}`);
    }
  }
  if (economy && priorMatch) {
    const revisit = redactInboundSecrets(echoScrub(String(input.revisitReason ?? '').trim())).slice(0, 600);
    trace.priorQuestionId = priorMatch.row.id;
    trace.priorStrict = priorMatch.strict;
    const eventMs = input.harnessEventAt != null ? new Date(input.harnessEventAt).getTime() : NaN;
    const decidedMs = new Date(priorMatch.row.resolvedAt ?? NaN).getTime();
    // An unreadable decision time reads as "before the event" (fail toward delivery).
    const harnessEventAfterDecision = Number.isFinite(eventMs) && !(eventMs <= decidedMs);
    if (input.machineTriggered === true && priorMatch.strict && !ownerOnlyReason && !revisit && !harnessEventAfterDecision) {
      trace.priorRecall = 'refused';
      return {
        kind: 'refused', refused: 'previously_decided', prior: priorMatch.row as OwnerQuestionView,
        decidedOn: priorMatch.decidedOn, message: economy.priorDecisionRefusalMessage(priorMatch),
      };
    }
    // Review 2026-10-20: the note is fitted WITHOUT silently cutting the new
    // question (compact note first; an explicit truncation marker last), and
    // a typed gate gets "Same as before" only when the prior decision
    // satisfies it (mapped by option LABEL, never by id / position).
    question = economy.annotateQuestionWithPriorDecision(question, priorMatch, { budget: questionBudget, ownerOnlyReason });
    options = economy.withPriorDecisionOption(options, priorMatch, { expectedType: expected.type });
    if (revisit) {
      context = prependOwnerCardContextLine(context, `[What changed since the prior decision] ${revisit}`);
      // The owner-only verdict reads the SAME text the apply-time re-check
      // will read (review 2026-10-20: a revisitReason naming "$5/day" made the
      // armed reversible default refuse forever at 24 h). Only ever widens.
      if (!ownerOnlyReason) {
        try {
          ownerOnlyReason = economy.ownerOnlyInterruptReason(question, context, {
            credentialGate: expected.type === 'credential', consoleAction: !!consoleSpec, carriesSecrets,
          });
        } catch { ownerOnlyReason = 'classifier_error'; }
        trace.ownerOnlyReason = ownerOnlyReason;
      }
    }
    trace.priorRecall = 'annotated';
  }

  const normalizeDecisionText = (s: string): string => {
    let out = stripPriorDecisionAnnotation(String(s ?? ''));
    out = out.replace(/^\[[^\]]*\]\s*/, ''); // the [ProjectName] scope prefix
    return out.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  };
  const existingOpen = (supersedesDeclared || carriesSecrets)
    ? null
    : await prisma.ownerQuestion.findFirst({
        where: { chatId: input.chatId, question, status: 'open' },
      });
  if (existingOpen) {
    // fea78360: APPEND the new context (budget-trimmed, newest first) to the
    // existing card instead of silently dropping it. Best-effort — a failed
    // append degrades to the pre-fix dedupe (row returned, context dropped).
    let appended = false;
    const addition = context.trim();
    if (addition && ownerCardAppendContextDisabled() !== true) {
      try {
        const current = String(existingOpen.context ?? '');
        // Trim to budget: the addition FIRST (newest content), then as much
        // of the existing context as fits (the head of `current` holds the
        // most recent prior append — keep the head, drop the oldest tail).
        if (!current.includes(addition)) {
          const room = Math.max(0, CONTEXT_MAX - addition.length - 2);
          const keptOld = current.slice(0, room);
          const nextContext = `${addition}\n${keptOld}`.slice(0, CONTEXT_MAX);
          const flip = await prisma.ownerQuestion.updateMany({
            where: { id: existingOpen.id, status: 'open' },
            data: { context: nextContext },
          });
          appended = flip.count > 0;
        }
      } catch { /* best-effort — the dedupe verdict stands */ }
    }
    return { kind: 'deduped', question: existingOpen, ...(appended ? { appended: true } : {}) };
  }
  // fea78360 decision-level dedupe (beyond exact text): an OPEN question on
  // this chat that is the SAME DECISION reworded (normalized-text equality,
  // or the topic-dedupe predicate) also dedupes + appends — one decision,
  // one live card. The exact-text row was already checked above; this scan
  // catches reworded re-asks. A DECLARED replacement (supersedes) yields —
  // it is an intentional new card, not a re-ask.
  if (ownerCardAppendContextDisabled() !== true && !supersedesDeclared && !carriesSecrets) {
    try {
      const openRows = await prisma.ownerQuestion.findMany({
        where: { chatId: input.chatId, status: 'open' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      const normalizedNew = normalizeDecisionText(question);
      const sameDecision = (openRows ?? []).find((row: any) => {
        // (a) UNIVERSAL: the same decision text modulo case/punctuation and
        // the [Project] scope prefix — the exact-dedupe layer in normalized
        // form (the todo: dedupe on the normalized DECISION, not the raw
        // string).
        if (normalizeDecisionText(row.question) === normalizedNew) return true;
        // (b) MACHINE-ONLY: the N8 topic predicate (reworded re-asks) — a
        // user-anchored re-ask still CREATES (a human may re-ask
        // deliberately; the pinned N8 / b8bdc0e2 / SA0906 contracts).
        if (input.machineTriggered === true && questionTopicDedupeMatch(row.question, question)) return true;
        return false;
      });
      if (sameDecision) {
        let appended = false;
        const addition = context.trim();
        if (addition) {
          try {
            const current = String(sameDecision.context ?? '');
            if (!current.includes(addition)) {
              const room = Math.max(0, CONTEXT_MAX - addition.length - 2);
              const keptOld = current.slice(0, room);
              const nextContext = `${addition}\n${keptOld}`.slice(0, CONTEXT_MAX);
              const flip = await prisma.ownerQuestion.updateMany({
                where: { id: sameDecision.id, status: 'open' },
                data: { context: nextContext },
              });
              appended = flip.count > 0;
            }
          } catch { /* best-effort */ }
        }
        return { kind: 'deduped', question: sameDecision, ...(appended ? { appended: true } : {}) };
      }
    } catch { /* decision dedupe is best-effort — never blocks a legitimate flag */ }
  }

  // ── Machine-ask preflight (N8) — machine-triggered contexts only ──────────
  // fea78360: a DECLARED replacement (supersedes) yields past the topic
  // dedupe too — the flagger explicitly wants the new card.
  if (input.machineTriggered === true && !supersedesDeclared && !carriesSecrets) {
    // Topic dedupe: an OPEN question on the same chat covering the same topic
    // (normalized-token overlap ≥ 0.6) — return the existing row instead of a
    // near-duplicate. Fail-open on any read hiccup.
    try {
      const open = await prisma.ownerQuestion.findMany({
        where: { chatId: input.chatId, userId: input.userId, status: 'open' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      const topical = (open ?? []).find((row: any) => questionTopicDedupeMatch(row.question, question));
      if (topical) return { kind: 'deduped', question: topical };
    } catch { /* preflight is best-effort — never blocks a legitimate flag */ }
    // Answered-scan: the last 10 ANSWERED questions for the same project (or
    // chat, when the chat is ungrouped) — a same-topic answer that said
    // stop-asking / proceed refuses the re-ask, citing it.
    try {
      const chatRow = await (prisma as any).crossModelChat?.findUnique?.({
        where: { id: input.chatId }, select: { projectId: true },
      }).catch(() => null);
      const projectId: string | null = chatRow?.projectId ?? null;
      let answered: any[] | null = null;
      if (projectId) {
        const projectChats = await (prisma as any).crossModelChat?.findMany?.({
          where: { projectId, userId: input.userId }, select: { id: true }, take: 100,
        }).catch(() => null);
        if (Array.isArray(projectChats) && projectChats.length) {
          answered = await prisma.ownerQuestion.findMany({
            where: { userId: input.userId, status: 'answered', chatId: { in: projectChats.map((c: any) => c.id) } },
            orderBy: { resolvedAt: 'desc' },
            take: 10,
          });
        }
      }
      if (!answered) {
        answered = await prisma.ownerQuestion.findMany({
          where: { chatId: input.chatId, userId: input.userId, status: 'answered' },
          orderBy: { resolvedAt: 'desc' },
          take: 10,
        });
      }
      const prior = (answered ?? []).find(
        (row: any) =>
          questionTopicOverlap(row.question, question) >= TOPIC_OVERLAP_THRESHOLD &&
          STOP_ASKING_ANSWER_RE.test(String(row.answer ?? '')),
      );
      if (prior) return { kind: 'refused', refused: 'previously_answered', prior };
    } catch { /* preflight is best-effort */ }
  }

  // Cooldown: the owner DISMISSED this exact question within 24h — stop
  // raising it (the dismiss transcript note says the same to the agent).
  // fea78360: a SUPERSEDED card (auto-dismissed by its replacement) does not
  // poison the cooldown — the cooldown guards the OWNER's "stop raising it",
  // and a system dismissal must never masquerade as the owner's ruling.
  // OWNER-DISMISS-RAILS (2026-10-20): a SUPERVISOR's dismissal of an
  // owner-only class card does not arm the cooldown — only the owner rules
  // those, so the lane may raise it to the owner again
  // (supervisorDismissalArmsCooldown; kill switch
  // OWNER_DISMISS_RAILS_DISABLED=1 restores the any-dismissal cooldown). A
  // supervisor's dismissal of a TRIAGED card (supervisor route) still arms it
  // — review fix: exempting those let a lane re-file the same moot question
  // every firing, each one a fresh triage wake.
  const recentDismissals = await prisma.ownerQuestion.findMany({
    where: {
      chatId: input.chatId,
      question,
      status: 'dismissed',
      supersededBy: null,
      resolvedAt: { gte: new Date(Date.now() - DISMISSED_COOLDOWN_MS) },
    },
    take: 5,
  });
  const recentlyDismissed = recentDismissals.find((r: any) => supervisorDismissalArmsCooldown(r)) ?? null;
  if (recentlyDismissed) {
    // abca56ce: name the actor — a supervisor/agent dismissal inside the
    // cooldown must not read as the owner's "stop raising it" ruling.
    const by = (recentlyDismissed as any).dismissedBy ?? 'owner';
    const byText = by === 'owner' ? 'the owner' : by === 'supervisor' ? (ownerDismissRailsDisabled() ? 'the Fleet Supervisor (on the owner\'s behalf)' : 'a supervisor (on the owner\'s behalf)') : by === 'agent' ? 'the filing chat' : 'the system (superseded)';
    return { kind: 'refused', refused: 'dismissed_recently', message: `${byText} dismissed this topic recently — do not re-raise it; act on what you have` };
  }

  // Per-chat open cap. fea78360: a DECLARED replacement that resolved to an
  // OPEN card WAIVES the cap — the filing itself frees the slot (the old card
  // is auto-dismissed), so a chat at cap can still replace, exactly the
  // pile-up case the contract targets. The hourly rate cap still bounds the
  // filing rate.
  const openCount = await prisma.ownerQuestion.count({
    where: { chatId: input.chatId, status: 'open' },
  });
  const openCapWaived = !!(supersedesId && supersedesTargetWasOpen);
  if (openCount >= OWNER_QUESTION_OPEN_CAP && !openCapWaived) return { kind: 'refused', refused: 'cap' };

  // Per-session hourly rate cap (file_feedback's session-cap mechanism).
  const hourCount = await prisma.ownerQuestion.count({
    where: { chatId: input.chatId, createdAt: { gte: new Date(Date.now() - 3600_000) } },
  });
  if (hourCount >= OWNER_QUESTION_RATE_CAP_PER_HOUR) return { kind: 'refused', refused: 'cap' };

  // Lane linkage (v1#5): forChatId is stored only when it names a DIFFERENT
  // chat of the SAME owner — a foreign/unknown id is dropped (logged), never
  // an error (linkage is an enhancement, not a gate). Best-effort probe: an
  // unavailable client shape (unit mocks) keeps the caller-supplied id.
  // R1-4a (round-1 review of 5c024656, probe D1; ticket 91b0f191): the same
  // inbound wrap every other agent-authored linkage slot got in #1682 —
  // echoScrub FIRST (a delivered-value echo becomes its [SECRET n] reveal
  // handle), then the inbound scan (a scanner-known key degrades to the
  // destruction marker instead of riding the stored row). Hardening only:
  // production drops unknown/foreign ids today, so no live row ever carried
  // a raw key here — this closes the kept-id leg (same-owner chat ids are
  // uuids and pass byte-identical; the probe keeps scanning the SCRUBBED id,
  // which for a uuid is the identical string).
  let forChatId = redactInboundSecrets(echoScrub(String(input.forChatId ?? '').trim())) || null;
  if (forChatId === input.chatId) forChatId = null; // self-link is meaningless — chatId already wakes
  if (forChatId) {
    try {
      const target = await (prisma as any).crossModelChat?.findUnique?.({
        where: { id: forChatId }, select: { userId: true },
      });
      if (target !== undefined && (!target || target.userId !== input.userId)) {
        void logOwnerQuestions('warn', `owner-questions: forChatId ${forChatId.slice(0, 8)} dropped (unknown or foreign chat)`);
        forChatId = null;
      }
    } catch { /* keep the id — the wake path is itself best-effort */ }
  }

  // ── Todo fea78360 (monitor lesson 6): observe-only contract metrics ────────
  // (never a refusal, never a rewrite). Both ride recordOwnerQuestionMetric
  // (dynamic import, never throws). META-LEADING keys per the
  // TELEMETRY_META_CHARS truncation rule. The supersedesId + forChatId
  // context comes from the resolution/validation above.
  if (!ownerCardContractDisabled()) {
    // (a) Payload completeness — only for cards the flagger authored (a
    // consoleAction card is complete by construction).
    const missing = detectOwnerCardPayloadGaps({
      question, context: context || null,
      options: options ?? undefined, consoleAction: !!consoleSpec,
      // Ticket 90a5b127: the flagger's own typed declaration + the declared
      // answer type ride the SAME write-time admission (one definition, two
      // enforcement points) — a card declared optional, or declared yes_no,
      // is complete on the options axis by declaration, not wording.
      optionalAsk: input.optionalAsk === true ? true : input.optionalAsk === false ? false : null,
      expectedAnswerType: expected.type === 'credential' ? `credential:${expected.envKey}` : expected.type || null,
    });
    if (missing.length) {
      void recordOwnerQuestionMetric('owner_card_payload_incomplete', {
        chatId: input.chatId, kind: 'flag', missing, questionChars: question.length,
      });
    }
    // (b) Chain linkage — is there a same-decision predecessor in the union
    // scope (same chat, forChatId either direction, goal, todo) this card
    // replaces without naming it? OPEN predecessors any age; resolved
    // (answered/dismissed) within 72h — older resolved cards are history,
    // not a live chain.
    try {
      const scope = ownerCardChainScope({ chatId: input.chatId, forChatId, goalId: String(input.goalId ?? '').trim() || null, todoId: String(input.todoId ?? '').trim() || null });
      const chatIds: string[] = [];
      for (const s of scope) {
        if (s.scope === 'chat' || s.scope === 'forChat') chatIds.push(s.id);
      }
      const cut = new Date(Date.now() - 72 * 3600_000);
      const candidates: any[] = [];
      const seen = new Set<string>();
      const pushCandidates = (rows: any[]) => {
        for (const row of rows ?? []) {
          if (!seen.has(row.id)) { seen.add(row.id); candidates.push(row); }
        }
      };
      // OPEN predecessors any age; resolved (answered/dismissed) within 72h —
      // older resolved cards are history, not a live chain (both real ACL-chain
      // transitions were answered→new: oq_ea52c6ae answered 12:26Z →
      // oq_9396afac 13:26Z; oq_9396afac answered 13:26Z → oq_19ab7b6b 14:25Z).
      const liveOrRecent = {
        OR: [
          { status: 'open' },
          { status: { not: 'open' }, resolvedAt: { gte: cut } },
        ],
      };
      if (chatIds.length) {
        // Forward leg: predecessors FILED on this chat / the linked chat.
        pushCandidates(await prisma.ownerQuestion.findMany({
          where: { userId: input.userId, ...liveOrRecent, chatId: { in: chatIds } },
          orderBy: { createdAt: 'desc' }, take: 30,
        }));
        // REVERSE leg — the REAL incident shape: predecessors filed on OTHER
        // chats whose forChatId points INTO this scope. oq_ea52c6ae /
        // oq_9396afac were filed on c0e22e36 with forChatId=99e63f86 while
        // the successor (oq_19ab7b6b) was filed ON 99e63f86 — invisible to
        // the filed-on leg, caught here. (A same-chat successor never reaches
        // this scan: the decision-level dedupe folds it into the open card.)
        pushCandidates(await prisma.ownerQuestion.findMany({
          where: { userId: input.userId, ...liveOrRecent, forChatId: { in: chatIds } },
          orderBy: { createdAt: 'desc' }, take: 30,
        }));
      }
      for (const s of scope) {
        if (s.scope === 'goal' || s.scope === 'todo') {
          pushCandidates(await prisma.ownerQuestion.findMany({
            where: {
              userId: input.userId,
              OR: [
                { status: 'open' },
                { status: { not: 'open' }, resolvedAt: { gte: cut } },
              ],
              ...(s.scope === 'goal' ? { goalId: s.id } : { todoId: s.id }),
            },
            orderBy: { createdAt: 'desc' }, take: 30,
          }));
        }
      }
      const predecessor = (candidates ?? []).find(
        (row: any) => row.id !== supersedesId && ownerCardChainMatch(row, { question }),
      );
      if (predecessor) {
        // The successor DID name a predecessor → the chain is linked (no
        // unlinked row). It did NOT → record the gap, even when supersedesId
        // named a DIFFERENT card (a named-but-wrong link is still unlinked
        // to the actual predecessor; the metric carries both ids).
        void recordOwnerQuestionMetric('owner_card_chain_unlinked', {
          chatId: input.chatId, kind: 'flag', predecessorId: predecessor.id,
          linked: false, scope: scope.map((s) => s.scope).join('+'),
        });
      } else if (supersedesId && supersedesTargetQuestion) {
        // Named + no other same-decision candidate: the chain is linked —
        // but the HEALTHY number only counts a link whose predecessor is the
        // SAME decision (a resolvable-but-wrong id is a bad link, not a
        // healthy one: record it as unlinked with both ids so the baseline
        // can tell them apart). Polarity note: this kind records BOTH
        // polarities — meta.linked=false is the contract violation (an
        // unlinked successor), meta.linked=true the healthy counterpart.
        const namedMatches = ownerCardChainMatch({ question: supersedesTargetQuestion }, { question });
        void recordOwnerQuestionMetric('owner_card_chain_unlinked', {
          chatId: input.chatId, kind: 'flag', predecessorId: supersedesId,
          linked: namedMatches, matched: namedMatches, scope: 'supersedes',
        });
      }
    } catch { /* chain observation is best-effort — telemetry never blocks the flag */ }
  }

  // Review 2026-09-13 issue 11: supervisor-first triage. TRIAGE when the flag
  // is machine-triggered AND the filing chat is positively a NON-supervisor
  // chat AND the question is not owner-only. The
  // chat probe must SAY isSupervisor:false — an unknown chat or an unavailable
  // client shape (unit mocks) keeps legacy routing (straight to the owner):
  // fail toward the owner, never toward a silent hold.
  let triage: 'supervisor' | null = null;
  let triageUntil: Date | null = null;
  let triageReason: OwnerQuestionRoutingReason | null = null;
  if (input.machineTriggered === true) {
    let routing = classifyOwnerQuestionRouting(question, context);
    // Todo 77c88942 item 2: a credential ask is OWNER-ONLY — there is no text
    // answer a supervisor could give, and the owner's paste must land in the
    // vault (store_secret / the card's key field / the Account UI — the stored
    // state credentialLifted() checks). Never triaged.
    if (routing.route === 'supervisor' && expected.type === 'credential') {
      routing = { route: 'owner', reason: 'credentials' };
    }
    // Ticket 1b1c41bc: a console-action ask is PHYSICALLY HUMAN — the owner
    // must click through an external console nobody else can drive. Never
    // triaged; the SLA hold is exactly the stall this ticket exists to end.
    if (routing.route === 'supervisor' && consoleSpec) {
      routing = { route: 'owner', reason: 'physically_human' };
    }
    // Ticket b32e0da5 (N2): the pure regex can't class a bare project name —
    // the roster-backed check catches "…apply to CanLaw?" / "…bind CanLaw
    // too?" / "Should the inference project follow it?" and upgrades the
    // route to owner with the same cross_project_scope reason.
    if (routing.route === 'supervisor' &&
        await questionNamesAnotherOwnerProject(prisma, input, `${stripPriorDecisionAnnotation(question)}\n${context}`)) {
      routing = { route: 'owner', reason: 'cross_project_scope' };
    }
    // Ticket 26786762: a card carrying DELIVERED CREDENTIALS is
    // owner-directed content — its whole purpose is the owner revealing the
    // value. A supervisor first-responder has no answer to give (the value
    // is not theirs to read) and the triage SLA would only delay the
    // delivery. Never triaged.
    if (routing.route === 'supervisor' && carriesSecrets) {
      routing = { route: 'owner', reason: 'credentials' };
    }
    // Ticket 1a56f816 (2026-10-30): the PAYLOAD leg. The regex allowlist reads
    // the question's PROSE; it never reads the card's own typed OPTIONS, and
    // the specimen (oq_3c246863) carried no prose cue at all — "run these sudo
    // commands on the Mac mini, paste what steps 4 and 5 print" with options
    // "Done — ran it, output pasted below" / "not at that machine right now".
    // A supervisor first-responder cannot produce any of those answers, so the
    // card could only ever wait out the SLA while the owner sat in the filing
    // chat asking for it. Never triaged.
    // Kill switch OWNER_QUESTION_PAYLOAD_CLASS_DISABLED=1.
    if (routing.route === 'supervisor' && !ownerQuestionPayloadClassDisabled()) {
      const payloadClass = ownerOnlyPayloadClass({ question, context, options });
      if (payloadClass) routing = { route: 'owner', reason: payloadClass };
    }
    if (routing.route === 'supervisor') {
      try {
        const chat = await (prisma as any).crossModelChat?.findUnique?.({
          where: { id: input.chatId }, select: { isSupervisor: true },
        });
        if (chat && chat.isSupervisor === false) {
          triage = 'supervisor';
          triageUntil = new Date(Date.now() + ownerQuestionTriageSlaMinutes() * 60_000);
          triageReason = routing.reason;
        }
      } catch { /* probe is best-effort — legacy routing on any hiccup */ }
    }
  }

  // ── OWNER-INTERRUPT-ECONOMY: reversible recommended default ───────────────
  // Owner rule (2026-10-20): ONLY a card the flagger marks reversible WITH a
  // recommended default, outside the owner-only classes, auto-applies that
  // default after 24 h (REVERSIBLE_DEFAULT_AFTER_DAYS) — stored through the
  // P7 default pair, marked reversible in the economy marker so the sweep
  // applies it and the digest announces it. An ineligible recommendation is
  // still shown to the owner (a context line), never applied.
  // Kill switch OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED=1.
  let reversibleVerdict: { armed: boolean; reason: string } | undefined;
  let recommendedDefault = '';
  if (economy && input.reversible === true) {
    recommendedDefault = redactInboundSecrets(echoScrub(String(input.recommendedDefault ?? input.defaultOption ?? '').trim())).slice(0, OPTION_LABEL_MAX);
    reversibleVerdict = economy.reversibleDefaultEligibility({
      reversible: true, recommendedDefault, ownerOnlyReason, expectedType: expected.type, options,
    });
    trace.reversible = reversibleVerdict.armed ? 'armed' : reversibleVerdict.reason;
    if (reversibleVerdict.armed) {
      defaultAfterDays = economy.REVERSIBLE_DEFAULT_AFTER_DAYS;
      defaultOption = recommendedDefault;
    } else if (recommendedDefault && reversibleVerdict.reason !== 'disabled') {
      const why = reversibleVerdict.reason.replace(/^owner_only:/, 'an owner-only class — ').replace(/_/g, ' ');
      context = prependOwnerCardContextLine(context, `[Agent's recommended default] "${recommendedDefault}" — not auto-applied (${why}).`);
    }
  }

  // ── OWNER-INTERRUPT-ECONOMY: ask-vs-decide (supervisor filer, observe-only) ─
  // A supervisor's own card skips triage (it IS the triage seat), so the
  // owner hears every one of them. Before it lands, say on the tool result
  // whether the supervisor could decide it itself under the standing
  // directives — never a refusal. Kill switch OWNER_ASK_VS_DECIDE_ADVISORY_DISABLED=1.
  let advisory: string | undefined;
  if (economy && input.machineTriggered === true && !economy.ownerAskVsDecideAdvisoryDisabled()) {
    let supervisorFiler: boolean | null = null;
    try {
      const chat = await (prisma as any).crossModelChat?.findUnique?.({ where: { id: input.chatId }, select: { isSupervisor: true } });
      supervisorFiler = chat ? chat.isSupervisor === true : null;
    } catch { supervisorFiler = null; }
    trace.supervisorFiler = supervisorFiler;
    const adv = economy.askVsDecideAdvisory({
      supervisorFiler, machine: true, ownerOnlyReason,
      reversible: input.reversible === true, hasRecommendation: !!recommendedDefault,
    });
    if (adv.advise && adv.message) {
      advisory = adv.message;
      trace.advisory = adv.reason;
    }
  }

  // f3a69ed3 (defect 2): the owner's reply on the card this one REPLACES,
  // folded onto the new card's question so every surface that renders the
  // question — the card, the Inbox, the Telegram DM, every agent read —
  // shows it. The fold is APPENDED after the scrub/slice passes (the reply
  // text comes from the predecessor row, already scrubbed at record time),
  // and the column is @db.Text so the deliberate overage is safe. Matching
  // paths strip it via stripCardAnnotations / parseReplacedReplyFold.
  if (supersedesId && supersedesTargetReply && supersedesTargetReply.text) {
    const fold = `${REPLACED_REPLY_MARK} (card ${supersedesId}): "${supersedesTargetReply.text.replace(/"/g, "'").slice(0, 800)}"`;
    question = `${question}${fold}`;
  }

  const row = await prisma.ownerQuestion.create({
    data: {
      id: `oq_${randomUUID()}`,
      chatId: input.chatId,
      userId: input.userId,
      question,
      ...(context ? { context } : {}),
      ...(options ? { options: options as any } : {}),
      // Ticket 1b1c41bc: the structured console-action spec (Json) so the
      // pending surface can flag the card kind (consoleAction: true) and any
      // future surface can re-render the payload from structure.
      ...(consoleSpec ? { consoleAction: scrubbedSpec as any } : {}),
      // Todo fea78360 (monitor lesson 6): replacement-card linkage — the
      // named predecessor rides the new row (supersedesId); the OLD row gets
      // supersededBy (linked below, after the create).
      ...(supersedesId ? { supersedesId } : {}),
      ...(forChatId ? { forChatId } : {}),
      // H5 (round 7): goalId/todoId are agent-authored and ride the row +
      // the wake echo — scrub an echo of a delivered value (no slice on
      // these slots today, but the fragment guard makes the scrub
      // cap-proof regardless).
      // Ticket 5c024656 (round-9 F2): the echo scrub alone left a RAW
      // scanner-known credential in these linkage fields untouched — the
      // same inbound-scan wrap as the option slots (echo first, then
      // destruction) closes it. Real goal/todo ids (uuids) are not
      // credential-shaped and pass byte-identical.
      ...(String(input.goalId ?? '').trim() ? { goalId: redactInboundSecrets(echoScrub(String(input.goalId).trim())) } : {}),
      ...(String(input.todoId ?? '').trim() ? { todoId: redactInboundSecrets(echoScrub(String(input.todoId).trim())) } : {}),
      // P7 S2b: cost-of-delay + default answer (nullable, flagger-supplied).
      ...(idleUsdPerDay !== null ? { idleUsdPerDay } : {}),
      ...(defaultAfterDays !== null ? { defaultAfterDays } : {}),
      ...(defaultOption ? { defaultOption } : {}),
      // Todo 77c88942 item 2: the declared answer type ('free' stores null —
      // legacy rows and the default path stay indistinguishable).
      // Ticket 90a5b127: the flagger's own optional-ask declaration — a
      // tri-state stored verbatim (true/false/null = not declared).
      ...(input.optionalAsk === true || input.optionalAsk === false
        ? { optionalAsk: input.optionalAsk } : {}),
      // R1-3 (round-1 review of 5c024656, probe D5; ticket 91b0f191): the
      // envKey half is credential-scan-gated at parse time. This create-site
      // wrap is the belt-and-braces second layer (echoScrub on the RAW
      // pre-uppercase half, then the inbound scan) — with ONE hard rule from
      // the round-2 review (D1): the wrap must NEVER change the STORAGE
      // SHAPE of an accepted key into something the reader cannot re-parse.
      // `credential:[SECRET 1]` / `credential:[REDACTED: …]` fail
      // parseExpectedAnswerType's shape check, the row silently degrades to
      // FREE TEXT (any answer resolves it — fail-open), and the gate the
      // flagger declared is gone. So: when the scrub CHANGES the key (an
      // echo became a handle, the scan hit), store the BARE no-key slot
      // 'credential:' — the documented fail-closed shape that re-parses as
      // a credential gate with no key. Keys the scrub leaves untouched
      // store byte-identical to the pre-fix canonical form.
      ...(expected.type && expected.type !== 'free' ? {
        expectedAnswerType: expected.type === 'credential'
          ? (() => {
              const rawHalf = rawEnvKeyHalf(input.expectedAnswerType) ?? expected.envKey ?? '';
              const wrapped = expected.envKey ? redactInboundSecrets(echoScrub(rawHalf)) : '';
              return expected.envKey && wrapped === rawHalf
                ? `credential:${rawHalf.toUpperCase()}`
                : 'credential:';
            })()
          : expected.type,
      } : {}),
      // Review 2026-09-13 issue 11: supervisor-first triage state.
      ...(triage ? { triage, triageUntil } : {}),
    },
  });
  // Ticket 26786762 rework (review BLOCKING 2): the created result carries the
  // delivery manifest (ordinal → label) so the agent can cite real handles.
  let deliveredManifest: Array<{ ordinal: number; label: string }> | undefined;

  // ── Ticket 26786762: persist the delivered credential set ──────────────
  // Review rework: EXPLICIT deliverSecrets entries hold ordinals 1..E (the
  // agent writes "[SECRET 1]" for its first delivered key per the tool doc —
  // that handle must resolve to THAT key); implicitly-rescued spans number
  // E+1.. from the shared counter (the agent never writes handles for them —
  // the scan substitutes them in place). FAIL-LOUD on the store write (the
  // catch refuses the flag): a card whose text promises "[SECRET 1]" with no
  // row behind it is the silent-failure mishap again. The row was already
  // created; deleting it keeps the inbox clean on refusal.
  if (implicitKept.length || explicitEntries.length) {
    // Advisory 5 (review): a handle cut off by the QUESTION/CONTEXT truncation
    // leaves a vaulted value with no visible handle — drop those from the
    // delivery (the span's original text is cut off too, so nothing is lost
    // from the visible card).
    const visibleKept = implicitKept.filter((k) =>
      (question.includes(secretDelivery.oqSecretPlaceholder(k.ordinal)) && questionRescue.kept.some((x) => x.ordinal === k.ordinal)) ||
      (context.includes(secretDelivery.oqSecretPlaceholder(k.ordinal)) && contextRescue.kept.some((x) => x.ordinal === k.ordinal)));
    // Review BLOCKING G3 (round 6): sanitize the PERSISTED label at
    // construction — the schema encrypts only valueEnc, and this label
    // renders on the card and rides the manifest seam. safeDeliverableLabel
    // = the inbound scan gate PLUS an exact-echo check against EVERY
    // delivered value on the card (a scanner-unknown value pasted into a
    // label slot is invisible to the scan alone). The store re-sanitizes as
    // defense in depth.
    const deliverableValues = [
      ...explicitEntries.map((e) => e.value),
      ...visibleKept.map((k) => k.value),
    ];
    const deliverables: DeliverableSecret[] = [
      ...explicitEntries.map((e, i) => ({ ordinal: i + 1, label: secretDelivery.safeDeliverableLabel(e.label, deliverableValues), value: e.value, origin: 'explicit' })),
      ...visibleKept.map((k) => ({ ordinal: k.ordinal, label: secretDelivery.safeDeliverableLabel(k.name, deliverableValues), value: k.value, origin: k.name })),
    ];
    if (deliverables.length > OQ_SECRET_TOTAL_CAP) {
      await prisma.ownerQuestion.delete({ where: { id: row.id } }).catch(() => {});
      return {
        kind: 'refused', refused: 'invalid',
        message: `this card carries ${deliverables.length} credentials (implicit spans + deliverSecrets) — the cap is ${OQ_SECRET_TOTAL_CAP}. Split the delivery across cards or deliver fewer values.`,
      };
    }
    try {
      await secretDelivery.storeQuestionSecrets(prisma, input.userId, row.id, deliverables);
    } catch (err: any) {
      await prisma.ownerQuestion.delete({ where: { id: row.id } }).catch(() => {});
      await logOwnerQuestions('warn', `owner-questions: secret delivery FAILED for ${row.id} (flag refused): ${err?.message ?? err}`);
      return {
        kind: 'refused', refused: 'invalid',
        message: 'the credential could not be stored for delivery (vault unavailable) — the card was NOT filed; retry, or leave the value in the coding-credentials vault and tell the owner where to read it.',
      };
    }
    void recordOwnerQuestionMetric('owner_question_secret_delivered', {
      chatId: input.chatId, kind: 'flag', questionId: row.id.slice(0, 11),
      implicit: implicitKept.length, explicit: explicitEntries.length,
    });
    // Review BLOCKING 2 (rework) + B″ (round 4): the flag RESULT carries the
    // delivery manifest (ordinal → label) so the agent can cite the real
    // handles — "[SECRET 1]" is the FIRST EXPLICIT entry. The label rides
    // the unredacted tool-result seam (stamped into transcript parts and
    // re-sent to the provider), so it gets the SAME safe-label gate as every
    // preview surface: a credential-shaped label degrades to 'Credential'.
    deliveredManifest = deliverables.map((d) => ({ ordinal: d.ordinal, label: secretDelivery.safeDeliveredLabel(d.label) }));
  }
  void logOwnerQuestions('info', `owner-questions: ${row.id} flagged on chat ${input.chatId} (user ${input.userId})${triage ? ` — triaged to the Fleet Supervisor until ${triageUntil?.toISOString()} (${triageReason})` : ''}`);
  // ── Todo fea78360: post-create replacement linkage ─────────────────────────
  // The new row exists; link the OLD card (supersededBy) and auto-dismiss it
  // when still OPEN. The conditional updateMany keeps it race-safe against a
  // simultaneous owner answer/dismiss (exactly like answerOwnerQuestion). A
  // non-open predecessor still LINKS (chain history is real) but is never
  // re-dismissed. The dismiss note names the REPLACEMENT id so the woken lane
  // knows where the live decision now lives.
  let supersededQuestionId: string | undefined;
  if (supersedesId) {
    try {
      // fea78360: the link is FIRST-WRITER-WINS — the where pins
      // supersededBy: null so a card already claimed by another successor is
      // never silently re-pointed (two concurrent replacements cannot both
      // claim one predecessor; the loser keeps its supersedesId but the old
      // card's forward pointer stays with the first claim).
      const link = await prisma.ownerQuestion.updateMany({
        where: { id: supersedesId, userId: input.userId, supersededBy: null },
        data: { supersededBy: row.id },
      });
      if (link.count > 0) {
        supersededQuestionId = supersedesId;
        const target = await prisma.ownerQuestion.findUnique({ where: { id: supersedesId } });
        if (target && target.status === 'open') {
          const flip = await prisma.ownerQuestion.updateMany({
            where: { id: supersedesId, status: 'open' },
            // abca56ce: stamped 'system' — a superseded card is no one's
            // ruling, and every reader (list_owner_questions, the notify_user
            // refusal) must be able to say so.
            data: { status: 'dismissed', resolvedAt: new Date(Date.now()), dismissedBy: 'system' },
          });
          if (flip.count > 0) {
            if (economy) void economy.recordOwnerQuestionResolved(target, { outcome: 'dismissed', by: 'system', surface: 'superseded' }).catch(() => {});
            await postOwnerInboxNote(
              target.chatId,
              `[Owner inbox] Card ${target.id} is now superseded by replacement card ${row.id} — the live decision is "${row.question.slice(0, 160)}" (one decision, one card: todo fea78360). Answer the replacement, not this one.`,
            );
            await wakeChatForOwnerResolution(
              target.chatId,
              `[Owner inbox — card ${target.id} was replaced by ${row.id}] The card you were waiting on is superseded by a newer card for the same decision: "${row.question.slice(0, 160)}". Treat ${row.id} as the live gate; do not wait on or re-ask this one.`,
              target.id,
              { kind: 'superseded' },
            );
          }
        }
      }
    } catch (err: any) {
      void logOwnerQuestions('warn', `owner-questions: supersedes linkage failed for ${row.id} → ${supersedesId}: ${err?.message ?? err}`);
    }
  }
  // OWNER-INTERRUPT-ECONOMY: the per-question marker the later paths read —
  // urgency (a triaged card surfacing later is still sent at once) and the
  // reversible default (the 24 h sweep applies only marked rows). Awaited,
  // best-effort: a failed write leaves an urgent triaged card to the
  // cost-of-delay / owner-only checks and a reversible default to the P7
  // escalation seam (it then applies like any preset default).
  if (economy && (input.urgent === true || reversibleVerdict?.armed)) {
    const wrote = await economy.writeEconomyMarker(row.id, {
      ...(input.urgent === true ? { urgent: true } : {}),
      ...(reversibleVerdict?.armed ? { reversible: true, recommendedDefault } : {}),
    });
    if (!wrote) void logOwnerQuestions('warn', `owner-questions: economy marker write failed for ${row.id} (urgent=${input.urgent === true}, reversible=${reversibleVerdict?.armed === true})`);
  }
  const economyFields = {
    ...(priorMatch && trace.priorRecall === 'annotated' ? { priorDecision: { questionId: priorMatch.row.id, decidedOn: priorMatch.decidedOn, strict: priorMatch.strict } } : {}),
    ...(reversibleVerdict ? { reversibleDefault: reversibleVerdict } : {}),
    ...(advisory ? { advisory } : {}),
  };
  if (triage) {
    // Review 2026-09-13 issue 11: the owner's DM is DEFERRED — it is sent by
    // surfaceTriagedOwnerQuestions only if the supervisor has not answered by
    // the SLA. Wake the supervisor with the question id (best-effort; the
    // routing class rides the info line above).
    trace.delivery = 'triage';
    void wakeSupervisorForTriage({ chatId: input.chatId, questionId: row.id, question, options }).catch(() => {});
    return { kind: 'created', question: row, ...(supersededQuestionId ? { supersededQuestionId } : {}), ...(deliveredManifest ? { secrets: deliveredManifest } : {}), delivery: 'triage', ...economyFields };
  }
  // OWNER-INTERRUPT-ECONOMY (owner rule 2026-10-20): a card only the owner can
  // answer, or one marked urgent / high cost-of-delay, is DMed at once (as
  // before); every other card joins the owner's 12 h digest. A queue write
  // that fails sends the DM at once (fail toward delivery).
  // Kill switch OWNER_DECISION_DIGEST_DISABLED=1.
  let delivery: 'immediate' | 'digest' = 'immediate';
  if (economy) {
    const verdict = economy.classifyOwnerQuestionDelivery({ ownerOnlyReason, urgent: input.urgent === true, idleUsdPerDay });
    trace.deliveryReason = verdict.reason;
    if (verdict.delivery === 'digest') {
      const anchorAt = row.createdAt instanceof Date ? row.createdAt : new Date(Date.now());
      if (await economy.queueOwnerDigestEntry({ userId: input.userId, questionId: row.id, kind: 'question', anchorAt })) delivery = 'digest';
      else trace.deliveryReason = 'queue_failed';
    }
  } else {
    trace.deliveryReason = 'economy_unavailable';
  }
  trace.delivery = delivery;
  if (delivery === 'immediate') {
    // ticket 4ab93d8d: push a Telegram DM to the owner on every NEW flag — the
    // inbox/badge are pull-only and the owner asked for a notification. Fire-
    // and-forget: a push failure must never block or fail the flag itself.
    void notifyOwnerOfNewFlag({
      userId: input.userId, question, options: options ?? undefined, questionId: row.id,
      idleUsdPerDay: idleUsdPerDay ?? undefined,
      defaultAfterDays: defaultAfterDays ?? undefined,
      defaultOption: defaultOption ?? undefined,
      ...(consoleSpec ? { consoleAction: true } : {}),
    }).catch(() => {});
  }
  return { kind: 'created', question: row, ...(supersededQuestionId ? { supersededQuestionId } : {}), ...(deliveredManifest ? { secrets: deliveredManifest } : {}), delivery, ...economyFields };
}

/**
 * ticket 4ab93d8d — best-effort Telegram DM to the owner when a new owner
 * question is recorded. No-op unless the bot is configured AND the user has a
 * linked Telegram; every failure is swallowed (log-only) so the flag path is
 * never blocked by a push problem. Deduped/refused flags never reach this —
 * the owner is pinged once per genuinely new inbox item.
 */
async function notifyOwnerOfNewFlag(input: {
  userId: string;
  question: string;
  options?: OwnerQuestionOption[];
  questionId?: string;
  idleUsdPerDay?: number;
  defaultAfterDays?: number;
  defaultOption?: string;
  /** Review 2026-09-13 issue 11: the DM was HELD for the supervisor's SLA and
   *  is being sent now because nobody answered — say so (one line). */
  heldForSupervisor?: boolean;
  /** Ticket 1b1c41bc: a console-action card carries the paste-ready payload
   *  in its question body — the DM must not amputate it at the 900-char
   *  default slice (the owner would again see a summary and ask for the
   *  content — the exact round-trip this ticket ends). */
  consoleAction?: boolean;
}): Promise<void> {
  try {
    const { isConfigured, sendMessage } = await import('../telegram/telegram.service');
    if (!isConfigured()) return;
    const prisma = await db();
    const link = await prisma.telegramLink.findUnique({ where: { userId: input.userId } });
    if (!link) return;
    const optionsBlock = input.options?.length ? `\n\n${renderOptionsNumbered(input.options)}` : '';
    // P7 S2b: cost-of-delay + default-answer lines when the flagger set them.
    const delayBlock = renderCostOfDelay(input);
    const replyHint = input.questionId
      ? `\n\nAnswer in Digby → Management → Inbox, or reply here: "answer ${shortQuestionRef(input.questionId)} <your answer${input.options?.length ? ' or option number' : ''}>".`
      : '\n\nAnswer in Digby → Management → Inbox.';
    // The "Digby needs your decision" marker is load-bearing: the Telegram
    // bare-reply router (telegram.controller DECISION_DM_MARKER_RE) keys on it.
    const heldLine = input.heldForSupervisor
      ? '\n(Held for the Fleet Supervisor first — it did not answer within the triage window, so this one is yours.)'
      : '';
    // OWNER-INTERRUPT-ECONOMY: a re-asked card's prior-decision annotation
    // sits at the END of its question — the clip keeps it.
    const text = `⚠️ Digby needs your decision:${heldLine}\n\n${clipQuestionKeepingAnnotation(input.question, input.consoleAction ? CONSOLE_ACTION_QUESTION_MAX : 900)}${optionsBlock}${delayBlock}${replyHint}`;
    await sendMessage(link.chatId, text);
  } catch (err: any) {
    await logOwnerQuestions('warn', `owner-questions: telegram push failed for user ${input.userId}: ${err?.message ?? err}`);
  }
}

/**
 * Cost-of-delay + default-answer lines (P7 S2b) — shared by the new-flag DM,
 * the daily re-push, and the Inbox card build (confirmations.controller).
 * Empty string when the flagger set neither field. Pure; exported for tests.
 */
export function renderCostOfDelay(q: {
  idleUsdPerDay?: number | null;
  defaultAfterDays?: number | null;
  defaultOption?: string | null;
}): string {
  const lines: string[] = [];
  const idle = typeof q.idleUsdPerDay === 'number' && Number.isFinite(q.idleUsdPerDay) && q.idleUsdPerDay > 0 ? q.idleUsdPerDay : null;
  if (idle !== null) lines.push(`💸 idle cost ~$${idle % 1 === 0 ? idle : idle.toFixed(2)}/day while this waits`);
  const days = typeof q.defaultAfterDays === 'number' && Number.isFinite(q.defaultAfterDays) && q.defaultAfterDays >= 1 ? Math.round(q.defaultAfterDays) : null;
  const opt = String(q.defaultOption ?? '').trim();
  if (days !== null && opt) lines.push(`⏱ defaults to "${opt}" after ${days} day${days === 1 ? '' : 's'} with no answer`);
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

/** The short ref the Telegram answer command accepts: the first 8 id chars after 'oq_'. */
export function shortQuestionRef(questionId: string): string {
  const id = String(questionId ?? '');
  return id.startsWith('oq_') ? id.slice(3, 11) : id.slice(0, 8);
}

// ── Owner-card contract (todo fea78360, monitor lesson 6) ───────────────────
// One decision, one card, one chain. The 2026-10-16 amd-server-1 ACL stall:
// FOUR cards for ONE 2-minute console save (oq_d5948325 mangled auto-file,
// dismissed; oq_ea52c6ae answered with an instruction ask; oq_9396afac
// answered "Saved"; oq_19ab7b6b open) — no card named the one it replaced,
// and the owner answered the STALE card while the live one sat under it.
// Fleet baseline 2026-10-16: 14 of 25 owner cards carried the full payload
// inline; 0 of 5 replacement cards named the card they replaced.
//
// OBSERVE-ONLY FIRST (the 6f8b52b7 / PR #1548 ladder): the flag path records
// owner_card_payload_incomplete + owner_card_chain_unlinked loop metrics —
// metric only, never a refusal, never a rewrite. The supersedes linkage and
// the dedupe context-append are SUPPORT additions (they add information and
// resolve ids the agent supplied); the refusal half of the contract (reject a
// payload-incomplete card, require supersedes: on a same-topic successor) is
// a LATER decision on the measured rate. Kill switch for the detectors:
// OWNER_CARD_CONTRACT_DISABLED=1 (registered, forwarded backend + worker).

/** Kill switch for the fea78360 owner-card contract DETECTOR legs (the
 *  observe-only metrics). The supersedes resolution + auto-dismiss and the
 *  dedupe context-append stay ON when the switch flips (they are support
 *  paths, not detections — reverting them would strand existing callers),
 *  and OWN-supersedes chain metric rows are never suppressed for a card
 *  that itself declares the link (there is nothing to observe). */
export function ownerCardContractDisabled(): boolean {
  return process.env.OWNER_CARD_CONTRACT_DISABLED === '1';
}

/** Kill switch for the fea78360 dedupe context-append (a MUTATING support
 *  path — it rewrites the open card's context). DISABLED=1 reverts the flag
 *  path to the pre-fix dedupe: return the existing row, drop the context. */
export function ownerCardAppendContextDisabled(): boolean {
  return process.env.OWNER_CARD_APPEND_CONTEXT_DISABLED === '1';
}

/** Kill switch for the fea78360 supersedes resolution + auto-dismiss (a
 *  MUTATING support path — it dismisses the named predecessor card). The
 *  flagger-supplied supersedes id is dropped with a warn when set; the card
 *  files unlinked (the pre-fix behavior). */
export function ownerCardSupersedesDisabled(): boolean {
  return process.env.OWNER_CARD_SUPERSEDES_DISABLED === '1';
}

/** The payload-completeness admission for a filed card (fea78360) MOVED to
 *  the pure leaf ./owner-card-gaps.ts (ticket 65cfec1b) so the read-time
 *  framework-signal sweep applies the SAME admission; re-exported above for
 *  existing importers (tests). The decision context the owner's
 *  2026-10-16 13:19Z inline-payload directive requires — background (what is
 *  happening), options (choices or a recommendation), and the ask itself. A
 *  consoleAction card carries the four elements structurally and is complete
 *  by construction. */

/** Union of scopes a successor card is CHAIN-RELATED to a predecessor
 *  through — the chain scan's search space (fea78360). */
export function ownerCardChainScope(input: {
  chatId: string;
  forChatId?: string | null;
  goalId?: string | null;
  todoId?: string | null;
}): Array<{ scope: 'chat' | 'forChat' | 'goal' | 'todo'; id: string }> {
  const scopes: Array<{ scope: 'chat' | 'forChat' | 'goal' | 'todo'; id: string }> = [
    { scope: 'chat', id: input.chatId },
  ];
  const forChatId = String(input.forChatId ?? '').trim();
  if (forChatId && forChatId !== input.chatId) scopes.push({ scope: 'forChat', id: forChatId });
  const goalId = String(input.goalId ?? '').trim();
  if (goalId) scopes.push({ scope: 'goal', id: goalId });
  const todoId = String(input.todoId ?? '').trim();
  if (todoId) scopes.push({ scope: 'todo', id: todoId });
  return scopes;
}

/** The fea78360 chain predicate: does the successor card look like a
 *  REPLACEMENT for the predecessor (same decision, re-asked)? Topic overlap
 *  on the question texts, same bar as the N8 open-question topic dedupe
 *  (Jaccard ≥ 0.6, or an entity-anchored run ≥ 2 over the 0.25 floor).
 *  Pure; exported for tests. */
export function ownerCardChainMatch(predecessor: { question: string }, successor: { question: string }): boolean {
  return questionTopicDedupeMatch(predecessor.question, successor.question);
}

/**
 * 72h owner-wait re-push (remediation P2 S2a): ONE Telegram reminder per
 * question per calendar day for an owner-gated goal/todo still waiting.
 * Deduped by a Redis NX key (question + UTC day); every failure is swallowed.
 * Returns true only when a DM was actually sent this call.
 */
export async function repushOwnerQuestionReminder(question: OwnerQuestionView, waitingDays: number): Promise<boolean> {
  try {
    const redis = (await import('../../../config/redis')).default as any;
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const key = `oq:repush:${question.id}:${day}`;
    const claimed = await redis.set(key, '1', { NX: true, EX: 26 * 60 * 60 }).catch(() => null);
    if (claimed !== 'OK') return false;
    const { isConfigured, sendMessage } = await import('../telegram/telegram.service');
    if (!isConfigured()) return false;
    const prisma = await db();
    const link = await prisma.telegramLink.findUnique({ where: { userId: question.userId } });
    if (!link) return false;
    const options = parseStoredOptions(question.options);
    const optionsBlock = options.length ? `\n\n${renderOptionsNumbered(options)}` : '';
    const delayBlock = renderCostOfDelay(question);
    const sent = await sendMessage(
      link.chatId,
      `⏳ Still awaiting you (${waitingDays} day${waitingDays === 1 ? '' : 's'}) — work is blocked on this decision:\n\n` +
        `${question.question.slice(0, 900)}${optionsBlock}${delayBlock}\n\n` +
        `Answer in Digby → Management → Inbox, or reply here: "answer ${shortQuestionRef(question.id)} <your answer${options.length ? ' or option number' : ''}>".`,
    );
    return sent !== false;
  } catch (err: any) {
    await logOwnerQuestions('warn', `owner-questions: 72h re-push failed for ${question.id}: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Conservative default-answer applier (P7 S2b): a question whose FLAGGER
 * explicitly set BOTH defaultAfterDays and defaultOption auto-answers with the
 * default once it has sat OPEN past the deadline. Called from the P2
 * owner-wait escalation path (project-digest pushBlockedItem — the same hourly
 * seam as the 72h re-push). Double guard: both fields must be present on the
 * row (flagOwnerQuestion only stores them as a validated pair) AND re-checked
 * here; anything else returns false untouched. The auto-answer follows the
 * answerOwnerQuestion contract — conditional one-shot flip, transcript note,
 * wake (+ linked lane), supervisor ledger — but stamps answeredBy:'default'
 * and DMs the owner a confirmation so a silent default can never surprise
 * them. NEVER throws.
 */
export async function applyDefaultAnswerIfDue(
  question: OwnerQuestionView,
  now: Date = new Date(),
  /** OWNER-INTERRUPT-ECONOMY: the per-question economy marker when the caller
   *  already read it (the reversible-default sweep); undefined = read it here. */
  opts: { economyMarker?: { reversible?: boolean; recommendedDefault?: string } | null } = {},
): Promise<boolean> {
  return (await applyDefaultAnswerWithReason(question, now, opts)).applied;
}

/**
 * applyDefaultAnswerIfDue with the reason it did / did not apply
 * (OWNER-INTERRUPT-ECONOMY review 2026-10-20 — the reversible-default sweep
 * RETIRES a default refused for a permanent reason instead of re-reading it
 * every pass): 'applied' | 'not_open' | 'no_default' | 'not_due' |
 * 'reversible_disabled' | 'typed_gate' | 'owner_only:<class>' | 'lost_race' |
 * 'error'. NEVER throws.
 */
export async function applyDefaultAnswerWithReason(
  question: OwnerQuestionView,
  now: Date = new Date(),
  opts: { economyMarker?: { reversible?: boolean; recommendedDefault?: string } | null } = {},
): Promise<{ applied: boolean; reason: string }> {
  try {
    if (!question || question.status !== 'open') return { applied: false, reason: 'not_open' };
    const days = typeof question.defaultAfterDays === 'number' && Number.isFinite(question.defaultAfterDays)
      ? Math.round(question.defaultAfterDays) : null;
    const defaultOption = String(question.defaultOption ?? '').trim();
    if (days === null || days < 1 || !defaultOption) return { applied: false, reason: 'no_default' }; // BOTH must be set (double guard)
    const createdMs = question.createdAt instanceof Date ? question.createdAt.getTime() : new Date(question.createdAt as any).getTime();
    if (!Number.isFinite(createdMs) || now.getTime() - createdMs < days * 86_400_000) return { applied: false, reason: 'not_due' };

    // OWNER-INTERRUPT-ECONOMY (2026-10-20): a REVERSIBLE recommended default
    // (economy marker) — the owner's 24 h rule. Read only once the default is
    // due; a failed read is "not reversible" (the P7 path, unchanged).
    let economy: typeof import('./owner-interrupt-economy') | null = null;
    try { economy = await import('./owner-interrupt-economy'); } catch { economy = null; }
    let marker = opts.economyMarker;
    if (marker === undefined) marker = economy ? await economy.readEconomyMarkerSafe(question.id) : null;
    // Review 2026-10-20: the kill switch covers cards ALREADY armed — a marked
    // row is never auto-answered while OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED
    // is on, by any seam (it used to fall through to the preset path, so the
    // hourly P7 blocked-item seam answered it after 1 day anyway). Residual: a
    // store outage hides the marker and the row reads as a preset default.
    if (marker?.reversible === true && process.env.OWNER_QUESTION_REVERSIBLE_DEFAULT_DISABLED === '1') {
      return { applied: false, reason: 'reversible_disabled' };
    }
    const reversible = !!economy && marker?.reversible === true;
    const options = parseStoredOptions(question.options);
    // Todo 77c88942 item 2: a TYPED gate never auto-answers with a preset
    // default — a credential gate has no text answer at all, and a choice/
    // yes_no gate must match its own shape. The default arm is a flagger-
    // pre-declared TEXT; against a typed gate that is a mismatch by
    // construction. (defaultAfterDays/defaultOption pair with a typed gate is
    // a flag-time modeling error — the answer path simply refuses.)
    // OWNER-INTERRUPT-ECONOMY: a REVERSIBLE default armed at flag time only
    // when it IS the gate's declared shape (a typed option / a ruling) passes.
    const typed = parseExpectedAnswerType((question as any).expectedAnswerType, question.question).type;
    if (typed && !(reversible && economy!.reversibleDefaultFitsTypedGate(typed, defaultOption, options))) return { applied: false, reason: 'typed_gate' };
    if (reversible) {
      // Defense in depth (owner rule): never auto-apply on an owner-only class.
      const ownerOnly = economy!.ownerOnlyInterruptReason(question.question, question.context ?? null, {
        credentialGate: typed === 'credential', consoleAction: !!parseStoredConsoleAction((question as any).consoleAction),
      });
      if (ownerOnly) {
        void logOwnerQuestions('warn', `owner-questions: reversible default for ${question.id} NOT applied — the card reads as owner-only (${ownerOnly})`);
        return { applied: false, reason: `owner_only:${ownerOnly}` };
      }
    }

    const prisma = await db();
    const matched = matchAnswerToOption(options, defaultOption);
    const label = matched ? matched.label : defaultOption;
    const storedAnswer = (reversible
      ? `${label} [auto-applied the flagger's RECOMMENDED default after 24 hours with no owner answer — the choice is reversible: the owner can change course at any time]`
      : `${label} [auto-answered with the flagger's preset default after ${days} day${days === 1 ? '' : 's'} with no owner answer]`).slice(0, ANSWER_MAX);
    const flip = await prisma.ownerQuestion.updateMany({
      where: { id: question.id, status: 'open' },
      data: {
        status: 'answered', answer: storedAnswer, resolvedAt: new Date(Date.now()),
        answeredBy: 'default',
        ...(matched ? { chosenOption: matched.id } : {}),
      },
    });
    if (flip.count === 0) return { applied: false, reason: 'lost_race' }; // the owner (or a peer sweep) got there first
    void logOwnerQuestions('info', `owner-questions: ${question.id} auto-answered with its ${reversible ? 'reversible recommended' : 'preset'} default ("${label}") after ${days}d open`);
    if (economy) void economy.recordOwnerQuestionResolved(question, { outcome: 'answered', by: 'default', surface: reversible ? 'reversible_default' : 'preset_default' }).catch(() => {});
    await postOwnerInboxNote(
      question.chatId,
      reversible
        ? `[Owner inbox] Question auto-answered with your RECOMMENDED reversible default (the owner did not answer within 24 hours; announced in the owner's next decision digest) — Q: "${question.question}" A: "${storedAnswer}"`
        : `[Owner inbox] Question auto-answered with its preset DEFAULT (the owner did not answer within ${days} day${days === 1 ? '' : 's'}) — Q: "${question.question}" A: "${storedAnswer}"`,
    );
    const wakeText = reversible
      ? `[Owner inbox — your flagged question AUTO-ANSWERED with your recommended REVERSIBLE default (no owner answer within 24 hours)] Q: "${question.question}"\nA: "${storedAnswer}"\n\nAct on this default now — it is the recommendation YOU made when flagging the choice as reversible, and the owner sees it in the next decision digest. If the owner later says otherwise, change course; if reality has since made it wrong, flag a fresh question instead of acting against it.`
      : `[Owner inbox — your flagged question AUTO-ANSWERED with its preset default (no owner answer within ${days} day${days === 1 ? '' : 's'})] Q: "${question.question}"\nA: "${storedAnswer}"\n\nAct on this default now — it is the conservative choice YOU pre-declared when flagging. If reality has since made it wrong, flag a fresh question instead of acting against it.`;
    const forChatId: string | null = question.forChatId ?? null;
    // archived-target-retire: each wake names the OTHER chat this default
    // reaches, so an archived asker / linked lane never re-routes the same
    // answer to a supervisor that already gets it.
    const askerReroutedTo = await wakeChatForOwnerResolution(question.chatId, wakeText, question.id, { kind: 'answer', alsoWakingChatIds: [forChatId] });
    if (forChatId && forChatId !== question.chatId) {
      await wakeChatForOwnerResolution(forChatId, wakeText, question.id, { kind: 'answer', alsoWakingChatIds: [question.chatId, askerReroutedTo], laneRole: 'linked' });
    }
    await appendAnswerToSupervisorLedger(question.userId, { questionId: question.id, question: question.question, answer: storedAnswer, sourceChatId: question.chatId, answeredBy: 'default' });
    // Ticket 356d21bb: a DECISION was made (the flagger's own pre-declared
    // default) — it resolves the derived gates too, through the same choke
    // point as an owner-typed answer.
    await unblockGatesForAnsweredQuestion({
      userId: question.userId, questionId: question.id, question: question.question, answer: storedAnswer,
      source: 'preset default answer',
      answeredBy: 'default',
    });
    // OWNER-INTERRUPT-ECONOMY (owner rule): a REVERSIBLE default is announced
    // in the owner's next decision digest, not by its own DM. A queue failure
    // falls through to the immediate confirmation DM (fail toward delivery).
    if (reversible && economy && await economy.queueOwnerDigestEntry({ userId: question.userId, questionId: question.id, kind: 'auto_default', anchorAt: new Date(Date.now()) })) {
      return { applied: true, reason: 'applied' };
    }
    // Confirmation DM — the owner must LEARN a default was applied on their
    // behalf (best-effort like every push in this module).
    try {
      const { isConfigured, sendMessage } = await import('../telegram/telegram.service');
      if (isConfigured()) {
        const link = await prisma.telegramLink.findUnique({ where: { userId: question.userId } });
        if (link) {
          await sendMessage(
            link.chatId,
            `⏱ Default applied — this decision sat unanswered ${days} day${days === 1 ? '' : 's'}, so its preset default was auto-answered:\n\nQ: ${question.question.slice(0, 600)}\nDefault: "${label}"\n\nIf that's wrong, tell the chat (or the supervisor) to course-correct.`,
          );
        }
      }
    } catch (err: any) {
      await logOwnerQuestions('warn', `owner-questions: default-answer confirmation DM failed for ${question.id}: ${err?.message ?? err}`);
    }
    return { applied: true, reason: 'applied' };
  } catch (err: any) {
    await logOwnerQuestions('warn', `owner-questions: default-answer apply failed for ${question?.id}: ${err?.message ?? err}`);
    return { applied: false, reason: 'error' };
  }
}

/**
 * OWNER-INTERRUPT-ECONOMY review 2026-10-20: RETIRE an armed reversible
 * default the 24 h apply refused for a permanent reason (the card now reads
 * owner-only — e.g. context appended after filing names a cost — or the
 * default no longer fits its typed gate). The row's default pair is cleared
 * (no seam — the sweep or the P7 blocked-item path — ever applies it, and the
 * card stops promising "defaults to … after 1 day"), the recommendation stays
 * visible as a context line, and the asking lane is told the card waits for
 * the owner (it was told "armed" at flag time). Conditional on the row still
 * being open. Returns whether the row was retired; never throws.
 */
export async function retireReversibleDefault(question: OwnerQuestionView, reason: string): Promise<boolean> {
  try {
    const prisma = await db();
    const label = String(question.defaultOption ?? '').trim();
    const why = String(reason ?? '').startsWith('owner_only:')
      ? `the card now reads as an owner-only decision (${String(reason).slice('owner_only:'.length).replace(/_/g, ' ')})`
      : 'the default does not fit the card\'s typed answer';
    const line = `[Agent's recommended default] "${label}" — NOT auto-applied after 24 h: ${why}. This card waits for the owner.`;
    const flip = await prisma.ownerQuestion.updateMany({
      where: { id: question.id, status: 'open' },
      data: { defaultAfterDays: null, defaultOption: null, context: prependOwnerCardContextLine(String(question.context ?? ''), line) },
    });
    if (flip.count === 0) return false;
    void logOwnerQuestions('info', `owner-questions: reversible default for ${question.id} retired (${reason}) — the card waits for the owner`);
    await postOwnerInboxNote(
      question.chatId,
      `[Owner inbox] The reversible default you recommended for card ${question.id} ("${label}") was NOT auto-applied after 24 hours — ${why}. The card stays OPEN for the owner's own answer; do not act on the recommendation as if it were decided.`,
    );
    return true;
  } catch (err: any) {
    await logOwnerQuestions('warn', `owner-questions: retiring the reversible default for ${question?.id} failed (the sweep drops it from its index anyway): ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Inbox poll: the owner's open questions, newest first (never expire).
 * Review 2026-09-13 issue 11: rows currently in supervisor triage (open,
 * triage='supervisor', SLA not elapsed) are HIDDEN by default — this is the
 * owner's Decisions rail + Telegram view. `includeTriaged: true` (the
 * supervisor's list_owner_questions) shows them with a `triaged: true` marker.
 */
export async function listOpenOwnerQuestionsForUser(
  userId: string,
  opts: { includeTriaged?: boolean } = {},
): Promise<OwnerQuestionView[]> {
  const now = new Date(Date.now());
  const rows = await (await db()).ownerQuestion.findMany({
    where: { userId, status: 'open', ...(opts.includeTriaged ? {} : notInTriageWhere(now)) } as any,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return opts.includeTriaged ? rows.map((r) => ({ ...r, triaged: isOwnerQuestionInTriage(r, now) })) : rows;
}

/**
 * Surfacing sweep (Review 2026-09-13 issue 11): every OPEN row still in
 * supervisor triage whose SLA has elapsed flips to triage='surfaced' (a
 * conditional one-shot updateMany — blue/green run one sweeper each) and the
 * owner gets the (once-delayed) Telegram DM through the same notify path a
 * fresh flag uses. Rows the supervisor
 * answered before the SLA are status='answered' and never match — they never
 * reach the owner's rail. Runs from the attention-watchdog sweep (the same
 * cron seam as the 72h re-push / default-answer escalations). NEVER throws.
 */
export async function surfaceTriagedOwnerQuestions(opts?: { now?: Date }): Promise<number> {
  const now = opts?.now ?? new Date(Date.now());
  let surfaced = 0;
  try {
    const prisma = await db();
    const due = await prisma.ownerQuestion.findMany({
      where: { status: 'open', triage: 'supervisor', triageUntil: { lte: now } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    // ── Ticket 1a56f816 (2026-10-30): EARLY RELEASE ──────────────────────────
    // TWO engagement-independent reasons to end a triage window early. Both
    // flip + DM through the identical path the SLA arm uses — they only change
    // WHEN a card reaches the owner, never what.
    //
    // (a) UNANSWERABLE (adversarial finding 2, BLOCKING — this ticket's own
    //     shape): supervisor triage is only meaningful while a supervisor can
    //     LAWFULLY act. A card whose stored row classes owner-only can never be
    //     answered by a supervisor (the answer-time guard refuses it) and can
    //     never be dismissed by one (the dismiss rails refuse it) — holding it
    //     for the SLA is a pure delay with no possible outcome but the owner's.
    //     That is exactly the specimen: oq_3c246863 sat 2 h behind triageUntil
    //     while answer_owner_question and dismiss_owner_question both refused,
    //     so a peer supervisor asked for a release and no lawful path existed.
    //     This arm is the standing path: an owner-only card found in triage
    //     surfaces on the next sweep, whatever its filing time. It also heals
    //     cards ALREADY in triage at deploy time (filed under the old
    //     classifier) and any whose class is widened later.
    // (b) ENGAGEMENT: the owner posted in the FILING chat after the card was
    //     filed — an unambiguous "I am here, looking at this lane, now" signal
    //     (the same countOwnerPostsSinceQuestion probe the triage-race guard and
    //     the dismiss rails use). A probe hiccup returns 0 and simply leaves the
    //     card on the SLA.
    // Kill switch OWNER_QUESTION_TRIAGE_EARLY_RELEASE_DISABLED=1 (both arms).
    const engaged: any[] = [];
    const releaseWhy = new Map<string, 'owner_only' | 'owner_engaged'>();
    if (!ownerQuestionTriageEarlyReleaseDisabled()) {
      try {
        const inFlight = await prisma.ownerQuestion.findMany({
          where: { status: 'open', triage: 'supervisor' },
          orderBy: { createdAt: 'asc' },
          take: 50,
        });
        const dueIds = new Set((due ?? []).map((r: any) => r.id));
        for (const row of inFlight ?? []) {
          if (dueIds.has(row.id)) continue; // the SLA arm flips it below anyway
          const ownerOnly = ownerOnlyRoutingForStoredRow({
            question: row.question,
            context: (row as any).context ?? null,
            options: (row as any).options,
            expectedAnswerType: (row as any).expectedAnswerType,
            consoleAction: (row as any).consoleAction,
          });
          if (ownerOnly) {
            engaged.push(row);
            releaseWhy.set(row.id, 'owner_only');
            continue;
          }
          if (await countOwnerPostsSinceQuestion(prisma, row) > 0) {
            engaged.push(row);
            releaseWhy.set(row.id, 'owner_engaged');
          }
        }
      } catch (err: any) {
        await logOwnerQuestions('warn', `owner-questions: triage early-release probe failed: ${err?.message ?? err}`);
      }
    }
    for (const row of engaged) {
      const flip = await prisma.ownerQuestion.updateMany({
        where: { id: row.id, status: 'open', triage: 'supervisor' },
        data: { triage: 'surfaced' },
      });
      if (flip.count === 0) continue; // answered / dismissed / surfaced in the race
      surfaced++;
      const why = releaseWhy.get(row.id) ?? 'owner_engaged';
      void logOwnerQuestions('info', why === 'owner_only'
        ? `owner-questions: ${row.id} released from supervisor triage EARLY — the card classes owner-only, so no supervisor could ever answer or withdraw it`
        : `owner-questions: ${row.id} released from supervisor triage EARLY — the owner posted in the filing chat after it was filed`);
      void recordOwnerQuestionMetric('owner_question_triage_early_released', {
        questionId: String(row.id).slice(0, 11), chatId: String(row.chatId).slice(0, 8), reason: why,
      }, row.chatId);
      // The owner is engaged RIGHT NOW — send it immediately, never into the
      // 12 h digest queue (a batched card is the same delay under another name).
      const engagedOptions = parseStoredOptions((row as any).options);
      await notifyOwnerOfNewFlag({
        userId: row.userId, question: row.question, options: engagedOptions.length ? engagedOptions : undefined, questionId: row.id,
        idleUsdPerDay: (row as any).idleUsdPerDay ?? undefined,
        defaultAfterDays: (row as any).defaultAfterDays ?? undefined,
        defaultOption: (row as any).defaultOption ?? undefined,
        heldForSupervisor: true,
        ...(parseStoredConsoleAction((row as any).consoleAction) ? { consoleAction: true } : {}),
      });
    }
    for (const row of due ?? []) {
      const flip = await prisma.ownerQuestion.updateMany({
        where: { id: row.id, status: 'open', triage: 'supervisor' },
        data: { triage: 'surfaced' },
      });
      if (flip.count === 0) continue; // answered, or surfaced by a peer sweeper, in the race
      surfaced++;
      void logOwnerQuestions('info', `owner-questions: ${row.id} surfaced to the owner — the Fleet Supervisor did not answer within the triage SLA`);
      // OWNER-INTERRUPT-ECONOMY (owner rule 2026-10-20): a surfaced card is
      // batched like a fresh one — owner-only / urgent / high cost-of-delay
      // DM at once, the rest join the 12 h digest anchored at the moment it
      // SURFACED (below). An unreadable marker or a failed queue write sends
      // the DM at once (fail toward delivery).
      try {
        const economy = await import('./owner-interrupt-economy');
        let urgent = false;
        let markerOk = true;
        try { urgent = (await economy.readEconomyMarker(row.id))?.urgent === true; } catch { markerOk = false; }
        if (markerOk) {
          const ownerOnly = economy.ownerOnlyInterruptReason(row.question, (row as any).context ?? null, {
            credentialGate: parseExpectedAnswerType((row as any).expectedAnswerType, row.question).type === 'credential',
            consoleAction: !!parseStoredConsoleAction((row as any).consoleAction),
          });
          const verdict = economy.classifyOwnerQuestionDelivery({ ownerOnlyReason: ownerOnly, urgent, idleUsdPerDay: (row as any).idleUsdPerDay ?? null });
          // Review 2026-10-20: anchored at the moment the card SURFACED to the
          // owner (its triageUntil — the first moment it was owner-facing),
          // not its filing: a filing anchor made a card held ~2 h in triage
          // due well under 12 h after the previous digest. The 12 h wait runs
          // from when the owner could first see the card.
          const surfacedMs = new Date((row as any).triageUntil ?? now).getTime();
          if (verdict.delivery === 'digest' && await economy.queueOwnerDigestEntry({
            userId: row.userId, questionId: row.id, kind: 'question',
            anchorAt: new Date(Number.isFinite(surfacedMs) && surfacedMs <= now.getTime() ? surfacedMs : now.getTime()),
          })) {
            continue;
          }
        }
      } catch { /* fall through to the immediate DM */ }
      const options = parseStoredOptions((row as any).options);
      await notifyOwnerOfNewFlag({
        userId: row.userId, question: row.question, options: options.length ? options : undefined, questionId: row.id,
        idleUsdPerDay: (row as any).idleUsdPerDay ?? undefined,
        defaultAfterDays: (row as any).defaultAfterDays ?? undefined,
        defaultOption: (row as any).defaultOption ?? undefined,
        heldForSupervisor: true,
        ...(parseStoredConsoleAction((row as any).consoleAction) ? { consoleAction: true } : {}),
      });
    }
  } catch (err: any) {
    await logOwnerQuestions('warn', `owner-questions: triage surfacing sweep failed: ${err?.message ?? err}`);
  }
  return surfaced;
}

/**
 * Shared-project second chance (ticket 973d7f80, 2026-09-19) — the probe-side
 * half of the cross-tenant tug-of-war fix. The caller-scoped resolution above
 * is CORRECT for inbox privacy, but in a SHARED project it made the OTHER
 * member's real gate card indistinguishable from a hallucinated id: the New
 * Hampshire saga (d76750f5 → be94fa64 → c286ba91) saw both sides diagnose the
 * other's LIVE card as "phantom" and re-point the shared todo's gate at their
 * own card (verified flips 9/18 14:21Z, 20:31Z, 9/19 02:28Z + 08:12Z).
 *
 * Given an id the caller-scoped probe could NOT resolve, this asks: does the
 * row exist for ANOTHER account AND is it linked to a project the caller can
 * read (via its store linkage goalId/todoId, or via gating a goal/todo there)?
 * Only then is it reported — as METADATA (id, status, store linkage), never
 * the question/answer/options text, which stays with the owning account. A row
 * with no caller-readable linkage stays "unmatched": no cross-tenant existence
 * oracle. Access uses goals.service's getProjectAccess (DYNAMIC import — keeps
 * the module graph acyclic) so owner/member/ancestor-inherited reads all count,
 * exactly like every goals read surface.
 *
 * Best-effort: any probe failure degrades to the legacy "unmatched" answer
 * (logged) — the caller-scoped verdict stays correct on its own.
 */
export interface SharedOwnerQuestionBrief {
  id: string;
  status: string;
  ownedByOtherMember: true;
  goalId: string | null;
  todoId: string | null;
  createdAt: Date; // ticket 56284f30 (cosmetic): was `any` — prisma hands back a Date
}

/** Probe → prisma where-clause (≥8 chars = prefix, else exact) and its JS-side
 *  matcher — ONE definition shared by the caller-scoped resolution and the
 *  shared-project second chance (ticket 56284f30: the two copies had drifted). */
const oqIdWhereForProbe = (probe: string) => (probe.length >= 8 ? { id: { startsWith: probe } } : { id: probe });
const oqIdMatchesProbe = (id: string, probe: string): boolean =>
  probe.length >= 8 ? id.startsWith(probe) : id === probe;

/**
 * Ticket 56284f30 (F3): a second-chance failure used to degrade to
 * "unmatched" with a logger-only warn — a real prod failure mode invisible to
 * the metrics surface. The warn now rides WITH a loop_metrics counter (lazy
 * import: the static-import ban in the file header covers loop-metrics too —
 * it statically pulls config/database).
 */
async function sharedSecondChanceFailed(probes: string[], err: any): Promise<void> {
  const message = String(err?.message ?? err);
  await logOwnerQuestions('warn', `owner-questions: shared-project second chance failed for "${probes.join(', ')}": ${message}`);
  try {
    const { recordLoopMetric, LOOP_METRIC_KINDS } = await import('./loop-metrics.service');
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SHARED_OQ_SECOND_CHANCE_FAILED,
      meta: { probes: probes.length, error: message.slice(0, 300) },
    });
  } catch {
    /* telemetry must never break the probe path */
  }
}

/**
 * Shared-project second chance — BATCHED (ticket 56284f30 F4): ONE
 * cross-tenant candidate query covers the whole unmatched set (previously ~5
 * round-trips × ≤50 ids: candidates + store linkage + gate linkage per id).
 * Per-ROW project resolution still runs per row, but only for rows that
 * actually resolve (typically zero — the second chance fires on
 * caller-unmatched ids only).
 *
 * Gate linkage (ticket 56284f30 F2): rows linked SOLELY via a pre-guard
 * LEGACY prefix gate — the stored gateQuestionId is a ≥8-char PREFIX of the
 * row's full id — never matched the old exact-match probe and stayed
 * unmatched. The startsWith scan on the row id's first 8 chars covers
 * full-id AND prefix storage in one pass; the JS filter keeps only
 * exact-or-prefix matches (a longer divergent id sharing 8 chars is correctly
 * rejected). Best-effort: any probe failure degrades to the legacy
 * "unmatched" answer (logged + telemetered) — the caller-scoped verdict
 * stays correct on its own.
 */
async function resolveSharedProjectOwnerQuestions(
  prisma: any,
  probes: string[],
  callerUserId: string,
): Promise<{ shared: SharedOwnerQuestionBrief[]; stillUnmatched: string[] }> {
  const shared: SharedOwnerQuestionBrief[] = [];
  const stillUnmatched: string[] = [];
  if (!probes.length) return { shared, stillUnmatched };
  let candidates: any[];
  try {
    // Same resolution semantics as the caller-scoped path (≥8 chars → prefix).
    candidates = await prisma.ownerQuestion.findMany({
      where: { OR: probes.map(oqIdWhereForProbe) },
      select: { id: true, userId: true, status: true, goalId: true, todoId: true, createdAt: true },
    });
  } catch (err: any) {
    await sharedSecondChanceFailed(probes, err);
    return { shared, stillUnmatched: [...probes] };
  }
  const rows = Array.isArray(candidates) ? candidates : [];
  for (const probe of probes) {
    try {
      const matches = rows.filter((r: any) => oqIdMatchesProbe(String(r.id), probe));
      // Zero rows (true phantom) or an ambiguous cross-tenant prefix — either
      // way there is no single row to point at, so stay unmatched.
      if (matches.length !== 1) { stillUnmatched.push(probe); continue; }
      const row = matches[0];
      if (row.userId === callerUserId) { stillUnmatched.push(probe); continue; } // defensive: own rows resolve in the main path
      const projectIds = new Set<string>();
      if (row.todoId) {
        const t = await prisma.projectTodo.findUnique({ where: { id: row.todoId }, select: { projectId: true } });
        if (t?.projectId) projectIds.add(t.projectId);
      }
      if (row.goalId) {
        const g = await prisma.projectGoal.findUnique({ where: { id: row.goalId }, select: { projectId: true } });
        if (g?.projectId) projectIds.add(g.projectId);
      }
      const gatePrefix = row.id.slice(0, 8);
      const [gateTodos, gateGoals] = await Promise.all([
        prisma.projectTodo.findMany({ where: { gateQuestionId: { startsWith: gatePrefix } }, select: { gateQuestionId: true, projectId: true }, take: 25 }),
        prisma.projectGoal.findMany({ where: { gateQuestionId: { startsWith: gatePrefix } }, select: { gateQuestionId: true, projectId: true }, take: 25 }),
      ]);
      const storedGateMatchesRow = (stored: any): boolean => {
        const s = String(stored ?? '').trim();
        return !!s && (s === row.id || (s.length >= 8 && row.id.startsWith(s)));
      };
      for (const t of gateTodos ?? []) if (storedGateMatchesRow(t?.gateQuestionId) && t?.projectId) projectIds.add(t.projectId);
      for (const g of gateGoals ?? []) if (storedGateMatchesRow(g?.gateQuestionId) && g?.projectId) projectIds.add(g.projectId);
      if (!projectIds.size) { stillUnmatched.push(probe); continue; }
      // Lazy import stays BEHIND a resolved linkage (pre-56284f30 laziness):
      // suites exercising the caller-scoped path alone must never pull
      // goals.service → config/env into their jest graph.
      const { getProjectAccess } = await import('./goals.service');
      let readable = false;
      for (const projectId of projectIds) {
        // READ-level access (owner OR any member, viewer included) is enough —
        // the hint discloses metadata only, and the gate id itself already
        // renders on that project's todo_get/goal_get for the same caller.
        if (await getProjectAccess(projectId, callerUserId)) { readable = true; break; }
      }
      if (!readable) { stillUnmatched.push(probe); continue; }
      shared.push({
        id: row.id,
        status: row.status ?? 'open',
        ownedByOtherMember: true,
        goalId: row.goalId ?? null,
        todoId: row.todoId ?? null,
        createdAt: row.createdAt,
      });
    } catch (err: any) {
      await sharedSecondChanceFailed([probe], err);
      stillUnmatched.push(probe);
    }
  }
  return { shared, stillUnmatched };
}

/**
 * Gate-state probe (2026-09-12 spark-stall incident): the owner's
 * owner_questions rows by id(s) or in list form, at ANY status — the service
 * half of the list_owner_questions tool. The incident: a lane reported the
 * dflash2 throughput run parked on "two of your inbox cards" when BOTH cards
 * were already answered (one a full day earlier) and the owner's inbox showed
 * nothing spark-related — no surface let the lane, the supervisor, or a wake
 * note fresh-verify a gate's live state, so stale-gate claims survived every
 * sweep. This read closes that: before reporting anything as "waiting on the
 * owner", pull the gate rows fresh and act on what they actually say.
 *
 * Owner-scoped (userId — the caller's own questions only); the ids/chatId
 * filters are intersected with it. `status` defaults to no filter (ALL
 * statuses) precisely so the caller can see answered/dismissed gates — the
 * open-only view is listOpenOwnerQuestionsForUser.
 *
 * ids resolution (ticket 8bae9959): each supplied id may be the FULL id OR a
 * unique ≥8-char prefix of it (the oq_-prefixed short form lane relays and
 * attention blocks cite, e.g. "oq_9a0e5a3a" — the supervisor evidence rules
 * make lanes cite ids as their first 8 chars, so the probe must accept that
 * form). Previously the filter was an exact `id IN (…)` — a prefix probe
 * matched NOTHING and the tool replied "resolved or never existed" about a
 * LIVE open gate (the false-cleared-gate hazard this read exists to kill).
 * Exact ids ride the same startsWith operator (a full id is a prefix of
 * itself). An ambiguous prefix returns EVERY candidate row (read-only probe —
 * showing two live statuses beats showing none). Supplied ids that match no
 * row come back in unmatchedIds so the caller can report them honestly
 * instead of the blanket "never existed".
 */
export async function listOwnerQuestionsForUser(
  userId: string,
  opts: { status?: string; ids?: string[]; chatId?: string; limit?: number; includeTriaged?: boolean } = {},
): Promise<{ rows: OwnerQuestionView[]; unmatchedIds: string[]; sharedRows: SharedOwnerQuestionBrief[] }> {
  const prisma = await db();
  const now = new Date(Date.now());
  const status =
    opts.status === 'open' || opts.status === 'answered' || opts.status === 'dismissed'
      ? opts.status
      : undefined;
  const limit = Math.min(Math.max(1, Number(opts.limit) || 25), 100);
  const ids = [...new Set((Array.isArray(opts.ids) ? opts.ids.map((s) => String(s).trim()).filter(Boolean) : []))].slice(0, 50);
  const where: Record<string, unknown> = { userId };
  if (status) where.status = status;
  if (opts.chatId) where.chatId = String(opts.chatId);
  const unmatchedIds: string[] = [];
  const sharedRows: SharedOwnerQuestionBrief[] = [];
  if (ids.length) {
    // ONE owner-scoped candidate query (id is the PK — a startsWith range scan
    // is indexed; the table is small per owner). Resolution is deliberately
    // NOT intersected with the status/chatId/triage filters: an id that
    // resolves to a real row is never reported "unmatched" just because a
    // filter hides the row — that distinction is exactly what the tool's
    // no-match guidance hinges on.
    const candidates = await prisma.ownerQuestion.findMany({
      where: { userId, OR: ids.map(oqIdWhereForProbe) },
      select: { id: true },
    } as any);
    const resolved: string[] = [];
    const seen = new Set<string>();
    for (const s of ids) {
      const matches = candidates.filter((c: any) => oqIdMatchesProbe(String(c.id), s));
      if (!matches.length) { unmatchedIds.push(s); continue; }
      for (const m of matches) if (!seen.has(m.id)) { seen.add(m.id); resolved.push(m.id); }
    }
    // Ticket 973d7f80: before ANY unmatched id is reported as never-existed,
    // give it the shared-project second chance — a REAL row owned by another
    // account comes back as metadata in sharedRows instead of feeding a
    // phantom misdiagnosis (and the next gate flip). Batched per ticket
    // 56284f30 (F4): ONE cross-tenant candidate query for the whole set.
    if (unmatchedIds.length) {
      const secondChance = await resolveSharedProjectOwnerQuestions(prisma, unmatchedIds, userId);
      for (const brief of secondChance.shared) sharedRows.push(brief);
      unmatchedIds.length = 0;
      unmatchedIds.push(...secondChance.stillUnmatched);
    }
    if (!resolved.length) return { rows: [], unmatchedIds, sharedRows };
    where.id = { in: resolved };
  }
  // Review 2026-09-13 issue 11: same default hide as the open-only view; the
  // list_owner_questions tool passes includeTriaged:true (the supervisor must
  // see the rows it is first responder for) and renders the marker.
  if (!opts.includeTriaged) Object.assign(where, notInTriageWhere(now));
  const rows = await prisma.ownerQuestion.findMany({
    where: where as any,
    orderBy: { createdAt: 'desc' },
    // Prefix expansion can resolve MORE rows than supplied ids (an ambiguous
    // prefix returns every candidate) — size the take off the resolved set.
    take: ids.length ? Math.max((where.id as any)?.in?.length ?? ids.length, limit) : limit,
  });
  return { rows: opts.includeTriaged ? rows.map((r) => ({ ...r, triaged: isOwnerQuestionInTriage(r, now) })) : rows, unmatchedIds, sharedRows };
}

export type OwnerQuestionResolution = 'ok' | 'ok_paste_refused' | 'not_found' | 'not_open' | 'ambiguous' | 'owner_engaged' | 'credential_pending' | 'reply_recorded' | 'owner_only_class';

/**
 * Append the resolution note to the originating chat's transcript so the agent
 * sees it on its next turn/wake. Same CrossModelMessage convention as the
 * orphan-recovery / attention-watchdog notices (role 'assistant' +
 * metadata.origin), plus the deliberate chat updatedAt bump so the note
 * surfaces in the updatedAt-sorted sidebar. BEST-EFFORT: a failure is logged,
 * never propagated — the owner's answer/dismiss must not be lost to a
 * transcript hiccup.
 */
async function postOwnerInboxNote(chatId: string, content: string): Promise<void> {
  try {
    const prisma = await db();
    await prisma.crossModelMessage.create({
      data: { chatId, role: 'assistant', content, metadata: { origin: 'owner-inbox' } },
    });
    await prisma.crossModelChat.update({ where: { id: chatId }, data: { updatedAt: new Date(Date.now()) } }).catch(() => {});
  } catch (err: any) {
    void logOwnerQuestions('warn', `owner-questions: transcript note failed for chat ${chatId}: ${err?.message ?? err}`);
  }
}

/**
 * Wake the chat on an owner resolution (2026-08-30 live audit — see header):
 * the transcript note alone waited for the chat's next scheduled wake. The
 * wake IS the note text (the run sees the resolution verbatim, and it persists
 * in the transcript via the machine-run path). A busy/failed wake is fine —
 * the transcript note remains for the next organic wake. NEVER throws; the
 * dynamic import keeps this module's import-time graph clean (see header).
 *
 * ARCHIVED-TARGET-RETIRE (c, 2026-10-20 + review): `kind` says what the wake
 * carries — only an 'answer' (owner / supervisor / preset default) is work an
 * archived lane would have acted on, so only an answer is re-routed; a
 * 'dismissal', 'superseded' notice or cross-chat 'duplicate' close aimed at an
 * archived chat is DROPPED (no wake, no retry — before this a supervisor's
 * own dismissal sweep of archived lanes' cards was echoed back to it as one
 * retry row per card). `alsoWakingChatIds` are the chats this SAME resolution
 * wakes (the asker / the linked forChatId, plus a supervisor an earlier
 * re-route of it already reached), `actorChatId` the chat whose turn
 * resolved it — the re-route never lands on either (no second turn on the
 * same answer). `laneRole` names the archived chat's role in the wake text.
 */
type OwnerResolutionWakeOpts = {
  kind: 'answer' | 'dismissal' | 'superseded' | 'duplicate';
  alsoWakingChatIds?: Array<string | null | undefined>;
  actorChatId?: string | null;
  laneRole?: 'asking' | 'linked';
  rerouted?: boolean;
};
async function wakeChatForOwnerResolution(
  chatId: string,
  content: string,
  questionId: string | undefined,
  opts: OwnerResolutionWakeOpts,
): Promise<string | null> {
  // Returns the supervisor an archived-target RE-ROUTE of this resolution
  // reached (null otherwise) — the caller's next wake for the same answer
  // passes it in alsoWakingChatIds so two archived chats on one question
  // (asker AND forChatId) never re-route the answer to one supervisor twice.
  let delivered = false;
  // ARCHIVED-TARGET-RETIRE (c, 2026-10-20): set when the wake was refused
  // because the asking chat is ARCHIVED — an answer is re-routed to the
  // project's supervisor (else the Fleet Supervisor), a notice is dropped, and
  // NO retry is armed onto the archived chat (it would be refused every ~3 min
  // for 24 h).
  let archivedTarget = false;
  try {
    const { dailyCapExceeded, refundDailyCapToken, fireScheduleTarget } = await import('../coding/schedule.service');
    const cap = await dailyCapExceeded(chatId);
    if (cap !== null) {
      void logOwnerQuestions('info', `owner-questions: wake for ${chatId.slice(0, 8)} skipped — chat at its ${cap}/day machine-run cap; the note awaits the next wake`);
    } else {
      const res = await fireScheduleTarget({ id: `owner-inbox-${randomUUID()}`, sessionId: chatId, prompt: content, origin: 'hook', dispatchSurface: 'owner_answer' });
      if (res.started) {
        delivered = true;
      } else {
        await refundDailyCapToken(chatId);
        archivedTarget = res.reason === 'archived';
        void logOwnerQuestions('info', `owner-questions: wake for ${chatId.slice(0, 8)} did not start (${res.reason ?? 'unknown'}); the note awaits the next wake`);
      }
    }
  } catch (err: any) {
    void logOwnerQuestions('warn', `owner-questions: wake failed for chat ${chatId}: ${err?.message ?? err}`);
  }
  if (archivedTarget) {
    const retired = await retireOwnerResolutionForArchivedChat(chatId, content, questionId, opts, 'wake');
    if (retired.handled) return retired.reroutedTo;
  }
  // Durable retry (remediation P2 v1#6): the immediate wake is fire-and-forget
  // — a busy chat, a capped budget, or a mid-deploy process death silently
  // parked the OWNER'S ANSWER until the next organic wake (hours on a 2h
  // sweep). When the immediate path did not start a run, arm a DB-backed
  // one-shot retry schedule (the schedule sweeper IS the durable wake outbox:
  // the row survives deploys, busy-skips re-arm every ~3 min, cap-skips retry
  // each interval until the 24h expiry). The hook outbox was considered and
  // rejected: HookEvent rows require a real EventHook FK and self-loop
  // suppression forbids a chat hooking itself — the schedule row is the
  // durable path that fits.
  if (!delivered) {
    try {
      const mod: any = await import('../coding/schedule.service');
      const res = await mod?.armOwnerAnswerRetrySchedule?.({
        sessionId: chatId,
        prompt: content,
        marker: questionId ? `[owner-answer-retry:${questionId}]` : `[owner-answer-retry:${chatId.slice(0, 8)}]`,
      });
      if (res?.ok) {
        void logOwnerQuestions('info', `owner-questions: durable answer-wake retry armed for ${chatId.slice(0, 8)} (schedule ${String(res.scheduleId ?? '').slice(0, 8)})`);
      } else if (res?.reason === 'archived') {
        // Review 2026-10-20: the immediate path never saw the archive (the
        // chat is at its daily machine-run cap, or a satellite-archived lane
        // answered 'busy') and the retry arm refused the archived target —
        // retire the resolution exactly like a wake refused 'archived', so
        // an owner answer is re-routed instead of reaching no live chat.
        return (await retireOwnerResolutionForArchivedChat(chatId, content, questionId, opts, 'retry_arm')).reroutedTo;
      }
    } catch (err: any) {
      void logOwnerQuestions('warn', `owner-questions: durable answer-wake arm failed for ${chatId.slice(0, 8)}: ${err?.message ?? err}`);
    }
  }
  return null;
}

/**
 * ARCHIVED-TARGET-RETIRE (c, 2026-10-20): what happens to an owner resolution
 * addressed to an ARCHIVED chat. `handled` is true when the retire took it
 * (the caller arms no retry); false when the kill switch is on (the pre-fix
 * path). A wake that was itself re-routed stops here (no second hop); a
 * notice (dismissal / superseded / duplicate) is dropped; an answer is
 * re-routed to the inheriting supervisor (`reroutedTo`). Never throws.
 */
async function retireOwnerResolutionForArchivedChat(
  chatId: string,
  content: string,
  questionId: string | undefined,
  opts: OwnerResolutionWakeOpts,
  seam: 'wake' | 'retry_arm',
): Promise<{ handled: boolean; reroutedTo: string | null }> {
  const retire = await import('./archived-target-retire').catch(() => null);
  if (!retire || retire.archivedTargetRetireDisabled()) return { handled: false, reroutedTo: null };
  // A re-routed wake that lands on another archived chat stops here — no
  // second hop, no retry (the transcript notes remain).
  if (opts.rerouted) return { handled: true, reroutedTo: null };
  if (opts.kind !== 'answer') {
    void logOwnerQuestions('info', `owner-questions: ${opts.kind} wake for ARCHIVED chat ${chatId.slice(0, 8)} dropped — a notice needs no action from a stopped lane (no re-route, no retry; the transcript note remains)`);
    retire.recordArchivedTargetRetire(chatId, { surface: 'owner_answer', action: 'dropped', outcome: `${opts.kind}_dropped`, seam, chatId, questionId: questionId ?? null });
    return { handled: true, reroutedTo: null };
  }
  return { handled: true, reroutedTo: await rerouteOwnerResolutionFromArchivedLane(chatId, content, questionId, opts, seam) };
}

/**
 * ARCHIVED-TARGET-RETIRE (c, 2026-10-20): an owner ANSWER addressed to an
 * ARCHIVED lane (its asker, or its linked forChatId) goes to the lane's
 * inheriting supervisor — the project's supervisor lane (supervision ON), else
 * the owner's Fleet Supervisor — as ONE wake carrying the question, the answer
 * and the archived lane id (archived-target-retire.ownerAnswerRerouteWake).
 * Skipped when that supervisor already gets the same answer (one of the
 * resolution's other woken chats — the asker or the linked lane) or is the
 * chat whose turn resolved it (the actor). A re-routed wake that does not
 * start arms its durable retry on the SUPERVISOR, never on the archived chat.
 * Returns the supervisor it re-routed to (null when skipped). Best-effort;
 * never throws.
 */
async function rerouteOwnerResolutionFromArchivedLane(
  archivedChatId: string,
  content: string,
  questionId: string | undefined,
  opts: OwnerResolutionWakeOpts,
  seam: 'wake' | 'retry_arm',
): Promise<string | null> {
  try {
    const retire = await import('./archived-target-retire');
    const lane = await retire.readArchivedTarget(archivedChatId);
    if (!lane?.userId) return null;
    const target = await retire.resolveLaneSupervisor({ userId: lane.userId, projectId: lane.projectId, excludeChatId: archivedChatId });
    const base = { surface: 'owner_answer', action: 'rerouted', seam, chatId: archivedChatId, laneRole: opts.laneRole ?? 'asking', questionId: questionId ?? null };
    if (!target) {
      void logOwnerQuestions('info', `owner-questions: wake for ARCHIVED lane ${archivedChatId.slice(0, 8)} not re-routed — no supervisor to inherit it; the transcript note remains`);
      retire.recordArchivedTargetRetire(archivedChatId, { ...base, outcome: 'no_supervisor' });
      return null;
    }
    const woken = new Set((opts.alsoWakingChatIds ?? []).filter((id): id is string => !!id));
    if (woken.has(target.id)) {
      void logOwnerQuestions('info', `owner-questions: wake for ARCHIVED lane ${archivedChatId.slice(0, 8)} not re-routed — its ${target.tier} supervisor ${target.id.slice(0, 8)} is already woken with the same answer (the question's asker / linked chat)`);
      retire.recordArchivedTargetRetire(archivedChatId, { ...base, outcome: 'linked_chat_woken', targetChatId: target.id, tier: target.tier });
      return null;
    }
    if (opts.actorChatId && target.id === opts.actorChatId) {
      void logOwnerQuestions('info', `owner-questions: wake for ARCHIVED lane ${archivedChatId.slice(0, 8)} not re-routed — its ${target.tier} supervisor ${target.id.slice(0, 8)} resolved the question itself (this turn)`);
      retire.recordArchivedTargetRetire(archivedChatId, { ...base, outcome: 'actor_is_target', targetChatId: target.id, tier: target.tier });
      return null;
    }
    const wake = retire.ownerAnswerRerouteWake({ archivedChatId, archivedTitle: lane.title, questionId: questionId ?? null, content, tier: target.tier, laneRole: opts.laneRole ?? 'asking' });
    void logOwnerQuestions('info', `owner-questions: wake for ARCHIVED lane ${archivedChatId.slice(0, 8)} re-routed to its ${target.tier} supervisor ${target.id.slice(0, 8)} (archived-target-retire)`);
    retire.recordArchivedTargetRetire(archivedChatId, { ...base, outcome: 'rerouted', targetChatId: target.id, tier: target.tier });
    await wakeChatForOwnerResolution(target.id, wake, questionId, { kind: 'answer', rerouted: true });
    return target.id;
  } catch (err: any) {
    void logOwnerQuestions('warn', `owner-questions: archived-lane re-route failed for ${archivedChatId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Answered-question ledger append (remediation P2 v1#5): record the Q/A as a
 * DONE directive in the owner's supervisor state doc, so no later wake can
 * claim the decision is still pending. Best-effort; never throws.
 */
async function appendAnswerToSupervisorLedger(userId: string, entry: { questionId: string; question: string; answer: string; counterQuestion?: boolean; sourceChatId?: string; answeredBy?: 'owner' | 'supervisor' | 'default'; sweeperAutoHeal?: boolean }): Promise<void> {
  // OWNER-PROVENANCE-STRICT (2026-10-20): `answeredBy` rides to the ledger so
  // a supervisor's / a preset default's answer is banked under ITS name and
  // origin, never "Owner ANSWERED" with the owner stamp (the default path and
  // the supervisor triage answer both used to land as the owner's ruling).
  const { sourceChatId, ...ledgerEntry } = entry;
  try {
    const target = await fleetSupervisorLedgerTarget(userId, sourceChatId);
    const { appendAnsweredQuestionDirective } = await import('./supervisor-state.service');
    if (target) await appendAnsweredQuestionDirective(target.supervisorId, userId, { ...ledgerEntry, ...(target.scope ? { scope: target.scope } : {}) });
    // OWNER-DIRECTIVE-FANOUT (2026-10-20): the same entry is MIRRORED onto the
    // ASKING project's supervisor ledger (idempotent per question) — the
    // project supervisor's wake reads only its own ledger, so a decision on a
    // card its own project filed was invisible to it.
    const mirror = await projectSupervisorLedgerTarget(userId, sourceChatId, target?.supervisorId);
    if (mirror) await appendAnsweredQuestionDirective(mirror.supervisorId, userId, { ...ledgerEntry, scope: mirror.scope, mirror: true });
  } catch (err: any) {
    void logOwnerQuestions('warn', `owner-questions: supervisor ledger append failed for ${entry.questionId}: ${err?.message ?? err}`);
  }
}

/**
 * The ASKING chat's PROJECT SUPERVISOR chat + that project's scope label —
 * the mirror target of a banked answer / ruling (OWNER-DIRECTIVE-FANOUT,
 * 2026-10-20). Null when the fan-out is disabled, the asking chat has no
 * project, the project has no (live) supervisor chat, or it IS the Fleet
 * Supervisor target. Best-effort: any read failure → null (no mirror).
 */
async function projectSupervisorLedgerTarget(userId: string, sourceChatId: string | undefined, fleetSupervisorId?: string): Promise<{ supervisorId: string; scope: string } | null> {
  if (ownerDirectiveFanoutDisabled() || !sourceChatId) return null;
  try {
    const prisma = await db();
    const chat = await (prisma as any).crossModelChat?.findUnique?.({
      where: { id: sourceChatId },
      select: { projectId: true, project: { select: { name: true } } },
    });
    const projectId = typeof chat?.projectId === 'string' ? chat.projectId : '';
    if (!projectId) return null;
    const ps = await (prisma as any).crossModelChat?.findFirst?.({
      where: { userId, projectId, isProjectSupervisor: true, archivedAt: null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!ps?.id || ps.id === fleetSupervisorId) return null;
    const scope = String(chat?.project?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return scope ? { supervisorId: String(ps.id), scope } : null;
  } catch {
    return null;
  }
}

/** The owner's Fleet Supervisor chat + the ASKING chat's project scope (null when the owner has no supervisor). */
async function fleetSupervisorLedgerTarget(userId: string, sourceChatId?: string): Promise<{ supervisorId: string; scope?: string } | null> {
  const prisma = await db();
  const supervisor = await (prisma as any).crossModelChat?.findFirst?.({
    where: { userId, isSupervisor: true }, select: { id: true },
  });
  if (!supervisor?.id) return null;
  // Ticket 661fb494: stamp the banked ruling with the ASKING chat's project
  // scope — a ledgered "Owner ANSWERED flagged question" directive without
  // its scope is exactly the record a later wake miscites cross-project.
  let scope: string | undefined;
  if (sourceChatId) {
    try {
      const chat = await (prisma as any).crossModelChat?.findUnique?.({
        where: { id: sourceChatId },
        select: { project: { select: { name: true } } },
      });
      const name = String(chat?.project?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      scope = name || 'ungrouped';
    } catch { scope = undefined; }
  }
  return { supervisorId: String(supervisor.id), ...(scope ? { scope } : {}) };
}

/**
 * Owner RULING capture (2026-10-20): the owner's own answer text, or the note
 * on a card the OWNER dismissed, that carries an order / permanent rule is
 * ledgered as an OPEN owner-origin directive on the Fleet Supervisor's ledger
 * (supervisor-state.service appendOwnerRulingDirective decides — deterministic,
 * idempotent per question). Only the owner's words: a supervisor / default /
 * agent / system resolution never reaches here. Best-effort; never throws.
 * Kill switch OWNER_RULING_CAPTURE_DISABLED=1.
 */
async function captureOwnerRulingOnSupervisorLedger(userId: string, entry: { questionId: string; question: string; ruling: string; source: 'answer' | 'dismissal'; sourceChatId?: string }): Promise<void> {
  try {
    const { appendOwnerRulingDirective, ownerRulingCaptureDisabled, classifyOwnerRuling } = await import('./supervisor-state.service');
    if (ownerRulingCaptureDisabled() || !classifyOwnerRuling(entry.ruling).ruling) return; // no DB read for the common non-ruling answer
    const target = await fleetSupervisorLedgerTarget(userId, entry.sourceChatId);
    const base = { questionId: entry.questionId, question: entry.question, ruling: entry.ruling, source: entry.source };
    if (target) await appendOwnerRulingDirective(target.supervisorId, userId, { ...base, ...(target.scope ? { scope: target.scope } : {}) });
    // OWNER-DIRECTIVE-FANOUT (2026-10-20): mirror onto the asking project's
    // supervisor ledger (same deterministic id — idempotent; project scope).
    // Review fix: STANDING rulings only. A non-standing ruling is banked on
    // the Fleet Supervisor's ledger with THIS project's scope, so the
    // [OWNER DIRECTIVES IN FORCE] block already carries it to this project's
    // supervisor and lanes (and drops it when the Fleet Supervisor closes it);
    // a mirror would be a second OPEN, evidence-less owner row that the
    // directive-age alarm chases on both ledgers and nothing closes with the
    // source. A standing mirror is never age-alarmed.
    if (classifyOwnerRuling(entry.ruling).standing) {
      const mirror = await projectSupervisorLedgerTarget(userId, entry.sourceChatId, target?.supervisorId);
      if (mirror) await appendOwnerRulingDirective(mirror.supervisorId, userId, { ...base, scope: mirror.scope, mirror: true });
    }
  } catch (err: any) {
    void logOwnerQuestions('warn', `owner-questions: owner ruling capture failed for ${entry.questionId}: ${err?.message ?? err}`);
  }
}

/**
 * Gate unblock fan-out (ticket 356d21bb): an answered ownerQuestion resolves
 * ALL derived gates — every todo/goal parked 'blocked' with gateQuestionId =
 * this row id flips actionable through goals.service's unblockOwnerGatedItems
 * (the ONE choke point). Dynamic import (goals.service statically pulls
 * config/database — see this module's header); never throws.
 */
async function unblockGatesForAnsweredQuestion(input: {
  userId: string;
  questionId: string;
  answer: string;
  question: string;
  source: string;
  /** The owner replied with a question (no decision) — the release note says so. */
  counterQuestion?: boolean;
  /** fadc3563: provenance for hold notes — a supervisor/default hold is never dressed as the owner's words. */
  answeredBy?: 'owner' | 'supervisor' | 'default';
  /** Chats this answer already woke — the board must not wake them again. */
  skipWakeChatIds?: string[];
}): Promise<void> {
  try {
    const { unblockOwnerGatedItems } = await import('./goals.service');
    await unblockOwnerGatedItems(input);
  } catch (err: any) {
    void logOwnerQuestions('warn', `owner-questions: gate unblock failed for ${input.questionId}: ${err?.message ?? err}`);
  }
}

/* ── Credential routing for owner card answers (ticket 50bcd1e7) ────────────
 * The 2026-10-16 incident (Schooltime Drive-watch, oq_312999fe): the owner
 * pasted a full GCP service-account JSON as a card answer; the PEM
 * private_key line arrived in BOTH the supervisor's and the lane's view as
 * "[REDACTED: looked like a credential]" while every other field came
 * through — the card is the OWNER's answer surface, and the inbound
 * redaction (item N9) destroyed the credential it was asked to deliver. The
 * lane had to file a follow-up re-paste card (oq_7a5f6c52), wasting an
 * owner interaction. An owner-question card is an owner-AUTHORED, one-hop,
 * owner-addressed surface: the answer is already at rest in its own DB row
 * under the owner's id, exactly like a chat message — but a chat paste
 * reaches lanes verbatim while a card answer had NO sanctioned hand-off, so
 * N9 redaction was the only leg with no counterpart.
 *
 * The fix routes the value the same sanctioned way store_secret does (audit
 * 2026-10-06 T2-3 — "a credential never rides a message"): BEFORE the N9
 * redaction, the raw answer is scanned with the shared scanner
 * (findSecretSpans) and each span is stored server-side into the encrypted
 * coding-credentials vault (upsertCredential — AES-256-GCM at rest, injected
 * into coding shells as $ENVKEY, scrubbed from shell output). envKey choice
 * (ca0b57cd + its review): the FIRST stored value rides the question's
 * DECLARED gate key when it has one; every span from a NAMED assignment
 * (`secret_access_key=<v>`) rides a LABEL-DERIVED envKey; the rest fall to
 * the ordinal question-derived OWNER_ANSWER_<id>[_N] key. Re-answers UPDATE
 * values under the SAME keys in place (the store_secret replace posture —
 * a same-named key, including a hand-set custom credential of that name, is
 * updated by a newer owner answer); an infra-managed row is never flipped.
 * A captured value that cannot store (the per-answer cap, an infra-managed
 * key) is named in the notice as NOT stored — never silently dropped. The stored row, the
 * transcript note and the wake prompt keep the REDACTED answer (unchanged
 * N9 posture — the value never rides a prompt or a transcript) and carry a
 * vault notice naming ONLY the envKey(s), so the woken lane uses
 * "$ENVKEY" instead of re-asking. Owner answers only; a supervisor or
 * default answer never routes to the vault. Never throws, never blocks the
 * answer: on any failure the value is redacted exactly as before (the
 * pre-fix behavior) and the notice names nothing.
 * Kill switch OWNER_ANSWER_VAULT_DISABLED=1 (registered, release kind). */

/** Kill switch for the owner-answer credential routing (ticket 50bcd1e7). */
function ownerAnswerVaultDisabled(): boolean {
  return process.env.OWNER_ANSWER_VAULT_DISABLED === '1';
}

const OQ_VAULT_MAX_SPANS = 3;
const OQ_VAULT_NOTE_PREFIX = '[CREDENTIAL VAULTED —';

/**
 * Normalize an owner-pasted span for the vault (pure): a literal-`\n` /
 * `\t` escaped paste (a PEM block inside a JSON service-account blob, the
 * 2026-10-16 incident shape) is unescaped so it stores as the REAL block —
 * credentials.service accepts multi-line values only as a well-formed PEM
 * block, and the escaped form is neither a usable key nor storable.
 * Surrounding quotes are stripped once. A value that (still) fails the
 * vault's own well-formedness is returned null — refused, never stored
 * broken (the pre-fix redaction stands for that span).
 */
function vaultCandidateValue(raw: string, isPemBlock: (v: string) => boolean): string | null {
  let v = String(raw ?? '');
  if (/\\[nrt]/.test(v)) v = v.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
  // Ticket b71367e5 (escaped-JSON residual): an escaped-slash value
  // (`"abC…\/xyz"` — a JSON-serialized key containing `/`) stores as the
  // REAL value, never its escaped serialization (the same rule as the
  // \n-unescape above).
  v = v.replace(/\\\//g, '/');
  if (/^["']/.test(v) && /["']$/.test(v) && v.length >= 2) v = v.slice(1, -1);
  v = v.trim();
  if (!v) return null;
  // Multi-line or PEM-header values are vaultable only as a COMPLETE block —
  // the same guard upsertCredential enforces, pre-checked here so a refusal
  // is a silent best-effort skip, not an error path.
  if (/[\n\r\0]/.test(v) || /^-----BEGIN\b/.test(v)) {
    if (!isPemBlock(v)) return null;
  }
  return v;
}

/**
 * Ticket ad4fae90 (2026-10-16): true when the owner submitted this answer
 * through the card's DEDICATED SECRET INPUT (credentialPaste: true — explicit
 * "this text IS the key" intent, the owner-authenticated REST surface only).
 * The whole-answer vault path runs ONLY on this intent: an implicit
 * declared-envKey leg was removed after adversarial review (finding B1/F2 —
 * any opaque token ≥16 chars with a digit or separator, including hyphenated
 * prose like "yes-use-the-staging-one" and git SHAs, silently minted as the
 * declared credential and lifted the gate; no shape heuristic separates
 * all-lowercase-hyphenated provider keys from prose). With intent, the WHOLE
 * trimmed answer is the candidate — multi-word values INCLUDED (a Gmail app
 * password in Google's displayed "abcd efgh ijkl mnop" form, a passphrase)
 * — guarded only by vaultCandidateValue (non-empty, \n-unescape, quote
 * strip, PEM well-formedness) and the [REDACTED marker refusal. Pure.
 */
export function explicitPasteValue(raw: string, isPemBlock: (v: string) => boolean): string | null {
  const v = vaultCandidateValue(raw, isPemBlock);
  if (!v) return null;
  if (/^\[REDACTED/i.test(v)) return null; // already-redacted text is not a value
  return v;
}

/** True when a reply is a single opaque token (no whitespace, ≥12 chars) —
 *  used to WITHHOLD the verbatim quote from the stored mismatch record: for a
 *  shape the scanner does not know, the redaction pass missed it and quoting
 *  it persisted the raw key on the row (ticket ad4fae90). Pure. */
export function isOpaqueTokenShape(text: string): boolean {
  const t = String(text ?? '').trim();
  return t.length >= 12 && /^[A-Za-z0-9_\-.=+/:@]+$/.test(t);
}

/** Derive the vault envKey for a question: OWNER_ANSWER_<8 id chars>[_2..].
 *  Alphabetic, ≤64 chars (ENV_KEY_RE), not deny-listed, stable across
 *  re-answers of the same question. The id fragment is UPPERCASED — oq_ ids
 *  carry lower-case uuid hex, and ENV_KEY_RE admits upper-case only. */
function ownerAnswerEnvKey(questionId: string, ordinal: number): string | null {
  const suffix = String(questionId ?? '').replace(/[^0-9A-Za-z]/g, '').slice(0, 8).toUpperCase();
  if (!suffix) return null;
  const key = ordinal <= 1 ? `OWNER_ANSWER_${suffix}` : `OWNER_ANSWER_${suffix}_${ordinal}`;
  return key.length <= 64 ? key : null;
}

export interface OwnerAnswerVaultResult {
  /** Appended to the stored answer / transcript note / wake prompt. Names
   *  envKey(s) only — never a value. Empty string when nothing was vaulted. */
  notice: string;
  /** envKey(s) actually stored (telemetry / tests). */
  envKeys: string[];
  /** Ticket ad4fae90: the WHOLE answer was the paste and was vaulted (no span
   *  matched — the dedicated secret-input path or the declared-envKey
   *  fallback). The answer path then stores the vault notice INSTEAD of the
   *  redacted answer text: an unknown-shape token is not redactable by the
   *  N9 scan either, so storing the text would persist the raw key. */
  wholeAnswerVaulted: boolean;
}

/**
 * Route the credential spans of an OWNER-authored card answer to the vault
 * (ticket 50bcd1e7). Call BEFORE the N9 redaction, with the RAW answer.
 * Best-effort: every failure degrades to { notice: '', envKeys: [] } (the
 * pre-fix redaction-only behavior) and never blocks the answer.
 */
async function vaultOwnerAnswerSecrets(
  userId: string,
  questionId: string,
  rawAnswer: string,
  opts: { answeredBy: 'owner' | 'supervisor' | 'default'; declaredEnvKey?: string; credentialPaste?: boolean },
): Promise<OwnerAnswerVaultResult> {
  const none: OwnerAnswerVaultResult = { notice: '', envKeys: [], wholeAnswerVaulted: false };
  try {
    if (ownerAnswerVaultDisabled()) return none;
    // Only the OWNER's own answers carry authorized credentials — a
    // supervisor ruling or a default auto-answer restates text the run
    // already held, and must never mint a vault credential.
    if (opts.answeredBy !== 'owner') return none;
    const { findSecretSpans } = await import('./secret-scan');
    const raw = String(rawAnswer ?? '');
    const spans = findSecretSpans(raw);
    // Ticket ad4fae90 — the dedicated paste path, EXPLICIT INTENT ONLY. The
    // owner submitted the answer through the card's secret input
    // (credentialPaste: true) — the span scan is shape-driven and a provider
    // prefix SECRET_PATTERNS does not know is the documented refusal machine
    // (cfat_ 82dd8756, tskey- 4e8257c4), so with intent the WHOLE answer is
    // the candidate (multi-word values included — a Gmail app password in its
    // displayed "abcd efgh ijkl mnop" form is a real key form). An IMPLICIT
    // declared-envKey leg existed here pre-review and was removed (finding
    // B1/F2: no shape heuristic separates hyphenated prose from keys, and a
    // refused paste leaked through the mismatch record's verbatim quote).
    const candidates: Array<{ value: string; label?: string; spanName?: string; paste?: boolean }> = spans.map((s: { value: string; label?: string; name?: string }) => ({ value: s.value, ...(s.label ? { label: s.label } : {}), ...(s.name ? { spanName: s.name } : {}) }));
    const wholeAnswerPaste = !spans.length
      && opts.credentialPaste === true
      && !!explicitPasteValue(raw, (await import('../coding/credentials.service')).isPemBlock);
    if (wholeAnswerPaste) candidates.push({ value: raw, paste: true });
    if (!candidates.length) return none;
    const prisma = await db();
    const creds: any = await import('../coding/credentials.service');
    if (typeof creds?.upsertCredential !== 'function' || typeof creds?.isPemBlock !== 'function') return none;
    // Composition with typed credential gates (e90db560c): a CREDENTIAL-
    // gated row declares the envKey the answer must carry. The declared key is
    // assigned to the first candidate that FITS the declared slot (validated by
    // upsertCredential's own ENV_KEY_RE/DENIED_ENV_KEYS guards — a malformed
    // declaration simply falls through to the derived key) so credentialLifted's
    // store-state check lifts the gate on this very answer.
    const declaredEnvKey = String(opts.declaredEnvKey ?? '').trim().toUpperCase() || null;
    // Ticket ca0b57cd: a span from a NAMED assignment (`secret_access_key=…`)
    // carries the owner's own name for the value — store it under a
    // LABEL-DERIVED envKey (normalized UPPER_SNAKE, validated by the same
    // ENV_KEY_RE/DENIED_ENV_KEYS guards, deduped against keys already used
    // this answer) so a multi-value answer vaults EACH value under the name
    // the owner wrote, never "first value only". A label that fails the
    // guards or collides falls back to the ordinal derived key — a named
    // value is never silently dropped for naming reasons.
    const labelEnvKey = (label: string | undefined): string | null => {
      const norm = String(label ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (!norm || !creds.ENV_KEY_RE.test(norm) || creds.DENIED_ENV_KEYS.has(norm)) return null;
      if (norm === declaredEnvKey || storedKeys.includes(norm)) return null;
      return norm;
    };
    const storedKeys: string[] = [];
    const seenValues = new Set<string>();
    const normalizeLabel = (label: string | undefined): string =>
      String(label ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    // Review A7 (of 64705f7a8) + delta-review #3 (of 722064990): a captured
    // value that cannot store — the per-answer cap, an infra-managed key, a
    // refused label key, a value the vault's own well-formedness rejects —
    // was redacted from the row AND absent from the vault with NO notice
    // (the early return skipped the warning entirely when nothing stored).
    // Captured-but-unstored values are now counted and NAMED in the notice
    // (label, span name or ordinal) so the owner knows to re-supply them.
    const unstored: string[] = [];
    const nameOf = (i: number, c: { label?: string; spanName?: string; paste?: boolean }): string =>
      String(c.label ?? c.spanName ?? (c.paste ? 'the pasted value' : `value ${i + 1}`));
    // ── Ticket c54074df / 7caf07ed (2026-10-21): the declared key is routed by
    // FIT, never by span position. The incident: the owner pasted both halves
    // of an AWS pair (`…_access_key=AKIA…, …_secret_access_key=<40c>`) on a
    // SECRET-declared card; the AKIA provider span is pushed BEFORE the
    // named-compound secret span, so the positional first-span rule minted the
    // 20-char KEY ID as the SECRET and the corridor measured a secret
    // byte-equal to the key-ID row. Each candidate is scored against the
    // declared slot (fitScore below — the family-aware scheme); the
    // best-scoring span claims the slot, ties breaking positionally. A
    // candidate that does not take the declared slot falls through to the
    // label/ordinal keys — never dropped, never silently landed on the slot.
    // (17d64418 (a): the first cut's "2 + overlap" word-share score list and
    // its declaredWords helper died with the family-aware rewrite — removed
    // so the next maintainer models the real router.)
    const slotMismatchOf = (value: string): string | null => {
      if (!declaredEnvKey) return null;
      if (typeof creds.valueSlotMismatch !== 'function') return null; // mocked-module posture — cannot disprove
      return creds.valueSlotMismatch(declaredEnvKey, value);
    };
    // Family-aware fit scoring (review findings 1/3 + the ca0b57cd/b71367e5
    // regression battery): the owner's own assignment LABEL (`secret_access_key=…`,
    // `db_password=…`) names the FAMILY of the value it carries. A label whose
    // family contradicts the declared slot is an ANTI-signal — the first cut
    // scored bare word overlap, so `canlaw_cpt_s3_secret_access_key=<40c>`
    // (shares CANLAW/CPT/S3 with the declared CANLAW_CPT_S3_KEY) stole the
    // KEY-ID slot on a pair paste: the mirror image of the incident. Scores:
    //   0 — the value slot-MISMATCHES the declared key (never);
    //   0 — the label names the OPPOSITE AWS-pair family (anti-signal);
    //   4 — the label IS the declared envKey (exact, normalized);
    //   3 — the label's family matches the declared slot's family;
    //   1 — neutral (no label, or the slot names no AWS-pair family) — the
    //       legacy positional claim. Ties break POSITIONALLY (first span), the
    //       pre-fix behavior the ca0b57cd label-collision pin requires.
    const declaredFamily: string | null = typeof creds.awsSlotFamily === 'function' ? creds.awsSlotFamily(declaredEnvKey ?? '') : null;
    const fitScore = (c: { value: string; label?: string }): number => {
      if (!declaredEnvKey) return 0;
      if (slotMismatchOf(c.value)) return 0;
      const norm = normalizeLabel(c.label);
      if (norm && norm === declaredEnvKey) return 4;
      if (typeof creds.awsSlotFamily === 'function' && c.label) {
        const lf = creds.awsSlotFamily(norm);
        if (lf && declaredFamily && lf !== declaredFamily) return 0;
        if (lf && declaredFamily && lf === declaredFamily) return 3;
      }
      return 1;
    };
    // Normalize every candidate ONCE (quote-strip / \n-unescape / PEM
    // well-formedness) so fit and store see the exact value that vaults.
    const normalized: Array<{ value: string; label?: string; spanName?: string; paste?: boolean }> = [];
    for (let i = 0; i < candidates.length; i++) {
      const value = vaultCandidateValue(candidates[i].value, creds.isPemBlock);
      if (value) normalized.push({ ...candidates[i], value });
      else unstored.push(nameOf(i, candidates[i]));
    }
    // Paste intent (the card's dedicated secret input says "this whole text IS
    // the key"): when spans exist but NONE fits the declared slot, the WHOLE
    // pasted text is the declared-slot candidate — span scanning must not
    // silently override the owner's explicit submission (the 18:25Z shape: a
    // stray sibling span present, the real secret scanner-unknown).
    let pasteCandidate: string | null = null;
    if (opts.credentialPaste === true && spans.length > 0) {
      const whole = explicitPasteValue(raw, creds.isPemBlock);
      if (whole && !normalized.some((c) => c.value === whole)) pasteCandidate = whole;
    }
    // Resolve the declared-slot assignment: the unique best-scoring span wins
    // (a fitting span beats the whole-paste text — the pair-in-secret-field
    // shape vaults the SECRET half, not the whole two-value string); a
    // score-1 positional claim is granted only when it is the SOLE claimant;
    // with no fitting span, the whole-paste candidate claims it; a whole-paste
    // value that slot-MISMATCHES the declared key is refused for that slot and
    // named unstored (the paste went to the wrong card — the gate stays honest).
    let declaredAssignIdx = -1;
    let declaredPasteValue: string | null = null;
    if (declaredEnvKey) {
      const scores = normalized.map((c) => fitScore(c));
      const max = scores.length ? Math.max(...scores) : 0;
      // The unique best score claims the slot; ties break POSITIONALLY (the
      // first span) — the pre-fix behavior the b71367e5 A8 pin (an unlabeled
      // key ID + a labeled db_password on a KEY card: the key ID, first, takes
      // it) and the ca0b57cd label-collision pin (two spans both labeled the
      // declared key: the first rides it, the second falls to the ordinal)
      // both require. The ABSOLUTE zeros — a slot-mismatched value, a
      // cross-family label — can never claim, tie or not.
      if (max > 0) declaredAssignIdx = scores.findIndex((s) => s === max);
      if (declaredAssignIdx < 0 && pasteCandidate !== null) {
        // Review finding B: a paste that CONTAINS a value already refused for
        // this slot (the bare `AKIA… <40c>` pair through the key field — the
        // AKIA span mismatches, the bare 40-char half is scanner-uncapturable)
        // is the PAIR, not the secret: storing the whole text verbatim would
        // mint a two-token "secret" that then LIFTS the gate. Refuse and name
        // it — the owner pastes only the value the card asked for.
        const mismatchedSpan = normalized.find((c) => !!slotMismatchOf(c.value));
        if (mismatchedSpan) {
          unstored.push('the pasted value (refused for this slot — it contains a value that belongs in a DIFFERENT slot; paste only the value this card asked for)');
        } else if (!slotMismatchOf(pasteCandidate)) {
          declaredPasteValue = pasteCandidate;
        } else {
          unstored.push('the pasted value (refused for this slot — the value looks like a different credential than the card asked for)');
        }
      }
    }
    for (let i = 0; i < normalized.length; i++) {
      const c = normalized[i];
      if (seenValues.has(c.value)) continue; // same value matched twice — store once
      if (storedKeys.length >= OQ_VAULT_MAX_SPANS) { unstored.push(nameOf(i, c)); continue; }
      const envKey = i === declaredAssignIdx
        ? declaredEnvKey
        : (c.label ? labelEnvKey(c.label) : null)
          ?? ownerAnswerEnvKey(questionId, storedKeys.length + 1);
      if (!envKey) { unstored.push(nameOf(i, c)); continue; }
      const existing = await prisma.codingCredential
        .findUnique({ where: { userId_envKey_label: { userId, envKey, label: '' } } })
        .catch(() => null);
      if (existing && String(existing.provider) !== 'custom') { unstored.push(nameOf(i, c)); continue; } // never flip an infra-managed row
      // Review finding 2 (tickets c54074df/7caf07ed): a value the vault will
      // DETERMINISTICALLY refuse (a slot mismatch on a label/ordinal key, a
      // shape the vault rejects) is pre-checked and NAMED unstored — the
      // thrown-store escape below stays for INFRA failures only (the per-user
      // cap, a DB error), preserving the pinned cap-exhaustion posture of
      // 50bcd1e7 N1 (answer survives, no notice) while a refused VALUE can
      // never abort the whole leg and silently drop its siblings.
      if (typeof creds.valueSlotMismatch === 'function' && envKey !== declaredEnvKey) {
        const refusal = creds.valueSlotMismatch(envKey, c.value);
        if (refusal) { unstored.push(nameOf(i, c)); continue; }
      }
      // A THROWN store (the per-user cap, a DB error) keeps the pinned 50bcd1e7
      // N1 posture: the throw escapes to the outer best-effort catch, the
      // answer survives, no notice — never a new silent catch at the loop.
      await creds.upsertCredential(userId, 'custom', envKey, c.value, '');
      storedKeys.push(envKey);
      seenValues.add(c.value);
    }
    // The whole-paste candidate stores LAST, only when it claimed the declared
    // slot (it exists for that slot alone; when a span already fit, the whole
    // text is redundant and is never vaulted as a second value).
    // 17d64418 (b): the per-answer cap guard used to sit in the `if`
    // condition — when the span loop had already filled the cap (three
    // contradictory-labeled spans + paste intent), the paste candidate was
    // silently dropped while the notice claimed every capture stored. Same
    // fix shape as the per-value guards above: a refused paste is NAMED
    // unstored, never silently dropped.
    if (declaredPasteValue !== null && !seenValues.has(declaredPasteValue)) {
      if (storedKeys.length >= OQ_VAULT_MAX_SPANS) {
        unstored.push('the pasted value');
      } else {
        try {
          await creds.upsertCredential(userId, 'custom', declaredEnvKey as string, declaredPasteValue, '');
          storedKeys.push(declaredEnvKey as string);
          seenValues.add(declaredPasteValue);
        } catch {
          unstored.push('the pasted value');
        }
      }
    }
    if (!storedKeys.length && !unstored.length) return none;
    // Delta-review #6: cap the unstored name list so the notice tail can
    // never crowd the $ENVKEY list out of ANSWER_MAX on a pathological
    // many-span answer (values are never named — labels/patterns only).
    if (unstored.length > 6) unstored.splice(6, unstored.length, `…and ${unstored.length - 6} more`);
    // Audit + telemetry, store_secret-shaped (env NAME only, never the value).
    try {
      await prisma.activity.create({
        data: { userId, action: 'coding_credential.store', resource: 'platform', metadata: { via: 'owner_answer_vault', questionId, envKeys: storedKeys, spans: spans.length, wholeAnswerPaste: wholeAnswerPaste ? 1 : 0 } },
      }).catch(() => { /* the audit row never fails the answer */ });
    } catch { /* activity table absent in some test graphs — never fail */ }
    void recordOwnerQuestionMetric('owner_answer_credential_vaulted', { questionId: questionId.slice(0, 11), envKeys: storedKeys.length }, undefined);
    const ref = storedKeys.map((k) => `$${k}`).join(', ');
    // Ticket ca0b57cd: the notice names HOW MANY credential-shaped values were
    // captured — the pre-fix notice named the envKey(s) but not the count, so
    // an answer carrying TWO values with only ONE stored read as complete.
    // Delta-review #3: when NOTHING stored but values were captured, the
    // notice is the pure WARNING (never "0 values … stored as ").
    const captureCount =
      storedKeys.length === 1 ? 'the credential-shaped value' : `${storedKeys.length} credential-shaped values`;
    const warningSentence = (n: number): string =>
      ` ${OQ_VAULT_NOTE_PREFIX} WARNING: ${n} more credential-shaped value${n === 1 ? ' was' : 's were'} captured but could NOT be stored (per-answer cap, a protected key, or a value the vault refuses) and ${n === 1 ? 'is' : 'are'} redacted without a vault copy: ${unstored.join(', ')}. Re-supply ${n === 1 ? 'it' : 'them'} (store_secret, or Account → Coding → Credentials).]`;
    const notice = storedKeys.length
      ? `${OQ_VAULT_NOTE_PREFIX} ${captureCount} in this answer were stored in the encrypted coding-credentials vault as ${ref} and are available in every coding-session shell of this account (use "$ENVKEY" in commands; scrubbed from shell output). They are redacted from this text. Do not ask the owner to re-paste them.]`
        // Review A7: captured but NOT stored (the per-answer cap, an
        // infra-managed key) — the notice names them instead of reading
        // complete. These the owner DOES need to re-supply, so a WARNING
        // sentence is appended naming them.
        + (unstored.length ? warningSentence(unstored.length) : '')
      : `${OQ_VAULT_NOTE_PREFIX} WARNING: ${unstored.length} credential-shaped value${unstored.length === 1 ? ' was' : 's were'} captured in this answer but could NOT be stored (a protected key, or a value the vault refuses) and ${unstored.length === 1 ? 'is' : 'are'} redacted without a vault copy: ${unstored.join(', ')}. Re-supply ${unstored.length === 1 ? 'it' : 'them'} (store_secret, or Account → Coding → Credentials).]`;
    return { notice, envKeys: storedKeys, wholeAnswerVaulted: wholeAnswerPaste && storedKeys.length > 0 };
  } catch {
    return none; // best-effort — the pre-fix redaction-only posture stands
  }
}

/**
 * The owner answered a flagged question. Guards: the row exists, belongs to
 * userId, and is still 'open'; the flip is a conditional updateMany on
 * status='open' (one-shot/race-safe against a double-click or a simultaneous
 * dismiss). Then the answer is posted back into the originating chat.
 */
export async function answerOwnerQuestion(
  id: string,
  userId: string,
  answer: string,
  /** Review 2026-09-13 issue 11: provenance stamp — 'owner' (REST / Telegram,
   *  the default) or 'supervisor' (the answer_owner_question tool acting under
   *  the owner's standing directives). The transcript note + wake name the
   *  actual answerer so the lane never misattributes a supervisor decision.
   *  Ticket 91ec252a: acknowledgeNewerOwnerPosts is the triage-race-guard
   *  override — set ONLY on a supervisor re-answer after an 'owner_engaged'
   *  refusal (the delivered answer is then visibly stamped).
   *  Ticket 50bcd1e7 (review F1): 'default' is a REPLAY-ONLY provenance — a
   *  stored preset-default answer re-delivered by the duplicate sweeper. It
   *  stamps the row exactly like applyDefaultAnswerIfDue would and (unlike
   *  'owner') is refused by the credential-vault leg: replayed text is never
   *  fresh owner input.
   *  archived-target-retire (review 2026-10-20): actorChatId is the chat whose
   *  turn answered (the answer_owner_question tool's session) — an answer to
   *  an ARCHIVED lane is never re-routed back onto it as a second turn.
   *  Ticket c1714329 (2026-10-21): replayed=true marks a REPLAY of a stored
   *  answer (the owner-gate sweeper's dupe arm, not fresh owner input) — the
   *  typed-gate conversational wake fires on fresh OWNER input only, never
   *  on a replay, or the sweeper would re-wake the lane every 5-minute pass
   *  its 24h lookback covers.
   *  Ticket c54074df/7caf07ed (2026-10-21): sweeperAutoHeal=true marks the
   *  gate-sweeper's CREDENTIAL auto-heal arm (a machine state check on a
   *  slot-validated store row — never an owner paste, never a preset
   *  default), so the wake/note/ledger surfaces narrate it truthfully. */
  opts: { answeredBy?: 'owner' | 'supervisor' | 'default'; acknowledgeNewerOwnerPosts?: boolean; credentialPaste?: boolean; userDirected?: boolean; actorChatId?: string | null; replayed?: boolean; sweeperAutoHeal?: boolean } = {},
): Promise<OwnerQuestionResolution> {
  const answeredBy: 'owner' | 'supervisor' | 'default' = opts.answeredBy === 'supervisor' ? 'supervisor' : opts.answeredBy === 'default' ? 'default' : 'owner';
  const bySupervisor = answeredBy === 'supervisor';
  const prisma = await db();
  // Id resolution (ticket 590d368d): the supervisor-first triage event hands
  // the Fleet Supervisor the oq_-prefixed SHORT form (first 8 chars — the
  // fleet's relay idiom) and this tool's own not_found message says "copy the
  // oq_ id verbatim from the triage event" — but findUnique matches the FULL
  // id only, so a verbatim-copied triage id missed a LIVE row and the refusal
  // falsely claimed "no owner question with that id belongs to this owner"
  // (the 2026-09-17T05:46Z Fleet Supervisor streak: three real, answerable
  // rows — oq_3936085b, oq_72405c29, oq_8281cb0d — all refused not_found).
  // Mirror the listOwnerQuestionsForUser resolver (ticket 8bae9959): an
  // exact-id miss on a ≥8-char input retries as an owner-scoped unique
  // prefix; an ambiguous prefix refuses with its own reason rather than
  // answering the wrong gate.
  let row = await prisma.ownerQuestion.findUnique({ where: { id } });
  if (!row && id.length >= 8) {
    const candidates = await prisma.ownerQuestion.findMany({
      where: { userId, id: { startsWith: id } },
      select: { id: true },
    } as any);
    if (candidates.length > 1) return 'ambiguous';
    if (candidates.length === 1) {
      row = await prisma.ownerQuestion.findUnique({ where: { id: candidates[0].id } });
    }
  }
  if (!row || row.userId !== userId) return 'not_found';
  if (row.status !== 'open') return 'not_open';
  // Ticket 91ec252a: supervisor-triage race guard — the owner may have posted
  // in the FILING chat after the question was filed (the 2026-09-21 CanLaw
  // incident: the owner pasted the Z.ai key in the source chat at 19:13Z; the
  // Fleet Supervisor's triage answer "proceed WITHOUT the Z.ai stream" still
  // delivered at 19:25Z, contradicting what the owner had just done). A
  // supervisor answer made without seeing those posts is stale by construction
  // — REFUSE it (nothing flips, no note, no wake) and send the supervisor back
  // to re-read the filing chat first; an explicit acknowledgeNewerOwnerPosts
  // override delivers WITH a visible stamp. Owner answers (REST / Telegram /
  // user-present turns) are the authority itself and are never guarded; the
  // auto-answer default sweep stamps 'default', never 'supervisor'.
  // Detection mirrors latestOwnerRowsAfter (ticket c6db9c72): role 'user' rows
  // newer than the question's createdAt whose metadata.origin is absent/'user'
  // (machine origins — schedule/hook/agent/webhook — never count); the JS-side
  // filter sidesteps Prisma's JSON-null / missing-key edge cases. Best-effort:
  // a probe hiccup logs a warning and never blocks an answer.
  let newerOwnerPosts = 0;
  if (bySupervisor) {
    newerOwnerPosts = await countOwnerPostsSinceQuestion(prisma, row);
    if (newerOwnerPosts > 0 && !opts.acknowledgeNewerOwnerPosts) {
      void recordOwnerQuestionMetric('owner_answer_triage_race_refused', { questionId: row.id.slice(0, 11), chatId: row.chatId.slice(0, 8), posts: newerOwnerPosts }, row.chatId);
      return 'owner_engaged';
    }
    if (newerOwnerPosts > 0) {
      void recordOwnerQuestionMetric('owner_answer_triage_race_override', { questionId: row.id.slice(0, 11), chatId: row.chatId.slice(0, 8), posts: newerOwnerPosts }, row.chatId);
    }
  }
  // Audit 96fb2f25 (specimen oq_e4869c75): an OWNER-ONLY class question is
  // never answered by a supervisor on the owner's behalf. The specimen: a
  // free-text approve-dispatch ask over the held-ticket note "this ticket is
  // on another account (or quotes another user's chat)" was answered by the
  // Fleet Supervisor citing only the generic "clear gates always on my
  // behalf" directive, with the supervisor itself judging the foreign account
  // synthetic. Flag-time routing already sends these classes to the owner, but
  // nothing re-checked at answer time — a supervisor (or a sweeper replay of a
  // supervisor answer) could flip any of them. The check re-runs the PURE
  // classifier over the stored row (no schema change): when the question
  // falls in an owner-only class — another-account security, cross-project
  // scope, credentials, irreversible, external send, physically-human — only
  // the owner's own hand answers it. Kill switch OWNER_ANSWER_OWNER_ONLY_DISABLED=1.
  // userDirected (a user-present turn) is the owner's own voice and never refused.
  if (bySupervisor && !opts.userDirected && process.env.OWNER_ANSWER_OWNER_ONLY_DISABLED !== '1') {
    // Ticket 1a56f816: the verdict now reads the STORED PAYLOAD too (typed
    // human-action options, physical device + an unobtainable credential,
    // run-and-paste instructions) through the ONE shared helper — otherwise a
    // card the flag path correctly refused to triage could still be answered
    // by a supervisor that found it by hand.
    const ownerOnlyReason = ownerOnlyRoutingForStoredRow({
      question: row.question,
      context: row.context,
      options: (row as any).options,
      expectedAnswerType: (row as any).expectedAnswerType,
      consoleAction: (row as any).consoleAction,
    });
    if (ownerOnlyReason) {
      void recordOwnerQuestionMetric('owner_answer_owner_only_refused', { questionId: row.id.slice(0, 11), chatId: row.chatId.slice(0, 8), reason: ownerOnlyReason }, row.chatId);
      return 'owner_only_class';
    }
  }
  // Credential scan on the INBOUND answer (remediation P1 item N9): the answer
  // persists in the row AND is rendered verbatim into the originating chat's
  // transcript + wake prompt — an owner password pasted here once sat in two
  // rows and rode every later prompt. Store the redacted form; the note text
  // tells both sides a credential was seen and dropped.
  // Ticket 50bcd1e7: on the OWNER's own answer, the credential spans are
  // FIRST routed to the encrypted vault (server-side, never in the readable
  // row) — the redaction below still runs, unchanged; the notice names only
  // the envKey(s) so the woken lane uses $ENVKEY instead of re-asking.
  // Ticket 50bcd1e7: on the OWNER's own answer, the credential spans are
  // FIRST routed to the encrypted vault (server-side, never in the readable
  // row) — the redaction below still runs, unchanged; the notice names only
  // the envKey(s) so the woken lane uses $ENVKEY instead of re-asking.
  // Composition with typed credential gates (e90db560c, todo 77c88942): a
  // CREDENTIAL-gated row declares the envKey the answer must carry — when the
  // owner pastes the credential itself on the card, the vault leg stores it
  // under the DECLARED key, so credentialLifted's store-state check (userId +
  // envKey startsWith) lifts the gate on THIS answer — the card becomes a
  // first-class credential hand-off surface without weakening the gate's
  // text-never-resolves rule (a mismatched answer still keeps the gate shut).
  const expected = parseExpectedAnswerType((row as any).expectedAnswerType, row.question);
  const vaulted = await vaultOwnerAnswerSecrets(userId, row.id, String(answer ?? ''), {
    answeredBy,
    ...(expected.type === 'credential' && expected.envKey ? { declaredEnvKey: expected.envKey } : {}),
    ...(expected.type === 'credential' && opts.credentialPaste === true ? { credentialPaste: true } : {}),
  });
  const trimmedReply = redactInboundSecrets(String(answer ?? '').trim()).slice(0, ANSWER_MAX);
  if (!trimmedReply) return 'not_open'; // the controller validates; defense in depth
  const options = parseStoredOptions((row as any).options);
  // OWNER-INTERRUPT-ECONOMY (2026-10-20): on a card annotated with the owner's
  // PRIOR decision, "Same as before" (the typed option or the words) IS that
  // decision — expanded here so the lane, the ledger and every gate read the
  // real answer (and the prior option, when this card offers it), stamped
  // with its provenance. Kill switch OWNER_PRIOR_DECISION_RECALL_DISABLED=1.
  let sameAsBefore: { reply: string; option: OwnerQuestionOption | null; stamp: string } | null = null;
  if (process.env.OWNER_PRIOR_DECISION_RECALL_DISABLED !== '1' && String(row.question ?? '').includes(PRIOR_DECISION_MARK)) {
    try {
      const economy = await import('./owner-interrupt-economy');
      const parsed = economy.parsePriorDecisionAnnotation(row.question);
      let priorRow: any = null;
      if (parsed) {
        const hits = await prisma.ownerQuestion.findMany({ where: { userId, id: { startsWith: parsed.questionRef } }, take: 2 } as any);
        priorRow = Array.isArray(hits) && hits.length === 1 ? hits[0] : null;
      }
      sameAsBefore = economy.resolveSameAsBefore({ question: row.question, reply: trimmedReply, options, priorRow });
    } catch { sameAsBefore = null; /* the reply is stored as typed */ }
  }
  const trimmed = sameAsBefore ? redactInboundSecrets(sameAsBefore.reply).slice(0, ANSWER_MAX) : trimmedReply;
  // Ticket ad4fae90: a whole-answer paste vaulted by the dedicated path never
  // stores its token as answer text — an unknown-shape key (the provider-
  // prefix gap) is not redactable by the N9 scan either, so the raw value
  // would persist verbatim on the row that the vault notice already serves.
  // Post-merge review F-A: the rule keys on the SUBMISSION (credentialPaste),
  // NOT on whether this answer's vault leg happened to store. When the vault
  // REFUSED — a preset-managed envKey row (provider !== 'custom' is skipped),
  // an over-length value, the kill switch — the raw token must not ride the
  // row either; and when the gate lifts anyway from PRE-EXISTING state the
  // caller must be told the paste was NOT stored (the card must not toast
  // "Key stored" while the vault kept the old value).
  const pasteRefused = expected.type === 'credential' && opts.credentialPaste === true && vaulted.envKeys.length === 0;
  const answerText = vaulted.wholeAnswerVaulted
    ? '[pasted credential — stored in the encrypted coding-credentials vault; value redacted]'
    : pasteRefused
      ? '[pasted credential — NOT stored: the vault refused this value (the key may be managed by an Account preset, over the size limit, or vaulting is disabled); the value never rides this row, and the gate reflects only previously stored credentials. To replace the key use Account → Coding → Credentials.]'
      : trimmed;
  // 50bcd1e7: the vault notice rides the stored answer (and every render of
  // it) when credentials were vaulted — never a value, envKey(s) only. It is
  // appended AFTER the redaction so no pattern can act on the raw answer;
  // the TEXT portion is capped so text+notice together stay inside
  // ANSWER_MAX with the actionable notice (the envKey name) never truncated.
  const storedAnswerRaw = vaulted.notice
    ? `${answerText.slice(0, Math.max(0, ANSWER_MAX - vaulted.notice.length - 1))} ${vaulted.notice}`.slice(0, ANSWER_MAX)
    : answerText;
  // Typed options (N3): an answer matching an option id / label / 1-based
  // number stamps chosenOption and stores the LABEL as the durable answer
  // (the label is what the owner meant; the raw text is preserved when
  // different). Free text passes through untouched. 50bcd1e7: option
  // matching runs on the REDACTED text (the pre-fix behavior) — a credential
  // pasted as an option pick would never be a label — and the vault notice
  // rides the stored answer either way.
  // OWNER-INTERRUPT-ECONOMY review 2026-10-20 (BLOCKING): an expanded "Same as
  // before" takes ONLY the option resolveSameAsBefore mapped by LABEL — never
  // a re-match of the prior answer text against this card (a prior free-text
  // "2" or an id would pick this card's option 2 / that id: a different
  // decision). No mapped option = stored as free text.
  const matched = sameAsBefore ? sameAsBefore.option : matchAnswerToOption(options, trimmed);
  // Review F-B (post-merge): the matched branch used to rebuild from `trimmed`
  // — bypassing answerText, so a vaulted/refused paste rode the row inside the
  // "typed:" quote. Every storage derivation now goes through answerText.
  const storedAnswerBase = matched
    ? `${matched.label === answerText ? answerText : `${matched.label} [option ${matched.id}; typed: "${answerText}"]`}${vaulted.notice ? ` ${vaulted.notice}` : ''}`.slice(0, ANSWER_MAX)
    : storedAnswerRaw;
  const storedAnswer = sameAsBefore
    ? `${storedAnswerBase.slice(0, Math.max(0, ANSWER_MAX - sameAsBefore.stamp.length - 1))} ${sameAsBefore.stamp}`
    : storedAnswerBase;

  // ── Typed answer gates (todo 77c88942 item 2, 2026-10-16) ─────────────────
  // Check STATE, not text. The specimen: oq_211513ed/oq_483730f8 answered
  // "yes public" 3 s apart — text that could never carry a credential — and
  // the credential-gated Schooltime todo 746aa1c5 opened anyway. A typed gate
  // declares what a RESOLVING answer looks like; anything else keeps the row
  // OPEN (recorded on the row as a counter-question the lane must answer
  // back on) so the gate re-checks on every later surface (the sweeper, the
  // re-answer) until the declared shape arrives.
  if (expected.type === 'credential') {
    const looksLikePaste = answerLooksLikeCredential(trimmed);
    // Ticket ad4fae90: a BARE credential declaration ('credential' with no
    // envKey inferable from the question) can never pass the state check —
    // there is no declared key to look up. The explicit paste path is the one
    // honest lift: the owner submitted the value through the card's secret
    // input and the vault leg stored a real credential on THIS answer (span
    // leg or whole-answer leg — review finding B2: a known-shape key on a
    // bare row stored via spans but never lifted, dead-ending the card with a
    // false "not stored" record). Text answers keep the fail-closed rule.
    const lift = expected.envKey
      ? await credentialLifted(prisma, row.userId, expected.envKey)
      : opts.credentialPaste === true && vaulted.envKeys.length > 0
        ? { lifted: true, via: 'store' as 'receipt' | 'store' }
        : { lifted: false, via: null as 'receipt' | 'store' | null };
    if (!lift.lifted) {
      // Ticket ad4fae90: quoting the reply verbatim on the row PERSISTED an
      // unknown-shape key (the N9 scan did not know the shape either — that is
      // exactly why the gate never lifted). Withheld from both the mismatch
      // record and the inbox note when the reply is an opaque token, OR when
      // the answer came through the card's secret input (credentialPaste —
      // review finding F1: a multi-word secret the paste leg refused was then
      // quoted verbatim; the paste path NEVER quotes, whatever the shape).
      const pastePath = opts.credentialPaste === true;
      // 2026-10-20 (the ctrl.cql.ca "i never got the json policy" specimen):
      // WORDS from the owner — not a paste through the key field, not a PEM /
      // opaque token — are a counter-question the asking lane must answer ON
      // THE CARD, not a failed key. Owner-origin only: a replayed preset
      // default ('default') or a supervisor's text carries nothing new for
      // the lane, and the gate's text-never-resolves rule is untouched either
      // way (the row stays open below in every branch).
      const conversational = answeredBy === 'owner' && !opts.replayed && !pastePath && !looksLikePaste && !isOpaqueTokenShape(trimmed) && !credentialReplyWakeDisabled();
      const replyExcerpt = pastePath || isOpaqueTokenShape(trimmed)
        ? pastePath
          ? '(the value was pasted through the card\'s key field — withheld; if it was stored it will carry a vault notice, if refused it never rides this row)'
          : '(an opaque token was pasted — withheld; shapes the scanner does not know are stored, never quoted)'
        : `"${trimmed.slice(0, 300)}"`;
      // Ticket f3a69ed3 (defect 1): the record is now the OWNER-FACING
      // block — the owner's words lead, then the one-line reason the card did
      // not resolve, then where the reply went. The owner-facing surfaces
      // (the card, the Inbox) render it verbatim via parseOwnerRecordedReply;
      // the agent surfaces (the inbox note, the wake below) still carry the
      // full agent-directed wording.
      const f3aRecord = buildRecordedReplyRecord({
        receivedAt: new Date(Date.now()),
        text: pastePath
          ? '(the value was pasted through the card\'s key field — withheld; if it was stored it will carry a vault notice, if refused it never rides this row)'
          : isOpaqueTokenShape(trimmed)
            ? '(an opaque token was pasted — withheld; shapes the scanner does not know are stored, never quoted)'
            : trimmed,
        reason: RECORDED_REPLY_REASON.credential,
        delivered: conversational ? 'woken' : 'sent',
        // The paste warning (todo 5c024656 finding 3) rides the record too —
        // merged with the vault notice when both apply, both appended after
        // the words and the reason so the actionable tail is never clipped.
        // Applies to EVERY non-key-field paste (a pasted JWT is both
        // paste-shaped and opaque — the words are withheld AND the owner must
        // be told the value was NOT stored and where it must go instead).
        vaultNotice: [
          looksLikePaste && !pastePath
            ? '(the reply looked like a pasted credential — it was NOT stored; paste it through the card\'s key field, store_secret or the Account form so it never sits in a question row)'
            : '',
          vaulted.notice ?? '',
        ].filter(Boolean).join(' ') || undefined,
        cap: ANSWER_MAX,
      });
      // The gate STAYS SHUT: nothing flips, nothing wakes as a decision. The
      // owner's words are kept on the row (the recorded-reply block) so the
      // card, the lane and the next wake see them, and the metric carries the
      // observe-only baseline (7-day ladder before any stricter enforcement
      // of the answer surfaces themselves).
      // Ticket b71367e5 (pass-3 finding #7): the vault notice (capture
      // count, and above all the zero-store WARNING for captured-but-
      // unstored values) must ride THIS record too — pre-fix it was computed
      // by vaultOwnerAnswerSecrets and then dropped here, so an owner whose
      // paste the vault refused (truncated PEM, per-answer cap, a protected
      // key) saw only "gate still shut" with no idea the value was NOT
      // stored. The record text is capped so the actionable notice tail
      // (envKeys / what to re-supply) never truncates. (f3a69ed3: the notice
      // is folded into the owner-facing block itself now.)
      const mismatchRecord = f3aRecord;
      try {
        await prisma.ownerQuestion.updateMany({
          where: { id: row.id, status: 'open' },
          data: {
            // f3a69ed3: the owner-facing recorded-reply block — the owner's
            // words + the one-line reason, rendered back on the card.
            answer: mismatchRecord,
          },
        });
      } catch { /* the record is best-effort; the refusal below is the gate */ }
      void recordOwnerQuestionMetric('owner_gate_type_mismatch', {
        questionId: row.id.slice(0, 11), chatId: row.chatId.slice(0, 8),
        expectedType: 'credential', envKey: expected.envKey ?? '',
        lookedLikePaste: looksLikePaste, answeredBy,
        // 2026-10-20: a conversational owner reply wakes the lane (the
        // credential counter-question path) instead of dead-ending the card.
        conversational, woken: conversational,
      }, row.chatId);
      // Tell the lane what happened (its next wake / the pending ask_user
      // drain sees the note): the card is still open, the owner's words are
      // on it, and the ask is unchanged.
      await postOwnerInboxNote(
        row.chatId,
        `[Owner inbox] The owner replied to your credential-gated question (Q: "${row.question}") with text that is not the credential: ${pastePath ? '(the value was pasted through the card\'s key field — withheld from this note)' : isOpaqueTokenShape(trimmed) ? '(an opaque token was pasted — withheld from this note; unknown-shape credentials are stored via the vault, never quoted)' : `"${trimmed.slice(0, 200)}"`}. ` +
        `The gate stays SHUT — a credential gate opens only when the key is stored: ${expected.envKey ? `${expected.envKey} via store_secret, the card's key field or the Account UI (stored state, never answer text)` : 'no envKey declared, so only a later answer\'s key-field paste can lift it'}. The question is still OPEN; ${conversational ? 'you are being woken now — answer the owner ON THE CARD (re-file with flag_owner_question carrying the full instructions + supersedes), never only in this transcript; and ' : 'answer the owner\'s reply or re-ask as needed, but '}do not treat this as the credential arriving.`,
      );
      if (conversational) {
        // The credential twin of the free-text counter-question wake: the
        // lane is woken NOW with the owner's words, the question (and its id,
        // so supersedes can name it), the context it filed, and the standing
        // instruction to answer on the card. kind 'answer' so an ARCHIVED
        // asker re-routes to its supervisor like any owner answer.
        const contextEcho = row.context
          ? `\n[Question context — as filed with the flag]\n${String(row.context).slice(0, 1500)}\n`
          : '';
        const wakeText =
          `${CREDENTIAL_REPLY_WAKE_HEADER} Q: "${row.question}" (question id ${row.id})\nOwner replied: "${trimmed}"\n${contextEcho}\n${CREDENTIAL_REPLY_INSTRUCTION}`;
        await wakeChatForOwnerResolution(row.chatId, wakeText, row.id, { kind: 'answer', actorChatId: opts.actorChatId ?? null });
        return 'reply_recorded';
      }
      return 'credential_pending';
    }
    // Lifted (receipt or store) — fall through and resolve like any answer;
    // the note below quotes the owner's words, and the stored answer says
    // what actually lifted it (never the value).
    if (expected.envKey) {
      void recordOwnerQuestionMetric('owner_gate_credential_lifted', {
        questionId: row.id.slice(0, 11), chatId: row.chatId.slice(0, 8),
        envKey: expected.envKey, via: lift.via,
      }, row.chatId);
    }
  } else if (expected.type === 'choice' || expected.type === 'yes_no') {
    // A choice gate needs a typed-option match; a yes_no gate needs an
    // affirmative/negative ruling. Anything else (including a question back)
    // is a mismatch: record it, keep the row open, refuse the resolution.
    // `matched` is matchAnswerToOption(options, trimmed) on every ordinary
    // answer; on an expanded "Same as before" it is the LABEL-mapped prior
    // option (or none) — the gate reads the same option the row stores.
    const yesNoRuling = /^\s*(?:yes|yeah|yep|ok(?:ay)?|go|approve[d]?|no|nope|nah|don'?t|stop|decline[d]?)\b/i.test(trimmed)
      || !!matched;
    const resolves = expected.type === 'choice' ? !!matched : yesNoRuling;
    if (!resolves) {
      // Todo 0dd7d3f2 (2026-10-18, monitor-reported specimen oq_17b85b72): this
      // branch used to return 'credential_pending' — a code the card surfaces
      // read as "needs a credential" — so every typed reply on a CHOICE/yes_no
      // card that didn't match an option showed the owner the credential toast
      // and never cleared the draft ("i cant respond to tickets"). The reply IS
      // delivered to the asking chat (postOwnerInboxNote below) — the card just
      // can't resolve on it. Distinct code so every surface can say that truth.
      // The full reply (ANSWER_MAX, not the old 200/300-char excerpt) rides BOTH
      // the mismatch record and the inbox note — a pasted console error or policy
      // line reached the lane cut off mid-sentence (specimen oq_f7322fe9's shape).
      // The reply rides BOTH surfaces in full: `trimmed` is already capped at
      // ANSWER_MAX upstream (line ~3097), so it is used verbatim — the bracket
      // may push the ROW's total a few chars past ANSWER_MAX by design (the
      // column is @db.Text; the reply itself never exceeds the cap). Review
      // MINOR-1 (todo 0dd7d3f2 round-2): an earlier version capped the reply
      // at ANSWER_MAX − bracket inside the ROW and reused that same string
      // for the NOTE, so a maximal reply lost ~83 tail chars on both surfaces.
      const looksLikePaste = answerLooksLikeCredential(trimmed);
      const replyForRecord = isOpaqueTokenShape(trimmed)
        // Review finding 3: an unknown-shape secret pasted onto a choice card
        // is withheld from BOTH the record and the note (the credential
        // branch's ad4fae90 rule — shapes the scanner do not know are stored,
        // never quoted; the widening here would otherwise have made the
        // pre-existing hole 8,000 chars deep).
        ? '(an opaque token was pasted — withheld; unknown-shape credentials are stored via the vault, never quoted)'
        // Ticket 913339d7 (review obs 2 — looksLikePaste parity with the
        // credential twin at the 4220/4248 shape): a PEM block with prose
        // around it (a certificate, a public key — NOT matched by the N9
        // redaction pass, which knows only PRIVATE KEY blocks) is paste-
        // shaped but not a single opaque token, so before this it rode the
        // record verbatim. Withheld from every quoted surface, exactly like
        // the credential branch's paste notice.
        : looksLikePaste
          ? '(the reply looked like a pasted key or certificate — withheld from the card; it was NOT stored)'
          : trimmed;
      // Ticket f3a69ed3 (defect 1 + 3): the ROW's record is now the
      // OWNER-FACING block — the owner's words + the one-line reason the card
      // did not resolve + where the reply went — rendered back on the card
      // (parseOwnerRecordedReply) instead of bouncing silently. And an
      // OWNER's plain-English reply WAKES the asking lane now (the free-text
      // twin of the 2026-10-20 credential conversational wake): before, the
      // words lived only in the transcript note below — a lane reading them
      // hours later is exactly "nothing happened" from the owner's seat.
      // Ticket c1714329 (2026-10-21): `!opts.replayed` — a sweeper REPLAY is
      // not fresh owner input and never wakes. The dupe arm (action (b) of
      // owner-gate-sweeper, replayed: true) replays an answered row's text
      // onto a still-open gated dupe every 5-minute pass for a 24h lookback;
      // without this guard each pass would re-fire the wake below — a wake
      // loop on exactly the lanes the wake exists to free (the same guard the
      // credential twin's `conversational` carries).
      const conversationalChoice = answeredBy === 'owner' && !opts.replayed && !isOpaqueTokenShape(trimmed) && !looksLikePaste && !credentialReplyWakeDisabled();
      const mismatchRecord = buildRecordedReplyRecord({
        receivedAt: new Date(Date.now()),
        text: replyForRecord,
        reason: expected.type === 'yes_no' ? RECORDED_REPLY_REASON.yesNo : RECORDED_REPLY_REASON.choice,
        delivered: conversationalChoice ? 'woken' : 'sent',
        ...(vaulted.notice ? { vaultNotice: vaulted.notice } : {}),
        // The builder adds the +200 bracket overage internally (todo
        // 0dd7d3f2's row budget: ANSWER_MAX + 200 = 8200).
        cap: ANSWER_MAX,
      });
      try {
        await prisma.ownerQuestion.updateMany({
          where: { id: row.id, status: 'open' },
          data: {
            answer: mismatchRecord,
          },
        });
      } catch { /* best-effort */ }
      void recordOwnerQuestionMetric('owner_gate_type_mismatch', {
        questionId: row.id.slice(0, 11), chatId: row.chatId.slice(0, 8),
        expectedType: expected.type, answeredBy,
        lookedLikePaste: looksLikePaste,
        conversational: conversationalChoice, woken: conversationalChoice,
      }, row.chatId);
      await postOwnerInboxNote(
        row.chatId,
        `[Owner inbox] The owner replied to your ${expected.type}-gated question (Q: "${row.question}") with text that does not resolve it: "${replyForRecord}". The question is still OPEN — treat the reply as conversation, not the decision, and re-ask or answer back as needed.${conversationalChoice ? ' You are being woken NOW with the owner\'s words — act on any executable instruction in them under your standing autonomy, and answer the owner ON THE CARD (re-file with flag_owner_question carrying options that match what they said + supersedes), never only in this transcript.' : ''}`,
      );
      if (conversationalChoice) {
        // f3a69ed3 defect 3: wake the asking lane NOW with the owner's words
        // (kind 'answer' so an ARCHIVED asker re-routes to its supervisor
        // like any owner answer). A supervisor's or preset-default reply
        // carries nothing new for the lane and never wakes.
        const contextEcho = row.context
          ? `\n[Question context — as filed with the flag]\n${String(row.context).slice(0, 1500)}\n`
          : '';
        // replyForRecord, never trimmed (ticket c1714329, review round 2):
        // an opaque-token-shaped paste on a choice card is withheld from
        // every quoted surface — the wake prompt is a quoted surface (the
        // ad4fae90 rule: unknown-shape secrets are stored via the vault,
        // never quoted; replyForRecord already carries the withholding text).
        await wakeChatForOwnerResolution(
          row.chatId,
          `${CHOICE_REPLY_WAKE_HEADER} Q: "${row.question}" (question id ${row.id})\nOwner replied: "${replyForRecord}"\n${contextEcho}\n${CHOICE_REPLY_INSTRUCTION}`,
          row.id,
          { kind: 'answer', actorChatId: opts.actorChatId ?? null },
        );
      }
      return 'reply_recorded';
    }
    // A matching choice / ruling — fall through to the normal flip.
  }

  const flip = await prisma.ownerQuestion.updateMany({
    // row.id (the RESOLVED full id), not the caller-supplied id — after the
    // prefix lane (ticket 590d368d) the caller's id may be an 8-char prefix,
    // which matches nothing here and would falsely report a lost race.
    where: { id: row.id, status: 'open' },
    data: {
      status: 'answered', answer: storedAnswer, resolvedAt: new Date(Date.now()),
      answeredBy, // P7 S2b provenance — 'owner' | 'supervisor' (issue 11) vs 'default' (auto-answered)
      ...(matched ? { chosenOption: matched.id } : {}),
    },
  });
  if (flip.count === 0) return 'not_open'; // lost a race with another surface
  // OWNER-INTERRUPT-ECONOMY: owner_question_resolved (who, how fast, surface).
  void import('./owner-interrupt-economy')
    .then((e) => e.recordOwnerQuestionResolved(row, { outcome: 'answered', by: answeredBy, surface: sameAsBefore ? 'same_as_before' : opts.credentialPaste ? 'credential_paste' : 'answer' }))
    .catch(() => {});
  // CanLaw stall 2026-09-15: an owner reply that is itself a question is NOT
  // a decision — the note, the wake, the ledger and the gate release all say
  // so, so no lane can turn "didn't we change the benchmark a ton?" into an
  // "owner HALT decision MADE". Supervisor answers are rulings by contract.
  // "Option B?" / "2?" picks an option with a hedge — match it loosely (trailing
  // question mark stripped) before reading the reply as a question back.
  const matchedLoose = matched ?? matchAnswerToOption(options, trimmed.replace(/\s*[?？]+\s*$/, ''));
  const counterQuestion = !bySupervisor && isCounterQuestionAnswer(trimmed, matchedLoose);
  // Review 2026-09-13 issue 11: name the actual answerer.
  // Ticket 91ec252a: an acked override (supervisor answered over newer owner
  // posts in the filing chat) is VISIBLY stamped on both the transcript note
  // and the wake, so no lane mistakes it for a ruling made on fresh context.
  const raceStamp = bySupervisor && newerOwnerPosts > 0
    ? ` [⚠ ${newerOwnerPosts} newer owner post${newerOwnerPosts === 1 ? '' : 's'} in the filing chat since this question was filed — the supervisor acknowledged them before answering]`
    : '';
  const answererNote = bySupervisor
    ? `The Fleet Supervisor answered your flagged question under the owner\'s standing directives (supervisor-first triage)${raceStamp}`
    : answeredBy === 'default'
      ? opts.sweeperAutoHeal
        ? 'Your flagged question was AUTO-RESOLVED by the gate sweeper: it verified the credential already stored (no owner action, no new value)'
        : 'Your flagged question was resolved by its preset DEFAULT answer (re-delivered from the auto-answered duplicate of this decision)'
    : counterQuestion
      ? 'The owner replied to your flagged question WITH A QUESTION — not a decision'
      : 'The owner answered your flagged question';
  await postOwnerInboxNote(
    row.chatId,
    `[Owner inbox] ${answererNote} — Q: "${row.question}" A: "${storedAnswer}"${counterQuestion ? ` (no ruling was made; answer the owner's question and proceed under the standing directives)` : ''}`,
  );
  // The wake echoes the question's CONTEXT when the flag carried one (SA0906):
  // a stopped-schedule decision's actionable detail (which schedule, cadence,
  // the resume/leave-stopped choices) lives in context, and the woken run only
  // ever sees this prompt — without the echo a "resume" answer arrived with no
  // schedule to act on. Clipped so a maximal context can't blow the wake prompt.
  const contextEcho = row.context
    ? `\n[Question context — as filed with the flag]\n${String(row.context).slice(0, 1500)}\n`
    : '';
  const wakeHeader = bySupervisor
    ? `[Owner inbox — the FLEET SUPERVISOR answered your flagged question under the owner\'s standing directives (supervisor-first triage, review 2026-09-13 issue 11); treat it exactly like an owner answer]${raceStamp}`
    : answeredBy === 'default'
      ? opts.sweeperAutoHeal
        ? '[Owner inbox — your flagged question was AUTO-RESOLVED by the gate sweeper on VERIFIED stored-credential state (a machine check, not an owner decision and not a preset default); the gate opens because the vault now holds a slot-validated value]'
        : '[Owner inbox — your flagged question was resolved by its PRESET DEFAULT (re-delivered from the auto-answered duplicate of this decision); act on the default you pre-declared]'
      : counterQuestion
        ? COUNTER_QUESTION_WAKE_HEADER
        : '[Owner inbox — the OWNER just answered your flagged question]';
  const wakeInstruction = counterQuestion
    ? COUNTER_QUESTION_INSTRUCTION
    : `Act on this answer now: close or re-dispatch the affected todos with the goal tools per the ${bySupervisor ? 'supervisor\'s' : 'owner\'s'} direction, and verify against ground truth (ticket status, git/PR state) before reporting anything as done.`;
  const wakeText =
    `${wakeHeader} Q: "${row.question}"\n${counterQuestion ? 'Owner asked back' : 'A'}: "${storedAnswer}"\n${contextEcho}\n${wakeInstruction}`;
  const forChatId: string | null = (row as any).forChatId ?? null;
  // archived-target-retire: each wake names the OTHER chat this answer
  // reaches (and the actor whose turn answered), so an archived asker /
  // linked lane never re-routes the same answer onto a chat that has it.
  const actorChatId = opts.actorChatId ?? null;
  const askerReroutedTo = await wakeChatForOwnerResolution(row.chatId, wakeText, row.id, { kind: 'answer', alsoWakingChatIds: [forChatId], actorChatId });
  // Lane linkage (v1#5): wake the linked lane too (deduped when it IS the
  // asking chat — flagOwnerQuestion already nulls a self-link, this re-check
  // is defense in depth for rows written by other paths).
  if (forChatId && forChatId !== row.chatId) {
    await wakeChatForOwnerResolution(forChatId, wakeText, row.id, { kind: 'answer', alsoWakingChatIds: [row.chatId, askerReroutedTo], actorChatId, laneRole: 'linked' });
  }
  // …and record the resolution in the supervisor's durable ledger as a DONE
  // directive, so no later wake can restate the decision as pending (v1#5).
  // A counter-question is recorded as exactly that — "asked back, no decision"
  // — so the ledger can never be read as an owner ruling.
  await appendAnswerToSupervisorLedger(userId, { questionId: row.id, question: row.question, answer: storedAnswer, counterQuestion, sourceChatId: row.chatId, answeredBy, ...(opts.sweeperAutoHeal && answeredBy === 'default' ? { sweeperAutoHeal: true } : {}) });
  // 2026-10-20: an OWNER answer that is itself a ruling ("no new X, ever",
  // "they should all use Y always") ALSO lands as an OPEN owner-origin
  // directive — the DONE row above banks the decision, it never binds lanes.
  // Free text only: a typed option pick is a choice, a credential answer is
  // never ledgered, a counter-question decides nothing.
  if (answeredBy === 'owner' && !counterQuestion && !matched && expected.type !== 'credential' && !vaulted.wholeAnswerVaulted) {
    await captureOwnerRulingOnSupervisorLedger(userId, { questionId: row.id, question: row.question, ruling: answerText, source: 'answer', sourceChatId: row.chatId });
  }
  // Ticket 356d21bb: the answer resolves ALL derived gates — todos/goals
  // parked with gateQuestionId = this row flip actionable (assignee woken).
  // A counter-question releases the gate too (the card is no longer open, so
  // nothing may stay parked on it) — the progress note says the owner asked
  // back and the lane proceeds under the standing directives.
  await unblockGatesForAnsweredQuestion({
    userId, questionId: row.id, question: row.question, answer: storedAnswer,
    source: 'owner inbox answer', counterQuestion,
    answeredBy,
    // The asking chat (and the linked lane) already got THIS wake — don't
    // wake them a second time through the todo board.
    skipWakeChatIds: [row.chatId, ...(forChatId ? [forChatId] : [])],
  });
  // …and CROSS-CHAT DUPLICATES of the same decision close with it: an OPEN
  // same-owner row whose question is the same decision (isSameDecisionQuestion)
  // auto-resolves with this answer (OWNER-PROVENANCE-STRICT 2026-10-20: the
  // duplicate INHERITS the source's answeredBy — a supervisor / default answer
  // fanned out to a duplicate was stamped 'owner' and read as the owner's
  // ruling everywhere downstream; OWNER_PROVENANCE_STRICT_DISABLED=1 restores
  // the 'owner' stamp; the 992c8374 card path stamps the same way), its chat is woken,
  // and its own gated items unblock through the same choke point. Conditional
  // updateMany flips only — a row answered/dismissed elsewhere in the race is
  // skipped. The sweeper (owner-gate-sweeper) backstops anything missed here.
  try {
    const prisma = await db();
    // CanLaw 2026-09-15: a counter-question resolves NOTHING else — the lane
    // is told to RE-FILE the decision with its answer, and that re-filed row
    // (a superset of the same question text) must never be auto-closed with
    // the owner's question. The gate sweeper's duplicate action skips these too.
    const openDupes = counterQuestion ? [] : await prisma.ownerQuestion.findMany({
      where: { userId, status: 'open' }, take: 50,
    });
    const skipWake = new Set([row.chatId, forChatId].filter(Boolean) as string[]);
    const strictProvenance = !ownerProvenanceStrictDisabled();
    const dupeAnsweredBy = strictProvenance ? answeredBy : 'owner';
    const dupeActor = !strictProvenance || answeredBy === 'owner'
      ? 'The owner answered this flagged question from another surface'
      : answeredBy === 'supervisor'
        ? 'The Fleet Supervisor answered this flagged question on another surface (under the owner\'s standing directives — not the owner)'
        : 'This flagged question was resolved on another surface by its preset DEFAULT (no owner answer)';
    for (const dupe of openDupes.filter((d) => d.id !== row.id && isSameDecisionQuestion(d.question, row.question))) {
      // Todo 77c88942 item 2: a TYPED gate never resolves through a
      // duplicate's answer — a credential gate opens only on its own state
      // check (stored state for ITS envKey — a store_secret receipt or the
      // CodingCredential row), a choice/yes_no gate
      // only on its own typed match. The duplicate's answer text is by
      // construction not this row's declared shape.
      if (parseExpectedAnswerType((dupe as any).expectedAnswerType, dupe.question).type) continue;
      const dupeFlip = await prisma.ownerQuestion.updateMany({
        where: { id: dupe.id, status: 'open' },
        data: { status: 'answered', answer: storedAnswer, resolvedAt: new Date(Date.now()), answeredBy: dupeAnsweredBy },
      });
      if (dupeFlip.count === 0) continue; // resolved elsewhere in the race
      void import('./owner-interrupt-economy')
        .then((e) => e.recordOwnerQuestionResolved(dupe, { outcome: 'answered', by: dupeAnsweredBy, surface: 'duplicate' }))
        .catch(() => {});
      await postOwnerInboxNote(
        dupe.chatId,
        `[Owner inbox] ${dupeActor} — Q: "${dupe.question}" A: "${storedAnswer}" (auto-resolved: the same decision was answered on row ${row.id}, ticket 356d21bb; this duplicate row is closed so it stops re-listing).`,
      );
      if (!skipWake.has(dupe.chatId)) {
        // A duplicate close on an ARCHIVED chat is dropped, never re-routed:
        // the asker / linked lane above already carry this answer.
        await wakeChatForOwnerResolution(dupe.chatId, wakeText, dupe.id, { kind: 'duplicate' });
      }
      await unblockGatesForAnsweredQuestion({
        userId, questionId: dupe.id, question: dupe.question, answer: storedAnswer,
        source: 'cross-chat duplicate answer',
        answeredBy,
      });
    }
  } catch (err: any) {
    void logOwnerQuestions('warn', `owner-questions: cross-chat duplicate fan-out failed for ${row.id}: ${err?.message ?? err}`);
  }
  // Review F-A (post-merge): a paste-path answer that RESOLVED (the gate
  // lifted — possibly from a PRE-EXISTING credential) but stored NOTHING this
  // answer returns a distinct resolution so the card surface never toasts
  // "Key stored" while the vault kept the old value. The row's stored answer
  // already carries the refusal marker (answerText), never the raw value.
  if (pasteRefused) {
    void recordOwnerQuestionMetric('owner_answer_credential_paste_refused', {
      questionId: row.id.slice(0, 11), chatId: row.chatId.slice(0, 8),
      envKey: expected.envKey ?? '',
    }, row.chatId);
    return 'ok_paste_refused';
  }
  return 'ok';
}

/**
 * Ticket 91ec252a race probe, shared by the supervisor ANSWER guard and the
 * supervisor DISMISS rail (OWNER-DISMISS-RAILS 2026-10-20): role 'user' rows
 * in the FILING chat newer than the question's createdAt whose
 * metadata.origin is absent / 'user' (machine origins — schedule / hook /
 * agent / webhook — never count). Best-effort: a probe hiccup logs a warning
 * and answers 0 (never blocks).
 */
async function countOwnerPostsSinceQuestion(prisma: Prisma, row: { id: string; chatId: string; createdAt: Date }): Promise<number> {
  let posts = 0;
  try {
    const recent = await prisma.crossModelMessage.findMany({
      where: { chatId: row.chatId, role: 'user', createdAt: { gt: row.createdAt } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { createdAt: true, metadata: true },
    });
    for (const r of recent) {
      const origin = (r.metadata as { origin?: unknown } | null)?.origin;
      if (origin !== undefined && origin !== null && origin !== 'user') continue;
      posts += 1;
    }
  } catch (err: any) {
    posts = 0;
    void logOwnerQuestions('warn', `owner-questions: triage race probe failed for ${row.id}: ${err?.message ?? err}`);
  }
  return posts;
}

/** The supervisor seat dismissing on a MACHINE turn — the Fleet Supervisor, or a project supervisor (its project id). */
export interface SupervisorDismissSeat { role: 'fleet' | 'project'; projectId?: string | null }
export type SupervisorDismissRefusal = 'owner_only_class' | 'owner_engaged' | 'out_of_project';

/**
 * OWNER-DISMISS-RAILS (2026-10-20): dismiss_owner_question decided "allowed"
 * from the seat alone — a supervisor seat on a machine turn could withdraw an
 * OWNER-ONLY class card (the answer path refuses exactly that since audit
 * 96fb2f25), dismiss a card the owner had just engaged with in the filing
 * chat (the answer path's ticket 91ec252a race guard), and a PROJECT
 * supervisor could dismiss another project's card. The same three checks the
 * answer path makes, in the same order:
 *   1. owner-only class (classifyOwnerQuestionRouting over the stored row) ⇒
 *      'owner_only_class' — only the owner's own hand closes it;
 *   2. the owner posted in the filing chat since the card was filed ⇒
 *      'owner_engaged' — re-read the chat, leave it to the owner;
 *   3. a PROJECT supervisor may dismiss only a card whose chatId or forChatId
 *      lives in ITS project ⇒ 'out_of_project' (fail-closed on a read error).
 * Each refusal records loop_metrics owner_question_dismiss_refused {questionId,
 * chatId, reason, role, detail?}. Kill switch OWNER_DISMISS_RAILS_DISABLED=1
 * (always ok). Never throws.
 */
export async function checkSupervisorDismissRails(
  row: {
    id: string; chatId: string; question: string; context?: string | null; createdAt: Date; forChatId?: string | null;
    /** Ticket 1a56f816: the payload columns the owner-only class now reads. A
     *  caller that omits them falls back to the prose + structural legs only
     *  (never a false 'ok' for a payload-classed card the caller DID pass). */
    options?: unknown; expectedAnswerType?: string | null; consoleAction?: unknown;
  },
  seat: SupervisorDismissSeat,
): Promise<{ ok: true } | { ok: false; reason: SupervisorDismissRefusal; detail?: string }> {
  if (ownerDismissRailsDisabled()) return { ok: true };
  const refuse = (reason: SupervisorDismissRefusal, detail?: string) => {
    void recordOwnerQuestionMetric('owner_question_dismiss_refused', {
      questionId: String(row.id).slice(0, 11), chatId: String(row.chatId).slice(0, 8), reason, role: seat.role, ...(detail ? { detail } : {}),
    }, row.chatId);
    return { ok: false as const, reason, ...(detail ? { detail } : {}) };
  };
  try {
    // Ticket 1a56f816: the rail reads the STORED PAYLOAD through the shared
    // helper (see ownerOnlyRoutingForStoredRow) so a card the flag path refused
    // to triage cannot be withdrawn out from under the owner by a supervisor
    // either. The payload columns ride the optional fields the callers pass.
    const routing = classifyOwnerQuestionRouting(row.question, row.context ?? null);
    if (routing.route === 'owner') return refuse('owner_only_class', routing.reason);
    const payloadClass = ownerOnlyRoutingForStoredRow({
      question: row.question,
      context: row.context ?? null,
      options: (row as any).options,
      expectedAnswerType: (row as any).expectedAnswerType,
      consoleAction: (row as any).consoleAction,
    });
    if (payloadClass) return refuse('owner_only_class', payloadClass);
    const prisma = await db();
    if (await countOwnerPostsSinceQuestion(prisma, row) > 0) return refuse('owner_engaged');
    if (seat.role === 'project') {
      const projectId = String(seat.projectId ?? '');
      if (!projectId) return refuse('out_of_project', 'seat_without_project');
      const ids = [row.chatId, row.forChatId].filter((x): x is string => typeof x === 'string' && !!x);
      let inProject = false;
      try {
        const chats = await (prisma as any).crossModelChat?.findMany?.({ where: { id: { in: ids } }, select: { id: true, projectId: true } });
        inProject = Array.isArray(chats) && chats.some((c: any) => c?.projectId === projectId);
      } catch { inProject = false; }
      if (!inProject) return refuse('out_of_project');
    }
    return { ok: true };
  } catch (err: any) {
    void logOwnerQuestions('warn', `owner-questions: dismiss rails check failed for ${row.id}: ${err?.message ?? err}`);
    // Only the project-scope rail is fail-closed (above); a classifier / probe
    // hiccup leaves the pre-rails behaviour.
    return { ok: true };
  }
}

/** Does this dismissal arm the 24 h re-flag cooldown? Every dismissal does except a
 *  SUPERVISOR's dismissal of an OWNER-ONLY class card (OWNER-DISMISS-RAILS 2026-10-20): only
 *  the owner rules those (the rails refuse a supervisor's machine-turn dismissal of one; this
 *  covers any that slip through), so the lane may raise it to the owner again. A supervisor's
 *  dismissal of a supervisor-route / TRIAGED card DOES arm it (review fix, same day): the first
 *  cut exempted every card still in triage, which let a lane re-file a question the supervisor
 *  had just ruled moot on every firing — each one a fresh triage wake — while the lane was told
 *  the cooldown enforced it. Kill switch OWNER_DISMISS_RAILS_DISABLED=1 (always arms). Pure;
 *  exported for tests. */
export function supervisorDismissalArmsCooldown(row: { dismissedBy?: string | null; question: string; context?: string | null }): boolean {
  if (row.dismissedBy !== 'supervisor' || ownerDismissRailsDisabled()) return true;
  return classifyOwnerQuestionRouting(row.question, row.context ?? null).route !== 'owner';
}

/**
 * The owner dismissed a flagged question ("stop raising it"). Same guards and
 * conditional flip as answerOwnerQuestion; the dismissal note tells the agent
 * not to re-flag (the 24h dismissed-cooldown in flagOwnerQuestion enforces it).
 *
 * Ticket abca56ce (2026-10-18): `dismissedBy` records WHO dismissed — every
 * narration below attributes from it instead of hardcoding "the OWNER"
 * ('owner' REST/inbox click | 'supervisor' standing-directive seat |
 * 'agent' the filing chat withdrawing its own card | 'system' superseded).
 * NULL (legacy default) renders as the owner, preserving old sentences.
 */
export type OwnerQuestionDismissActor = 'owner' | 'supervisor' | 'agent' | 'system';
export async function dismissOwnerQuestion(
  id: string,
  userId: string,
  /** OWNER-DISMISS-RAILS (2026-10-20): `supervisorRole` names WHICH supervisor seat dismissed
   *  ('fleet' default | 'project') — a project supervisor's dismissal was narrated as the
   *  Fleet Supervisor's. Narration only; the row keeps dismissedBy 'supervisor'. */
  opts: { dismissedBy?: OwnerQuestionDismissActor; reason?: string; supervisorRole?: 'fleet' | 'project' } = {},
): Promise<OwnerQuestionResolution> {
  const dismissedBy: OwnerQuestionDismissActor = opts.dismissedBy ?? 'owner';
  const projectSeat = opts.supervisorRole === 'project' && !ownerDismissRailsDisabled();
  const prisma = await db();
  const row = await prisma.ownerQuestion.findUnique({ where: { id } });
  if (!row || row.userId !== userId) return 'not_found';
  if (row.status !== 'open') return 'not_open';
  const flip = await prisma.ownerQuestion.updateMany({
    where: { id, status: 'open' },
    data: { status: 'dismissed', resolvedAt: new Date(Date.now()), dismissedBy },
  });
  if (flip.count === 0) return 'not_open';
  void import('./owner-interrupt-economy')
    .then((e) => e.recordOwnerQuestionResolved(row, { outcome: 'dismissed', by: dismissedBy, surface: 'dismiss' }))
    .catch(() => {});
  const actorLead =
    dismissedBy === 'supervisor' ? `${projectSeat ? 'The PROJECT supervisor' : 'The Fleet Supervisor'} (on the owner's behalf, under standing directives) dismissed this flagged question`
    : dismissedBy === 'agent' ? 'The chat that filed it dismissed this flagged question'
    : dismissedBy === 'system' ? 'The system dismissed this flagged question (superseded — not the owner\'s ruling)'
    : 'The owner dismissed this flagged question';
  const reasonSuffix = opts.reason ? ` — reason: ${String(opts.reason).replace(/["\n]/g, ' ').slice(0, 200)}` : '';
  // The note keeps the uniform '— stop raising it: "<question>"' ENDING the
  // frontend inbox parser (machine-wake.ts) extracts the question from
  // (regex anchors on the closing quote) — every qualifier goes before it.
  await postOwnerInboxNote(
    row.chatId,
    `[Owner inbox] ${actorLead}${reasonSuffix} — stop raising it: "${row.question}"`,
  );
  // audit 2026-10-06 T3-7 (fleet F11): the durable retry is keyed by the
  // QUESTION id ([owner-answer-retry:oq_…], like the answer path) — the chat-
  // keyed marker let the per-marker 24 h dedupe swallow a SECOND dismissal's
  // retry in the same chat, and the wake text now names the question id.
  // Kill switch OWNER_DISMISS_RETRY_QUESTION_KEY_DISABLED=1 (chat-keyed, no id).
  const keyByQuestion = process.env.OWNER_DISMISS_RETRY_QUESTION_KEY_DISABLED !== '1';
  // OWNER-DISMISS-RAILS review fix: the wake claims the 24 h re-flag cooldown
  // only when this dismissal arms it (supervisorDismissalArmsCooldown — a
  // supervisor's dismissal of an owner-only class card does not).
  const cooldownArmed = supervisorDismissalArmsCooldown({ dismissedBy, question: row.question, context: row.context ?? null });
  const dontRaise = dismissedBy === 'system'
    ? 'Do not raise this question again in the superseded form — answer the replacement card if it is still live'
    : cooldownArmed
      ? `Do not raise this question again (the 24h re-flag cooldown enforces it${reasonSuffix})`
      : `Do not raise this question again unless it still needs the owner's own decision (no re-flag cooldown was armed: it is an owner-only class question a supervisor cannot rule for the owner${reasonSuffix})`;
  await wakeChatForOwnerResolution(
    row.chatId,
    keyByQuestion
      ? `[Owner inbox — ${dismissedBy === 'owner' ? 'the OWNER' : dismissedBy === 'supervisor' ? (projectSeat ? 'the PROJECT SUPERVISOR (on the owner\'s behalf)' : 'the FLEET SUPERVISOR (on the owner\'s behalf)') : dismissedBy === 'agent' ? 'the FILING CHAT' : 'the SYSTEM (superseded)'} dismissed your flagged question ${row.id}] "${row.question}"\n\n${dontRaise}. If it blocked any of your todos, mark them appropriately and move on.`
      : `[Owner inbox — ${dismissedBy === 'owner' ? 'the OWNER' : dismissedBy === 'supervisor' ? (projectSeat ? 'the PROJECT SUPERVISOR (on the owner\'s behalf)' : 'the FLEET SUPERVISOR (on the owner\'s behalf)') : dismissedBy === 'agent' ? 'the FILING CHAT' : 'the SYSTEM (superseded)'} dismissed your flagged question] "${row.question}"\n\n${dontRaise}. If it blocked any of your todos, mark them appropriately and move on.`,
    keyByQuestion ? row.id : undefined,
    // A dismissal aimed at an ARCHIVED chat is dropped (no re-route, no retry).
    { kind: 'dismissal' },
  );
  // 2026-10-20 (specimen oq_892c91ae): the note on a card the OWNER dismissed
  // ("no new Hyperstack IP, ever — the account is shutting down …") is a
  // ruling for the whole fleet, not just a reason this card closed — ledger it
  // as an OPEN owner-origin directive when it reads as one. Owner dismissals
  // only: a supervisor / agent / system dismissal note is not the owner's words.
  if (dismissedBy === 'owner' && opts.reason) {
    await captureOwnerRulingOnSupervisorLedger(userId, { questionId: row.id, question: row.question, ruling: String(opts.reason), source: 'dismissal', sourceChatId: row.chatId });
  }
  return 'ok';
}

/* ── Decision-card answer coherence (ticket 992c8374) ───────────────────────
 * The 2026-09-05 incident: the Fleet Supervisor flagged the Spark bring-up
 * decision with flag_owner_question AND asked it with ask_user ("GO / NVFP4
 * first / Hold" + a custom text box). The owner typed custom answers into the
 * CARD three times — each resolved (or expired) the ask_user wait, but
 * NOTHING resolved the flagged ownerQuestion row, so the fleet-attention
 * block kept reporting "The owner has NOT answered — re-list it VERBATIM
 * every wake until it resolves" (supervisor-state.service.ts) and every wake
 * re-asked the decision: a card the owner had answered three times would not
 * dismiss. Answering EITHER surface must resolve both. */

/** Lowercase alphanumeric token stream — the normalization both sides of the
 *  same-decision test share (punctuation/casing/word-order agnostic). */
function normalizeQuestionText(s: string): string {
  return stripPriorDecisionAnnotation(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Function words + decision-frame boilerplate, excluded from content tokens.
 * The supervisor re-lists decisions VERBATIM per the attention block, so
 * formulaic frames ("Decision needed:", "GO with the current plan, or hold
 * the lane?", "Should we …") make stopword-INCLUSIVE overlap useless as a
 * discriminator — the round-1 adversarial review (B1) crossed the old
 * Jaccard bar on "Lane Helios: …" vs "Lane Apollo: …" (0.80) and
 * staging-vs-prod deploy frames (0.71). Deliberately NOT in this list:
 * option words that ARE the decision (go / hold / first / approve /
 * decline / ship / wait) and lane/model/region nouns — those discriminate.
 */
const DECISION_STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'without',
  'we', 'should', 'shall', 'would', 'could', 'can', 'will', 'do', 'does', 'did',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'have', 'has', 'had',
  'i', 'me', 'my', 'our', 'us', 'you', 'your', 'it', 'its',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'when',
  'where', 'why', 'how', 'if', 'then', 'else', 'than', 'so', 'such', 'as',
  'at', 'by', 'from', 'into', 'about', 'over', 'under', 'again', 'once',
  'just', 'also', 'please', 'per', 'via', 'now', 'not', 'no', 'yes',
  'need', 'needed', 'decision', 'decisions', 'question', 'answer', 'answered', 'owner',
]);

/** Stopword-free content tokens — the discriminative vocabulary of a decision. */
function contentTokens(normalized: string): Set<string> {
  return new Set(normalized.split(' ').filter((t) => t && !DECISION_STOPWORDS.has(t)));
}

/**
 * Are two question texts the SAME decision? The flag and the ask are written
 * by the same run about the same decision but are rarely byte-identical.
 * Match on (a) identical normalized forms, (b) normalized containment with a
 * minimum length guard (a short generic string must never "contain"-match),
 * or (c) content-token FULL COVERAGE: after stopword removal, EVERY content
 * token of the shorter set must appear in the larger set (and the shorter
 * set must carry at least 3 content tokens). Coverage — not a Jaccard ratio
 * — is the bar because a ratio lets formulaic frames match when only the
 * lane/region noun differs (round-1 review B1: "Lane Helios …" vs "Lane
 * Apollo …" false-matched at 0.80). A false positive records the owner's
 * answer against the WRONG open decision and silences its attention-block
 * listing, so the residual risk profile is deliberately asymmetric: a
 * missed match just leaves the flag open for the Inbox.
 * KNOWN RESIDUALS (accepted in round-2 review, documented not fixed):
 * (a) subset matches — "Merge PR 601?" vs "Merge PR 601 and PR 602?" match
 *     because the narrower decision's tokens are fully covered (requires
 *     both open simultaneously on one chat; the broader answer usually
 *     subsumes the narrower flag);
 * (b) negation carriers (with/without/not) are stopwords, so "Ship the
 *     stack without the migration?" matches "… with the migration?" — a
 *     token matcher does not model semantics, and the same-chat+same-owner
 *     scoping keeps the blast radius to one lane's own decisions.
 * Exported for the unit tests; the service half is
 * resolveOwnerQuestionsForChatAnswer below.
 */
export function isSameDecisionQuestion(a: string, b: string): boolean {
  const na = normalizeQuestionText(a);
  const nb = normalizeQuestionText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length >= 24 && longer.includes(shorter)) return true;
  let ta = contentTokens(na);
  let tb = contentTokens(nb);
  if (ta.size > tb.size) [ta, tb] = [tb, ta]; // ta = the smaller content set
  if (ta.size < 3) return false; // a tiny content set can never prove sameness
  for (const t of ta) if (!tb.has(t)) return false; // full coverage or nothing
  return true;
}

/**
 * Auto-resolve matching flagged questions when the owner answers a chat's
 * ask_user decision card (ticket 992c8374). Every OPEN row on the SAME chat
 * belonging to the SAME owner whose question is the same decision
 * (isSameDecisionQuestion) flips to answered with the typed answer — the
 * conditional updateMany keeps it one-shot/race-safe against a simultaneous
 * Inbox answer/dismiss, exactly like answerOwnerQuestion. The transcript note
 * records the provenance; the chat is deliberately NOT woken — the run that
 * asked is already resuming with this answer, so a wake would be a duplicate
 * machine turn. BEST-EFFORT like the rest of this module: never throws and
 * never fails the answer path that called it.
 */
export async function resolveOwnerQuestionsForChatAnswer(input: {
  chatId: string;
  userId: string;
  /** The ask_user question text as asked (the decision the owner just answered). */
  askedQuestion: string;
  /** The owner's typed (or quick-picked) answer. */
  answer: string;
  /** Ticket 50bcd1e7 (review N5/F1): provenance of the answer text. The
   *  default 'owner' is the ask_user card surface itself (an owner-typed
   *  answer); a caller REPLAYING an already-stored answer (the gate sweeper
   *  re-delivering an auto-defaulted row) passes that row's provenance so
   *  the credential-vault leg never mints from replayed non-owner text. */
  answeredBy?: 'owner' | 'supervisor' | 'default';
}): Promise<{ resolved: number; ids: string[] }> {
  const none = { resolved: 0, ids: [] as string[] };
  try {
    const asked = String(input.askedQuestion ?? '').trim();
    if (!asked) return none;
    const prisma = await db();
    const open = await prisma.ownerQuestion.findMany({
      where: { chatId: input.chatId, userId: input.userId, status: 'open' },
    });
    const matches = open.filter((row) => isSameDecisionQuestion(row.question, asked));
    if (!matches.length) return none;
    // Ticket 50bcd1e7: the ask_user card is the other owner-typed answer
    // surface. The LIVE run resumes with the raw answer, but the durable row
    // — what any later wake re-reads — was redacted, destroying the value;
    // route the credential spans to the vault FIRST (anchored on the first
    // matched row's id) so the stored row names $ENVKEY instead.
    const vaulted = await vaultOwnerAnswerSecrets(input.userId, matches[0].id, String(input.answer ?? ''), { answeredBy: input.answeredBy ?? 'owner' });
    // Same inbound credential scan as answerOwnerQuestion (item N9) — this is
    // the other path an owner-typed answer persists through.
    const answer = redactInboundSecrets(String(input.answer ?? '').trim()).slice(0, ANSWER_MAX);
    if (!answer) return none;
    const answerWithNotice = (vaulted.notice
      ? `${answer.slice(0, Math.max(0, ANSWER_MAX - vaulted.notice.length - 1))} ${vaulted.notice}`
      : answer
    ).slice(0, ANSWER_MAX);
    const ids: string[] = [];
    // OWNER-PROVENANCE-STRICT (2026-10-20): a REPLAYED non-owner answer (the
    // gate sweeper re-delivering a supervisor / default row) keeps its
    // provenance on the closed row, in the note and through the gate unblock
    // — it was stamped (and narrated) as the owner's. An owner card answer
    // still stamps nothing (the 992c8374 shape).
    const strictProvenance = !ownerProvenanceStrictDisabled();
    const replayBy: 'owner' | 'supervisor' | 'default' = strictProvenance ? (input.answeredBy ?? 'owner') : 'owner';
    const cardActor = replayBy === 'supervisor'
      ? 'The Fleet Supervisor\'s answer (standing directives — not the owner) was re-delivered to your flagged question through the in-chat decision card'
      : replayBy === 'default'
        ? 'Your flagged question was resolved by its preset DEFAULT (no owner answer), re-delivered through the in-chat decision card'
        : 'The owner answered your flagged question from the in-chat decision card';
    for (const q of matches) {
      // Todo 77c88942 item 2: a TYPED gate never auto-resolves off a card
      // answer — a credential gate opens only on its own state check, a
      // choice/yes_no gate only on its own typed match. The card's answer is
      // the ask_user decision, not this row's declared shape.
      if (parseExpectedAnswerType((q as any).expectedAnswerType, q.question).type) continue;
      const flip = await prisma.ownerQuestion.updateMany({
        where: { id: q.id, status: 'open' },
        data: { status: 'answered', answer: answerWithNotice, resolvedAt: new Date(Date.now()), ...(replayBy !== 'owner' ? { answeredBy: replayBy } : {}) },
      });
      if (flip.count === 0) continue; // resolved elsewhere in the race — no duplicate note
      ids.push(q.id);
      void import('./owner-interrupt-economy')
        .then((e) => e.recordOwnerQuestionResolved(q, { outcome: 'answered', by: replayBy, surface: 'chat_card' }))
        .catch(() => {});
      await postOwnerInboxNote(
        q.chatId,
        `[Owner inbox] ${cardActor} — Q: "${q.question}" A: "${answerWithNotice}" (auto-resolved: the same decision was answered on the ask_user card, ticket 992c8374; the flag row is closed so it stops re-listing).`,
      );
      // Ticket 356d21bb: the card answer resolves ALL derived gates too —
      // todos/goals parked with gateQuestionId = this row flip actionable
      // through the SAME choke point as the Inbox answer path.
      // CanLaw 2026-09-15: a card answer that is itself a question releases
      // the gate as the team's own (blocked, blockKind 'agent') — same rule
      // as the Inbox path. The run that asked already holds the raw answer.
      await unblockGatesForAnsweredQuestion({
        userId: input.userId, questionId: q.id, question: q.question, answer: answerWithNotice,
        source: 'in-chat card answer',
        counterQuestion: replayBy === 'owner' && isCounterQuestionAnswer(answer, null),
        answeredBy: replayBy,
      });
    }
    if (ids.length) {
      void logOwnerQuestions('info', `owner-questions: auto-resolved ${ids.length} flagged question(s) on chat ${input.chatId} from an in-chat card answer: ${ids.join(', ')}`);
    }
    return { resolved: ids.length, ids };
  } catch (err: any) {
    await logOwnerQuestions('warn', `owner-questions: auto-resolve on a card answer failed for chat ${input.chatId}: ${err?.message ?? err}`);
    return none;
  }
}

/* ── Stopped-schedule decision cards (SA0906) ────────────────────────────────
 * A recurring schedule that permanently stops by a MACHINE path (run-cap
 * exhaustion, lifetime expiry, a machine-turn cancel) while its chat's project
 * holds an ACTIVE goal — AND the lane's heartbeat actually died (no enabled
 * successor schedule, no recent runs) — files an owner decision through THIS
 * machinery (the #624 pending-decisions queue: badge + push + one-tap resolve).
 * See coding/stopped-schedule-alert.ts for the filing half. The decision's
 * context embeds a machine-readable marker carrying the scheduleId; these
 * helpers own the marker format, the per-scheduleId dedupe read, and the
 * auto-resolve when the LANE comes back to life by any path — the same row
 * re-enabled OR any new enabled schedule armed on the chat (self-renewing
 * schedule_self chains arm a successor per spent link; a successor IS the
 * resolution — the #625 doctrine: a decision the world already made must stop
 * asking).
 */

/** Leads every stopped-schedule marker — the session-scoped resolve scans for it. */
export const STOPPED_SCHEDULE_MARKER_PREFIX = '[stopped-schedule:';

/** Machine-readable marker embedded in a stopped-schedule decision's context.
 *  MUST lead the context so the 4000-char cap can never truncate it away. */
export function stoppedScheduleMarker(scheduleId: string): string {
  return `${STOPPED_SCHEDULE_MARKER_PREFIX}${scheduleId}]`;
}

/**
 * Per-scheduleId dedupe read: is an OPEN stopped-schedule decision already
 * filed for this schedule? Fail-open to false (a read hiccup must not block
 * the alert — flagOwnerQuestion's exact-question dedupe backstops a double).
 */
export async function hasOpenStoppedScheduleDecision(scheduleId: string): Promise<boolean> {
  try {
    const prisma = await db();
    const row = await prisma.ownerQuestion.findFirst({
      where: { status: 'open', context: { contains: stoppedScheduleMarker(scheduleId) } },
    });
    return !!row;
  } catch (err: any) {
    await logOwnerQuestions('warn', `owner-questions: stopped-schedule dedupe read failed for ${scheduleId}: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Per-CHAT dedupe read (ticket 3ce5f6d0 case C): is ANY stopped-schedule
 * decision already open on this chat? One card per lane ever — two stopped
 * links of the same lane must not stack two resume cards (the 2026-09-10
 * 19:07Z double on the kernel lane: oq_9ffc4f5a + oq_dfe04aab). Fail-open to
 * false, same posture as the per-schedule read.
 */
export async function hasOpenStoppedScheduleDecisionForChat(sessionId: string): Promise<boolean> {
  try {
    const prisma = await db();
    const row = await prisma.ownerQuestion.findFirst({
      where: { chatId: sessionId, status: 'open', context: { contains: STOPPED_SCHEDULE_MARKER_PREFIX } },
    });
    return !!row;
  } catch (err: any) {
    await logOwnerQuestions('warn', `owner-questions: stopped-schedule chat dedupe read failed for ${sessionId}: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * The LANE revived — an enabled schedule appeared on the chat by ANY path
 * (Schedules-tab resume of any row, a fresh schedule_self / schedule_message
 * successor): every open stopped-schedule decision on that chat is moot — flip
 * them to answered with an auto-resolution note so the queue badge clears.
 * Session-scoped on purpose (successor = resolution, SA0906 revision): the
 * spark-cluster chains never resume a spent link, they arm a NEW one. The
 * transcript note records the provenance; the chat is deliberately NOT woken
 * (the revival itself is the action the decision asked about — a wake would
 * burn a machine turn to state the obvious). Same one-shot conditional flip as
 * answerOwnerQuestion; never throws (the arm/resume path must not break on an
 * inbox hiccup).
 */
export async function resolveStoppedScheduleDecisionsForSession(sessionId: string, successorId?: string): Promise<number> {
  try {
    const prisma = await db();
    const open = await prisma.ownerQuestion.findMany({
      where: { chatId: sessionId, status: 'open', context: { contains: STOPPED_SCHEDULE_MARKER_PREFIX } },
    });
    let resolved = 0;
    // v1#12 successor honesty: the resolution NAMES the successor schedule
    // (callers pass the RECURRING enabled row that revived the lane) so the
    // owner can verify the claim instead of trusting "a schedule exists".
    const successorPhrase = successorId
      ? `A recurring successor schedule ${successorId} is armed on this chat`
      : 'An enabled recurring schedule is armed on this chat again';
    for (const q of open) {
      const flip = await prisma.ownerQuestion.updateMany({
        where: { id: q.id, status: 'open' },
        data: {
          status: 'answered',
          answer: `[auto-resolved] ${successorPhrase}, so this resume decision is moot.`,
          resolvedAt: new Date(Date.now()),
        },
      });
      if (flip.count === 0) continue; // resolved elsewhere in the race
      resolved++;
      await postOwnerInboxNote(
        q.chatId,
        `[Owner inbox] Auto-resolved a stopped-schedule decision — ${successorPhrase.charAt(0).toLowerCase()}${successorPhrase.slice(1)}, so "${q.question}" no longer needs an answer.`,
      );
    }
    if (resolved) {
      void logOwnerQuestions('info', `owner-questions: auto-resolved ${resolved} stopped-schedule decision(s) on chat ${sessionId} — the lane re-armed`);
    }
    return resolved;
  } catch (err: any) {
    await logOwnerQuestions('warn', `owner-questions: stopped-schedule auto-resolve failed for chat ${sessionId}: ${err?.message ?? err}`);
    return 0;
  }
}

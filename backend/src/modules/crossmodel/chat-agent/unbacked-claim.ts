/**
 * UNBACKED DISPATCH CLAIM (2026-09-29 — TB 2.1 v3c bench, owner: "fix that
 * lost to a supervisor relay failure … i want the most accurate numbers").
 *
 * On a HUMAN turn in a supervisor chat the lead sometimes answers a dispatch
 * request with prose alone — "Dispatched this turn — receipt: 9e1c13ea" —
 * while the run made ZERO tool calls: nothing was sent and the receipt id was
 * invented. The bench lost 2 of 40 trials this way after five relay attempts
 * (every failing reply had a text part only; every successful one carried a
 * send_chat_message tool call). The chat lane now re-runs such a turn ONCE
 * with a harness note naming the invented ids (chat-agent.service.ts, after
 * the leak retry). A turn with no tool call has no side effects, so the
 * replay is safe; an id that matches a REAL receipt of the chat (an honest
 * reference to an earlier send) never triggers it, so the retry cannot cause
 * a duplicate send.
 */
import prisma from '../../../config/database';
import { PLATFORM_READ_TOOLS, PLATFORM_MUTATING_TOOLS } from '../platform/platform-tool-names';
import { INTEGRATION_WRITE_TOOL_NAMES } from '../coding/integration-tool-schema';
import { stripNoActionToolNote, insertNoActionToolNote, noActionToolNoteDisabled, endsInsideOpenFence, hasNoActionToolNote, NO_ACTION_TOOL_NOTE } from './no-action-note';
import { parseFollowUps, stripAnswerMarkup } from '../langgraph/pipeline-utils';
import { artifactAttributionDisabled, attributionClaimSentences, attributionMismatches, attributionOfReceiptIds, type AttributionMismatch, type TodoRowForCheck } from '../coding/artifact-attribution';
import {
  CLAIM_VERB_OR_NOUN_SRC,
  CLAIM_VERB_TOOL_CLASSES,
  expectedToolsForCitation,
  isOwnActActiveAt,
  isOwnActPassiveAt,
  isParticipleAt,
  clauseSeparatorBetween,
  claimVerbActClass,
  agentiveByAfterToken,
} from '../platform/claim-verb-classes';

/** Verbs that claim a message went out. */
export const DISPATCH_CLAIM_RE = /\b(?:re-?dispatched|dispatched|forwarded|re-?sent|sent|delivered|relayed)\b/i;
/** The word that introduces a receipt citation ("receipt 9e1c13ea", "send receipt: …", "receipts d0490bf8, 403b3ad5"). */
const RECEIPT_KW_RE = /\breceipts?\b/gi;
/** An 8-hex id (optionally the head of a full uuid) inside the citation window. */
const HEX8_RE = /\b([0-9a-f]{8})(?:-[0-9a-f]{4}(?:-[0-9a-f]{4}){0,3}(?:-[0-9a-f]{12})?)?\b/gi;
/** How far past "receipt" a cited id may sit — the window also stops at the sentence end. */
const RECEIPT_WINDOW = 120;

/** The supervisor unbacked-claim re-run is always on (the
 *  SUPERVISOR_UNBACKED_CLAIM_RETRY_DISABLED release switch was removed
 *  2026-10-30, RSW-1 cohort delete). */

/**
 * Pure: the receipt ids a final answer cites for a dispatch it claims, when
 * the run made NO tool call at all (so no id can be real THIS turn). Null when
 * the run called any tool, the text claims no dispatch, or cites no receipt.
 */
export function unbackedDispatchClaimIds(text: string, parts: Array<{ type?: string }> | undefined): string[] | null {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  if ((parts ?? []).some((p) => p?.type === 'tool_call')) return null;
  if (!DISPATCH_CLAIM_RE.test(t)) return null;
  const ids = new Set<string>();
  for (const kw of t.matchAll(RECEIPT_KW_RE)) {
    const start = (kw.index ?? 0) + kw[0].length;
    let win = t.slice(start, start + RECEIPT_WINDOW);
    const end = win.search(/[.;](?:\s|$)|\n/);
    if (end >= 0) win = win.slice(0, end);
    for (const m of win.matchAll(HEX8_RE)) ids.add(m[1].toLowerCase());
  }
  return ids.size ? [...ids].slice(0, 6) : null;
}

/**
 * The cited ids that match NO receipt of this chat (any time). An id that
 * does match is an honest reference to an earlier send. Fail-closed on a read
 * error: nothing is treated as invented, so no retry fires.
 */
export async function inventedReceiptIds(chatId: string, ids: string[]): Promise<string[]> {
  try {
    const found = new Set<string>();
    for (const id of ids) {
      const row = await (prisma as any).runToolReceipt.findFirst({ where: { chatId, id: { startsWith: id } }, select: { id: true } });
      if (row) found.add(id);
    }
    return ids.filter((id) => !found.has(id));
  } catch {
    return [];
  }
}

// ── FOLLOW-THROUGH ID GROUNDING (todo efb2960d, audit 2026-10-16 — specimens
// bc618690 + fc20e6df) ────────────────────────────────────────────────────────
// A FOLLOW-THROUGH / continuation round of a human ask runs machine-origin
// (source 'schedule', args.continuation set) but IS the answer the human was
// promised — and every existing citation lane stands down the moment the run
// made ANY tool_call part (unbackedDispatchClaimIds / toolNounCitedIds both
// return null then), so a round that made read-only calls cited INVENTED
// receipt ids untouched (bc618690, Fleet Supervisor 05:59:02Z: "Steered the
// supervisor … (receipt 6d75445d)", "- Sent the ping to the deploy lane
// 24f1950e — 1d5a6905" — neither id exists in its receipts, plus a dead chat
// link rendered as if real). fc20e6df (08:08Z, human lane, ZERO tools) typed
// "Ledger verified — receipt b471f5dc" — no dispatch verb, no first person, no
// ACTIONS TAKEN header, so every lane missed that shape too. The detectors
// below have NO tool-call precondition and NO dispatch-verb requirement; the
// HONESTY CHECK (a real receipt id, or a value inside a receipt's ids
// envelope) is the only thing that clears an id. Wiring: chat-agent.service.ts
// ENFORCES on continuation rounds (rewrite before delivery + meta.enforced on
// supervisor_unbacked_claim_machine) and joins the invented ids into the human
// lane's existing retry machinery. Kill switch
// SUPERVISOR_FOLLOW_THROUGH_ID_GROUNDING_DISABLED=1.

/** True when the follow-through/continuation id-grounding leg is switched off (todo efb2960d). */
export function followThroughIdGroundingDisabled(): boolean {
  return process.env.SUPERVISOR_FOLLOW_THROUGH_ID_GROUNDING_DISABLED === '1';
}

/** A bare 8-hex id with at least one letter — NOT the head of a longer uuid (that is a chat/lane id, the chat-link lane's business) and not a decimal run like a date. */
const BARE_HEX8_RE = /\b(?=[0-9a-f]*[a-f])([0-9a-f]{8})\b(?!-)/gi;
/** A full 36-char chat uuid. */
const CHAT_UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
/** The text right after a cited id denies its existence — an honest "no such receipt", never a fabrication. */
const NO_SUCH_AFTER_RE = /\b(?:does\s+not\s+exist|doesn'?t\s+exist|do\s+not\s+exist|don'?t\s+exist|no\s+such|not\s+found|never\s+existed|no\s+longer\s+exists|is\s+not\s+(?:a\s+)?real|isn'?t\s+real|unknown)\b/i;
/** A third-party reporter naming the act before the id — a RELAY of another lane's claim, never this note's own ("the deploy lane reported …", "the supervisor confirmed …"). */
const THIRD_PARTY_RELAY_RE = /\b(?:the\s+)?(?:lane|supervisor|worker|agent|session|run|child|fleet|bench)\b[^.!?]{0,40}?\b(?:said|says|reported|reports|replied|replies|told|tells|noted|notes|claimed|claims|answered|answers|messaged|sent|dispatched|delivered|forwarded|relayed|confirmed|confirms)\b/i;
/** A citation separator directly before an id — "— 1d5a6905", ": abcdef01", "(6d75445d)", "receipt 9e1c13ea". A bare TARGET reference ("to the deploy lane 24f1950e", "chat d1d0b346") is never a citation. */
const CITED_BEFORE_RE = /(?:→|->|:|—|–|\(|#|receipts?)\s*$/i;

/** First-person or subject-less (sentence/bullet-initial) act verbs — the ACTION_CLAIM_PATTERNS shapes ("I steered …", "Steered the supervisor …", "- Sent the ping …"). Built lazily: the verb vocabularies are declared lower in this file. */
let _ownClaimSentenceRe: RegExp | null = null;
function ownClaimSentenceRe(): RegExp {
  if (!_ownClaimSentenceRe) {
    _ownClaimSentenceRe = new RegExp(
      `${SUBJ}(?:${SEND_PAST}|${SEND_GER}|${READ_PAST}|${READ_GER}|${CHANGE_PAST}|${CHANGE_GER})\\b`
      + `|(?:^|(?<=[.!?]\\s{1,3}))[ \\t]*(?:[-*•]\\s+|\\d+[.)]\\s+)?(?:\\*\\*|__)?(?:${SEND_PAST}|${SEND_GER}|${READ_PAST}|${READ_GER}|${CHANGE_PAST}|${CHANGE_GER})\\b`,
      'im',
    );
  }
  return _ownClaimSentenceRe;
}

/** Any act verb (send / read / change, past or gerund) ANYWHERE in a sentence — the weaker claim signal a receipt-keyword citation needs ("Ledger verified — receipt b471f5dc" has no first person and no sentence-initial verb). Built lazily, like the sentence RE. */
let _anyActVerbRe: RegExp | null = null;
function anyActVerbRe(): RegExp {
  if (!_anyActVerbRe) _anyActVerbRe = new RegExp(`\\b(?:${SEND_PAST}|${SEND_GER}|${READ_PAST}|${READ_GER}|${CHANGE_PAST}|${CHANGE_GER})\\b`, 'i');
  return _anyActVerbRe;
}

/** The shared citation guards: quoted/code, disclaimed, a third-party relay, or a "no such id" denial right after. */
function citationIsRelayedOrDisclaimed(t: string, s0: number, at: number, end: number): boolean {
  if (inQuoteOrCode(t, s0, at)) return true;
  const before = t.slice(Math.max(s0, at - DISCLAIMER_WINDOW), at);
  if (disclaimedBefore(before)) return true;
  if (THIRD_PARTY_RELAY_RE.test(before)) return true;
  if (NO_SUCH_AFTER_RE.test(t.slice(end, end + 72))) return true;
  return false;
}

/**
 * Pure: the receipt-shaped ids a note cites as its OWN action — (a) any id in
 * a "receipt(s) …" citation window whose sentence carries a claim signal (no
 * dispatch verb required: "Ledger verified — receipt b471f5dc"; plain
 * commentary — "The receipt 9e1c13ea looks odd to me" — cites nothing as an
 * act), and (b) any bare 8-hex id in CITATION position (after a dash / colon
 * / arrow / paren / the receipt word) inside a first-person or bullet-shaped
 * claim sentence. NO tool-call precondition and NO dispatch-verb requirement —
 * a read-only round's citations are judged too (that is the bc618690 escape).
 * A TARGET reference ("to the deploy lane 24f1950e") is not a citation.
 * Quoted/code, disclaimed, third-party-relay and "no such id" sentences are
 * skipped; whether an id is INVENTED is judged separately (the grounding
 * check). Null when none. Capped at 6.
 */
export function citedOwnReceiptIds(text: string): string[] | null {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  const ids = new Set<string>();
  // (a) the receipt-keyword citation window.
  for (const kw of t.matchAll(RECEIPT_KW_RE)) {
    const start = (kw.index ?? 0) + kw[0].length;
    let win = t.slice(start, start + RECEIPT_WINDOW);
    const end = win.search(/[.;](?:\s|$)|\n/);
    if (end >= 0) win = win.slice(0, end);
    for (const m of win.matchAll(HEX8_RE)) {
      const at = start + (m.index ?? 0);
      const [s0, se] = sentenceBounds(t, at);
      if (!ownClaimSentenceRe().test(t.slice(s0, se)) && !anyActVerbRe().test(t.slice(s0, se))) continue;
      if (citationIsRelayedOrDisclaimed(t, s0, at, at + m[0].length)) continue;
      ids.add(m[1].toLowerCase());
    }
  }
  // (b) a claim sentence carrying a bare id in citation position.
  for (const m of t.matchAll(BARE_HEX8_RE)) {
    const at = m.index ?? 0;
    const [s0, se] = sentenceBounds(t, at);
    if (!ownClaimSentenceRe().test(t.slice(s0, se))) continue;
    if (!CITED_BEFORE_RE.test(t.slice(s0, at))) continue;
    if (citationIsRelayedOrDisclaimed(t, s0, at, at + m[0].length)) continue;
    ids.add(m[1].toLowerCase());
  }
  return ids.size ? [...ids].slice(0, 6) : null;
}

/**
 * Pure: the full 36-char chat uuids a note cites in a claim sentence (its own
 * action) — a dead link rendered as if real (bc618690's
 * 99e63f86-69cf-4b09-90dc-b4f143d01942). Empty when none. Capped at 4.
 */
export function citedChatLinkIds(text: string): string[] {
  const t = String(text ?? '');
  if (!t.trim()) return [];
  const ids = new Set<string>();
  for (const m of t.matchAll(CHAT_UUID_RE)) {
    const at = m.index ?? 0;
    const [s0, se] = sentenceBounds(t, at);
    if (!ownClaimSentenceRe().test(t.slice(s0, se))) continue;
    if (citationIsRelayedOrDisclaimed(t, s0, at, at + m[0].length)) continue;
    ids.add(m[1].toLowerCase());
  }
  return [...ids].slice(0, 4);
}

/** A follow-through round's id-grounding verdict: the invented receipt ids and the dead chat links it cited. */
export interface FollowThroughGrounding { invented: string[]; deadChatLinks: string[] }

/**
 * Ground every id a follow-through note cites as its own action: the receipt
 * ids that resolve to NO receipt of this chat — inventedToolNounIds' WIDER
 * check (a receipt id prefix OR any value inside a receipt's ids envelope),
 * because an honest reference cites LANE ids too (bc618690's "deploy lane
 * 24f1950e" is real and cited in the same breath as the invented ones; a
 * prefix-only check would convict it) — and the chat links that resolve to no
 * chat row. Fail-closed on any read error: ids are treated as real, nothing
 * is invented, no rewrite fires.
 */
export async function groundFollowThroughCitations(chatId: string, text: string): Promise<FollowThroughGrounding> {
  const t = String(text ?? '');
  const cited = citedOwnReceiptIds(t);
  const invented = cited?.length ? await inventedToolNounIds(chatId, cited) : [];
  const deadChatLinks: string[] = [];
  for (const id of citedChatLinkIds(t)) {
    let row: unknown;
    try {
      row = await (prisma as any).crossModelChat.findFirst({ where: { id }, select: { id: true } });
    } catch { continue; } // fail-closed: a read error treats the link as real
    if (!row) deadChatLinks.push(id);
  }
  return { invented, deadChatLinks };
}

// ── TOOL-NOUN CITATIONS (todo 77c88942 item 3, 2026-10-16 — LiteLLM specimen
// 8fae35a4) ──────────────────────────────────────────────────────────────────
// "start_coding_session → 9e39ec5c" — the LiteLLM project supervisor's HUMAN
// turn (c6941c11, 02:42Z) claimed a dispatch with an INVENTED lane id while
// the run made ZERO tool calls (real dispatch 04:42:59Z, receipt a5323560 →
// lane 6a4319da, proves the tool mints receipts; retracted by msg 169a1fbc).
// The dispatch lane missed it twice: 'start_coding_session' is a tool NOUN,
// not one of the 7 send verbs, and RECEIPT_KW_RE only opens a citation window
// after the literal word "receipt" — the arrow id sat outside every window.
// A consequential tool noun cited with an id in arrow/colon shape IS a
// dispatch claim: the noun names the act. Zero-tool runs only (same
// condition as the dispatch lane).

/** Consequential tool nouns whose direct id citation asserts the act ran. */
export const TOOL_NOUN_RE = /\b(?:start_coding_session|send_chat_message|send_to_instance|dispatch_platform_task|delegate_parallel|delegate|schedule_message|update_schedule|flag_owner_question|file_feedback|store_secret|stage_upload|git_commit|git_push|open_pull_request|merge_pull_request)\b/i;
/** A tool noun directly followed by a separator and an 8-hex id: "start_coding_session → 9e39ec5c", "git_commit: 77b92751". */
const TOOL_NOUN_CITATION_RE = new RegExp(`\\b(?:start_coding_session|send_chat_message|send_to_instance|dispatch_platform_task|delegate_parallel|delegate|schedule_message|update_schedule|flag_owner_question|file_feedback|store_secret|stage_upload|git_commit|git_push|open_pull_request|merge_pull_request)\\b(?:\\s*(?:→|->|:|—|–)\\s*)([0-9a-f]{8})`, 'gi');

/**
 * Pure: the ids a final answer cites DIRECTLY after a consequential tool
 * noun, when the run made NO tool call at all. A sentence placing the act in
 * the PAST of another turn (historicalExemptLegacy — this lane keeps the pre-318b3175 test, review B1), a disclaimed or quoted sentence,
 * is a REPORT, never this answer's claim — skipped. Null when the run called
 * any tool, or no such citation exists.
 */
export function toolNounCitedIds(text: string, parts: Array<{ type?: string }> | undefined): string[] | null {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  if ((parts ?? []).some((p) => p?.type === 'tool_call')) return null;
  const ids = new Set<string>();
  TOOL_NOUN_CITATION_RE.lastIndex = 0;
  for (const m of t.matchAll(TOOL_NOUN_CITATION_RE)) {
    const at = m.index ?? 0;
    const [s0] = sentenceBounds(t, at);
    if (historicalExemptLegacy(t.slice(s0, at + m[0].length))) continue;
    const before = t.slice(Math.max(s0, at - DISCLAIMER_WINDOW), at);
    if (disclaimedBefore(before) || inQuoteOrCode(t, s0, at)) continue;
    ids.add(m[1].toLowerCase());
  }
  return ids.size ? [...ids].slice(0, 6) : null;
}

/**
 * The tool-noun-cited ids that match NO real entity of this chat's history.
 * Wider than inventedReceiptIds on purpose: an HONEST reference to an earlier
 * dispatch cites the LANE id ("start_coding_session → 6a4319da"), which lives
 * INSIDE the real receipt's ids envelope ({chatId: '6a4319da…'}), not as a
 * receipt id — checking only the receipt id space would false-positive every
 * honest report. An id is honest when it matches (a) a receipt id prefix, or
 * (b) any VALUE inside a receipt's ids envelope of this chat (chatId/
 * sessionId/scheduleId/prNumber/sha/ticketId — the entities the channel has
 * actually seen). Fail-closed on a read error: nothing invented, no retry.
 */
export async function inventedToolNounIds(chatId: string, ids: string[]): Promise<string[]> {
  try {
    const rows: any[] = await (prisma as any).runToolReceipt.findMany({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { id: true, ids: true },
    });
    const known = new Set<string>();
    for (const r of rows) {
      known.add(String(r.id).slice(0, 8).toLowerCase());
      const env = (r.ids ?? {}) as Record<string, unknown>;
      for (const v of Object.values(env)) {
        if (typeof v === 'string' && /^[0-9a-f]{8}/i.test(v)) known.add(v.slice(0, 8).toLowerCase());
        if (typeof v === 'number' && Number.isInteger(v)) known.add(String(v));
      }
    }
    return ids.filter((id) => !known.has(id));
  } catch {
    return [];
  }
}

// ── RECEIPT TRIPLE GROUNDING (audit 2026-10-16, todo d597ce5d — #1578 escape,
// monitor lesson 6) ───────────────────────────────────────────────────────────
// PR #1578 grounded the ID alone: a cited receipt id that resolves to ANY
// receipt of the chat is honest, whatever the tool. Specimens (Fleet Supervisor
// follow-through rounds, graded by the monitor at 13:53Z):
//  (a) ad60c49d — 13:53Z "Follow-through done" note, ACTIONS TAKEN:
//      "Resolved duplicate ticket 9c307167 via filer self-close — receipt
//      ticket 9c307167" (and the 93292353 twin). Both ids RESOLVE — but only
//      via the chat's file_feedback envelopes (2a6a748f / 0bb1f832, ok): the
//      run's own update_feedback calls (fb1b249c / 47e13553 / 306a5014 /
//      caf83213) are ALL ok:false. The close verb was backed by a file tool.
//  (b) 05126597 — a send_chat_message receipt whose delivered payload claims
//      "The fleet's two duplicates (93292353, 9c307167) are pinned at priority
//      0 with adminNotes" on the strength of those same failed update_feedback
//      calls — update-verb prose inside a send-verb receipt's payload.
// Law: an id resolves to a receipt OF THE TOOL CLASS THE CLAIM'S VERB NAMES.
// The cited receipt's tool must belong to that class; a mismatch is the SAME
// strike path as a phantom id. OBSERVE-ONLY FIRST: the metric
// receipt_tool_mismatch (loop_metrics) carries a 7-day baseline before any
// enforcement (same ladder as 6f8b52b7 / PR #1548). Kill switch
// RECEIPT_TOOL_TRIPLE_GROUNDING_DISABLED=1.

/** Kill switch for the (verb, tool, id) triple check (metric-only today). */
export function receiptTripleGroundingDisabled(): boolean {
  return process.env.RECEIPT_TOOL_TRIPLE_GROUNDING_DISABLED === '1';
}

/**
 * (ticket f05b38c1) Kill switch for the ENFORCEMENT half only — the pre-delivery
 * rewrite of an act-grade verb mismatch on a supervisor final. The observe-only
 * metric (every grade) keeps recording when this is set; an operator who
 * suspects a false strike restores the pre-f05b38c1 observe-only behaviour in
 * one box-env var while the data still accumulates.
 */
export function receiptTripleEnforceDisabled(): boolean {
  return process.env.RECEIPT_TOOL_TRIPLE_ENFORCE_DISABLED === '1';
}

export {
  CLAIM_VERB_TOOL_CLASSES,
  expectedToolsForCitation,
} from '../platform/claim-verb-classes';

/**
 * One triple candidate the note offers for grounding: an id, the verb the
 * claim sentence used, and (when the citation is TOOL-NOUN shaped) the noun
 * itself. phrase is the citing sentence's first 120 chars for the metric.
 * grade (ticket f05b38c1): 'act' — an own-act verb governs the id (the
 * enforcement lane rewrites it); 'report' — the id rides a report/entity
 * citation (observe-only, never rewritten). sentAt carries the citing
 * sentence's start offset for the span rewrite.
 */
export interface ReceiptTripleCandidate {
  id: string;
  verb: string | undefined;
  noun?: string;
  phrase: string;
  grade: ReceiptTripleGrade;
  /** The citing sentence's start offset in the text (span rewrite anchor). */
  sentAt: number;
  /** The id's offset in the TEXT (span rewrite anchor — the FIRST occurrence of this id). */
  idAt: number;
  /**
   * (ticket c7b408ef) How the binding was made — the sibling-act rescue applies
   * to the GRAMMAR-GUESSED bindings only ('clause' / 'borrow'): a 'noun' or
   * 'passive' binding names its act precisely and is never rescued.
   */
  via?: 'noun' | 'clause' | 'borrow' | 'passive';
}

/**
 * The triple lane's OWN id pattern — permissive on purpose: pure-decimal ids
 * are allowed (specimen 93292353 has no a-f letter; the shared BARE_HEX8_RE
 * excludes decimal runs as clock/date guards). Safe HERE because the lane is
 * RESOLUTION-gated: an id that matches no receipt id prefix and no envelope
 * value of this chat is skipped entirely (the invented-id lane's business) —
 * a date or phone number that cites nothing can never reach a verdict.
 */
const TRIPLE_ID_RE = /\b([0-9a-f]{8})\b(?!-)/gi;

/**
 * Citation position for the TRIPLE check only (the shared CITED_BEFORE_RE is
 * untouched): the sibling shapes PLUS the entity nouns a supervisor cites
 * ("receipt ticket 9c307167" — the ad60c49d bullet; the id after "ticket"
 * sits OUTSIDE every shared window) and the id-list separators of a paren
 * enumeration ("(93292353, 9c307167)" — the 05126597 payload).
 */
const TRIPLE_CITED_BEFORE_RE = /(?:→|->|:|—|–|\(|#|receipts?|ticket|sched(?:ule)?|goal|todo|oq|pr|,|·|;)\s*$/i;

/** A tool noun directly before the citation separator ("receipt ticket 9c307167", "start_coding_session → 9e39ec5c"). */
const NOUN_BEFORE_CITATION_RE = /\b(start_coding_session|send_chat_message|send_to_instance|dispatch_platform_task|delegate_parallel|delegate|schedule_message|update_schedule|flag_owner_question|file_feedback|triage_ticket|resolve_feedback|update_feedback|update_supervisor_state|store_secret|stage_upload|git_commit|git_push|open_pull_request|merge_pull_request|notify_user|send_email_as_digby|gmail_send_email|dismiss_owner_question|answer_owner_question|answer_chat_question|todo_update|goal_update|goal_premise_set|goal_create|todo_create|archive_chat)\b(?:\s*(?:→|->|:|—|–)\s*)?$/i;

/**
 * (ticket f05b38c1) The citation grade. 'act' — the id is cited as the
 * note's OWN action claim (an own-act verb governs it: the enforcement lane
 * rewrites these before delivery). 'report' — the id rides a report of
 * another actor's work, an entity citation, or an annotation aside; the
 * observe-only metric still records it, but no rewrite ever touches it (a
 * false strike on an honest note is strictly worse than a miss — 587e9d64).
 */
export type ReceiptTripleGrade = 'act' | 'report';

/**
 * Words allowed in a citation clause that is a bare POINTER (an id
 * enumeration or a receipt/entity pointer) — anything else in the clause
 * head means the id is cited inside running prose, not as the claim's own
 * receipt citation, and no backward borrow may cross it.
 */
const POINTER_WORDS_RE = /^(?:receipts?|ticket|sched(?:ule)?|schedule|goal|todo|oq|pr|msg|chat|lane|and|both|canonical|open|filed|resolved)$/i;

/** Is this clause head (text between the clause start / open paren and the id) a bare pointer — markers, ids, entity nouns only? */
function barePointerHead(clauseBeforeId: string): boolean {
  const stripped = clauseBeforeId
    .replace(/\b[0-9a-f]{8}\b/gi, '')
    .replace(/[\s·,;()#→:—–\-*_"'\[\]]+/g, ' ')
    .trim();
  if (!stripped) return true;
  return stripped.split(/\s+/).every((w) => POINTER_WORDS_RE.test(w));
}

/** Does the pointer name the RECEIPT itself (the word "receipt" or a tool noun) — the borrow-crossing credential? */
function namesReceipt(clauseBeforeId: string): boolean {
  return /\breceipts?\b/i.test(clauseBeforeId) || NOUN_BEFORE_CITATION_RE.test(clauseBeforeId);
}

/** Paren depth at offset `at` in `s` (depth > 0 ⇒ inside an aside). */
function parenDepthAt(s: string, at: number): number {
  let d = 0;
  for (let i = 0; i < at && i < s.length; i++) {
    if (s[i] === '(') d += 1;
    else if (s[i] === ')') d -= 1;
  }
  return d;
}

/** The offset of the '(' that opens the aside containing `at`, or -1 when `at` is at depth 0. */
function asideOpenAt(s: string, at: number): number {
  let d = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (s[i] === ')') d += 1;
    else if (s[i] === '(') {
      if (d === 0) return i;
      d -= 1;
    }
  }
  return -1;
}

interface GovernedBinding { verb: string; via: 'noun' | 'clause' | 'borrow' | 'passive' }

/**
 * (ticket f05b38c1) The (verb, id) BINDING — which mapped verb of the citing
 * sentence governs the cited id as the note's own act, and at what grade.
 * Precedence, tightest scope first:
 *   1. NOUN — the citation is tool-noun shaped; the noun names the act.
 *   2. CLAUSE — an own-act ACTIVE verb earlier in the id's clause with no
 *      clause separator and no unclosed paren between (the id is its object:
 *      "re-armed the read-back … as sched 0059e4e4").
 *   3. BORROW — the id's clause head is a bare pointer (an id enumeration or
 *      a receipt/entity pointer): the nearest preceding own-act ACTIVE verb
 *      of the sentence governs. At depth 0 the pointer may be bare ("—
 *      9c307167 and 93292353 are now resolved" — the ad60c49d enumeration;
 *      "— receipt ticket 9c307167" — the receipt credential); INSIDE a paren
 *      aside the head must NAME THE RECEIPT ("(receipt 05126597)") — an
 *      entity aside ("todos (38b83fa7, 80150024)") reports other objects and
 *      never borrows.
 *   4. PASSIVE — a copular bridge + mapped verb after the id in the same
 *      clause ("(93292353, 9c307167) are pinned at priority 0").
 * No binding ⇒ the id is NOT this note's own claim (a report, an entity
 * citation, an annotation) — grade 'report', observe-only forever.
 */
function governCandidate(sentence: string, idAt: number, id: string, noun: string | undefined): GovernedBinding | undefined {
  if (noun) return { verb: noun, via: 'noun' };
  const depth = parenDepthAt(sentence, idAt);
  // (2) same-clause backward: stop at the aside's '(' when inside one.
  const backStop = depth > 0 ? asideOpenAt(sentence, idAt) : clauseStartBeforeLocal(sentence, idAt);
  const clauseBefore = sentence.slice(backStop < 0 ? 0 : backStop, idAt);
  const verbRe = new RegExp(CLAIM_VERB_OR_NOUN_SRC, 'gi');
  let active: { verb: string; at: number } | undefined;
  for (const vm of clauseBefore.matchAll(verbRe)) {
    const vi = vm.index ?? 0;
    if (isParticipleAt(clauseBefore, vi)) continue;
    // paren containment INSIDE the head region (a nested "(both resolved)" aside) — skip
    const headDepth = parenDepthAt(clauseBefore, vi);
    if (headDepth > 0) continue;
    if (isOwnActActiveAt(clauseBefore, vi)) active = { verb: vm[1], at: vi };
  }
  if (active && !clauseSeparatorBetween(clauseBefore, active.at + String(active.verb).length, clauseBefore.length)) {
    return { verb: active.verb, via: 'clause' };
  }
  // (3) borrow: bare pointer head. Depth 0 — credential-free (an id enumeration
  // "— 9c307167 and 93292353 …" or a receipt pointer "— receipt X"). Depth 1
  // (inside an aside) — the aside head must NAME THE RECEIPT for the BACKWARD
  // borrow, or an entity aside ("todos (a, b)") would borrow a sibling act's
  // verb. The FORWARD passive is exempt from the credential: its subject IS
  // the enumeration the aside carries ("(93292353, 9c307167) are pinned").
  const clauseStart = clauseStartBeforeLocal(sentence, idAt);
  const asideOpen = depth > 0 ? asideOpenAt(sentence, idAt) : -1;
  const headForPointer = depth > 0 ? sentence.slice(asideOpen, idAt) : sentence.slice(clauseStart, idAt);
  if (barePointerHead(headForPointer)) {
    if (depth === 0 || namesReceipt(headForPointer)) {
      const borrowFrom = depth > 0 ? asideOpen : clauseStart;
      // nearest preceding own-act ACTIVE verb of the sentence (right-to-left)
      const head = sentence.slice(0, borrowFrom);
      const re2 = new RegExp(CLAIM_VERB_OR_NOUN_SRC, 'gi');
      const hits: Array<{ verb: string; at: number }> = [];
      for (const vm of head.matchAll(re2)) {
        const vi = vm.index ?? 0;
        if (isParticipleAt(head, vi)) continue;
        if (isOwnActActiveAt(head, vi)) hits.push({ verb: vm[1], at: vi });
      }
      const last = hits[hits.length - 1];
      if (last) return { verb: last.verb, via: 'borrow' };
    }
    // forward passive — allowed to cross OUT of a bare pointer aside (the aside attaches to the passive's subject)
    const forward = passiveAfter(sentence, idAt + id.length, depth > 0 ? asideOpen : idAt);
    if (forward) return forward;
    return undefined;
  }
  // (4) forward passive at depth 0 only (an aside's id with prose after it inside the aside is an annotation)
  if (depth === 0) {
    const forward = passiveAfter(sentence, idAt + id.length, idAt);
    if (forward) return forward;
  }
  return undefined;
}

/** A be/adverb bridge + mapped own-act verb shortly after `from` in the same clause. */
function passiveAfter(sentence: string, from: number, minAt: number): GovernedBinding | undefined {
  const window = sentence.slice(from, from + 48);
  const re = new RegExp(CLAIM_VERB_OR_NOUN_SRC, 'gi');
  for (const vm of window.matchAll(re)) {
    const vi = vm.index ?? 0;
    if (isParticipleAt(window, vi)) continue;
    const at = from + vi;
    if (at < minAt) continue;
    if (clauseSeparatorBetween(sentence, from, at)) continue;
    if (isOwnActPassiveAt(sentence, at)) return { verb: vm[1], via: 'passive' };
    return undefined; // a mapped verb that is NOT passive-bridged ends the scan (it belongs to another subject)
  }
  return undefined;
}

/** Clause start (offset-local twin of the shared helper in claim-verb-classes). */
function clauseStartBeforeLocal(s: string, at: number): number {
  let start = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = s[i];
    if (c === '\n') { start = i + 1; break; }
    if (c === ')' || c === '”' || c === '’' || c === '"' || c === ']' || c === '*' || c === '_') continue;
    const two = s.slice(i, i + 2);
    if (c === '.' || c === '!' || c === '?' || c === ';' || c === '—' || c === '–'
      || (c === ':' && !/\d/.test(s[i + 1] ?? '')) || two === ' - ') { start = i + 1; break; }
  }
  return start;
}

/**
 * Pure: the (verb, tool, id) triple candidates a note offers — every id a
 * CLAIM sentence cites, with the verb that GOVERNS it (ticket f05b38c1:
 * act-grade binding via clause/borrow/passive, report-grade otherwise) and
 * the tool noun when the citation is tool-noun shaped. The mapped verb IS
 * the claim gate (a sentence with no mapped verb fails OPEN). Skips quoted /
 * relayed / disclaimed / "no such id" sentences (the existing citation
 * guards). One candidate per id per citing sentence. Null when none. Capped
 * at 6.
 */
export function receiptTripleCandidates(text: string): ReceiptTripleCandidate[] | null {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  const out: ReceiptTripleCandidate[] = [];
  // (ticket f05b38c1) one candidate PER ID, act-grade winning: an id cited
  // first in a report sentence and again in an ACTIONS-TAKEN claim (the
  // ad60c49d note: the "Receipts:" line vs the claim bullet) must grade by
  // its CLAIM sentence — the enforcement lane rewrites the claim, not the
  // report. First-citing-sentence order is kept for the phrase/verb of a
  // never-act id (the observe-only metric's shape).
  const byId = new Map<string, ReceiptTripleCandidate>();
  for (const m of t.matchAll(TRIPLE_ID_RE)) {
    const at = m.index ?? 0;
    const id = m[1].toLowerCase();
    const [s0, se] = sentenceBounds(t, at);
    const sentence = t.slice(s0, se);
    if (!TRIPLE_CITED_BEFORE_RE.test(t.slice(s0, at))) continue;
    if (citationIsRelayedOrDisclaimed(t, s0, at, at + m[0].length)) continue;
    // The tool noun directly before the citation separator, if any ("receipt
    // ticket 9c307167", "start_coding_session → 9e39ec5c" — noun expected).
    const before = t.slice(Math.max(s0, at - 40), at);
    const nounMatch = before.match(NOUN_BEFORE_CITATION_RE);
    // (ticket f05b38c1) the (verb, id) binding + grade.
    const bound = governCandidate(sentence, at - s0, id, nounMatch ? nounMatch[1] : undefined);
    if (!bound && !nounMatch) {
      // no noun and no mapped token anywhere — fail-open (old contract)
      const re = new RegExp(CLAIM_VERB_OR_NOUN_SRC, 'i');
      if (!re.test(sentence)) continue;
    }
    const verb = bound?.verb
      ?? (sentence.match(new RegExp(CLAIM_VERB_OR_NOUN_SRC, 'i')) ?? [])[0];
    const cand: ReceiptTripleCandidate = {
      id, verb,
      ...(nounMatch ? { noun: nounMatch[1] } : {}),
      phrase: sentence.slice(0, 120),
      grade: bound ? 'act' : 'report',
      sentAt: s0,
      idAt: at,
      ...(bound ? { via: bound.via } : {}),
    };
    const prior = byId.get(id);
    if (!prior || (prior.grade !== 'act' && cand.grade === 'act')) byId.set(id, cand);
  }
  out.push(...byId.values());
  return out.length ? out.slice(0, 6) : null;
}

/** One triple mismatch: the id, the expected tool class, the actual receipt's tool, and the citing phrase. */
export interface ReceiptToolMismatch {
  receiptId: string;
  verb: string | undefined;
  noun?: string;
  expectedTools: readonly string[];
  actualTool: string;
  phrase: string;
  /** (f05b38c1) 'act' — the note's own claim (enforced pre-delivery); 'report' — a report/entity citation (observe-only). */
  grade: ReceiptTripleGrade;
  /** The sentence span in the TEXT (for the pre-delivery rewrite) — set when grade is 'act'. */
  span?: [number, number];
  /** The honest-line class of the claim verb (send / change). */
  claimClass?: 'send' | 'change' | 'read';
}

/**
 * (ticket c7b408ef) SIBLING-ACT HONEST ATTRIBUTION — does any VERB token of
 * the citing sentence map to a class CONTAINING `tool`, as THIS note's own
 * act (or a bare coordination position — see below)?
 *
 * The defect this closes: the BORROW binding (governCandidate) takes the
 * nearest preceding own-act ACTIVE verb, but a verb behind a COORDINATION
 * ("Closed the stale schedule and sent the owner the summary — receipt
 * 250ec3f7") is never an own-act clause head (the 5ad80b27 mercy — that is
 * the verifier's doctrine too), so the backward borrow binds the citation to
 * the SIBLING clause's verb (Closed / armed) and an honest send receipt
 * false-strikes ACT-GRADE — the enforcement lane then rewrites the whole
 * sentence, deleting the truthful send. The citation is honestly attributed
 * to that sibling act instead: skip the mismatch, fail toward miss
 * (587e9d64 — a false strike replaces an honest note; the skipped fabrication
 * still has the invented-id lane (efb2960d) and the verifier tiers behind it).
 *
 * ADMISSION RULES for a sibling token (adversarial review F1/F2):
 *   • VERB KEYS ONLY — the map's tool-NOUN keys (send_chat_message,
 *     file_feedback, …) are annotation vocabulary, not acts: "— receipt X
 *     (send_chat_message)" is a note TELLING us the receipt is a send while
 *     the verb claims a close — the strongest wrong-tool shape, never an
 *     acquittal.
 *   • OWN-ACT, or bare COORDINATION position — the grammar alone cannot see
 *     a coordination sibling (that is the defect), so a token immediately
 *     after a coordination conjunction (and/or/then/plus) or a comma/
 *     semicolon series is admitted without demanding clause-initiality.
 *     A THIRD-PARTY agentive token ("closed by lane cb941a0a") or a copular
 *     STATE report ("are pinned at 0") names another actor's act and never
 *     acquits: the agentive-by and copular-bridge guards apply. Quoted
 *     tokens are NOT excluded on purpose (c7b408ef review finding A): a
 *     quoted sibling whose resolved receipt is REAL and ok still backs the
 *     citation — striking it would delete a truthful send (fail toward
 *     miss, 587e9d64). The "the lane said \"sent …\"" RELAY phrasing is
 *     stopped EARLIER, at collection: that phrasing never yields an
 *     act-grade candidate at all (pinned in the c7b408ef suite).
 * SENTENCE-scoped on purpose: the ad60c49d specimen's note carries "filed"
 * tokens in other lines whose class contains file_feedback — a note-wide
 * scan would acquit the close-verb bullets; the citing-sentence scope keeps
 * both TP specimens firing.
 */
function sentenceNamesSiblingActFor(sentence: string, tool: string): boolean {
  const re = new RegExp(CLAIM_VERB_OR_NOUN_SRC, 'gi');
  for (const m of sentence.matchAll(re)) {
    const tok = m[1];
    if (tok.includes('_')) continue; // (F1) a tool-NOUN key is annotation vocabulary, never an act
    const at = m.index ?? 0;
    if (isParticipleAt(sentence, at)) continue; // "the sent summary" — a noun phrase, not an act
    if (agentiveByAfterToken(sentence, at)) continue; // (F2) "closed by lane cb941a0a" — another actor's act
    const cls = CLAIM_VERB_TOOL_CLASSES[tok.toLowerCase()];
    if (!cls || !cls.includes(tool)) continue;
    if (isOwnActActiveAt(sentence, at) || isOwnActPassiveAt(sentence, at)) return true;
    // (F2) a copular-bridged token that is NOT own-act ("are pinned at 0") is
    // a STATE report of another actor — but the own-act passive case is
    // already covered above, so only a bare state report reaches here.
    if (PASSIVE_BRIDGE_BEFORE_RE.test(sentence.slice(Math.max(0, at - 24), at))) continue;
    // The COORDINATION position — the defect's own shape: a verb directly
    // after a coordination conjunction is the sibling act the citation was
    // borrowed FROM, and it cannot be clause-initial by construction.
    const before = sentence.slice(Math.max(0, at - 16), at);
    if (COORDINATION_BEFORE_RE.test(before)) return true;
  }
  return false;
}

/** A coordination position directly before a token — the sibling-clause position ("… and sent the report", "… schedule, sent the summary, receipt X"). A bare comma/semicolon series counts: commas are not clause separators, so a series verb is never clause-initial either (same defect class); the participle / agentive-by / copular guards above still block third-party tokens. Quote marks between the conjunction and the verb ("… and \"sent the report\" …") do NOT break the position (c7b408ef review finding A): a quoted sibling whose resolved receipt is REAL and ok still backs the citation, and striking it would delete a truthful send — the "the lane said X" third-party RELAY phrasing is stopped earlier, at collection. */
const COORDINATION_BEFORE_RE = /(?:\b(?:and|or|then|plus|while|also)\s*[,;]?|[,;])\s*["'"“”‘’]*\s*$/i;
/** A copular bridge before a token ("are pinned", "is resolved") — a third-party state report, never this note's act. */
const PASSIVE_BRIDGE_BEFORE_RE = /\b(?:are|is|was|were|be|been|being)\s+(?:(?:now|already|formally|newly)\s+)?$/i;

/**
 * The triple candidates whose cited id resolves to a receipt whose tool is NOT in the expected class.
 * (ticket f05b38c1) Resolution prefers ANY in-class receipt: an id that anchors to BOTH a send and a
 * goal_update receipt is honestly vouched when ANY ok receipt matches the verb's class (the old
 * first-match shadowing mis-ruled honest rows). Grade + span ride every row so the enforcement lane
 * can rewrite act-grade citations without re-parsing.
 * (ticket c7b408ef) ACT-GRADE ONLY: a BORROWED or CLAUSE-bound citation whose
 * citing sentence also names a sibling act whose class contains the resolved
 * receipt's tool is honestly attributed to that sibling act — the mismatch is
 * skipped (fail toward miss). NOUN- and PASSIVE-bound citations are precise
 * bindings and are never rescued; REPORT-grade rows are untouched (the
 * observe-only metric baseline keeps its series).
 */
export async function receiptToolMismatches(chatId: string, text: string): Promise<ReceiptToolMismatch[]> {
  if (receiptTripleGroundingDisabled()) return [];
  const candidates = receiptTripleCandidates(text);
  if (!candidates?.length) return [];
  const out: ReceiptToolMismatch[] = [];
  // One shared pull of the chat's receipts (the same window inventedToolNounIds uses).
  let rows: any[] = [];
  try {
    rows = await (prisma as any).runToolReceipt.findMany({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { id: true, tool: true, ids: true, ok: true },
    });
  } catch {
    return []; // fail-closed: a read error strikes nothing
  }
  for (const c of candidates) {
    const expected = expectedToolsForCitation(c.verb, c.noun);
    if (!expected) continue; // unmapped verb — fail-open
    // Resolve the id against receipt ids AND envelope values (an honest report
    // cites the ticket id / schedule id / lane id, not the receipt id). ALL
    // matching rows count (f05b38c1): any ok receipt of the expected class
    // vouches the id.
    const resolved = receiptRowsForCitedId(rows, c.id);
    if (!resolved.length) continue; // invented ids are the efb2960d lane's business, not this one
    const okRows = resolved.filter((r) => r.ok);
    if (!okRows.length) continue; // a FAILED call backs nothing — but the "invented" class owns it, not the triple
    if (okRows.some((r) => expected.includes(String(r.tool)))) continue; // SOME ok receipt of the expected class backs it — honest triple
    // (ticket c7b408ef) SIBLING-ACT honest attribution — ACT-GRADE, CLAUSE- or
    // BORROW-bound citations only: a citation whose citing sentence ALSO names
    // a sibling act whose class contains the resolved receipt's tool (the
    // "… and sent the owner the summary — receipt X" coordination shape)
    // belongs to that sibling act — not a mismatch. NOUN/PASSIVE bindings name
    // their act precisely and are never rescued; REPORT-grade rows are
    // untouched (the observe-only metric keeps its baseline series). EXACT
    // sentence bounds, never a fixed window: a window would bleed into the
    // NEXT line (the ad60c49d "Retired …" bullet sits <200 chars from the
    // sibling bullet's "re-filed", whose `filed` class contains
    // file_feedback) and wrongly acquit the close-verb bullet.
    if (c.grade === 'act' && (c.via === 'clause' || c.via === 'borrow')) {
      const [sb0, sb1] = sentenceBounds(text, c.idAt);
      if (okRows.some((r) => sentenceNamesSiblingActFor(text.slice(sb0, sb1), String(r.tool)))) continue;
    }
    // (ticket 62718124) SENTENCE-LEVEL ANY-IN-CLASS VOUCH — act-grade,
    // CLAUSE- or BORROW-bound only (the c7b408ef rescue's discipline: NOUN and
    // PASSIVE bindings name their act precisely and are never rescued):
    // an honest ACTIONS-TAKEN sentence names the act's OTHER artifacts (the
    // goal it moved, the chat it messaged) next to the act's OWN receipt
    // citation. The per-id vouch above already cleared the honest citation
    // itself; an ENTITY id in the SAME sentence must not strike the sentence
    // when any sibling id cited in it resolves to an ok receipt of THIS
    // claim's expected class. The 2026-10-18 5c48f492 specimen (receipts
    // held):
    //   "send_chat_message → Fleet Supervisor (chat c0e22e36), receipt
    //    5ef5b9e3: goal d1a991a1 DONE state change + dispatch-help"
    // — receipt 5ef5b9e3 IS that run's ok send_chat_message receipt, yet the
    // goal id (resolving to goal_update) struck act-grade and the truthful
    // sentence was rewritten into a false denial that contradicted its own
    // ACTIONS TAKEN block. REPORT-grade rows are untouched (the observe-only
    // series keeps its baseline).
    // KNOWN TRADE (adversarial review, accepted under 587e9d64 — a false
    // strike on an honest note is strictly worse than a miss): the vouch is
    // CLASS-scoped, not act-scoped — a sentence that honestly cites one
    // in-class receipt ALSO acquits a sibling wrong-tool claim of the same
    // class in that sentence ("Closed todo X (receipt T) and closed goal G"
    // with G's receipt a send). The enforcement lane keeps its teeth for the
    // ad60c49d shape — a wrong-tool claim with NO in-class sibling beside it.
    if (c.grade === 'act' && (c.via === 'clause' || c.via === 'borrow')) {
      const [vsb0, vsb1] = sentenceBounds(text, c.idAt);
      const sentenceText = text.slice(vsb0, vsb1);
      let siblingVouched = false;
      for (const m of sentenceText.matchAll(TRIPLE_ID_RE)) {
        const sid = (m[1] || '').toLowerCase();
        if (!sid || sid === c.id) continue;
        if (receiptRowsForCitedId(rows, sid).some((r) => r.ok && expected.includes(String(r.tool)))) {
          siblingVouched = true;
          break;
        }
      }
      if (siblingVouched) continue;
    }
    const row = okRows[0];
    out.push({
      receiptId: c.id, verb: c.verb, ...(c.noun ? { noun: c.noun } : {}),
      expectedTools: expected, actualTool: String(row.tool), phrase: c.phrase, grade: c.grade,
      ...(c.grade === 'act' ? { span: cSpan(text, c), claimClass: claimVerbActClass(c.verb ?? c.noun) } : {}),
    });
  }
  return out;
}

/** (62718124) Every receipt row an 8-hex id resolves to — receipt-id prefix OR
 *  any envelope value prefix (an honest report cites the ticket/goal/chat id,
 *  not the receipt id). The single resolution both vouch lanes share. */
function receiptRowsForCitedId(rows: any[], id: string): any[] {
  const want = id.toLowerCase();
  return rows.filter((r) => String(r.id).slice(0, 8).toLowerCase() === want
    || (() => {
      const env = (r.ids ?? {}) as Record<string, unknown>;
      return Object.values(env).some((v) => typeof v === 'string' && v.slice(0, 8).toLowerCase() === want);
    })());
}

/**
 * (ticket 62718124) The log level of the AGGREGATE triple warn. An act-grade
 * mismatch — a wrong-tool CLAIM, enforced or enforceable — stays WARN: that is
 * the real wrong-tool-claim signal the warn exists for. A REPORT-only wake is
 * the f05b38c1-adjudicated BENIGN class (honest status reports whose mapped
 * verb belongs to another actor or clause) — INFO keeps it out of the
 * log-signal sweep's hourly series (the sweep reads warn+error only) while the
 * per-row receipt_tool_mismatch metric rows keep the full observe-only
 * baseline. The message text is unchanged in both cases.
 */
export function tripleAggregateLogLevel(actGradeCount: number): 'warn' | 'info' {
  return actGradeCount > 0 ? 'warn' : 'info';
}

/** The sentence span of a candidate's citing sentence (text offsets), anchored on the collected id occurrence. */
function cSpan(text: string, c: ReceiptTripleCandidate): [number, number] | undefined {
  if (c.idAt < 0 || c.idAt > text.length) return undefined;
  const [s, e] = claimSpan(text, c.idAt, false); // whole sentence, bold-balanced
  return [s, e];
}

/* ── Artifact-attribution cross-check (todo 13dfa16d, monitor lesson 7) ──────
 *
 * The deterministic cross-check the audit spec names: a supervisor sentence
 * '<todo> merged/landed/shipped' must agree with that todo's row (status +
 * evidence naming the PR) AND with the event-time stamp on the artifact
 * receipt for the same sentence. The #1590 specimen: the Fleet digest said
 * 'Lesson-5 contract merged (PR #1590)' while PR #1590's branch was
 * block-escalation-27c215d6 — the sentence implied the LANE-TITLE todo, the
 * artifact served 27c215d6. OBSERVE-ONLY (the 6f8b52b7 / PR #1548 ladder):
 * one metric row per mismatch, never a rewrite, never a retry; the 7-day
 * baseline gates any future enforcement. Kill switch
 * ARTIFACT_ATTRIBUTION_DISABLED=1 (shared with the stamping seam).
 */

/** The '<todo> merged' mismatches in a supervisor note — observe-only input. */
export async function artifactAttributionMismatches(chatId: string, text: string): Promise<AttributionMismatch[]> {
  if (artifactAttributionDisabled()) return [];
  const claims = attributionClaimSentences(text);
  if (!claims.length) return [];
  // The todo rows the claims name — by 8-hex PREFIX (the supervisor renders
  // prefixes, not full ids). A supervisor sentence describes ANY lane's todo,
  // so the read is prefix-keyed across the whole table, never
  // assignee-scoped. Fail-closed: a read error checks nothing.
  const todoRows: TodoRowForCheck[] = [];
  try {
    const rows = await (prisma as any).projectTodo.findMany({
      where: { OR: claims.map((c) => ({ id: { startsWith: c.prefix } })) },
      take: 60,
      select: { id: true, status: true, evidence: true },
    }).catch(() => []);
    for (const r of rows as Array<{ id: string; status: string; evidence: string | null }>) {
      todoRows.push({ id: String(r.id), status: String(r.status ?? ''), evidence: r.evidence == null ? null : String(r.evidence) });
    }
  } catch { /* fail-closed */ }
  if (!todoRows.length) return [];
  // The stamped artifact receipts of THIS chat (the supervisor's own view of
  // the PRs it narrates — its receipts hold the board it read; a supervisor
  // quoting a lane's PR cites the PR number, matched by prefix in the pure
  // checker). Read fails ⇒ no stamps ⇒ only the row-vs-sentence legs check.
  let stamped: Array<{ prNumber?: number | null; workItem: string }> = [];
  try {
    const receipts = await (prisma as any).runToolReceipt.findMany({
      where: { chatId, tool: { in: ['open_pull_request', 'merge_pull_request', 'git_push'] }, ok: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { tool: true, ids: true },
    }).catch(() => []);
    stamped = (receipts as Array<{ tool: string; ids: unknown }>)
      .map((r): { prNumber?: number | null; workItem: string } | null => {
        const a = attributionOfReceiptIds(r.ids);
        const x = (r.ids && typeof r.ids === 'object' ? r.ids : {}) as Record<string, unknown>;
        return a ? { prNumber: Number.isFinite(Number(x.prNumber)) ? Number(x.prNumber) : null, workItem: a.workItem } : null;
      })
      .filter((v): v is { prNumber?: number | null; workItem: string } => v != null);
  } catch { stamped = []; }
  return attributionMismatches(claims, todoRows, stamped);
}
// Three gaps the 10-08 guard left, each with a real specimen from the Fleet
// Supervisor chat (c0e22e36) the night of 10-15/16:
//  (i)  MACHINE wakes were unchecked (`!runIsMachineTriggered`): msg af8ed7b6
//       (02:29Z, machine wake) cited "receipt-gap todo 14013c16" — no such
//       todo anywhere; sailed out untouched.
//  (ii) Subject-less past-tense bullets match nothing: msg 0a30db95 (01:59:55Z)
//       "ACTIONS TAKEN — Routed 5 fleet items… / Filed one owner question… /
//       Armed the daily digest…" with 11 invented ids from a ZERO-tool turn.
//  (iii) Only the matched sentence was replaced: msg 65a92992 (02:18:53Z) kept
//        its headline ("homework complete … both gaps filed") next to THREE
//        copies of the honest line — a self-contradicting deliverable.
// New pieces (below): ACTIONS_TAKEN_RE + actionsTakenClaims() for (ii);
// rewriteUnbackedClaims whole-block extension for (iii); the machine-wake
// coverage for (i) lives in chat-agent.service.ts (flag-first: a
// supervisor_unbacked_claim_machine metric, no rewrite, per the observe-only
// doctrine — the retry/rewrite stays owner-turn-only until the FP rate is
// measured). Kill switch SUPERVISOR_UNBACKED_MACHINE_WAKE_DISABLED=1 (metric only).

/** True when the machine-wake leg of the guard is switched off. */
export function unbackedMachineWakeDisabled(): boolean {
  return process.env.SUPERVISOR_UNBACKED_MACHINE_WAKE_DISABLED === '1';
}

// ── CREDENTIAL NARRATION (todo 77c88942 item 3, 2026-10-16 — LiteLLM specimen
// 8fae35a4, "Seven keys banked … store_secret ×7") ───────────────────────────
// "Seven keys banked" is subject-less PROSE (no ACTIONS TAKEN header, no
// first person) claiming a credential STORE — the highest-stakes change claim
// there is (item 1 made store_secret mint receipts precisely so this class is
// verifiable). The bullet vocabulary already carries 'banked', but only
// INSIDE an ACTIONS TAKEN block; in prose the claim rode 'stored/saved' being
// absent and no subject being present. A credential-claim sentence that no
// store_secret tool call of the run backs is an unbacked CHANGE claim — zero-
// tool runs by construction (the guard only runs then), and the rewrite
// replaces the sentence with the honest line.
// Subject-less credential-store narrations, BOTH word orders — the specimen
// is "Seven keys banked" (noun BEFORE the participle), not "banked seven keys".
const CREDENTIAL_NARRATION_RE = /\b(?:(?:banked|stored|saved)\s+(?:(?:all\s+|the\s+|both\s+|\d+\s+|\w+\s+)?(?:keys?|credentials?|secrets?|api[ _-]?keys?|tokens?)\b)|(?:keys?|credentials?|secrets?|api[ _-]?keys?|tokens?)\s+(?:are\s+|is\s+|were\s+|was\s+|been\s+)?(?:banked|stored|saved)\b)/gi;
/** A store_secret tool call part backs the narration (any result — the guard's zero-tool precondition makes this rare; a run WITH the call skips the lane). */
const STORE_SECRET_TOOL_RE = /\bstore_secret\b/i;

/**
 * Pure: credential-store narrations ("Seven keys banked", "2 keys stored",
 * "the API keys are saved") on a run that made NO store_secret tool call.
 * Subject-less prose included — a credential claim is too consequential for
 * the first-person-only rule. Exported for tests.
 */
export function unbackedCredentialClaims(text: string, parts: Array<{ type?: string; name?: string }> | undefined): UnbackedActionClaim[] {
  const t = String(text ?? '');
  if (!t.trim()) return [];
  if ((parts ?? []).some((p) => p?.type === 'tool_call' && (p.name ? STORE_SECRET_TOOL_RE.test(p.name) : false))) return [];
  const out: UnbackedActionClaim[] = [];
  CREDENTIAL_NARRATION_RE.lastIndex = 0;
  for (const m of t.matchAll(CREDENTIAL_NARRATION_RE)) {
    const at = m.index ?? 0;
    const [s0] = sentenceBounds(t, at);
    const before = t.slice(Math.max(s0, at - DISCLAIMER_WINDOW), at);
    if (disclaimedBefore(before) || inQuoteOrCode(t, s0, at)) continue;
    // The historical window is the WHOLE SENTENCE — "Seven keys were banked
    // earlier by the onboarding run" has the tense marker AFTER the match.
    const [, se] = sentenceBounds(t, at);
    if (historicalExemptLegacy(t.slice(s0, Math.max(se, at + m[0].length)))) continue;
    const [s, e] = claimSpan(t, at, true);
    out.push({ cls: 'change', phrase: m[0].replace(/\s+/g, ' ').slice(0, 120), start: s, end: e, source: 'credential' });
  }
  return out;
}

/** The "ACTIONS TAKEN" / "ACTIONS TAKEN (N)" header that opens a supervisor claim block. */
export const ACTIONS_TAKEN_RE = /^[ \t]*(?:\*\*|__)?[ \t]*ACTIONS[ \t]+TAKEN(?:[ \t]*\(\d+\))?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*$/im;

/** Subject-less past-tense act verbs (the 0a30db95 bullet shapes) — "Routed 5 fleet items", "Filed one owner question". Built lazily: the verb vocabularies (SEND_PAST/CHANGE_PAST/READ_PAST) are declared lower in this file. */
let _bulletActRe: RegExp | null = null;
function bulletActRe(): RegExp {
  if (!_bulletActRe) {
    _bulletActRe = new RegExp(
      `\\b(${SEND_PAST}|${CHANGE_PAST}|${READ_PAST}|routed|dropped|dismissed|answered|banked)\\b`,
      'i',
    );
  }
  return _bulletActRe;
}

/** A bullet line under an ACTIONS TAKEN header: "- Routed 5 fleet items …", "2. Filed one owner question …". */
function bulletLines(t: string, headerEnd: number): Array<{ start: number; end: number; line: string }> {
  const out: Array<{ start: number; end: number; line: string }> = [];
  let i = headerEnd;
  const end = t.length;
  while (i < end) {
    const nl = t.indexOf('\n', i);
    const lineEnd = nl === -1 ? end : nl;
    const line = t.slice(i, lineEnd);
    if (line.trim() && !/^[ \t]*(?:[-*•]|\d+[.)])[ \t]/.test(line)) break; // block ends at first non-bullet
    if (line.trim()) out.push({ start: i, end: lineEnd, line });
    i = lineEnd + 1;
  }
  return out;
}

/** Classify a bullet's act verb: send if it names a send act, read for read acts, else change. */
function bulletClass(verb: string): UnbackedClaimClass {
  if (new RegExp(`^(?:${SEND_PAST}|routed)$`, 'i').test(verb)) return 'send';
  if (new RegExp(`^(?:${READ_PAST})$`, 'i').test(verb)) return 'read';
  return 'change';
}

/**
 * Pure: the unbacked SUBJECT-LESS bullet claims in an "ACTIONS TAKEN" block —
 * a bullet whose act verb is past tense with no subject (the elided "I"), when
 * the run's tool calls do not back its class. Also matches a bare one-line
 * "ACTIONS TAKEN — Routed 5 fleet items …" (header and first bullet on one
 * line). Empty when no ACTIONS TAKEN block, or every bullet is backed /
 * disclaimed. Exported for tests.
 */
export function actionsTakenClaims(text: string, parts: Array<{ type?: string; name?: string }> | undefined): UnbackedActionClaim[] {
  const t = String(text ?? '');
  if (!t.trim()) return [];
  if ((parts ?? []).some((p) => p?.type === 'tool_call')) {
    // A run with ANY tool call can honestly cite its own ids; the bullets'
    // backing is judged class-wise below, but the zero-tool case is the
    // fabrication class — keep it even when tools ran only when a bullet's
    // class is unbacked (handled by the per-bullet check).
  }
  const backed = backedClaimClasses(parts);
  const out: UnbackedActionClaim[] = [];
  const header = ACTIONS_TAKEN_RE.exec(t);
  if (header) {
    const headerEnd = (header.index ?? 0) + header[0].length;
    // Case A: bullets on following lines.
    for (const b of bulletLines(t, headerEnd)) {
      const stripped = b.line.replace(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]+/, '');
      const m = bulletActRe().exec(stripped);
      if (!m) continue;
      const cls = bulletClass(m[1]);
      if (cls === 'send' ? backed.send : cls === 'change' ? backed.change : backed.any) continue;
      if (disclaimedBefore(stripped.slice(0, m.index))) continue;
      if (/^\s*(?:nothing|no one|none|no message|not\b)/i.test(stripped.slice(m.index + m[0].length, m.index + m[0].length + 24))) continue;
      out.push({
        cls, phrase: stripped.slice(0, 110).replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120),
        start: b.start, end: b.end, source: 'action',
      });
    }
    // Case B: "ACTIONS TAKEN — Routed 5 fleet items" on the header's own line.
    const nlIdx = t.indexOf('\n', headerEnd);
    const sameLine = t.slice(headerEnd, nlIdx === -1 ? t.length : nlIdx);
    if (sameLine.trim()) {
      const stripped = sameLine.replace(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]+/, '').replace(/^[ \t]*(?:[—–-]|:)[ \t]*/, '');
      const m = bulletActRe().exec(stripped);
      if (m) {
        const cls = bulletClass(m[1]);
        if (!(cls === 'send' ? backed.send : cls === 'change' ? backed.change : backed.any)) {
          out.push({ cls, phrase: stripped.slice(0, 120).replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120), start: header.index ?? 0, end: headerEnd + sameLine.length, source: 'action' });
        }
      }
    }
  }
  return out;
}

/** True when a rewritten claim block must take its whole BLOCK (header + bullets), not just the matched sentence. */
export const CLAIM_BLOCK_WHOLE_REWRITE = true;

/**
 * Pure helper for gap (iii): the span of the ENTIRE claim block around a claim
 * — the ACTIONS TAKEN header (if the claim sits in its bullet list) plus every
 * bullet line of that block, up to the end of the LAST claim-carrying bullet.
 * Returns null when the claim is not part of a bullet block (ordinary sentence
 * rewrite, pre-existing behaviour).
 */
export function wholeClaimBlockSpan(t: string, claims: UnbackedActionClaim[]): [number, number] | null {
  if (!claims.length) return null;
  const header = ACTIONS_TAKEN_RE.exec(t);
  if (!header) return null;
  const headerStart = header.index ?? 0;
  const headerEnd = headerStart + header[0].length;
  const inBlock = claims.filter((c) => c.start >= headerStart);
  if (!inBlock.length) return null;
  // Extend to the whole bullet block: every bullet line from the header down.
  const bullets = bulletLines(t, headerEnd);
  const blockEnd = bullets.length ? bullets[bullets.length - 1].end : headerEnd;
  // Also swallow the trailing blank line separators after the last bullet so the
  // honest line does not strand a dangling "ACTIONS TAKEN" clone above.
  let e = blockEnd;
  while (e < t.length && /[\s]/.test(t[e])) {
    const rest = t.slice(e);
    const nextLine = rest.split('\n', 1)[0] ?? '';
    if (nextLine.trim() && !/^[ \t]*(?:[-*•]|\d+[.)])[ \t]/.test(nextLine)) break;
    e += (rest.indexOf('\n') === -1 ? rest.length : rest.indexOf('\n') + 1);
  }
  return [headerStart, e];
}

/** The harness note the re-run carries (rides the final user turn). */
export function unbackedClaimNotice(invented: string[]): string {
  return `[HARNESS CHECK — NO TOOL CALL: your previous answer says a message was dispatched and cites receipt ${invented.join(', ')}, `
    + 'but you made NO tool call in that answer, so nothing was sent and no such receipt exists. '
    + 'If the request asks you to send or dispatch a message, call the tool NOW (send_chat_message with the requested chatId and content) and quote the receipt id from its tool RESULT. '
    + 'If a send really happened in an EARLIER turn, do not send again — say so and cite that turn. If you decide not to send, say plainly that nothing was sent.]';
}

// ── UNBACKED FRESHNESS CLAIM (audit 2026-10-06 T6-3 — others.md F2, fleet.md F4) ──
// Owner turns on supervisor chats answered "FULL STATE CHECK — fresh reads at
// 06:55Z", "verified against the live ledger just now", "Everything below is
// verified fresh this run", "Fresh probe across the repo and S3 … exact
// recount just now" with `leadToolCalls: 0` — nothing was read. The
// production-state lane runs on machine wakes only and the dispatch check above
// only matches dispatch verbs + receipt ids. A turn with NO tool call has no
// side effect, so the same ONE re-run is safe: the note asks the model to make
// the reads now or say plainly the figures come from earlier context.
// Kill switch SUPERVISOR_UNBACKED_FRESHNESS_RETRY_DISABLED=1.

/** Verbs that claim a check was performed (past tense / participle). */
const VERIFY_VERB = '(?:verified|re-?verified|checked|re-?checked|confirmed|re-?confirmed|re-?read|re-?counted|recounted|re-?queried|queried|re-?probed|probed|re-?pulled|pulled|counted|measured|re-?measured|inspected|scanned)';
/** Freshness / verification claim shapes (each matched within one sentence). */
const FRESHNESS_CLAIM_RES: RegExp[] = [
  // "fresh reads at 06:55Z", "Fresh probe across the repo", "freshly pulled numbers"
  /\bfresh(?:ly)?[ -]+(?:reads?|probes?|pulls?|recounts?|re-?reads?|checks?|quer(?:y|ies)|scans?|looks?|snapshots?|pulled|read|probed|checked|queried|counted|verified)\b/gi,
  // "verified against the live ledger just now", "exact recount just now"
  new RegExp(`\\b(?:${VERIFY_VERB}|recount|re-?read)\\b[^.!?\\n]{0,80}?\\bjust now\\b`, 'gi'),
  // "verified fresh this run", "checked this wake"
  new RegExp(`\\b${VERIFY_VERB}\\b[^.!?\\n]{0,40}?\\bthis (?:run|turn|wake)\\b`, 'gi'),
  // "verified fresh", "confirmed live", "checked live", "live probe"
  /\b(?:verified|confirmed|checked)\s+(?:fresh|live)\b/gi,
  /\blive[ -](?:reads?|checks?|probes?|quer(?:y|ies)|recounts?)\b/gi,
  // first-person re-verbs: "I re-read the ledger", "I've recounted", "we just re-checked"
  /\b(?:i|i've|i have|we|we've|we have)\s+(?:just\s+)?(?:re-?read|re-?counted|recounted|re-?checked|re-?verified|re-?queried|re-?probed|re-?pulled)\b/gi,
];
/** A negation or a future / conditional cue shortly BEFORE the match (same sentence) makes it an honest disclaimer or a plan, never a claim. */
const DISCLAIMER_BEFORE_RE = /\b(?:no|not|never|without|nothing|none|haven't|hasn't|didn't|did not|have not|has not|cannot|can't|couldn't|could not|unable|won't|will|i'll|we'll|let me|going to|next|plan|planned|would|should|can|could|to|before|unless|if|once)\b[^.!?\n]*$/i;
const DISCLAIMER_WINDOW = 40;

// ── Narrowed disclaimer (audit 2026-10-08 W1-2 — supervisors F1 / chats F1) ──
// The 40-char window above counted a bare "to" / "can" / "could" / "next"
// ANYWHERE before the claim, so "You're right **to** flag that — I just re-read
// the capture log" (Schooltime 3edd998a, 10-08 18:12, ZERO tool calls) read as a
// plan and shipped. A cue now counts only inside the claim's OWN clause (text
// after the last "—", "–", ";", ":", "(", ", " or " - " before it), and the
// weak cues (to / can / could / next) only when they directly govern the verb
// ("to re-read", "can just re-check"). Kill switch
// SUPERVISOR_UNBACKED_DISCLAIMER_NARROW_DISABLED=1 restores the wide window.
const STRONG_DISCLAIMER_RE = /\b(?:no|not|never|without|nothing|none|haven't|hasn't|didn't|did not|have not|has not|cannot|can't|couldn't|could not|unable|won't|will|i'll|we'll|let me|going to|plan|planned|would|should|before|unless|if|once|want me|shall|about to|ready to|happy to)\b/i;
const WEAK_DISCLAIMER_TAIL_RE = /\b(?:to|can|could|next|will|may|might|must)\s+(?:just\s+|also\s+|now\s+)?$/i;
export function unbackedDisclaimerNarrowDisabled(): boolean {
  return process.env.SUPERVISOR_UNBACKED_DISCLAIMER_NARROW_DISABLED === '1';
}
/** True when the text just before a match (same sentence) disclaims it — a negation, a plan, a conditional. Pure; exported for tests. */
export function disclaimedBefore(before: string): boolean {
  if (unbackedDisclaimerNarrowDisabled()) return DISCLAIMER_BEFORE_RE.test(before);
  const clause = before.split(/[—–;:(]|,\s|\s-\s/).pop() ?? '';
  return STRONG_DISCLAIMER_RE.test(clause) || WEAK_DISCLAIMER_TAIL_RE.test(clause);
}

export function unbackedFreshnessRetryDisabled(): boolean {
  return process.env.SUPERVISOR_UNBACKED_FRESHNESS_RETRY_DISABLED === '1';
}

/**
 * Pure: the sentence fragment where a final answer CLAIMS fresh verification
 * ("fresh reads", "verified … just now", "re-read", "recount", "checked live")
 * while the run made NO tool call. Null when the run called any tool, the text
 * is empty, or every match is negated / future-tense ("no fresh reads this
 * turn", "I'll do a fresh read next wake", "(not read this wake)").
 */
export function unbackedFreshnessClaim(text: string, parts: Array<{ type?: string }> | undefined): string | null {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  if ((parts ?? []).some((p) => p?.type === 'tool_call')) return null;
  for (const re of FRESHNESS_CLAIM_RES) {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      const sentenceStart = Math.max(t.lastIndexOf('.', at - 1), t.lastIndexOf('\n', at - 1), t.lastIndexOf('!', at - 1), t.lastIndexOf('?', at - 1)) + 1;
      const before = t.slice(Math.max(sentenceStart, at - DISCLAIMER_WINDOW), at);
      if (disclaimedBefore(before)) continue;
      return t.slice(Math.max(sentenceStart, at - 30), Math.min(t.length, at + m[0].length + 30)).replace(/\s+/g, ' ').trim().slice(0, 160);
    }
  }
  return null;
}

/** The harness note the freshness re-run carries (rides the final user turn). */
export function unbackedFreshnessNotice(phrase: string): string {
  return `[HARNESS CHECK — NO TOOL CALL: your previous answer claims fresh verification ("${phrase.replace(/"/g, "'").slice(0, 160)}"), `
    + 'but you made NO tool call in that answer, so nothing was read, probed or recounted this turn. '
    + 'Either make the reads NOW (the tools that read the state you cite) and answer from their RESULTS, quoting what they returned, '
    + 'or answer without them and say plainly that the figures come from earlier context (name how old) — never call them fresh, live, re-read or "just now".]';
}

// ── UNBACKED ACTION CLAIM (audit 2026-10-08 W1-2 — supervisors F1, chats F1) ──
// 4 of 16 owner answers on supervisor chats claimed a send / steer / read-back
// with ZERO tool calls: StAnne 8c581bc3 "I've messaged chat d1d0b346" (no such
// chat, nothing sent), Schooltime 3edd998a "I just re-read the capture log …
// **Steering the lane now**", Schooltime 1579dd79 "Steering the recorder lane …
// The lane gets the steer now", CanLaw 74471a68 "Done — … I read back both
// settings after writing them" (its retry re-fabricated and shipped). The
// dispatch check above needs a "receipt" citation; the freshness check misses
// send / write verbs. This lane detects a FIRST-PERSON action claim — a send
// (messaged / sent / steered / steering … / dispatched / relayed / told …), a
// read (read back / re-read / checked / verified …) or a change (set / armed /
// scheduled / cancelled / wrote / filed …) — on an answer that made NO tool
// call of the matching class: a send needs a sending tool, a change a
// non-read tool, a read any tool. Kill switch
// SUPERVISOR_UNBACKED_ACTION_RETRY_DISABLED=1.

export type UnbackedClaimClass = 'send' | 'read' | 'change';
export interface UnbackedActionClaim {
  cls: UnbackedClaimClass;
  /** The matched claim words (bounded). */
  phrase: string;
  /** The claim's sentence span in the text (bold-balanced) — what the rewrite replaces. */
  start: number;
  end: number;
  /** Which detector found it. */
  source: 'action' | 'freshness' | 'dispatch' | 'credential';
  /**
   * HR-1: an EARLIER attempt of this turn ran this write, and the claim's sentence
   * names the same object but cites no id — the act is plausible and unproven, so
   * the claim is still replaced, but by a TURN-AWARE line (what the tool log
   * proves) instead of the false "nothing went out / nothing was changed".
   * Absent ⇒ the ordinary honest line.
   */
  turnBacked?: string;
}

export function unbackedActionRetryDisabled(): boolean {
  return process.env.SUPERVISOR_UNBACKED_ACTION_RETRY_DISABLED === '1';
}
/** Kill switch for the deterministic rewrite of a claim the retry still did not back (ships the retry as-is). */
export function unbackedClaimRewriteDisabled(): boolean {
  return process.env.SUPERVISOR_UNBACKED_CLAIM_REWRITE_DISABLED === '1';
}

/** Tools that back a SEND claim (a message / steer / dispatch / notification left this chat). */
export const SEND_CLAIM_TOOLS: ReadonlySet<string> = new Set([
  'send_chat_message', 'send_to_instance', 'dispatch_platform_task', 'notify_user', 'send_email_as_digby', 'gmail_send_email',
  'start_coding_session', 'imessage_send', 'slack_post_message', 'discord_send_message', 'discord_send_dm', 'x_post',
  'stage_upload', 'delegate', 'delegate_parallel', 'flag_owner_question', 'file_feedback',
]);
/** A tool name that only READS (backs a read claim, never a change claim). */
const READ_TOOL_RE = /^(?:get|list|search|read|resolve|fetch|find|lookup|describe|view|show|query|inspect|check|probe|count|preview|topology|memory_rebuild|test_model)_|_(?:get|list|status|search|read)$|^(?:search_memory|search_engine|scrape_as_markdown|scrape_as_html|scrape_batch|web_pipe|youtube_pipe|wait_for_chat|load_tools|list_tool_groups)$/;

const SUBJ = "\\b(?:i(?:'|’)?ve|i have|i(?:'|’)?m|i am|i)\\b(?:\\s+(?:just|also|then|now|actually|directly|quickly|already|since))*\\s+";
// "told you" / "asked you" / "sent you" / "showed you" are conversation, never a send to another chat.
const SEND_PAST = "(?:re-?messaged|messaged|re-?sent(?!\\s+you)|sent(?!\\s+you)|re-?steered|steered|re-?dispatched|dispatched|relayed|forwarded|pinged|notified|nudged|told(?!\\s+you)|asked(?!\\s+you)|posted|queued)";
const SEND_GER = '(?:messaging|sending|steering|dispatching|relaying|forwarding|pinging|notifying|nudging|telling|posting)';
const READ_PAST = '(?:re-?read|reread|read\\s+back|re-?checked|rechecked|checked|re-?verified|verified|re-?confirmed|confirmed|looked\\s+at|re-?pulled|pulled(?!\\s+together)|re-?queried|queried|inspected|reviewed|scanned|re-?probed|probed|re-?counted|recounted|counted)';
const READ_GER = '(?:re-?reading|reading\\s+back|re-?checking|checking|verifying|pulling|querying|inspecting|reviewing|scanning|probing)';
// "wrote up / written out" is the answer itself, never a write.
const CHANGE_PAST = '(?:re-?set|set|disabled|enabled|cancell?ed|paused|resumed|un-?archived|archived|re-?armed|armed|re-?scheduled|scheduled|updated|re-?wrote(?!\\s+(?:up|out|down))|wrote(?!\\s+(?:up|out|down))|written(?!\\s+(?:up|out|down))|created|filed|flagged|closed|re-?opened|merged|deleted|removed|turned\\s+(?:it\\s+|them\\s+)?(?:off|on)|switched\\s+(?:it\\s+|them\\s+)?(?:off|on)|stopped|killed|restarted|marked|moved|renamed|registered|recorded|saved|stored|added|re-?assigned|assigned|applied|deployed|pushed|committed|fixed|changed|edited|retired|spawned|started|launched|kicked\\s+off)';
const CHANGE_GER = '(?:re-?setting|setting|disabling|enabling|cancell?ing|pausing|resuming|archiving|re-?arming|arming|re-?scheduling|scheduling|updating|writing|creating|filing|flagging|closing|merging|deleting|removing|stopping|killing|restarting|marking|moving|renaming|recording|saving|adding|assigning|applying|deploying|pushing|fixing|changing|spawning|starting|launching)';
const SEND_GER_RE = new RegExp(`^${SEND_GER}$`, 'i');
const READ_GER_RE = new RegExp(`^${READ_GER}$`, 'i');

interface ClaimPattern { re: RegExp; cls: UnbackedClaimClass; form: 'first_person' | 'sentence_gerund' | 'gets_steer' | 'done' }
const ACTION_CLAIM_PATTERNS: ClaimPattern[] = [
  { re: new RegExp(`${SUBJ}(?:${SEND_PAST}|${SEND_GER})\\b`, 'gi'), cls: 'send', form: 'first_person' },
  { re: new RegExp(`${SUBJ}(?:${READ_PAST}|${READ_GER})\\b`, 'gi'), cls: 'read', form: 'first_person' },
  { re: new RegExp(`${SUBJ}(?:${CHANGE_PAST}|${CHANGE_GER})\\b`, 'gi'), cls: 'change', form: 'first_person' },
  // Sentence-initial present participle with the subject elided: "**Steering the lane now**", "Steering the recorder lane to …".
  { re: new RegExp(`(?:^|(?<=[.!?]\\s{1,3}))[ \\t]*(?:[-*•]\\s+|\\d+\\.\\s+)?(?:\\*\\*|__)?(${SEND_GER}|${CHANGE_GER}|${READ_GER})\\b`, 'gim'), cls: 'send', form: 'sentence_gerund' },
  // "The lane gets the steer now", "The lane gets the correction now."
  { re: /\b(?:gets|is getting|receives|is receiving|now has)\s+(?:the|my|a|your)\s+(?:steer|message|correction|nudge|instruction|ping)\b/gi, cls: 'send', form: 'gets_steer' },
  // An answer that opens "Done — …" with nothing done (zero-tool runs only).
  { re: /^\s*(?:\*\*|__)?done\b\s*[—–:!.,-]/gi, cls: 'change', form: 'done' },
];
/** A gerund used as a SUBJECT ("Steering the lane is the next step") is not a claim. */
const GERUND_SUBJECT_RE = /^(?:\S+\s+){0,5}?(?:is|are|was|were|would|should|will|could|can|needs?|requires?|means|remains|stays)\b/i;
/** A gerund-initial sentence must name the act's object or its time to read as an ongoing act. */
const GERUND_OBJECT_RE = /\b(?:now|lane|chat|session|supervisor|steer|message|correction|ticket|schedule|watch|sweep|recorder|worker|board|todo|goal|directive|owner)\b/i;
/** A sentence that places the act in the PAST of another turn is a report, never this answer's claim.
 *  Ticket 318b3175 (round-2 scoped fix, review B1): a supervisor note stamps its OWN
 *  status clock onto the claim sentence itself ("(3:13 PM PDT / 22:13Z)", "Wake at 9:31 AM
 *  PDT Oct 17 (16:31Z): …"), and that stamp exempted a LIVE zero-tool send claim while its
 *  sibling claims were rewritten to the honest line — the durable final shipped "and I've
 *  dispatched the first autonomous step" right beside "I have not sent that message yet —
 *  nothing went out in this answer." (Schooltime supervisor 41bd202a, msg c2449755,
 *  2026-10-16 22:00:51Z, retry metric supervisor_unbacked_claim_retry {invented:["08d3cf2c"],
 *  rewritten:2}.)
 *
 *  SCOPED to the lane that actually escaped — the ACTION lane (first-person claims):
 *  a PARENTHETICAL clock (the incident's own-sentence status stamp, "(3:13 PM PDT /
 *  22:13Z)" / "(16:31Z)") NEVER exempts; an INLINE clock (a narrative event time in the
 *  sentence's prose, "I dispatched the lane at 06:55Z") still exempts as before, because
 *  an honest report of an earlier turn's real act reads exactly that way. The CREDENTIAL
 *  and TOOL-NOUN lanes keep the PRE-fix exemption entirely (pointer word OR any clock):
 *  they are subject-less / noun-shaped and catch THIRD-PERSON historical narration
 *  ("At 05:40Z the onboarding run banked seven keys.") — round-2 review B1, verified
 *  first-hand: new code caught it (old exempt), a pure historical report about ANOTHER
 *  run's act would have been rewritten to a first-person honest line. The incident never
 *  escaped through those lanes (its clause was first-person), so narrowing them bought
 *  nothing and struck honest prose.
 *  Kill switch SUPERVISOR_UNBACKED_CLOCK_NARROW_DISABLED=1 restores the pre-318b3175
 *  bare-clock window on every lane. */
const HISTORICAL_POINTER_RE = /\b(?:earlier|yesterday|ago|previously|previous|prior|last\s+(?:wake|turn|night|sweep|run|time|week|message|answer|reply)|this morning|already|before\s+(?:you|that|this|the))\b/i;
/** The pre-318b3175 bare clock arms — byte-identical, kept for the kill switch. */
const HISTORICAL_BARE_CLOCK_RE = /\b(?:at\s+\d{1,2}:\d{2}|\d{1,2}:\d{2}\s*(?:am|pm|z\b|utc))/i;
/** A clock that NAMES the earlier event it qualifies: "the 05:40Z wake", "that 21:48Z run", "the 02:42Z dispatch". */
const QUALIFIED_CLOCK_RE = /\b(?:(?:the|that|this|last|previous|prior|from|of)\s+\d{1,2}:\d{2}(?:\s*(?:am|pm))?(?:\s*(?:z|utc))?\b[^.!?\n]{0,24}?\b(?:wake|run|turn|sweep|message|answer|reply|night|dispatch|probe|check|sync|firing|session)\b|\d{1,2}:\d{2}(?:\s*(?:am|pm))?\s*(?:z|utc)\b\s*(?:wake|run|turn|sweep|message|answer|reply|firing))\b/i;
/** A clock inside parentheses — the note's OWN status stamp ("(3:13 PM PDT / 22:13Z)", "(16:31Z)"). The 318b3175 escape shape. */
const PARENTHETICAL_CLOCK_RE = /\([^()]{0,80}?\b\d{1,2}:\d{2}(?:\s*(?:am|pm))?(?:\s*(?:z|utc))?\b[^()]{0,80}?\)/i;
/** A sentence that names THIS turn — its clock narrates the model's own (claimed) act time, never an earlier event. */
const THIS_TURN_RE = /\bthis\s+(?:run|turn|wake|answer|reply|note|message|sweep)\b/i;

/** True when the switch-registry kill switch restores the wide bare-clock historical window. */
export function unbackedClockNarrowDisabled(): boolean {
  return process.env.SUPERVISOR_UNBACKED_CLOCK_NARROW_DISABLED === '1';
}

/** The PRE-318b3175 historical test, unchanged: a pointer word or ANY clock. */
function historicalExemptLegacy(text: string): boolean {
  if (HISTORICAL_POINTER_RE.test(text)) return true;
  return HISTORICAL_BARE_CLOCK_RE.test(text);
}

/** The 318b3175 historical test for the ACTION lane only: pointer words and
 *  qualified clocks exempt as before; a bare INLINE clock (a narrative event
 *  time, "I dispatched the lane at 06:55Z") still exempts — an honest report
 *  of an earlier turn's real act reads exactly that way; a bare PARENTHETICAL
 *  clock (the note's own status stamp riding the claim, "(3:13 PM PDT /
 *  22:13Z)") and a sentence naming THIS turn never do. */
function historicalExemptActionLane(text: string): boolean {
  if (HISTORICAL_POINTER_RE.test(text)) return true;
  if (QUALIFIED_CLOCK_RE.test(text)) return true;
  if (THIS_TURN_RE.test(text)) return false;
  if (PARENTHETICAL_CLOCK_RE.test(text)) return false;
  return HISTORICAL_BARE_CLOCK_RE.test(text);
}
/** A sentence about THIS answer's own text ("added a breakdown below") claims no action. */
const SELF_REFERENCE_RE = /\b(?:below|above|in this (?:answer|reply|message|note|response))\b/i;

function sentenceBounds(t: string, at: number): [number, number] {
  let s = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = t[i];
    if (c === '\n') { s = i + 1; break; }
    // ".** Next", ".) Next", '." Next' end a sentence too (closers between the stop and the space).
    const closers = (c === '.' || c === '!' || c === '?') ? /^([*_)\]"'”’]*)\s/.exec(t.slice(i + 1, i + 8)) : null;
    if (closers) { s = i + 1 + closers[1].length; break; }
  }
  let e = t.length;
  for (let i = at; i < t.length; i++) {
    const c = t[i];
    if (c === '\n') { e = i; break; }
    if ((c === '.' || c === '!' || c === '?') && (i + 1 >= t.length || /[\s*_)\]"'”’]/.test(t[i + 1]))) { e = i + 1; break; }
  }
  while (s < e && /\s/.test(t[s])) s += 1;
  // A list / heading marker opening the line stays — the rewrite replaces the sentence, not the bullet.
  const marker = /^(?:[-•]\s+|\*\s+|\d+[.)]\s+|#{1,6}\s+)/.exec(t.slice(s, e));
  if (marker) s += marker[0].length;
  // Trailing bold / italic closers right after the terminal punctuation belong to the sentence.
  while (e < t.length && (t.startsWith('**', e) || t.startsWith('__', e))) e += 2;
  return [s, e];
}

/** Adjust [s,e) so the span holds an even number of "**" markers (never split a bold run): drop an
 *  edge marker first (the replacement then sits inside the bold run), else widen to the enclosing run. */
function boldBalanced(t: string, s: number, e: number): [number, number] {
  const count = (a: number, b: number) => (t.slice(a, b).match(/\*\*/g) ?? []).length;
  if (count(s, e) % 2 === 0) return [s, e];
  if (e - 2 >= s && t.startsWith('**', e - 2)) return [s, e - 2];
  if (t.startsWith('**', s)) return [s + 2, e];
  if (count(0, s) % 2 === 1) {
    const prev = t.lastIndexOf('**', s - 1);
    if (prev >= 0) return [prev, e];
  }
  const next = t.indexOf('**', e);
  return next >= 0 ? [s, next + 2] : [s, e];
}

/** The claim's replaceable span: from its own CLAUSE (after the last "—" / "–" / ";" / ":" / " - " in its
 *  sentence — "You're right to flag that — I just re-read …" keeps its opening clause) to the sentence end. */
function claimSpan(t: string, at: number, clauseLevel: boolean): [number, number] {
  const [s0, e0] = sentenceBounds(t, at);
  let s = s0;
  if (clauseLevel && at > s0) {
    const head = t.slice(s0, at);
    let cut = -1;
    for (const m of head.matchAll(/[—–;]|:(?!\d)|\s-\s/g)) {
      // Only a boundary at paren depth 0 and outside inline code ("(`supervised: false`, confirmed live)" is one clause).
      const pre = head.slice(0, m.index ?? 0);
      const depth = (pre.match(/\(/g) ?? []).length - (pre.match(/\)/g) ?? []).length;
      if (depth > 0 || ((pre.match(/`/g) ?? []).length % 2) === 1) continue;
      cut = (m.index ?? 0) + m[0].length;
    }
    if (cut >= 0) {
      s = s0 + cut;
      while (s < at && /[\s*_)\]]/.test(t[s])) s += 1;
    }
  }
  return boldBalanced(t, s, e0);
}

function inQuoteOrCode(t: string, s: number, at: number): boolean {
  const lineStart = t.lastIndexOf('\n', at - 1) + 1;
  if (/^\s*>/.test(t.slice(lineStart, at))) return true; // blockquote
  if (((t.slice(0, at).match(/```/g) ?? []).length % 2) === 1) return true; // fenced code
  const inSentence = t.slice(s, at);
  if (((inSentence.match(/["“”]/g) ?? []).length % 2) === 1) return true; // inside a quotation
  if (((inSentence.match(/`/g) ?? []).length % 2) === 1) return true; // inline code
  return false;
}

// ── HR-1 (todo 76fd0cce): the WRITE ALLOW-LIST ───────────────────────────────
// Backlog HR-1. Before this, "did this run change anything?" was answered by a
// DENY-list — `!READ_TOOL_RE.test(name)` — which is wrong in the expensive
// direction: `resolve_feedback` starts with `resolve_`, so READ_TOOL_RE called
// the MUTATING ticket close a read, and a true "I've closed your ticket" was
// rewritten to "I have not made that change yet". The mirror error was as bad:
// a name the regex did not recognise (an unknown user-MCP tool) counted as a
// write and backed a fabricated claim. Both come from judging by prefix.
//
// The rule here is an explicit ALLOW-list — a name backs a change claim only if
// it is a known write:
//   • PLATFORM_MUTATING_TOOLS (platform-tool-names.ts — includes resolve_feedback,
//     store_secret, update_supervisor_state, every goal/todo/schedule write),
//   • INTEGRATION_WRITE_TOOL_NAMES (Google + the #26 connector writes),
//   • the document / browser / council / image writes the finalize's replay set
//     already calls side effects (tool-call-leak.ts REPLAY_UNSAFE_TOOLS beyond
//     the two lists above),
//   • a user-MCP tool (`mcp_<server>_<tool>`) whose OWN verb tail is not a read
//     verb — the registry's readOnly flag is DB-backed and unavailable here, so
//     the tail is the only static signal; `mcp_notion_search` stays a READ.
// Everything else — an unknown platform name, update_plan, a bare read, a name
// no module declares — backs NOTHING (fail-safe: the claim is rewritten exactly
// as before rather than exonerated by a name nobody recognises).
const EXTRA_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'create_document', 'update_document', 'fill_pdf_form',
  'browser_task', 'computer_task', 'generate_image', 'dispatch_colleagues',
]);
const PLATFORM_MUTATING_SET: ReadonlySet<string> = new Set(PLATFORM_MUTATING_TOOLS);
/** The verb tail of a user-MCP tool name that means "this is a READ". The server slug and the
 *  tool name may BOTH carry underscores, so the read verb is looked for as a whole `_`-delimited
 *  SEGMENT of the tool portion — the backlog's round-5 `mcp_<slug>_list_issues` shape has its
 *  verb mid-name, and a plain tail check called it a write. */
const MCP_READ_SEGMENT_RE = /_(?:list|get|search|read|fetch|find|query|describe|inspect|status|preview|count|lookup)(?:_|$)/i;

/** True when `name` is a KNOWN WRITE tool — the allow-list above. Pure; exported for tests. */
export function isWriteToolName(name: string | null | undefined): boolean {
  const n = String(name ?? '');
  if (!n) return false;
  if (EXTRA_WRITE_TOOLS.has(n) || PLATFORM_MUTATING_SET.has(n) || INTEGRATION_WRITE_TOOL_NAMES.has(n)) return true;
  if (n.startsWith('mcp_')) return !MCP_READ_SEGMENT_RE.test(n);
  return false; // unknown names back nothing
}

/** Kill switch (one, release): SUPERVISOR_UNBACKED_TURN_BACKING_DISABLED=1 restores the pre-HR-1
 *  behaviour byte-for-byte — the deny-list `!READ_TOOL_RE` change backing and no turn backing. */
export function unbackedTurnBackingDisabled(): boolean {
  return process.env.SUPERVISOR_UNBACKED_TURN_BACKING_DISABLED === '1';
}

/** Which claim classes this run's tool calls back. Pure; exported for tests. */
export function backedClaimClasses(parts: Array<{ type?: string; name?: string }> | undefined): { any: boolean; send: boolean; change: boolean } {
  const calls = (parts ?? []).filter((p) => p?.type === 'tool_call').map((p) => String(p?.name ?? ''));
  return {
    any: calls.length > 0,
    send: calls.some((n) => SEND_CLAIM_TOOLS.has(n)),
    // HR-1: a known WRITE backs a change claim — never "anything the read regex does not match".
    change: calls.some((n) => (unbackedTurnBackingDisabled() ? !!n && !READ_TOOL_RE.test(n) : isWriteToolName(n))),
  };
}

// ── HR-1: backing a claim by ANOTHER attempt of the same turn ────────────────
// The chat seam re-runs the whole orchestration (empty / leak / unbacked retries,
// seat fallback). The delivered answer is judged on ITS OWN parts — rounds 3–6 of
// PR #1878 established that class-level backing from every earlier attempt is a
// hole: a mid-name connector read (gmail_get_message, mcp_<slug>_list_issues)
// counted as a write, and an earlier `update_supervisor_state` exonerated an
// unrelated "I've paused the AGX schedule".
//
// So backing is granted PER CLAIM, never per class, and only when the claim's own
// sentence names the object that write acted on:
//   STRONG — a topic match AND every id the sentence cites appears in that write's
//            own args. The claim really describes that act ⇒ drop it (no rewrite).
//   WEAK   — a topic match with no id cited. The act is plausible but unproven, so
//            the claim is still replaced — by a TURN-AWARE honest line that says
//            what the tool log proves ("an earlier attempt of this turn ran X")
//            instead of the false "nothing went out / nothing was changed".
//   NONE   — no topic match, or ids that the write never saw. Rewritten as today.
// A write whose object this map does not name backs nothing (fail-safe).
const WRITE_ACT_TOPICS: Readonly<Record<string, readonly RegExp[]>> = {
  update_supervisor_state: [/\bsupervisor (?:state|ledger|doc|note|file)\b/i, /\bstate (?:doc|ledger|file)\b/i, /\bledger\b/i],
  resolve_feedback: [/\bticket\b/i, /\bfeedback\b/i],
  update_feedback: [/\bticket\b/i, /\bfeedback\b/i],
  triage_ticket: [/\bticket\b/i],
  file_feedback: [/\bticket\b/i, /\bfeedback\b/i],
  goal_update: [/\bgoal\b/i],
  goal_create: [/\bgoal\b/i],
  goal_premise_set: [/\bpremise\b/i],
  todo_update: [/\btodo\b/i],
  todo_create: [/\btodo\b/i],
  schedule_message: [/\bschedule\b/i, /\bwatch\b/i, /\bcadence\b/i],
  update_schedule: [/\bschedule\b/i, /\bwatch\b/i, /\bcadence\b/i],
  cancel_schedule: [/\bschedule\b/i, /\bwatch\b/i, /\bcadence\b/i],
  flag_owner_question: [/\bquestion\b/i, /\bcard\b/i, /\bowner card\b/i],
  dismiss_owner_question: [/\bquestion\b/i, /\bcard\b/i],
  store_secret: [/\bsecret\b/i, /\bcredential\b/i, /\bkey\b/i],
  send_chat_message: [/\b(?:messaged|sent|steered|relayed|pinged|nudged|notified|posted|queued)\b/i],
  send_to_instance: [/\b(?:messaged|sent|pushed|instance|edge)\b/i],
  notify_user: [/\b(?:notified|pinged|telegram)\b/i],
};

/** 'strong' | 'weak' | 'none' — see the block comment above. Pure; exported for tests. */
export type TurnBacking = 'none' | 'weak' | 'strong';

/**
 * The tool calls of EVERY attempt of the turn minus the delivered attempt's own —
 * the "some other attempt acted" ledger. Counted, not set-compared: a retry may
 * repeat the same call, and only the surplus is another attempt's act.
 */
export function priorAttemptToolCalls(
  turnParts: ReadonlyArray<{ type?: string; name?: string; args?: unknown }> | undefined,
  deliveredParts: ReadonlyArray<{ type?: string; name?: string; args?: unknown }> | undefined,
): Array<{ name: string; args: unknown }> {
  const key = (p: { name?: string; args?: unknown }) => `${String(p?.name ?? '')}\u0000${JSON.stringify(p?.args ?? null)}`;
  const remaining = new Map<string, number>();
  for (const p of deliveredParts ?? []) if (p?.type === 'tool_call') remaining.set(key(p), (remaining.get(key(p)) ?? 0) + 1);
  const out: Array<{ name: string; args: unknown }> = [];
  for (const p of turnParts ?? []) {
    if (p?.type !== 'tool_call') continue;
    const k = key(p);
    const n = remaining.get(k) ?? 0;
    if (n > 0) { remaining.set(k, n - 1); continue; }
    out.push({ name: String(p?.name ?? ''), args: p?.args });
  }
  return out;
}

/**
 * How (if at all) an EARLIER attempt of this turn backs one claim sentence.
 * `sentence` is the claim's own sentence from the delivered text; `call` is a
 * prior attempt's tool call. Pure; exported for tests.
 */
export function turnBackingForClaim(sentence: string, call: { name: string; args: unknown }, opts: { disabled?: boolean } = {}): TurnBacking {
  if (opts.disabled ?? unbackedTurnBackingDisabled()) return 'none';
  if (!isWriteToolName(call.name)) return 'none';
  const topics = WRITE_ACT_TOPICS[call.name];
  if (!topics || !topics.some((re) => re.test(sentence))) return 'none';
  const ids = [...new Set([...sentence.matchAll(HEX8_RE)].map((m) => String(m[1]).toLowerCase()))];
  if (!ids.length) return 'weak';
  const seen = JSON.stringify(call.args ?? null).toLowerCase();
  return ids.every((id) => seen.includes(id)) ? 'strong' : 'none';
}

/** The best backing any other attempt of the turn gives this claim sentence. */
export function bestTurnBacking(sentence: string, priorCalls: ReadonlyArray<{ name: string; args: unknown }> | undefined, opts: { disabled?: boolean } = {}): { backing: TurnBacking; tool?: string } {
  let weakTool: string | undefined;
  for (const call of priorCalls ?? []) {
    const b = turnBackingForClaim(sentence, call, opts);
    if (b === 'strong') return { backing: 'strong', tool: call.name };
    if (b === 'weak') weakTool = call.name;
  }
  return weakTool ? { backing: 'weak', tool: weakTool } : { backing: 'none' };
}

/**
 * Pure: every first-person ACTION claim in a final answer that the run's own
 * tool calls do not back (see the block comment above). Empty when the text
 * claims nothing unbacked. A claim is skipped when it is negated / planned /
 * conditional in its own clause (disclaimedBefore), a question, quoted, or
 * placed in an earlier turn (historicalExemptActionLane — the scoped 318b3175 test); an answer-opening "Done —" is
 * judged only on a run that called no tool at all.
 */
export function unbackedActionClaims(text: string, parts: Array<{ type?: string; name?: string }> | undefined): UnbackedActionClaim[] {
  const t = String(text ?? '');
  if (!t.trim()) return [];
  const backed = backedClaimClasses(parts);
  const out: UnbackedActionClaim[] = [];
  const seen = new Set<string>();
  for (const pat of ACTION_CLAIM_PATTERNS) {
    if (pat.form === 'done' && backed.any) continue;
    pat.re.lastIndex = 0;
    for (const m of t.matchAll(pat.re)) {
      const raw = m[0];
      const lead = raw.length - raw.trimStart().length;
      const at = (m.index ?? 0) + lead;
      let cls = pat.cls;
      if (pat.form === 'sentence_gerund') {
        const verb = String(m[1] ?? '');
        cls = SEND_GER_RE.test(verb) ? 'send' : READ_GER_RE.test(verb) ? 'read' : 'change';
      }
      if (cls === 'send' ? backed.send : cls === 'change' ? backed.change : backed.any) continue;
      const [s0, e0] = sentenceBounds(t, at);
      const sentence = t.slice(s0, e0);
      if (/\?\s*(?:\*\*|__)?\s*$/.test(sentence)) continue; // a question
      if ((unbackedClockNarrowDisabled() ? historicalExemptLegacy(sentence) : historicalExemptActionLane(sentence)) || SELF_REFERENCE_RE.test(sentence)) continue;
      if (inQuoteOrCode(t, s0, at)) continue;
      const before = t.slice(Math.max(s0, at - DISCLAIMER_WINDOW), at);
      if (disclaimedBefore(before)) continue;
      const claimEnd = at + raw.trimStart().length;
      if (/^\s*(?:nothing|no one|none|no message|not\b)/i.test(t.slice(claimEnd, claimEnd + 24))) continue; // "I sent nothing"
      if (pat.form === 'sentence_gerund') {
        const rest = t.slice(at, e0).replace(/^[\s*_\-•\d.)]+/, '');
        if (GERUND_SUBJECT_RE.test(rest)) continue;
        if (!GERUND_OBJECT_RE.test(sentence)) continue;
      }
      const [s, e] = claimSpan(t, at, pat.form === 'first_person' || pat.form === 'gets_steer');
      const key = `${s}:${e}:${cls}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // The claim words plus their object (bounded, same sentence) — what the notice quotes.
      out.push({ cls, phrase: t.slice(at, Math.min(e0, at + 90)).replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120), start: s, end: e, source: 'action' });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Sentence spans of the zero-tool FRESHNESS claims (the T6-3 detector's shapes) — read class. Pure. */
export function unbackedFreshnessSpans(text: string, parts: Array<{ type?: string }> | undefined): UnbackedActionClaim[] {
  const t = String(text ?? '');
  if (!t.trim() || (parts ?? []).some((p) => p?.type === 'tool_call')) return [];
  const out: UnbackedActionClaim[] = [];
  for (const re of FRESHNESS_CLAIM_RES) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      const [s0] = sentenceBounds(t, at);
      const before = t.slice(Math.max(s0, at - DISCLAIMER_WINDOW), at);
      if (disclaimedBefore(before) || inQuoteOrCode(t, s0, at)) continue;
      const [s, e] = claimSpan(t, at, true);
      out.push({ cls: 'read', phrase: m[0].replace(/\s+/g, ' ').slice(0, 120), start: s, end: e, source: 'freshness' });
    }
  }
  return out;
}

/** Sentence spans that cite one of the INVENTED receipt ids of a zero-tool dispatch claim — send class. Pure. */
export function inventedReceiptSpans(text: string, invented: string[]): UnbackedActionClaim[] {
  const t = String(text ?? '');
  const lower = t.toLowerCase();
  const out: UnbackedActionClaim[] = [];
  for (const id of invented) {
    for (let at = lower.indexOf(id); at >= 0; at = lower.indexOf(id, at + id.length)) {
      const [s, e] = claimSpan(t, at, false); // the WHOLE sentence: "Dispatched — receipt X" must not keep "Dispatched —"
      out.push({ cls: 'send', phrase: `receipt ${id}`, start: s, end: e, source: 'dispatch' });
    }
  }
  return out;
}

/** Drop claims whose sentence cites an 8-hex id that is a REAL receipt of this chat (an earlier, real send). */
export async function filterHonestReferences(chatId: string, text: string, claims: UnbackedActionClaim[]): Promise<UnbackedActionClaim[]> {
  const out: UnbackedActionClaim[] = [];
  for (const c of claims) {
    if (c.source === 'dispatch') { out.push(c); continue; } // already existence-checked
    const ids = [...new Set([...text.slice(c.start, c.end).matchAll(HEX8_RE)].map((m) => m[1].toLowerCase()))].slice(0, 4);
    if (ids.length) {
      const invented = await inventedReceiptIds(chatId, ids);
      // fail-closed read error ⇒ [] ⇒ treated as real ⇒ the claim is left alone
      if (invented.length < ids.length) continue; // at least one id is a real receipt → honest reference
    }
    out.push(c);
  }
  return out;
}

/**
 * Every claim still unbacked in a DELIVERABLE text: action claims, zero-tool
 * freshness claims and zero-tool dispatch claims citing an invented receipt.
 * A claim whose sentence cites a REAL receipt of this chat is an honest
 * reference to an earlier send — never rewritten.
 */
export async function residualUnbackedClaims(
  chatId: string,
  text: string,
  parts: Array<{ type?: string; name?: string }> | undefined,
  /**
   * HR-1: EVERY attempt of the turn (delivered + superseded), when the caller has
   * it. Only used to say what the turn's own tool log proves for a claim the
   * delivered attempt cannot back — never to drop a claim except on a STRONG
   * match (a topic match whose cited ids the earlier write's args carry).
   */
  opts?: { turnParts?: ReadonlyArray<{ type?: string; name?: string; args?: unknown }> },
): Promise<UnbackedActionClaim[]> {
  const claims: UnbackedActionClaim[] = [
    ...(unbackedActionRetryDisabled() ? [] : unbackedActionClaims(text, parts)),
    ...(unbackedFreshnessRetryDisabled() ? [] : unbackedFreshnessSpans(text, parts)),
    // Audit 2026-10-16 (gap ii): subject-less "ACTIONS TAKEN" bullets (0a30db95).
    ...(unbackedActionRetryDisabled() ? [] : actionsTakenClaims(text, parts)),
    // Todo 77c88942 item 3 (8fae35a4): subject-less credential-store prose
    // ("Seven keys banked") — zero-tool runs only, never when store_secret ran.
    ...(unbackedActionRetryDisabled() ? [] : unbackedCredentialClaims(text, parts)),
  ];
  const cited = unbackedDispatchClaimIds(text, parts);
  if (cited?.length) claims.push(...inventedReceiptSpans(text, await inventedReceiptIds(chatId, cited)));
  // Todo 77c88942 item 3 (8fae35a4): tool-noun citations ("start_coding_session
  // → 9e39ec5c") — the noun names the act; an invented id after it is a
  // fabricated dispatch.
  const toolNounIds = toolNounCitedIds(text, parts);
  if (toolNounIds?.length) claims.push(...inventedReceiptSpans(text, await inventedReceiptIds(chatId, toolNounIds)));
  if (!claims.length) return [];
  const honest = await filterHonestReferences(chatId, text, claims);
  // HR-1: what the REST of the turn proves. Never widens backing by class — only
  // a claim whose own sentence names the same object does anything here, and only
  // a STRONG match (the sentence's ids ride the earlier write's args) drops it.
  const priorCalls = unbackedTurnBackingDisabled() ? [] : priorAttemptToolCalls(opts?.turnParts, parts);
  if (!priorCalls.length) return honest;
  const out: UnbackedActionClaim[] = [];
  for (const c of honest) {
    const backing = bestTurnBacking(text.slice(c.start, c.end), priorCalls);
    if (backing.backing === 'strong') continue;
    out.push(backing.backing === 'weak' ? { ...c, turnBacked: backing.tool } : c);
  }
  return out;
}

/** The harness note the action re-run carries (rides the final user turn). */
export function unbackedActionNotice(claims: UnbackedActionClaim[]): string {
  const phrases = [...new Set(claims.map((c) => c.phrase))].slice(0, 3).map((p) => `"${p.replace(/"/g, "'")}"`).join(', ');
  const classes = new Set(claims.map((c) => c.cls));
  const what = [classes.has('send') ? 'nothing was sent' : '', classes.has('change') ? 'nothing was changed' : '', classes.has('read') ? 'nothing was read' : ''].filter(Boolean).join(', ');
  return `[HARNESS CHECK — NO MATCHING TOOL CALL: your previous answer says ${phrases}, but that answer made no tool call that does it, so ${what} in that answer. `
    + `If the owner asked for it, do it NOW with the tool (${classes.has('send') ? "send_chat_message with the chat's FULL id for a message or steer" : 'the tool that makes the change or the read'}) and answer from its RESULT, quoting the id it returns. `
    + 'If it really happened in an EARLIER turn, do not repeat it — say so and cite that turn. If you decide not to do it, say plainly that it has not been done yet. Never describe an action as done, sent or underway unless a tool call in THIS answer did it.]';
}

/** The honest replacement sentence for an unbacked claim of each class. */
export const HONEST_CLAIM_LINES: Readonly<Record<UnbackedClaimClass, string>> = {
  send: 'I have not sent that message yet — nothing went out in this answer.',
  change: 'I have not made that change yet — nothing was changed in this answer.',
  read: 'I did not re-read anything in this answer — this comes from earlier context.',
};

// ── NO-ACTION-TOOL NOTE (2026-10-21, FSN1021) ────────────────────────────────
// Owner Paul's Fleet Supervisor chat: a human turn with ZERO tool calls, the one
// retry made none either, and the rewrite replaced the first-person promise with
// HONEST_CLAIM_LINES.change but shipped the next sentence — "Both actions are
// running in the background — the AGX lane gets the rule now, and the card is
// withdrawn" — so the owner read a contradiction and believed work was underway.
// Three rounds of a sentence-level detector for such continuations kept
// rewriting honest lane relays away, so the harness does not judge sentences
// here: when the turn already tripped the unbacked-action / dispatch check, the
// delivered run fired no send or change tool, and the text still speaks of
// something sent / started / running in the background, it APPENDS one line that
// states only what the tool log proves. True whatever the sentences mean; nothing
// is deleted. Kill switch SUPERVISOR_NO_ACTION_NOTE_DISABLED=1.
// The line itself (and its strip / insert helpers) lives in the pure leaf no-action-note.ts so the history
// redactor can use it without loading this module's DB graph.
export { NO_ACTION_TOOL_NOTE, stripNoActionToolNote, insertNoActionToolNote, hasNoActionToolNote, noActionToolNoteDisabled } from './no-action-note';


/** The run's own bookkeeping — none of these sends, starts or changes anything outside the answer. */
const NOTE_NEUTRAL_TOOLS: ReadonlySet<string> = new Set(['finish_run', 'update_plan', 'load_tools', 'load_tool_group', 'list_tool_groups']);
/** Reads the note may treat as "no action": the platform's registered reads plus plain read verbs. An unknown name — any user MCP tool, wait / resolve / set / update verbs — counts as an action, so a misread name only ever leaves the note OFF. */
const NOTE_READ_TOOLS: ReadonlySet<string> = new Set([...PLATFORM_READ_TOOLS, 'resolve_id']);
const NOTE_READ_PREFIX_RE = /^(?:get|list|search|read|fetch|find|lookup|describe|scrape|query)_/;
export function noteReadOnlyTool(name: string): boolean {
  if (!name) return true;
  if (NOTE_NEUTRAL_TOOLS.has(name) || NOTE_READ_TOOLS.has(name)) return true;
  return !name.startsWith('mcp_') && NOTE_READ_PREFIX_RE.test(name);
}

const UNDERWAY_CUE_RE = /\b(?:in the background|underway|under way|in flight|on (?:its|their) way|kicked (?:(?:it|them|both|that|those) )?off)\b|\b(?:is|are|has been|have been)(?: now)? (?:sent|withdrawn|dismissed|cancell?ed|queued|posted|delivered|cleared)\b|\b(?:it|that|this|everything|all)['’]s(?: now)? (?:sent|withdrawn|dismissed|cancell?ed|queued|posted|delivered|cleared)\b/i;
/** A denial in front of the cue ("Nothing has been sent", "No card is withdrawn yet") already says nothing happened. */
const NOTE_NEGATION_RE = /\b(?:no|not|nothing|never|none|neither|nor|without)\b|n['’]t\b/i;
const FOLLOWUPS_BLOCK_RE = /\[FOLLOWUPS\][\s\S]*?(?:\[\/FOLLOWUPS\]|$)/i;

/** True when some sentence of the prose (follow-up chips, quotes, code and blockquotes masked) carries an underway / done-passive cue with no denial in front of it. */
export function hasUnderwayCue(text: string): boolean {
  const prose = String(text ?? '')
    .replace(FOLLOWUPS_BLOCK_RE, ' ')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/[“"][^”"\n]{0,400}[”"]/g, ' ');
  for (const sentence of prose.split(/(?<=[.!?])\s+|\n+/)) {
    const m = UNDERWAY_CUE_RE.exec(sentence);
    if (m && !NOTE_NEGATION_RE.test(sentence.slice(0, m.index))) return true;
  }
  return false;
}

/**
 * Pure: the delivered text with NO_ACTION_TOOL_NOTE inserted (before a
 * [FOLLOWUPS] block when there is one, else at the end), or null when the note
 * does not apply — some tool call of the TURN (pass every attempt's parts) was
 * not a known read, no prose sentence carries an undenied underway / background
 * / done-passive cue, or the note is already there. The caller only asks on a
 * turn whose unbacked send / change / dispatch check fired.
 */
export function noActionToolNote(text: string, parts: Array<{ type?: string; name?: string }> | undefined): string | null {
  // Only the harness writes this line: a copy in the model's text (echoed from history or a reconcile draft) is dropped first.
  const t = stripNoActionToolNote(String(text ?? ''));
  if (!t.trim() || endsInsideOpenFence(t)) return null; // a line appended inside an open fence would render as code
  if ((parts ?? []).some((p) => p?.type === 'tool_call' && !noteReadOnlyTool(String(p?.name ?? '')))) return null;
  if (!hasUnderwayCue(t)) return null;
  const out = insertNoActionToolNote(t);
  if (out === t) return null;
  // Round 8: judged by the finalize's own parsers — the line must survive as standalone prose and never become
  // a follow-up chip (a tapped chip would send the harness line back as the owner's words). Else it stays off.
  const parsed = parseFollowUps(out);
  if (!hasNoActionToolNote(stripAnswerMarkup(out)) || parsed.followUps.some((f) => f.includes(NO_ACTION_TOOL_NOTE.slice(0, 40)))) return null;
  return out;
}

/**
 * The turn's durable receipts: true when this chat minted an ok receipt for a
 * non-read tool since the owner's message — it catches calls an earlier attempt
 * made before a seat fallback or retry replaced the delivered run. A failed
 * lookup counts as acted (the note is then left off).
 */
export async function actedSinceTurn(chatId: string, since: Date | undefined): Promise<boolean> {
  if (!since) return true;
  try {
    const rows = await prisma.runToolReceipt.findMany({ where: { chatId, ok: true, createdAt: { gte: since }, tool: { notIn: [...NOTE_READ_TOOLS, ...NOTE_NEUTRAL_TOOLS] } }, select: { tool: true }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.some((r: { tool: string }) => !noteReadOnlyTool(String(r.tool ?? '')));
  } catch {
    return true;
  }
}

/**
 * Deterministic rewrite: each unbacked claim's sentence is REPLACED by the
 * honest line of its class (send > change > read when spans overlap), so the
 * claim never ships; an identical honest line right after another collapses.
 * Pure; exported for tests.
 */
/**
 * Options (ticket f05b38c1): `noBlockCollapse` — replace ONLY the given
 * sentence spans, never the whole ACTIONS TAKEN block. The triple-enforcement
 * lane strikes ONE mismatched citation; the block collapse is the residual
 * lane's shape (every bullet unbacked) and would delete HONEST sibling
 * bullets from a delivered note (review finding B2 — a false strike on
 * content the claim never touched, strictly worse than the miss).
 */
export interface RewriteClaimsOptions {
  noBlockCollapse?: boolean;
}

export function rewriteUnbackedClaims(text: string, claims: UnbackedActionClaim[], opts?: RewriteClaimsOptions): string {
  const t = String(text ?? '');
  if (!claims.length) return t;
  // Audit 2026-10-16 (gap iii, specimen 65a92992): claims inside an ACTIONS
  // TAKEN block are rewritten as ONE block replacement — header + every bullet
  // of the block — so the deliverable never keeps a "homework complete"
  // headline next to three copies of the honest line.
  const blockSpan = wholeClaimBlockSpan(t, claims);
  let effClaims = claims;
  if (!opts?.noBlockCollapse && blockSpan && claims.some((c) => c.start >= blockSpan[0] && c.end <= blockSpan[1])) {
    const inBlock = claims.filter((c) => c.start >= blockSpan[0] && c.end <= blockSpan[1]);
    const outside = claims.filter((c) => !(c.start >= blockSpan[0] && c.end <= blockSpan[1]));
    const bestCls = inBlock.reduce<UnbackedClaimClass>((acc, c) => (rank3(c.cls) > rank3(acc) ? c.cls : acc), 'read');
    effClaims = [...outside, { cls: bestCls, phrase: inBlock[0].phrase, start: blockSpan[0], end: blockSpan[1], source: 'action' }];
  }
  const rank: Record<UnbackedClaimClass, number> = { send: 3, change: 2, read: 1 };
  const merged: Array<{ start: number; end: number; cls: UnbackedClaimClass; turnBacked?: string }> = [];
  for (const c of [...effClaims].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && c.start < last.end) {
      last.end = Math.max(last.end, c.end);
      if (rank[c.cls] > rank[last.cls]) last.cls = c.cls;
      if (c.turnBacked) last.turnBacked = c.turnBacked;
    } else merged.push({ start: c.start, end: c.end, cls: c.cls, turnBacked: c.turnBacked });
  }
  let out = '';
  let cursor = 0;
  let lastLine = '';
  for (const m of merged) {
    const gap = t.slice(cursor, m.start);
    // HR-1: when ANOTHER attempt of this turn ran a write on the same object, the
    // false "nothing went out / nothing was changed in this answer" is replaced by
    // what the tool log actually proves.
    const line = m.turnBacked ? turnBackedClaimLine(m.cls, m.turnBacked) : HONEST_CLAIM_LINES[m.cls];
    out += line === lastLine && !gap.trim() ? '' : gap + line;
    lastLine = line;
    cursor = m.end;
  }
  out += t.slice(cursor);
  return out.replace(/[ \t]{2,}/g, ' ');
}

/**
 * HR-1: the honest line for a claim the DELIVERED answer cannot back but an
 * EARLIER attempt of the same turn ran a matching write for. It never claims the
 * act landed in this answer and never says nothing happened — it names the tool
 * whose receipt the turn owns, and points at the evidence.
 */
export function turnBackedClaimLine(cls: UnbackedClaimClass, tool: string): string {
  const what = cls === 'send'
    ? 'That message went out from an earlier attempt of this turn, not this answer'
    : cls === 'read'
      ? 'That read ran in an earlier attempt of this turn, not this answer'
      : 'That change was made by an earlier attempt of this turn, not this answer';
  return `${what} — the \`${tool}\` call is in the turn's tool log.`;
}

const rank3 = (cls: UnbackedClaimClass): number => (cls === 'send' ? 3 : cls === 'change' ? 2 : 1);

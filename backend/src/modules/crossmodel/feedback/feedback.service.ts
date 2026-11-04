/**
 * Agent feedback loop — ONE service behind the file_feedback / list_feedback /
 * update_feedback platform tools (and the shared type list for the user-facing
 * REST endpoint, crossmodel.controller.ts submitFeatureRequest).
 *
 * Agents (chat agent, coding orchestrators, worker subagents of every role)
 * file tickets into the SAME user_feature_requests table the user-facing
 * Feedback tab writes to — bugs, mishaps (unnecessary/wrong behavior that
 * isn't strictly a code bug), enhancement ideas, and research ideas — so a
 * human admin or a scheduled supervisor session can triage them. This closes
 * the loop the nightly autopilot served before its removal (2026-07-20).
 *
 * Safety shape (file_feedback is reachable from EVERY agent surface, incl.
 * anonymous chat runs and cheap helper-tier workers):
 *   - DEDUP: a repeat sighting of an open AGENT-filed ticket (same type +
 *     normalized title, 90-day window) bumps priority + context.occurrences,
 *     records the sighting (context.sightings, last 5) and appends the new
 *     description instead of creating a duplicate row — a sighting on an
 *     IN_PROGRESS ticket escalates priority +1 (recurrence means the
 *     dispatched fix did not hold). A secondary FUZZY pass
 *     (tickets 167822fb/9982d063) merges PARAPHRASED titles for one incident:
 *     same context.sessionId/chatId, 24h window, any type, word-set Jaccard
 *     ≥ 0.6 on normalized titles. Agent filings never dedup against — i.e.
 *     never mutate — USER-filed tickets. REOPEN-ON-RECURRENCE (2026-08-31):
 *     an exact-title match against a recently-CLOSED agent ticket reopens it
 *     (occurrence trail survives, dispatch claim released, drain fired) —
 *     closure used to destroy the recurrence signal, so every same-class
 *     ticket looked like a one-off and root causes shipped un-fixed.
 *     SYSTEM-identity filings (ticket beb1788b, 2026-10-18): a programmatic
 *     filing stamped context.surface='system' (log-signal sweep, infra-watch
 *     card tickets, framework signal sweep — the tool layer stamps
 *     agentSurface ?? 'coding', so only server code can stamp 'system') never
 *     takes the two LINK-creating passes (cross-source, incident-twin): a
 *     containment/overlap hit over its raw-log-excerpt haystack parked the
 *     fingerprint as a done duplicate under a wrong parent, undispatchable.
 *     Its stable title keeps the exact/reopen contract. Kill switch
 *     FEEDBACK_SYSTEM_FILING_LINK_GUARD_DISABLED=1.
 *     EXCEPTION (be06c812, 2026-10-18): a closed match carrying a RECORDED
 *     adjudication verdict (context.adjudicatedClass or the adminNote
 *     wording — isAdjudicatedTicketRow) is a standing class, not a
 *     recurrence: it counter-bumps in the adjudicated absorption shape (no
 *     status flip, no escalation, no dispatch), and a recorded "re-open
 *     bar" in the adminNote re-arms the legacy gates when a sighting's 24h
 *     count crosses it (feedback_adjudicated_bar_breach).
 *   - RATE CAPS (agent source only): >20 tickets per session per hour, and a
 *     ≥300 tickets/day global backstop (raised 5→20 / 50→300 on 2026-08-31 —
 *     the ca-central-1 fleet has the headroom). A cap hit NO LONGER DROPS the
 *     filing: the row is stored with status 'queued' and auto-promotes to
 *     'open' as windows free (self-draining, no sweeper) — the pre-queue
 *     behavior silently vanished user-requested tickets. The queue itself is
 *     bounded (QUEUED_CAP_PER_SESSION / QUEUED_CAP_GLOBAL backstops); only
 *     past THOSE does a refusal drop, still as a STRUCTURED result
 *     ({ error: 'rate_limited' }), never a thrown 500 — the tool layer
 *     surfaces either outcome to the model as a routine message.
 *   - list_feedback / update_feedback are ADMIN-gated at execution
 *     (isAdminUser) — the tool schema is advertised to orchestrators, but a
 *     non-admin run gets a friendly refusal.
 */

import prisma from '../../../config/database';
import { Prisma } from '@prisma/client';
import logger from '../../../utils/logger';
import { killSwitchOn } from '../../../utils/kill-switch';
import { AppError } from '../../../middleware/error-handler';
// af4ef7c7: the pure sighting-fit block moved to an env-free leaf so the
// breaker filer can share ONE implementation without importing this module.
import { DESCRIPTION_MAX, fitBumpedDescription } from './sighting-fit';
// Re-exported at its historical path so existing importers and pins are unchanged.
export { fitBumpedDescription } from './sighting-fit';
import { extractFeedbackImages, splitPackedDescription } from './feedback-images';
import { resolveTicketFixState, type TicketFixState } from './fix-state';
import { modelToolName } from '../coding/tool-scope';
import { recordLoopMetric } from '../platform/loop-metrics.service';
import { harnessSubjectRedactDisabled, isHarnessTicketContext, shapeOnlyDescription } from './harness-ticket';
import { findIncidentTwin, incidentTwinDedupeDisabled } from './incident-twin';
// fffacaee: the infra-alert stable-key leaf (pure extractors — no env-validating
// imports, same discipline as ticket-status/ticket-family).
import {
  INFRA_ALERT_KEY_FIELD,
  extractInfraAlertKey,
  infraAlertDedupDisabled,
  infraAlertKeyOfContext,
  infraAlertKeyString,
  infraAlertKeysEqual,
} from './infra-alert-key';
// TICKET-FAMILY-ROUTING + ACCEPTANCE-METRIC-BASELINE (2026-10-20): both leaves
// import only prisma + the ticket-status leaf (no env-validating chains).
import { FAMILY_QUEUED_NOTE_PREFIX, closeStampPatch, familyFilingRoute, familyPrecisionRoutingDisabled, familyQueuedNote, parseAdjudicatedReopenBar, type FamilyPrecision } from './ticket-family';
import { acceptanceBaselineGateDisabled, measureAcceptanceBaseline, readAcceptanceMetric } from './ticket-metric';
import {
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  OPEN_TICKET_STATUSES,
  closedTicketStatusesForQuery,
  normalizeTicketStatus,
  ticketStatusRank,
  type FeedbackStatus,
  type FeedbackType,
} from './ticket-status';

// ── Shared constants (imported by the REST controller too) ────────────────────

// FEEDBACK_TYPES / FeedbackType moved to ticket-status.ts (the import-free
// leaf — ticket 6665fff6, review A8) and are re-exported below so every
// existing importer (controller, platform-tools, live-chat-audit) is unchanged.
export { FEEDBACK_TYPES };
export type { FeedbackType } from './ticket-status';

// The status vocabulary lives in ticket-status.ts (backlog audit T8,
// 2026-09-28): ONE canonical write set + ONE "closed" read set shared with the
// closure manifest, the REST controller and the coding stopped-schedule alert.
// Re-exported so existing importers keep their surface.
export { FEEDBACK_STATUSES };
export type { FeedbackStatus };

// Triage sort rank for status (ticket a1ca6bfc). The documented list order is
// open-first, then priority desc, then newest — but `status` is a plain String
// column, so a DB `orderBy: { status }` sorts it ALPHABETICALLY
// ('done' < 'in_progress' < 'open'), which is exactly BACKWARDS and buried open
// tickets under done ones. Prisma's query builder can't express a CASE/mapped
// rank in orderBy, so we rank status EXPLICITLY here and apply it in code.
// 'queued' (2026-08-31) = rate-cap-held filings awaiting auto-promotion — they
// rank after actively-triaged rows but ahead of done. A legacy closed spelling
// ('resolved') ranks with 'done' (ticket-status.ts).
const statusRank = (status: string): number => ticketStatusRank(status);

export const FEEDBACK_SOURCES = ['user', 'agent'] as const;

const TITLE_MAX = 140;
// af4ef7c7: DESCRIPTION_MAX now lives in ./sighting-fit (one value, shared with
// the breaker filer's attach arm) — imported above, not redefined here.
const AREA_MAX = 40;
const PRIORITY_MIN = 0;
const PRIORITY_MAX = 5;
const DEDUP_WINDOW_MS = 90 * 24 * 3600_000;
// Secondary FUZZY dedup (tickets 167822fb/9982d063): paraphrased titles for
// ONE incident from the SAME session/chat within this window merge when their
// normalized-title word sets overlap at ≥ the Jaccard threshold. Deliberately
// strict — wrongly merging two DISTINCT issues buries one inside the other.
const FUZZY_DEDUP_WINDOW_MS = 24 * 3600_000;
const FUZZY_TITLE_JACCARD = 0.6;
const FUZZY_CANDIDATE_SCAN = 50; // bound the same-session candidate scan
// Class-keyed MISHAP dedup (audit roadmap #9c, 2026-09-02): agent mishaps for
// ONE failure class differ only in their tail (session ids, timestamps,
// counts) — the exact-title pass filed each variant as a fresh row and the
// fuzzy pass only merges within one session/24h. Mishap filings therefore
// ALSO dedup on the first N normalized chars of the title against open-ish
// agent mishaps (same 90d window/candidates as the exact pass), bumping
// occurrences instead of duplicating. N=60: long enough that two DIFFERENT
// mishap classes sharing it are near-identical prose anyway; titles whose
// normalized form is shorter than N degrade exactly to the exact pass (both
// sides must match the full key).
const MISHAP_CLASS_KEY_LEN = 60;
// Cross-source duplicate match (backlog audit T2, ticket d6110694 / 7acaa7ba,
// 2026-09-28): an agent-CAPTURED owner remark ("Owner report … shared
// workspaces dont work and throw errors", filed from a supervisor chat) is
// very often the owner's OWN user-filed ticket from minutes earlier. Every
// agent pass above is source='agent' by design (an agent filing must never
// mutate a user row), so the twin was never consulted and the dispatcher
// spun up a SECOND lane on the same defect. This pass is READ-ONLY on the
// user row: user-sourced open rows of the SAME user in the last 24 h are
// matched on normalized title (exact, Jaccard ≥ the fuzzy bar, or one title
// contained in the other filing's text); a match files the agent row as a
// LINKED DUPLICATE — status 'done', context.duplicateOf, autoDispatch:false —
// so it is recorded but never dispatched, and the user row is untouched.
const CROSS_SOURCE_WINDOW_MS = 24 * 3600_000;

// SYSTEM-identity filings (ticket beb1788b, 2026-10-18): the log-signal sweep
// (and infra-watch card tickets / the framework signal sweep) file through
// fileFeedbackTicket with the first admin's userId and a SERVER-STAMPED
// context.surface='system' (the file_feedback tool layer stamps
// ctx.agentSurface ?? 'coding' — agentSurface is only ever 'chat' | 'coding'
// — so no agent-carried context can forge 'system'). System filings are
// RECURRING FINGERPRINT RECORDS, not captures of an owner remark: their
// description embeds a raw log excerpt (600 chars for the log-signal sweep)
// that enlarges the containment haystack, and BOTH link-creating passes key
// on text containment/overlap rather than defect substance — a match parks
// the fingerprint as a done + duplicateOf row under a WRONG parent
// (reproduced live 2026-10-16: the run-journal P0 spec 35596b15/38a16954
// parked under the preempted-turns P0 a5b36dc6). A parked fingerprint is
// recorded as "handled" but was never dispatched, and later weeks re-file
// it. A system filing therefore never takes the cross-source link or the
// incident-twin link — its stable per-fingerprint title is already covered
// by the exact-title pass (the 90-day bump) and the closed-reopen pass,
// which is the dedup contract the sweep's title-agreement guard assumes.
// Kill switch FEEDBACK_SYSTEM_FILING_LINK_GUARD_DISABLED=1 (fail-safe: the
// link paths take effect again for system filings).
const SYSTEM_FILING_SURFACES = new Set(['system']);

export function systemFilingLinkGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test(String(env.FEEDBACK_SYSTEM_FILING_LINK_GUARD_DISABLED ?? '').trim());
}

/**
 * True when this filing is a programmatic SYSTEM filing (a recurring-signal
 * record: log-signal sweep, infra-watch card tickets, framework signal
 * sweep) — identified by the server-stamped surface. Pure.
 */
export function isSystemTicketFiling(context: unknown): boolean {
  if (systemFilingLinkGuardDisabled()) return false;
  const c = context && typeof context === 'object' && !Array.isArray(context) ? (context as Record<string, unknown>) : {};
  return typeof c.surface === 'string' && SYSTEM_FILING_SURFACES.has(c.surface.trim().toLowerCase());
}
const CROSS_SOURCE_CANDIDATE_SCAN = 50;
const CROSS_SOURCE_CONTAINMENT_MIN_TOKENS = 4; // a title this short is too generic to match by containment
const CROSS_SOURCE_TEXT_MAX = 4000;            // bound the containment haystack
const SESSION_CAP_PER_HOUR = 20;  // queue when EXCEEDED (> 20) within the hour (raised 5 → 20, 2026-08-31)
const GLOBAL_CAP_PER_DAY = 300;   // queue when REACHED (>= 300) within 24h (raised 50 → 300, 2026-08-31)
// Queued-filing backstops (2026-08-31): a cap hit STORES the ticket as
// status='queued' instead of dropping it — but the queue itself must be
// bounded or a runaway session/table floods the DB. Past THESE depths the
// refusal really does drop (structured rate_limited, as before).
const QUEUED_CAP_PER_SESSION = 10;  // max queued backlog held for one session
const QUEUED_CAP_GLOBAL = 500;      // max queued backlog held table-wide
const QUEUE_PROMOTE_PER_PASS = 3;   // oldest queued rows auto-promoted per under-cap filing
const SIGHTINGS_KEPT = 5;         // dedup trail: last N sightings kept in context
// ── 90-day dedup scan shape (ticket 586ebe71) ────────────────────────────────
// The exact-title dedup scans (open exact / mishap-class, closed-reopen,
// adjudicated-class) are UNBOUNDED over their 90-day window: findDedupCandidate
// pages through the candidates newest-first until the window is exhausted. The
// pre-586ebe71 shape scanned only the newest 200 rows (take: 200) — once >200
// newer agent rows existed, a STANDING ticket (e.g. a log-signal-sweep class
// row) fell out of the scan and its next recurrence filed a duplicate, eroding
// the "one durable row per standing class" property at ~60-90 days of volume.
// The DB narrows every page with a normalization-stable prefilter (see
// dedupPrefilterToken), so a page costs the same as the old single query.
export const DEDUP_SCAN_PAGE = 200;
// Deadman switch, NOT a semantic window: 200 pages × 200 rows = 40k candidate
// rows is unreachable under the filing caps (GLOBAL_CAP_PER_DAY 300 × 90d
// ≈ 27k rows TOTAL, and the prefilter admits only a slice of those). It exists
// so a non-advancing cursor bug can never loop a filing forever.
export const DEDUP_SCAN_MAX_PAGES = 200;
// Saturation cap (ba65163d churn pathology): after this many "fix did not hold"
// reopens on ONE recurring-class ticket, further withhold-class sightings
// counter-bump instead of reopening — the signal is saturated, each reopen
// re-fires a full dispatch whose lane has repeatedly fabricated its own
// remediation lifecycle, and the trail + reopenSuppressedCount keep the
// recurrence auditable (a human can still re-open manually via update_feedback).
const REOPEN_SUPPRESS_AFTER = 3;
const LIST_DESCRIPTION_MAX = 500; // list_feedback rows cap description (context-size guard)

// ── file ──────────────────────────────────────────────────────────────────────

export interface FileFeedbackOpts {
  /** null for anonymous chat runs (no users row — the column is nullable). */
  userId: string | null;
  type: string;
  title: string;
  description: string;
  priority?: number;
  area?: string;
  /** Tool-layer captured metadata: sessionId, surface, role, projectId, filedAt. */
  context: Record<string, unknown>;
  /**
   * HARNESS filers only (audit 2026-10-08 W5-1b): a harness-written shape line
   * (claim kinds + cited ids — never chat text) stored in place of the full
   * description when the subject account is not an admin (harness-ticket.ts).
   */
  shapeDescription?: string;
  /**
   * SHARED-PROJECT-DISPATCH (2026-10-20): the filing chat's SUPERVISOR seat,
   * stamped by the file_feedback tool. An about=digby_platform filing from a
   * supervisor seat on an account the dispatcher would HOLD is auto-approved
   * for a ticket lane with a shape-only description (held-ticket-escalation
   * shouldAutoApprovePlatformTicket). Kill switch
   * HELD_PLATFORM_TICKET_AUTOAPPROVE_DISABLED=1.
   */
  filerSeat?: 'project_supervisor' | 'fleet_supervisor';
  /**
   * SHARED-PROJECT-DISPATCH review fix (2026-10-20): the filing CHAT's project
   * (crossmodel_chats.projectId, read by the file_feedback tool) — auto-approval
   * requires it to be OWNED by the ticket-lane owner with the filer an editor /
   * admin member of it.
   */
  filerProjectId?: string | null;
  /** SHARED-PROJECT-DISPATCH review fix: the filing turn is a MACHINE turn (auto-approval never rides a human's typed ask). */
  filerMachineTurn?: boolean;
}

export type FileFeedbackResult =
  /** `duplicateOf` (T2): the USER-filed ticket this agent capture was linked to — the returned `ticket` is the agent's own linked row, never the user row. */
  | { deduped: boolean; ticket: any; duplicateOf?: string }
  | { queued: true; ticket: any }
  | { error: 'invalid' | 'rate_limited'; message: string };

/** The user-sourced candidate shape the cross-source pass reads (select-projected). */
export interface CrossSourceCandidate {
  id: string;
  title: string;
  description: string;
}

export type CrossSourceMatch = { candidate: CrossSourceCandidate; matchedBy: 'exact' | 'fuzzy-title' | 'title-contained' };

/**
 * Pure matcher for the cross-source pass (T2): does an agent filing (title +
 * description) describe the same defect as one of the user's own open rows?
 * Exact normalized title → Jaccard ≥ FUZZY_TITLE_JACCARD → the user's title
 * (≥ 4 tokens) contained in the agent's text, or the agent's title (≥ 4
 * tokens) contained in the user's text. First match in candidate order wins.
 * Exported for tests.
 */
export function findCrossSourceDuplicate(
  candidates: ReadonlyArray<CrossSourceCandidate>,
  filing: { title: string; description: string },
): CrossSourceMatch | null {
  const norm = normalizeFeedbackTitle(filing.title);
  if (!norm) return null;
  const agentText = normalizeFeedbackTitle(`${filing.title} ${filing.description}`.slice(0, CROSS_SOURCE_TEXT_MAX));
  const tokenCount = (s: string) => s.split(' ').filter(Boolean).length;
  const contained = (needle: string, hay: string) =>
    tokenCount(needle) >= CROSS_SOURCE_CONTAINMENT_MIN_TOKENS && ` ${hay} `.includes(` ${needle} `);
  for (const c of candidates) {
    const cNorm = normalizeFeedbackTitle(String(c.title ?? ''));
    if (!cNorm) continue;
    if (cNorm === norm) return { candidate: c, matchedBy: 'exact' };
    if (titleTokenJaccard(cNorm, norm) >= FUZZY_TITLE_JACCARD) return { candidate: c, matchedBy: 'fuzzy-title' };
    const userText = normalizeFeedbackTitle(`${c.title ?? ''} ${c.description ?? ''}`.slice(0, CROSS_SOURCE_TEXT_MAX));
    if (contained(cNorm, agentText) || contained(norm, userText)) return { candidate: c, matchedBy: 'title-contained' };
  }
  return null;
}

/** Lowercase, strip punctuation, collapse whitespace — the dedup comparison key. */
export function normalizeFeedbackTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Ticket 79cc46ee (2026-10-17): the filer used to REJECT any title over
 * TITLE_MAX, and the filing agent never noticed — two P1 memory-audit
 * filings (157/173-char titles) were lost on 2026-10-16. Instead of
 * rejecting, a long title is cut at a word boundary to at most
 * TITLE_MAX-1 chars + '…'; the FULL original title is prepended to the
 * description by the caller (fileFeedbackTicket). Pure (no I/O), exported
 * so the tool layer derives its "title was shortened" notice from the SAME
 * helper — the two can never drift.
 *
 * Shape rules:
 * - ≤ TITLE_MAX chars → returned unchanged (never touched).
 * - No whitespace to cut at → hard cut at TITLE_MAX-1 + '…' (never blows the column).
 * - The cut lands on a code-unit boundary: a cut INSIDE a surrogate pair is
 *   repaired by dropping the orphaned lead unit (emoji stays whole).
 * - A no-space title whose cut lands mid-surrogate, and multibyte at the cut
 *   point generally, are pinned by the replay suite.
 */
export function shortenFilingTitle(title: string): { title: string; shortened: boolean; originalTitle: string } {
  const trimmed = title.trim();
  if (trimmed.length <= TITLE_MAX) return { title: trimmed, shortened: false, originalTitle: trimmed };
  const cut = trimmed.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, ''); // word boundary within the budget
  // Repair a surrogate pair split by the slice: a trailing high surrogate
  // (0xD800-0xDBFF) with no low surrogate after it is an orphan — drop it.
  const endsWithOrphanLead = /[\uD800-\uDBFF]$/.test(cut);
  const clean = endsWithOrphanLead ? cut.slice(0, -1) : cut;
  return {
    title: `${clean}…`,
    shortened: true,
    originalTitle: trimmed,
  };
}

/**
 * Word-set Jaccard similarity of two NORMALIZED titles — the fuzzy dedup
 * score (|A∩B| / |A∪B| over whitespace-split token sets). 0 when either side
 * is empty.
 */
export function titleTokenJaccard(a: string, b: string): number {
  const setA = new Set(a.split(' ').filter(Boolean));
  const setB = new Set(b.split(' ').filter(Boolean));
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

function asContextObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** True when a CLOSED agent-family row carries a recorded adjudication
 *  verdict — context.adjudicatedClass (stamped structurally by the
 *  absorption path itself whenever a row absorbs a sighting by its
 *  adjudication; there is deliberately NO other writer — a filer-supplied
 *  stamp is only ever honored on rows the adjudication logic has already
 *  confirmed), or the adminNote verdict wording (model behavior / guard(s) correct / no
 *  deterministic framework defect). One predicate for BOTH consumers: the
 *  reopen pass's same-type short-circuit and the cross-type adjudicated-class
 *  dedupe (audit 2026-10-16 item 6, todo 6df5fc61) — the two must never drift
 *  apart on what "adjudicated" means, or a row adjudicated for one pass
 *  reopens through the other (ticket be06c812, the log-signal family lane).
 *
 *  NEGATION-BLIND (cross-family review B1, 2026-10-18): the old regex matched
 *  "model behavior" ANYWHERE — including "FRAMEWORK DEFECT (not model
 *  behavior)" and "NOT model behavior — fixed and deployed", the CONFIRMED-
 *  DEFECT closure shape (24 of 139 prod rows matching the old predicate were
 *  negation-shaped; 2 agent-source, exactly this pass's candidate scope).
 *  Absorbing those silently kills a real recurrence signal forever. A verdict
 *  phrase must now be POSITIVE: no not/never/nor/isn't/wasn't negator within
 *  the 40 chars before the match. The structural stamp
 *  (context.adjudicatedClass === true) is exempt — a deliberate stamp is not
 *  prose and carries no negation ambiguity. Fail direction: a note that
 *  cannot be parsed positive falls through to the legacy reopen — the safe
 *  direction for a REAL defect's ticket. */
function isAdjudicatedTicketRow(row: { context?: unknown; adminNote?: string | null }): boolean {
  if (asContextObject(row.context).adjudicatedClass === true) return true;
  const note = String(row.adminNote ?? '');
  const ADJUDICATED_VERDICT_RE = /\b(?:model behavior\b|guard(?:s)? (?:was |were |fired |is |are )?correct\b|no(?:-| )deterministic framework defect\b|no framework defect\b)/gi;
  const NEGATOR_RE = /\b(?:not|never|nor|isn'?t|wasn'?t|ain'?t|zero)\b[^a-z0-9]{0,3}$/i;
  let m: RegExpExecArray | null;
  while ((m = ADJUDICATED_VERDICT_RE.exec(note)) !== null) {
    const window = note.slice(Math.max(0, m.index - 40), m.index);
    if (!NEGATOR_RE.test(window)) return true;
  }
  return false;
}

/**
 * af4ef7c7 — attach a same-class sighting to an already-ADJUDICATED closed
 * row, keyed on the stamped class key alone.
 *
 * The KEY ITSELF lives in ./breaker-class-key.ts (an import-free leaf) so the
 * hot breaker filer can derive it without dragging this module's dependency
 * graph — and this module's eager env validation — into its test suites.
 * Re-exported here so callers that already depend on this module keep one
 * import site.
 */
export { breakerClassKey, BREAKER_CLASS_KEY_FIELD } from './breaker-class-key';

/**
 * af4ef7c7 — attach a same-class sighting to an already-ADJUDICATED closed
 * row, keyed on the stamped class key alone.
 *
 * WHY A SEPARATE ENTRY POINT. Every dedupe pass lives INSIDE
 * fileFeedbackTicket, and the harness filer (coding/reflection.ts) writes its
 * breaker ticket with a raw prisma.userFeatureRequest.create — so those rows
 * never entered the dedupe chain at all. Stamping a key at that create site
 * would be inert. Routing the filer through fileFeedbackTicket instead would
 * put harness breaker tickets under its rate caps (20/session/hour, 300/day
 * global) and its cross-source linking, which is the wrong blast radius for a
 * self-healing detector. This helper gives the raw-write filers exactly the
 * one arm they need, with no rate cap and no cross-source pass.
 *
 * NO TITLE PREFILTER. The lookup is a direct JSON-path equality on the stamp
 * (plus an honest re-check in JS). The legacy scan prefilters on
 * `title CONTAINS <token>`, which for a breaker title is usually the mutable
 * chat-title word — that is exactly how the class went unseen.
 *
 * Fail-open: any error returns null and the caller files normally. Attaching
 * must never be able to block a ticket.
 */
// af4ef7c7: the raw-write-filer arm lives in ./adjudicated-class-attach.ts
// (a leaf whose import graph never reaches config/env — see that file's
// header for the measured reason). Re-exported so callers keep one site.
export { bumpAdjudicatedClassSighting } from './adjudicated-class-attach';

/**
 * The adjudication's recorded RE-OPEN BAR — the 24h row count past which the
 * verdict itself demands re-examination. MOVED verbatim to ticket-family.ts
 * (ticket 0ef6794e, 2026-10-26: the log-signal sweep's per-fingerprint
 * adjudication suppression needs the same bar semantics at the filing
 * decision — one parser, one meaning, both layers) and imported above; the
 * absorption pass below and every existing pin keep their exact behavior.
 */

/** Validate the caller-supplied fields; returns an error message or null. */
function validateFileInput(opts: FileFeedbackOpts): string | null {
  if (!(FEEDBACK_TYPES as readonly string[]).includes(opts.type)) {
    return `Invalid type "${opts.type}" — allowed: ${FEEDBACK_TYPES.join(' | ')}.`;
  }
  const titleLen = opts.title.trim().length;
  // 79cc46ee: a >TITLE_MAX title is no longer a rejection — the filer
  // shortens it (shortenFilingTitle) and keeps the full text in the
  // description. Only an EMPTY title is invalid now.
  if (titleLen < 1) {
    return `title must be at least 1 char after trimming (got ${titleLen}).`;
  }
  const descLen = opts.description.trim().length;
  if (descLen < 1 || descLen > DESCRIPTION_MAX) {
    return `description must be 1..${DESCRIPTION_MAX} chars after trimming (got ${descLen}).`;
  }
  if (opts.priority !== undefined) {
    const p = opts.priority;
    if (!Number.isInteger(p) || p < PRIORITY_MIN || p > PRIORITY_MAX) {
      return `priority must be an integer ${PRIORITY_MIN}..${PRIORITY_MAX} (got ${p}).`;
    }
  }
  if (opts.area !== undefined && opts.area.trim().length > AREA_MAX) {
    return `area must be ≤${AREA_MAX} chars (got ${opts.area.trim().length}).`;
  }
  return null;
}

async function bumpDedupedTicket(
  existing: { id: string; priority: number; description: string; context: unknown; status?: string },
  opts: { priority: number; description: string; context: Record<string, unknown> },
  matchedBy: 'exact' | 'fuzzy-title' | 'mishap-class' | 'cross-source-linked' | 'infra-alert-key',
): Promise<FileFeedbackResult> {
  const prevCtx = asContextObject(existing.context);
  const occurrences = (typeof prevCtx.occurrences === 'number' ? prevCtx.occurrences : 1) + 1;
  const sighting: Record<string, unknown> = {};
  if (opts.context.sessionId) sighting.sessionId = opts.context.sessionId;
  if (opts.context.role) sighting.role = opts.context.role;
  if (opts.context.filedAt) sighting.filedAt = opts.context.filedAt;
  // Provenance (ba65163d adjudication): keep the handled/unhandled distinction
  // on sightings landing on an OPEN ticket too — the closed-ticket reopen path
  // already copies this marker, but the live-bump path used to drop it, making
  // delivered-redacted sightings indistinguishable from withholds in the trail.
  if (opts.context.deliveredRedacted === true) sighting.deliveredRedacted = true;
  // containedPreDelivery (ticket aac649ba): same provenance rule for
  // pre-delivery replacement strikes — contained, never a reopen trigger.
  if (opts.context.containedPreDelivery === true) sighting.containedPreDelivery = true;
  // deliveredAnnotated (ticket 336f3d38): the W1-4 annotated delivery is its
  // own provenance class — the content DID reach the thread (named by the
  // trailing annotation). The closed-ticket reopen path copies this marker;
  // the live-bump path must too, or an annotated sighting on an OPEN ticket
  // is indistinguishable from an uncontained one in the trail.
  if (opts.context.deliveredAnnotated === true) sighting.deliveredAnnotated = true;
  // Subject classification (owner 2026-09-04): keep each sighting's
  // about/digbyEvidence in the trail so triage can audit WHY every repeat
  // filer judged the issue Digby's — the ticket-level context keeps only the
  // first filing's classification.
  if (opts.context.about) sighting.about = opts.context.about;
  if (opts.context.digbyEvidence) sighting.digbyEvidence = opts.context.digbyEvidence;
  const prevSightings = Array.isArray(prevCtx.sightings) ? prevCtx.sightings : [];
  const sightings = [...prevSightings, sighting].slice(-SIGHTINGS_KEPT);
  // Recurrence escalation (2026-08-31 self-fix-loop hardening): a sighting on
  // an IN_PROGRESS ticket means the dispatched fix did NOT hold — the ticket
  // climbs the re-dispatch queue (+1 per sighting, capped) instead of sitting
  // at the flat max() that kept every recurring verifier ticket at priority 3
  // forever. (The dispatch-staleness clock it waits on is bump-proof since
  // the same fix — ticket-dispatch context.dispatchedAt.)
  const escalated = existing.status === 'in_progress'
    ? Math.min(PRIORITY_MAX, Math.max(existing.priority, opts.priority) + 1)
    : Math.max(existing.priority, opts.priority);
  const updated = await prisma.userFeatureRequest.update({
    where: { id: existing.id },
    data: {
      priority: escalated,
      // (ticket 300802aa) evict oldest evidence at the cap — never discard the
      // sighting being filed (the pre-fix fallback kept the OLD text, so the
      // newest evidence was lost while occurrences kept counting).
      description: fitBumpedDescription(existing.description, `${occurrences} ---\n${opts.description}`),
      context: { ...prevCtx, occurrences, sightings, lastSeen: new Date().toISOString() } as Prisma.InputJsonValue,
    },
  });
  logger.info(`feedback: deduped agent ticket ${existing.id} (occurrences=${occurrences}, match=${matchedBy})`);
  return { deduped: true, ticket: updated };
}

/**
 * The DB-side prefilter key for a dedup scan (ticket 586ebe71): the LONGEST
 * token of a NORMALIZED title (or class key). Every token of
 * `normalizeFeedbackTitle(t)` is a maximal [a-z0-9] run of `t.toLowerCase()`
 * (normalization only replaces non-alphanumerics with spaces — it never
 * deletes or rewrites them), so `title CONTAINS <token>` case-insensitively
 * matches EVERY title whose normalized form contains that token: the DB
 * predicate is a provable SUPERSET of any normalized-equality or
 * normalized-prefix match, and the in-memory matchers stay the sole dedup
 * authority — no match can be lost, only non-candidates skipped. Filtering on
 * the longest token (max selectivity) keeps each page as cheap as the old
 * single query. A raw `WHERE title = <normalized>` (the ticket's sketched
 * shape) would NOT be sound: titles are stored RAW and `log-signal: foo` ≠
 * `log signal foo` byte-wise — that shape silently kills dedup for every
 * punctuation-bearing title, including the log-signal-sweep rows this fix
 * protects. Exported for tests.
 */
export function dedupPrefilterToken(normTitle: string): string {
  return normTitle.split(' ').reduce((longest, tok) => (tok.length > longest.length ? tok : longest), '');
}

/** A full userFeatureRequest row as the dedup scans read it (no select). */
type DedupScanRow = {
  id: string;
  userId: string | null;
  type: string;
  title: string;
  description: string;
  priority: number;
  status: string;
  adminNote: string | null;
  source: string;
  context: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Find the first dedup candidate with NO row-count window (ticket 586ebe71):
 * the old `take: 200` newest-first scans let a STANDING ticket fall out of the
 * scan once 200+ newer agent rows existed, so its next recurrence filed a
 * duplicate row — eroding the "one durable row per standing class" property
 * (load-bearing for log-signal-sweep) at ~60-90 days of volume. Pages of
 * DEDUP_SCAN_PAGE rows scroll newest-first on a (orderField, id) cursor — the
 * id tiebreaker makes the order total so the cursor can never skip or repeat
 * a row under the createdAt/updatedAt collisions bulk filings produce — until
 * the window is exhausted; each page is narrowed DB-side by the prefilter
 * token. The `match` predicate over the streamed rows is the SAME authority
 * the old in-memory `.find()` was, evaluated in the SAME newest-first order,
 * so which row matches (and which match wins) is unchanged — only the window
 * is now the full 90 days. Throws propagate to the caller's existing
 * fail-open handling (adjudicated pass catches; the exact/reopen passes
 * surface to the filer exactly as the old single query did).
 */
export async function findDedupCandidate<T extends { id: string }>(args: {
  where: Record<string, unknown>;
  orderBy: 'createdAt' | 'updatedAt';
  token: string;
  match: (row: T) => boolean;
  select?: Record<string, boolean>;
}): Promise<T | null> {
  const { where, orderBy, token, match, select } = args;
  let cursor: { orderValue: Date; id: string } | null = null;
  for (let page = 0; page < DEDUP_SCAN_MAX_PAGES; page++) {
    const pageRows = await prisma.userFeatureRequest.findMany({
      where: {
        ...where,
        ...(token ? { AND: [{ title: { contains: token, mode: 'insensitive' as const } }] } : {}),
        ...(cursor ? {
          OR: [
            { [orderBy]: { lt: cursor.orderValue } },
            { [orderBy]: cursor.orderValue, id: { lt: cursor.id } },
          ],
        } : {}),
      },
      orderBy: [{ [orderBy]: 'desc' }, { id: 'desc' }],
      take: DEDUP_SCAN_PAGE,
      ...(select ? { select } : {}),
    }) as unknown as T[];
    if (!Array.isArray(pageRows) || pageRows.length === 0) return null;
    for (const row of pageRows) {
      if (match(row)) return row;
    }
    if (pageRows.length < DEDUP_SCAN_PAGE) return null;
    const last = pageRows[pageRows.length - 1] as Record<string, unknown>;
    const lastOrder = last?.[orderBy];
    cursor = {
      orderValue: lastOrder instanceof Date ? lastOrder : new Date(String(lastOrder)),
      id: String(last?.id ?? ''),
    };
  }
  logger.warn(`feedback: dedup scan hit the ${DEDUP_SCAN_MAX_PAGES}-page deadman switch (token="${token.slice(0, 40)}") — the oldest candidates in the 90-day window were not reached`);
  return null;
}

/**
 * Would the live exact-title dedup pass BUMP for this filing? (ticket
 * 586ebe71) The log-signal-sweep daily-cap peek must answer with the REAL
 * pass's scan shape — a peek that scans a different window than the pass it
 * models drifts under volume exactly like the erosion this ticket fixes (at
 * cap it would defer a bump the real pass would have made, pausing recurrence
 * evidence on a standing class). Runs the same unbounded prefiltered scan +
 * matcher as fileFeedbackTicket's exact pass, read-only.
 */
export async function wouldExactTitleDedupBump(args: { title: string; type: string }): Promise<boolean> {
  const norm = normalizeFeedbackTitle(args.title);
  if (!norm) return false;
  const dedupSince = new Date(Date.now() - DEDUP_WINDOW_MS);
  const row = await findDedupCandidate<DedupScanRow>({
    where: { type: args.type, source: 'agent', status: { in: [...OPEN_TICKET_STATUSES] }, createdAt: { gte: dedupSince } },
    orderBy: 'createdAt',
    token: dedupPrefilterToken(norm),
    match: (c) => normalizeFeedbackTitle(c.title) === norm,
  });
  return row !== null;
}

/** Ticket types a missing acceptance metric is flagged on (platform-tools file_feedback's FIX_CLASS_TYPES). */
const METRIC_FIX_CLASS_TYPES = ['bug_report', 'mishap', 'enhancement'];

/**
 * ACCEPTANCE-METRIC-BASELINE (2026-10-20) — the FILING half of the baseline
 * gate (ticket-metric.ts measureAcceptanceBaseline). A metric that already
 * PASSES over its pre-fix window ([now − windowHours, now]) can never tell a
 * fixed system from a broken one, so it is NOT stored: the ticket still files
 * (never refused — fail toward delivery), the metric moves to
 * context.acceptanceMetricVacuous with its measured baseline, and a fix-class
 * ticket is flagged acceptanceMetricMissing exactly like one filed without a
 * metric (the file_feedback result tells the filer). A metric the gate could
 * not measure (DB error) is kept — the gate never drops what it cannot judge.
 * Mutates the filing's context COPY. Never throws. Exported for tests. Kill
 * switch ACCEPTANCE_BASELINE_GATE_DISABLED=1.
 */
export async function applyAcceptanceBaselineGate(context: Record<string, unknown>, type: string, now: Date = new Date()): Promise<void> {
  try {
    if (acceptanceBaselineGateDisabled()) return;
    const metric = readAcceptanceMetric(context);
    if (!metric) {
      // An auto-filer's metric that does not validate is never stored half-
      // usable (the verifier could not read it): drop it, flag the ticket.
      if (context.acceptanceMetric !== undefined && context.acceptanceMetricSource !== undefined) {
        delete context.acceptanceMetric;
        delete context.acceptanceMetricSource;
        if (METRIC_FIX_CLASS_TYPES.includes(type)) context.acceptanceMetricMissing = true;
      }
      return;
    }
    // A LIVE count: the pre-fix window ends now and is counted now (the
    // filing stamp the verifier trusts first — review 2026-10-20).
    const b = await measureAcceptanceBaseline(metric, now, now);
    const source = typeof context.acceptanceMetricSource === 'string' ? context.acceptanceMetricSource : 'filer';
    const stamp = { baseline: b.baseline ?? null, measurable: b.measurable, vacuous: b.vacuous, windowStart: b.windowStart, windowEnd: b.windowEnd, at: now.toISOString() };
    if (b.vacuous) {
      delete context.acceptanceMetric;
      delete context.acceptanceMetricSource;
      context.acceptanceMetricVacuous = { metric, source, ...stamp, detail: b.detail.slice(0, 200) };
      if (METRIC_FIX_CLASS_TYPES.includes(type)) context.acceptanceMetricMissing = true;
    } else {
      context.acceptanceMetricBaseline = stamp;
    }
    recordLoopMetric({
      kind: 'acceptance_metric_baseline',
      sessionId: typeof context.sessionId === 'string' ? context.sessionId : undefined,
      value: b.baseline,
      meta: { phase: 'filing', probe: metric.probe, operator: metric.operator, target: metric.target, baseline: b.baseline ?? null, measurable: b.measurable, vacuous: b.vacuous, source },
    });
  } catch { /* the gate never blocks a filing */ }
}

/**
 * File an agent-sourced feedback ticket. Validates, dedups against open
 * tickets, enforces the per-session + global rate caps, then creates the row.
 * Never throws for expected refusals — check `'error' in result`.
 */
export async function fileFeedbackTicket(opts: FileFeedbackOpts): Promise<FileFeedbackResult> {
  // Screenshot hygiene (e87aee19): the file_feedback tool schema carries no
  // image field, but an agent can still QUOTE a packed ---IMAGES--- section
  // into the description (e.g. when re-filing a user ticket). Strip the base64
  // blobs FIRST — before validation (a blob would blow the 8000-char cap) and
  // before any dedup comparison/append (base64 must never bake into a stored
  // row). The decoded bytes are staged to disk once the TARGET ticket id is
  // known (the dedup-hit row's id, or the freshly created row's).
  const packed = splitPackedDescription(opts.description);
  const optsForFiling = packed.dataUrls.length ? { ...opts, description: packed.text } : opts;

  const invalid = validateFileInput(optsForFiling);
  if (invalid) return { error: 'invalid', message: invalid };

  const type = optsForFiling.type as FeedbackType;
  // 79cc46ee: an over-length title is SHORTENED, never rejected — word-boundary
  // cut to ≤139 chars + '…' (shortenFilingTitle), the FULL original prepended
  // to the description and stamped on context. Every stored row (create /
  // queued / linked-duplicate) carries the same truncated title, so the dedup
  // passes key on it deterministically — a repeat of the same long title
  // converges on one row exactly like a short one.
  const short = shortenFilingTitle(optsForFiling.title);
  const title = short.title;
  const bodyText = optsForFiling.description.trim();
  let description = bodyText;
  const priority = optsForFiling.priority ?? 0;
  const area = optsForFiling.area?.trim() || undefined;
  // A COPY (audit 2026-10-08 W5-1b): the filing stamps keys on it (area, subjectContentWithheld) — never on the caller's object.
  const context = { ...asContextObject(optsForFiling.context) };
  if (area) context.area = area;
  if (short.shortened) {
    // Lossless trail even when the body is at the description cap (the prefix
    // is skipped there — the full title still lives on context.originalTitle).
    context.originalTitle = short.originalTitle;
    const prefix = `Full title: ${short.originalTitle}\n\n`;
    if (bodyText.length + prefix.length <= DESCRIPTION_MAX) description = `${prefix}${bodyText}`;
  }

  // Harness tickets about ANOTHER account's chat (audit 2026-10-08 W5-1b — the
  // 7cabb0cc incident: an external account's chat excerpt was stored verbatim,
  // listed in that user's own Feedback tab, briefed to a framework lane and
  // committed as a test fixture). A detector-stamped filing (verifier / class)
  // whose subject account is not an admin stores a SHAPE-ONLY description —
  // the defect, the detector and the ids, never chat text. Kill switch
  // FEEDBACK_HARNESS_SUBJECT_REDACT_DISABLED=1.
  let subjectContentWithheld = false;
  if (opts.userId && isHarnessTicketContext(context) && !harnessSubjectRedactDisabled()) {
    const ownerSide = await isAdminUser(opts.userId).catch(() => false);
    if (!ownerSide) {
      description = shapeOnlyDescription({ title, description, context, shape: opts.shapeDescription ?? null });
      context.subjectContentWithheld = true;
      subjectContentWithheld = true;
      try {
        recordLoopMetric({
          kind: 'harness_ticket_subject_redacted',
          sessionId: typeof context.sessionId === 'string' ? context.sessionId : undefined,
          meta: { detector: String(context.verifier ?? context.class ?? ''), type, shaped: !!opts.shapeDescription },
        });
      } catch { /* telemetry never blocks */ }
    }
  }

  // SHARED-PROJECT-DISPATCH (2026-10-20; feedback/held-ticket-escalation.ts):
  // an agent-filed about=digby_platform ticket from a PROJECT-SUPERVISOR seat
  // of a write member (editor / admin) of a project the ticket-lane owner
  // OWNS, filed on a MACHINE turn from that project's chat, on an account the
  // dispatcher would hold (not the owner, not an admin) is AUTO-APPROVED for a
  // ticket lane — the shared-project defect class a held ticket used to
  // strand (ticket 22d667e7 sat held from 10-18) — carrying the defect SHAPE
  // only: the stored description (and any dedup sighting) is shape-only,
  // never the filer's free text. Review fix: any other account's supervisor
  // filing (every signup gets a Fleet Supervisor) stays HELD and is escalated
  // to the owner's card. The approval stamps ride only a NEW row (a dedup
  // bump records a shape-only sighting on the existing row and leaves its
  // hold to the held-ticket card). Fail-closed: any lookup error leaves the
  // filing as before (held, then escalated). Kill switch
  // HELD_PLATFORM_TICKET_AUTOAPPROVE_DISABLED=1.
  let autoApprovedSeat: 'project_supervisor' | 'fleet_supervisor' | null = null;
  let autoApprovedVia: { projectId: string; memberRole: string } | null = null;
  if (opts.filerSeat === 'project_supervisor' && opts.userId && opts.filerMachineTurn === true && opts.filerProjectId
    && !subjectContentWithheld && context.about === 'digby_platform') {
    try {
      const hte = await import('./held-ticket-escalation');
      if (!hte.heldPlatformTicketAutoapproveDisabled()) {
        const { resolveTicketOwnerUserId } = await import('./ticket-dispatch.service');
        const filerProjectId = String(opts.filerProjectId);
        const [ownerUserId, filer, project, membership] = await Promise.all([
          resolveTicketOwnerUserId(),
          prisma.user.findUnique({ where: { id: opts.userId }, select: { role: true } }).catch(() => null),
          prisma.crossModelProject.findUnique({ where: { id: filerProjectId }, select: { userId: true } }).catch(() => null),
          prisma.projectMember.findUnique({ where: { projectId_userId: { projectId: filerProjectId, userId: opts.userId } }, select: { role: true } }).catch(() => null),
        ]);
        if (hte.shouldAutoApprovePlatformTicket({
          about: context.about, filerSeat: opts.filerSeat, filerUserId: opts.userId, filerRole: filer?.role ?? null, ownerUserId, autoDispatch: context.autoDispatch,
          filerMachineTurn: opts.filerMachineTurn,
          filerProject: project ? { ownerUserId: project.userId ?? null, filerRole: membership?.role ?? null } : null,
        })) {
          const { shapeOnlyDescription, SUPERVISOR_SHAPE_ONLY_HEADER } = await import('./harness-ticket');
          description = shapeOnlyDescription({
            title, description, context,
            detector: 'project supervisor seat (write member of the owner\'s project)',
            header: SUPERVISOR_SHAPE_ONLY_HEADER,
            shape: hte.supervisorPlatformShapeLine(opts.filerSeat, context),
          });
          for (const k of ['digbyEvidence', 'originalTitle']) delete context[k];
          context.subjectContentWithheld = true;
          subjectContentWithheld = true;
          autoApprovedSeat = opts.filerSeat;
          autoApprovedVia = { projectId: filerProjectId, memberRole: String(membership?.role ?? '') };
        }
      }
    } catch (err: any) {
      logger.warn(`feedback: supervisor platform auto-approval check failed (${err?.message ?? err}) — filed as before (held for an admin)`);
    }
  }

  /**
   * e87aee19: the description a dedup append should carry — the stripped text
   * plus `[screenshot N: …]` reference lines, the blobs written under the
   * EXISTING ticket's dir. A no-op (identity) when nothing was packed.
   */
  const descriptionForBump = async (existingTicketId: string): Promise<string> => {
    if (!packed.dataUrls.length || subjectContentWithheld) return description;
    const extraction = await extractFeedbackImages(opts.description, existingTicketId);
    return extraction.description.trim();
  };

  // ── Dedup: same type, still open, same normalized title, last 90 days →
  //    bump the EXISTING ticket (priority = max, occurrences + 1, sighting
  //    evidence, lastSeen). Candidates are scoped to source='agent': an agent
  //    filing must NEVER mutate a user-filed row (no agent occurrences/sightings
  //    written onto user-visible tickets, no priority bumps) — it files its own
  //    ticket instead. The scan is UNBOUNDED over the 90-day window (586ebe71):
  //    the prefilter narrows each page, the in-memory matcher stays the sole
  //    authority (findDedupCandidate). The mishap-class pass shares the scan
  //    (same candidates by construction: both matchers run over the same
  //    type/source/status/window set, newest-first).
  const dedupSince = new Date(Date.now() - DEDUP_WINDOW_MS);
  const norm = normalizeFeedbackTitle(title);
  const existing = await findDedupCandidate<DedupScanRow>({
    where: { type, source: 'agent', status: { in: [...OPEN_TICKET_STATUSES] }, createdAt: { gte: dedupSince } },
    orderBy: 'createdAt',
    token: dedupPrefilterToken(norm),
    match: (c) => normalizeFeedbackTitle(c.title) === norm,
  });
  if (existing) return bumpDedupedTicket(existing, { priority, description: await descriptionForBump(existing.id), context }, 'exact');

  // ── Infra-alert STABLE-KEY dedup (ticket fffacaee, 2026-10-20) ──
  // A deploy-failure / CI-red alert names a machine-stable identity (the
  // failed GitHub Actions run id + repo, or the failing sha) that survives
  // any wording — and infra-watch fans ONE alert out to up to 10 admin
  // supervisor chats, so two independently-worded filings for the same
  // alert are the DESIGNED shape of this class. Every text pass above
  // missed exactly that (2026-10-20: run 39441731823 → b612be26 +
  // 9e0c9f5a ~50s apart, two lanes, a manual de-conflict). The key is
  // extracted from the filing's own shape (extractInfraAlertKey — a
  // "Deploy run <id>"-led title corroborated by the raw run URL in the
  // body, or a CI-red-shaped title with the failing sha) and matched
  // against OPEN agent tickets carrying the same key — stamped on context
  // when filed after this fix, re-derived from the row's own alert shape
  // for pre-fix rows. A match bumps THAT ticket (occurrences/sighting,
  // same shape as the exact pass) and stamps the key on it, so the
  // dispatcher's dispatch-side guard reads a stable field too. Runs BEFORE
  // the mishap-class pass but AFTER the exact pass (an exact title match
  // keeps its existing semantics). Kill switch
  // FEEDBACK_INFRA_ALERT_DEDUP_DISABLED=1.
  if (!infraAlertDedupDisabled()) {
    const alertKey = extractInfraAlertKey(title, description);
    if (alertKey) {
      const keyStr = infraAlertKeyString(alertKey);
      context[INFRA_ALERT_KEY_FIELD] = keyStr;
      // Candidates are OPEN agent rows of any type (the incident pair was
      // type 'enhancement'; a future alert could file 'bug_report' — the
      // KEY, not the type, is the identity here), newest-first; the match
      // consults the stamped context key first and falls back to
      // re-deriving the key from the row's own alert shape (pre-fix rows
      // like 9e0c9f5a carry no stamp).
      // Prefilter token = the key's id (run id / sha): an alert-shaped filing's
      // TITLE carries it by construction ("Deploy run <id>…" / "[CI FAILED —
      // owner/repo@sha]…"), so the DB prefilter admits every candidate the
      // matcher can match. An agent-variant CI-red title with the sha only in
      // the body under-folds to the pre-fix behavior (a new row) — the
      // DISPATCH-side guard, which scans in-memory, is the hard backstop.
      const alertMatch = await findDedupCandidate<DedupScanRow>({
        where: { source: 'agent', status: { in: [...OPEN_TICKET_STATUSES] }, createdAt: { gte: dedupSince } },
        orderBy: 'createdAt',
        // Prefilter token: the key's id (run id / sha) for deploy/CI alerts —
        // an alert-shaped filing's TITLE carries it by construction ("Deploy
        // run <id>…" / "[CI FAILED — owner/repo@sha]…"), so the DB prefilter
        // admits every candidate the matcher can match. The BACKUP class
        // (253636d6) has no id in its title — its titles carry the class word
        // 'backup' by the title-gate construction instead. An agent-variant
        // CI-red title with the sha only in the body under-folds to the
        // pre-fix behavior (a new row) — the DISPATCH-side guard, which
        // scans in-memory, is the hard backstop.
        token: alertKey.kind === 'backup' ? 'backup' : alertKey.id,
        match: (c) => infraAlertKeysEqual(c, alertKey),
      });
      if (alertMatch) {
        // The bump merges the fresh sighting; also stamp the key on the
        // EXISTING row so later drains and filings read a stable field
        // (bumpDedupedTicket preserves prior context, so pass it through).
        const prevAlertCtx = asContextObject(alertMatch.context);
        if (!infraAlertKeyOfContext(prevAlertCtx)) {
          await prisma.userFeatureRequest.update({
            where: { id: alertMatch.id },
            data: { context: { ...prevAlertCtx, [INFRA_ALERT_KEY_FIELD]: keyStr } as Prisma.InputJsonValue },
          }).catch(() => undefined); // best-effort stamp — the bump below is the load-bearing write
        }
        return bumpDedupedTicket(
          { ...alertMatch, context: { ...prevAlertCtx, [INFRA_ALERT_KEY_FIELD]: keyStr } },
          { priority, description: await descriptionForBump(alertMatch.id), context },
          'infra-alert-key',
        );
      }
    }
  }


  // ── Class-keyed MISHAP dedup (audit #9c): mishap filings whose normalized
  //    titles share the first MISHAP_CLASS_KEY_LEN chars are ONE failure class
  //    (the varying tail is session ids/counts) — bump the existing open-ish
  //    agent mishap instead of duplicating. Same candidate set as the exact
  //    pass (type='mishap', source='agent', open/in_progress/queued, 90d), so
  //    user-filed rows are never touched. 586ebe71: its own unbounded scan —
  //    the prefilter token is derived from the CLASS KEY (every token of the
  //    key is a substring of any class-matching title, so the superset proof
  //    holds for prefix matches exactly as it does for exact ones), and the
  //    exact pass's match is re-checked first so the row the exact pass would
  //    have bumped still wins.
  const classKey = norm.slice(0, MISHAP_CLASS_KEY_LEN);
  if (type === 'mishap' && classKey) {
    const classMatch = await findDedupCandidate<DedupScanRow>({
      where: { type, source: 'agent', status: { in: [...OPEN_TICKET_STATUSES] }, createdAt: { gte: dedupSince } },
      orderBy: 'createdAt',
      token: dedupPrefilterToken(classKey),
      match: (c) => normalizeFeedbackTitle(c.title) !== norm // the exact pass already ruled this row out
        && normalizeFeedbackTitle(c.title).slice(0, MISHAP_CLASS_KEY_LEN) === classKey,
    });
    if (classMatch) {
      return bumpDedupedTicket(classMatch, { priority, description: await descriptionForBump(classMatch.id), context }, 'mishap-class');
    }
  }


  // ── Reopen-on-recurrence (2026-08-31 self-fix-loop hardening): the live
  //    passes above only see open/in_progress rows, so a CLOSED ticket whose
  //    defect recurs used to file a brand-new row with occurrences=1 — every
  //    same-class ticket looked like a first occurrence and the recurrence
  //    signal died at closure (the phantom-clock class produced a dozen
  //    "one-off" tickets in a week; each closure got a symptom-level regex
  //    patch while the root cause shipped on). An exact-title match against a
  //    recently-CLOSED agent ticket REOPENS it instead: the sighting trail
  //    and occurrence count survive, the row re-enters the drain queue (the
  //    30d dispatch claim is released first), and the lane is told its fix
  //    did not hold — fix the CLASS, not the instance. User-filed rows are
  //    never candidates (the same agent-immutability rule as the live passes).
  //    'done' plus every legacy closed spelling (ticket-status.ts, audit T8):
  //    a 'resolved' row's recurrence used to file a fresh row.
  //    586ebe71: unbounded over the 90-day window (findDedupCandidate).
  // A cross-source LINKED DUPLICATE row (context.duplicateOf, audit T2) is a
  // record of a user ticket, never a closed fix — it is skipped here.
  const closedMatch = await findDedupCandidate<DedupScanRow>({
    where: { type, source: 'agent', status: { in: closedTicketStatusesForQuery() }, createdAt: { gte: dedupSince } },
    orderBy: 'updatedAt',
    token: dedupPrefilterToken(norm),
    match: (c) => normalizeFeedbackTitle(c.title) === norm && !asContextObject(c.context).duplicateOf,
  });
  // ── ADJUDICATED-CLASS SHORT-CIRCUIT (ticket be06c812, the log-signal
  //    family lane, 2026-10-18): the exact pass above scopes to OPEN rows and
  //    THIS pass matches CLOSED ones — a ticket closed as an adjudicated
  //    standing class (FS-accepted baseline, designed observability) used to
  //    fall straight through to the reopen below: the sweep's next weekly
  //    same-type filing flipped it back to open, escalated priority, released
  //    the 30d dispatch claim and re-fired drainOpenTicketsToLane — a fresh
  //    lane re-dispatched to re-adjudicate a class a lane had ALREADY
  //    adjudicated (be06c812 "invalid signature", FS-accepted baseline
  //    f132-close, re-open bars 13,149/24h or a third spike IP; the family
  //    lane this fix ships from). An adjudicated row is not a "fix did not
  //    hold" recurrence — the recorded verdict says the class is accepted
  //    behavior. Counter-bump in the adjudicated absorption shape (same
  //    merge the cross-type pass at the bottom performs): occurrences +
  //    sighting + description trail accrue, duplicateSuppressedBy marker, NO
  //    status flip, NO priority escalation, NO dispatch release. The verdict
  //    must be RECORDED on the row (context.adjudicatedClass or the
  //    adminNote wording) — an unmarked closed row keeps the reopen behavior
  //    (fail-safe: adjudication is a deliberate act, never a default).
  //    Honors the SAME kill switch as the cross-type pass so the whole
  //    adjudication-dedupe feature reverts as one unit.
  //    RE-OPEN BAR (adversarial review of this very fix, B1): an adjudication
  //    is a CONDITIONAL acceptance — the verdict records when the class must
  //    be re-examined ("re-open bar: 24h count > 13149" in the adminNote —
  //    the f132 baseline's rate arm). The sweep's filing context carries
  //    `count` (rows/24h); a sighting whose count CROSSES a recorded bar is
  //    the verdict's own re-open condition firing — it falls through to the
  //    gates below (handled-marker / fix-live / saturation / reopen) instead
  //    of being absorbed, and emits a distinct breach metric so the crossing
  //    is visible even when a later gate still counter-bumps. No bar recorded
  //    (or no numeric count on the sighting — non-sweep filers) → absorb.
  //    Non-numeric bar arms (the f132 third-spike-IP condition) stay with the
  //    operators' own watches, which escalate through the normal path.
  if (closedMatch && isAdjudicatedTicketRow(closedMatch) && process.env.FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED !== '1') {
    const bar = parseAdjudicatedReopenBar(closedMatch);
    const sightingCount = typeof context.count === 'number' ? context.count : null;
    if (bar !== null && sightingCount !== null && sightingCount > bar) {
      logger.info(`feedback: adjudicated closed ticket ${closedMatch.id} re-open bar BREACHED (24h count ${sightingCount} > bar ${bar}) — the recorded verdict's own re-open condition fired; legacy recurrence gates apply`);
      // B4 (cross-family review): the legacy reopen below overwrites adminNote,
      // destroying a PROSE-only bar — the row would re-close later with no bar
      // and absorb every future sighting silently. Stamp the parsed bar
      // structurally onto the row's context NOW: every fall-through gate write
      // (handled-marker / fix-live / saturation / reopen) spreads prevCtx, so
      // whichever path handles the breach persists the bar.
      if (typeof asContextObject(closedMatch.context).reopenBar !== 'number') {
        closedMatch.context = { ...asContextObject(closedMatch.context), reopenBar: bar } as Prisma.InputJsonValue;
      }
      try {
        recordLoopMetric({
          kind: 'feedback_adjudicated_bar_breach',
          sessionId: typeof context.sessionId === 'string' ? context.sessionId : undefined,
          value: 1,
          meta: { ticketId: closedMatch.id, count: sightingCount, bar, filedType: type },
        });
      } catch { /* telemetry never blocks */ }
    } else {
    const prevCtx = asContextObject(closedMatch.context);
    const occurrences = (typeof prevCtx.occurrences === 'number' ? prevCtx.occurrences : 1) + 1;
    const sighting: Record<string, unknown> = {};
    if (context.sessionId) sighting.sessionId = context.sessionId;
    if (context.role) sighting.role = context.role;
    if (context.filedAt) sighting.filedAt = context.filedAt;
    if (context.about) sighting.about = context.about;
    // Provenance markers (adversarial review B2): the legacy branch below
    // deliberately copies these (ba65163d made dropping them a scored defect
    // — a delivered-redacted sighting must stay distinguishable from a
    // withhold in the trail). The absorption sighting keeps the same shape.
    if (context.deliveredRedacted === true) sighting.deliveredRedacted = true;
    if (context.containedPreDelivery === true) sighting.containedPreDelivery = true;
    // (ticket 336f3d38) The annotated delivery is its own provenance class —
    // copy it here too, same as the closed-ticket and live-bump writers.
    if (context.deliveredAnnotated === true) sighting.deliveredAnnotated = true;
    // The 24h volume the re-open bars are defined on — occurrences advances
    // only per FILING (the sweep files once per fingerprint per ISO week), so
    // the counter alone can never show a surge between weekly filings.
    if (sightingCount !== null) sighting.count = sightingCount;
    sighting.duplicateSuppressedBy = 'adjudicated-class';
    const prevSightings = Array.isArray(prevCtx.sightings) ? prevCtx.sightings : [];
    const sightings = [...prevSightings, sighting].slice(-SIGHTINGS_KEPT);
    const bumpDescription = await descriptionForBump(closedMatch.id);
    const countTrail = sightingCount !== null ? `; 24h count=${sightingCount}${bar !== null ? ` (re-open bar ${bar})` : ''}` : '';
    const bumpedAdj = await prisma.userFeatureRequest.update({
      where: { id: closedMatch.id },
      data: {
        description: fitBumpedDescription(closedMatch.description, `${occurrences} (adjudicated class — standing class sighting, NOT a reopen; suppressed, no dispatch${countTrail}) ---\n${bumpDescription}`),
        // B2/B4 (cross-family review): the absorption is itself the missing
        // WRITER for the structural forms — a row that just absorbed a
        // sighting BY its adjudication is by definition adjudicated, and the
        // bar it enforced is the bar to keep. Stamping both here means (a) the
        // predicate no longer depends on prose surviving future adminNote
        // rewrites, and (b) a later breach-triggered reopen keeps its bar (the
        // reopen write below overwrites adminNote but spreads prevCtx).
        context: {
          ...prevCtx,
          ...(prevCtx.adjudicatedClass === true ? {} : { adjudicatedClass: true }),
          ...(bar !== null && typeof prevCtx.reopenBar !== 'number' ? { reopenBar: bar } : {}),
          occurrences,
          sightings,
          lastSeen: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    logger.info(`feedback: adjudicated closed ticket ${closedMatch.id} counter-bumped WITHOUT reopen (same-type sighting, occurrences=${occurrences}${sightingCount !== null ? `, 24h count=${sightingCount}` : ''}) — the standing class stays closed`);
    try {
      recordLoopMetric({
        kind: 'feedback_adjudicated_class_dedupe',
        sessionId: typeof context.sessionId === 'string' ? context.sessionId : undefined,
        value: 1,
        meta: { ticketId: closedMatch.id, occurrences, filedType: type, ticketType: closedMatch.type, via: 'reopen-pass-short-circuit', ...(sightingCount !== null ? { count: sightingCount } : {}), ...(bar !== null ? { bar } : {}) },
      });
    } catch { /* telemetry never blocks */ }
    return { deduped: true, ticket: bumpedAdj };
    }
  }
  if (closedMatch) {
    const prevCtx = asContextObject(closedMatch.context);
    const occurrences = (typeof prevCtx.occurrences === 'number' ? prevCtx.occurrences : 1) + 1;
    const sighting: Record<string, unknown> = {};
    if (context.sessionId) sighting.sessionId = context.sessionId;
    if (context.role) sighting.role = context.role;
    if (context.filedAt) sighting.filedAt = context.filedAt;
    if (context.deliveredRedacted === true) sighting.deliveredRedacted = true;
    if (context.containedPreDelivery === true) sighting.containedPreDelivery = true;
    if (context.deliveredAnnotated === true) sighting.deliveredAnnotated = true;
    const prevSightings = Array.isArray(prevCtx.sightings) ? prevCtx.sightings : [];
    const sightings = [...prevSightings, sighting].slice(-SIGHTINGS_KEPT);
    const bumpDescription = await descriptionForBump(closedMatch.id);
    // Handled-sighting suppression (5e1ca207 churn loop): a strip+mark
    // (delivered-redacted) strike means the guard DELIVERED the note with the
    // convicted line(s) elided — the mitigation worked, so this is NOT a
    // "fix did not hold" recurrence. Counter-bump only (occurrences/sightings/
    // lastSeen + description trail): no status flip, no priority escalation,
    // no reopen adminNote, no dispatch release. Unmarked sightings (full
    // withholds — content was destroyed — and post-delivery catches, where the
    // phantom DID reach the thread) still reopen below: lost/escaped content
    // IS a genuine recurrence signal (occ 23/24 were withholds and re-opened
    // correctly).
    //   containedPreDelivery (ticket aac649ba — 9 sightings / 3 reopens of pure
    // churn on chat aa78e314): a guardMachineWakeFinalAnswer pre-delivery
    // strike intercepted the note before it reached the thread un-checked.
    // Same containment class as strip+mark: the detector kept working and the
    // model's recidivism is a known, contained property — counter-bump, never
    // reopen. Before this marker, full-replacement strikes filed UNMARKED
    // sightings and took the reopen path once per wake — each reopen
    // re-dispatched the engineering lane (5 dispatches, zero escapes) and the
    // dispatch system overwrote the adjudication adminNote each time.
    //   deliveredAnnotated (ticket 336f3d38): under the W1-4 default the
    // pre-delivery strike delivers the note AS WRITTEN with a trailing
    // observe-only annotation — the struck content DID reach the thread. The
    // suppression decision is unchanged (the detector worked and the in-thread
    // correction runs — the containment is the annotation + correction + this
    // ticket, not removal), but the trail prose must never claim "never
    // reached the thread" for a delivery that reached it: the incident's
    // closed-ticket trail said exactly that while the annotated note's
    // fabricated citations had reached a peer lane, which refuted them.
    //   Fail-safe: both markers are opt-in — any writer that does not set them
    // (or a stripped context) keeps the legacy reopen behavior.
    const handledWhy = context.deliveredRedacted === true
      ? 'delivered redacted — handled by strip+mark; NOT a reopen'
      : context.deliveredAnnotated === true
      ? 'pre-delivery strike — the note was delivered AS WRITTEN with an observe-only annotation (W1-4): the struck content DID reach the thread, named by the trailing annotation and the in-thread correction; NOT a reopen'
      : 'pre-delivery strike — the note was replaced before delivery, the struck content never reached the thread; NOT a reopen';
    if (context.deliveredRedacted === true || context.containedPreDelivery === true) {
      const bumpedHandled = await prisma.userFeatureRequest.update({
        where: { id: closedMatch.id },
        data: {
          description: fitBumpedDescription(closedMatch.description, `${occurrences} (${handledWhy}) ---\n${bumpDescription}`),
          context: { ...prevCtx, occurrences, sightings, lastSeen: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });
      logger.info(`feedback: done ticket ${closedMatch.id} counter-bumped WITHOUT reopen (${context.deliveredRedacted === true ? 'delivered-redacted' : 'contained-pre-delivery'} sighting, occurrences=${occurrences})`);
      return { deduped: true, ticket: bumpedHandled };
    }
    // Fix-already-live gate (ticket 208ad03d — the 5ba5f03e re-dispatch burn,
    // 2026-09-18): a sighting matching a ticket whose RECORDED fix already
    // merged AND deployed is not a "fix did not hold" recurrence — production
    // already carries the remediation, and reopening re-fires a full dispatch
    // that re-fixes live work (5ba5f03e re-opened at 21:48Z with its PR #859
    // merged at 19:48Z and its deploy green at 21:02Z). When the resolver
    // proves the fix live, counter-bump in the handled-marker shape above —
    // occurrences/sightings/lastSeen accrue, the trail records the sighting
    // with the live-fix evidence, the adminNote keeps the auto-close
    // rationale — with NO status flip, NO priority escalation, and crucially
    // NO dispatch-claim release / drain. Fail-safe: resolveTicketFixState
    // returns fixLive=true ONLY on positive merged+deploy proof (fix-state.ts),
    // and a resolver THROW is treated as fixLive=false — incomplete data never
    // suppresses a reopen.
    const fixState: TicketFixState = await resolveTicketFixState(closedMatch).catch((err: any): TicketFixState => ({
      fixLive: false,
      reason: `resolver error (fail-safe): ${String(err?.message ?? err).slice(0, 120)}`,
    }));
    if (fixState.fixLive) {
      const fixEvidence = fixState.evidence ?? {};
      const mergedProof = fixEvidence.commitSha ? `merged ${fixEvidence.commitSha}` : 'fix merged';
      const deployProof = fixEvidence.deployRunId ? `deploy ${fixEvidence.deployRunId}` : 'deploy live';
      const sightingsLive = [...prevSightings, { ...sighting, fixAlreadyLive: true }].slice(-SIGHTINGS_KEPT);
      const autoCloseNote = `[auto-close 208ad03d ${new Date().toISOString()}: sighting ${occurrences} NOT reopened — the recorded fix is already live (${fixState.reason})]`;
      const bumpedLive = await prisma.userFeatureRequest.update({
        where: { id: closedMatch.id },
        data: {
          adminNote: closedMatch.adminNote ? `${closedMatch.adminNote}\n${autoCloseNote}` : autoCloseNote,
          description: fitBumpedDescription(closedMatch.description, `${occurrences} (fix already live at sighting — ${mergedProof}, ${deployProof}; NOT a reopen) ---\n${bumpDescription}`),
          context: { ...prevCtx, occurrences, sightings: sightingsLive, lastSeen: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });
      logger.info(`feedback: done ticket ${closedMatch.id} counter-bumped WITHOUT reopen (fix already live — ${fixState.reason}; occurrences=${occurrences})`);
      return { deduped: true, ticket: bumpedLive };
    }
    logger.info(`feedback: reopen gate 208ad03d passed for done ticket ${closedMatch.id} (fix not proven live — ${fixState.reason}); legacy reopen path applies`);
    // Reopen-saturation cap (ba65163d): once a class has re-opened this ticket
    // REOPEN_SUPPRESS_AFTER times, the "fix did not hold" signal is saturated —
    // every further reopen just re-fires a dispatch that re-adjudicates the same
    // evidence (the ba65163d loop produced fabrication cascades in the
    // DISPATCHED lanes themselves: the fictional #577 lifecycle, the #594
    // merge/deploy phantom). Counter-bump instead: occurrences/sightings/
    // lastSeen keep accruing, reopenSuppressedCount records the suppression,
    // and the ticket stays done. Withhold-class only — redacted sightings
    // already counter-bump above.
    const prevReopens = typeof prevCtx.reopenCount === 'number' ? prevCtx.reopenCount : 0;
    if (prevReopens >= REOPEN_SUPPRESS_AFTER) {
      const sightingsSupp = [...prevSightings, { ...sighting, reopenSuppressed: true }].slice(-SIGHTINGS_KEPT);
      const bumpedSupp = await prisma.userFeatureRequest.update({
        where: { id: closedMatch.id },
        data: {
          description: fitBumpedDescription(closedMatch.description, `${occurrences} (withhold sighting; reopen SUPPRESSED — class saturated at ${prevReopens} reopens; counter-bump only, no dispatch release) ---\n${bumpDescription}`),
          context: {
            ...prevCtx, occurrences, sightings: sightingsSupp,
            lastSeen: new Date().toISOString(),
            reopenSuppressedCount: (typeof prevCtx.reopenSuppressedCount === 'number' ? prevCtx.reopenSuppressedCount : 0) + 1,
          } as Prisma.InputJsonValue,
        },
      });
      logger.info(`feedback: done ticket ${closedMatch.id} counter-bumped WITHOUT reopen (reopen-saturation cap ${prevReopens}>=${REOPEN_SUPPRESS_AFTER}, occurrences=${occurrences})`);
      return { deduped: true, ticket: bumpedSupp };
    }
    // TICKET-LANE ARCHIVE GAPS B2b (2026-10-21): the reopen drops the first
    // close's lane-archive stamp — kept, it made the drain skip the NEXT
    // lane's archive forever. Inline (no static ticket-dispatch import);
    // TICKET_LANE_ARCHIVE_GAPS_DISABLED=1 keeps the stamp as before.
    const { laneArchivedAt: _laneArchivedAt, laneArchivedLane: _laneArchivedLane, ...reopenCtx } = prevCtx;
    const reopenBase = killSwitchOn(process.env.TICKET_LANE_ARCHIVE_GAPS_DISABLED) ? prevCtx : reopenCtx;
    const reopened = await prisma.userFeatureRequest.update({
      where: { id: closedMatch.id },
      data: {
        status: 'open',
        priority: Math.min(PRIORITY_MAX, Math.max(closedMatch.priority, priority) + 1),
        adminNote: `Reopened automatically at ${new Date().toISOString()}: the defect recurred after closure (sighting ${occurrences}). Treat as a CLASS bug — fix the root cause, not this instance.`,
        description: fitBumpedDescription(closedMatch.description, `${occurrences} (recurrence AFTER closure — the fix did not hold) ---\n${bumpDescription}`),
        context: {
          ...reopenBase, occurrences, sightings,
          lastSeen: new Date().toISOString(),
          reopenCount: (typeof prevCtx.reopenCount === 'number' ? prevCtx.reopenCount : 0) + 1,
        } as Prisma.InputJsonValue,
      },
    });
    logger.info(`feedback: REOPENED agent ticket ${closedMatch.id} on recurrence after closure (occurrences=${occurrences}) — the fix did not hold`);
    // Release the 30d dispatch claim so the drain can re-route it, then fire
    // the drain — the same fire-and-forget dynamic-import discipline as the
    // create path below (this module's static graph stays light).
    void import('./ticket-dispatch.service')
      .then(async (m) => { await m.releaseTicketDispatchClaim(closedMatch.id); void m.drainOpenTicketsToLane(); })
      .catch(() => {});
    return { deduped: true, ticket: reopened };
  }

  // ── Secondary FUZZY dedup (tickets 167822fb/9982d063): the literal pass
  //    above let three paraphrased "Digby has no response" tickets for ONE
  //    incident pile up in 42 seconds. Candidates: agent-filed open-ish rows
  //    from the SAME session/chat in the last 24h — ANY type, because the same
  //    incident gets filed as bug_report by one agent and mishap by another —
  //    whose normalized-title word sets overlap at Jaccard ≥ 0.6. Source stays
  //    'agent': user-filed rows are never candidates, never mutated.
  const fuzzyKeys = [context.sessionId, context.chatId]
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (fuzzyKeys.length) {
    const fuzzySince = new Date(Date.now() - FUZZY_DEDUP_WINDOW_MS);
    const fuzzyCandidates = await prisma.userFeatureRequest.findMany({
      where: {
        source: 'agent',
        status: { in: [...OPEN_TICKET_STATUSES] },
        createdAt: { gte: fuzzySince },
        OR: [...new Set(fuzzyKeys)].flatMap((key) => [
          { context: { path: ['sessionId'], equals: key } },
          { context: { path: ['chatId'], equals: key } },
        ]),
      },
      orderBy: { createdAt: 'desc' },
      take: FUZZY_CANDIDATE_SCAN,
    });
    const fuzzyMatch = fuzzyCandidates.find(
      (c) => titleTokenJaccard(normalizeFeedbackTitle(c.title), norm) >= FUZZY_TITLE_JACCARD,
    );
    if (fuzzyMatch) return bumpDedupedTicket(fuzzyMatch, { priority, description: await descriptionForBump(fuzzyMatch.id), context }, 'fuzzy-title');

    // ── Same-chat INCIDENT TWIN (audit 2026-10-08 W5-2, incident-twin.ts): the
    //    L2 lead (59a4407b) and its cross-checker (9b944f30) filed ONE defect in
    //    other words 136 s apart — title Jaccard 0.21, so the pass above missed
    //    it and two fresh lanes raced into competing PRs. A filing whose TEXT
    //    overlaps an open same-chat agent ticket filed ≤ 30 min earlier is
    //    stored as a LINKED duplicate (status done, context.duplicateOf,
    //    autoDispatch:false) — recorded, never dispatched — and the original
    //    gains a `twins` back-link (no priority bump: a twin is not a
    //    recurrence). Harness filings never take part. Kill switch
    //    FEEDBACK_INCIDENT_TWIN_DEDUPE_DISABLED=1.
    //    SYSTEM filings never take part either (ticket beb1788b): the sweep's
    //    synthetic sessionId (log-signal: <fpHash>) never matches a chat
    //    session, but the shingle/anchor legs fire on shared text — the live
    //    2026-10-16 class (the run-journal P0 spec parked under a5b36dc6 via
    //    twins) matched on shared boilerplate, not defect substance.
    if (!incidentTwinDedupeDisabled() && !isSystemTicketFiling(context)) {
      const twin = findIncidentTwin(Array.isArray(fuzzyCandidates) ? fuzzyCandidates : [], { title, description, context });
      if (twin) {
        const nowIso = new Date().toISOString();
        const gapS = Math.max(0, Math.round((Date.now() - new Date(twin.candidate.createdAt as any).getTime()) / 1000));
        const linked = await prisma.userFeatureRequest.create({
          data: {
            userId: opts.userId,
            type,
            title,
            description,
            priority,
            source: 'agent',
            status: 'done',
            adminNote: `Duplicate of ticket ${twin.candidate.id} ("${String(twin.candidate.title).slice(0, 120)}"), filed from the same chat ${gapS} s earlier — the same incident (match: ${twin.score.matchedBy}; shingle ${twin.score.shingle.toFixed(2)}, ${twin.score.sharedAnchors} shared evidence anchor(s), ${twin.score.sharedIds} shared id(s)). NOT dispatched — ticket ${twin.candidate.id.slice(0, 8)}'s lane carries the work.`,
            context: { ...context, duplicateOf: twin.candidate.id, duplicateMatch: 'incident-twin', linkedAt: nowIso, autoDispatch: false } as Prisma.InputJsonValue,
          },
        });
        const prevCtx = asContextObject(twin.candidate.context);
        const twins = Array.isArray(prevCtx.twins) ? (prevCtx.twins as unknown[]).map(String) : [];
        await prisma.userFeatureRequest.update({
          where: { id: twin.candidate.id },
          data: { context: { ...prevCtx, twins: [...twins, linked.id].slice(-5) } as Prisma.InputJsonValue },
        }).catch(() => { /* the back-link is best-effort */ });
        try {
          recordLoopMetric({
            kind: 'feedback_incident_twin',
            sessionId: typeof context.sessionId === 'string' ? context.sessionId : undefined,
            meta: { ticketId: linked.id, duplicateOf: twin.candidate.id, gapS, matchedBy: twin.score.matchedBy, shingle: Number(twin.score.shingle.toFixed(3)), anchors: twin.score.sharedAnchors, sharedIds: twin.score.sharedIds, titleJaccard: Number(twin.score.titleJaccard.toFixed(3)), role: context.role ?? null },
          });
        } catch { /* telemetry never blocks */ }
        logger.info(`feedback: agent filing ${linked.id} linked as an incident twin of ${twin.candidate.id} (same chat, ${gapS}s, ${twin.score.matchedBy}) — not dispatched`);
        return { deduped: true, ticket: linked, duplicateOf: twin.candidate.id };
      }
    }
  }

  // ── Cross-source duplicate (backlog audit T2, 2026-09-28 — see the
  //    CROSS_SOURCE_* constants): the owner's OWN user-filed open ticket from
  //    the last 24 h is consulted READ-ONLY. A match files this agent capture
  //    as a LINKED DUPLICATE (status 'done', context.duplicateOf,
  //    autoDispatch:false) — recorded, never dispatched, the user row never
  //    written. A repeat capture of the same remark bumps the existing linked
  //    row (occurrences/sightings) instead of minting another; the closed-
  //    reopen scan above skips linked rows, so a linked duplicate is never
  //    mistaken for a "fix did not hold" recurrence. Runs LAST among the dedup
  //    passes (an agent twin still wins). Same-user only; an anonymous filing
  //    (no userId) skips the pass.
  //    SYSTEM filings skip the pass entirely (ticket beb1788b): the log-signal
  //    sweep files with the first admin's userId, which makes the admin's own
  //    24 h user-filed tickets candidates, and the sweep's description embeds
  //    a 600-char raw log excerpt that enlarges the containment haystack. A
  //    containment hit over the excerpt parks the fingerprint as a done +
  //    duplicateOf row under the USER ticket — recorded as "handled" but never
  //    dispatched, with the fingerprint's stable title never reaching a
  //    dispatchable row (later weeks re-file it). The row the pass WOULD have
  //    created carries the sweep's own title (not the user ticket's), so the
  //    sweep-side title-agreement guard could never catch this shape; the
  //    guard must live at the pass itself.
  if (opts.userId && !isSystemTicketFiling(context)) {
    const crossSince = new Date(Date.now() - CROSS_SOURCE_WINDOW_MS);
    const userRows = await prisma.userFeatureRequest.findMany({
      where: { source: 'user', userId: opts.userId, status: { in: [...OPEN_TICKET_STATUSES] }, createdAt: { gte: crossSince } },
      orderBy: { createdAt: 'desc' },
      take: CROSS_SOURCE_CANDIDATE_SCAN,
      select: { id: true, title: true, description: true },
    });
    const cross = findCrossSourceDuplicate(Array.isArray(userRows) ? userRows : [], { title, description });
    if (cross) {
      const linkedExisting = await prisma.userFeatureRequest.findFirst({
        where: { source: 'agent', context: { path: ['duplicateOf'], equals: cross.candidate.id } },
        orderBy: { createdAt: 'desc' },
      });
      if (linkedExisting) {
        const bumped = await bumpDedupedTicket(linkedExisting, { priority, description: await descriptionForBump(linkedExisting.id), context }, 'cross-source-linked');
        return { ...bumped, duplicateOf: cross.candidate.id };
      }
      const nowIso = new Date().toISOString();
      const linked = await prisma.userFeatureRequest.create({
        data: {
          userId: opts.userId,
          type,
          title,
          description,
          priority,
          source: 'agent',
          status: 'done',
          adminNote: `Duplicate of user ticket ${cross.candidate.id} ("${String(cross.candidate.title).slice(0, 120)}") — linked read-only at ${nowIso} (match: ${cross.matchedBy}); NOT dispatched — the user-filed ticket carries the work.`,
          context: { ...context, duplicateOf: cross.candidate.id, duplicateMatch: cross.matchedBy, linkedAt: nowIso, autoDispatch: false } as Prisma.InputJsonValue,
        },
      });
      logger.info(`feedback: agent capture ${linked.id} linked as a duplicate of USER ticket ${cross.candidate.id} (match=${cross.matchedBy}) — not dispatched`);
      return { deduped: true, ticket: linked, duplicateOf: cross.candidate.id };
    }
  }

  // ── Rate caps (agent source only — this function only ever files 'agent').
  //    A cap hit STORES the ticket as status='queued' (2026-08-31) instead of
  //    dropping it — the old behavior silently vanished user-requested
  //    filings (a rate-limited refusal lived only in one transcript's tool
  //    result, so unless the model relayed it the request was gone). The
  //    queue itself is bounded (QUEUED_CAP_*): only past the queued backlog
  //    depth does the refusal really drop. Queued rows auto-promote to 'open'
  //    via promoteQueuedFeedbackTickets as windows free.
  const sessionId = String(context.sessionId || context.chatId || 'unknown');
  const hourAgo = new Date(Date.now() - 3600_000);
  const dayAgo = new Date(Date.now() - 24 * 3600_000);

  const queueTicket = async (reason: string): Promise<FileFeedbackResult> => {
    const [queuedForSessionAll, queuedGlobalAll, familyQueuedForSession, familyQueuedGlobal] = await Promise.all([
      prisma.userFeatureRequest.count({
        where: { source: 'agent', status: 'queued', context: { path: ['sessionId'], equals: sessionId } },
      }),
      prisma.userFeatureRequest.count({ where: { source: 'agent', status: 'queued' } }),
      // TICKET-FAMILY-ROUTING (2026-10-20): family-queued members (filed
      // 'queued' for their noisy family's lane) are NOT rate-cap backlog — a
      // noisy family must never fill the cap queue and refuse other filings.
      countFamilyQueued({ sessionId }),
      countFamilyQueued({}),
    ]);
    const queuedForSession = Math.max(0, queuedForSessionAll - familyQueuedForSession);
    const queuedGlobal = Math.max(0, queuedGlobalAll - familyQueuedGlobal);
    if (queuedForSession >= QUEUED_CAP_PER_SESSION || queuedGlobal >= QUEUED_CAP_GLOBAL) {
      return {
        error: 'rate_limited',
        message: `The feedback queue is full (${reason}; queued backlog ${queuedForSession}/${QUEUED_CAP_PER_SESSION} for this session, ${queuedGlobal}/${QUEUED_CAP_GLOBAL} global). Do NOT retry this run — a human will drain the queue.`,
      };
    }
    // ACCEPTANCE-METRIC-BASELINE: a held filing is stored too — same gate.
    await applyAcceptanceBaselineGate(context, type);
    const queuedTicket = await prisma.userFeatureRequest.create({
      data: {
        userId: opts.userId,
        type,
        title,
        description,
        priority,
        source: 'agent',
        status: 'queued',
        context: { ...context, queuedReason: reason, queuedAt: new Date().toISOString() } as Prisma.InputJsonValue,
      },
    });
    logger.info(`feedback: agent ticket ${queuedTicket.id} QUEUED (${reason}, session=${sessionId}) — stored, not dropped`);
    return { queued: true, ticket: queuedTicket };
  };

  const sessionCount = await prisma.userFeatureRequest.count({
    where: {
      source: 'agent',
      createdAt: { gte: hourAgo },
      context: { path: ['sessionId'], equals: sessionId },
    },
  });
  if (sessionCount > SESSION_CAP_PER_HOUR) {
    return queueTicket(`session cap: ${sessionCount} tickets in the last hour (cap ${SESSION_CAP_PER_HOUR})`);
  }
  const globalCount = await prisma.userFeatureRequest.count({
    where: { source: 'agent', createdAt: { gte: dayAgo } },
  });
  if (globalCount >= GLOBAL_CAP_PER_DAY) {
    return queueTicket(`global backstop: ${globalCount} tickets/24h (cap ${GLOBAL_CAP_PER_DAY})`);
  }

  // Under capacity: pull the oldest queued filings forward so a held backlog
  // drains itself as rate windows free — no sweeper, the next under-cap
  // filing (in ANY session) is the trigger.
  const promoted = await promoteQueuedFeedbackTickets(QUEUE_PROMOTE_PER_PASS);
  if (promoted > 0) {
    void import('./ticket-dispatch.service')
      .then((m) => m.drainOpenTicketsToLane())
      .catch(() => {});
  }

  // ── ADJUDICATED-CLASS dedupe, cross type/source (audit 2026-10-16 item 6,
  //    todo 6df5fc61): once a failure pattern is adjudicated "model behavior,
  //    guard correct" and its ticket CLOSED, a NEW sighting of the same
  //    normalized class appends to the ADJUDICATED ticket (occurrences +
  //    sighting, no priority escalation, no dispatch) instead of filing a fresh
  //    row that re-fires a full lane dispatch. The exact pass above scopes to
  //    {type, source:'agent'} so the mishap AUTO-filing (source 'agent-harness')
  //    and an agent SIGHTING of the same incident never matched (live case:
  //    596718e7 mishap/agent-harness vs 62f14ea6 general_feedback/agent —
  //    IDENTICAL normalized title, two rows, two dispatched lanes). This pass
  //    matches the normalized title against ANY closed, adjudicated
  //    agent-family row (source 'agent' or 'agent-harness' — never user rows)
  //    regardless of type, in the same 90d window. Fail-safe shape: the
  //    adjudication must be RECORDED on the row (context.adjudicatedClass
  //    stamped by update_feedback at adjudication, or the adminNote carries
  //    the model-behavior/guard-correct verdict) — an unmarked closed row is
  //    never merged into (it falls to the reopen pass below by type).
  //    Kill switch FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED=1.
  if (process.env.FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED !== '1') {
    try {
      const adjudicatedMatch = await findDedupCandidate<DedupScanRow>({
        where: {
          source: { in: ['agent', 'agent-harness'] },
          status: { in: closedTicketStatusesForQuery() },
          createdAt: { gte: dedupSince },
        },
        orderBy: 'updatedAt',
        token: dedupPrefilterToken(norm),
        select: { id: true, title: true, priority: true, description: true, context: true, adminNote: true, status: true, type: true, source: true, updatedAt: true },
        match: (c) => {
          if (normalizeFeedbackTitle(c.title) !== norm) return false;
          if (asContextObject(c.context).duplicateOf) return false; // linked-duplicate records never absorb
          return isAdjudicatedTicketRow(c);
        },
      });
      if (adjudicatedMatch) {
        const prevCtx = asContextObject(adjudicatedMatch.context);
        const occurrences = (typeof prevCtx.occurrences === 'number' ? prevCtx.occurrences : 1) + 1;
        const sighting: Record<string, unknown> = {};
        if (context.sessionId) sighting.sessionId = context.sessionId;
        if (context.role) sighting.role = context.role;
        if (context.filedAt) sighting.filedAt = context.filedAt;
        if (context.about) sighting.about = context.about;
        sighting.duplicateSuppressedBy = 'adjudicated-class';
        const prevSightings = Array.isArray(prevCtx.sightings) ? prevCtx.sightings : [];
        const sightings = [...prevSightings, sighting].slice(-SIGHTINGS_KEPT);
        const bumpDescription = await descriptionForBump(adjudicatedMatch.id);
        const bumped = await prisma.userFeatureRequest.update({
          where: { id: adjudicatedMatch.id },
          data: {
            description: fitBumpedDescription(adjudicatedMatch.description, `${occurrences} (adjudicated class — model behavior, guard correct; suppressed, no dispatch) ---\n${bumpDescription}`),
            context: { ...prevCtx, occurrences, sightings, lastSeen: new Date().toISOString() } as Prisma.InputJsonValue,
          },
        });
        logger.info(`feedback: adjudicated-class dedupe — sighting merged into ${adjudicatedMatch.id} (occurrences=${occurrences}); no new ticket, no dispatch`);
        try {
          recordLoopMetric({
            kind: 'feedback_adjudicated_class_dedupe',
            sessionId: typeof context.sessionId === 'string' ? context.sessionId : undefined,
            value: 1,
            meta: { ticketId: adjudicatedMatch.id, occurrences, filedType: type, ticketType: adjudicatedMatch.type },
          });
        } catch { /* telemetry never blocks */ }
        return { deduped: true, ticket: bumped };
      }
    } catch (err) {
      logger.warn(`feedback: adjudicated-class dedupe pass failed (fail-open to normal filing): ${String((err as any)?.message ?? err).slice(0, 120)}`);
    }
  }

  // ACCEPTANCE-METRIC-BASELINE (2026-10-20): a metric that already passes on
  // its pre-fix window is not stored (the ticket still files, flagged).
  await applyAcceptanceBaselineGate(context, type);
  // TICKET-FAMILY-ROUTING (2026-10-20): a member of a NOISY auto-filer family
  // (≥ 3 of its last 5 closes were false positives or siblings) is filed
  // 'queued' — the dispatcher carries it into the family's next lane (at most
  // one per UTC day) instead of spending a lane slot re-adjudicating the class.
  // Only when the fresh-lane drain can carry it (review 2026-10-20): fresh
  // lanes on, a lane home, and the ticket in OWNER scope — another account's
  // ticket (the action verifier files under the chat owner's userId) files
  // 'open' and stays visible on the held-for-owner-review list.
  const familyRoute: FamilyPrecision | null = await familyFilingRoute({ title, type, context, userId: opts.userId ?? null });
  if (familyRoute) {
    context.familyQueued = true;
    context.familyQueue = {
      key: familyRoute.family,
      at: new Date().toISOString(),
      considered: familyRoute.considered,
      falsePositives: familyRoute.falsePositives,
      siblings: familyRoute.siblings,
      trueDefects: familyRoute.trueDefects,
    };
  }
  // SHARED-PROJECT-DISPATCH: the auto-approval rides the NEW row only (the
  // dispatcher's owner-scope rule reads context.dispatchApproved).
  if (autoApprovedSeat) {
    const { AUTO_APPROVED_BY } = await import('./held-ticket-escalation');
    context.dispatchApproved = true;
    context.dispatchApprovedBy = AUTO_APPROVED_BY;
    context.dispatchApprovedAt = new Date().toISOString();
    context.autoApproved = { seat: autoApprovedSeat, rule: 'supervisor_platform_ticket', ...(autoApprovedVia ? { projectId: autoApprovedVia.projectId, memberRole: autoApprovedVia.memberRole } : {}) };
  }
  const ticket = await prisma.userFeatureRequest.create({
    data: {
      userId: opts.userId,
      type,
      title,
      description,
      priority,
      source: 'agent',
      ...(familyRoute ? { status: 'queued', adminNote: familyQueuedNote(familyRoute) } : {}),
      context: context as Prisma.InputJsonValue,
    },
  });
  if (autoApprovedSeat) {
    try {
      recordLoopMetric({
        kind: 'held_ticket_escalation',
        sessionId: typeof context.sessionId === 'string' ? context.sessionId : undefined,
        meta: { phase: 'autoapprove', ticketId: ticket.id, seat: autoApprovedSeat, type, ...(autoApprovedVia ? { projectId: autoApprovedVia.projectId, memberRole: autoApprovedVia.memberRole } : {}) },
      });
    } catch { /* telemetry never blocks */ }
    logger.info(`feedback: agent ticket ${ticket.id} AUTO-APPROVED for a ticket lane (about=digby_platform from a ${autoApprovedSeat} seat of a ${autoApprovedVia?.memberRole ?? 'write'} member of the owner's project ${autoApprovedVia?.projectId.slice(0, 8) ?? '?'}; shape-only description)`);
  }
  if (familyRoute) {
    try {
      recordLoopMetric({
        kind: 'ticket_family_routing',
        sessionId: typeof context.sessionId === 'string' ? context.sessionId : undefined,
        meta: { phase: 'filed_queued', ticketId: ticket.id, family: familyRoute.family, considered: familyRoute.considered, falsePositives: familyRoute.falsePositives, siblings: familyRoute.siblings, trueDefects: familyRoute.trueDefects },
      });
    } catch { /* telemetry never blocks */ }
    logger.info(`feedback: agent ticket ${ticket.id} filed QUEUED for the next ${familyRoute.family} family lane (noisy family: ${familyRoute.falsePositives} false positives + ${familyRoute.siblings} siblings in its last ${familyRoute.considered} closes)`);
  }
  // e87aee19: a filing that carried packed screenshots is re-written with the
  // blobs on disk and reference lines in the row (extraction never throws).
  let storedTicket = ticket;
  if (packed.dataUrls.length && !subjectContentWithheld) {
    const extraction = await extractFeedbackImages(opts.description, ticket.id);
    if (extraction.description.trim() !== description) {
      storedTicket = await prisma.userFeatureRequest.update({
        where: { id: ticket.id },
        data: { description: extraction.description.trim() },
      });
    }
  }
  logger.info(`feedback: agent ticket ${ticket.id} filed (type=${type}, priority=${priority}, session=${sessionId})`);
  // Burn-down drain (owner directive 2026-08-22): every agent filing also
  // triggers a batched dispatch of the open backlog into the platform lane
  // (env-gated + capped + loop-gated in ticket-dispatch.service). Fire-and-
  // forget dynamic import — never blocks or throws into the filing run, and
  // keeps this module's static graph light (ticket-dispatch pulls config/redis).
  void import('./ticket-dispatch.service')
    .then((m) => m.drainOpenTicketsToLane())
    .catch(() => {});
  return { deduped: false, ticket: storedTicket };
}

/** Count FAMILY-queued agent rows (optionally one session's). Never throws — a failed or odd read counts 0. */
async function countFamilyQueued(opts: { sessionId?: string }): Promise<number> {
  try {
    const n = await prisma.userFeatureRequest.count({
      where: {
        source: 'agent',
        status: 'queued',
        AND: [
          { context: { path: ['familyQueued'], equals: true } },
          ...(opts.sessionId ? [{ context: { path: ['sessionId'], equals: opts.sessionId } }] : []),
        ],
      },
    });
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Auto-promote the oldest rate-cap-HELD filings (status 'queued', 2026-08-31)
 * to 'open' so they enter triage/drain. Called from fileFeedbackTicket after
 * the cap checks pass — the next under-cap filing is the trigger (no sweeper).
 * Returns the number promoted. Exported for tests.
 * TICKET-FAMILY-ROUTING (2026-10-20): a FAMILY-queued member (context.familyQueued
 * — filed 'queued' for its noisy family's lane) is never promoted here: the
 * dispatcher carries it into the next family lane. They are excluded IN THE
 * QUERY (review 2026-10-20 — a bounded page-skip loop starved the rate-cap
 * backlog behind ≥ 9 older family rows): every family-queued row carries the
 * dispatcher-shaped filing note (FAMILY_QUEUED_NOTE_PREFIX) and a rate-cap
 * row never does, so the null-safe column filter `adminNote IS NULL OR NOT
 * LIKE 'Queued for the next%'` skips them however many there are; the
 * context flag is re-checked in memory as a belt (a hand-edited note).
 */
export async function promoteQueuedFeedbackTickets(maxPromote = QUEUE_PROMOTE_PER_PASS): Promise<number> {
  if (maxPromote < 1) return 0;
  const oldest = await prisma.userFeatureRequest.findMany({
    where: {
      source: 'agent',
      status: 'queued',
      OR: [{ adminNote: null }, { NOT: { adminNote: { startsWith: FAMILY_QUEUED_NOTE_PREFIX } } }],
    },
    orderBy: { createdAt: 'asc' },
    take: maxPromote,
    select: { id: true, context: true },
  });
  const ids = (Array.isArray(oldest) ? oldest : []).filter((r) => asContextObject(r.context).familyQueued !== true).map((r) => r.id);
  if (!ids.length) return 0;
  const { count } = await prisma.userFeatureRequest.updateMany({
    where: { id: { in: ids }, status: 'queued' }, // re-guard: a loser of a concurrent pass stays queued
    data: { status: 'open' },
  });
  if (count > 0) {
    logger.info(`feedback: promoted ${count} queued agent ticket(s) to open (rate window freed)`);
  }
  return count;
}

// ── list (admin) ──────────────────────────────────────────────────────────────

export interface ListFeedbackOpts {
  status?: string;
  type?: string;
  source?: string;
  limit?: number;
}

/**
 * Admin listing — open first, then priority desc, then newest (mirrors
 * adminListFeatureRequests in crossmodel.controller.ts). Trimmed shape:
 * area/occurrences are lifted out of the context blob.
 */
export async function listFeedbackTickets(opts: ListFeedbackOpts) {
  if (opts.status && !(FEEDBACK_STATUSES as readonly string[]).includes(opts.status)) {
    throw new AppError(400, `Invalid status "${opts.status}" — allowed: ${FEEDBACK_STATUSES.join(' | ')}.`);
  }
  if (opts.type && !(FEEDBACK_TYPES as readonly string[]).includes(opts.type)) {
    throw new AppError(400, `Invalid type "${opts.type}" — allowed: ${FEEDBACK_TYPES.join(' | ')}.`);
  }
  if (opts.source && !(FEEDBACK_SOURCES as readonly string[]).includes(opts.source)) {
    throw new AppError(400, `Invalid source "${opts.source}" — allowed: ${FEEDBACK_SOURCES.join(' | ')}.`);
  }
  const limit = Math.min(200, Math.max(1, Math.trunc(opts.limit ?? 50) || 50));

  const rows = await prisma.userFeatureRequest.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.source ? { source: opts.source } : {}),
    },
    include: { user: { select: { email: true, name: true } } },
    // NOTE: status is intentionally NOT in the DB orderBy — an alphabetical
    // status sort is the bug (a1ca6bfc). The DB orders by priority/recency; the
    // authoritative open-first grouping is the explicit STATUS_RANK sort below.
    orderBy: [
      { priority: 'desc' },
      { createdAt: 'desc' },
    ],
    take: limit,
  });

  // Explicit status rank (open → in_progress → done). Array.sort is stable in
  // Node, so within each status group the priority-desc / newest DB order is
  // preserved — giving the documented "open first, then priority desc, then
  // newest" total order.
  rows.sort((a, b) => statusRank(a.status) - statusRank(b.status));

  return rows.map((r) => {
    const ctx = asContextObject(r.context);
    return {
      id: r.id,
      type: r.type,
      title: r.title,
      // Capped so a list result can't blow the model's context — the ticket id
      // remains for follow-up reads of the full row.
      description: r.description.length > LIST_DESCRIPTION_MAX
        ? `${r.description.slice(0, LIST_DESCRIPTION_MAX)}…`
        : r.description,
      status: normalizeTicketStatus(r.status), // a legacy closed spelling reads as 'done' (audit T8)
      priority: r.priority,
      source: r.source,
      area: typeof ctx.area === 'string' ? ctx.area : null,
      occurrences: typeof ctx.occurrences === 'number' ? ctx.occurrences : 1,
      userId: r.userId ?? null,
      user: r.user ? { email: r.user.email, name: r.user.name } : null,
      createdAt: r.createdAt,
    };
  });
}

// ── get (single full row — audit #9d) ────────────────────────────────────────

/** Minimum prefix length accepted by the prefix-resolution fallback. */
const GET_ID_PREFIX_MIN = 8;

export type GetFeedbackResult =
  | { ok: true; ticket: any }
  | { ok: false; reason: 'not_found' | 'ambiguous'; candidates?: string[] };

/**
 * Fetch ONE feedback ticket's FULL row (audit #9d — lanes were re-deriving
 * ticket state from list_feedback's 500-char digests). Accepts the full id or
 * a unique ≥8-char prefix (adminNotes, briefs, and the closure manifest all
 * cite 8-char prefixes — same affordance as hook_unsubscribe). An ambiguous
 * prefix returns the candidate full ids. AUTHORIZATION IS THE CALLER'S JOB:
 * this returns the row for any id — the tool layer gates on admin/ownership.
 */
export async function getFeedbackTicketById(id: string): Promise<GetFeedbackResult> {
  const key = id.trim();
  if (!key) return { ok: false, reason: 'not_found' };
  // A legacy closed spelling reads as 'done' on this path too (audit T8) —
  // the row itself is never rewritten here.
  const withStatus = (row: any) => (row && typeof row === 'object' ? { ...row, status: normalizeTicketStatus(row.status) } : row);
  const exact = await prisma.userFeatureRequest.findUnique({ where: { id: key } });
  if (exact) return { ok: true, ticket: withStatus(exact) };
  if (key.length < GET_ID_PREFIX_MIN) return { ok: false, reason: 'not_found' };
  const byPrefix = await prisma.userFeatureRequest.findMany({
    where: { id: { startsWith: key } },
    take: 3,
  });
  if (byPrefix.length === 1) return { ok: true, ticket: withStatus(byPrefix[0]) };
  if (byPrefix.length > 1) return { ok: false, reason: 'ambiguous', candidates: byPrefix.map((r) => r.id) };
  // audit 2026-10-08 W3-3: the shared heal tier — a ≥8-char suffix / prefix+suffix splice. Same scope as the
  // prefix tier above (authorization stays the caller's job — the tool layer gates on admin / ownership).
  try {
    const { healIdRef } = await import('../platform/id-ref');
    const healed = await healIdRef(key, {
      byPrefix: async (prefix, take) => ((await prisma.userFeatureRequest.findMany({ where: { id: { startsWith: prefix } }, select: { id: true }, take })) ?? []).map((r: any) => r.id),
      bySuffix: async (suffix, take) => ((await prisma.userFeatureRequest.findMany({ where: { id: { endsWith: suffix } }, select: { id: true }, take })) ?? []).map((r: any) => r.id),
    }, 'ticket');
    if (healed.ok) {
      const row = await prisma.userFeatureRequest.findUnique({ where: { id: healed.id } });
      if (row) return { ok: true, ticket: withStatus(row) };
    } else if (healed.reason === 'ambiguous') {
      return { ok: false, reason: 'ambiguous', candidates: healed.candidates };
    }
  } catch { /* fail-open: the not_found below */ }
  return { ok: false, reason: 'not_found' };
}

// ── update (admin) ────────────────────────────────────────────────────────────

export interface UpdateFeedbackOpts {
  id: string;
  status?: string;
  adminNote?: string;
  priority?: number;
  /** Row-context merge (the filer duplicate-retire rail's linked-duplicate write). */
  context?: Record<string, unknown>;
  /**
   * Optimistic-concurrency guard (9dacab1a round-1 review F8): the context
   * the CALLER read before building `context`. When present the update runs
   * as an updateMany guarded by `context equals expectContext` — 0 rows means
   * another writer landed first and this call reports {ok:false,
   * reason:'context_conflict'} instead of silently clobbering their fields.
   * null context normalizes to {} on both sides before comparing.
   */
  expectContext?: unknown;
}

export type UpdateFeedbackTicketResult =
  // The updated row (the historical return shape — every existing caller).
  | { ok: true; ticket: any }
  // Only when expectContext was supplied and the guard matched 0 rows.
  | { ok: false; reason: 'context_conflict' };

/**
 * TICKET-FAMILY-ROUTING review (2026-10-20): stamp the CLOSE TIME
 * (context.closedAt) on a transition into a closed / awaiting-verification
 * status (ticket-family closeStampPatch). Class-fix absorption reads it as
 * "when the fix closed" — the row's updatedAt moves on every later write (the
 * lane-archive stamp, the verifier's verdict, a counter bump on a done row),
 * which read post-fix recurrences as predating the fix. An ATOMIC jsonb merge
 * after the status write, so a concurrent context writer is never clobbered
 * (and a context the caller just wrote keeps every field). Best-effort: a
 * failed stamp leaves the close unstamped, which never anchors an absorption.
 * Off with TICKET_FAMILY_PRECISION_ROUTING_DISABLED=1. Never throws.
 */
async function stampTicketClosedAt(id: string, prevStatus: unknown, nextStatus: unknown): Promise<void> {
  try {
    if (familyPrecisionRoutingDisabled()) return;
    const patch = closeStampPatch(prevStatus, nextStatus, new Date().toISOString());
    if (!patch || typeof (prisma as { $executeRaw?: unknown }).$executeRaw !== 'function') return;
    const json = JSON.stringify(patch);
    await prisma.$executeRaw`UPDATE "user_feature_requests" SET "context" = (CASE WHEN jsonb_typeof("context") = 'object' THEN "context" ELSE '{}'::jsonb END) || ${json}::jsonb WHERE "id" = ${id}`;
  } catch (err: any) {
    logger.warn(`feedback: close-time stamp failed for ticket ${id.slice(0, 8)} (non-fatal — the close stays unstamped): ${err?.message ?? err}`);
  }
}

export async function updateFeedbackTicket(rawOpts: UpdateFeedbackOpts): Promise<any> {
  // A legacy closed spelling ('resolved') on input writes the canonical
  // 'done' (ticket-status.ts, audit T8) — the table never gains a new one.
  const opts: UpdateFeedbackOpts = rawOpts.status !== undefined
    ? { ...rawOpts, status: normalizeTicketStatus(rawOpts.status) }
    : rawOpts;
  if (!opts.id) throw new AppError(400, 'id is required.');
  if (opts.status !== undefined && !(FEEDBACK_STATUSES as readonly string[]).includes(opts.status)) {
    throw new AppError(400, `Invalid status "${opts.status}" — allowed: ${FEEDBACK_STATUSES.join(' | ')}.`);
  }
  if (opts.priority !== undefined) {
    const p = opts.priority;
    if (!Number.isInteger(p) || p < PRIORITY_MIN || p > PRIORITY_MAX) {
      throw new AppError(400, `priority must be an integer ${PRIORITY_MIN}..${PRIORITY_MAX} (got ${p}).`);
    }
  }
  // Existence pre-check: a not-found id is a ROUTINE model mistake (agents
  // probe with garbage ids — 265 raw `prisma:error` log lines in 4h on box C,
  // 2026-09-08), so it must not reach the throwing update() (the client logs
  // every P2025 to stderr before our catch). The P2025 catch stays as the
  // delete-race belt.
  // Id resolution (ticket e829e28c): exact match first, then a UNIQUE ≥8-char
  // prefix — the fleet convention cites 8-char prefixes (get_feedback, briefs,
  // closure manifests) and every sibling by-id tool resolves them, so the
  // exact-only check here 404'd EXISTING tickets ("Feedback ticket \"d78f477b\"
  // not found." ×3, breaker trip 2026-09-11, session 4194f3cc). An ambiguous
  // prefix refuses with the candidates — never a silent mis-write.
  const resolved = await getFeedbackTicketById(opts.id);
  if (!resolved.ok) {
    if (resolved.reason === 'ambiguous') {
      throw new AppError(400, `Feedback ticket prefix "${opts.id}" is ambiguous — candidates: ${(resolved.candidates ?? []).join(', ')}. Re-call ${modelToolName('update_feedback')} with the full id.`);
    }
    throw new AppError(404, `Feedback ticket "${opts.id}" not found.`);
  }
  const resolvedId = resolved.ticket.id as string;
  // Optimistic-concurrency path (F8): guard the write on the context the
  // caller read. A 0-row update means the row moved underneath them — report
  // the conflict; the CALLER decides whether to re-read and retry (the
  // service never retries internally: a blind retry would clobber whatever
  // the winning writer just landed, which is the race this exists to stop).
  if (opts.expectContext !== undefined) {
    // Normalize null/malformed → {} on BOTH sides before comparing: a caller
    // that read a null context passes {} (handled here), and a row stored
    // with SQL NULL context must match an expected {} (the OR-null branch —
    // Postgres jsonb NULL never equals '{}'::jsonb).
    const expectedRaw = opts.expectContext;
    const expected = (expectedRaw && typeof expectedRaw === 'object' && !Array.isArray(expectedRaw)
      ? expectedRaw : {}) as Record<string, unknown>;
    const expectedEmpty = Object.keys(expected).length === 0;
    // Prisma's JsonNullableFilter on this stack (client 7.x + PrismaPg driver
    // adapter, Postgres): a SQL-NULL context matches NEITHER `equals: {}` NOR
    // `equals: null` — the latter compiles to `("context" = 'null'::jsonb OR
    // "context" IS NULL)` inside one filter object, which still misses (the
    // driver adapter folds the OR into a non-matching filter). Verified
    // empirically against a real Postgres (ticket 696d4346, 2026-10-28): the
    // OLD `OR [{ equals: {} }, { equals: null }]` guarded write returned
    // count=0 for a SQL-NULL context row — every held-ticket escalation stamp
    // on a never-touched (NULL-context) ticket failed as context_conflict, so
    // the sweep re-carded the same ticket every cycle despite the owner's
    // repeated answers. `Prisma.AnyNull` is the verified idiom: the same OR
    // with `equals: Prisma.AnyNull` matches SQL NULL, jsonb 'null' and {}
    // (count=1 each) and still skips populated contexts (count=0).
    const guardedWhere = expectedEmpty
      ? { id: resolvedId, OR: [{ context: { equals: {} as Prisma.InputJsonValue } }, { context: { equals: Prisma.AnyNull } }] }
      : { id: resolvedId, context: { equals: expected as Prisma.InputJsonValue } };
    try {
      const res = await prisma.userFeatureRequest.updateMany({
        where: guardedWhere as any,
        data: {
          ...(opts.status !== undefined && { status: opts.status }),
          ...(opts.adminNote !== undefined && { adminNote: opts.adminNote }),
          ...(opts.priority !== undefined && { priority: opts.priority }),
          ...(opts.context !== undefined && { context: opts.context as Prisma.InputJsonValue }),
        },
      });
      if (res.count === 0) return { ok: false as const, reason: 'context_conflict' as const };
      await stampTicketClosedAt(resolvedId, resolved.ticket.status, opts.status);
      const after = await prisma.userFeatureRequest.findUnique({ where: { id: resolvedId } });
      logger.info(`feedback: ticket ${resolvedId} updated (status=${opts.status ?? 'unchanged'}, priority=${opts.priority ?? 'unchanged'}, guarded context write)`);
      return after ?? { ok: true as const, ticket: { id: resolvedId } };
    } catch (err: any) {
      if (err?.code === 'P2025') throw new AppError(404, `Feedback ticket "${opts.id}" not found.`);
      throw err;
    }
  }
  try {
    const updated = await prisma.userFeatureRequest.update({
      where: { id: resolvedId },
      data: {
        ...(opts.status !== undefined && { status: opts.status }),
        ...(opts.adminNote !== undefined && { adminNote: opts.adminNote }),
        ...(opts.priority !== undefined && { priority: opts.priority }),
        ...(opts.context !== undefined && { context: opts.context as Prisma.InputJsonValue }),
      },
    });
    await stampTicketClosedAt(resolvedId, resolved.ticket.status, opts.status);
    logger.info(`feedback: ticket ${resolvedId} updated (status=${opts.status ?? 'unchanged'}, priority=${opts.priority ?? 'unchanged'})`);
    return updated;
  } catch (err: any) {
    if (err?.code === 'P2025') throw new AppError(404, `Feedback ticket "${opts.id}" not found.`);
    throw err;
  }
}

// ── admin gate ────────────────────────────────────────────────────────────────

/** True when userId belongs to an ADMIN user (list/update feedback triage). */
export async function isAdminUser(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return user?.role === 'ADMIN';
}

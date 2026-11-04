/**
 * Auto-filer ticket FAMILIES + measured family precision (TICKET-FAMILY-ROUTING,
 * 2026-10-20 — round 2 of the supervisor SOTA wave).
 *
 * WHY: framework-signal-sweep filed 14 tickets over 10-18..10-20; 12 got a
 * solo ticket lane and only ONE was a true defect. The batching families
 * (ticket 47397831) covered four template titles, but the sweep's two other
 * finding classes ("Incomplete owner card <id8>", "Missed bug: owner
 * frustration in chat <id8>") and the action verifier's per-chat mishap
 * tickets each took a whole lane slot to re-adjudicate a known
 * false-positive class — real defects waited behind them.
 *
 * THREE pieces live here (pure helpers + one bounded DB read; the dispatcher
 * and the filing path call them):
 *   1. FAMILY KEYS — the 47397831 title families plus three V2 families:
 *      incomplete-card + missed-bug (framework-signal-sweep titles) and
 *      av-mishap (any action-verifier ticket: context.verifier ===
 *      'action-verifier'). Kill switch TICKET_FAMILY_PREFIX_V2_DISABLED=1
 *      restores the four-family classifier byte-for-byte.
 *   2. MEASURED PRECISION — a family's last FAMILY_PRECISION_WINDOW (5) closes
 *      are classified true_defect / false_positive / sibling / unknown from
 *      what the closing lane RECORDED (adminNote verdict wording, a
 *      duplicateOf link, the machine-close evidence block). When
 *      FAMILY_NOISY_MIN (3) or more are false positives or siblings the family
 *      is NOISY: new members are filed 'queued' (not 'open') and the
 *      dispatcher runs at most ONE batched lane for that family per UTC day,
 *      carrying every queued member. A queued member is never lost — it is a
 *      canonical owed status (OPEN_TICKET_STATUSES), dedup still bumps it,
 *      and the next family lane lists it on its checklist.
 *   3. CLASS-FIX ABSORPTION — a never-laned open/queued member whose LATEST
 *      sighting PREDATES a merged fix of its class (a same-family close with
 *      machine-close fix evidence, same absorb class, an EXPLICIT close time)
 *      is closed as a linked duplicate of that fix (context.duplicateOf,
 *      absorbedByClassFix) instead of taking a lane to re-discover the fix.
 *      Only an INSTANCE-keyed class absorbs (raw-marker:<MARKER> — one marker
 *      leak, one renderer fix). A DETECTOR-WIDE class (incomplete-card /
 *      missed-bug / av-mishap — each instance is a different owner question,
 *      chat or root cause) is NEVER auto-closed (review 2026-10-20): a narrowed
 *      detector only stops FUTURE false positives, it says nothing about the
 *      pending sightings, so the family lane's brief lists them under a
 *      "detector narrowed in <sha> — re-check" line instead.
 *      The fix time is context.closedAt (stamped by updateFeedbackTicket on the
 *      transition into a closed / awaiting-verification status — never the
 *      row's updatedAt, which every later write moves), else the done-bar
 *      handoff time (verification.queuedAt); an unstamped close never anchors
 *      an absorption. If the fix did not cover a sighting, the class recurs
 *      AFTER the fix and the filer files (or bumps) a row whose sighting time
 *      postdates the fix, so it is never absorbed.
 *   Pieces 2 and 3 share kill switch TICKET_FAMILY_PRECISION_ROUTING_DISABLED=1
 *   (no queued filings, no day gate, no absorption, no close stamp — rows
 *   already queued are still drained, so flipping the switch never strands
 *   one).
 *   A member is filed 'queued' only when the fresh-lane drain can carry it:
 *   fresh lanes on (TICKET_DISPATCH_FRESH_LANES_DISABLED unset), a lane home
 *   resolves, and the ticket is in OWNER scope (ticketOwnerScopeAllowed — the
 *   F3 rule the drain applies). Anything else files 'open' as before, where
 *   the held-for-owner-review list and the standing-lane batch can see it.
 *
 * Import-free apart from prisma + the ticket-status leaf (feedback.service and
 * ticket-dispatch.service both import this; no logger, no redis). The lane
 * home is resolved through a DYNAMIC import of the lane-home leaf, only for a
 * noisy-family filing.
 */

import prisma from '../../../config/database';
import { closedTicketStatusesForQuery, isClosedTicketStatus } from './ticket-status';

/** Every family the dispatcher batches into ONE lane. */
export type TicketFamilyKey =
  | 'recurring-log-signature'
  | 'raw-marker'
  | 'log-signal'
  | 'tool-failure-streak'
  | 'incomplete-card'
  | 'missed-bug'
  | 'av-mishap';

export const TICKET_FAMILY_KEYS: readonly TicketFamilyKey[] = [
  'recurring-log-signature', 'raw-marker', 'log-signal', 'tool-failure-streak', 'incomplete-card', 'missed-bug', 'av-mishap',
];

/** '1' restores the four 47397831 families (no incomplete-card / missed-bug / av-mishap). Read at CALL time. */
export function familyPrefixV2Disabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TICKET_FAMILY_PREFIX_V2_DISABLED === '1';
}

/** '1' turns off precision routing: no queued filings, no one-lane-per-day gate, no class-fix absorption. */
export function familyPrecisionRoutingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TICKET_FAMILY_PRECISION_ROUTING_DISABLED === '1';
}

// ── DEFECT FAMILY (TFD-1, 2026-10-30) — the STRUCTURAL family signal ─────────
// The auto-filer families above classify a ticket's TITLE TEMPLATE (who filed
// it and from which sweep). A DIRECTOR defect family is a different axis: the
// defect itself, named by the FILER, so a second sighting of one defect can be
// recognised even though it arrives from a different sweep, with a different
// title, hours later. Incident: the tool-call truncation family (tickets
// c42e8099 → efdb3d31 → b61794e3 → bf3a61e6) — every supervisor wake that hit
// a cut filed a FRESH ticket, the dispatcher minted a brand-new lane for it,
// and the third lane's run reported it built nothing (a third independent fix
// for the family is refused). Cost: a full run per duplicate classification.
//
// The signal has to be VOLUNTARY and CONSERVATIVE: only a filer that NAMES a
// family (file_feedback's `defectFamily` arg, stamped as context.defectFamily)
// ever enables the gate. No stamp ⇒ no family ⇒ dispatch exactly as today
// (fail OPEN — a genuinely new defect can never be swallowed by a guess).
//
// Pure: no prisma, no redis, no logger (the drain owns the I/O).

/** The note a same-family duplicate carries while the canonical lane runs.
 *  Registered in ticket-dispatch.service's DISPATCHER_NOTE_RE so the drain
 *  keeps owning (and on a later drain replacing) this note. */
export const DEFECT_FAMILY_HOLD_NOTE_PREFIX = 'Held — same defect family: ticket ';

const DEFECT_FAMILY_MIN = 3;
const DEFECT_FAMILY_MAX = 40;

/**
 * Normalize a filer-named defect family to its stable slug, or null when it
 * cannot be read with confidence (null / non-string / too short / too long /
 * no letters). AMBIGUITY IS NOT A GATE: null ⇒ no family ⇒ dispatch as today.
 */
export function normalizeDefectFamily(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  if (slug.length < DEFECT_FAMILY_MIN || slug.length > DEFECT_FAMILY_MAX) return null;
  if (!/[a-z]/.test(slug)) return null; // a pure-digit slug carries no defect identity
  return slug;
}

/** The row's filer-named defect family (context.defectFamily), or null. Pure. */
export function defectFamilyOf(row: { context?: unknown } | null | undefined): string | null {
  const c = row?.context;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  return normalizeDefectFamily((c as Record<string, unknown>).defectFamily);
}

/** The family carried by a CONTEXT object (the drain already holds the context
 *  and must not re-wrap it — a row-vs-context mixup here silently disables the
 *  gate, which reads exactly like "no family"). Pure. */
export function defectFamilyOfContext(context: unknown): string | null {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  return normalizeDefectFamily((context as Record<string, unknown>).defectFamily);
}

/** The note for a same-family sighting held while the canonical lane runs. */
export function defectFamilyHoldNote(canonicalId: string, lane: string, family: string): string {
  return `${DEFECT_FAMILY_HOLD_NOTE_PREFIX}${canonicalId.slice(0, 8)}${lane ? ` (ticket lane ${lane.slice(0, 8)})` : ''} already works the ${family} defect family — no second lane while it runs; its sightings are linked onto that ticket.`;
}

// ── Family classification ─────────────────────────────────────────────────────
// Family identity is the FILER CLASS (see ticket-dispatch.service.ts's 47397831
// block): the template's variable tail (hash8 / chat id8 / question id8)
// never splits a family.
const V1_TITLE_FAMILIES: ReadonlyArray<{ key: TicketFamilyKey; re: RegExp; dbPrefix: string[] }> = [
  // raw-marker markers are UPPER_SNAKE (BATCH, HARNESS, SECRET, SEND_EMAIL…)
  // — 47397831 review #7: [a-z_]+ not [a-z]+.
  { key: 'recurring-log-signature', re: /^recurring log signature [0-9a-f]{6,12}\b/i, dbPrefix: ['Recurring log signature'] },
  { key: 'raw-marker', re: /^raw marker [a-z_]+(\s*\(high\))?\s+survived in chat [0-9a-f]{6,12}\b/i, dbPrefix: ['Raw marker'] },
  { key: 'log-signal', re: /^log-signal:\s/i, dbPrefix: ['log-signal:'] },
  { key: 'tool-failure-streak', re: /^3[x×] tool-failure streak:\s/i, dbPrefix: ['3× tool-failure streak', '3x tool-failure streak'] },
];
/** framework-signal-sweep.ts cardFinding / frustrationFinding titles (verbatim templates). */
const V2_TITLE_FAMILIES: ReadonlyArray<{ key: TicketFamilyKey; re: RegExp; dbPrefix: string[] }> = [
  { key: 'incomplete-card', re: /^incomplete owner card [0-9a-z_-]{6,12}\b/i, dbPrefix: ['Incomplete owner card'] },
  { key: 'missed-bug', re: /^missed bug: owner frustration in chat [0-9a-f]{6,12}\b/i, dbPrefix: ['Missed bug: owner frustration'] },
];

type Ctx = Record<string, unknown>;
const ctxOf = (row: { context?: unknown } | null | undefined): Ctx => {
  const c = row?.context;
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Ctx) : {};
};

/**
 * Classify a ticket as an auto-filer family row, or null. Pure. The title is
 * the identity for the six template families; the action verifier's mishap
 * tickets carry ~11 distinct per-chat titles, so av-mishap keys on the
 * verifier stamp (context.verifier === 'action-verifier') instead. `row` is
 * optional so the 47397831 one-argument call shape keeps working.
 */
export function ticketFamilyKey(
  title: unknown,
  row?: { type?: unknown; context?: unknown } | null,
  env: NodeJS.ProcessEnv = process.env,
): TicketFamilyKey | null {
  const t = typeof title === 'string' ? title : '';
  for (const p of V1_TITLE_FAMILIES) if (t && p.re.test(t)) return p.key;
  if (familyPrefixV2Disabled(env)) return null;
  for (const p of V2_TITLE_FAMILIES) if (t && p.re.test(t)) return p.key;
  if (row && ctxOf(row).verifier === 'action-verifier') return 'av-mishap';
  return null;
}

// ── Close classification (what the closing lane RECORDED) ─────────────────────

export type FamilyCloseClass = 'true_defect' | 'false_positive' | 'sibling' | 'unknown';

/** A verdict phrase counts only when POSITIVE: no negator in the 40 chars before it
 *  (feedback.service isAdjudicatedTicketRow's B1 discipline — "NOT model behavior"
 *  is the confirmed-defect close shape); an article / softener may sit between
 *  ("not a false positive", "not really noise"). */
const NEGATOR_TAIL_RE = /\b(?:not|never|nor|isn'?t|wasn'?t|ain'?t|zero)\b(?:[^a-z0-9]{1,3}(?:a|an|the|really|actually|just|simply))?[^a-z0-9]{0,3}$/i;
const SIBLING_RE = /\b(?:duplicate of|dup of|sibling of|same root cause as|same (?:defect|class|fix|incident) as|already (?:fixed|covered|tracked|handled) (?:by|in|under)|superseded by|folded into|absorbed (?:into|by)|covered by (?:ticket|the fix|pr|commit))\b/gi;
const FALSE_POSITIVE_RE = /\b(?:false[- ]positives?|not a (?:real |framework |platform )?(?:defect|bug)|no (?:real |framework |platform )?(?:defect|bug)\b|working as (?:intended|designed)|by design|expected behaviou?r|nothing to fix|no (?:code )?(?:change|fix) (?:is )?(?:needed|required)|model behaviou?r|guards? (?:was |were |fired |is |are )?correct|no(?:-| )deterministic framework defect|(?:detector|sweep|signal|filer|verifier) (?:noise|over-?fir(?:e|ed|ing)|mis-?fir(?:e|ed|ing)))/gi;

function positiveMatch(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const window = text.slice(Math.max(0, m.index - 40), m.index);
    if (!NEGATOR_TAIL_RE.test(window)) { re.lastIndex = 0; return true; }
  }
  re.lastIndex = 0;
  return false;
}

/** A merged fix is recorded: the machine-close evidence block (closure-evidence.ts —
 *  a verified commit or replay test), a commit sha / PR in the note, or the
 *  post-deploy verifier's deployed_verified. Pure. */
export function hasFixEvidence(row: { status?: unknown; adminNote?: unknown }): boolean {
  if (row.status === 'deployed_verified') return true;
  const note = String(row.adminNote ?? '');
  return /\[machine-close evidence: [^\]]+\]/.test(note)
    || /\bcommit [0-9a-f]{7,40}\b/i.test(note)
    || /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(note);
}

/** The note names a SHIPPED change: a commit sha (in an evidence block or the
 *  lane's own words) or a GitHub PR link. A replay-test-only evidence block is
 *  not one. Pure. */
export function noteNamesShippedFix(adminNote: unknown): boolean {
  const note = String(adminNote ?? '');
  return /\bcommit [0-9a-f]{7,40}\b/i.test(note) || /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(note);
}

/** The sha a fix close recorded (the LAST evidence block's commit), when any. Pure. */
export function fixCommitSha(adminNote: unknown): string | undefined {
  const note = String(adminNote ?? '');
  const blocks = [...note.matchAll(/\[machine-close evidence: ([^\]]+)\]/g)];
  const last = blocks.length ? blocks[blocks.length - 1][1] : note;
  return /\bcommit ([0-9a-f]{7,40})\b/i.exec(last)?.[1]?.toLowerCase();
}

/**
 * How a closed family member was closed, from what the closing lane recorded.
 * Precedence: sibling (a duplicate link or "same root cause as …") > false
 * positive (an adjudication: "false positive", "model behavior, guard
 * correct", "working as intended", context.adjudicatedClass) > true defect
 * (merged fix evidence) > unknown. A false-positive verdict wins over fix
 * evidence: a lane that narrowed a detector ships a commit for a ticket that
 * was never a product defect. Pure.
 */
export function classifyFamilyClose(row: { status?: unknown; adminNote?: unknown; context?: unknown }): FamilyCloseClass {
  const ctx = ctxOf(row);
  const note = String(row.adminNote ?? '');
  if ((typeof ctx.duplicateOf === 'string' && ctx.duplicateOf) || positiveMatch(SIBLING_RE, note)) return 'sibling';
  if (ctx.adjudicatedClass === true || positiveMatch(FALSE_POSITIVE_RE, note)) return 'false_positive';
  if (hasFixEvidence(row)) return 'true_defect';
  return 'unknown';
}

// ── Adjudication re-open bar (0ef6794e, 2026-10-26) ─────────────────────────────
//
// parseAdjudicatedReopenBar lived as a private helper of feedback.service
// (the be06c812 absorption's bar enforcement). The log-signal sweep's
// per-fingerprint adjudication suppression (fleet/log-signal-adjudication.ts,
// ticket 0ef6794e) needs the SAME bar semantics at the filing decision — one
// parser, one meaning, both layers — so it moved here verbatim (same date/
// PR-cite stripping, comparator anchoring, structural-first precedence) and
// feedback.service now re-imports it. Pure, no env-validating chain.

/**
 * The adjudication's recorded RE-OPEN BAR — the 24h row count past which the
 * verdict itself demands re-examination. TWO forms, most-trusted first:
 *   1. STRUCTURAL — context.reopenBar (a number; stamped by the absorption
 *      path when it enforces a parsed bar, and by the breach arm so a
 *      breach-triggered reopen — which overwrites adminNote — keeps its bar);
 *      no other writer exists by design;
 *   2. PROSE — the adminNote: a number AFTER a "re-open … bar" phrase.
 * The prose scan strips DATE-SHAPED tokens first (a "2026-10-14" after the
 * phrase must not become the bar), accepts comma/space/underscore-grouped
 * thousands ("13,149", "13 149") and bare 4+ digit runs ("13149"), but NOT
 * bare 3-digit runs — "f127" / "f132" (ticket-id digits inside the phrase)
 * must never parse as a bar; a sub-1000 bar must be written with a separator
 * or the structural field. Multi-line notes are scanned (\s\S, not \n-bounded).
 * Fail direction when nothing parses: null → the sighting is ABSORBED (the
 * verdict carries no bar; re-examination stays with the operators' watches).
 */
export function parseAdjudicatedReopenBar(row: { context?: unknown; adminNote?: string | null }): number | null {
  const structural = ctxOf(row).reopenBar;
  if (typeof structural === 'number' && Number.isFinite(structural) && structural > 0) return structural;
  const note = String(row.adminNote ?? '')
    // date-shaped tokens die first: "(f132, 2026-10-14): … > 13149" and the
    // T-joined form "recorded 2026-10-14T05:55:00Z: … > 13149" (round-3 NB-1
    // — otherwise 2026 parses as a low bar and every steady-state sighting
    // "breaches") must both read 13149.
    .replace(/\b(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}(?:T[\d:.]+Z?)?\b/g, ' ')
    // cross-family review B3: PR/issue cites ("see PR #1709"), build ids and
    // commit shas routinely ride machine-close adminNotes and their digits
    // must never parse as the bar. "(see PR #1709 …): 24h count > 13,149"
    // must read 13149, not 1709; "build 20261018 > 13149" must read 13149.
    .replace(/#\d+/g, ' ')
    .replace(/\b(?:build|sha|commit|run)\b[\s:#]*[0-9a-f]{4,}\b/gi, ' ');
  const phrase = /\bre-?open(?:ed)?(?:\s+adjudication)?[\s\S]{0,120}?\bbars?\b/i.exec(note);
  if (!phrase) return null;
  const NUMBER_RE = /\d{1,3}(?:[,\s_]\d{3})+|\d{4,}/g;
  const COMPARATOR_BEFORE_RE = /(?:>|>=|≥|past|over|above|beyond|exceed(?:s|ing)?|more than|climbs?\s+past)\s*$/i;
  // The scan window starts AFTER the phrase's "bar" token: the bar VALUE is
  // what the verdict re-opens past, never the f127/f132 ticket-id digits that
  // may sit inside the phrase itself.
  const window = note.slice(phrase.index + phrase[0].length, phrase.index + phrase[0].length + 120);
  const candidates: { n: number; anchored: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RE.exec(window)) !== null) {
    const n = Number(m[0].replace(/[,\s_]/g, ''));
    if (Number.isFinite(n) && n > 0) candidates.push({ n, anchored: COMPARATOR_BEFORE_RE.test(window.slice(Math.max(0, m.index - 16), m.index)) });
  }
  // Prefer the comparator-anchored candidate ("> 13,149"); otherwise the LAST
  // bare candidate ("bar (13,149) or a third IP" — the value trails the
  // phrase). NEVER the first bare one: prose between phrase and value (a PR
  // cite, a build id) is exactly the mis-parse class of review B3.
  const pick = candidates.find((c) => c.anchored) ?? (candidates.length ? candidates[candidates.length - 1] : null);
  return pick ? pick.n : null;
}

// ── Measured precision ────────────────────────────────────────────────────────

export const FAMILY_PRECISION_WINDOW = 5;
export const FAMILY_NOISY_MIN = 3;

export interface FamilyCloseRow {
  id: string;
  title: string;
  type?: string;
  status: string;
  adminNote: string | null;
  context: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface FamilyPrecision {
  family: TicketFamilyKey;
  considered: number;
  falsePositives: number;
  siblings: number;
  trueDefects: number;
  unknown: number;
  /** ≥ FAMILY_NOISY_MIN of the last FAMILY_PRECISION_WINDOW closes were false positives or siblings. */
  noisy: boolean;
}

/** True when the row was closed by THIS module's absorption (never part of the
 *  precision measure — the dispatcher's own output must not feed its routing). */
export function isAbsorbedRow(row: { context?: unknown }): boolean {
  const a = ctxOf(row).absorbedByClassFix;
  return !!a && typeof a === 'object';
}

/** Precision over a family's closes (NEWEST first). Pure. */
export function familyPrecision(family: TicketFamilyKey, closesNewestFirst: ReadonlyArray<FamilyCloseRow>): FamilyPrecision {
  const window = closesNewestFirst.filter((r) => isClosedTicketStatus(r.status) && !isAbsorbedRow(r)).slice(0, FAMILY_PRECISION_WINDOW);
  const out: FamilyPrecision = { family, considered: window.length, falsePositives: 0, siblings: 0, trueDefects: 0, unknown: 0, noisy: false };
  for (const r of window) {
    const c = classifyFamilyClose(r);
    if (c === 'false_positive') out.falsePositives++;
    else if (c === 'sibling') out.siblings++;
    else if (c === 'true_defect') out.trueDefects++;
    else out.unknown++;
  }
  out.noisy = out.falsePositives + out.siblings >= FAMILY_NOISY_MIN;
  return out;
}

/** One-line human summary of a precision verdict (notes, telemetry, briefs). Pure. */
export function precisionSummary(p: FamilyPrecision): string {
  return `${p.falsePositives} false positive${p.falsePositives === 1 ? '' : 's'} + ${p.siblings} sibling${p.siblings === 1 ? '' : 's'} in its last ${p.considered} close${p.considered === 1 ? '' : 's'}`;
}

// ── Class-fix absorption ──────────────────────────────────────────────────────

export interface AbsorbKey {
  key: string;
  /** The family's instances are different subjects (owner questions / chats /
   *  root causes): a fix of one never covers another, so the class is never
   *  auto-closed — a detector (false-positive) fix only earns the pending
   *  members a re-check line in the family lane's brief. */
  detectorWide: boolean;
}

/** The absorb class of a family row, or null when the family has none (the
 *  log families' instances ARE distinct classes — one fix never covers another
 *  signature — and exact repeats already dedup to one row). av-mishap is
 *  detector-wide (review 2026-10-20): its title classes ("phantom action
 *  claim: chat asserted action(s) never executed") span every chat and many
 *  root causes, so one member's fix proves nothing about another. Pure. */
export function familyAbsorbKey(family: TicketFamilyKey, row: { title?: unknown; context?: unknown }): AbsorbKey | null {
  const ctx = ctxOf(row);
  const title = String(row.title ?? '');
  if (family === 'raw-marker') {
    const marker = typeof ctx.marker === 'string' && ctx.marker ? ctx.marker : /^raw marker ([a-z_]+)/i.exec(title)?.[1] ?? '';
    return marker ? { key: `raw-marker:${marker.toUpperCase()}`, detectorWide: false } : null;
  }
  if (family === 'incomplete-card' || family === 'missed-bug' || family === 'av-mishap') return { key: family, detectorWide: true };
  return null;
}

export interface ClassFix {
  ticketId: string;
  /** When the fix CLOSED (context.closedAt, else the done-bar handoff time) — never updatedAt. */
  fixedAt: Date;
  key: string;
  commitSha?: string;
  /** A detector-wide class: never absorbs, only re-check hints (absorbVerdict returns null). */
  detectorWide: boolean;
}

/**
 * The status-write patch that stamps a close TIME (context.closedAt): only on
 * a transition INTO a closed or awaiting-verification status from an owed
 * one — the verifier's later awaiting_verification → deployed_verified /
 * done write keeps the lane's close time, and a re-close after a reopen
 * stamps afresh. null = no stamp. Pure.
 */
export function closeStampPatch(prevStatus: unknown, nextStatus: unknown, nowIso: string): { closedAt: string } | null {
  const ended = (s: unknown): boolean => isClosedTicketStatus(s) || String(s ?? '').trim().toLowerCase() === 'awaiting_verification';
  if (typeof nextStatus !== 'string' || !ended(nextStatus) || ended(prevStatus)) return null;
  return { closedAt: nowIso };
}

/**
 * When a closed row's fix CLOSED, or null when no explicit time was recorded.
 * context.closedAt (closeStampPatch) first, else the done-bar handoff time
 * (context.verification.queuedAt — the lane's close of a metric ticket).
 * Never updatedAt: it moves on every later write (the lane-archive stamp a
 * family lead gets only after its LAST rider closes, the verifier's verdict,
 * a counter bump on a done row) and would read a post-fix recurrence as
 * "predating the fix". Never later than updatedAt either. Pure.
 */
export function classFixTimeMs(row: { updatedAt?: unknown; context?: unknown }): number | null {
  const ctx = ctxOf(row);
  const ver = ctx.verification && typeof ctx.verification === 'object' ? (ctx.verification as Ctx) : {};
  const stamp = [ctx.closedAt, ver.queuedAt].map((v) => (typeof v === 'string' ? Date.parse(v) : NaN)).find((n) => Number.isFinite(n));
  if (stamp === undefined) return null;
  const updated = row.updatedAt instanceof Date ? row.updatedAt.getTime() : Date.parse(String(row.updatedAt ?? ''));
  return Number.isFinite(updated) ? Math.min(stamp, updated) : stamp;
}

/**
 * The NEWEST merged fix per absorb class in a family's closes (newest first).
 * Instance-keyed class: any non-sibling close with fix evidence. Detector-wide
 * class: only a close the lane recorded as a FALSE POSITIVE that shipped a
 * COMMIT (a detector narrowing) — and it is a re-check hint, never an
 * absorption. A close with no explicit close time (classFixTimeMs) is never a
 * fix anchor (fail toward delivery). Pure.
 */
export function latestClassFixes(family: TicketFamilyKey, closesNewestFirst: ReadonlyArray<FamilyCloseRow>): Map<string, ClassFix> {
  const out = new Map<string, ClassFix>();
  for (const r of closesNewestFirst) {
    if (!isClosedTicketStatus(r.status) || isAbsorbedRow(r)) continue;
    if (!hasFixEvidence(r)) continue;
    const cls = classifyFamilyClose(r);
    if (cls === 'sibling') continue; // a duplicate link records redundancy, never a fix
    const ak = familyAbsorbKey(family, r);
    if (!ak || out.has(ak.key)) continue;
    const commitSha = fixCommitSha(r.adminNote);
    if (ak.detectorWide && (cls !== 'false_positive' || !commitSha)) continue; // only a shipped detector narrowing
    const fixedMs = classFixTimeMs(r);
    if (fixedMs === null) continue;
    out.set(ak.key, { ticketId: r.id, fixedAt: new Date(fixedMs), key: ak.key, detectorWide: ak.detectorWide, ...(commitSha ? { commitSha } : {}) });
  }
  return out;
}

const timeMs = (v: unknown): number => (v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN);

/** When the sighting was LAST seen: the first sighting (context.observedAt —
 *  the detector's event time; framework-signal-sweep stamps it and its 2 h
 *  lookback files events that happened before a fix deployed — never later
 *  than createdAt) or any later dedup bump (context.lastSeen, the sightings
 *  trail's filedAt), whichever is NEWEST. A row first seen before a fix but
 *  bumped after it is a post-fix recurrence. Pure. */
export function sightingTimeMs(row: { createdAt?: unknown; context?: unknown }): number {
  const ctx = ctxOf(row);
  const created = timeMs(row.createdAt);
  const observed = timeMs(ctx.observedAt);
  const first = Number.isFinite(observed) && (!Number.isFinite(created) || observed <= created) ? observed : created;
  const trail = Array.isArray(ctx.sightings) ? ctx.sightings.map((s) => timeMs(s && typeof s === 'object' ? (s as Ctx).filedAt : undefined)) : [];
  const later = [timeMs(ctx.lastSeen), ...trail].filter((n) => Number.isFinite(n));
  return later.length ? Math.max(Number.isFinite(first) ? first : -Infinity, ...later) : first;
}

/** True when no ticket lane ever carried this row: no live dispatch, no
 *  earlier lane (the dispatcher's undispatchedContext keeps previousLanes and
 *  laneDispatches when it hands a row back to open), no "Auto re-dispatch
 *  stopped" human-look flag. Pure. */
export function neverLaned(row: { adminNote?: unknown; context?: unknown }): boolean {
  const ctx = ctxOf(row);
  if (typeof ctx.dispatchedTo === 'string' && ctx.dispatchedTo.trim()) return false;
  if (Array.isArray(ctx.previousLanes) && ctx.previousLanes.length) return false;
  if (typeof ctx.laneDispatches === 'number' && ctx.laneDispatches > 0) return false;
  return !/^\s*Auto re-dispatch stopped/.test(String(row.adminNote ?? ''));
}

type PendingRow = { id: string; title?: unknown; status?: unknown; createdAt?: unknown; adminNote?: unknown; context?: unknown };

/** The fix of this row's class it predates, or null — shared by absorbVerdict / detectorRecheckVerdict. */
function predatedFix(family: TicketFamilyKey, row: PendingRow, fixes: ReadonlyMap<string, ClassFix>): ClassFix | null {
  if (row.status !== 'open' && row.status !== 'queued') return null;
  if (ctxOf(row).autoDispatch === false || !neverLaned(row)) return null;
  const ak = familyAbsorbKey(family, row);
  if (!ak) return null;
  const fix = fixes.get(ak.key);
  if (!fix || fix.ticketId === row.id) return null;
  const seen = sightingTimeMs(row);
  return Number.isFinite(seen) && seen < fix.fixedAt.getTime() ? fix : null;
}

/**
 * The class fix a sighting should be ABSORBED into, or null. Only an
 * instance-keyed class (never detector-wide), only a row no lane ever carried
 * (neverLaned), still open or queued (a verifier-'reopened' row means a fix
 * FAILED — never absorbed), not the fix itself, whose LATEST sighting
 * predates the fix's close. The caller additionally requires a
 * dispatcher-written note (a lane / admin progress note is never closed
 * over). Pure.
 */
export function absorbVerdict(family: TicketFamilyKey, row: PendingRow, fixes: ReadonlyMap<string, ClassFix>): ClassFix | null {
  const fix = predatedFix(family, row, fixes);
  return fix && !fix.detectorWide ? fix : null;
}

/** The detector narrowing a pending DETECTOR-WIDE sighting predates (the
 *  family lane re-checks it against the narrowed detector), or null. Pure. */
export function detectorRecheckVerdict(family: TicketFamilyKey, row: PendingRow, fixes: ReadonlyMap<string, ClassFix>): ClassFix | null {
  const fix = predatedFix(family, row, fixes);
  return fix && fix.detectorWide ? fix : null;
}

/** The trusted brief line a family lane reads when some members predate a
 *  detector narrowing. Only server-generated ids, a hex sha and an ISO time —
 *  never reporter text (the line rides OUTSIDE the untrusted fence). Pure. */
export function detectorRecheckLine(family: TicketFamilyKey, fix: ClassFix, memberIds: ReadonlyArray<string>): string | null {
  const ids = memberIds.filter((id) => /^[A-Za-z0-9_-]{6,64}$/.test(id));
  if (!ids.length || !/^[A-Za-z0-9_-]{6,64}$/.test(fix.ticketId)) return null;
  const sha = fix.commitSha && /^[0-9a-f]{7,40}$/.test(fix.commitSha) ? ` (commit ${fix.commitSha.slice(0, 12)})` : '';
  return `DETECTOR NARROWED — RE-CHECK: ticket ${fix.ticketId}${sha} recorded the ${family} detector as over-firing and narrowed it at ${fix.fixedAt.toISOString()}; these members were sighted BEFORE that: ${ids.join(', ')}. Re-check each against the narrowed detector: a member it would no longer flag can close as a duplicate of ${fix.ticketId} citing that commit; a member it still flags is a real sighting — work it. Never close one on the narrowing alone.`;
}

/** The adminNote an absorbed sighting carries. Pure. */
export function absorbedNote(fix: ClassFix, family: TicketFamilyKey, nowIso: string): string {
  return `Absorbed at ${nowIso} — this ${family} sighting predates the merged class fix in ticket ${fix.ticketId}${fix.commitSha ? ` (commit ${fix.commitSha.slice(0, 12)})` : ''}, closed ${fix.fixedAt.toISOString()}. Recorded as a linked duplicate of that fix, NOT dispatched. If the class recurs after the fix, the filer files a fresh ticket — re-open this one only if it is a DIFFERENT defect.`;
}

// ── Notes ──────────────────────────────────────────────────────────────────────

/** Dispatcher-shaped prefixes (ticket-dispatch.service DISPATCHER_NOTE_RE matches both). */
export const FAMILY_QUEUED_NOTE_PREFIX = 'Queued for the next';
export const FAMILY_DAY_WAIT_NOTE_PREFIX = 'Waiting for the next';

/** The note a member filed 'queued' carries. Pure. */
export function familyQueuedNote(p: FamilyPrecision): string {
  return `${FAMILY_QUEUED_NOTE_PREFIX} ${p.family} family lane — this auto-filer family's recent closes were mostly not defects (${precisionSummary(p)}), so its members are batched into at most one lane per UTC day instead of a lane each. It is queued, not lost: the next ${p.family} family lane carries it on its checklist.`;
}

/** The note an OPEN member of a noisy family carries while today's family lane is spent. Pure. */
export function familyDayWaitNote(p: FamilyPrecision): string {
  return `${FAMILY_DAY_WAIT_NOTE_PREFIX} ${p.family} family lane — this family already ran its one lane today (${precisionSummary(p)}); the next one starts after 00:00 UTC and carries this ticket. Queued, not lost.`;
}

/** Redis key of a noisy family's one-lane-per-UTC-day token. */
export const FAMILY_DAY_KEY = (family: TicketFamilyKey, day: string): string => `ticket-dispatch:family-day:${family}:${day}`;
export const FAMILY_DAY_TTL_SEC = 26 * 3600;

/** A HIGH-severity sighting (the sweep's severity stamp) is never queued or day-gated — fail toward delivery. */
export function isHighSeverityRow(row: { context?: unknown }): boolean {
  return ctxOf(row).severity === 'high';
}

/** A row the filing path queued for its family lane. */
export function isFamilyQueuedRow(row: { status?: unknown; context?: unknown }): boolean {
  return row.status === 'queued' && ctxOf(row).familyQueued === true;
}

// ── The one DB read ───────────────────────────────────────────────────────────

/** Closes older than this never steer routing (a family that went quiet re-measures fresh). */
export const FAMILY_HISTORY_LOOKBACK_MS = 21 * 24 * 3600_000;
const FAMILY_HISTORY_TAKE = 200;

export interface FamilyHistory {
  byFamily: Map<TicketFamilyKey, FamilyCloseRow[]>;
  error?: string;
}

/**
 * Recently CLOSED family rows, grouped by family, newest first. One bounded
 * read (the DB filter narrows to family titles + verifier rows; the family
 * classifier re-checks every row in memory, so a looser filter can only cost
 * rows, never misgroup). Never throws — a failed read returns an empty map
 * with `error` (callers then route nothing: the pre-routing behavior).
 */
export async function loadFamilyHistory(now: number = Date.now(), opts: { families?: ReadonlyArray<TicketFamilyKey> } = {}, env: NodeJS.ProcessEnv = process.env): Promise<FamilyHistory> {
  const byFamily = new Map<TicketFamilyKey, FamilyCloseRow[]>();
  try {
    const v2 = !familyPrefixV2Disabled(env);
    const titleFamilies = [...V1_TITLE_FAMILIES, ...(v2 ? V2_TITLE_FAMILIES : [])]
      .filter((f) => !opts.families || opts.families.includes(f.key));
    const wantAv = v2 && (!opts.families || opts.families.includes('av-mishap'));
    const or: Array<Record<string, unknown>> = [
      ...titleFamilies.flatMap((f) => f.dbPrefix.map((p) => ({ title: { startsWith: p, mode: 'insensitive' as const } }))),
      ...(wantAv ? [{ context: { path: ['verifier'], equals: 'action-verifier' } }] : []),
    ];
    if (!or.length) return { byFamily };
    const rows = await prisma.userFeatureRequest.findMany({
      where: {
        status: { in: closedTicketStatusesForQuery() },
        updatedAt: { gte: new Date(now - FAMILY_HISTORY_LOOKBACK_MS) },
        OR: or,
      } as any,
      orderBy: { updatedAt: 'desc' },
      take: FAMILY_HISTORY_TAKE,
      select: { id: true, title: true, type: true, status: true, adminNote: true, context: true, createdAt: true, updatedAt: true },
    });
    const list = (Array.isArray(rows) ? rows : []) as unknown as FamilyCloseRow[];
    const sorted = [...list].sort((a, b) => new Date(b.updatedAt as any).getTime() - new Date(a.updatedAt as any).getTime());
    for (const r of sorted) {
      if (!r || !isClosedTicketStatus(r.status)) continue;
      const fam = ticketFamilyKey(r.title, r, env);
      if (!fam || (opts.families && !opts.families.includes(fam))) continue;
      const arr = byFamily.get(fam) ?? [];
      arr.push(r);
      byFamily.set(fam, arr);
    }
    return { byFamily };
  } catch (err: any) {
    return { byFamily: new Map(), error: String(err?.message ?? err).slice(0, 160) };
  }
}

// ── Owner scope (the F3 dispatch rule, shared with the drain) ─────────────────

/**
 * Owner-only autonomy (audit 2026-10-08 F3, SECURITY) — the PURE rule the
 * dispatcher applies (ticket-dispatch.service ticketDispatchAllowed delegates
 * here): a ticket dispatches on its own only when it is on the lane-home
 * OWNER's account, filed by an ADMIN-role author, or approved by an admin
 * (context.dispatchApproved). A null userId stays held.
 * TICKET_DISPATCH_ANY_USER=1 restores every-account dispatch. Pure.
 */
export function ticketOwnerScopeAllowed(
  t: { userId?: string | null; context?: unknown; user?: { role?: string | null } | null },
  ownerUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.TICKET_DISPATCH_ANY_USER === '1') return true;
  if (ctxOf(t).dispatchApproved === true) return true;
  if (!t.userId) return false;
  if (t.userId === ownerUserId) return true;
  return String(t.user?.role ?? '').toUpperCase() === 'ADMIN';
}

/**
 * Can the FRESH-LANE drain carry a family-queued row? Only the fresh-lane
 * drain reads family-queued rows (the standing-lane batch reads 'open' only),
 * so: fresh lanes on, a lane home resolves (lane-home leaf, dynamic import),
 * and the row is in owner scope. Anything else must file 'open' — where the
 * held-for-owner-review list and the batch drain see it. Never throws (false).
 */
export async function familyQueueScopeAllowed(row: { userId?: string | null; context?: unknown }, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    if (env.TICKET_DISPATCH_FRESH_LANES_DISABLED === '1') return false;
    const { resolveTicketLaneHome } = await import('./lane-home');
    const home = await resolveTicketLaneHome();
    if (!home?.userId) return false;
    if (ticketOwnerScopeAllowed(row, home.userId, env)) return true;
    if (!row.userId) return false;
    const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { role: true } });
    return ticketOwnerScopeAllowed({ ...row, user: { role: user?.role ?? null } }, home.userId, env);
  } catch {
    return false;
  }
}

/**
 * The filing-time route for a NEW auto-filed row: the family's precision when
 * it is noisy AND the fresh-lane drain can carry the row (the row is then
 * filed 'queued'), else null. Never throws. Gated: precision routing on,
 * family batching on (a queued member needs a family lane to ride), not a
 * high-severity sighting, then — only for a noisy family — the drain-carry
 * scope (familyQueueScopeAllowed; review 2026-10-20: a queued row on another
 * account was invisible to the held-for-owner list and stranded forever).
 * `deps.scopeAllowed` is the test seam.
 */
export async function familyFilingRoute(
  row: { title: string; type?: string; context?: unknown; userId?: string | null },
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
  deps: { scopeAllowed?: (r: { userId?: string | null; context?: unknown }) => Promise<boolean> } = {},
): Promise<FamilyPrecision | null> {
  try {
    if (familyPrecisionRoutingDisabled(env) || env.TICKET_FAMILY_BATCHING_DISABLED === '1') return null;
    if (env.TICKET_DISPATCH_FRESH_LANES_DISABLED === '1') return null;
    if (isHighSeverityRow(row)) return null;
    const family = ticketFamilyKey(row.title, row, env);
    if (!family) return null;
    const history = await loadFamilyHistory(now, { families: [family] }, env);
    if (history.error) return null;
    const p = familyPrecision(family, history.byFamily.get(family) ?? []);
    if (!p.noisy) return null;
    const scopeAllowed = deps.scopeAllowed ?? ((r) => familyQueueScopeAllowed(r, env));
    return (await scopeAllowed({ userId: row.userId ?? null, context: row.context })) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Fleet Supervisor durable state doc (2026-08-22 rebuild — the 2026-08-21
 * amnesia incident): the supervisor is a plain chat whose machine wakes
 * reconstruct state from a 12-pair transcript — everything older is forgotten.
 * This module is its durable memory: ONE Postgres row per supervisor chat
 * (supervisor_states), with the rendered doc injected into every machine wake
 * by chat-agent.service (startDetachedChatRun), merged by the supervisor
 * itself via the update_supervisor_state platform tool, and appended-to
 * automatically when the OWNER types in the supervisor chat (a directive —
 * owner messages must survive outside the 12-pair transcript window).
 * REFUTATIONS are verifier-written only (appendVerifierRefutation — the
 * phantom-claim action verifier, PR #295 port): the model's
 * update_supervisor_state merge never touches them, so a proven-false action
 * claim stays visibly refuted in every later wake block.
 *
 * LEAF module: imports ONLY prisma + logger — no crossmodel.service /
 * autonomy.service — so it stays static-import-safe from anywhere (incl. the
 * chat-agent run-start path). Every export is TOTAL: malformed stored state
 * degrades to an empty doc, DB failures degrade to a log line (+ an errors
 * entry on the merge path) — nothing here ever throws, because a state-doc
 * hiccup must never break a run start or a user-message persist.
 */

import { randomUUID } from 'crypto';
import { directiveCloseRelevance, directiveCloseRelevanceDisabled, directiveCloseMismatchNote } from './directive-close-relevance';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
// prisma-only leaf (the store table) — the cold closed-row archive (review 2026-10-22).
import { storeDelete, storeDeleteChatScoped, storeFindByKeyPrefix, storeGet, storeListNamespace, storePut } from '../memory/context-store';
import { redactInboundSecrets } from './secret-scan';
import { ownerProvenanceStrictDisabled } from './owner-authority-switches';
import { evaluateProjectDormancy } from '../coding/dormancy-gate.service';
// The near-cap predicate's single home (ticket b4d1096c) — the DEPENDENCY-FREE
// module, statically imported: pulling ../coding/schedule.service itself would
// drag config/redis → config/env into every suite that imports THIS module
// bare (the 2026-09-21 liveness-suite worker crashes).
import { scheduleNearCapCause } from '../coding/schedule-near-cap';
import { modelToolName } from '../coding/tool-scope';
import { supervisorLedgerSearchable } from '../coding/supervisor-search-scopes';
import { annotateStateLineWithKpi, type KpiView } from './kpi-of-record';
import { loadNeedsYouUnion } from './owner-needs-you';// audit 2026-10-06 T4-9: the shared "is this only a no-op close?" leaf.
import { isNoopOnlyReply, ownerAskNoopReplyDisabled } from '../fleet/supervisor-reply-row';

// ── Doc shape ───────────────────────────────────────────────────────────────

/** Who wrote a directive row — see SupervisorDirective.origin. Only 'owner' and
 *  'owner_question' are OWNER stamps; 'supervisor_answer' / 'default'
 *  (OWNER-PROVENANCE-STRICT, 2026-10-20) bank a supervisor's / a preset
 *  default's answer to a flagged question — harness-written, NOT the owner's. */
export type SupervisorDirectiveOrigin = 'owner' | 'owner_question' | 'supervisor_answer' | 'default';
const DIRECTIVE_ORIGINS: ReadonlySet<string> = new Set(['owner', 'owner_question', 'supervisor_answer', 'default']);
/** Is this a harness OWNER stamp ('owner' | 'owner_question')? The archive keep, the brief's owner
 *  decisions and the owner-directive fan-out key on it — never on 'supervisor_answer' / 'default'. Pure. */
export function isOwnerOriginStamp(origin: unknown): origin is 'owner' | 'owner_question' {
  return origin === 'owner' || origin === 'owner_question';
}

export interface SupervisorDirective {
  id: string;
  text: string;
  at: string; // ISO
  /** 'open' → 'answered' (audit 96fb2f25: a kind:'ask' row the harness marked
   *  when a supervisor reply LANDED — a reply exists, nothing is verified) →
   *  'done' (an outcome close: the model's typed-evidence path only). The
   *  harness never writes 'done' on a mere reply — a board must never show an
   *  owner request as fulfilled while it is unresolved. */
  status: 'open' | 'done' | 'answered';
  evidence?: string; // REQUIRED to close — the anti-phantom-dispatch rule
  /** Never evicted by the cap (remediation P2 v1#3/B6): grant-ish standing
   *  orders ("standing directive", "from now on", "never ask again") set at
   *  capture, or explicitly by the supervisor's own merge. */
  standing?: boolean;
  /** Ticket 661fb494: the directive's SCOPE — the project the owner message
   *  was posted in ('fleet' only for an explicitly fleet-wide message or the
   *  projectless fleet chat). Stamped at capture from the chat's project, or
   *  supplied by the supervisor's own merge. Optional: legacy rows carry none
   *  — a scopeless directive must never be cited cross-project. */
  scope?: string;
  /** Provenance (layered-prompts review fix, 2026-09-27): HARNESS-stamped at
   *  capture — 'owner' by appendDirective (a message the owner typed into the
   *  chat), 'owner_question' by appendAnsweredQuestionDirective (an
   *  owner-answered oq row). The model merge (update_supervisor_state) can
   *  NEVER set it: its add / update paths build rows from an explicit field
   *  list that has no origin, and parseDoc keeps only the two literal values
   *  — so a row that carries it is owner-origin by construction, and a row
   *  WITHOUT it (legacy, or supervisor-written) is never promoted into a
   *  stored prompt as an owner decision (project-brief.loader.ts filters on
   *  it — the lane-authored "band table" / "owner decision" class that rule
   *  halt.owner-words exists for).
   *  OWNER-PROVENANCE-STRICT (2026-10-20): appendAnsweredQuestionDirective
   *  stamps a SUPERVISOR's answer 'supervisor_answer' and a preset default
   *  'default' — harness provenance, never an owner stamp (isOwnerOriginStamp). */
  origin?: SupervisorDirectiveOrigin;
  /** Set when the harness moved the row to `archived` (autonomy loop #6). */
  archivedAt?: string;
  /** tt-rd audit 2026-09-27 (finding upward-chatter-3): an owner STATUS
   *  QUESTION ("any progress?", "where are we at") captured as an ASK — it
   *  stays visible under OPEN OWNER ASKS until the supervisor's reply lands,
   *  when the harness marks it ANSWERED (closeAskOnReply; audit 96fb2f25 — a
   *  reply is not an outcome, so 'done' is never the stamp). An imperative
   *  directive carries no kind and closes only against typed evidence. */
  kind?: 'ask';
  /** The owner crossmodel_messages row this directive was captured from (asks
   *  need it: the reply-close keys on the ask row's id). */
  messageId?: string;
}

export interface SupervisorDispatch {
  at: string; // ISO
  kind: string; // send_chat_message | start_coding_session | schedule_message | …
  id: string; // the REAL tool-returned id — never a recalled one
  note?: string;
}

export interface SupervisorProjectStatus {
  name: string;
  status: string;
  at: string; // ISO
}

export interface SupervisorStateDoc {
  directives: SupervisorDirective[];
  /**
   * Autonomy loop #6 (2026-09-19): OPEN, non-standing directives older than
   * DIRECTIVE_ARCHIVE_AFTER_MS move here (oldest first) while the live ledger
   * holds more than DIRECTIVE_ARCHIVE_MIN_OPEN open rows. The Fleet Supervisor
   * carried 44 open directives (35 of them > 7 days, the oldest 12 days) that
   * the evidence-gated close could never retire — no artifact exists for
   * "S1+S2 = fleet dev/bench pair" — so ~40 rows were hidden from every wake
   * behind the "NOT shown" line and the consolidation ask went unanswered for
   * 16 h. get_supervisor_state({section:'archived'}) reads them and
   * update_supervisor_state {id, status:'open'} revives one.
   * 2026-10-22 (fs-durable-memory): CLOSED rows the 50-row live cap evicts
   * land here too (capDirectivesIntoArchive) — but only the newest
   * ARCHIVE_HOT_CLOSED_KEEP of them stay in this HOT doc (loaded on every
   * wake); older closed rows spill to the COLD archive (context store, one
   * row per directive — spillClosedArchive), mirrored into memory and read
   * only by get_supervisor_state / a revive / an id lookup.
   */
  archived: SupervisorDirective[];
  /**
   * 2026-10-22: how many CLOSED rows the cold archive holds (harness-written
   * by spillClosedArchive only; the model merge never touches it). Absent ⇒ 0.
   * The wake block's archive line counts with it — no cold read per wake.
   */
  archivedColdCount?: number;
  /**
   * Review 2026-10-23: ids whose cold-archive copy duplicates a row this doc
   * now holds hot (a revive / update pulled it back), kept one write longer.
   * The hot write is a whole-blob read-modify-write and another process's
   * stale write can land AFTER this write's settle — deleting the cold copy
   * in the same write that promoted the row lost it for good. A later write
   * whose BASE read already holds the row hot deletes the copy. Harness-
   * written only (the model merge never touches it); it forces that write's
   * cold listing even when nothing spills. Readers already ignore a cold
   * copy of a hot id.
   */
  coldStaleIds?: string[];
  dispatches: SupervisorDispatch[];
  projects: SupervisorProjectStatus[];
  notes: string;
  /**
   * Verifier-written refutation lines (newest first) — durable proof that a
   * narrated action claim was FALSE. Written ONLY by appendVerifierRefutation
   * (the phantom-claim action verifier); applyStateUpdate never touches this
   * list, so the supervisor's own merge can neither forge nor erase one.
   */
  refutations: string[];
  /**
   * Ticket a5b36dc6: ISO time of the LAST user preemption of a machine run on
   * this supervisor chat, or '' when none is live. Harness-written ONLY
   * (markPreemptedInflight, called from the preempt path) — the model's
   * update_supervisor_state merge never touches it, so it can neither forge a
   * "there was a preemption" story nor erase one. A fresh marker makes the
   * wake/owner-turn path render the [PREEMPTED RUN — ACTION IN FLIGHT] block
   * from a LIVE re-read of the tool-intent journal (unsettled rows = the
   * interrupted run's calls that may still land), so the next turn VERIFY
   * before claiming an action out or not-out instead of answering "from
   * earlier context" and retracting claims that had actually executed.
   */
  inflightPreemptAt: string;
}

/** What the supervisor's update_supervisor_state call may merge in. Fields are
 *  LOOSELY typed (the model supplies them) — every value is validated at merge. */
export interface SupervisorStateUpdate {
  directives?: Array<{ id?: string; text?: string; status?: string; evidence?: string; standing?: boolean; scope?: string }>;
  dispatches?: Array<{ kind?: string; id?: string; note?: string }>;
  projects?: Array<{ name?: string; status?: string }>;
  notes?: string;
}

export interface SupervisorStateUpdateResult {
  applied: string[];
  errors: string[];
}

// Caps — the doc must stay small enough to inject into EVERY wake.
const MAX_DIRECTIVES = 50;
const MAX_DISPATCHES = 30;
const MAX_PROJECTS = 20;
const MAX_DIRECTIVE_TEXT = 500;
const MAX_EVIDENCE = 500;
const MAX_DIRECTIVE_SCOPE = 60; // ticket 661fb494 — project name or 'fleet'
const MAX_DISPATCH_NOTE = 300;
const MAX_PROJECT_STATUS = 200;
const MAX_NOTES = 4000;
const MAX_REFUTATIONS = 10;

/** fixer 2026-09-27 (finding upward-chatter-5): a dispatch with the same
 *  kind + id recorded within this window is the SAME action re-merged (the
 *  owner-turn empty retry replays the whole turn) — not a second row. */
export const DISPATCH_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
function withinDispatchDedupeWindow(atIso: string): boolean {
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) return false; // an undated legacy row never blocks a fresh record
  return Date.now() - t <= DISPATCH_DEDUPE_WINDOW_MS;
}
const MAX_REFUTATION = 300;
/** Directive archive (autonomy loop #6): age past which an OPEN non-standing row leaves the wake block … */
export const DIRECTIVE_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** … but only while the live ledger holds MORE than this many open non-standing rows (a short ledger keeps its history in view).
 *  Live 2026-09-19 17:20Z: at 15 the Fleet Supervisor's 15 remaining ≤500-char rows still overflowed the 6000-char wake block by 4
 *  ("NOT shown" persisted); at 10 every live row renders. Rows younger than 7 d never archive regardless of this floor. */
export const DIRECTIVE_ARCHIVE_MIN_OPEN = 10;
const MAX_ARCHIVED = 200;
// ── Directive age alarm (supervisor-directives-closure D2, 2026-09-27) ────────
// The canlaw H100-move order sat 41 h unacted and spark carried 6
// archived-but-open directives: a directive had no AGE alarm (open|done only,
// the 7-day archive kept status open and hid the row), so an order the
// supervisor never touched looked exactly like one it was working. Three
// surfaces: the wake-block line below (`formatStateForWake`), the
// [FOLLOW-THROUGH — DIRECTIVE] direct wake at 24 h and the daily
// `directive_open_age` loop metric (both in
// platform/directive-age.service.ts, riding the attention watchdog). "Unacted"
// = OPEN, non-standing, with NO evidence recorded — recording a blocker as
// evidence on the open row ({id, evidence}) clears the alarm without closing.
/** Age past which an unacted directive is named on the wake-block alarm line. */
export const DIRECTIVE_AGE_ALARM_MS = 48 * 60 * 60 * 1000;
/** Age past which an unacted directive earns a [FOLLOW-THROUGH — DIRECTIVE] wake (once per directive per 24 h). */
export const DIRECTIVE_FOLLOW_THROUGH_MS = 24 * 60 * 60 * 1000;
/** Ids named on the wake-block alarm line. */
export const DIRECTIVE_AGE_ALARM_MAX_IDS = 6;

export interface UnactedDirective extends SupervisorDirective {
  ageMs: number;
  /** True when the row lives in `archived` (hidden from the wake block) rather than the live ledger. */
  archived: boolean;
}

/**
 * OPEN, non-standing directives (live AND archived — an archived-but-open row
 * is the D2 blind spot) with NO evidence recorded and a parseable `at` at least
 * `minAgeMs` old, oldest first. Pure; exported for tests and the age sweep.
 */
export function unactedDirectives(doc: SupervisorStateDoc, now: Date = new Date(), minAgeMs: number = DIRECTIVE_AGE_ALARM_MS): UnactedDirective[] {
  const out: UnactedDirective[] = [];
  const consider = (rows: SupervisorDirective[], archived: boolean) => {
    for (const d of rows) {
      if (d.status !== 'open' || d.standing === true) continue;
      if (typeof d.evidence === 'string' && d.evidence.trim()) continue;
      const t = Date.parse(d.at);
      if (!Number.isFinite(t)) continue;
      const ageMs = now.getTime() - t;
      if (ageMs < minAgeMs) continue;
      out.push({ ...d, ageMs, archived });
    }
  };
  consider(doc.directives, false);
  consider(doc.archived, true);
  return out.sort((a, b) => b.ageMs - a.ageMs);
}

/**
 * audit 2026-10-06 T4-3 / T4-4 (spark.md F3/F5, others.md F10): OPEN
 * OWNER-ORIGIN directives on the live ledger — rows the HARNESS stamped
 * origin 'owner' at capture (an owner message typed into this supervisor
 * chat; asks and orders alike, standing ones included) whose `at` is within
 * `windowMs` (default 7 days — the archive horizon; an unparseable `at`
 * counts). Supervisor-written rows (no origin) never count — a model can not
 * keep its own sweep alive by writing itself an order. `newSince` = the
 * subset captured at/after `sinceMs`. Pure.
 */
export const OPEN_OWNER_DIRECTIVE_WINDOW_MS = DIRECTIVE_ARCHIVE_AFTER_MS;
export function countOpenOwnerDirectives(
  doc: SupervisorStateDoc,
  now: Date = new Date(),
  opts: { sinceMs?: number; windowMs?: number } = {},
): { open: number; newSince: number; ids: string[] } {
  const windowMs = opts.windowMs ?? OPEN_OWNER_DIRECTIVE_WINDOW_MS;
  const out = { open: 0, newSince: 0, ids: [] as string[] };
  for (const d of doc?.directives ?? []) {
    if (d?.status !== 'open' || d.origin !== 'owner') continue;
    const t = Date.parse(d.at);
    if (Number.isFinite(t) && now.getTime() - t > windowMs) continue;
    out.open += 1;
    if (out.ids.length < 6) out.ids.push(String(d.id ?? '').slice(0, 8));
    if (opts.sinceMs != null && (!Number.isFinite(t) || t >= opts.sinceMs)) out.newSince += 1;
  }
  return out;
}

/** Every verifier refutation line starts with this — the wake block labels the section by it. */
export const VERIFIER_REFUTATION_PREFIX = 'VERIFIER REFUTED';

// ── Refutation TTL (MIND-HYGIENE, 2026-10-20) ────────────────────────────────
// The doc keeps the 10 newest refutations with no age bound, and the wake
// block rendered all of them: on the Fleet Supervisor six lines from
// 2026-09-01 (49 days old) took 1,919 of the block's 5,834 chars — a third of
// every wake's state spent restating month-old convictions. The wake block now
// renders only refutations from the last REFUTATION_RENDER_TTL_MS plus ONE
// 30-day class tally line (counts by class, how many lines are hidden, where
// to read them), and on overflow trims refutations older than
// REFUTATION_TRIM_EARLY_AFTER_MS BEFORE notes. Nothing is deleted —
// get_supervisor_state({section:'refutations'}) reads every stored line.
// Kill switch SUPERVISOR_REFUTATION_TTL_DISABLED=1 restores the full list and
// the old trim order.
export const REFUTATION_RENDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REFUTATION_TALLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const REFUTATION_TRIM_EARLY_AFTER_MS = 24 * 60 * 60 * 1000;

export function refutationTtlDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.SUPERVISOR_REFUTATION_TTL_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

const REFUTATION_STAMP_RE = new RegExp(`^\\s*${VERIFIER_REFUTATION_PREFIX}\\s*\\(([^)]+)\\)\\s*`);

/** The ISO stamp appendVerifierRefutation writes into a line, as epoch ms (null when absent / unparseable). Pure. */
export function refutationAtMs(line: string): number | null {
  const m = REFUTATION_STAMP_RE.exec(String(line ?? ''));
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

/**
 * The conviction class of a refutation line: the first `[tag]` the action
 * verifier put at the head of its detail ('[evidence citation]', '[vanished
 * artifact]', '[in send_chat_message args]' …), lowercased; an untagged
 * detail is an 'action claim' (the verifier's default lane). Pure.
 */
export function refutationClass(line: string): string {
  const s = String(line ?? '').replace(REFUTATION_STAMP_RE, '');
  const m = /^\s*\[([^\]]{1,40})\]/.exec(s);
  if (!m) return 'action claim';
  const tag = m[1].trim().toLowerCase();
  // '[in <tool> args]' carries the tool name — the class is "in tool args".
  return /^in \S+ args$/.test(tag) ? 'in tool args' : tag;
}

/**
 * The 30-day class tally line for the wake block, or '' when nothing is
 * hidden (every stored line renders) or no refutation falls inside the
 * window. `stored` is the doc's newest-first list; `hidden` is how many of
 * them the block does not show (TTL + overflow trim). A list at the doc cap
 * whose lines are ALL inside the window reads "N+" — older convictions were
 * evicted by the cap, so the count is a floor. Pure.
 */
export function refutationTallyLine(stored: ReadonlyArray<string>, now: Date, hidden: number): string {
  if (hidden <= 0) return '';
  const nowMs = now.getTime();
  const counts = new Map<string, number>();
  let inWindow = 0;
  for (const r of stored) {
    const at = refutationAtMs(r);
    if (at === null || nowMs - at > REFUTATION_TALLY_WINDOW_MS) continue;
    inWindow += 1;
    const cls = refutationClass(r);
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  const saturated = stored.length >= MAX_REFUTATIONS && inWindow === stored.length;
  const days = Math.round(REFUTATION_TALLY_WINDOW_MS / 86_400_000);
  const ttlDays = Math.round(REFUTATION_RENDER_TTL_MS / 86_400_000);
  const read = `get_supervisor_state({section:'refutations'}) lists every stored line`;
  if (!inWindow) return `- (${hidden} refutation line(s) older than ${days} d not shown — ${read}.)`;
  const classes = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c, n]) => `${c} ×${n}`).join(', ');
  return `- (refutations in the last ${days} d: ${inWindow}${saturated ? '+' : ''} — ${classes}; ${hidden} line(s) older than ${ttlDays} d or trimmed for space not shown — ${read}.)`;
}
/**
 * Ticket f5b94615 (2026-09-15): the dispatches section is a HISTORICAL ledger —
 * every entry ran on a PRIOR wake. Unmarked, its lines render in the exact
 * 'kind → id' receipt shape the wake-close contract demands for this-wake
 * ACTIONS TAKEN, and a wake re-cites one as a fresh receipt (the 08:02Z
 * project-supervisor phantom-send strike: zero consequential actions in the
 * journal, id lifted from history). The header must say so explicitly — the
 * same framing the refutations section already carries.
 */
export const RECENT_DISPATCHES_HEADER =
  'RECENT DISPATCHES (HISTORICAL LEDGER — these actions ran on PRIOR wakes, NOT this one: never re-cite these ids as ACTIONS TAKEN or this-wake receipts; the action verifier strikes a re-cited id as a phantom):';
/** Hard cap on the whole rendered wake block (drop oldest dispatches, then truncate notes). */
export const WAKE_BLOCK_CAP = 6000;

const SOURCE = 'supervisor-state';

// ── Directive-ledger integrity (remediation P2 v1#3 / spark B6, 2026-09-09) ──
// The 21:17Z incident class: an OPEN owner directive silently evicted by the
// blind newest-50 slice is an owner order the fleet forgets. Eviction now
// removes DONE (non-standing) rows oldest-first, NEVER an open or standing
// one; an all-open overflow keeps every row (the effective cap raises) and
// emits a `directive_overflow` loop metric so the pressure is observable.

/** Grant-ish standing phrasing — captured directives matching this are flagged
 *  standing:true and are NEVER evicted by the cap. */
export const STANDING_DIRECTIVE_RE =
  /\b(standing (directive|order|approval|instruction)|from now on|going forward|always (deploy|ship|do|allow|merge)|never ask (again|me)|don'?t ask (again|me|for approval)|do not ask (again|me))\b/i;

/** Pure acks / status questions — NOT directives (remediation P2 B6): the
 *  capture path skips them so "how did it go" / "ok thanks" never occupy
 *  ledger slots. Deliberately narrow: anything with imperative content stays. */
export const ACK_DIRECTIVE_RE =
  /^((ok(ay)?|k|kk|thanks?|thank you|thx|ty|great|nice|cool|good|perfect|awesome|sounds good|got it|will do|👍|🙏|lgtm)[,.!\s]*)+$/i;
const STATUS_QUESTION_RE =
  /^(how('s| is| did| are)? (it|that|things?|the \w+( \w+)?) (go(ing)?|coming( along)?|look(ing)?|work(ing)?( out)?)|any (update|progress|news)|status|what('s| is) the status( of [\w\s-]+)?|did (it|that) work|progress|are (we|you) (done|there yet))\??[.!\s]*$/i;

/** True when an owner message is a pure ack or a bare status question — it
 *  should not be recorded as a directive. Pure; exported for tests. */
export function isAckOrStatusQuestion(text: string): boolean {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  if (ACK_DIRECTIVE_RE.test(t)) return true;
  if (t.length <= 80 && STATUS_QUESTION_RE.test(t)) return true;
  return false;
}

/** Owner STATUS-QUESTION openers the narrow STATUS_QUESTION_RE missed (tt-rd
 *  audit 2026-09-27: 'any progress ?', 'any new progress', 'where are we at',
 *  'what are you doing', 'any successes recently…', 'how are we looking?…'
 *  were all captured as OPEN DIRECTIVES and never closed). Anchored on the
 *  OPENER — no length limit — so a long status ping with a tail ("where are
 *  we at with the rebase, it has been two days") still reads as an ask.
 *  Exported for tests. */
export const OWNER_ASK_OPENER_RE =
  /^(?:(?:any|anything|some) (?:new |recent |more |real |actual )?(?:progress|update|updates|news|breakthrough|breakthroughs|success|successes|change|changes|movement|luck|results?)\b|(?:where|how) are (?:we|you|things)(?: at| looking| doing| going| coming(?: along)?)?\b|what(?:'?s| is| are)? (?:going on|happening|new|you doing|the (?:latest|newest|current)|the (?:hold ?up|delay))\b|(?:status|progress|update|eta) ?\?*$|why (?:is|are) (?:this|it|you|we) (?:taking|so slow|still)\b|(?:is|are) (?:it|this|that|we|you) (?:done|finished|working|ready|there yet|still going)\b|did (?:it|that|this|anything) (?:work|land|finish|merge|move)\b|how (?:far|close) (?:are we|is it)\b)/i;

// ── State-complaint asks (ticket b03d7033, 2026-10-20) ──────────────────────
// The mishap this closes: an owner asks "why do i still see no <expected-thing>?
// and i still see <wrong-thing>?" — a QUESTION in shape, but it asserts a
// mismatch between what the owner expects and what the system shows, and the
// expectation is the order ("the endpoint SHOULD be named X; the stale routes
// SHOULD NOT be listed"). The specimen replies (03:28Z ask, 03:29Z reply) were
// explanation-only ("the bare name is deliberate") — closeAskOnReply stamped the
// ask 'answered', the row left every wake, and the unmet order died in that
// lane's transcript with no action and no report-up. The upward-chatter-2
// 'ask_directive' twin is exactly the remedy; this register adds the frame that
// cue missed: an interrogative STATE COMPLAINT (why / how come … + still see /
// don't see / missing / not showing) carries an implicit order cue, so it
// ledgers BOTH rows — the ask (closable on reply) and the plain directive twin
// (closable only on typed evidence), same messageId. Deliberately narrow: a
// bare why-question without a complaint verb stays a pure ask.
const STATE_COMPLAINT_OPENER_RE = /^(?:and|also|but|so|ok(?:ay)?|now|then)[,.!\s]*(?:why|how come)\b|^(?:why|how come)\b/i;
const STATE_COMPLAINT_BODY_RE = /\b(?:still (?:see|don'?t see|do not see|getting|listed|showing)|(?:don'?t|do not|no longer) see\b|isn'?t (?:showing|listed|there|available|appearing)|doesn'?t (?:show|appear|exist)|there(?:'?s| is| are)? no\b|missing|not showing|not listed|nowhere to be found|not there|not available)\b/i;
/** True when an owner message is an interrogative STATE COMPLAINT — a question
 *  that asserts an expected-vs-shown mismatch and thereby orders the fix. Pure;
 *  exported for tests (the b03d7033 replay pins both specimen messages). */
export function isStateComplaintAsk(text: string): boolean {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (!STATE_COMPLAINT_OPENER_RE.test(t)) return false;
  return STATE_COMPLAINT_BODY_RE.test(t);
}

export type OwnerMessageKind = 'ack' | 'ask' | 'directive' | 'ask_directive';

// Imperative content INSIDE an opener-led message (fixer 2026-09-27, finding
// upward-chatter-2): the openers above have no length cap, so an owner ORDER
// that starts with a status phrase — "what are you doing about the truncated
// log — restore it from git history", "any update — if the ladder still has 0
// adoptions kill it", "is it done? if so merge to main", "why are you taking
// so long cant you spawn more sessions" — read as a pure 'ask' and
// closeAskOnReply retired the order on the first reply (the 21:17Z incident
// class the ledger exists to prevent). Deterministic, cheap, no gate: a cue
// here only ADDS a plain directive row next to the ask row. The cues are
// request modals ("can you", "could you", "can't you"), "please", "you
// should / need to / must", the conditional orders "if so" / "if not",
// "don't", and an order verb that follows a separator or conjunction with an
// object/particle after it ("— restore it", "and start the rebase", "; use
// one PR", "stop appending"). Question auxiliaries are neutralised first so
// "did you check the probe?" / "are you stuck on the bisect?" stay asks.
const ORDER_VERB =
  '(?:restore|revert|roll ?back|stop|start|kill|merge|cut|report|use|spawn|fix|ship|deploy|rebase|archive|switch|run|add|remove|cancel|pause|resume|retire|move|rename|delete|drop|prioriti[sz]e|focus|keep|make|get|send|post|push|pull|open|close|file|create|update|change|set|try|check|look|find|figure|tell|give|show|write|read|test|verify|measure|benchmark|schedule|dispatch|redirect|reassign|escalate|answer|reply|respond|hold|wait|skip|ignore|include|exclude|limit|raise|lower|increase|decrease|double|halve|reduce|bump|scale|put|bring|take|go|do|stand down|wrap up|clean up|follow up|re-?run|re-?measure|re-?arm|re-?try|migrate|upgrade|downgrade|install|build|serve|restart|reboot|nudge|steer|ping|message|notify|ask|assign|unblock|split|land|sync|subscribe|unsubscribe|enable|disable|turn)';
const ORDER_OBJECT =
  '(?:it|them|this|that|these|those|the|a|an|one|to|on|off|up|down|all|everything|your|our|my|its|now|today|tonight|tomorrow|immediately|asap|first|instead|again|more|fewer|less|back|out|in|over|away|ahead|sure|at|with|for|from|into|onto|\\w+ing)';
export const OWNER_ORDER_CUE_RE = new RegExp(
  "\\b(?:can'?t|cannot|could|would|will|can) (?:you|we|someone|somebody)\\b" +
  '|\\b(?:please|pls|plz)\\b' +
  '|\\b(?:you|we) (?:should|need to|must|have to|ought to|gotta|had better)\\b' +
  '|\\bif (?:so|not)\\b' +
  "|\\b(?:don'?t|do not)\\s+\\w" +
  `|(?:^|[—–\\-:;,.?!]\\s*|\\b(?:and|then|also|but|so|just|now|please|go)\\s+)${ORDER_VERB}\\s+${ORDER_OBJECT}\\b`,
  'i',
);
const QUESTION_AUX_RE = /\b(?:did|do|does|have|has|had|are|is|was|were)(?:n'?t)?\s+(?:you|we|they|it|anyone|anybody|someone)\s+\w+/gi;

/** True when an owner message carries an order cue (see OWNER_ORDER_CUE_RE).
 *  Pure; exported for tests. */
export function hasOwnerOrderCue(text: string): boolean {
  const t = String(text ?? '').replace(/\s+/g, ' ').replace(QUESTION_AUX_RE, 'Q').trim();
  return OWNER_ORDER_CUE_RE.test(t);
}

/** Capture classification for an owner message typed into a supervisor chat
 *  (tt-rd audit 2026-09-27): 'ack' = pure acknowledgement (never ledgered);
 *  'ask' = a status question — ledgered as kind:'ask' so it stays visible
 *  under OPEN OWNER ASKS until the reply lands; 'ask_directive' (fixer
 *  2026-09-27) = an opener-led message that ALSO carries an order — ledgered
 *  as BOTH an ask row (closable on reply) and a plain directive row (closable
 *  only on typed evidence); 'directive' = everything else (an order, closed
 *  only against typed evidence). Pure; exported for tests.
 *  isAckOrStatusQuestion above keeps its byte-identical narrow contract for
 *  the project brief's ask listing (review C7). */
export function classifyOwnerMessage(text: string): OwnerMessageKind {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || ACK_DIRECTIVE_RE.test(t)) return 'ack';
  if (t.length <= 80 && STATUS_QUESTION_RE.test(t)) return 'ask';
  // b03d7033: a state complaint must reach the twin even when an opener
  // alternative matched first — the opener early-return below sits AFTER this
  // check because OWNER_ASK_OPENER_RE's "why is|are … still" band swallows
  // "why is it still not showing the routes?" whole and the ask_directive
  // branch underneath would never run (review finding 2 — dead branch).
  if (OWNER_ASK_OPENER_RE.test(t)) return (hasOwnerOrderCue(t) || isStateComplaintAsk(t)) ? 'ask_directive' : 'ask';
  if (isStateComplaintAsk(t)) return 'ask_directive';
  if (!directiveImperativeOnlyDisabled() && !isImperativeOwnerMessage(t)) return 'ask';
  return 'directive';
}

// ── Only imperative orders become directives (audit 2026-10-08 W1-5 — supervisors F8) ──
// Remarks and questions were captured as closable DIRECTIVES: "i don't see that issue at all",
// "you said you dismissed the owner card but it is still showing", "are you able to get the
// transcriptions from today?", "done?", "??", "progress now ?", "what are you waiting for".
// They spent the Fleet's one daily follow-through wake while a real unacted owner rule (03acdf24)
// was capped, made a supervisor message its own chat to mint close "evidence", and pinned
// sweep_triage. Now a QUESTION (ends in "?", or opens with a question word) without an order cue,
// and a SHORT remark (≤ 160 chars) without an imperative, is ledgered as kind 'ask' — visible under
// OPEN OWNER ASKS and harness-closed by the reply. An order cue, an imperative opening verb
// ("archive any completed sessions"), a standing rule ("make sure / always / never / before using
// …") or a longer statement stays a directive. Kill switch
// SUPERVISOR_DIRECTIVE_IMPERATIVE_ONLY_DISABLED=1.
export function directiveImperativeOnlyDisabled(): boolean {
  return process.env.SUPERVISOR_DIRECTIVE_IMPERATIVE_ONLY_DISABLED === '1';
}
const QUESTION_WORD_OPENER_RE = /^(?:what|why|how|when|where|who|which|whose|are|is|am|do|does|did|can|could|will|would|have|has|had|should|shall|was|were|isn'?t|aren'?t|don'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|can'?t|couldn'?t)\b/i;
const IMPERATIVE_OPENER_RE = new RegExp(`^(?:(?:ok(?:ay)?|so|and|now|then|also|pls|plz|please|just|hey|digby)[,!\\s]+)*${ORDER_VERB}\\b`, 'i');
/** Standing-rule phrasing an owner uses for a policy ("make sure …", "always …", "never …", "before using …"). */
export const STANDING_RULE_CUE_RE = /^(?:(?:please|pls|and|also|from now on,?)\s+)*(?:make sure|ensure|always|never|don'?t ever|do not ever)\b|\bbefore (?:using|you use|touching|running|deploying|merging)\b|\bevery time\b|\bwhenever\b/i;
/** First-person / third-person negated statements ("i don't see …") are remarks, never "don't …" orders. */
const NEGATED_STATEMENT_RE = /\b(?:i|we|it|that|this|they|he|she|you|there)\s+(?:do|does|did)\s?n['o]?t\b/gi;
/** True when an owner message carries an IMPERATIVE (an order) — not just a question or a remark. Pure; exported for tests. */
export function isImperativeOwnerMessage(text: string): boolean {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (hasImperativeCue(t)) return true;
  if (isQuestionShaped(t)) return false;
  return t.length > 160; // a long statement is treated as an order (it usually is one)
}
/** The explicit-imperative half of isImperativeOwnerMessage (no long-statement fallback): a standing-rule
 *  cue, an order cue, or an order verb opening a non-question. `t` is whitespace-normalized. */
function hasImperativeCue(t: string): boolean {
  if (STANDING_RULE_CUE_RE.test(t)) return true;
  if (hasOwnerOrderCue(t.replace(NEGATED_STATEMENT_RE, 'N'))) return true;
  // "do you need me to …" opens with an auxiliary + subject — a question, not the order verb "do".
  const auxQuestion = /^(?:do|does|did|can|could|will|would|should|shall|have|has|had|is|are|was|were|am)\s+(?:you|we|i|they|it|he|she|anyone|anybody|someone|somebody|there|this|that)\b/i.test(t);
  return !auxQuestion && IMPERATIVE_OPENER_RE.test(t);
}
function isQuestionShaped(t: string): boolean {
  return /\?\s*[)\]"'”’]*\s*$/.test(t) || /^\?+$/.test(t) || QUESTION_WORD_OPENER_RE.test(t);
}

// ── Owner rulings on flagged questions (2026-10-20) ──────────────────────────
// A fleet-scope owner RULING given as an owner-question answer or as the note
// on a dismissed card was never ledgered as a directive: answers bank only a
// DONE "Owner ANSWERED …" row (appendAnsweredQuestionDirective) and a
// dismissal note banked nothing. Specimen: the owner dismissed oq_892c91ae
// with "no new Hyperstack IP, ever — the account is shutting down;
// canlegalbench.com comes back from the stanne lab"; it lived only on the
// dismissed card and inside a goal, so other lanes kept acting on the old
// plan. classifyOwnerRuling is deterministic and conservative: an explicit
// order (hasImperativeCue — the same cues the owner-message capture uses)
// of ≥ 4 words (a bare "go ahead" / "yes merge it" is a CHOICE the DONE row
// already banks), or permanence language ("ever", "always", "from now on",
// "shutting down" …) beside a normative word ("should", "must", "no new",
// "only" …). Questions never qualify. Fleet-wide / permanent wording marks
// the row standing. Kill switch OWNER_RULING_CAPTURE_DISABLED=1.
export function ownerRulingCaptureDisabled(): boolean {
  return process.env.OWNER_RULING_CAPTURE_DISABLED === '1';
}
const RULING_PERMANENCE_RE = /\b(?:ever|never|always|from now on|going forward|any ?more|no longer|permanently|for good|shut(?:ting)? down|winding down)\b/i;
const RULING_NORMATIVE_RE = /\b(?:should(?:n'?t)?|must(?:n'?t)?|needs? to|ha(?:s|ve) to|no (?:new|more|longer)|only|don'?t|do not|stop)\b/i;
/** Fleet-wide / permanent wording that makes a ruling STANDING (never evicted, never age-alarmed). */
export const RULING_STANDING_RE = /\b(?:ever|never|always|everything|all|from now on|going forward|permanently|for good|shut(?:ting)? down)\b/i;
const RULING_MIN_ORDER_WORDS = 4;

/** Is this owner answer / dismissal note a RULING, and is it standing? Pure; exported for tests. */
export function classifyOwnerRuling(text: string): { ruling: boolean; standing: boolean } {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || ACK_DIRECTIVE_RE.test(t)) return { ruling: false, standing: false };
  const order = hasImperativeCue(t) && t.split(' ').length >= RULING_MIN_ORDER_WORDS;
  if (!order && isQuestionShaped(t)) return { ruling: false, standing: false };
  const neutral = t.replace(NEGATED_STATEMENT_RE, 'N');
  const permanent = RULING_PERMANENCE_RE.test(neutral) && RULING_NORMATIVE_RE.test(neutral);
  if (!order && !permanent) return { ruling: false, standing: false };
  return { ruling: true, standing: STANDING_DIRECTIVE_RE.test(t) || RULING_STANDING_RE.test(t) };
}


/**
 * Cap eviction that can never silently drop an OPEN owner directive: evict
 * DONE non-standing rows oldest-first until at cap; if the survivors still
 * exceed the cap (all open/standing), keep them ALL — the effective cap
 * raises and `overflow` reports by how much (the caller emits the
 * directive_overflow metric). Pure; exported for tests.
 */
export function evictDirectivesAtCap(
  directives: SupervisorDirective[],
  cap: number = MAX_DIRECTIVES,
): { directives: SupervisorDirective[]; overflow: number; evicted: SupervisorDirective[] } {
  if (directives.length <= cap) return { directives, overflow: 0, evicted: [] };
  const kept = [...directives];
  const evicted: SupervisorDirective[] = [];
  // Oldest-first among evictable rows (done/answered + not standing — audit
  // 96fb2f25: 'answered' rows must evict exactly like 'done', else they squat
  // the cap forever). Array order is chronological (appends), so scan from the front.
  let excess = kept.length - cap;
  for (let i = 0; i < kept.length && excess > 0; ) {
    const d = kept[i];
    if (d.status !== 'open' && d.standing !== true) {
      evicted.push(...kept.splice(i, 1));
      excess -= 1;
    } else {
      i += 1;
    }
  }
  return { directives: kept, overflow: Math.max(0, kept.length - cap), evicted };
}

// ── Cap-evicted closed rows go to the archive (2026-10-22, fs-durable-memory) ─
// The 50-row cap above DELETED done / answered rows, and the memory mirror
// (supervisor-state-memory.ts) deletes the row of every directive that leaves
// the doc — so an owner remark ledgered as kind:'ask', answered on the next
// reply and pushed past the cap a week later was gone from the ledger AND from
// search. The cap now moves those rows to `archived` (stamped archivedAt) like
// the 7-day open archive does: hidden from the wake block, still read by
// get_supervisor_state({section:'archived'}) and still mirrored, so recall /
// search_memory keep finding them. Bounded by the same MAX_ARCHIVED; when the
// archive is full its oldest CLOSED rows go first, so an archived-but-open
// order (the age alarm's subject) is never pushed out by closed history.
// Review 2026-10-22: the HOT doc (loaded by every wake, rewritten by every
// state write) keeps only the newest ARCHIVE_HOT_CLOSED_KEEP closed rows; the
// older ones spill to the COLD archive (spillClosedArchive, below) — a
// realistic Fleet Supervisor doc with a full 200-row archive measured 142k
// JSON chars, 41.6k of it without the closed rows.
// Kill switch SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED=1 restores the
// delete-at-cap and the plain newest-200 archive slice (and stops the spill;
// cold rows already stored stay readable).
export function supervisorLedgerArchiveAnsweredDisabled(): boolean {
  return process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED === '1';
}

/** The archive cut to `cap` rows: oldest CLOSED rows drop first, then (all open) the oldest. Pure. */
export function trimArchive(rows: SupervisorDirective[], cap: number = MAX_ARCHIVED): SupervisorDirective[] {
  if (rows.length <= cap) return rows;
  if (supervisorLedgerArchiveAnsweredDisabled()) return rows.slice(-cap);
  const kept = [...rows];
  let excess = kept.length - cap;
  for (let i = 0; i < kept.length && excess > 0; ) {
    if (kept[i].status !== 'open') { kept.splice(i, 1); excess -= 1; } else i += 1;
  }
  return kept.length > cap ? kept.slice(-cap) : kept;
}

/**
 * The live-ledger cap for one write: evictDirectivesAtCap, and the rows it
 * drops are appended to the archive (archivedAt = now) instead of deleted.
 * Pure — returns the new arrays; the caller assigns them and emits the
 * metrics (`overflow` → directive_overflow, `archivedCount` → directive_cap_archive).
 */
export function capDirectivesIntoArchive(
  doc: Pick<SupervisorStateDoc, 'directives' | 'archived'>,
  now: Date = new Date(),
  cap: number = MAX_DIRECTIVES,
): { directives: SupervisorDirective[]; archived: SupervisorDirective[]; overflow: number; archivedCount: number } {
  const r = evictDirectivesAtCap(doc.directives, cap);
  if (!r.evicted.length || supervisorLedgerArchiveAnsweredDisabled()) {
    return { directives: r.directives, archived: doc.archived, overflow: r.overflow, archivedCount: 0 };
  }
  const stamp = now.toISOString();
  const archived = trimArchive([...doc.archived, ...r.evicted.map((d) => ({ ...d, archivedAt: stamp }))]);
  return { directives: r.directives, archived, overflow: r.overflow, archivedCount: r.evicted.length };
}

/** Apply capDirectivesIntoArchive to a doc in place (the upsertDoc mutate seams). Returns the overflow. */
function applyDirectiveCap(chatId: string, doc: SupervisorStateDoc): number {
  const capped = capDirectivesIntoArchive(doc);
  doc.directives = capped.directives;
  doc.archived = capped.archived;
  if (capped.archivedCount > 0) {
    void import('./loop-metrics.service')
      .then((m) => m.recordLoopMetric({ kind: 'directive_cap_archive', sessionId: chatId, value: capped.archivedCount }))
      .catch(() => {});
  }
  return capped.overflow;
}

// ── Hot / cold closed archive (review 2026-10-22, fs-durable-memory) ──────────
// The hot doc carries every OPEN archived row (the age alarm, the owner-order
// restore and the wake count read them) plus the newest closed ones; older
// CLOSED rows live in the context store, one row per directive id under
// [chatId, 'supervisor-archive'] (no read-modify-write race between two
// writers), bounded to COLD_ARCHIVE_MAX with the oldest dropped first. They
// stay in the memory mirror (supervisor-state-memory embeds them under
// 'archive …' refs) so recall / search_memory still find them;
// get_supervisor_state({section:'archived'}), a revive by id and the
// directive id lookup read them on demand. The spill writes the cold rows
// BEFORE the hot doc drops them, so a failed store write keeps them hot.
/** Closed archived rows the HOT doc keeps (newest by archive order); older closed rows spill cold. */
export const ARCHIVE_HOT_CLOSED_KEEP = 20;
/** Closed archived rows kept in all (hot + cold) — the same 200 the archive always promised. */
export const ARCHIVE_CLOSED_MAX = MAX_ARCHIVED;
/** Cold-archive bound (closed rows; the oldest are dropped first) — with the hot keep, ARCHIVE_CLOSED_MAX in all. */
export const COLD_ARCHIVE_MAX = ARCHIVE_CLOSED_MAX - ARCHIVE_HOT_CLOSED_KEEP;
/** Bound on the doc's deferred cold-copy deletions (coldStaleIds) — a revive pulls one row at a time. */
const COLD_STALE_IDS_MAX = 50;
/**
 * The cold archive's context-store namespace — one row per directive id. The
 * kind literal is also in memory/context-store CHAT_SCOPED_STORE_KINDS (the
 * namespaces every chat / account deletion clears — pinned equal by
 * supervisor-state.cold-archive.test; kept literal here because most suites
 * mock context-store wholesale).
 */
export function coldArchiveNamespace(chatId: string): string[] {
  return [chatId, 'supervisor-archive'];
}

/**
 * A row's ARCHIVE time — archivedAt, else its own `at`, else 0 (oldest) — the
 * order "the oldest closed rows go first" means (review round 3, 2026-10-23:
 * the cold trim used the store's write order, and a row pulled back from cold
 * was appended as if newest). Pure.
 */
export function archiveTimeMs(d: Pick<SupervisorDirective, 'archivedAt' | 'at'> | null | undefined): number {
  const a = Date.parse(String(d?.archivedAt ?? ''));
  if (Number.isFinite(a)) return a;
  const t = Date.parse(String(d?.at ?? ''));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Insert `row` into an archive list at its archive-time position — after every
 * row archived at or before it — so the list stays in archive order (a row a
 * revive / update pulls back from the cold archive is OLD; appending it made
 * it the newest closed row). Pure: returns a new array.
 */
export function insertByArchiveTime(archived: SupervisorDirective[], row: SupervisorDirective): SupervisorDirective[] {
  const t = archiveTimeMs(row);
  let i = archived.length;
  while (i > 0 && archiveTimeMs(archived[i - 1]) > t) i -= 1;
  return [...archived.slice(0, i), row, ...archived.slice(i)];
}

/**
 * Split the hot archive: every OPEN row plus the newest `keep` CLOSED rows —
 * newest by archive time (archiveTimeMs; ties keep array order, which is
 * archive order: rows are appended when archived) — stay hot; the older closed
 * rows go cold. Order within `hot` and `cold` is the array's. Pure.
 */
export function splitClosedArchive(
  archived: SupervisorDirective[],
  keep: number = ARCHIVE_HOT_CLOSED_KEEP,
): { hot: SupervisorDirective[]; cold: SupervisorDirective[] } {
  const closedIdx = archived.map((d, i) => (d.status !== 'open' ? i : -1)).filter((i) => i >= 0);
  const oldestFirst = [...closedIdx].sort((a, b) => archiveTimeMs(archived[a]) - archiveTimeMs(archived[b]) || a - b);
  const spill = new Set(oldestFirst.slice(0, Math.max(0, oldestFirst.length - Math.max(0, keep))));
  if (!spill.size) return { hot: archived, cold: [] };
  return { hot: archived.filter((_, i) => !spill.has(i)), cold: archived.filter((_, i) => spill.has(i)) };
}

/** Rows oldest-archived first (archiveTimeMs; a stable sort keeps the given order on ties). Pure. */
function byArchiveTime<T extends { row: SupervisorDirective | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => archiveTimeMs(a.row) - archiveTimeMs(b.row));
}

/** Every cold-archive row of a supervisor chat, oldest ARCHIVED first (archiveTimeMs, not write order). [] on any failure. */
export async function readColdArchive(chatId: string): Promise<SupervisorDirective[]> {
  try {
    const rows = await storeListNamespace<unknown>(coldArchiveNamespace(chatId), { limit: 1000 });
    return byArchiveTime(rows.map((r) => ({ row: parseDirective(r.value) })))
      .map((r) => r.row)
      .filter((d): d is SupervisorDirective => !!d);
  } catch (err: any) {
    logger.warn(`supervisor-state: cold archive read failed for ${chatId}: ${err?.message ?? err}`, { source: SOURCE });
    return [];
  }
}

/**
 * One cold row by full id or unique ≥8-char prefix (the revive / lookup
 * path). `ambiguous` when a prefix names several rows. The prefix is matched
 * LITERALLY — every hit is re-checked with `id.startsWith(prefix)` here too
 * (review round 3: a LIKE wildcard in an id used to pull an unrelated row
 * into the hot doc). Never throws.
 */
export async function findColdArchivedDirective(chatId: string, id: string): Promise<{ row?: SupervisorDirective; ambiguous?: number }> {
  const want = String(id ?? '').trim();
  if (!want) return {};
  try {
    const exact = parseDirective(await storeGet<unknown>(coldArchiveNamespace(chatId), want));
    if (exact && exact.id === want) return { row: exact };
    if (want.length < 8) return {};
    const hits = (await storeFindByKeyPrefix<unknown>([coldArchiveNamespace(chatId)], want, 3))
      .map((h) => parseDirective(h.value))
      .filter((d): d is SupervisorDirective => !!d && d.id.startsWith(want));
    if (hits.length > 1) return { ambiguous: hits.length };
    return hits.length ? { row: hits[0] } : {};
  } catch {
    return {};
  }
}

/** Cold rows across several supervisor chats whose id starts with `idOrPrefix` (the directive id lookup). [] on failure. */
export async function findColdArchivedDirectivesAcross(chatIds: string[], idOrPrefix: string, limit = 10): Promise<Array<{ chatId: string; directive: SupervisorDirective }>> {
  const want = String(idOrPrefix ?? '').trim();
  if (!want || !chatIds.length) return [];
  try {
    const nsToChat = new Map(chatIds.map((c) => [coldArchiveNamespace(c).join(':'), c]));
    const hits = await storeFindByKeyPrefix<unknown>(chatIds.map(coldArchiveNamespace), want, limit);
    const out: Array<{ chatId: string; directive: SupervisorDirective }> = [];
    for (const h of hits) {
      const d = parseDirective(h.value);
      const chatId = nsToChat.get(h.namespace);
      if (d && chatId && d.id.startsWith(want)) out.push({ chatId, directive: d });
    }
    return out;
  } catch {
    return [];
  }
}

/** What one spill did to the cold archive — upsertDoc applies the deletions only after its hot write. */
interface ColdSpill {
  /** Cold keys past COLD_ARCHIVE_MAX (the oldest archived rows) — deleted once the hot write lands. */
  trimKeys: string[];
  /**
   * Cold keys whose row the hot doc now holds (pulled back by a revive /
   * update, or a stale copy left by an earlier unconfirmed move) — deleted
   * only after a re-read of the hot doc confirms the row is there.
   */
  moved: Array<{ key: string; row: SupervisorDirective | null }>;
  /** The rows that stay cold (the memory mirror's set). */
  coldRows: SupervisorDirective[];
}

/**
 * The spill for one doc write (runs inside upsertDoc's serialized chain,
 * BEFORE the hot write): closed archive rows past the hot keep are written
 * cold, the cold set is re-listed, cold keys whose row the hot doc holds are
 * set aside as `moved`, and the rest is trimmed to COLD_ARCHIVE_MAX by
 * ARCHIVE time (oldest archived first — archiveTimeMs, never the store's
 * write order); `next` is updated in place (archived = the hot part,
 * archivedColdCount = the rows that stay cold). `promoted` = ids a revive /
 * update pulled OUT of the cold archive this write (it also triggers the
 * listing when nothing spills). Under SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED
 * nothing spills and nothing is trimmed, but a promotion is still settled
 * (review round 3: the switch used to leave the revived row's closed cold
 * copy behind — listed, counted and mirrored as archived). Returns null when
 * the cold archive was not touched — or any store call failed, in which case
 * `next` is left as it was (every row stays hot; nothing is lost; the next
 * write retries). Never throws.
 */
async function spillClosedArchive(
  chatId: string,
  next: SupervisorStateDoc,
  promoted?: ReadonlySet<string>,
): Promise<ColdSpill | null> {
  const disabled = supervisorLedgerArchiveAnsweredDisabled();
  const split = disabled ? { hot: next.archived, cold: [] as SupervisorDirective[] } : splitClosedArchive(next.archived);
  if (!split.cold.length && !(promoted && promoted.size)) return null;
  const ns = coldArchiveNamespace(chatId);
  try {
    if (split.cold.length) await Promise.all(split.cold.map((d) => storePut(ns, d.id, d as unknown as Record<string, unknown>)));
    const listed = (await storeListNamespace<unknown>(ns, { limit: 1000 })).map((r) => ({ key: r.key, row: parseDirective(r.value) }));
    const hotIds = new Set([...next.directives.map((d) => d.id), ...split.hot.map((d) => d.id)]);
    const moved = listed.filter((r) => hotIds.has(r.key));
    const live = byArchiveTime(listed.filter((r) => !hotIds.has(r.key)));
    const trimmed = !disabled && live.length > COLD_ARCHIVE_MAX ? live.slice(0, live.length - COLD_ARCHIVE_MAX) : [];
    const coldRows = live.slice(trimmed.length).map((r) => r.row).filter((d): d is SupervisorDirective => !!d);
    next.archived = split.hot;
    if (coldRows.length) next.archivedColdCount = coldRows.length;
    else delete next.archivedColdCount;
    if (split.cold.length || trimmed.length || moved.length) {
      void import('./loop-metrics.service')
        .then((m) => m.recordLoopMetric({ kind: 'directive_cold_archive', sessionId: chatId, value: split.cold.length, meta: { cold: coldRows.length, trimmed: trimmed.length, promoted: moved.length } }))
        .catch(() => {});
    }
    return { trimKeys: trimmed.map((r) => r.key), moved, coldRows };
  } catch (err: any) {
    logger.warn(`supervisor-state: cold archive spill failed for ${chatId} (rows stay hot): ${err?.message ?? err}`, { source: SOURCE });
    return null;
  }
}

/**
 * After the hot write: delete the trimmed cold keys and every moved key whose
 * row a RE-READ of the hot doc confirms is there (review round 3: a revive
 * whose hot write a concurrent stale write overwrote used to lose the row
 * completely — its cold key was already gone). An unconfirmed move keeps its
 * cold copy (and its cold mirror row); the next spill re-checks it. Returns
 * the cold set for the memory mirror. Never throws.
 */
async function settleColdSpill(chatId: string, spills: ColdSpill[], baseHotIds: ReadonlySet<string>): Promise<SupervisorDirective[]> {
  const ns = coldArchiveNamespace(chatId);
  // The LAST spill listed the cold set after every earlier spill's writes, so
  // its trim is the one that holds (an earlier spill's trim it kept — a
  // promotion freed the slot — must not be deleted).
  const final = spills[spills.length - 1];
  const trimKeys = new Set(final.trimKeys);
  const moved = new Map<string, SupervisorDirective | null>();
  for (const x of spills) for (const m of x.moved) if (!trimKeys.has(m.key)) moved.set(m.key, m.row);
  const confirmed = new Set<string>();
  if (moved.size) {
    try {
      const re = parseDoc((await prisma.supervisorState.findUnique({ where: { chatId }, select: { state: true } }))?.state);
      const ids = new Set([...re.directives, ...re.archived].map((d) => d.id));
      for (const k of moved.keys()) if (ids.has(k)) confirmed.add(k);
    } catch { /* unconfirmed: the cold copies stay; the next spill re-checks them */ }
  }
  // Review 2026-10-23: a moved key is deleted only when this write's BASE
  // read already held the row hot — never in the write that promoted it. A
  // stale whole-blob write from another process can still land after the
  // re-read above; had the cold copy gone with it, the row was in neither
  // tier. The doc's coldStaleIds makes the NEXT write delete it.
  const deletable = [...confirmed].filter((k) => baseHotIds.has(k));
  await Promise.all([...trimKeys, ...deletable].map((k) => storeDelete(ns, k).catch(() => {})));
  const coldIds = new Set(final.coldRows.map((d) => d.id));
  // The cold mirror: an unconfirmed move stays mirrored as archived (its cold
  // copy may be the only one); a confirmed-hot row is never mirrored cold.
  const keptMoved = [...moved.entries()]
    .filter(([k, row]) => !confirmed.has(k) && !!row && !coldIds.has(k))
    .map(([, row]) => row as SupervisorDirective);
  return [...final.coldRows, ...keptMoved];
}

/**
 * The chat is CONFIRMED gone (the lookup answered null) ⇒ delete its
 * chat-keyed store rows — the cold archive this write's spill may have
 * written after the delete's own purge (and the thread row). A lookup or
 * purge failure purges nothing (fail-safe: a live chat's archive is state).
 * Never throws; true when it purged.
 */
async function purgeChatKeyedRowsIfChatGone(chatId: string, why: string): Promise<boolean> {
  try {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { id: true } });
    if (chat !== null) return false;
    const n = await storeDeleteChatScoped([chatId]);
    logger.info(`supervisor-state: ${why} for deleted chat ${chatId} — purged ${n} chat-keyed store row(s) its spill left behind`, { source: SOURCE });
    return true;
  } catch (err: any) {
    logger.warn(`supervisor-state: deleted-chat purge failed for ${chatId}: ${err?.message ?? err}`, { source: SOURCE });
    return false;
  }
}

/** Fire-and-forget directive_overflow metric — dynamic import keeps this module a leaf. */
function emitDirectiveOverflowMetric(chatId: string, overflow: number): void {
  void import('./loop-metrics.service')
    .then((m) => m.recordLoopMetric({ kind: 'directive_overflow', sessionId: chatId, value: overflow }))
    .catch(() => {});
}

function emptyDoc(): SupervisorStateDoc {
  return { directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '' };
}

// ── Owner-origin orders never age out (2026-10-20) ───────────────────────────
// The archive rule below hid an OPEN OWNER ORDER: the 2026-10-12 standing
// ruling answering oq_68d001e9 ("the digby defaults shouldnt be on litellm cql
// … they should all be using the github environment secrets as defaults
// always") moved to `archived` on 2026-10-19T19:35Z still open, so it vanished
// from every wake while the ledger was long. A row the HARNESS stamped
// owner-origin at capture (SupervisorDirective.origin — an owner message in
// this chat, or an owner-question answer / ruling) now never archives while
// open, a harness-archived open one is RESTORED to the live ledger on the
// next read / write, and the wake block's last-resort trim drops every
// machine / model row before an owner row. Owner ASKS (kind:'ask' — status
// questions the reply closes) keep the old aging rule. Kill switch
// DIRECTIVE_ARCHIVE_OWNER_KEEP_DISABLED=1 restores the pre-fix archive + trim.
export function directiveArchiveOwnerKeepDisabled(): boolean {
  return process.env.DIRECTIVE_ARCHIVE_OWNER_KEEP_DISABLED === '1';
}
/** An OPEN, harness-stamped owner-origin ORDER (never an ask) — the rows the archive keeps live. Pure. */
export function isOpenOwnerOriginOrder(d: SupervisorDirective): boolean {
  return d.status === 'open' && d.kind !== 'ask' && (d.origin === 'owner' || d.origin === 'owner_question');
}

/**
 * Move stale OPEN non-standing directives to the archive (autonomy loop #6).
 * Oldest first, only while the live ledger holds more than
 * DIRECTIVE_ARCHIVE_MIN_OPEN open non-standing rows, only rows whose `at` is
 * older than DIRECTIVE_ARCHIVE_AFTER_MS. Standing rows, done rows, rows
 * without a parseable `at` and (2026-10-20) open owner-origin orders never
 * move; an open owner-origin order already in the archive is put back at the
 * head of the live ledger (`restored`, archivedAt dropped). The archive keeps
 * its newest MAX_ARCHIVED rows. Pure — returns a new doc and the rows it moved.
 */
export function archiveStaleDirectives(
  doc: SupervisorStateDoc,
  now: Date = new Date(),
): { doc: SupervisorStateDoc; moved: SupervisorDirective[]; restored: SupervisorDirective[] } {
  const keepOwner = !directiveArchiveOwnerKeepDisabled();
  let restored: SupervisorDirective[] = [];
  if (keepOwner && doc.archived.some(isOpenOwnerOriginOrder)) {
    restored = doc.archived.filter(isOpenOwnerOriginOrder);
    // Prepend: the live ledger is chronological (appends) and these rows are old.
    const back = restored.map(({ archivedAt: _archivedAt, ...rest }) => rest);
    doc = { ...doc, directives: [...back, ...doc.directives], archived: doc.archived.filter((d) => !isOpenOwnerOriginOrder(d)) };
  }
  const isLiveOpen = (d: SupervisorDirective) => d.status === 'open' && d.standing !== true;
  let liveOpen = doc.directives.filter(isLiveOpen).length;
  if (liveOpen <= DIRECTIVE_ARCHIVE_MIN_OPEN) return { doc, moved: [], restored };
  const cutoff = now.getTime() - DIRECTIVE_ARCHIVE_AFTER_MS;
  const candidates = doc.directives
    .filter((d) => isLiveOpen(d) && !(keepOwner && isOpenOwnerOriginOrder(d)) && Number.isFinite(Date.parse(d.at)) && Date.parse(d.at) < cutoff)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const moved: SupervisorDirective[] = [];
  for (const d of candidates) {
    if (liveOpen <= DIRECTIVE_ARCHIVE_MIN_OPEN) break;
    moved.push(d);
    liveOpen -= 1;
  }
  if (!moved.length) return { doc, moved, restored };
  const movedIds = new Set(moved.map((d) => d.id));
  const stamp = now.toISOString();
  const archived = [...doc.archived, ...moved.map((d) => ({ ...d, archivedAt: stamp }))];
  return {
    doc: { ...doc, directives: doc.directives.filter((d) => !movedIds.has(d.id)), archived: trimArchive(archived) },
    moved,
    restored,
  };
}

/** Fire-and-forget directive_archive metric — dynamic import keeps this module a leaf. */
function emitDirectiveArchiveMetric(chatId: string, moved: number): void {
  void import('./loop-metrics.service')
    .then((m) => m.recordLoopMetric({ kind: 'directive_archive', sessionId: chatId, value: moved }))
    .catch(() => {});
}

/** Fire-and-forget directive_archive_restore metric (2026-10-20): open owner-origin orders put back on the live ledger. */
function emitDirectiveRestoreMetric(chatId: string, restored: SupervisorDirective[]): void {
  void import('./loop-metrics.service')
    .then((m) => m.recordLoopMetric({ kind: 'directive_archive_restore', sessionId: chatId, value: restored.length, meta: { ids: restored.slice(0, 6).map((d) => d.id.slice(0, 12)) } }))
    .catch(() => {});
}

// ── Tolerant parse (missing/malformed stored state → empty doc) ─────────────

/** Tolerant parse of ONE stored directive row (the doc's lists and the cold archive's rows). null when unusable. */
function parseDirective(d: unknown): SupervisorDirective | null {
  if (!d || typeof d !== 'object') return null;
  const dd = d as Record<string, unknown>;
  if (typeof dd.id !== 'string' || typeof dd.text !== 'string') return null;
  return {
    id: dd.id,
    text: dd.text,
    at: typeof dd.at === 'string' ? dd.at : '',
    // Audit 96fb2f25: 'answered' (a reply landed, no verified outcome) is a
    // harness-only status for kind:'ask' rows — preserved on the round trip
    // so a read can never re-open (or fulfill) it. An imperative directive
    // can never legitimately carry it, so only ask rows keep it.
    status: dd.status === 'done' ? 'done' : dd.status === 'answered' && dd.kind === 'ask' ? 'answered' : 'open',
    ...(typeof dd.evidence === 'string' && dd.evidence ? { evidence: dd.evidence } : {}),
    ...(dd.standing === true ? { standing: true } : {}),
    ...(typeof dd.scope === 'string' && dd.scope ? { scope: dd.scope.slice(0, MAX_DIRECTIVE_SCOPE) } : {}),
    // The harness origin stamp survives the round trip only as one of its
    // literal values (anything else — a hand edit, a bogus string — is
    // dropped, so it can never masquerade as owner-origin).
    ...(typeof dd.origin === 'string' && DIRECTIVE_ORIGINS.has(dd.origin) ? { origin: dd.origin as SupervisorDirectiveOrigin } : {}),
    ...(typeof dd.archivedAt === 'string' && dd.archivedAt ? { archivedAt: dd.archivedAt } : {}),
    ...(dd.kind === 'ask' ? { kind: 'ask' as const } : {}),
    ...(typeof dd.messageId === 'string' && dd.messageId ? { messageId: dd.messageId.slice(0, 64) } : {}),
  };
}

function parseDoc(raw: unknown): SupervisorStateDoc {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyDoc();
  const o = raw as Record<string, unknown>;
  const doc = emptyDoc();
  if (Array.isArray(o.directives)) {
    for (const d of o.directives) { const parsed = parseDirective(d); if (parsed) doc.directives.push(parsed); }
  }
  if (Array.isArray(o.archived)) {
    for (const d of o.archived) { const parsed = parseDirective(d); if (parsed) doc.archived.push(parsed); }
    doc.archived = doc.archived.slice(-MAX_ARCHIVED);
  }
  // Harness-written cold-archive count (spillClosedArchive) — kept only as a sane non-negative integer.
  if (typeof o.archivedColdCount === 'number' && Number.isFinite(o.archivedColdCount) && o.archivedColdCount > 0) {
    doc.archivedColdCount = Math.floor(o.archivedColdCount);
  }
  // Harness-written deferred cold-copy deletions (settleColdSpill) — ids only, bounded.
  if (Array.isArray(o.coldStaleIds)) {
    const ids = o.coldStaleIds.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 128).slice(0, COLD_STALE_IDS_MAX);
    if (ids.length) doc.coldStaleIds = [...new Set(ids)];
  }
  if (Array.isArray(o.dispatches)) {
    for (const d of o.dispatches) {
      if (!d || typeof d !== 'object') continue;
      const dd = d as Record<string, unknown>;
      if (typeof dd.kind !== 'string' || typeof dd.id !== 'string') continue;
      doc.dispatches.push({
        at: typeof dd.at === 'string' ? dd.at : '',
        kind: dd.kind,
        id: dd.id,
        ...(typeof dd.note === 'string' && dd.note ? { note: dd.note } : {}),
      });
    }
  }
  if (Array.isArray(o.projects)) {
    for (const p of o.projects) {
      if (!p || typeof p !== 'object') continue;
      const pp = p as Record<string, unknown>;
      if (typeof pp.name !== 'string' || typeof pp.status !== 'string') continue;
      doc.projects.push({ name: pp.name, status: pp.status, at: typeof pp.at === 'string' ? pp.at : '' });
    }
  }
  if (typeof o.notes === 'string') doc.notes = o.notes;
  if (Array.isArray(o.refutations)) {
    // Verifier-written lines only ever enter via appendVerifierRefutation, but
    // the tolerant parse still caps + stringifies so a hand-edited row can't
    // blow up the wake block.
    doc.refutations = o.refutations.filter((r): r is string => typeof r === 'string' && !!r).slice(0, MAX_REFUTATIONS);
  }
  // Ticket a5b36dc6: harness-written preempt marker — accept only a parseable
  // ISO string (anything else degrades to "none live").
  doc.inflightPreemptAt = typeof o.inflightPreemptAt === 'string' && Number.isFinite(Date.parse(o.inflightPreemptAt)) ? o.inflightPreemptAt : '';
  return doc;
}

/** Tolerant parse of a stored supervisor_states.state value (the age sweep reads rows in bulk). Never throws. */
export function parseSupervisorStateDoc(raw: unknown): SupervisorStateDoc {
  return parseDoc(raw);
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The supervisor chat's durable doc. Missing row, malformed JSON, or a DB
 * failure all degrade to an EMPTY doc — never throws (the wake injection path
 * treats any hiccup as "no memory yet").
 */
export async function getSupervisorState(chatId: string): Promise<SupervisorStateDoc> {
  try {
    const row = await prisma.supervisorState.findUnique({ where: { chatId }, select: { state: true } });
    // Read-side tidy (autonomy loop #6): the wake block reflects the archive
    // rule immediately; the next write persists it (upsertDoc applies the same
    // pure step, so reads and writes never disagree).
    return archiveStaleDirectives(parseDoc(row?.state)).doc;
  } catch (err: any) {
    logger.warn(`supervisor-state: load failed for ${chatId}: ${err?.message ?? err}`, { source: SOURCE });
    return emptyDoc();
  }
}

/**
 * get_supervisor_state (autonomy loop #6): the supervisor reads its OWN doc in
 * full — the wake block shows only what fits 6000 chars. `query` filters
 * directive rows (text / evidence / scope, case-insensitive substring);
 * `limit` caps each list (default 40, max 100); the JSON is bounded to
 * READ_SECTION_MAX_CHARS with a `truncated` flag. Never throws.
 */
export const READ_SECTION_MAX_CHARS = 12_000;
/** section 'all' lists at most this many CLOSED archived rows (review 2026-10-22) — section 'archived' lists them up to `limit`. */
export const READ_ALL_CLOSED_ARCHIVED_MAX = 10;
export type SupervisorStateSection = 'directives' | 'archived' | 'dispatches' | 'projects' | 'notes' | 'refutations' | 'all';

/**
 * The archive rule as get_supervisor_state states it — it must match what the
 * harness actually does (review 2026-10-22: the old text said "nothing is
 * deleted" and named only the 7-day open rows). `coldCount` = closed rows in
 * the cold archive (named under the kill switch, where they are left from
 * before it was set). Pure.
 */
export function archiveRuleText(coldCount = 0): string {
  const days = Math.round(DIRECTIVE_ARCHIVE_AFTER_MS / 86_400_000);
  const ownerKeep = directiveArchiveOwnerKeepDisabled() ? '' : ' (an OPEN owner-origin order — the owner\'s own message or flagged-question ruling — never moves here)';
  const revive = `${modelToolName('update_supervisor_state')}({directives:[{id, status:'open'}]}) revives (re-opens) one by id`;
  if (supervisorLedgerArchiveAnsweredDisabled()) {
    const earlier = coldCount > 0 ? ` The ${coldCount} closed (done / answered) row(s) in the cold archive were archived before this rule applied; they stay listed here and revivable.` : '';
    return `open, non-standing directives older than ${days} days move here while the live ledger holds more than ${DIRECTIVE_ARCHIVE_MIN_OPEN} open rows${ownerKeep}; the archive keeps its newest ${MAX_ARCHIVED} rows (older ones are dropped), and done / answered rows the ${MAX_DIRECTIVES}-row live ledger evicts are DELETED, not archived — ${revive}.${earlier}`;
  }
  // Review 2026-10-23: findability by search_memory is claimed only when the
  // harness provides it — the ledger mirror writes (SUPERVISOR_STATE_MEMORY_DISABLED
  // off) AND the supervisor search scopes (SUPERVISOR_SEARCH_MEMORY_SCOPES_DISABLED off).
  const findable = supervisorLedgerSearchable()
    ? 'Every archived row stays findable by search_memory while it is kept.'
    : `search_memory does not reach them right now (its ledger mirror or the supervisor search scopes are switched off) — read them here with get_supervisor_state({section:'archived', query:'…'}).`;
  return `two kinds of rows live here: OPEN, non-standing directives older than ${days} days, moved out while the live ledger holds more than ${DIRECTIVE_ARCHIVE_MIN_OPEN} open rows${ownerKeep}; and CLOSED (done / answered) rows the ${MAX_DIRECTIVES}-row live ledger moved out instead of deleting them. Open rows are listed first. Only the newest ${ARCHIVE_HOT_CLOSED_KEEP} closed rows stay in the doc every wake loads; older closed rows sit in the cold archive (listed here too). At most ${ARCHIVE_CLOSED_MAX} closed rows are kept in all — beyond that the OLDEST closed rows are deleted. ${findable} ${revive}.`;
}

export async function readSupervisorStateSection(
  chatId: string,
  args: { section?: unknown; query?: unknown; limit?: unknown },
): Promise<Record<string, unknown>> {
  const section = (['directives', 'archived', 'dispatches', 'projects', 'notes', 'refutations', 'all'] as const).find((k) => k === String(args?.section ?? 'all').trim()) ?? 'all';
  const query = String(args?.query ?? '').trim().toLowerCase();
  const lim = Math.max(1, Math.min(100, Math.floor(Number(args?.limit) || 40)));
  const doc = await getSupervisorState(chatId);
  const matches = (d: SupervisorDirective) => !query || `${d.text} ${d.evidence ?? ''} ${d.scope ?? ''}`.toLowerCase().includes(query);
  const newestFirst = (rows: SupervisorDirective[]) => [...rows].reverse();
  const wantsArchive = section === 'archived' || section === 'all';
  let archiveMatched: { open: number; closed: number } | null = null;
  // Review 2026-10-22: the cold archive (older closed rows) is read only here, on demand.
  const coldRows = wantsArchive && (doc.archivedColdCount ?? 0) > 0 ? await readColdArchive(chatId) : [];
  // A cold copy of a row the hot doc holds (live ledger OR hot archive — a
  // stale copy an unconfirmed move left behind) is never listed as archived.
  const hotIds = new Set([...doc.archived, ...doc.directives].map((d) => d.id));
  const coldListed = coldRows.filter((d) => !hotIds.has(d.id));
  const archiveAll = [...coldListed, ...doc.archived]; // oldest → newest
  const archivedOpen = archiveAll.filter((d) => d.status === 'open').length;
  const out: Record<string, unknown> = { section, counts: { directives: doc.directives.length, open: doc.directives.filter((d) => d.status === 'open').length, archived: wantsArchive ? archiveAll.length : doc.archived.length + (doc.archivedColdCount ?? 0), ...(wantsArchive ? { archivedOpen, archivedClosed: archiveAll.length - archivedOpen } : {}), dispatches: doc.dispatches.length, projects: doc.projects.length, refutations: doc.refutations.length } };
  if (section === 'directives' || section === 'all') out.directives = newestFirst(doc.directives).filter(matches).slice(0, lim);
  if (wantsArchive) {
    // OPEN rows first (the age alarm's subject — never crowded out by closed
    // history), then closed rows newest first; section 'all' lists only a few
    // closed rows and says how many more section 'archived' has.
    const open = newestFirst(archiveAll.filter((d) => d.status === 'open')).filter(matches);
    const closed = newestFirst(archiveAll.filter((d) => d.status !== 'open')).filter(matches);
    const closedCap = section === 'all' ? Math.min(lim, READ_ALL_CLOSED_ARCHIVED_MAX) : lim;
    const listed = [...open.slice(0, lim), ...closed.slice(0, Math.max(0, Math.min(closedCap, lim - Math.min(open.length, lim))))];
    out.archived = listed;
    archiveMatched = { open: open.length, closed: closed.length };
    out.archiveRule = archiveRuleText(coldListed.length);
  }
  if (section === 'dispatches' || section === 'all') out.dispatches = [...doc.dispatches].reverse().slice(0, lim);
  if (section === 'projects' || section === 'all') out.projects = doc.projects;
  if (section === 'notes' || section === 'all') out.notes = doc.notes;
  if (section === 'refutations' || section === 'all') out.refutations = doc.refutations;
  let json = JSON.stringify(out);
  // The archivedNotListed note (added below, ≤ ~120 chars) is reserved inside the bound.
  const maxChars = READ_SECTION_MAX_CHARS - (archiveMatched ? 160 : 0);
  if (json.length > maxChars) {
    // Trim the largest list first until it fits; say so.
    out.truncated = true;
    for (const key of ['archived', 'directives', 'dispatches'] as const) {
      while (Array.isArray(out[key]) && (out[key] as unknown[]).length > 1 && JSON.stringify(out).length > maxChars) (out[key] as unknown[]).pop();
    }
    if (typeof out.notes === 'string' && JSON.stringify(out).length > maxChars) out.notes = (out.notes as string).slice(0, 2000) + '…[truncated]';
    json = JSON.stringify(out);
  }
  // Review 2026-10-22: say how many matching archived rows this answer did NOT list (section cap, 'all' closed cap, size trim).
  if (archiveMatched && Array.isArray(out.archived)) {
    const rows = out.archived as SupervisorDirective[];
    const listedOpen = rows.filter((d) => d.status === 'open').length;
    const notListed = { open: archiveMatched.open - listedOpen, closed: archiveMatched.closed - (rows.length - listedOpen) };
    if (notListed.open > 0 || notListed.closed > 0) out.archivedNotListed = { ...notListed, how: "get_supervisor_state({section:'archived', query:'…', limit:100})" };
  }
  return out;
}

/** True iff this chat is a supervisor-class lane — the owner's Fleet
 *  Supervisor OR a project's dedicated supervisor (isProjectSupervisor,
 *  2026-09-13): both carry the durable state doc + the update_supervisor_state
 *  tool gate keys on this. False on ANY failure. */
export async function isSupervisorChat(chatId: string): Promise<boolean> {
  return (await supervisorChatFlag(chatId)) === true;
}

/** Three-state twin of isSupervisorChat: true / false from the row, NULL when
 *  the row could not be read (DB error). The supervisor-only tool executors
 *  use it so a transient outage answers `state_read_failed`, never the
 *  deterministic `supervisor_only` refusal the D5 ladder counts (review fixer
 *  2026-09-27). */
export async function supervisorChatFlag(chatId: string): Promise<boolean | null> {
  try {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { isSupervisor: true, isProjectSupervisor: true } });
    return chat?.isSupervisor === true || chat?.isProjectSupervisor === true;
  } catch {
    return null;
  }
}

// ── Wake rendering ──────────────────────────────────────────────────────────

/** "2d" / "5h" / "12m" / "just now" — the age of an ISO timestamp relative to now. */
function ageOf(iso: string, now: Date): string {  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '?';
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The DIRECTIVE AGE ALARM line for the wake block ('' when nothing is
 * overdue). Pure; exported for tests.
 */
export function directiveAgeAlarmLine(doc: SupervisorStateDoc, now: Date = new Date()): string {
  const overdue = unactedDirectives(doc, now, DIRECTIVE_AGE_ALARM_MS);
  if (!overdue.length) return '';
  const hours = Math.round(DIRECTIVE_AGE_ALARM_MS / 3_600_000);
  const archivedOpen = overdue.filter((d) => d.archived).length;
  const ids = overdue.slice(0, DIRECTIVE_AGE_ALARM_MAX_IDS).map((d) => `${d.id.slice(0, 8)} ${ageMs(d.ageMs)}${d.archived ? ' archived' : ''}`).join(', ');
  return `- DIRECTIVE AGE ALARM: ${overdue.length} directive(s) open >${hours}h with NO evidence recorded (oldest first: ${ids}${overdue.length > DIRECTIVE_AGE_ALARM_MAX_IDS ? ', …' : ''}${archivedOpen ? `; ${archivedOpen} archived-but-open — get_supervisor_state({section:'archived'})` : ''}). An order is not acted on by being remembered: for each, THIS wake, act on it and record the returned id as evidence on the OPEN row (${modelToolName('update_supervisor_state')}({directives:[{id, evidence:'dispatched: session <id>'}]}) — close it only once the artifact has landed; a dispatch is progress, not done), or record the blocker as evidence the same way ({id, evidence:'blocked: … (msg/oq/ticket id)'}) so the alarm clears.`;
}

/**
 * Render the durable doc as the block injected at the top of every machine
 * wake (right under the machine-wake preamble). Empty sections are omitted;
 * the whole block is hard-capped at ~6000 chars — oldest DISPATCHES drop
 * first (directives are the owner's voice and outlive dispatch history), then
 * refutations older than 24 h (MIND-HYGIENE; only the last 7 days render at
 * all — the rest are a 30-day tally line), then NOTES truncate. Pure function.
 */
export function formatStateForWake(
  doc: SupervisorStateDoc,
  now: Date = new Date(),
  opts: {
    /** fixer 2026-09-27 (finding upward-chatter-1c): ask rows to OMIT from the
     *  OPEN OWNER ASKS section — the ones the [OPEN OWNER ASKS — ANSWER FIRST]
     *  block above already lists, and the ones a reply already answered (the
     *  block builder auto-closes those). Without it an ask rendered twice per
     *  wake and an answered-but-unclosed ask re-injected for 72 h. */
    hideAskIds?: ReadonlyArray<string>;
    /** kpi-honesty-loops 2026-09-27: the live KPI register — annotates a projects[].status line that types a rate. */
    kpis?: KpiView[];
    /** FS context map 2026-10-22 (gap #3): stamp each PROJECT STATUS line with the age of
     *  its write + "snapshot, not live" — owner turns (SUPERVISOR_OWNER_LEDGER_DIFF_DISABLED). */
    projectStatusAges?: boolean;
  } = {},
): string {
  const header = `[SUPERVISOR STATE — your durable memory across wakes. Update it before finishing with ${modelToolName('update_supervisor_state')}.]`;
  // tt-rd audit 2026-09-27: owner ASKS (kind:'ask') render under their own
  // header so the model and the Fleet Supervisor can tell an unanswered
  // question from a standing order; closed by the harness when the reply lands.
  const openAll = doc.directives.filter((d) => d.status === 'open');
  const open = openAll.filter((d) => d.kind !== 'ask');
  const hideAsk = new Set(opts.hideAskIds ?? []);
  const askEntries = openAll.filter((d) => d.kind === 'ask' && !hideAsk.has(d.id)).map((d) => ({ d, line: `- [${d.id}] (${ageOf(d.at, now)} ago${d.messageId ? `, msg ${d.messageId.slice(0, 8)}` : ''})${d.scope ? ` [scope: ${d.scope}]` : ''} "${d.text}"` }));
  // Ticket 661fb494: the scope tag rides every directive line — the wake must
  // see WHICH project an owner message binds before citing it cross-project.
  // Autonomy loop #2 (2026-09-19): each line keeps its directive so the
  // last-resort trim below can drop NON-standing rows first and report what
  // it hid — the Fleet Supervisor carried 51 open directives (42k chars of
  // state) against this 6000-char block, so ~40 of them, including owner
  // grants from 09-14/09-16, were silently absent from every wake.
  const directiveEntries = open.map((d) => ({ d, line: `- [${d.id}] (${ageOf(d.at, now)} ago)${d.scope ? ` [scope: ${d.scope}]` : ''} ${d.text}` }));
  const hiddenDirectives: SupervisorDirective[] = [];
  // Directive age alarm (D2, 2026-09-27): the ONE line that makes an untouched
  // order look different from one being worked — counts live AND archived-
  // but-open rows (the archive hides them from the list above), names the
  // oldest ids, and says what clears it. Survives every trim below (it rides
  // directiveLines(), and the last-resort directive drop keeps ≥1 entry).
  const alarmLine = directiveAgeAlarmLine(doc, now);
  const directiveLines = () => {
    const lines = directiveEntries.map((e) => e.line);
    if (hiddenDirectives.length) {
      const ids = hiddenDirectives.slice(0, 12).map((d) => d.id).join(', ');
      lines.push(`- …and ${hiddenDirectives.length} older open directive(s) NOT shown (${ids}${hiddenDirectives.length > 12 ? ', …' : ''}) — the ledger exceeds this block. Consolidate with ${modelToolName('update_supervisor_state')}: mark stale ones done (with evidence) or merge duplicates, so nothing the owner said stays unseen.`);
    }
    const coldCount = doc.archivedColdCount ?? 0;
    if (doc.archived.length || coldCount) {
      // 2026-10-22: the archive also holds closed rows the 50-row cap moved out
      // (capDirectivesIntoArchive; the older ones in the cold archive) — the
      // count says which is which, and the line says what the archive keeps.
      const total = doc.archived.length + coldCount;
      const days = Math.round(DIRECTIVE_ARCHIVE_AFTER_MS / 86_400_000);
      const closedArchived = doc.archived.filter((d) => d.status !== 'open').length + coldCount;
      // Review round 3: under SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED the
      // cap DELETES closed rows (archiveRuleText says so) — the line must too.
      const why = !closedArchived
        ? `open > ${days} d while this ledger was long; out of this block, still listed and searchable`
        : supervisorLedgerArchiveAnsweredDisabled()
          ? `${total - closedArchived} open > ${days} d while this ledger was long, ${closedArchived} closed (done / answered) archived earlier, still listed and searchable; the archive keeps its newest ${MAX_ARCHIVED} rows, and done / answered rows the ${MAX_DIRECTIVES}-row cap evicts now are DELETED, not archived`
          : `${total - closedArchived} open > ${days} d while this ledger was long, ${closedArchived} closed (done / answered) moved out at the ${MAX_DIRECTIVES}-row cap; kept and searchable, up to ${ARCHIVE_CLOSED_MAX} closed rows — the oldest closed rows go first`;
      lines.push(`- ${total} older directive(s) ARCHIVED (${why}): get_supervisor_state({section:'archived', query:'…'}) lists them, open rows first; ${modelToolName('update_supervisor_state')}({directives:[{id, status:'open'}]}) revives one.`);
    }
    if (alarmLine) lines.push(alarmLine);
    return lines;
  };
  // MIND-HYGIENE refutation TTL: only the last 7 days render; older lines are
  // folded into the 30-day tally line (refutationTallyLine) — see the block
  // comment at REFUTATION_RENDER_TTL_MS. Off ⇒ every stored line, as before.
  const refutationTtl = !refutationTtlDisabled();
  const nowMs = now.getTime();
  const refutationEntries = doc.refutations
    .map((r) => ({ line: `- ${String(r).slice(0, MAX_REFUTATION)}`, at: refutationAtMs(r) }))
    .filter((e) => !refutationTtl || e.at === null || nowMs - e.at <= REFUTATION_RENDER_TTL_MS);
  const refutationLines = refutationEntries.map((e) => e.line);
  const dispatchLines = doc.dispatches.map((d) => `- ${d.at} ${d.kind} → ${d.id}${d.note ? ` — ${d.note}` : ''}`);
  // Finding 2d (tt-rd audit 2026-09-27): projects[].status is model-typed free
  // text; a copied KPI number goes stale there ("e2e premise 2.464" stayed
  // in the doc after the register moved to 5.08). Observe-only: append the
  // live register value after a line that names a KPI key or types a rate in
  // its unit. No kpis passed ⇒ verbatim.
  const kpis = Array.isArray(opts.kpis) && opts.kpis.length ? opts.kpis : null;
  // The status text is what the model typed at its last state update — on an owner turn it
  // read as current. The stamp sits before the status so a KPI annotation stays the live tail.
  const projectStamp = (at: string): string => {
    if (!opts.projectStatusAges) return '';
    const age = ageOf(at, now);
    return ` [${age === '?' ? 'age unknown' : age === 'just now' ? 'written just now' : `written ${age} ago`} — snapshot, not live]`;
  };
  // Review 2026-10-23 (item 4): the stamps are context ABOUT the status lines, never content — the cap below
  // grows by exactly the length of the stamps still rendered, so an owner turn loses no NOTES / dispatch /
  // directive char to them (the trim lands exactly where it does without stamps). '' stamps ⇒ the cap as before.
  const projectStampLens: number[] = [];
  const projectLines = doc.projects.map((p) => {
    const stamp = projectStamp(p.at);
    projectStampLens.push(stamp.length);
    const line = `- ${p.name}${stamp}: ${p.status}`;
    return kpis ? annotateStateLineWithKpi(line, kpis, now) : line;
  });
  const cap = (): number => WAKE_BLOCK_CAP + projectStampLens.reduce((n, x) => n + x, 0);
  let notes = doc.notes;

  const render = () => {
    const parts = [header];
    const dl = directiveLines();
    if (askEntries.length) parts.push(['OPEN OWNER ASKS (unanswered — answer each in plain words, citing its msg id; the harness marks it answered when your reply lands — closing it done needs typed evidence via update_supervisor_state):', ...askEntries.map((e) => e.line)].join('\n'));
    if (dl.length) parts.push(['OPEN DIRECTIVES:', ...dl].join('\n'));
    const tally = refutationTtl ? refutationTallyLine(doc.refutations, now, doc.refutations.length - refutationLines.length) : '';
    if (refutationLines.length || tally) parts.push(['VERIFIER REFUTATIONS (automated audit proved these action claims FALSE — never restate them as done):', ...refutationLines, ...(tally ? [tally] : [])].join('\n'));
    if (dispatchLines.length) parts.push([RECENT_DISPATCHES_HEADER, ...dispatchLines].join('\n'));
    if (projectLines.length) parts.push(['PROJECT STATUS:', ...projectLines].join('\n'));
    if (notes) parts.push(`NOTES:\n${notes}`);
    return parts.join('\n\n');
  };

  let block = render();
  while (block.length > cap() && dispatchLines.length) {
    dispatchLines.shift(); // oldest first — dispatches are appended chronologically
    block = render();
  }
  // MIND-HYGIENE: refutations older than 24 h go BEFORE notes (oldest first —
  // the list is newest-first, so pop); the tally line keeps their count. A
  // line without a parseable stamp is never "old" here (fail toward showing).
  if (refutationTtl) {
    while (block.length > cap() && refutationEntries.length) {
      const last = refutationEntries[refutationEntries.length - 1];
      if (last.at === null || nowMs - last.at <= REFUTATION_TRIM_EARLY_AFTER_MS) break;
      refutationEntries.pop();
      refutationLines.pop();
      block = render();
    }
  }
  if (block.length > cap() && notes) {
    const keep = notes.length - (block.length - cap()) - 20; // 20 > '\n…[truncated]'.length
    notes = keep > 0 ? notes.slice(0, keep) + '\n…[truncated]' : '';
    block = render();
  }
  // Last resorts (a full doc of long directives can exceed the cap on its
  // own): drop oldest project lines, then oldest refutation lines (the list
  // is newest-first — pop drops the stalest), then oldest open-directive lines.
  while (block.length > cap() && projectLines.length) {
    projectLines.shift();
    projectStampLens.shift();
    block = render();
  }
  while (block.length > cap() && refutationLines.length > 1) {
    refutationLines.pop();
    refutationEntries.pop();
    block = render();
  }
  // Directives: drop the oldest NON-standing row first (owner grants and
  // standing orders are the last thing a wake may lose), then the oldest
  // standing one. Every drop is counted and named in the "…NOT shown" line
  // so the supervisor can consolidate instead of silently forgetting.
  // 2026-10-20: owner-origin orders (the harness stamp) outrank every model /
  // machine row — drop order is machine non-standing → machine standing →
  // owner non-standing → owner standing, oldest first within each tier
  // (DIRECTIVE_ARCHIVE_OWNER_KEEP_DISABLED=1 restores the standing-only order).
  const ownerKeep = !directiveArchiveOwnerKeepDisabled();
  const dropRank = (d: SupervisorDirective) => (ownerKeep && isOpenOwnerOriginOrder(d) ? 2 : 0) + (d.standing === true ? 1 : 0);
  const dropOneDirective = (): boolean => {
    if (directiveEntries.length <= 1) return false;
    let idx = 0;
    for (let i = 1; i < directiveEntries.length; i++) {
      if (dropRank(directiveEntries[i].d) < dropRank(directiveEntries[idx].d)) idx = i;
    }
    hiddenDirectives.push(directiveEntries[idx].d);
    directiveEntries.splice(idx, 1);
    return true;
  };
  while (block.length > cap() && dropOneDirective()) {
    block = render();
  }
  // Asks are the last thing to go (oldest first) — an unanswered owner question outranks every other line.
  while (block.length > cap() && askEntries.length > 1) {
    askEntries.shift();
    block = render();
  }
  return block;
}

// ── Live fleet attention block (2026-08-30 fleet audit) ─────────────────────
// The durable doc is the supervisor's OWN memory — but it can drift from the
// fleet's ground truth (a todo marked in_progress while its assignee idles for
// a day; a lane that rewrote its own schedule into watch-only). This block is
// computed LIVE from the goal board + schedule rows at wake time, so every
// machine wake sees drift the doc never recorded. TOTAL like everything here:
// any failure degrades to an empty string.

/** An in_progress todo untouched this long is stalled, not progressing. */
const STALE_IN_PROGRESS_MS = 2 * 60 * 60 * 1000;
/** An assigned-but-pending todo this old was very likely never started. */
const STALE_ASSIGNED_MS = 6 * 60 * 60 * 1000;
/**
 * Reconcile-annotation freshness window (ticket e13f216e): a candidate whose
 * progressNote was restamped within this window was LOOKED AT recently — a
 * project-supervisor reconcile stamp or a lane's progress note — and left
 * pending/in_progress ON PURPOSE (deliberate queue / active work). The bare
 * updatedAt cutoff could not tell that apart from never-started, so an
 * annotated todo re-flagged just 6h after each reconcile (the tt-rd 10:57Z
 * restamps re-flagged at 18:45Z as "assigned 7h ago"). A fresh annotation
 * suppresses; the stamp ages out at 12h and an unmoved todo re-flags.
 */
const RECONCILED_FRESH_MS = 12 * 60 * 60 * 1000;
/**
 * Assignee-liveness suppression (ticket 8f5a45f7): a stalled in_progress todo
 * whose assignee lane RAN within its watch cadence is NOT stalled — the lane
 * is alive and simply has nothing to write (GET-only watch todos fire on
 * cadence, self-audit clean, and never touch the todo when nothing changed
 * upstream, so todo.updatedAt alone false-positives every wake). The lane is
 * "live" when its newest agent_runs row is fresher than
 * STALE_IN_PROGRESS_MS + the lane's own longest enabled-schedule cadence (a
 * 4h watch isn't late at 3h; a hook-woken lane with no schedule gets the base
 * window). Even a live lane's todo drifts free for at most
 * STALLED_BACKSTOP_MS before one reconcile — a day-old untouched in_progress
 * todo is drift worth surfacing no matter how healthy the lane looks.
 * Liveness lookups are fault-local: on failure they degrade to NO suppression
 * (today's behavior), never to hiding a genuine stall.
 */
const STALLED_BACKSTOP_MS = 24 * 60 * 60 * 1000;
/**
 * Ticket 09880586 — an ARMED read-back schedule is designed waiting, not a
 * stall. A metric-window todo (7-day observe-only baseline, one-shot read-back
 * armed for the window close) is untouched for DAYS on purpose: the quiet
 * window IS the experiment, and the read-back firing will compute the
 * before/after metric and close the todo. The bare updatedAt clock flagged
 * such todos as STALLED twice in one day (06:11Z + 18:20Z steers) even though
 * the detector's own liveness rule credited the lane — the 24h drift backstop
 * re-flagged mid-window, and every supervisor wake burned a reconcile steer on
 * a healthy wait. The exemption: a todo is in DESIGNED WAIT when an ENABLED,
 * still-due schedule EXISTS whose stored prompt REFERENCES the todo (the
 * standing idiom — "Todo fea78360 (owner-card contract) — 7-day observe-only
 * baseline READ-BACK", live-verified against prod rows) OR whose id appears in
 * the todo's progressNote ("read-back one-shot armed on own sched 0059e4e4").
 * Both legs lapse BY DESIGN when the wait ends: the sweeper disables a spent
 * one-shot (enabled:false), the row expires (expiresAt), or the prompt stops
 * naming the todo — the very next wake flags the todo again. UNSTARTED rows
 * are deliberately NOT exempt (a firing lane that never STARTS its assigned
 * todo is the genuine non-start signal). Suppression is fail-open: a lookup
 * failure degrades to today's flagging, never to hiding a stall. Kill switch
 * FLEET_ATTENTION_READBACK_CREDIT_DISABLED=1 restores the bare-clock behavior
 * byte-for-byte.
 */
const READBACK_MAX_SCHEDULES = 60;
function readbackCreditDisabled(): boolean {
  return process.env.FLEET_ATTENTION_READBACK_CREDIT_DISABLED === '1';
}
/** A fresh owner decision re-lists VERBATIM every wake; past this age it
 *  compresses into the one-line unchanged summary (ticket df4cff3c) — 6h
 *  matches the supervisor's own wake-economy dedupe rule. Exported for tests. */
export const OWNER_DECISION_VERBATIM_WINDOW_MS = 6 * 60 * 60 * 1000;
const ATTENTION_MAX_LINES = 6;
// Sizing rework (remediation P2 v1#2): boilerplate is HOISTED into one header
// per section, each item line is capped, and overflow drops whole ITEMS per
// section — never a mid-sentence global slice. The global cap survives only
// as a last-resort line-boundary guard.
const ATTENTION_BLOCK_CAP = 2400;
/** Per-item line cap (chars) — the id/age/title facts fit; prose lives in the section header. */
export const ATTENTION_ITEM_CAP = 160;
/** Per-section rendered budget (chars) — beyond it, whole items drop with a "+N more" line. */
const ATTENTION_SECTION_CAP = 700;

/** Ticket 03aef0da kill switch: '1' restores the 8-char id rendering and the
 *  enabled-only (expiry-blind) machine-prompt pull. */
function fullScheduleIdsDisabled(): boolean {
  return process.env.FLEET_ATTENTION_FULL_SCHEDULE_IDS_DISABLED === '1';
}

/**
 * audit 2026-10-08 W1-7 (supervisors F7): wake blocks rendered chat ids as SUFFIXES ("chat
 * …ec52d820") while every tool takes the full id — Schooltime spliced prefix + suffix into
 * invented ids ("0037460b-…-ec52d820"), 13 failed lookups in 24 h. Every id a model may pass back
 * is now rendered IN FULL. Kill switch SUPERVISOR_STATE_FULL_IDS_DISABLED=1 restores "…<last 8>".
 */
export function supervisorStateFullIdsDisabled(): boolean {
  return process.env.SUPERVISOR_STATE_FULL_IDS_DISABLED === '1';
}
/** An id as a wake block shows it: the full id (default) or the legacy "…<last 8>" suffix. */
export function wakeId(id: string | null | undefined, fallback = 'none'): string {
  const s = String(id ?? '');
  if (!s) return fallback;
  return supervisorStateFullIdsDisabled() ? `…${s.slice(-8)}` : s;
}

function ageMs(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Ticket e13f216e — true when the row carries a non-blank progressNote AND
 * its last touch is inside RECONCILED_FRESH_MS: positive evidence of a
 * recent reconcile (every todo_update progressNote restamp bumps the row's
 * updatedAt via Prisma @updatedAt, so a fresh note == a fresh stamp).
 */
function isFreshlyReconciled(t: { progressNote?: string | null; updatedAt: Date }, now: Date): boolean {
  if (!t.progressNote || !t.progressNote.trim()) return false;
  return now.getTime() - t.updatedAt.getTime() < RECONCILED_FRESH_MS;
}

/**
 * Ticket d1a7bec2 (CASE 1) — a STANDING ROLE todo is a permanent duty that is
 * designed never to close. The bare clock cannot tell that apart from a stall:
 * the Schooltime goal's two permanent roles ("Gap identifier role (standing,
 * RUNS FIRST)", "Dataset enhancer role (standing)") re-entered the STALLED /
 * UNSTARTED list every ~24 h forever, costing a fleet steer + a full
 * project-supervisor wake each time for pure ledger hygiene. One of them was
 * idle BY DESIGN (ingestion queue len=1, licence-gated), the other actively
 * shipping (three ladder rungs + 422 S3 rows + premise 2891→3313) — neither
 * was stalled, and neither can ever be closed, so the flag had no remedy.
 *
 * The credit is a SWAP, never a mute: a standing role drops out of the
 * STALLED/UNSTARTED lists and re-surfaces ONLY through an ADOPTION check — its
 * assignee lane's newest run (or, when the lane has never run, the todo's own
 * last touch) older than STANDING_ROLE_QUIET_MS. A live standing role stays
 * quiet; a genuinely dead one still surfaces, with the right remedy (re-steer
 * or retire) instead of the impossible "close it".
 *
 * Detection is a marker in the title OR the progressNote, because a standing
 * role declares itself exactly there ("STANDING ROLE", "(Standing role -
 * never close.)", "(standing, RUNS FIRST)"). Not the todo_type: a todo-level
 * flag would need a migration and every existing standing role re-stamped.
 *
 * TOTAL / fail-open: any lookup failure degrades to today's flagging (the row
 * renders as STALLED), never to hiding it. Kill switch
 * FLEET_ATTENTION_STANDING_ROLE_CREDIT_DISABLED=1 restores the bare clock
 * byte-for-byte.
 */
export const STANDING_ROLE_QUIET_MS = 72 * 60 * 60 * 1000;
export function standingRoleCreditDisabled(): boolean {
  return process.env.FLEET_ATTENTION_STANDING_ROLE_CREDIT_DISABLED === '1';
}
/**
 * The STANDING-ROLE marker. A false positive here is EXPENSIVE in the wrong
 * direction: a match REMOVES a row from the STALLED/UNSTARTED list, so an
 * ordinary stalled todo whose note happens to contain both words would be
 * silenced. (Review probe on the first cut: "role table sorted; pod standing.",
 * "role: standing up the replica", "Standing wave -- role of the mesh" all
 * matched — and so did "Do not close the PR until CI is green", the NORMAL note
 * on a paused todo.)
 *
 * So the marker is deliberately narrow — the shapes a standing role actually
 * declares itself in:
 *  - "standing role" / "Standing Role", either word order, joined by nothing
 *    more than a parenthetical/bracket and spaces: "role (standing)",
 *    "role (standing, RUNS FIRST)", "standing, RUNS FIRST)" is NOT required —
 *    the ticket's own title is "Gap identifier role (standing, RUNS FIRST)",
 *    which the parenthetical leg covers.
 *  - "permanent role" / "standing/permanent duty" / "role ... permanent".
 *  - an explicit IMPERATIVE never-close declaration ("never close", "never
 *    close it", "do not close this/it") — but NOT the bare "do not close",
 *    which is ordinary paused-work prose ("Do not close the PR until CI is
 *    green"). "never closes" (third person) is prose about something else.
 * No adversarial input exceeds linear time (fixed-width gaps only).
 */
const STANDING_ROLE_MARKER_RE = new RegExp(
  [
    // "standing role" / "role (standing)" / "Standing Role"
    String.raw`\bstanding[\s_-]*role\b`,
    String.raw`\brole\s*\(\s*standing\b`,
    // "permanent role" / "role (permanent)"
    String.raw`\bpermanent[\s_-]*role\b`,
    String.raw`\brole\s*\(\s*permanent\b`,
    // an explicit declaration, imperative only
    String.raw`\bnever[\s_-]+close(?:\s+(?:it|this|me))?\b`,
    String.raw`\bdo\s+not\s+close\s+(?:it|this)\b`,
  ].join('|'),
  'i',
);
/** Pure: does this todo declare itself a never-close standing role? */
export function isStandingRoleTodo(t: { title?: string | null; progressNote?: string | null }): boolean {
  const title = String(t.title ?? '');
  if (STANDING_ROLE_MARKER_RE.test(title)) return true;
  const note = String(t.progressNote ?? '');
  return note ? STANDING_ROLE_MARKER_RE.test(note) : false;
}
interface StandingRoleRow {
  id: string;
  title: string;
  assigneeChatId: string | null;
  updatedAt: Date;
  progressNote?: string | null;
}
/**
 * The ADOPTION check that replaces the stall clock for standing roles: returns
 * the rows whose assignee lane shows NO new activity within
 * STANDING_ROLE_QUIET_MS. Lane activity is the newest agent_runs stamp (a
 * standing role adopts by its lane doing the work, not by touching the todo);
 * with no lane, a lane that never ran, or a LOOKUP FAILURE, the todo's own last
 * touch stands in. That is the safe direction: an unreadable lane clock makes a
 * row MORE likely to surface, never less, so a genuinely dead role is never
 * silently hidden behind a DB outage. The cost is bounded and honest — a row
 * untouched > 72 h surfaces as "no adoption", which is exactly what an
 * unreadable lane clock cannot rule out.
 */
async function standingRolesWithoutAdoption<T extends StandingRoleRow>(rows: T[], now: Date): Promise<T[]> {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((t) => t.assigneeChatId).filter((x): x is string => Boolean(x)))];
  const lastRunMs = new Map<string, number>();
  if (ids.length) {
    try {
      const aggs = await (prisma.agentRun as any)
        .groupBy({ by: ['sessionId'], where: { sessionId: { in: ids } }, _max: { updatedAt: true } })
        .catch(() => [] as any[]);
      for (const g of aggs ?? []) {
        const ms = g?._max?.updatedAt ? new Date(g._max.updatedAt).getTime() : NaN;
        if (Number.isFinite(ms)) lastRunMs.set(g.sessionId, ms);
      }
    } catch {
      // Fall through to the todo clock — the same rule the no-run case uses.
    }
  }
  return rows.filter((t) => {
    const last = t.assigneeChatId ? lastRunMs.get(t.assigneeChatId) : undefined;
    const lastMs = Number.isFinite(last as number) ? (last as number) : t.updatedAt.getTime();
    return now.getTime() - lastMs >= STANDING_ROLE_QUIET_MS;
  });
}

/**
 * Ticket 09880586 — does one enabled, still-due schedule's stored prompt
 * reference this todo? The matching is STRICT, not cosmetic:
 *  - leg A (prompt → todo): the todo's 8-char id prefix must appear in the
 *    prompt as an id-ish token — 'Todo fea78360', 'todo 4e3b53a5', or a bare
 *    prefix. A prefix that happens to open a longer hex run is NOT a match
 *    (the word-boundary hex guard), so a prompt naming 'todo ab12cd34' does
 *    not credit todo 'ab12cd34-5678' when it actually means another row.
 *  - leg B (progressNote → schedule): the todo's progressNote names the
 *    schedule by an id-ish token (8+ hex), matching this row's own id prefix.
 * 'Still due' = kind 'recurring' (it re-arms every firing) or a one-shot whose
 * nextRunAt/expiresAt is in the future — a spent one-shot (the sweeper flips
 * enabled:false) or an expired row credits nothing.
 */
function scheduleCreditsTodo(
  sched: { id: string; kind: string; enabled: boolean; nextRunAt?: Date | null; expiresAt?: Date | null; prompt: string },
  todo: { id: string; progressNote?: string | null },
  now: Date,
): boolean {
  if (!sched.enabled) return false;
  // Still due: a recurring row always re-arms; a one-shot is due only while
  // its next fire (or its expiry ceiling) lies in the future.
  const dueAt = sched.nextRunAt ?? sched.expiresAt;
  if (sched.kind === 'once' && dueAt && dueAt.getTime() <= now.getTime()) return false;
  const prefix = todo.id.slice(0, 8);
  const promptText = String(sched.prompt ?? '');
  // Leg A: the todo prefix appears in the prompt as a hex-id token, never as
  // the head of a LONGER hex run ('fea78360' inside 'fea78360deadbeef…' is a
  // different row's id, not this todo).
  const promptRef = new RegExp(`(?:^|[^0-9a-f])${prefix}(?![0-9a-f])`, 'i').test(promptText);
  if (promptRef) return true;
  // Leg B: the todo's own progressNote cites this schedule's id.
  const note = String(todo.progressNote ?? '');
  if (!note) return false;
  const schedPrefix = sched.id.slice(0, 8);
  return new RegExp(`(?:^|[^0-9a-f])${schedPrefix}(?![0-9a-f])`, 'i').test(note);
}

/**
 * Ticket 09880586 — drop stalled-todo candidates that are in DESIGNED WAIT:
 * an enabled, still-due schedule references the todo (its prompt names the
 * todo, or the todo's progressNote cites the schedule id). This is POSITIVE
 * evidence the quiet is armed, exactly like the 8f5a45f7 liveness credit but
 * for the wait itself. One capped lookup pulls the owner's enabled schedules
 * once per wake (the prompts), matches locally, and drops ONLY matching rows.
 * TOTAL / fail-open: ANY failure (sync or async) degrades to NO suppression —
 * today's behavior — never to hiding a genuine stall; the kill switch
 * restores the bare-clock behavior byte-for-byte.
 */
async function filterStalledByArmedReadback<
  T extends { id: string; progressNote?: string | null; updatedAt: Date },
>(stalled: T[], now: Date): Promise<T[]> {
  try {
    if (readbackCreditDisabled() || !stalled.length) return stalled;
    const todoIds = new Set(stalled.map((t) => t.id));
    const scheds = await prisma.codingSchedule.findMany({
      where: { enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { id: true, kind: true, enabled: true, nextRunAt: true, expiresAt: true, prompt: true },
      // Capped on purpose: the exemption is per-todo, and a pathological fleet
      // (thousands of armed schedules) must not turn every wake into a prompt
      // scan. Newest-first — a freshly armed read-back outranks old rows.
      orderBy: { createdAt: 'desc' },
      take: READBACK_MAX_SCHEDULES,
    });
    if (!Array.isArray(scheds) || !scheds.length) return stalled;
    return stalled.filter(
      (t) => !(todoIds.has(t.id) && scheds.some((s) => scheduleCreditsTodo(s as any, t, now))),
    );
  } catch {
    // TOTAL, like filterStalledByAssigneeLiveness: ANY failure degrades to
    // today's flagging, never to losing the whole block.
    return stalled;
  }
}

/**
 * Ticket 09880586 — drop stalled-todo candidates whose ASSIGNEE LANE is
 * provably alive. A GET-only watch lane fires on cadence and self-audits
 * clean without ever writing its todo when nothing changed upstream, so a
 * bare todo.updatedAt check flagged healthy watches as STALLED on every
 * supervisor wake (each costing a reconcile probe that came back clean).
 * Kept: no assignee, lane never ran, lane's newest run older than
 * STALE_IN_PROGRESS_MS + the lane's longest enabled cadence, or the todo
 * untouched past STALLED_BACKSTOP_MS (live-lane drift backstop). Both
 * lookups degrade to [] on failure (→ no suppression, today's behavior).
 */
async function filterStalledByAssigneeLiveness<T extends { assigneeChatId: string | null; updatedAt: Date }>(
  stalled: T[],
  now: Date,
): Promise<T[]> {
  try {
    const ids = [...new Set(stalled.map((t) => t.assigneeChatId).filter((x): x is string => Boolean(x)))];
    if (!ids.length) return stalled;
    const [runAggs, cadenceRows] = await Promise.all([
      (prisma.agentRun as any)
        .groupBy({ by: ['sessionId'], where: { sessionId: { in: ids } }, _max: { updatedAt: true } })
        .catch(() => [] as any[]),
      prisma.codingSchedule
        .findMany({ where: { sessionId: { in: ids }, enabled: true }, select: { sessionId: true, intervalSec: true } })
        .catch(() => [] as any[]),
    ]);
    const lastRunMs = new Map<string, number>();
    for (const g of runAggs ?? []) {
      const ms = g?._max?.updatedAt ? new Date(g._max.updatedAt).getTime() : NaN;
      if (Number.isFinite(ms)) lastRunMs.set(g.sessionId, ms);
    }
    const cadenceMs = new Map<string, number>();
    for (const r of cadenceRows ?? []) {
      const ms = Number(r?.intervalSec) * 1000;
      if (Number.isFinite(ms) && ms > 0) cadenceMs.set(r.sessionId, Math.max(cadenceMs.get(r.sessionId) ?? 0, ms));
    }
    return stalled.filter((t) => {
      const id = t.assigneeChatId;
      if (!id) return true; // no assignee to liveness-check — flag as before
      if (now.getTime() - t.updatedAt.getTime() >= STALLED_BACKSTOP_MS) return true; // drift backstop
      const last = lastRunMs.get(id);
      if (!Number.isFinite(last)) return true; // lane never ran (or liveness lookup failed) — flag as before
      const windowMs = STALE_IN_PROGRESS_MS + (cadenceMs.get(id) ?? 0);
      return now.getTime() - (last as number) >= windowMs; // live lane → suppress; silent lane → flag
    });
  } catch {
    // TOTAL, like its caller: ANY liveness failure (sync or async) degrades to
    // NO suppression — today's behavior — never to losing the whole block.
    return stalled;
  }
}

/**
 * Live drift signals for the supervisor's machine-wake injection:
 *  - STALLED todos: in_progress but untouched > 2h AND the assignee lane is
 *    not demonstrably alive (ticket 8f5a45f7 — a watch lane firing within its
 *    cadence is not stalled even when its todo goes unwritten; a >24h
 *    untouched todo surfaces regardless as drift).
 *  - UNSTARTED todos: pending WITH an assignee, untouched > 6h (the wake
 *    never landed or was never acted on).
 *  - BOTH todo pulls drop freshly-RECONCILED rows (ticket e13f216e): a
 *    progressNote restamped < 12h ago is positive evidence a supervisor or
 *    lane looked at the todo and left it queued on purpose — the bare
 *    updatedAt cutoff re-flagged deliberate queues 6h after every reconcile
 *    stamp and mislabeled the restamp time as the assignment age.
 *  - MACHINE-WRITTEN schedule prompts: enabled schedules whose stored prompt
 *    was last written autonomously (promptSetBy='machine') — review for
 *    watch-mode scope drift (the 2026-08-29 lanes-auditing-instead-of-working
 *    incident). 'system' (framework) and 'user' prompts are excluded.
 *  - OPEN owner decisions (ticket 43212128): flag_owner_question rows the
 *    owner has NOT answered. The 2026-09-05 incident: a lane's decisions
 *    surfaced only as text in the supervisor's own wake notes, scrolled away,
 *    and a later note assumed "the decisions you already know about" — the
 *    owner did not. Listed deterministically EVERY wake until resolved so the
 *    note can never silently drop them. Dedupe-aware since ticket df4cff3c:
 *    NEW cards (< 6h) re-list verbatim every wake; long-unchanged cards ride a
 *    single summary line with the full re-list capped at once per 6h / on any
 *    state change — otherwise days-old cards freeze every wake note.
 * Returns '' when there is nothing to flag. Never throws.
 */
export async function buildFleetAttentionBlock(userId: string, now: Date = new Date()): Promise<string> {
  try {
    const [stalledCandidates, unstartedCandidates, machinePrompts, ownerDecisions, needsYou] = await Promise.all([
      prisma.projectTodo.findMany({
        where: { userId, status: 'in_progress', updatedAt: { lt: new Date(now.getTime() - STALE_IN_PROGRESS_MS) } },
        // id rides the select for the armed-readback credit (09880586): leg B
        // matches the todo's progressNote against a schedule id, and leg A
        // matches the schedule's prompt against this row's own id prefix.
        select: { id: true, title: true, assigneeChatId: true, updatedAt: true, progressNote: true, createdAt: true },
        // Over-fetch: liveness suppression (ticket 8f5a45f7) drops rows AFTER
        // this take, and without headroom a page of live-lane watches could
        // hide a genuine stall sitting just past the cutoff.
        orderBy: { updatedAt: 'asc' }, take: ATTENTION_MAX_LINES * 4,
      }),
      prisma.projectTodo.findMany({
        where: { userId, status: 'pending', assigneeChatId: { not: null }, updatedAt: { lt: new Date(now.getTime() - STALE_ASSIGNED_MS) } },
        // id rides the select for the standing-role split (ticket d1a7bec2):
        // a row pulled by BOTH probes must be de-duplicated by its own id.
        select: { id: true, title: true, assigneeChatId: true, updatedAt: true, progressNote: true, createdAt: true },
        // Over-fetch like the stalled pull: reconcile-annotation suppression
        // (ticket e13f216e) drops rows AFTER this take, and without headroom
        // a page of freshly-annotated queues could hide a genuine non-start.
        orderBy: { updatedAt: 'asc' }, take: ATTENTION_MAX_LINES * 4,
      }),
      prisma.codingSchedule.findMany({
        // Ticket 03aef0da: still-LIVE rows only — enabled AND not past their
        // lifetime ceiling (an expired row is stopped on the sweeper's next pass).
        where: fullScheduleIdsDisabled()
          ? { userId, enabled: true, promptSetBy: 'machine' }
          : { userId, enabled: true, promptSetBy: 'machine', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { id: true, sessionId: true, createdAt: true },
        orderBy: { createdAt: 'desc' }, take: ATTENTION_MAX_LINES,
      }),
      prisma.ownerQuestion.findMany({
        where: { userId, status: 'open' },
        select: { question: true, chatId: true, createdAt: true },
        orderBy: { createdAt: 'asc' }, take: ATTENTION_MAX_LINES,
      }),
      // Todo 908f48a7 (monitor lesson 5): the needs-you UNION — open cards +
      // todos/goals blocked on an owner action, INCLUDING approved-but-never-
      // landed ones (an ANSWERED gate still blocking its row). "Nothing needs
      // the owner" was counted from open cards alone across nine notes while
      // lane 24f1950e's deploy sat blocked on the owner's approved Tailscale
      // ACL save (specimens 970e4dcb…f561c547). Fail-open: null skips the
      // section, never renders a false zero.
      loadNeedsYouUnion({ userId }).catch(() => null),
    ]);
    // Ticket 8f5a45f7: drop watch-lane false positives, then re-cap to the
    // render budget (the over-fetch above keeps genuine stalls visible).
    // Ticket e13f216e: drop FRESHLY-RECONCILED rows first — a progressNote
    // restamp < 12h old is positive reconcile evidence (a deliberate queue
    // or active work), for BOTH pulls; it composes with the 24h drift
    // backstop (a fresh stamp implies updatedAt < 12h, never >= 24h).
    // Ticket 09880586: drop ARMED-READBACK rows (designed wait) — AFTER the
    // liveness pass so both credits compose, and only from the STALLED pull:
    // the referencing-schedule credit is positive evidence the quiet window
    // is armed (the read-back firing will move the todo), while an UNSTARTED
    // row on a live lane stays the genuine non-start signal it always was.
    // Ticket d1a7bec2 (CASE 1): split the STANDING ROLE rows out of BOTH pulls
    // before the stall clocks run at all — a never-close duty cannot be
    // "stalled" or "unstarted" in the sense those sections mean, and its only
    // possible remedy is the adoption check (re-steer or retire the role), not
    // "close it with todo_update". The split is first so no other credit has to
    // reason about a row that is intentionally permanent.
    //
    // The KILL SWITCH gates the split itself, not just the adoption lines: with
    // FLEET_ATTENTION_STANDING_ROLE_CREDIT_DISABLED=1 the standing rows must
    // return to the ordinary pulls (the pre-fix rendering), never vanish from
    // the block entirely — a switch that hides a row is worse than the false
    // positive it replaces.
    const creditOff = standingRoleCreditDisabled();
    const standingPull = creditOff ? [] : [...stalledCandidates, ...unstartedCandidates].filter((t) => isStandingRoleTodo(t));
    const standingIds = new Set(standingPull.map((t) => t.id));
    const stalledPool = stalledCandidates.filter((t) => !standingIds.has(t.id));
    const unstartedPool = unstartedCandidates.filter((t) => !standingIds.has(t.id));
    const stalled = (await filterStalledByArmedReadback(
      await filterStalledByAssigneeLiveness(stalledPool.filter((t) => !isFreshlyReconciled(t, now)), now),
      now,
    )).slice(0, ATTENTION_MAX_LINES);
    const unstarted = unstartedPool.filter((t) => !isFreshlyReconciled(t, now)).slice(0, ATTENTION_MAX_LINES);
    // The adoption check that REPLACES the stall clock for standing roles: only
    // a role whose lane has shown no activity for STANDING_ROLE_QUIET_MS
    // re-surfaces, on its own line with its own remedy. The 12h fresh-note and
    // 24h drift-backstop clocks are deliberately NOT applied here — they are
    // exactly what re-flagged a healthy permanent role every day.
    const staleStanding = creditOff
      ? []
      : await standingRolesWithoutAdoption(standingPull.filter((t) => !isFreshlyReconciled(t, now)), now);
    // Sizing rework (remediation P2 v1#2): one hoisted instruction header per
    // section + short capped item lines; overflow drops whole items ("+N
    // more"), never a mid-sentence slice.
    const capItem = (s: string) => (s.length <= ATTENTION_ITEM_CAP ? s : s.slice(0, ATTENTION_ITEM_CAP - 1) + '…');
    const section = (header: string, items: string[]): string => {
      if (!items.length) return '';
      const capped = items.map(capItem);
      const kept: string[] = [];
      let used = header.length;
      for (const line of capped) {
        if (used + line.length + 1 > ATTENTION_SECTION_CAP && kept.length > 0) break;
        kept.push(line);
        used += line.length + 1;
      }
      const dropped = capped.length - kept.length;
      return [header, ...kept, ...(dropped > 0 ? [`- …+${dropped} more (see the Management dashboard)`] : [])].join('\n');
    };
    const sections: string[] = [];
    // Owner decisions FIRST — a decision the owner never sees is the failure
    // class this block exists to kill; cap pressure drops the later sections.
    // Dedupe-aware re-listing (ticket df4cff3c): the every-wake verbatim rule
    // froze owner-facing notes once cards stayed open for days (owner
    // complaint 2026-09-13) and contradicted the supervisor's own ≤1×/6h
    // wake-economy rule. NEW cards (< 6h — a fresh state change) still re-list
    // verbatim every wake; long-unchanged cards compress into ONE summary line
    // and the header caps their full re-listing at once per 6h / the moment
    // one changes state. createdAt is the only durable per-decision timestamp
    // (OwnerQuestion has no updatedAt; open rows never carry resolvedAt), and
    // the findMany is createdAt-asc, so unchanged cards always sort first.
    const freshCutoff = now.getTime() - OWNER_DECISION_VERBATIM_WINDOW_MS;
    const freshDecisions = ownerDecisions.filter((q) => q.createdAt.getTime() >= freshCutoff);
    const unchangedCount = ownerDecisions.length - freshDecisions.length;
    const decisionItems: string[] = [];
    if (unchangedCount > 0) {
      decisionItems.push(
        `- ${unchangedCount} owner decision${unchangedCount === 1 ? '' : 's'} open 6h+ unchanged (oldest ${ageMs(now.getTime() - ownerDecisions[0].createdAt.getTime())}) — see Management → Inbox`,
      );
    }
    decisionItems.push(...freshDecisions.map((q) => `- OWNER DECISION open ${ageMs(now.getTime() - q.createdAt.getTime())} — "${q.question.slice(0, 90)}" (from chat ${wakeId(q.chatId)})`));
    sections.push(section(
      'OWNER DECISIONS OPEN — unanswered. Re-list each VERBATIM in your wake note while NEW (<6h); NEVER write "the decisions you already know about" (2026-09-05 incident). Cards unchanged 6h+ ride the one-line summary — full re-list ≤1×/6h or the moment one changes (df4cff3c). If one vanishes, check the transcript before re-asking.',
      decisionItems,
    ));
    // Todo 908f48a7 (monitor lesson 5): the needs-you UNION section — renders
    // ONLY when it adds information the OWNER DECISIONS section does not carry
    // (total > 0: an approved-but-never-landed action, or owner-gated rows the
    // open-cards list alone never showed). A true zero renders nothing — the
    // pre-existing empty-block contract holds, and a false "nothing needs the
    // owner" claim is the DETECTOR's business (owner_status_proxy_mismatch),
    // not this block's. Skipped on a read failure (fail-open null).
    if (needsYou && needsYou.total > 0) {
      const unionItems: string[] = [];
      if (needsYou.unlandedTitles.length) {
        unionItems.push(...needsYou.unlandedTitles.map((title) => `- APPROVED BY THE OWNER, FOLLOW-UP NOT LANDED: "${capItem(title)}" — the action this answer unlocks is still outstanding; it NEEDS the owner's attention even though no card is open`));
      }
      if (needsYou.ownerBlockedTitles.length) {
        unionItems.push(`- ${needsYou.ownerBlockedTitles.length} further item(s) blocked on the open card(s) above — subsumed by them, never extra`);
      }
      if (unionItems.length) {
        sections.push(section(
          `NEEDS-YOU UNION (todo 908f48a7) — ${needsYou.total} item(s) = ${needsYou.openCards} open card(s) + ${needsYou.answeredUnlanded} approved action(s) not yet landed. This is the ONLY basis for any "nothing needs the owner" / "Needs you: nothing" / "zero open questions" claim — never count open cards alone.`,
          unionItems,
        ));
      }
    }
    sections.push(section(
      'STALLED / UNSTARTED TODOS — RECONCILE FIRST: if the work already landed via another channel (merged PR, ops block, owner action), close it with todo_update; only then nudge, re-plan, or re-dispatch with send_chat_message. STANDING ROLE rows below are permanent by design — NEVER close one; re-steer the launch channel or retire the role.',
      [
        ...stalled.map((t) => `- STALLED todo "${t.title.slice(0, 70)}" — in_progress, untouched ${ageMs(now.getTime() - t.updatedAt.getTime())} (assignee chat ${wakeId(t.assigneeChatId)})`),
        // Ticket d1a7bec2: a standing role NEVER reads STALLED/UNSTARTED — it
        // reads as its own adoption signal, with the only remedy that fits a
        // never-close duty. The clock printed is the ADOPTION age (how long the
        // role has gone without lane activity), labelled as such so it cannot be
        // misread as the todo's own untouched age. The line is kept well under
        // ATTENTION_ITEM_CAP (160) so the REMEDY — the whole point of the line —
        // is never the part the cap truncates.
        ...staleStanding.map((t) => `- STANDING ROLE, NO ADOPTION ${ageMs(now.getTime() - t.updatedAt.getTime())} — "${t.title.slice(0, 44)}" (${wakeId(t.assigneeChatId)}) — never close it; re-steer or retire the role`),
        ...unstarted.map((t) => {
          // Age honesty (ticket e13f216e): the stale clock keys on the row's
          // LAST TOUCH (a reconcile restamp bumps @updatedAt), so the old
          // "assigned N ago" wording misstated the stall age — a 28h-old todo
          // restamped 7h prior rendered "assigned 7h ago". Report the
          // untouched age plus the true creation age when the row carries it.
          const created = t.createdAt instanceof Date && !Number.isNaN(t.createdAt.getTime())
            ? `, created ${ageMs(now.getTime() - t.createdAt.getTime())}`
            : '';
          return `- UNSTARTED todo "${t.title.slice(0, 70)}" — pending, untouched ${ageMs(now.getTime() - t.updatedAt.getTime())}${created} (chat ${wakeId(t.assigneeChatId, '(unassigned)')})`;
        }),
      ],
    ));
    // Ticket 03aef0da: the 8-char "c461c912…" form was neither unique nor
    // resolvable once the row aged out of schedule_get's listing window — print
    // the FULL id (schedule_get resolves it at any status).
    sections.push(fullScheduleIdsDisabled()
      ? section(
        'MACHINE-WRITTEN SCHEDULE PROMPTS — schedule_get each and confirm the cadence still matches the owner\'s intent (watch-mode drift check; prompts carry no updated-at, so rewrites of older rows hide here too).',
        machinePrompts.map((s) => `- MACHINE-WRITTEN schedule prompt ${s.id.slice(0, 8)}… on chat ${wakeId(s.sessionId)} (created ${ageMs(now.getTime() - s.createdAt.getTime())} ago)`),
      )
      : section(
        'MACHINE-WRITTEN SCHEDULE PROMPTS (enabled when this block was computed) — schedule_get each by the FULL id below and confirm the cadence still matches the owner\'s intent (watch-mode drift check; prompts carry no updated-at, so rewrites of older rows hide here too). One that reads [stopped] was stopped since — skip it.',
        machinePrompts.map((s) => `- schedule ${s.id} on chat ${wakeId(s.sessionId)} (created ${ageMs(now.getTime() - s.createdAt.getTime())} ago)`),
      ));
    const body = sections.filter(Boolean).join('\n');
    if (!body) return '';
    const block = `[FLEET ATTENTION — live ground truth, computed this wake. These override anything your notes imply:]\n${body}`;
    if (block.length <= ATTENTION_BLOCK_CAP) return block;
    // Last resort: cut at a LINE boundary, never mid-sentence.
    const cut = block.slice(0, ATTENTION_BLOCK_CAP - 20);
    const lastNl = cut.lastIndexOf('\n');
    return (lastNl > 0 ? cut.slice(0, lastNl) : cut) + '\n…[truncated]';
  } catch (err: any) {
    logger.warn(`supervisor-state: fleet attention block failed: ${err?.message ?? err}`, { source: 'supervisor-state' });
    return '';
  }
}

// ── Fleet liveness block (remediation P7, spark G4) ──────────────────────────
// A CODE-BUILT per-project machine-heartbeat table for the supervisor's wakes:
// enabled schedules, last firing age, live (running/queued) runs — grouped
// queries only, so the wake cost stays flat. The attention block above lists
// EXCEPTIONS; this lists the BASELINE, so a project that silently has no
// heartbeat at all (zero schedules, zero runs) is visible as exactly that.

/** Bound on rendered project lines (blocked-first ordering is not needed —
 *  the table is a baseline, not an alarm feed). */
const LIVENESS_MAX_LINES = 12;
const LIVENESS_BLOCK_CAP = 1400;
/** Bound on owner chats scanned (pathology guard, mirrors the fleet views). */
const LIVENESS_MAX_CHATS = 500;

/**
 * Per-project liveness for one owner's fleet: '' when the owner has no chats
 * (or on any failure — total, like everything in this module).
 */
export async function buildFleetLivenessBlock(userId: string, now: Date = new Date()): Promise<string> {
  try {
    const chats = await prisma.crossModelChat.findMany({
      where: { userId, archivedAt: null },
      select: { id: true, projectId: true },
      take: LIVENESS_MAX_CHATS,
    });
    if (!chats.length) return '';
    const chatIds = chats.map((c: any) => c.id);
    const projectOfChat = new Map<string, string | null>(chats.map((c: any) => [c.id, c.projectId ?? null]));
    const [schedGroups, runGroups, nearCapRows] = await Promise.all([
      (prisma.codingSchedule as any).groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: chatIds }, enabled: true },
        _count: { _all: true },
        _max: { lastFiredAt: true },
      }).catch(() => [] as any[]),
      (prisma.agentRun as any).groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: chatIds }, status: { in: ['running', 'queued'] } },
        _count: { _all: true },
      }).catch(() => [] as any[]),
      // Near-cap utilization (ticket b4d1096c): enabled recurring rows already
      // past the scheduleNearCapCause threshold — the pre-emptive "re-arm me"
      // signal this table lacked (only the post-death schedule_disabled
      // existed). Row scan is bounded by the fleet's enabled-row count; the
      // same predicate the sweeper emits on, so the table never disagrees
      // with the alert.
      prisma.codingSchedule.findMany({
        where: { sessionId: { in: chatIds }, enabled: true, kind: 'recurring' },
        select: { id: true, sessionId: true, kind: true, runsCount: true, maxRuns: true, expiresAt: true },
        take: 1000,
      }).catch(() => [] as any[]),
    ]);
    interface Agg { schedules: number; lastFiredMs: number | null; liveRuns: number }
    const byProject = new Map<string | null, Agg>();
    const aggOf = (projectId: string | null): Agg => {
      const cur = byProject.get(projectId) ?? { schedules: 0, lastFiredMs: null, liveRuns: 0 };
      byProject.set(projectId, cur);
      return cur;
    };
    for (const g of schedGroups ?? []) {
      const agg = aggOf(projectOfChat.get(g.sessionId) ?? null);
      agg.schedules += Number(g?._count?._all) || 0;
      const ms = g?._max?.lastFiredAt ? new Date(g._max.lastFiredAt).getTime() : NaN;
      if (Number.isFinite(ms)) agg.lastFiredMs = Math.max(agg.lastFiredMs ?? 0, ms);
    }
    for (const g of runGroups ?? []) {
      aggOf(projectOfChat.get(g.sessionId) ?? null).liveRuns += Number(g?._count?._all) || 0;
    }
    if (!byProject.size) return ''; // no schedules, no live runs anywhere — nothing to table
    // Cover EVERY project that has chats (a project with zero heartbeat is the
    // signal this table exists for), not just the ones with rows.
    for (const pid of new Set(chats.map((c: any) => (c.projectId ?? null) as string | null))) aggOf(pid);
    const projectIds = [...byProject.keys()].filter((p): p is string => !!p);
    // Live-work signals (ticket b1d435fd dormant-by-design render): open
    // goals/todos and LIVE watched resources per project. Scoped by userId
    // (both models carry it) — the same owner scope as the chat scan above.
    const [goalGroups, todoGroups, watchedGroups] = projectIds.length
      ? await Promise.all([
          (prisma.projectGoal as any).groupBy({
            by: ['projectId'],
            where: { userId, status: { in: ['active', 'blocked'] } },
            _count: { _all: true },
          }).catch(() => [] as any[]),
          (prisma.projectTodo as any).groupBy({
            by: ['projectId'],
            where: { userId, status: { in: ['pending', 'in_progress', 'blocked'] } },
            _count: { _all: true },
          }).catch(() => [] as any[]),
          (prisma.watchedResource as any).groupBy({
            by: ['projectId'],
            where: { userId, projectId: { in: projectIds }, OR: [{ reservationEndsAt: null }, { reservationEndsAt: { gt: now } }] },
            _count: { _all: true },
          }).catch(() => [] as any[]),
        ])
      : [[], [], []];
    const liveWorkOf = new Map<string, number>();
    for (const g of [...(goalGroups ?? []), ...(todoGroups ?? []), ...(watchedGroups ?? [])]) {
      if (!g?.projectId) continue;
      liveWorkOf.set(g.projectId, (liveWorkOf.get(g.projectId) ?? 0) + (Number(g?._count?._all) || 0));
    }
    const names = projectIds.length
      ? await prisma.crossModelProject.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } }).catch(() => [] as any[])
      : [];
    const nameById = new Map((names as any[]).map((p) => [p.id, p.name]));
    // Near-cap annotation (ticket b4d1096c): id-prefixed '441/500' (run cap) /
    // expiry-date (lifetime window) fragments per project, computed with the
    // sweeper's own predicate — the pre-emptive re-arm signal this table
    // lacked (only the post-death schedule_disabled existed). Capped per line:
    // the table stays a baseline, the hook event carries the alarm.
    const nearCapByProject = new Map<string | null, string[]>();
    for (const r of nearCapRows ?? []) {
      const cause = scheduleNearCapCause(r as any, now);
      if (!cause) continue;
      const pid = projectOfChat.get((r as any).sessionId) ?? null;
      const frag = cause === 'run_cap'
        ? `${(r as any).id.slice(0, 8)} ${(r as any).runsCount}/${(r as any).maxRuns}`
        : `${(r as any).id.slice(0, 8)} expiry ${(r as any).expiresAt ? new Date((r as any).expiresAt).toISOString().slice(0, 10) : 'soon'}`;
      const list = nearCapByProject.get(pid) ?? [];
      list.push(frag);
      nearCapByProject.set(pid, list);
    }
    const lines = [...byProject.entries()]
      .map(([pid, agg]) => {
        const name = pid ? (nameById.get(pid) ?? `project ${wakeId(pid)}`) : 'Ungrouped chats';
        // Dormant-by-design (b1d435fd): no heartbeat AND no live work anywhere
        // (runs, goals, todos, watched resources) is the DESIRED zero-wake
        // state, not deafness — DEAF now requires live work to exist.
        const dormant = agg.schedules === 0 && agg.liveRuns === 0 && !!pid && (liveWorkOf.get(pid) ?? 0) === 0;
        const firing = agg.schedules === 0
          ? (dormant
              ? 'dormant-by-design (no live work — hooks wake on new work; re-arm NOTHING here)'
              : 'NO enabled schedules (deaf unless a run is live)')
          : `last firing ${agg.lastFiredMs ? `${ageMs(now.getTime() - agg.lastFiredMs)} ago` : 'never'}`;
        const near = nearCapByProject.get(pid);
        const nearNote = near?.length
          ? ` · ⚠ NEAR-CAP: ${near.slice(0, 3).join(', ')}${near.length > 3 ? ` +${near.length - 3} more` : ''} — re-arm pre-emptively (each row also fires one schedule_near_cap hook event)`
          : '';
        return `- ${String(name).slice(0, 60)}: ${agg.schedules} enabled schedule(s), ${firing}, ${agg.liveRuns} running/queued run(s)${nearNote}`;
      })
      .sort()
      .slice(0, LIVENESS_MAX_LINES);
    const block = `[FLEET LIVENESS — per-project machine heartbeat, computed this wake (enabled schedules · last firing age · live runs). A monitored project with no schedules and no live runs is DEAF only if it has live work (active goals, open todos, or watched resources) — re-arm it or say why not; a project with NO live work is dormant-by-design (owner directive 2026-09-18, ticket b1d435fd): zero wakes there, re-arm NOTHING, event hooks are its wake path when work appears:]\n${lines.join('\n')}`;
    return block.length <= LIVENESS_BLOCK_CAP ? block : `${block.slice(0, LIVENESS_BLOCK_CAP - 15)}\n…[truncated]`;
  } catch (err: any) {
    logger.warn(`supervisor-state: fleet liveness block failed: ${err?.message ?? err}`, { source: 'supervisor-state' });
    return '';
  }
}

// ── Project-supervisor per-lane schedule truth (ticket 69d0c808) ────────────
// A PROJECT supervisor's machine wake loads its durable doc but NONE of the
// live fleet blocks above (those are owner-scoped, fleet-lane only) — so it
// composed a wake note about a worker lane's cadence from MEMORY and
// confabulated two schedule ids ("two enabled re-arms already queued", sched
// 87b434c5 / 184533b6) for a lane whose six schedules were ALL stopped; the
// delivery guard struck the note pre-delivery. This block is the compose-time
// ground truth for THAT lane universe: per-lane enabled rows (id prefix +
// next fire), stopped counts, last-firing age and live runs, computed this
// wake — an "enabled re-arms queued" claim is either citable from here or
// visibly false. TOTAL like everything here: any failure degrades to ''.

/** Pathology guards (per-project lane/row counts are normally tiny). */
const PROJECT_SCHEDULE_MAX_CHATS = 100;
/** Cap on the ENABLED rows pulled for the id/next-fire render. Counts ride an
 *  UNCAPPED groupBy instead (adversarial-review follow-up, ticket 69d0c808):
 *  a capped unordered findMany could silently drop a lane's enabled rows and
 *  fabricate the exact false "NO enabled schedules" signal this block exists
 *  to kill — the cap here can only truncate the citation list, never counts. */
const PROJECT_SCHEDULE_MAX_ENABLED_ROWS = 200;
/** Rendered bounds — a baseline table, not an alarm feed. */
const PROJECT_SCHEDULE_MAX_LINES = 16;
// audit 2026-10-08 W1-7: +450 for the FULL chat id per lane line (36 vs 9 chars × 16 lines).
const PROJECT_SCHEDULE_BLOCK_CAP = 2850;
/** Enabled schedule ids rendered per lane (with next-fire) — citation-ready. */
const PROJECT_SCHEDULE_MAX_IDS = 3;

/** IDLE CADENCE verdict inputs (autonomy loop #12). */
export const IDLE_CADENCE_FINALS_WINDOW = 5;
export const IDLE_CADENCE_MIN_FINALS = 3;
export const IDLE_CADENCE_MAX_RUN_MIN = 6;
/** No-op wording a lane's machine final carries when the firing produced nothing (conservative). */
export const IDLE_FINAL_RE = /\b(?:no-?op\b|nothing (?:new|to do|changed|moved|to report)|no changes?\b|no new (?:work|items|events|commits|activity|findings)|trigger unmet|standing down|stand-?by (?:watch|tick|verdict)|self-audit[^.\n]{0,40}\bpass\b|all \d+ steps (?:are )?done|already complete|unchanged since|nothing (?:needs|requires) (?:me|action))/i;
const MACHINE_FINAL_ORIGINS = new Set(['schedule', 'hook', 'agent', 'machine']);

export interface IdleCadenceVerdict { examined: number; idle: number; avgRunMin: number | null }

/** Pure: classify a lane's recent machine finals + run durations. Null = not idle (or too little evidence). */
export function judgeIdleCadence(finals: string[], runMinutes: number[]): IdleCadenceVerdict | null {
  const examined = finals.length;
  if (examined < IDLE_CADENCE_MIN_FINALS) return null;
  const idle = finals.filter((f) => IDLE_FINAL_RE.test(String(f ?? '').slice(0, 800))).length;
  const avgRunMin = runMinutes.length ? Math.round((runMinutes.reduce((a, b) => a + b, 0) / runMinutes.length) * 10) / 10 : null;
  if (idle / examined < 0.8) return null;
  if (avgRunMin != null && avgRunMin >= IDLE_CADENCE_MAX_RUN_MIN) return null; // real work that merely SAYS "no change"
  return { examined, idle, avgRunMin };
}

/**
 * Per-lane idle verdicts for the schedule block: the lane's last
 * IDLE_CADENCE_FINALS_WINDOW machine-origin finals (schedule/hook/agent wakes;
 * status cards and user turns excluded) + its last completed run durations.
 * Any read failure leaves the lane un-annotated. Never throws.
 */
async function computeIdleCadenceVerdicts(chatIds: string[]): Promise<Map<string, IdleCadenceVerdict>> {
  const out = new Map<string, IdleCadenceVerdict>();
  for (const sid of chatIds.slice(0, 12)) {
    try {
      const msgs: any[] = (await Promise.resolve((prisma as any).crossModelMessage?.findMany?.({
        where: { chatId: sid, role: 'assistant' },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { content: true, metadata: true },
      })).catch(() => [])) ?? [];
      const finals = msgs
        .filter((m) => MACHINE_FINAL_ORIGINS.has(String(m?.metadata?.origin ?? '')))
        .slice(0, IDLE_CADENCE_FINALS_WINDOW)
        .map((m) => String(m?.content ?? ''));
      if (finals.length < IDLE_CADENCE_MIN_FINALS) continue;
      const runs: any[] = (await Promise.resolve((prisma.agentRun as any).findMany?.({
        where: { sessionId: sid, status: 'completed' },
        orderBy: { createdAt: 'desc' },
        take: IDLE_CADENCE_FINALS_WINDOW,
        select: { startedAt: true, finishedAt: true },
      })).catch(() => [])) ?? [];
      const mins = runs
        .map((r) => (r?.startedAt && r?.finishedAt ? (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 60_000 : NaN))
        .filter((m) => Number.isFinite(m) && m >= 0);
      const v = judgeIdleCadence(finals, mins);
      if (v) out.set(sid, v);
    } catch { /* un-annotated */ }
  }
  return out;
}

/** audit 2026-10-06 T4-4: DORMANT_BANNER_FOLLOWUP_DISABLED=1 restores the plain "re-arm NOTHING" dormant banner. Read per call. */
export function dormantBannerFollowUpDisabled(): boolean {
  return process.env.DORMANT_BANNER_FOLLOWUP_DISABLED === '1';
}
/** A one-shot that fired within this window is "this wake's own firing" (the chain link being run now). */
export const OWN_FOLLOWUP_FIRED_WINDOW_MS = 60 * 60 * 1000;

/**
 * audit 2026-10-06 T4-4: is the project supervisor running its OWN follow-up
 * one-shot chain? TRUE when a supervisor chat holds an enabled `once` row, or
 * a `once` row of its own fired within OWN_FOLLOWUP_FIRED_WINDOW_MS (the link
 * that started this very wake — a fired one-shot is disabled at fire time).
 * Never throws; a read error ⇒ null (the plain banner).
 */
export async function supervisorOwnFollowUpChain(supervisorChatIds: string[], now: Date = new Date()): Promise<{ enabled: number; firedRecently: number } | null> {
  try {
    if (!supervisorChatIds.length) return null;
    const rows: any[] = (await (prisma.codingSchedule as any).findMany({
      where: {
        sessionId: { in: supervisorChatIds }, kind: 'once',
        OR: [{ enabled: true }, { lastFiredAt: { gte: new Date(now.getTime() - OWN_FOLLOWUP_FIRED_WINDOW_MS) } }],
      },
      select: { id: true, enabled: true, lastFiredAt: true, kind: true },
      take: 20,
    })) ?? [];
    let enabled = 0;
    let firedRecently = 0;
    for (const r of rows) {
      if (r?.kind != null && r.kind !== 'once') continue;
      if (r?.enabled === true) enabled += 1;
      else if (r?.lastFiredAt && now.getTime() - new Date(r.lastFiredAt).getTime() <= OWN_FOLLOWUP_FIRED_WINDOW_MS) firedRecently += 1;
    }
    return enabled + firedRecently > 0 ? { enabled, firedRecently } : null;
  } catch {
    return null;
  }
}

/**
 * Live per-lane schedule truth for ONE project supervisor's machine wakes:
 * every non-archived chat in the project that has ANY schedule rows or live
 * runs, rendered with its enabled rows' id prefixes + next-fire times so the
 * supervisor can cite REAL ids (or see a lane has NONE) without a tool pull.
 * '' when the project has no chats or nothing schedule-ish anywhere. Never
 * throws.
 */
export async function buildProjectScheduleBlock(projectId: string, now: Date = new Date()): Promise<string> {
  try {
    const chats = await prisma.crossModelChat.findMany({
      where: { projectId, archivedAt: null },
      select: { id: true, title: true, isProjectSupervisor: true },
      take: PROJECT_SCHEDULE_MAX_CHATS,
    });
    if (!chats.length) return '';
    const chatIds = chats.map((c: any) => c.id);
    const supervisorIds = new Set<string>((chats as any[]).filter((c) => c?.isProjectSupervisor === true).map((c) => String(c.id)));
    const [enabledRows, schedGroups, runGroups] = await Promise.all([
      // The id/next-fire render: enabled rows only, next-fire ascending.
      (prisma.codingSchedule as any).findMany({
        where: { sessionId: { in: chatIds }, enabled: true },
        select: { id: true, sessionId: true, nextRunAt: true, kind: true, promptSetBy: true, runsCount: true, maxRuns: true, expiresAt: true },
        orderBy: { nextRunAt: 'asc' },
        take: PROJECT_SCHEDULE_MAX_ENABLED_ROWS,
      }).catch(() => [] as any[]),
      // The counts: UNCAPPED grouped query (same doctrine as the fleet table)
      // — a lane's enabled/stopped numbers can never be truncated into a lie.
      (prisma.codingSchedule as any).groupBy({
        by: ['sessionId', 'enabled'],
        where: { sessionId: { in: chatIds } },
        _count: { _all: true },
        _max: { lastFiredAt: true },
      }).catch(() => [] as any[]),
      (prisma.agentRun as any).groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: chatIds }, status: { in: ['running', 'queued'] } },
        _count: { _all: true },
      }).catch(() => [] as any[]),
    ]);
    interface LaneAgg { enabled: Array<{ id: string; nextMs: number; cap: string | null; nearCap: boolean }>; enabledCount: number; stopped: number; lastFiredMs: number | null; liveRuns: number; recurring: boolean; ownerAuthored: boolean }
    const byChat = new Map<string, LaneAgg>();
    const aggOf = (sid: string): LaneAgg => {
      const cur = byChat.get(sid) ?? { enabled: [], enabledCount: 0, stopped: 0, lastFiredMs: null, liveRuns: 0, recurring: false, ownerAuthored: false };
      byChat.set(sid, cur);
      return cur;
    };
    for (const g of schedGroups ?? []) {
      const sid = String(g?.sessionId ?? '');
      if (!sid) continue; // a malformed row with no lane is not renderable
      const agg = aggOf(sid);
      const n = Number(g?._count?._all) || 0;
      if (g?.enabled) {
        agg.enabledCount += n;
        const firedMs = g?._max?.lastFiredAt ? new Date(g._max.lastFiredAt).getTime() : NaN;
        if (Number.isFinite(firedMs)) agg.lastFiredMs = Math.max(agg.lastFiredMs ?? 0, firedMs);
      } else {
        agg.stopped += n;
      }
    }
    // Already next-fire-ascending from the query — render order needs no re-sort.
    for (const row of enabledRows ?? []) {
      const sid = String(row?.sessionId ?? '');
      if (!sid) continue;
      const nextMs = row?.nextRunAt ? new Date(row.nextRunAt).getTime() : NaN;
      const agg = aggOf(sid);
      // Run-cap utilization (ticket b4d1096c): 'runs/max' per enabled capped
      // row + a NEAR-CAP flag on the sweeper's own predicate, so the project
      // supervisor re-arms pre-emptively from THIS block — no per-schedule
      // schedule_get (the fleet [FLEET LIVENESS] table carries the same).
      const cap = row?.maxRuns != null ? `${row.runsCount}/${row.maxRuns}` : null;
      const nearCap = row ? scheduleNearCapCause(row, now) != null : false;
      agg.enabled.push({ id: String(row?.id ?? ''), nextMs, cap, nearCap });
      if (row?.kind === 'recurring') agg.recurring = true;
      // Owner-authored rows (promptSetBy 'user' or legacy NULL) are the owner's instruction — never a cancel target for the supervisor.
      if (row?.promptSetBy == null || row?.promptSetBy === 'user') agg.ownerAuthored = true;
    }
    for (const g of runGroups ?? []) {
      const sid = String(g?.sessionId ?? '');
      if (sid) aggOf(sid).liveRuns += Number(g?._count?._all) || 0;
    }
    const lanes = [...byChat.entries()].filter(([, a]) => a.enabledCount > 0 || a.stopped > 0 || a.liveRuns > 0);
    if (!lanes.length) return ''; // nothing schedule-ish anywhere — no empty-table spam
    // Dormant-by-design (ticket b1d435fd): when the WHOLE project has no live
    // work (no active goals, open todos, live runs, or live watched
    // resources), a heartbeat-less lane is the DESIRED zero-wake state, not
    // deafness — the render must not tell the supervisor to re-arm it.
    const dormancy = await evaluateProjectDormancy(projectId);
    // audit 2026-10-06 T4-4 (spark.md F3): a DORMANT ledger must not tell the
    // supervisor to "re-arm NOTHING" while it is running its OWN follow-up
    // one-shot chain (an enabled one-shot on the supervisor chat, or the
    // one-shot that fired this very wake in the last hour) — spark's link 3
    // obeyed the banner over its firing's "re-arm this check", fabricated a
    // re-arm and the chain died. The banner then names the dormant LEDGER and
    // keeps the supervisor's own follow-ups in its hands. Kill switch
    // DORMANT_BANNER_FOLLOWUP_DISABLED=1 restores the plain banner.
    const ownFollowUps = dormancy.dormant && supervisorIds.size > 0 && !dormantBannerFollowUpDisabled()
      ? await supervisorOwnFollowUpChain([...supervisorIds], now)
      : null;
    // IDLE CADENCE verdicts (autonomy loop #12 — owner 2026-09-20: "scheduled
    // sessions not doing anything over and over"): for each lane with an
    // enabled RECURRING row, read its recent machine finals + run durations
    // and mark the lane when the firings keep producing nothing, so duty 5
    // (retire or justify) has compose-time ground truth. Best-effort.
    const idleVerdicts = await computeIdleCadenceVerdicts(
      lanes.filter(([, a]) => a.enabledCount > 0 && a.recurring).map(([sid]) => sid),
    );
    const titleOf = new Map<string, string>((chats as any[]).map((c) => [c.id, String(c.title ?? '')]));
    const hhmmz = (ms: number): string => (Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(11, 16)}Z` : '?');
    const lines = lanes
      .map(([sid, a]) => {
        const title = (titleOf.get(sid) ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'lane';
        const shown = a.enabled.slice(0, PROJECT_SCHEDULE_MAX_IDS);
        const ids = shown.map((s) => `${s.id.slice(0, 8)} next ${hhmmz(s.nextMs)}${s.cap ? ` ${s.cap}` : ''}${s.nearCap ? ' ⚠NEAR-CAP — re-arm pre-emptively' : ''}`).join('; ');
        const more = a.enabledCount > shown.length ? ` +${a.enabledCount - shown.length} more` : '';
        const schedPart = a.enabledCount === 0
          ? (dormancy.dormant
              ? (ownFollowUps && supervisorIds.has(sid)
                  ? 'your own follow-up chain — the one-shot that fired this wake is spent; if your firing says re-arm, re-arm it now with schedule_message (a real call — cite the returned id)'
                  : 'dormant-by-design (no live work — hooks wake on new work; re-arm NOTHING here)')
              : 'NO enabled schedules (deaf unless a run is live)')
          : `${a.enabledCount} enabled: ${ids}${more}`;
        const stoppedPart = a.stopped > 0 ? `, ${a.stopped} stopped` : '';
        const firedPart = a.enabledCount > 0 && a.lastFiredMs ? `, last firing ${ageMs(now.getTime() - a.lastFiredMs)} ago` : '';
        const v = idleVerdicts.get(sid);
        const idlePart = v
          ? ` — IDLE CADENCE: ${v.idle}/${v.examined} recent machine finals did nothing${v.avgRunMin != null ? ` (runs avg ${v.avgRunMin} min)` : ''} → ${a.ownerAuthored ? 'owner-authored cadence: report the idle verdict up, do NOT cancel' : 'retire it (cancel_schedule, then archive_chat) or name in your state doc what it still waits for'}`
          : '';
        return { enabledCount: a.enabledCount, liveCount: a.liveRuns, line: `- ${supervisorStateFullIdsDisabled() ? `…${sid.slice(-8)}` : `chat ${sid}`} "${title}": ${schedPart}${stoppedPart}${firedPart}, ${a.liveRuns} live run(s)${idlePart}` };
      })
      .sort((x, y) => y.enabledCount - x.enabledCount || y.liveCount - x.liveCount || x.line.localeCompare(y.line))
      .slice(0, PROJECT_SCHEDULE_MAX_LINES)
      .map((l) => l.line);
    const dormantClause = ownFollowUps
      ? 'THIS project\'s LEDGER is DORMANT right now (no goals, todos or live runs) — arm NO new heartbeat on any lane; your OWN follow-up one-shot chain on this supervisor chat is yours to keep: finish any re-arm or dispatch your firing calls for (a real schedule_message / send_chat_message call, cite the returned id), then stop'
      : 'THIS project is DORMANT right now (no live work) — heartbeat-less lanes are dormant-by-design: re-arm NOTHING, event hooks are the wake path when work appears';
    const block = `[PROJECT SCHEDULES — per-lane schedule truth for THIS project, computed LIVE this wake (enabled rows with id + next fire · stopped · live runs). These override anything your notes or memory imply: cite schedule state/ids ONLY from here or from a this-wake tool pull — never from memory. A lane with NO enabled schedules that owns standing work is DEAF — re-arm it or say why not; ${dormancy.dormant ? dormantClause : 'a project with no live work anywhere is dormant-by-design (owner directive 2026-09-18, ticket b1d435fd): zero wakes there, re-arm NOTHING'}:]\n${lines.join('\n')}`;
    return block.length <= PROJECT_SCHEDULE_BLOCK_CAP ? block : `${block.slice(0, PROJECT_SCHEDULE_BLOCK_CAP - 15)}\n…[truncated]`;
  } catch (err: any) {
    logger.warn(`supervisor-state: project schedule block failed: ${err?.message ?? err}`, { source: SOURCE });
    return '';
  }
}

// ── Account-wide liveness snapshot (tickets 25c5a7c3 / 23880ce0) ─────────────
// The owner-briefing layer rewrites wake notes into plain English WITHOUT any
// fleet state of its own — and a wake note about ONE cadence-stopped schedule
// became "The fleet is stopped." (2026-09-11, owner screenshot). This snapshot
// is the briefing's measured ground truth: it grounds the rewrite prompt and
// powers the deterministic repair gate that contradicts false fleet-wide
// stopped/nothing-running claims.

export interface FleetLivenessSnapshot {
  /** Enabled schedules across ALL of the owner's chats (archived excluded). */
  enabledSchedules: number;
  /** running/queued agent runs across the fleet right now. */
  liveRuns: number;
  /** Most recent schedule firing anywhere in the fleet (null = never fired). */
  lastFiredAt: Date | null;
}

/**
 * Account-wide fleet liveness for one owner — grouped queries only, same
 * shape as buildFleetLivenessBlock above. Returns null on any failure: the
 * caller's rewrite then runs ungrounded, never blocked by telemetry.
 */
export async function getFleetLivenessSnapshot(userId: string): Promise<FleetLivenessSnapshot | null> {
  try {
    const chats = await prisma.crossModelChat.findMany({
      where: { userId, archivedAt: null },
      select: { id: true },
      take: LIVENESS_MAX_CHATS,
    });
    const chatIds = chats.map((c: any) => c.id);
    if (!chatIds.length) return { enabledSchedules: 0, liveRuns: 0, lastFiredAt: null };
    const [schedGroups, runGroups] = await Promise.all([
      (prisma.codingSchedule as any).groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: chatIds }, enabled: true },
        _count: { _all: true },
        _max: { lastFiredAt: true },
      }).catch(() => [] as any[]),
      (prisma.agentRun as any).groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: chatIds }, status: { in: ['running', 'queued'] } },
        _count: { _all: true },
      }).catch(() => [] as any[]),
    ]);
    let enabledSchedules = 0;
    let liveRuns = 0;
    let lastFiredAt: Date | null = null;
    for (const g of schedGroups ?? []) {
      enabledSchedules += Number(g?._count?._all) || 0;
      const d = g?._max?.lastFiredAt ? new Date(g._max.lastFiredAt) : null;
      if (d && Number.isFinite(d.getTime()) && (!lastFiredAt || d.getTime() > lastFiredAt.getTime())) lastFiredAt = d;
    }
    for (const g of runGroups ?? []) liveRuns += Number(g?._count?._all) || 0;
    return { enabledSchedules, liveRuns, lastFiredAt };
  } catch (err: any) {
    logger.warn(`supervisor-state: fleet liveness snapshot failed: ${err?.message ?? err}`, { source: 'supervisor-state' });
    return null;
  }
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * In-process per-chat write serializer (review M3): upsertDoc is an unlocked
 * read-modify-write of the whole state blob, so without ordering, a wake's
 * update_supervisor_state merge that READ before appendVerifierRefutation
 * landed and WRITES after it would silently erase the refutation — breaking
 * the "the merge can never erase a refutation" invariant. Chaining writers per
 * chat kills the same-process race (the verifier + the merge both run in the
 * serving backend). A cross-container window remains during a blue-green flip
 * (minutes); the mishap ticket + in-thread correction still persist, and the
 * next phantom occurrence re-files. The chain map self-cleans at the tail.
 */
const docWriteChains = new Map<string, Promise<unknown>>();

function enqueueDocWrite(chatId: string, fn: () => Promise<void>): Promise<void> {
  const prev = docWriteChains.get(chatId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  docWriteChains.set(chatId, tail);
  void tail.then(() => { if (docWriteChains.get(chatId) === tail) docWriteChains.delete(chatId); });
  return next;
}

/** Read-modify-write against the upsert race: unique(chatId) converges concurrent creators. */
async function upsertDoc(
  chatId: string,
  userId: string,
  mutate: (doc: SupervisorStateDoc) => SupervisorStateDoc,
  opts: {
    /** Async step inside the serialized chain, BEFORE the sync mutate (review 2026-10-22: pulls cold-archive rows a revive / update names into `archived`). */
    prepare?: (doc: SupervisorStateDoc) => Promise<void>;
    /** Ids `prepare` pulled out of the cold archive — their cold rows are deleted once the hot write lands (unless they spill straight back). */
    promotedFromCold?: Set<string>;
  } = {},
): Promise<void> {
  await enqueueDocWrite(chatId, async () => {
    const existing = await prisma.supervisorState.findUnique({ where: { chatId }, select: { state: true } });
    // Tidy BEFORE the mutate too: the wake block (read side) already showed
    // stale rows as archived, so a revive-by-id must find them in `archived`
    // and stamp a fresh `at` — otherwise the post-mutate tidy re-archives the
    // row on the same write. Then tidy again for rows the mutate aged out.
    const before = archiveStaleDirectives(parseDoc(existing?.state));
    // What this write's BASE read holds hot (before prepare pulls cold rows
    // in) — only such a row's cold copy may be deleted by this write
    // (settleColdSpill); the base's deferred deletions force the listing.
    const baseHotIds = new Set([...before.doc.directives, ...before.doc.archived].map((d) => d.id));
    const baseColdStale = before.doc.coldStaleIds ?? [];
    // A doc ALREADY past the hot keep (a full archive from before the split,
    // or a write whose spill failed) spills first, so the cap below never has
    // to trim a closed row the cold archive has room for.
    const preSpill = await spillClosedArchive(chatId, before.doc);
    if (opts.prepare) {
      try { await opts.prepare(before.doc); } catch { /* best-effort: the mutate reports an unresolved id as before */ }
    }
    const tidied = archiveStaleDirectives(mutate(before.doc));
    const next = tidied.doc;
    const movedTotal = before.moved.length + tidied.moved.length;
    if (movedTotal) emitDirectiveArchiveMetric(chatId, movedTotal);
    const restored = [...before.restored, ...tidied.restored];
    if (restored.length) emitDirectiveRestoreMetric(chatId, restored);
    // Review 2026-10-22: closed archive rows past the hot keep spill to the
    // cold archive BEFORE the hot write drops them (null = untouched / failed:
    // everything stays hot this write).
    const forceList = new Set<string>([...(opts.promotedFromCold ?? []), ...baseColdStale]);
    const postSpill = await spillClosedArchive(chatId, next, forceList);
    {
      // The deferred cold-copy deletions this write leaves for the next one:
      // every moved key (only a base-hot one is deleted after this write; the
      // next listing drops the rest from the set). A failed / skipped spill
      // keeps the base's set so the next write retries.
      const spillsNow = [preSpill, postSpill].filter((x): x is ColdSpill => !!x);
      const finalTrim = new Set(spillsNow.length ? spillsNow[spillsNow.length - 1].trimKeys : []);
      const movedKeys = spillsNow.flatMap((x) => x.moved.map((m) => m.key)).filter((k) => !finalTrim.has(k));
      const stale = [...new Set(postSpill ? movedKeys : [...baseColdStale, ...movedKeys])].slice(0, COLD_STALE_IDS_MAX);
      if (stale.length) next.coldStaleIds = stale;
      else delete next.coldStaleIds;
    }
    try {
      await prisma.supervisorState.upsert({
        where: { chatId },
        create: { chatId, userId, state: next as any },
        update: { state: next as any },
      });
    } catch (err) {
      // fs-durable-memory re-review (2026-10-23): a chat / account delete
      // that landed between the spill and this write already ran its
      // chat-keyed purge, so the cold rows the spill just wrote would outlive
      // the chat (the FK makes this write fail, and nothing settles them).
      // Purge them when the chat is confirmed gone; the error still surfaces.
      await purgeChatKeyedRowsIfChatGone(chatId, 'hot write failed');
      throw err;
    }
    const spills = [preSpill, postSpill].filter((x): x is ColdSpill => !!x);
    if (spills.length) {
      // Only now that the hot doc is written: drop the trimmed cold keys and
      // the moved ones a re-read confirms are hot, then re-mirror the cold set.
      const coldRows = await settleColdSpill(chatId, spills, baseHotIds);
      void import('./supervisor-state-memory')
        .then((m) => m.enqueueSupervisorStateColdEmbed(chatId, coldRows, { userId }))
        .catch(() => {});
    }
    // Ticket 2b8508cb: mirror the doc into digby_memory (source
    // `supervisor_state`, chat scope) so the wake block's 6000-char trims are
    // retrievable per turn. Dynamic import + fire-and-forget via the bridge's
    // per-chat embed serializer: this module is a LEAF, the memory bridge is
    // not (rag.service → utility-llm), and a store failure must never fail
    // the doc write. The bridge short-circuits no-op rewrites (content hash),
    // orders concurrent embeds, and honors
    // SUPERVISOR_STATE_MEMORY_DISABLED.
    void import('./supervisor-state-memory')
      .then((m) => m.enqueueSupervisorStateEmbed(chatId, next, { userId }))
      .catch(() => {});
  });
}

/**
 * Ticket 661fb494: resolve a chat's directive SCOPE label — the chat's project
 * name, or 'fleet' for the projectless (Fleet Supervisor) chat. Stamped onto
 * captured directives so a later wake can see at a glance which project an
 * owner message binds. TOTAL: any failure → null (the capture proceeds
 * scopeless rather than failing — legacy rows carry no scope).
 */
async function directiveScopeForChat(chatId: string): Promise<string | null> {
  try {
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: chatId },
      select: { project: { select: { name: true } } },
    });
    if (!chat) return null;
    const name = String((chat as any).project?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DIRECTIVE_SCOPE);
    return name || 'fleet';
  } catch {
    return null;
  }
}

/**
 * Owner-message capture: a message typed BY THE OWNER into the supervisor chat
 * is a DIRECTIVE — it must survive outside the 12-pair transcript window.
 * Fire-and-forget from the persist path; never throws.
 */
export async function appendDirective(
  chatId: string,
  userId: string,
  text: string,
  opts: { messageId?: string } = {},
): Promise<void> {
  try {
    // Credential scan on capture (remediation P1 item N9): a directive is
    // re-rendered into EVERY future wake block — a pasted token here would
    // ride every prompt for 50 directives' worth of history.
    const trimmed = redactInboundSecrets(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, MAX_DIRECTIVE_TEXT);
    if (!trimmed) return;
    // Capture classification (remediation P2 B6; broadened tt-rd audit
    // 2026-09-27): a pure ack is conversation, never ledgered. A STATUS
    // QUESTION is ledgered as kind:'ask' (visible under OPEN OWNER ASKS until
    // the reply lands, then harness-closed by closeAskOnReply) — the audit
    // found ten "progress?" asks captured as open DIRECTIVES that only a typed
    // artifact could close.
    const kind = classifyOwnerMessage(trimmed);
    if (kind === 'ack') return;
    // audit 2026-10-08 W1-5: count the remarks/questions the imperative-only rule kept OUT of the directive ledger.
    if (kind === 'ask' && !OWNER_ASK_OPENER_RE.test(trimmed) && !(trimmed.length <= 80 && STATUS_QUESTION_RE.test(trimmed))) {
      void import('./loop-metrics.service')
        .then((m) => m.recordLoopMetric({ kind: 'owner_message_not_directive', sessionId: chatId, value: trimmed.length, meta: { question: /\?\s*$/.test(trimmed) } }))
        .catch(() => { /* telemetry never blocks */ });
    }
    // fixer 2026-09-27 (finding upward-chatter-2): an opener-led ORDER
    // ("any update — if the ladder has 0 adoptions kill it") ledgers BOTH an
    // ask row (harness-closed on reply) and a plain directive row (closed only
    // on typed evidence) — the reply answers the question; it never retires
    // the order.
    const isAsk = kind === 'ask' || kind === 'ask_directive';
    const alsoDirective = kind === 'ask_directive';
    const standing = (!isAsk || alsoDirective) && STANDING_DIRECTIVE_RE.test(trimmed);
    const scope = await directiveScopeForChat(chatId);
    const messageId = typeof opts.messageId === 'string' && opts.messageId.trim() ? opts.messageId.trim().slice(0, 64) : undefined;
    let overflow = 0;
    await upsertDoc(chatId, userId, (doc) => {
      doc.directives.push({
        id: randomUUID(), text: trimmed, at: new Date().toISOString(), status: 'open',
        origin: 'owner', // harness stamp — an owner message in this chat (see SupervisorDirective.origin)
        ...(standing && !isAsk ? { standing: true } : {}),
        ...(scope ? { scope } : {}),
        ...(isAsk ? { kind: 'ask' as const } : {}),
        ...(messageId ? { messageId } : {}),
      });
      if (alsoDirective) {
        doc.directives.push({
          id: randomUUID(), text: trimmed, at: new Date().toISOString(), status: 'open',
          origin: 'owner', // the same owner message — the directive twin carries the harness stamp too
          ...(standing ? { standing: true } : {}),
          ...(scope ? { scope } : {}),
          ...(messageId ? { messageId } : {}),
        });
      }
      overflow = applyDirectiveCap(chatId, doc);
      return doc;
    });
    if (overflow > 0) emitDirectiveOverflowMetric(chatId, overflow);
  } catch (err: any) {
    logger.warn(`supervisor-state: appendDirective failed for ${chatId}: ${err?.message ?? err}`, { source: SOURCE });
  }
}

/**
 * Answered owner-question ledger entry (remediation P2 v1#5): when the owner
 * answers a flagged question, the resolution is appended to the supervisor's
 * durable ledger as a DONE directive whose evidence cites the oq row — so a
 * later wake can never claim the decision is still pending, and the answer
 * survives the 12-pair transcript window. HARNESS-written (never model
 * text), so it bypasses the model-merge validation on purpose. TOTAL: never
 * throws.
 *
 * OWNER-PROVENANCE-STRICT (2026-10-20): the row names WHO answered —
 * `answeredBy` 'supervisor' banks "Fleet Supervisor ANSWERED (standing
 * directives) …" with origin 'supervisor_answer', 'default' banks "Preset
 * DEFAULT applied …" with origin 'default'; only an owner answer keeps the
 * owner stamp 'owner_question' (the archive keep, the brief's owner decisions
 * and the owner-directive fan-out key on the owner stamps only). Before the
 * fix every answer — the supervisor's triage answers and the auto-applied
 * defaults included — was banked as "Owner ANSWERED" with the owner stamp.
 * Kill switch OWNER_PROVENANCE_STRICT_DISABLED=1 restores the single shape.
 *
 * `mirror` (OWNER-DIRECTIVE-FANOUT, 2026-10-20): the same entry written onto
 * the ASKING project's supervisor ledger — deterministic id `<oq>-answer`,
 * idempotent (a second write of the same question is a no-op).
 */
export { ownerProvenanceStrictDisabled };
/** Deterministic id of an answered-question MIRROR row on a project supervisor's ledger (the idempotency key). */
export function answeredQuestionMirrorId(questionId: string): string {
  return `${String(questionId ?? '').trim().slice(0, 48)}-answer`;
}
/** The banked text + origin of an answered flagged question, by who answered it. Pure; exported for tests. */
export function answeredQuestionLedgerShape(entry: { question: string; answer: string; counterQuestion?: boolean; answeredBy?: 'owner' | 'supervisor' | 'default'; sweeperAutoHeal?: boolean }): { text: string; origin: SupervisorDirectiveOrigin } {
  const by = ownerProvenanceStrictDisabled() ? 'owner' : (entry.answeredBy ?? 'owner');
  // CanLaw stall 2026-09-15: a reply that was itself a question is ledgered
  // as "asked back — NO decision", never as an answer a later wake can quote
  // as the owner's ruling.
  const raw = entry.counterQuestion && by === 'owner'
    ? `Owner REPLIED WITH A QUESTION (no decision made — not a GO, not a HALT) to flagged question — Q: "${entry.question}" Owner asked: "${entry.answer}"`
    : by === 'supervisor'
      ? `Fleet Supervisor ANSWERED (standing directives — not the owner) flagged question — Q: "${entry.question}" A: "${entry.answer}"`
      : by === 'default'
        ? entry.sweeperAutoHeal
          ? `Gate sweeper AUTO-RESOLVED on verified stored-credential state (no owner answer, no preset default, no new value) — Q: "${entry.question}" A: "${entry.answer}"`
          : `Preset DEFAULT applied (no owner answer) to flagged question — Q: "${entry.question}" A: "${entry.answer}"`
        : `Owner ANSWERED flagged question — Q: "${entry.question}" A: "${entry.answer}"`;
  const origin: SupervisorDirectiveOrigin = by === 'owner' ? 'owner_question' : by === 'supervisor' ? 'supervisor_answer' : 'default';
  return { text: raw.replace(/\s+/g, ' ').trim().slice(0, MAX_DIRECTIVE_TEXT), origin };
}

export async function appendAnsweredQuestionDirective(
  chatId: string,
  userId: string,
  entry: { questionId: string; question: string; answer: string; counterQuestion?: boolean; scope?: string; answeredBy?: 'owner' | 'supervisor' | 'default'; sweeperAutoHeal?: boolean; mirror?: boolean },
): Promise<void> {
  try {
    const { text, origin } = answeredQuestionLedgerShape(entry);
    // Ticket 661fb494: the asking chat's project scope rides the ledger entry
    // — a banked ruling without its scope is the record a later wake miscites
    // cross-project.
    const scope = String(entry.scope ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DIRECTIVE_SCOPE);
    const mirrorId = entry.mirror ? answeredQuestionMirrorId(entry.questionId) : null;
    let overflow = 0;
    await upsertDoc(chatId, userId, (doc) => {
      if (mirrorId && [...doc.directives, ...doc.archived].some((d) => d.id === mirrorId)) return doc; // idempotent mirror
      doc.directives.push({
        id: mirrorId ?? randomUUID(),
        text,
        at: new Date().toISOString(),
        status: 'done',
        evidence: `oq ${String(entry.questionId).slice(0, 40)}`,
        origin, // harness stamp — WHO answered (see SupervisorDirective.origin)
        ...(scope ? { scope } : {}),
      });
      overflow = applyDirectiveCap(chatId, doc);
      return doc;
    });
    if (overflow > 0) emitDirectiveOverflowMetric(chatId, overflow);
  } catch (err: any) {
    logger.warn(`supervisor-state: appendAnsweredQuestionDirective failed for ${chatId}: ${err?.message ?? err}`, { source: SOURCE });
  }
}

/** Deterministic ledger id of the ruling captured from one owner question (the idempotency key; its first 8 chars read as the oq id). */
export function ownerRulingDirectiveId(questionId: string): string {
  return `${String(questionId ?? '').trim().slice(0, 48)}-ruling`;
}

export type OwnerRulingCaptureResult = 'appended' | 'duplicate' | 'not_ruling' | 'disabled' | 'failed';

/**
 * Owner RULING capture (2026-10-20 — see classifyOwnerRuling): the owner's
 * answer to a flagged question, or the note on a card the owner dismissed,
 * that carries an order / permanent rule becomes an OPEN directive on the
 * supervisor ledger — harness-stamped origin 'owner_question' (so the archive
 * never hides it and the brief may cite it), standing when the wording is
 * fleet-wide / permanent, and then scoped 'fleet' (the ruling binds every
 * lane, not just the asking project); otherwise the asking chat's scope.
 * Idempotent: one row per question (ownerRulingDirectiveId, live or
 * archived), and no row when an open owner-origin row already carries the
 * same ruling text (the owner typed it into this chat too). Secrets are
 * redacted on capture. HARNESS-written; TOTAL — never throws.
 */
export async function appendOwnerRulingDirective(
  chatId: string,
  userId: string,
  entry: { questionId: string; question: string; ruling: string; source: 'answer' | 'dismissal'; scope?: string; mirror?: boolean },
): Promise<OwnerRulingCaptureResult> {
  try {
    if (ownerRulingCaptureDisabled()) return 'disabled';
    const ruling = redactInboundSecrets(String(entry.ruling ?? '').replace(/\s+/g, ' ').trim());
    const qid = String(entry.questionId ?? '').trim();
    if (!ruling || !qid) return 'not_ruling';
    const cls = classifyOwnerRuling(ruling);
    if (!cls.ruling) return 'not_ruling';
    const question = redactInboundSecrets(String(entry.question ?? '').replace(/\s+/g, ' ').trim()).slice(0, 160);
    const how = entry.source === 'dismissal' ? `dismissing flagged question ${qid}` : `answering flagged question ${qid}`;
    // The ruling leads so the 500-char cap can only ever clip the question echo.
    const text = `Owner RULING${cls.standing ? ' (standing)' : ''} — "${ruling}" (${how}${question ? `: "${question}"` : ''})`.slice(0, MAX_DIRECTIVE_TEXT);
    const scopeIn = String(entry.scope ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DIRECTIVE_SCOPE);
    // OWNER-DIRECTIVE-FANOUT (2026-10-20): a MIRROR row on the asking
    // project's supervisor ledger keeps that project's scope even when the
    // ruling is fleet-wide — the Fleet Supervisor's row carries 'fleet', and
    // the fan-out block dedupes the two by id.
    const scope = cls.standing && !entry.mirror ? 'fleet' : scopeIn;
    const id = ownerRulingDirectiveId(qid);
    const needle = ruling.toLowerCase();
    let result = 'duplicate' as OwnerRulingCaptureResult; // set inside the serialized mutate
    let overflow = 0;
    await upsertDoc(chatId, userId, (doc) => {
      if ([...doc.directives, ...doc.archived].some((d) => d.id === id)) return doc;
      if (doc.directives.some((d) => d.status === 'open' && isOwnerOriginStamp(d.origin) && d.text.toLowerCase().includes(needle))) return doc;
      doc.directives.push({
        id,
        text,
        at: new Date().toISOString(),
        status: 'open',
        origin: 'owner_question', // harness stamp — the owner's own ruling on an oq card (see SupervisorDirective.origin)
        ...(cls.standing ? { standing: true } : {}),
        ...(scope ? { scope } : {}),
      });
      overflow = applyDirectiveCap(chatId, doc);
      result = 'appended';
      return doc;
    });
    if (overflow > 0) emitDirectiveOverflowMetric(chatId, overflow);
    void import('./loop-metrics.service')
      .then((m) => m.recordLoopMetric({ kind: 'owner_ruling_captured', sessionId: chatId, value: result === 'appended' ? 1 : 0, meta: { questionId: qid.slice(0, 11), source: entry.source, standing: cls.standing, outcome: result, ...(entry.mirror ? { mirror: true } : {}) } }))
      .catch(() => { /* telemetry never blocks */ });
    return result;
  } catch (err: any) {
    logger.warn(`supervisor-state: appendOwnerRulingDirective failed for ${chatId}: ${err?.message ?? err}`, { source: SOURCE });
    return 'failed';
  }
}

/** An open kind:'ask' directive as the wake block / follow-through read it. */
export interface OpenOwnerAsk { id: string; text: string; at: string; messageId?: string; scope?: string }

/**
 * OPEN owner ASKS (kind:'ask') on ONE supervisor chat, oldest first, optionally
 * capped to rows younger than `maxAgeMs` (tt-rd audit 2026-09-27 — the
 * [OPEN OWNER ASKS — ANSWER FIRST] block and follow-through detector 3 read
 * this). TOTAL: any failure degrades to [].
 */
export async function listOpenOwnerAsks(chatId: string, opts: { maxAgeMs?: number; now?: Date } = {}): Promise<OpenOwnerAsk[]> {
  try {
    const doc = await getSupervisorState(chatId);
    const nowMs = (opts.now ?? new Date()).getTime();
    const out: OpenOwnerAsk[] = [];
    for (const d of doc.directives) {
      if (d.status !== 'open' || d.kind !== 'ask') continue;
      const t = Date.parse(d.at);
      if (opts.maxAgeMs != null && Number.isFinite(t) && nowMs - t > opts.maxAgeMs) continue;
      out.push({ id: d.id, text: d.text, at: d.at, ...(d.messageId ? { messageId: d.messageId } : {}), ...(d.scope ? { scope: d.scope } : {}) });
    }
    return out.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  } catch (err: any) {
    logger.warn(`supervisor-state: listOpenOwnerAsks failed for ${chatId}: ${err?.message ?? err}`, { source: SOURCE });
    return [];
  }
}

// ── Answered asks with an OPEN twin (ticket b03d7033, 2026-10-20) ────────────
// The mishap's second half: closeAskOnReply stamps the kind:'ask' row
// 'answered' the moment ANY reply lands — including an explanation-only reply
// — and the row then leaves every open-ask scan. When the ask was captured as
// 'ask_directive' (an opener-led order, or a state complaint), its TWIN
// directive row (same messageId, no kind) carries the order and only typed
// evidence can close it; but nothing looked at the PAIR — the unmet order sat
// in the wake block with no nudge and, crucially, no report-up, so the
// exchange was invisible to the tier above. This read returns exactly those
// pairs: an ANSWERED ask whose twin is still OPEN. Follow-through detector 3b
// (fleet/follow-through.service) nudges the supervisor and escalates to the
// Fleet Supervisor on them. TOTAL: any failure degrades to [].
export interface AnsweredAskTwin {
  /** The answered kind:'ask' row. */
  askId: string;
  /** The still-open order twin (same owner messageId, no kind, NO recorded evidence — a twin carrying blocker evidence is excluded, see the doc below). */
  twinId: string;
  text: string;
  at: string;
  messageId?: string;
  scope?: string;
}

/**
 * ANSWERED kind:'ask' directives on ONE supervisor chat whose directive TWIN
 * (the same-messageId, kind-less row captured beside them) is still OPEN —
 * the owner's question got a reply, the order it carried did not get evidence.
 * Optionally capped to asks younger than `maxAgeMs`. Oldest first. The twin is
 * matched on the live ledger only (a twin the archive took is past the sweep's
 * horizon; the archive's own visibility covers it). Twins are identified by
 * messageId, which the harness stamps at capture and the model merge can never
 * write — a supervisor-authored row never matches. A twin that carries
 * non-empty EVIDENCE is EXCLUDED: doctrine's documented clear path is
 * recording a blocker (or the owner's reply) as evidence on the open row —
 * the age alarm honours exactly that, and a sweep that re-nudged a cleared
 * row would both nag a supervisor doing the right thing and assert a
 * falsehood to the tier above (review finding 1). TOTAL: degrades to [].
 */
export async function listAnsweredAsksWithOpenTwin(chatId: string, opts: { maxAgeMs?: number; now?: Date } = {}): Promise<AnsweredAskTwin[]> {
  try {
    const doc = await getSupervisorState(chatId);
    const nowMs = (opts.now ?? new Date()).getTime();
    const out: AnsweredAskTwin[] = [];
    for (const d of doc.directives) {
      if (d.status !== 'answered' || d.kind !== 'ask' || !d.messageId) continue;
      const t = Date.parse(d.at);
      if (opts.maxAgeMs != null && Number.isFinite(t) && nowMs - t > opts.maxAgeMs) continue;
      const twin = doc.directives.find((x) => x.status === 'open' && !x.kind && x.messageId === d.messageId && !String(x.evidence ?? '').trim());
      if (!twin) continue;
      out.push({ askId: d.id, twinId: twin.id, text: d.text, at: d.at, ...(d.messageId ? { messageId: d.messageId } : {}), ...(d.scope ? { scope: d.scope } : {}) });
    }
    return out.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  } catch (err: any) {
    logger.warn(`supervisor-state: listAnsweredAsksWithOpenTwin failed for ${chatId}: ${err?.message ?? err}`, { source: SOURCE });
    return [];
  }
}

/**
 * Harness close of an owner ASK once the supervisor's reply landed (tt-rd
 * audit 2026-09-27, finding upward-chatter-3): the ONLY close path for a
 * directive used to be the model calling update_supervisor_state with TYPED
 * evidence it had to fetch via get_chat_messages — so nine of ten answered
 * "progress?" asks stayed 'open' and re-injected into every wake. This writer
 * marks the kind:'ask' row captured from `askMessageId` done with evidence
 * `msg <replyId8>` — HARNESS-written, so it bypasses the typed-evidence model
 * gate exactly like appendAnsweredQuestionDirective. Imperative directives
 * (no kind) are never touched: a mere reply must not close an order.
 * TOTAL: never throws; returns whether a row closed.
 */
export async function closeAskOnReply(
  chatId: string,
  userId: string,
  entry: {
    askMessageId: string;
    replyMessageId: string;
    /** fixer 2026-09-27: which seam closed it — 'owner_turn' (the owner's own
     *  turn replied), 'machine_wake' (an [OWNER ASK UNANSWERED] re-wake /
     *  [FOLLOW-THROUGH] nudge answered), 'reconcile' (the wake-block builder
     *  found a qualifying reply already in the transcript), 'continuation' (build
     *  2026-10-08 A1: the answer-first follow-through settled — done / failed).
     *  Telemetry only. */
    source?: 'owner_turn' | 'machine_wake' | 'reconcile' | 'continuation';
  },
): Promise<boolean> {
  try {
    const askId = String(entry.askMessageId ?? '').trim();
    const replyId = String(entry.replyMessageId ?? '').trim();
    if (!askId || !replyId) return false;
    // audit 2026-10-06 T4-9 (others.md F11): a reply that is only the machine
    // no-op close ("WAKE: no-op …") never closes an owner ask — the ask stays
    // open and keeps riding [OPEN OWNER ASKS]. One read of the reply row; a
    // read error closes as before (fail-open to the pre-fix behaviour). Kill
    // switch OWNER_ASK_NOOP_REPLY_DISABLED=1 (fleet/supervisor-reply-row).
    if (!ownerAskNoopReplyDisabled()) {
      let replyText: string | null = null;
      try {
        const row = await prisma.crossModelMessage.findUnique({ where: { id: replyId }, select: { content: true } });
        replyText = typeof row?.content === 'string' ? row.content : null;
      } catch { replyText = null; }
      if (replyText != null && isNoopOnlyReply(replyText)) {
        logger.info(`supervisor-state: owner ask (msg ${askId.slice(0, 8)}) NOT closed on ${chatId.slice(0, 8)} — reply ${replyId.slice(0, 8)} is only a no-op close (audit 2026-10-06 T4-9)`, { source: SOURCE });
        void import('./loop-metrics.service')
          .then((m) => m.recordLoopMetric({ kind: 'owner_ask_noop_reply', sessionId: chatId, meta: { chatId, askMessageId: askId.slice(0, 8), replyMessageId: replyId.slice(0, 8), source: entry.source ?? 'owner_turn' } }))
          .catch(() => {});
        return false;
      }
    }
    let closed: SupervisorDirective | null = null;
    await upsertDoc(chatId, userId, (doc) => {
      const target = doc.directives.find((d) => d.status === 'open' && d.kind === 'ask' && d.messageId === askId);
      if (!target) return doc;
      // Audit 96fb2f25 (raspi e571edf5): a reply landing says NOTHING about the
      // outcome — the specimen's reply said "NOT done yet … repair lane has NOT
      // been dispatched" and the board still rendered the request "done". The
      // harness stamps 'answered' (a reply exists); 'done' stays reserved for
      // the model's typed-evidence close. Kill switch OWNER_ASK_DONE_TRUTH_DISABLED=1
      // restores the legacy 'done' stamp.
      const stamp: SupervisorDirective['status'] = process.env.OWNER_ASK_DONE_TRUTH_DISABLED === '1' ? 'done' : 'answered';
      target.status = stamp;
      target.evidence = `msg ${replyId.slice(0, 8)}`;
      closed = target;
      return doc;
    });
    if (!closed) return false;
    const row = closed as SupervisorDirective;
    const ageMs = Math.max(0, Date.now() - (Date.parse(row.at) || Date.now()));
    void import('./loop-metrics.service')
      .then((m) => m.recordLoopMetric({
        kind: 'directive_ask_autoclose', sessionId: chatId, value: ageMs, unit: 'ms',
        meta: { chatId, directiveId: row.id, askMessageId: askId.slice(0, 8), replyMessageId: replyId.slice(0, 8), ageMs, source: entry.source ?? 'owner_turn', status: row.status },
      }))
      .catch(() => {});
    return true;
  } catch (err: any) {
    logger.warn(`supervisor-state: closeAskOnReply failed for ${chatId}: ${err?.message ?? err}`, { source: SOURCE });
    return false;
  }
}

/**
 * Every OPEN directive across the user's supervisor docs newer than `sinceMs`
 * — the update_schedule directive-conflict guard's read (remediation P2 item
 * 8). TOTAL: any failure degrades to []. Rows whose `at` fails to parse are
 * INCLUDED (an undated open owner order must not evade the guard). Each row
 * carries the directive's `scope` (project name / 'fleet' / unset) when the
 * doc stamped one — the goal done-suspect leaf filters on it (review fix
 * 2026-09-27, finding 3); the directive-conflict guard ignores it.
 */
export async function listOpenDirectivesForUser(
  userId: string,
  sinceMs: number,
): Promise<Array<{ id: string; text: string; at: string; chatId: string; scope?: string; evidence?: string }>> {
  try {
    const rows = await prisma.supervisorState.findMany({ where: { userId }, select: { chatId: true, state: true } });
    const out: Array<{ id: string; text: string; at: string; chatId: string; scope?: string; evidence?: string }> = [];
    for (const row of rows ?? []) {
      const doc = parseDoc(row.state);
      for (const d of doc.directives) {
        if (d.status !== 'open') continue;
        const t = Date.parse(d.at);
        if (Number.isFinite(t) && t < sinceMs) continue;
        // evidence (audit 2026-10-08 W5-5): a dispatch / goal citation on the open row marks the goal it originated.
        out.push({ id: d.id, text: d.text, at: d.at, chatId: row.chatId, ...(d.scope ? { scope: d.scope } : {}), ...(d.evidence ? { evidence: d.evidence } : {}) });
      }
    }
    return out;
  } catch (err: any) {
    logger.warn(`supervisor-state: listOpenDirectivesForUser failed: ${err?.message ?? err}`, { source: SOURCE });
    return [];
  }
}

/**
 * Phantom-claim verifier (PR #295 port): append a DURABLE refutation line so
 * every later wake block shows the claim was proven false. Newest-first, cap
 * 10 — this is the ONLY writer of doc.refutations (the supervisor's own
 * update_supervisor_state merge can neither forge nor erase a line). TOTAL:
 * never throws; a DB failure is a warn log.
 */
export async function appendVerifierRefutation(chatId: string, userId: string, detail: string): Promise<void> {
  try {
    const trimmed = String(detail ?? '').replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    const line = `${VERIFIER_REFUTATION_PREFIX} (${new Date().toISOString()}) ${trimmed.slice(0, MAX_REFUTATION)} — it did NOT execute (no matching tool result in that run's log).`;
    await upsertDoc(chatId, userId, (doc) => {
      doc.refutations = [line, ...doc.refutations].slice(0, MAX_REFUTATIONS);
      return doc;
    });
  } catch (err: any) {
    logger.warn(`supervisor-state: appendVerifierRefutation failed for ${chatId}: ${err?.message ?? err}`, { source: SOURCE });
  }
}

// ── Preempted-run in-flight checkpoint (ticket a5b36dc6) ─────────────────────
// The incident: an owner POST preempts the running supervisor sweep; the
// sweep's turn dies mid-loop with issued-but-never-settled tool calls (their
// tool_intents rows stay pending/unknown — the effect may STILL land) and with
// claims the next turn cannot verify. The next turn answers "from earlier
// context", claims or retracts actions ("nothing went out"), and the writes
// land minutes later — the claim→retraction loop. The fix: the preempt path
// stamps a harness-written marker here, and every wake / owner turn on this
// chat renders a LIVE re-read of the journal window as an ACTION-IN-FLIGHT
// guard: verify before claiming. Fail-open everywhere (a marker or journal
// hiccup never blocks a run start); kill switch
// SUPERVISOR_INFLIGHT_PREEMPT_DISABLED=1 restores the pre-fix behavior.

/** How fresh a preempt marker must be for the IN-FLIGHT block to render. */
export const INFLIGHT_PREEMPT_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Cap on journal rows the block reads (the window is 2 h — a sweep is noisy). */
const INFLIGHT_PREEMPT_MAX_ROWS = 40;

/** Kill switch for the whole IN-FLIGHT checkpoint path (marker + block). */
export function inflightPreemptDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.SUPERVISOR_INFLIGHT_PREEMPT_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * Harness-only writer (ticket a5b36dc6): stamp the preemption time so the next
 * turn renders the IN-FLIGHT guard. Fire-and-forget from the preempt path;
 * never throws; a DB failure is a warn log (the block simply never renders).
 */
export async function markPreemptedInflight(chatId: string): Promise<void> {
  try {
    if (inflightPreemptDisabled()) return;
    // Supervisor-class chats only (the block renders on their wakes; a plain
    // chat's preempt must not mint supervisor_states rows).
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: chatId },
      select: { userId: true, isSupervisor: true, isProjectSupervisor: true },
    });
    if (!chat || (chat.isSupervisor !== true && chat.isProjectSupervisor !== true)) return;
    const userId = typeof chat.userId === 'string' && chat.userId ? chat.userId : null;
    if (!userId) return;
    await upsertDoc(chatId, userId, (doc) => ({ ...doc, inflightPreemptAt: new Date().toISOString() }));
    void import('./loop-metrics.service')
      .then((m) => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.INFLIGHT_PREEMPT_MARK, sessionId: chatId }))
      .catch(() => { /* telemetry never blocks */ });
  } catch (err: any) {
    logger.warn(`supervisor-state: markPreemptedInflight failed for ${chatId}: ${err?.message ?? err}`, { source: SOURCE });
  }
}

/**
 * The [PREEMPTED RUN — ACTION IN FLIGHT] block (ticket a5b36dc6). Rendered
 * LIVE (never from the stored doc — the journal settles as effects land) when
 * a fresh preempt marker exists: which side-effecting calls the interrupted
 * run left UNSETTLED (pending/unknown — the effect may still land, never
 * claim it out or not-out), which ones DID execute (receipt-backed), and the
 * counts of failed / staged / replayed rows. Returns '' when no fresh marker,
 * the kill switch is on, or anything fails (fail-open — the wake proceeds
 * exactly as before).
 */
export async function buildInflightPreemptBlock(chatId: string, opts: { now?: Date } = {}): Promise<string> {
  try {
    if (inflightPreemptDisabled()) return '';
    const doc = await getSupervisorState(chatId);
    const at = Date.parse(doc.inflightPreemptAt);
    const now = (opts.now ?? new Date()).getTime();
    if (!Number.isFinite(at) || now - at > INFLIGHT_PREEMPT_WINDOW_MS || now < at - 60_000) return '';
    const since = new Date(at - INFLIGHT_PREEMPT_WINDOW_MS);
    // Review P2 (ticket a5b36dc6): bound the window AT the stamp (+ 60 s
    // clock grace). An UNBOUNDED window let post-stamp rows (the owner's own
    // turn, later wakes — a busy lane journals dozens of side-effecting
    // calls) fill the take cap newest-first and crowd out the interrupted
    // run's pre-stamp unsettled rows, printing a FALSE "UNSETTLED: none" —
    // the exact retraction this block exists to prevent.
    const until = new Date(at + 60_000);
    const rows = await prisma.toolIntent.findMany({
      where: { chatId, createdAt: { gte: since, lte: until } },
      orderBy: { createdAt: 'desc' },
      take: INFLIGHT_PREEMPT_MAX_ROWS,
      select: { tool: true, state: true, slot: true, receiptId: true, createdAt: true },
    });
    if (!rows.length) return '';
    const unsettled = rows.filter((r) => r.state === 'pending' || r.state === 'unknown');
    const settled = rows.filter((r) => r.state === 'applied');
    const counts = {
      failed: rows.filter((r) => r.state === 'failed').length,
      staged: rows.filter((r) => r.state === 'staged').length,
      replayed: rows.filter((r) => r.state === 'replayed' || r.state === 'withheld').length,
    };
    const ago = Math.max(0, Math.round((now - at) / 60_000));
    const nowDate = new Date(now);
    const parts = [
      `[PREEMPTED RUN — ACTION IN FLIGHT (a preemption interrupted your previous turn ${ago} min ago; the tool-intent journal below is a LIVE read of that turn's side-effecting calls):`,
      `Verify with read tools BEFORE claiming any of these out or not-out — a pending/unknown call's effect may STILL LAND (or have already landed); an applied row DID execute (receipt-backed).]`,
    ];
    if (unsettled.length) {
      parts.push(`UNSETTLED (may still land — NEVER retract a claim without a read-back; state, tool, started):`);
      parts.push(...unsettled.slice(0, 12).map((r) => `- ${r.state} · ${r.tool} · started ${ageOf(r.createdAt.toISOString(), nowDate)} ago`));
      if (unsettled.length > 12) parts.push(`- …and ${unsettled.length - 12} more unsettled row(s) (get_fleet_telemetry / receipts surface them)`);
    } else {
      parts.push(`UNSETTLED: none — every side-effecting call from the interrupted turn has settled.`);
    }
    if (settled.length) {
      parts.push(`EXECUTED (receipt-backed — these DID run; cite the receipt id, never re-claim as fresh):`);
      parts.push(...settled.slice(0, 10).map((r) => `- ${r.tool} · receipt ${r.receiptId ? String(r.receiptId).slice(0, 8) : '(none)'} · ${ageOf(r.createdAt.toISOString(), nowDate)} ago`));
      if (settled.length > 10) parts.push(`- …and ${settled.length - 10} more applied row(s)`);
    }
    if (counts.failed || counts.staged || counts.replayed) {
      parts.push(`OTHER: ${counts.failed} failed, ${counts.staged} staged (awaiting owner confirmation — the card may still be live), ${counts.replayed} replayed/withheld.`);
    }
    return parts.join('\n');
  } catch (err: any) {
    logger.warn(`supervisor-state: inflight-preempt block failed for ${chatId}: ${err?.message ?? err}`, { source: SOURCE });
    return '';
  }
}

// ── Write-time evidence-citation validation (ticket cfeb1a57 class, 2026-09-01)
// ─────────────────────────────────────────────────────────────────────────────
// The post-hoc action verifier strikes fabricated citations from the DELIVERED
// wake note, but the state doc is the recidivism reservoir: a fabricated
// `msg <id>` merged into NOTES (or a directive's evidence, or a dispatch note)
// is rendered into EVERY later wake block by formatStateForWake and re-cited as
// real — the same-class ticket cluster (ba65163d 11×, aac649ba 2×, cfeb1a57).
// The merge now existence-validates the msg/sched citation idioms the
// verifier's evidence + schedule lanes mine — reusing their EXACT miners +
// row checks (same honesty-register exclusion, same prefix-match, same
// fail-toward-miss) — and REJECTS the offending field into `errors`
// (apply-or-reject, never a silent strip). The verifier is loaded via
// DYNAMIC import: this file is a leaf module on the run-start import path and
// the verifier drags in the utility-LLM stack. Fail-open end to end — the row
// checks already return true on a DB error, and any validation hiccup here
// yields [] — a state write is never blocked by an audit-side failure.

/**
 * One "kind id (near-miss hints)" string per FABRICATED citation mined from
 * `text`; [] when every citation verifies, none was mined, or validation
 * itself failed (fail-open).
 */
async function invalidCitedIds(text: string, userId: string): Promise<string[]> {
  try {
    const verifier = await import('./action-verifier');
    // The note-audit miners skip lines shorter than 20 chars (a safe-miss in
    // a long note). At write time a TERSE idiom ('sched 1fd6a55f', a bare
    // '(msg 972ac6fd)' line) is exactly the failure shape — right-pad short
    // lines to the floor so they still mine (adversarial review N1). The pad
    // char is not hex and the idiom regexes are unanchored, so captures are
    // unaffected; '>'-quoted lines still start with '>' and stay skipped.
    const mineable = text
      .split('\n')
      .map((l) => {
        const t = l.trim();
        return t.length > 0 && t.length < 20 ? t + '.'.repeat(20 - t.length) : l;
      })
      .join('\n');
    const candidates = [
      ...verifier.mineEvidenceCitations(mineable).map((c) => ({ kind: 'message' as const, id: String(c.id) })),
      ...verifier.mineScheduleCitations(mineable).map((c) => ({ kind: 'schedule' as const, id: String(c.id) })),
    ];
    if (!candidates.length) return [];
    // One indexed existence probe per distinct cited id, PARALLEL — the
    // evidence lane's review-F4 discipline; .catch(() => true) preserves the
    // fail-toward-miss contract even if an injected check rejects.
    const verdicts = await Promise.all(
      candidates.map((c) =>
        (c.kind === 'message' ? verifier.citedMessageRowExists(c.id) : verifier.citedScheduleRowExists(c.id)).catch(() => true),
      ),
    );
    const bad = candidates.filter((_, i) => !verdicts[i]);
    if (!bad.length) return [];
    // Ticket ef347cd0's educational hint, write-time edition: the rejection
    // names the same-prefix REAL ids so the next attempt cites the id it MEANT.
    const hints = await Promise.all(bad.map((c) => verifier.samePrefixRealIds(c.kind, c.id, userId).catch(() => [] as string[])));
    return bad.map((c, i) => `${c.kind} ${c.id}${hints[i].length ? ` (same-prefix real ids: ${hints[i].join(', ')})` : ''}`);
  } catch {
    return [];
  }
}

// ── Evidence-typed directive closure (remediation P2 v1#4 / CanLaw B4) ───────
// A directive close must cite a TYPED artifact — `<type> <id>` with type
// pr|session|ticket|receipt|msg|schedule (+ chat/sched/run/deploy/oq aliases)
// — and the checkable types are EXISTENCE-verified (msg/schedule already ride
// the cfeb1a57 citation lane; ticket/session/chat/oq get direct fail-open
// prisma probes here). Directives that mention OWNER APPROVAL close only on
// owner-voiced evidence (msg | oq).

/** `<type> <id>` idioms accepted as closure evidence. */
const TYPED_EVIDENCE_RE =
  /\b(pr|pull request|session|chat|ticket|receipt|msg|message|schedule|sched|run|deploy|oq)\b[\s#:]*([a-z0-9][\w./-]{0,60})/gi;

/** Directive text that gates the close on the OWNER's own voice. */
export const OWNER_GATE_DIRECTIVE_RE =
  /\b(owner('s)? (approval|sign-?off|decision|confirmation|go-?ahead)|ask the owner|await(ing|s)? (the )?owner|owner must (approve|confirm|decide)|needs? (the )?owner('s)? (approval|decision|sign-?off)|only (with|after) (the )?owner)\b/i;

export interface TypedEvidenceRef { type: string; id: string }

/** Parse the `<type> <id>` refs out of an evidence string. Pure; exported for tests. */
export function parseTypedEvidence(evidence: string): TypedEvidenceRef[] {
  const out: TypedEvidenceRef[] = [];
  const s = String(evidence ?? '');
  TYPED_EVIDENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TYPED_EVIDENCE_RE.exec(s)) !== null) {
    const raw = m[1].toLowerCase();
    const type =
      raw === 'pull request' ? 'pr'
      : raw === 'message' ? 'msg'
      : raw === 'sched' ? 'schedule'
      : raw === 'chat' ? 'session'
      : raw;
    out.push({ type, id: m[2] });
  }
  return out;
}

/** Owner-voiced evidence types — the only ones that close an owner-gate directive. */
const OWNER_VOICE_EVIDENCE_TYPES = new Set(['msg', 'oq']);

// ── Closure receipt-match (D2, 2026-09-27) ───────────────────────────────────
// The typed gate above existence-checks ticket/session/oq/msg/schedule refs,
// but pr / receipt / run / deploy were FORMAT-ONLY — 'pr #215' closed a
// directive whether or not anyone in this account ever touched PR 215. Now a
// ref is matched where it can actually be found (review fix — the first cut
// matched every type against the closing chat's receipt HEADS, which the DB
// never persists, so a PR# or deploy close read ~100% unreceipted):
//   receipt / run — the supervisor's OWN run_tool_receipts (row ids + ids, last
//     DIRECTIVE_CLOSE_RECEIPT_WINDOW_MS) and its dispatch ledger (real
//     tool-returned ids) — CHAT scope;
//   pr — the same, plus an ACCOUNT-wide probe: a run_tool_receipts row of any
//     chat of this owner carrying ids.prNumber = N (the open_pull_request
//     receipt a lane minted). A supervisor never opens a PR itself, so chat
//     scope alone can never match one;
//   deploy — NOT matched at all (no persisted deploy record exists — the fleet
//     telemetry 'deploy' view is a live GitHub read). Format-only, as on main.
// OBSERVE-ONLY by default (gate-flip doctrine 2026-09-11: never add a blocking
// gate on a lane's own work): an unmatched close still lands, the applied ack
// records it as UNRECEIPTED (neutral — the doctrine itself lists a PR# as
// valid artifact evidence) and one `directive_close_unreceipted` row records
// it with `matchable:true` + the scope each type was checked at (never a
// rejection: a PR opened outside the framework, e.g. by the owner or a GitHub
// connector tool, mints no receipt and would be unclosable). Fail-open end
// to end: a receipts / probe read error counts as matched.
export const DIRECTIVE_CLOSE_RECEIPT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Evidence types matched against the closing chat's OWN receipts (row ids + ids) and dispatch ledger. */
export const RECEIPT_MATCHED_EVIDENCE_TYPES: ReadonlySet<string> = new Set(['receipt', 'run']);
/** Evidence types matched ACCOUNT-wide (any chat of this owner) by a persisted receipt id — `pr` via ids.prNumber. */
export const ACCOUNT_MATCHED_EVIDENCE_TYPES: ReadonlySet<string> = new Set(['pr']);
/** Where each matched type is looked up — stamped on every directive_close_unreceipted row so the readout is honest. */
export const RECEIPT_MATCH_SCOPES: Readonly<Record<string, 'chat' | 'account'>> = Object.freeze({ receipt: 'chat', run: 'chat', pr: 'account' });

/**
 * True when `ref` is present in the supervisor's own receipts or dispatch
 * ledger. Pure over the rows handed in — DB-SHAPED rows only (id + ids; the
 * in-memory argsHead / resultHead are never persisted, so nothing reads them);
 * exported for tests. A pr ref matches `ids.prNumber` (number or string);
 * every other type matches its id against the receipt row's own id (prefix
 * ≥ 6) or as a substring of the receipt's ids, or of a dispatch id.
 */
export function evidenceRefInReceipts(
  ref: TypedEvidenceRef,
  receipts: Array<{ id?: string; tool?: string; ids?: unknown }>,
  dispatches: SupervisorDispatch[],
): boolean {
  const id = String(ref.id ?? '').trim().toLowerCase().replace(/^#/, '');
  if (!id) return false;
  for (const d of dispatches) {
    const did = String(d.id ?? '').toLowerCase();
    if (did === id || (id.length >= 6 && did.includes(id))) return true;
  }
  for (const r of receipts) {
    if (ref.type === 'pr') {
      const pr = (r.ids as any)?.prNumber;
      if (pr !== undefined && pr !== null && String(pr) === id) return true;
      continue;
    }
    // The receipt row's OWN id (the `receipt <id>` idiom).
    const rid = String(r.id ?? '').toLowerCase();
    if (rid && (rid === id || (id.length >= 6 && rid.startsWith(id)))) return true;
    let idsText = '';
    try { idsText = JSON.stringify(r.ids ?? {}).toLowerCase(); } catch { /* ignore */ }
    if (id.length >= 6 && idsText.includes(id)) return true;
    if (id.length < 6 && (idsText.includes(`"${id}"`) || idsText.includes(`:${id},`) || idsText.includes(`:${id}}`))) return true;
  }
  return false;
}

/**
 * ACCOUNT-wide existence probe for a pr ref: any ok run_tool_receipts row of
 * a chat owned by `userId` whose ids.prNumber equals the cited number.
 * Fail-OPEN: `undefined` when the client shape is unavailable (mocks) or the
 * read throws — the caller treats that as matched. Exported for tests.
 */
export async function prReceiptExistsInAccount(userId: string, prNumber: string): Promise<boolean | undefined> {
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    const row = await (prisma as any).runToolReceipt?.findFirst?.({
      where: { ok: true, ids: { path: ['prNumber'], equals: n }, chat: { userId } },
      select: { id: true },
    });
    if (row === undefined) return undefined;
    return row !== null;
  } catch {
    return undefined;
  }
}

/** Fire-and-forget directive_close_unreceipted metric — dynamic import keeps this module a leaf. */
/** audit 2026-10-06 T5-8: one observe-only row per suspect close (fire-and-forget). */
function emitDirectiveCloseMismatchMetric(chatId: string, directive: SupervisorDirective, evidence: string): void {
  void import('./loop-metrics.service')
    .then((m) => m.recordLoopMetric({
      kind: 'directive_close_mismatch',
      sessionId: chatId,
      meta: {
        directiveId: directive.id.slice(0, 8),
        origin: directive.origin ?? null,
        scope: directive.scope ? directive.scope.slice(0, 8) : null,
        evidenceHead: String(evidence).replace(/\s+/g, ' ').slice(0, 80),
        outcome: 'observed',
      },
    }))
    .catch(() => {});
}

function emitDirectiveCloseUnreceiptedMetric(chatId: string, directiveId: string, refs: TypedEvidenceRef[]): void {
  void import('./loop-metrics.service')
    .then((m) => m.recordLoopMetric({
      kind: 'directive_close_unreceipted',
      sessionId: chatId,
      meta: {
        directiveId: directiveId.slice(0, 8),
        refs: refs.slice(0, 6).map((r) => `${r.type} ${r.id}`),
        outcome: 'observed',
        // Every recorded ref was checked where it CAN be found (deploy refs
        // are never recorded — nothing persists them).
        matchable: true,
        scope: Object.fromEntries(refs.slice(0, 6).map((r) => [r.type, RECEIPT_MATCH_SCOPES[r.type] ?? 'chat'])),
      },
    }))
    .catch(() => {});
}

/**
 * The receipt- / account-matched refs that match neither the supervisor's own
 * recent receipts + dispatch ledger nor (pr) any receipt of this account. []
 * when every such ref matches, when there is none, or on any read failure
 * (fail-open). The receipts service is loaded
 * DYNAMICALLY (leaf-module discipline — it drags config/redis via the coding
 * stack).
 */
async function unreceiptedEvidenceRefs(chatId: string, userId: string, refs: TypedEvidenceRef[], dispatches: SupervisorDispatch[]): Promise<TypedEvidenceRef[]> {
  const candidates = refs.filter((r) => RECEIPT_MATCHED_EVIDENCE_TYPES.has(r.type) || ACCOUNT_MATCHED_EVIDENCE_TYPES.has(r.type));
  if (!candidates.length) return [];
  try {
    const svc = await import('../coding/run-receipts.service');
    const receipts = await svc.getRecentChatReceipts(chatId, DIRECTIVE_CLOSE_RECEIPT_WINDOW_MS);
    if (!Array.isArray(receipts)) return [];
    const out: TypedEvidenceRef[] = [];
    for (const r of candidates) {
      if (evidenceRefInReceipts(r, receipts as any[], dispatches)) continue;
      if (ACCOUNT_MATCHED_EVIDENCE_TYPES.has(r.type)) {
        const exists = await prReceiptExistsInAccount(userId, String(r.id ?? '').trim().replace(/^#/, ''));
        if (exists !== false) continue; // matched, or probe unavailable (fail-open)
      }
      out.push(r);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Existence probe for the DB-checkable typed refs (fail-OPEN: a probe error or
 * an unmockable client never blocks a close — same doctrine as the citation
 * lane). msg/schedule are validated by the cfeb1a57 lane (invalidCitedIds),
 * so this covers ticket / session / oq. Returns the refs that provably do NOT
 * exist.
 */
async function missingTypedEvidenceRefs(refs: TypedEvidenceRef[]): Promise<TypedEvidenceRef[]> {
  const missing: TypedEvidenceRef[] = [];
  for (const ref of refs) {
    try {
      const id = ref.id.trim();
      if (id.length < 6) continue; // too short to probe meaningfully — format already passed
      let row: unknown = 'unchecked';
      if (ref.type === 'ticket') {
        row = await (prisma as any).userFeatureRequest?.findFirst?.({ where: { id: { startsWith: id } }, select: { id: true } });
      } else if (ref.type === 'session') {
        row = await (prisma as any).crossModelChat?.findFirst?.({ where: { id: { startsWith: id } }, select: { id: true } });
      } else if (ref.type === 'oq') {
        row = await (prisma as any).ownerQuestion?.findFirst?.({ where: { id: { startsWith: id } }, select: { id: true } });
      } else {
        continue; // pr/receipt/run/deploy: format-only; msg/schedule: cfeb1a57 lane
      }
      if (row === undefined) continue; // client shape unavailable (mocks) — fail open
      if (row === null) missing.push(ref);
    } catch { /* fail open */ }
  }
  return missing;
}

/**
 * Merge the supervisor's own update_supervisor_state call into the doc:
 *   directives — an item WITH an existing id updates status/evidence (closing
 *     REQUIRES non-empty evidence; a close without evidence is rejected into
 *     `errors`, never silently applied); an item WITHOUT id but WITH text is a
 *     NEW open directive. Unknown ids are rejected. Cap: newest 50.
 *   dispatches — appended (kind + id REQUIRED — the real tool-returned id);
 *     note capped at 300. Keep newest 30.
 *   projects — upserted by name (status capped at 200). Keep 20.
 *   notes — full REPLACE, capped at 4000.
 * Cited msg/sched ids in notes / directive evidence / new-directive text /
 * dispatch notes / project statuses are existence-validated BEFORE the merge
 * (ticket cfeb1a57): a fabricated citation rejects the notes replace, the
 * directive item, or the project item outright, and drops a dispatch's note
 * (the dispatch itself still records — its ledger entry exonerates truthful
 * restatements in later wakes). A close riding STORED evidence (item.evidence
 * omitted) validates that stored evidence too.
 * Never throws: a DB failure returns { applied: [], errors: [message] }.
 */
/**
 * Resolve a submitted directive id against a directive list: exact match
 * first, then a UNIQUE ≥8-char prefix (ticket ec58521f — lanes habitually
 * carry 8-char prefixes in their own notes, the schedule_get / hook_update
 * convention). Ambiguous prefixes resolve to undefined; the merge site
 * re-checks matches itself so it can name the candidates in its error.
 */
function resolveDirectiveId<T extends { id: string }>(directives: T[], id: string): T | undefined {
  const exact = directives.find((d) => d.id === id);
  if (exact || id.length < 8) return exact;
  const matches = directives.filter((d) => d.id.startsWith(id));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Pure: the update with every model-typed string field passed through
 * redactInboundSecrets. `redacted` is true when at least one field changed;
 * `fields` names them (`directive.text`, `directive.evidence`,
 * `dispatch.note`, `project.status`, `notes`) for the applied[] note. Items
 * that are not objects pass through untouched (the mutate rejects them).
 */
export function redactStateUpdateSecrets(update: SupervisorStateUpdate): { update: SupervisorStateUpdate; redacted: boolean; fields: string[] } {
  const fields = new Set<string>();
  const scrub = (v: unknown, label: string): unknown => {
    if (typeof v !== 'string' || !v) return v;
    const next = redactInboundSecrets(v);
    if (next !== v) fields.add(label);
    return next;
  };
  const next: SupervisorStateUpdate = { ...(update ?? {}) };
  if (Array.isArray(next.directives)) {
    next.directives = next.directives.map((it) => (it && typeof it === 'object'
      ? { ...it, ...(typeof it.text === 'string' ? { text: scrub(it.text, 'directive.text') as string } : {}), ...(typeof it.evidence === 'string' ? { evidence: scrub(it.evidence, 'directive.evidence') as string } : {}) }
      : it));
  }
  if (Array.isArray(next.dispatches)) {
    next.dispatches = next.dispatches.map((it) => (it && typeof it === 'object' && typeof it.note === 'string' ? { ...it, note: scrub(it.note, 'dispatch.note') as string } : it));
  }
  if (Array.isArray(next.projects)) {
    next.projects = next.projects.map((it) => (it && typeof it === 'object' && typeof it.status === 'string' ? { ...it, status: scrub(it.status, 'project.status') as string } : it));
  }
  if (typeof next.notes === 'string') next.notes = scrub(next.notes, 'notes') as string;
  return { update: next, redacted: fields.size > 0, fields: Array.from(fields) };
}

export async function applyStateUpdate(
  chatId: string,
  userId: string,
  update: SupervisorStateUpdate,
): Promise<SupervisorStateUpdateResult> {
  const applied: string[] = [];
  const errors: string[] = [];
  // Citation validation (ticket cfeb1a57): existence checks are async and the
  // mutate below is sync, so sanitize the update BEFORE the read-modify-write:
  //   notes     — a fabricated citation rejects the whole REPLACE (the model
  //               re-issues without the invented id; the prior notes survive);
  //   directive — an id-bearing item is validated on its EFFECTIVE evidence
  //               (the update's evidence, else the stored directive's on a
  //               close — review N2); a NEW directive on its text (review N3);
  //               a fabricated citation rejects the item (a close must not
  //               land against fabricated evidence);
  //   dispatch  — only the NOTE is dropped: the dispatch itself is a real
  //               tool-returned record whose ledger entry exonerates truthful
  //               restatements in later wakes — rejecting it would convict an
  //               honest re-citation down the line;
  //   project   — a fabricated citation in the one-line status rejects the
  //               item (review N3). Every validated surface except directive
  //               evidence renders into the wake block (identical reservoir
  //               properties); evidence is validated because a directive
  //               closes only against a real artifact.
  // Secret-scrubbing review fix (the write path that persisted directive
  // 384f859b): every MODEL-TYPED string in the update — directive text /
  // evidence, dispatch notes, project statuses, notes — goes through the same
  // inbound credential redaction appendDirective runs on OWNER-typed rows,
  // BEFORE citation validation (so the validated surface is the stored
  // surface). Same leaf, same INBOUND_SECRET_SCAN_DISABLED=1 switch, fail-open
  // (a throw leaves the update as submitted). The read-side redaction stays
  // as defence-in-depth; this closes the persist seam for any route a
  // credential takes into the model's context.
  let sanitized: SupervisorStateUpdate = update ?? {};
  try {
    const scrubbed = redactStateUpdateSecrets(sanitized);
    if (scrubbed.redacted) {
      sanitized = scrubbed.update;
      applied.push(`credential-shaped string(s) were REDACTED before storing (${scrubbed.fields.join(', ')}) — never file a credential into supervisor state; refer to it as "the key pasted in chat <id>"`);
    }
  } catch { /* fail-open: the update lands as submitted */ }
  {
    const citationAdvice =
      'Cite only ids returned by a tool THIS wake; label external-system ids explicitly (e.g. \'gmail:<id>\', \'PR #123\') so they are not mined as crossmodel citations.';
    const directiveItems = Array.isArray(sanitized.directives) ? sanitized.directives : [];
    const dispatchItems = Array.isArray(sanitized.dispatches) ? sanitized.dispatches : [];
    const projectItems = Array.isArray(sanitized.projects) ? sanitized.projects : [];
    // Validate the text AS IT WILL BE STORED: the mutate whitespace-collapses
    // directive text / dispatch notes / project statuses (.replace(/\s+/g,' '))
    // — mining the raw per-line form lets a newline-split idiom evade while
    // its stored (collapsed) form would convict (adversarial review round-2).
    const asStored = (s: string) => s.replace(/\s+/g, ' ');
    // A close may ride STORED evidence (item.evidence omitted — the merge
    // falls back to target.evidence): validate that too, or a close lands on
    // evidence written pre-fix or during a fail-open blip (review N2). One
    // extra doc read, only when such a close is present.
    const needsStoredEvidence = directiveItems.some(
      (it) => typeof it?.id === 'string' && it.id.trim() && it?.status === 'done' && !(typeof it?.evidence === 'string' && it.evidence.trim()),
    );
    const storedDoc = needsStoredEvidence ? await getSupervisorState(chatId).catch(() => null) : null;
    const directiveSurface = (it: (typeof directiveItems)[number]): string => {
      if (typeof it?.id === 'string' && it.id.trim()) {
        if (typeof it.evidence === 'string' && it.evidence.trim()) return it.evidence;
        // Prefix-aware (review F1, ticket ec58521f): the merge below resolves
        // unique ≥8-char prefixes, so the stored-evidence surface must resolve
        // them too — otherwise a prefix-id close with omitted fresh evidence
        // would ride UNVALIDATED stored evidence past the N2 citation guard.
        if (it.status === 'done' && storedDoc) return resolveDirectiveId([...storedDoc.directives, ...storedDoc.archived], String(it.id).trim())?.evidence ?? '';
        return '';
      }
      return typeof it?.text === 'string' ? asStored(it.text) : '';
    };
    const check = (surface: string) => (surface.trim() ? invalidCitedIds(surface, userId) : Promise.resolve([] as string[]));
    const [notesBad, directiveBads, dispatchBads, projectBads] = await Promise.all([
      typeof sanitized.notes === 'string' ? check(sanitized.notes) : Promise.resolve([] as string[]),
      Promise.all(directiveItems.map((it) => check(directiveSurface(it)))),
      Promise.all(dispatchItems.map((it) => (typeof it?.note === 'string' ? check(asStored(it.note)) : Promise.resolve([] as string[])))),
      Promise.all(projectItems.map((it) => (typeof it?.status === 'string' ? check(asStored(it.status)) : Promise.resolve([] as string[])))),
    ]);
    if (notesBad.length || directiveBads.some((b) => b.length) || dispatchBads.some((b) => b.length) || projectBads.some((b) => b.length)) {
      sanitized = { ...sanitized };
      if (notesBad.length) {
        delete sanitized.notes;
        errors.push(`notes NOT applied: cited evidence id(s) do not exist (database existence-checked): ${notesBad.join('; ')}. ${citationAdvice}`);
      }
      if (directiveBads.some((b) => b.length)) {
        sanitized.directives = directiveItems.filter((_, i) => !directiveBads[i].length);
        directiveBads.forEach((bad, i) => {
          if (!bad.length) return;
          const it = directiveItems[i];
          const label = typeof it?.id === 'string' && it.id.trim() ? `directive ${it.id.trim()}` : `new directive "${String(it?.text ?? '').trim().slice(0, 60)}"`;
          errors.push(`${label}: item NOT applied — it cited id(s) that do not exist: ${bad.join('; ')}. ${citationAdvice}`);
        });
      }
      if (dispatchBads.some((b) => b.length)) {
        sanitized.dispatches = dispatchItems.map((it, i) => (dispatchBads[i].length ? { kind: it?.kind, id: it?.id } : it));
        dispatchBads.forEach((bad, i) => {
          if (bad.length) {
            errors.push(`dispatch ${String(dispatchItems[i]?.kind ?? '')} → ${String(dispatchItems[i]?.id ?? '')}: note dropped (the dispatch itself was recorded) — it cited id(s) that do not exist: ${bad.join('; ')}. ${citationAdvice}`);
          }
        });
      }
      if (projectBads.some((b) => b.length)) {
        sanitized.projects = projectItems.filter((_, i) => !projectBads[i].length);
        projectBads.forEach((bad, i) => {
          if (bad.length) errors.push(`project ${String(projectItems[i]?.name ?? '')}: status NOT applied — it cited id(s) that do not exist: ${bad.join('; ')}. ${citationAdvice}`);
        });
      }
    }
  }
  // ── Evidence-TYPED closure gate (remediation P2 v1#4 / CanLaw B4) ──────────
  // Runs on the items that survived citation validation, BEFORE the sync
  // mutate (the probes are async). Empty evidence is left to the existing
  // in-mutate rejection so its message stays byte-stable.
  // Observe-only receipt-match notes (D2): keyed by the submitted item so the
  // ack lands next to the close it describes after the mutate.
  const unreceiptedNotes = new Map<unknown, string>();
  // audit 2026-10-06 T5-8: observe-only "evidence about something else" notes, keyed like unreceiptedNotes.
  const mismatchNotes = new Map<unknown, string>();
  if (Array.isArray(sanitized.directives)) {
    const closeItems = sanitized.directives.filter(
      (it) => it && typeof it.id === 'string' && it.id.trim() && it.status === 'done',
    );
    if (closeItems.length) {
      const doc = await getSupervisorState(chatId).catch(() => null);
      const rejectedIdx = new Set<number>();
      for (const item of closeItems) {
        const submittedId = String(item.id).trim();
        const target = doc ? resolveDirectiveId(doc.directives, submittedId) : undefined;
        const evidence = String(
          (typeof item.evidence === 'string' && item.evidence.trim()) ? item.evidence : target?.evidence ?? '',
        ).trim();
        if (!evidence) continue; // the mutate's "closing requires evidence" rejection owns this
        const label = `directive ${submittedId}`;
        const refs = parseTypedEvidence(evidence);
        let reason = '';
        if (!refs.length) {
          reason = `${label}: close NOT applied — closing evidence must be TYPED, '<type> <id>' with type pr | session | ticket | receipt | msg | schedule (e.g. 'pr #215', 'session 1a2b3c4d', 'msg 08ae015c'). Untyped prose does not close a directive.`;
        } else if (target && OWNER_GATE_DIRECTIVE_RE.test(target.text) && !refs.some((r) => OWNER_VOICE_EVIDENCE_TYPES.has(r.type))) {
          reason = `${label}: close NOT applied — this directive requires OWNER approval, so it closes only against the owner's own voice: evidence of type 'msg <id>' (an owner transcript message) or 'oq <id>' (an answered owner question). Machine artifacts (PRs, sessions, tickets) cannot close it.`;
        } else {
          const missing = await missingTypedEvidenceRefs(refs);
          if (missing.length) {
            reason = `${label}: close NOT applied — cited evidence id(s) do not exist (database existence-checked): ${missing.map((r) => `${r.type} ${r.id}`).join('; ')}.`;
          } else {
            // Receipt-match (D2, 2026-09-27): receipt/run refs must appear in
            // THIS supervisor's own receipts or dispatch ledger; a pr ref in
            // any receipt of this ACCOUNT (a lane's open_pull_request). Deploy
            // refs are never matched (nothing persists them). Observe-only.
            const unreceipted = await unreceiptedEvidenceRefs(chatId, userId, refs, doc?.dispatches ?? []);
            if (unreceipted.length) {
              const listed = unreceipted.map((r) => `${r.type} ${r.id}`).join('; ');
              const where = `this chat's receipts (last ${Math.round(DIRECTIVE_CLOSE_RECEIPT_WINDOW_MS / 86_400_000)} d), its dispatch ledger${unreceipted.some((r) => ACCOUNT_MATCHED_EVIDENCE_TYPES.has(r.type)) ? ", or this account's PR receipts" : ''}`;
              emitDirectiveCloseUnreceiptedMetric(chatId, target?.id ?? submittedId, unreceipted);
              unreceiptedNotes.set(item, `directive ${target?.id ?? submittedId} closed UNRECEIPTED (observed only — the close stands): evidence ${listed} was found in none of ${where}. When you have one, cite the id from your own tool result.`);
            }
          }
        }
        // audit 2026-10-06 T5-8 (fleet F4, spark F9): a close that will land
        // with evidence sharing NO id / key noun with the directive is
        // recorded + warned, never refused (directive-close-relevance.ts).
        if (!reason && !directiveCloseRelevanceDisabled()) {
          const relTarget = target ?? (doc ? resolveDirectiveId(doc.archived, submittedId) : undefined);
          if (relTarget) {
            const rel = directiveCloseRelevance({ directiveText: relTarget.text, scope: relTarget.scope ?? null, evidence });
            if (!rel.related) {
              mismatchNotes.set(item, directiveCloseMismatchNote(relTarget.id, evidence));
              emitDirectiveCloseMismatchMetric(chatId, relTarget, evidence);
            }
          }
        }
        if (reason) {
          errors.push(reason);
          const idx = sanitized.directives.indexOf(item);
          if (idx >= 0) rejectedIdx.add(idx);
        }
      }
      if (rejectedIdx.size) {
        sanitized = { ...sanitized, directives: sanitized.directives.filter((_, i) => !rejectedIdx.has(i)) };
      }
    }
  }
  // Review 2026-10-22: an id the HOT doc does not hold may name a CLOSED row
  // in the cold archive (spillClosedArchive). Inside the serialized write,
  // before the sync mutate, such a row is pulled back into `archived` so the
  // existing archive path revives it (status 'open') or updates it where it
  // lies; its cold key is dropped once the hot write lands. Only ids with NO
  // hot match (exact or prefix) are looked up, and only when cold rows exist.
  const promotedFromCold = new Set<string>();
  const idItems = (Array.isArray(sanitized.directives) ? sanitized.directives : [])
    .map((it) => (it && typeof it === 'object' && typeof it.id === 'string' ? it.id.trim() : ''))
    .filter(Boolean);
  const prepare = idItems.length
    ? async (doc: SupervisorStateDoc) => {
        if (!(doc.archivedColdCount && doc.archivedColdCount > 0)) return;
        const hot = [...doc.directives, ...doc.archived];
        for (const id of idItems) {
          if (hot.some((d) => d.id === id || (id.length >= 8 && d.id.startsWith(id)))) continue;
          const found = await findColdArchivedDirective(chatId, id);
          if (!found.row || doc.archived.some((d) => d.id === found.row!.id) || doc.directives.some((d) => d.id === found.row!.id)) continue;
          // At its archive-time position (review round 3): appended, an old row
          // read as the NEWEST closed row — it stayed hot after an evidence-only
          // update and a genuinely newer closed row spilled cold in its place.
          doc.archived = insertByArchiveTime(doc.archived, found.row);
          promotedFromCold.add(found.row.id);
          hot.push(found.row);
        }
      }
    : undefined;
  try {
    await upsertDoc(chatId, userId, (doc) => {
      if (Array.isArray(sanitized.directives)) {
        for (const item of sanitized.directives) {
          if (!item || typeof item !== 'object') continue;
          const id = typeof item.id === 'string' ? item.id.trim() : '';
          if (id) {
            let target = doc.directives.find((d) => d.id === id);
            if (!target && id.length >= 8) {
              // Prefix resolution (ticket ec58521f): directive ids are full
              // randomUUIDs, but supervisor lanes habitually carry 8-char
              // prefixes in their own notes (the same convention
              // schedule_get / hook_update / cancel_schedule accept) and
              // submit those on close — an exact-match lookup made
              // directives unclosable in practice. A UNIQUE >=8-char prefix
              // resolves; an ambiguous one names its candidates instead of
              // guessing; invented ids still fail below.
              const matches = doc.directives.filter((d) => d.id.startsWith(id));
              if (matches.length === 1) target = matches[0];
              else if (matches.length > 1) {
                errors.push(`directive ${id}: ambiguous id prefix — matches ${matches.length} directives (${matches.map((m) => m.id.slice(0, 13)).join(', ')}…); submit more characters of the id`);
                continue;
              }
            }
            if (!target) {
              // Archive lookup (autonomy loop #6): an id from the archive is
              // real. status:'open' REVIVES it (fresh `at`, else the next tidy
              // re-archives it at once); a close / evidence / scope update
              // lands on the archived row where it lies.
              const arch = resolveDirectiveId(doc.archived, id);
              if (arch) {
                if (item.status === 'open') {
                  doc.archived = doc.archived.filter((d) => d !== arch);
                  delete arch.archivedAt;
                  arch.at = new Date().toISOString();
                  doc.directives.push(arch);
                  applied.push(`directive ${arch.id} revived from the ${promotedFromCold.has(arch.id) ? 'cold ' : ''}archive`);
                }
                target = arch;
              }
            }
            if (!target) {
              errors.push(`directive ${id}: no such directive id — never invent one; copy it from the injected state block or get_supervisor_state (a unique ≥8-char prefix is accepted)`);
              continue;
            }
            const did = target.id;
            if (item.status !== undefined) {
              if (item.status !== 'open' && item.status !== 'done') {
                errors.push(`directive ${did}: status must be 'open' | 'done' (got "${String(item.status)}")`);
                continue;
              }
              if (item.status === 'done') {
                const evidence = String(item.evidence ?? target.evidence ?? '').trim();
                if (!evidence) {
                  // The anti-phantom-dispatch rule: a directive closes ONLY
                  // against an artifact (PR#, session id, ticket id) — rejected,
                  // NOT applied.
                  errors.push(`directive ${did}: closing requires evidence (a PR#, session id, or ticket id from a tool result THIS wake)`);
                  continue;
                }
                target.evidence = evidence.slice(0, MAX_EVIDENCE);
              }
              target.status = item.status;
            } else if (typeof item.evidence === 'string' && item.evidence.trim()) {
              target.evidence = item.evidence.trim().slice(0, MAX_EVIDENCE);
            }
            if (item.standing === true) target.standing = true; // supervisor-set standing flag (P2 B6)
            // Ticket 661fb494: a merge may (re)stamp the directive's scope —
            // the project the owner message binds, or 'fleet' when explicitly
            // fleet-wide.
            if (typeof item.scope === 'string' && item.scope.trim()) {
              target.scope = item.scope.replace(/\s+/g, ' ').trim().slice(0, MAX_DIRECTIVE_SCOPE);
            }
            applied.push(`directive ${did} updated${did === id ? '' : ` (resolved from prefix ${id})`}`);
            const unreceipted = unreceiptedNotes.get(item);
            if (unreceipted && target.status === 'done') applied.push(unreceipted);
            const mismatch = mismatchNotes.get(item);
            if (mismatch && target.status === 'done') applied.push(mismatch);
          } else if (typeof item.text === 'string' && item.text.trim()) {
            const text = item.text.replace(/\s+/g, ' ').trim().slice(0, MAX_DIRECTIVE_TEXT);
            const scope = typeof item.scope === 'string' ? item.scope.replace(/\s+/g, ' ').trim().slice(0, MAX_DIRECTIVE_SCOPE) : '';
            // `origin` is NEVER taken from the model item: a row the supervisor
            // adds here has no provenance stamp, so the project brief never
            // renders it as an owner decision (SupervisorDirective.origin).
            doc.directives.push({
              id: randomUUID(),
              text,
              at: new Date().toISOString(),
              status: 'open',
              ...(item.standing === true || STANDING_DIRECTIVE_RE.test(text) ? { standing: true } : {}),
              ...(scope ? { scope } : {}),
            });
            applied.push(`directive added: "${item.text.trim().slice(0, 80)}"`);
          } else {
            errors.push('directive item needs an existing id (to update) or text (to add)');
          }
        }
        // Cap eviction (remediation P2 v1#3/B6): DONE non-standing rows evict
        // oldest-first (into the archive since 2026-10-22 — capDirectivesIntoArchive);
        // OPEN/standing rows are NEVER silently dropped — an all-open overflow
        // keeps every row and reports the pressure.
        {
          const overflow = applyDirectiveCap(chatId, doc);
          if (overflow > 0) emitDirectiveOverflowMetric(chatId, overflow);
        }
      }

      if (Array.isArray(sanitized.dispatches)) {
        for (const item of sanitized.dispatches) {
          if (!item || typeof item !== 'object') continue;
          const kind = String(item.kind ?? '').trim();
          const id = String(item.id ?? '').trim();
          if (!kind || !id) {
            errors.push('dispatch needs BOTH kind and id (the real tool-returned id — a claim without an id is a fabrication)');
            continue;
          }
          const note = typeof item.note === 'string' ? item.note.replace(/\s+/g, ' ').trim().slice(0, MAX_DISPATCH_NOTE) : '';
          // fixer 2026-09-27 (finding upward-chatter-5): the owner-turn empty
          // retry (chat-agent, tool-call-leak allow list) replays a whole turn
          // whose first attempt may already have recorded this dispatch — an
          // unconditional push double-wrote RECENT DISPATCHES (the history
          // every later wake reads) and the 30-row slice evicted a real row
          // per duplicate. Same kind + id within the window is the same
          // action (ids are tool-returned); a legit re-touch of the same todo
          // on a later wake falls outside the window and still records.
          const dup = doc.dispatches.find((d) => d.kind === kind && d.id === id && withinDispatchDedupeWindow(d.at));
          if (dup) {
            applied.push(`dispatch already recorded: ${kind} ${id} (no duplicate row — a HISTORY record of the action, NOT evidence it ran this wake)`);
            continue;
          }
          doc.dispatches.push({ at: new Date().toISOString(), kind, id, ...(note ? { note } : {}) });
          // Ticket f5b94615: the ack must never read as an EXECUTION receipt —
          // the bare 'kind → id' idiom inside a THIS-wake tool result let a
          // wake cite the ledger echo as evidence the action ran this wake
          // (rule 6 counts "update calls" as evidence-list sources). Ledger
          // framing, no arrow idiom.
          applied.push(`dispatch ledger updated: ${kind} ${id} (a HISTORY record of the action — NOT evidence it ran this wake)`);
        }
        doc.dispatches = doc.dispatches.slice(-MAX_DISPATCHES);
      }

      if (Array.isArray(sanitized.projects)) {
        for (const item of sanitized.projects) {
          if (!item || typeof item !== 'object') continue;
          const name = String(item.name ?? '').trim();
          const status = String(item.status ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PROJECT_STATUS);
          if (!name || !status) {
            errors.push('project status needs BOTH name and status');
            continue;
          }
          const existing = doc.projects.find((p) => p.name === name);
          if (existing) {
            existing.status = status;
            existing.at = new Date().toISOString();
          } else {
            doc.projects.push({ name, status, at: new Date().toISOString() });
          }
          applied.push(`project status: ${name}`);
        }
        doc.projects = doc.projects.slice(-MAX_PROJECTS);
      }

      if (sanitized.notes !== undefined && sanitized.notes !== null) {
        doc.notes = String(sanitized.notes).slice(0, MAX_NOTES);
        applied.push('notes replaced');
      }
      return doc;
    }, { prepare, promotedFromCold });
  } catch (err: any) {
    const message = err?.message ?? String(err);
    logger.warn(`supervisor-state: applyStateUpdate failed for ${chatId}: ${message}`, { source: SOURCE });
    return { applied: [], errors: [message] };
  }
  return { applied, errors };
}

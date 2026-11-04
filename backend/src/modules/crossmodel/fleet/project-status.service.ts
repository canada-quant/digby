/**
 * Project status updates (owner ask 2026-09-14, verbatim: "add deterministic
 * code for all PROJECT level supervisors to emit once per hour a concise
 * non-technical update in the ui to the user on the current status of the
 * project and how it relates to its goals, todos, blockers etc.").
 *
 * DETERMINISTIC — NO LLM. Every hour, for every project whose per-project
 * supervisor is enabled (crossmodel_projects.projectSupervisorEnabled) and
 * scaffolded (an isProjectSupervisor chat exists), this service READS the
 * project's ledger and RENDERS one plain-language status card:
 *
 *   · project_goals   → active / done / blocked counts, blocked titles + reasons
 *   · project_todos   → in-progress (Working on), pending (Next), blocked,
 *                       done-since-the-last-update (Done in the last hour)
 *   · agent_runs + coding_schedules on the project's chats → lanesRunning
 *   · hook_events on the project-scope hook in the window → run_completed /
 *                       run_failed / todo_done counts
 *   · owner_questions (open) on the project's chats → ownerItems
 *   · the supervisor's latest machine-wake note, FIRST LINE ONLY and only
 *     when it opens with a mandated marker ('WAKE: no-op' / 'SWEEP: no-op' /
 *     'ACTIONS TAKEN') — a quiet check-in or an action receipt line; harness
 *     provider-error envelopes are skipped (ticket 68742517)
 *
 * …and INSERTS it as an assistant-role crossmodel_messages row in the PROJECT
 * SUPERVISOR chat (metadata.origin 'project_status' — the SHARED CONTRACT the
 * frontend renders as a compact status card). The row is written DIRECTLY with
 * prisma.crossModelMessage.create (the platform/pending-confirmations.ts
 * postLaneMootNote pattern) — NEVER through sendChatMessage: no run, no hook
 * wake, no model in the loop. The supervisor chat's updatedAt is bumped so the
 * sidebar surfaces the update.
 *
 * Wording rules (a non-technical owner reads it in ~20 seconds): goal and todo
 * TITLES are allowed; ids / SHAs / receipts / hex are NOT — stripIdentifiers
 * removes uuids, \b[0-9a-f]{8,}\b, oq_/cf_ tokens and "receipt …" tokens. The
 * headline is ONE sentence on where the project stands vs its goals, e.g.
 * "CanLaw: 2 of 3 goals active, 1 blocked on the SoR rebuild; 2 lanes working".
 *
 * Cadence: the durable cron fires every 15 min (worker.ts 'project-status',
 * the attention-watchdog cadence); the 60-MIN GATE LIVES HERE — a lane whose
 * newest project_status row was last CHECKED (metadata.generatedAt, falling
 * back to createdAt) less than PROJECT_STATUS_INTERVAL_MS ago is skipped. The
 * gate compares against the sweep's `now`; everything else a lane writes —
 * generatedAt, the timing block, the chat bump, and so the NEXT window's
 * `since` — is stamped from that lane's OWN read clock, captured right before
 * its ledger read (review C2, 2026-09-24: a 200-lane sweep stamped every card
 * with the sweep's start time).
 *
 * "Unchanged" (2026-09-24 design decision: A CHANGED SET OF ASKS IS A REAL
 * CHANGE) means BOTH the structured status hash is unchanged AND the brief's
 * asks fingerprint equals the previous brief's (a missing/null previous
 * fingerprint counts as changed once). The hash covers ledger state only —
 * goals, todos, blocks, owner items, the board-derived "Working on" — never
 * the timing block, lanesRunning/lanesScheduled, the headline that carries
 * them, or the synthesized "Running: <lane>" entries (reviews C3/C4: a run
 * finishing or a schedule firing is not news the owner asked to be woken
 * for). On an unchanged hour ONE stub row lands reading "<project>: no change
 * since <HH:MMZ>" (or "no change for 3 days" once the streak is ≥ 20 h —
 * review C5) plus the "; N item(s) waiting on you" clause when owner
 * questions are open, with empty sections (metadata.unchanged, quietSince =
 * the last real card's time, quietChecks 1); metadata.statusHash keeps the
 * UNDERLYING hash so the next comparison is against real state, not the
 * stub, and the previous brief is COPIED FORWARD verbatim — a stub never
 * rebuilds it. Every further quiet hour UPDATES THAT STUB IN PLACE
 * (generatedAt AND createdAt = the check time so the stub stays the chat's
 * tail row — review C13; timing; quietChecks += 1) and does NOT bump the
 * chat — owner 2026-09-24: eight near-identical "no change in the last hour"
 * cards overnight (23 status rows in 24 h, six of them the same 08:21Z
 * brief). When only the asks moved, a REAL card (full body + rebuilt brief)
 * lands exactly like a status change. A brief build that fails keeps the
 * previous brief (never one built from empty ledger inputs — review C8).
 *
 * Lane counters (owner 2026-09-24: "Three work sessions are still running …
 * but no active work item" while nothing ran): lanesRunning counts lanes with
 * a RUNNING agent_run ONLY; lanes with merely an enabled schedule are
 * lanesScheduled. The headline, the brief prompt and the timing reason all
 * read from the split, and a running lane with no board item shows up in
 * "Working on" as "Running: <lane> (<age>m)" — built from the UNCAPPED
 * running set, "…and N more running" past TIMING_MAX_LANES (review C18) — so
 * the card never contradicts its own counters.
 *
 * Kill switch: PROJECT_STATUS_UPDATES_DISABLED=1 (read per call). Failure
 * posture: per-project try/catch isolation; the sweep never throws into the
 * cron loop.
 */

import { createHash } from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { OWNER_WAIT_CLAIM_RE, INLINE_OQ_ID_RE, isCounterQuestionRow } from '../platform/owner-questions';
import { isHarnessErrorNote } from '../coding/harness-error-notes';
import { progressNoteLead } from '../platform/progress-note';
// KPI of record (tt-rd audit 2026-09-27, finding 4): the card carries the
// register's number — key, value, receipt, age, bar — composed by the
// harness, never read from a model-typed progress note.
import { kpiPremiseOf, readPremisesLoose, renderKpiCardLine, type KpiPremiseLike, type PremiseValueStamp } from '../platform/kpi-of-record';
// Owner 2026-09-29: the at-a-glance update (state · summary · changes · needs
// you). Circular with this module by design — it reads plain /
// parseProgressFraction / plural at CALL time only (the project-brief pattern).
import { buildProjectUpdate, renderUpdateMarkdown } from './project-update';
import { computeNeedsYouUnion } from '../platform/owner-needs-you';
import { HARNESS_ACTIONS_HEADER, harnessActionLineCount } from '../platform/harness-receipts';

// ── Contract constants ───────────────────────────────────────────────────────

/** metadata.origin AND metadata.kind of a status row (the shared contract). */
export const PROJECT_STATUS_ORIGIN = 'project_status';
/** Minimum age of the previous status row before a new one is emitted. */
export const PROJECT_STATUS_INTERVAL_MS = 60 * 60 * 1000;
/** Upper bound on the "since" window when the previous row is very old
 *  (worker outage) — keeps the hook_events/todo scans bounded. */
export const PROJECT_STATUS_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Body budget (chars) — the card must be readable in ~20 seconds. */
export const PROJECT_STATUS_BODY_MAX_CHARS = 900;
/** Items per section before the "+N more" line takes over (shrinks to fit). */
export const PROJECT_STATUS_MAX_ITEMS = 4;
/** Per-item text cap (code points) — one line stays one line. */
export const PROJECT_STATUS_ITEM_MAX_CHARS = 90;
/** Bound on supervisor lanes swept per firing (pathology guard). */
export const MAX_PROJECTS_PER_SWEEP = 200;
/** Kill switch env (read per call so ops can flip it live). */
export const PROJECT_STATUS_DISABLED_ENV = 'PROJECT_STATUS_UPDATES_DISABLED';
/**
 * CHANGE-ONLY cards (owner 2026-09-29: "the project supervisor should always
 * update the user with a message when something changes or progress is made
 * or a new session related or subsession finishes"; then "doesnt the sweep
 * just cause too much noise? doesnt it make more sense to just operate off
 * hooks, schedules, messages, responses"; "an hourly sweep makes sense at the
 * Fleet supervisor … but that seems too much noise"). By default a project
 * supervisor chat gets a card ONLY when fleet/project-update names a
 * MILESTONE — no hourly card, no "no change" stub. The check is triggered by
 * the project's hook events (requestProjectStatusCheck, from
 * hooks.service emitHookEvent) and the 15-min cron is the catch-all for
 * changes that fire no hook (a goal edit, a new owner question). Two posts
 * are at least PROJECT_STATUS_CHANGE_MIN_MS apart (a cron check) /
 * PROJECT_STATUS_EVENT_MIN_MS (an event check); a change inside that spacing
 * rides the next post — the window starts at the last POSTED card.
 * PROJECT_STATUS_HOURLY_ENABLED=1 restores the hourly card + quiet stub (a
 * milestone then also posts inside the hour).
 */
export const PROJECT_STATUS_CHANGE_MIN_MS = 10 * 60 * 1000;
export const PROJECT_STATUS_EVENT_MIN_MS = 60 * 1000;
export const PROJECT_STATUS_HOURLY_ENV = 'PROJECT_STATUS_HOURLY_ENABLED';
export function projectStatusHourlyEnabled(): boolean {
  return process.env[PROJECT_STATUS_HOURLY_ENV] === '1';
}
/** audit 2026-10-06 T8-2: kill switch for "a milestone post rebuilds the brief" (restores the reuse-under-an-hour rule). */
export function milestoneBriefRebuildDisabled(): boolean {
  return process.env.PROJECT_STATUS_MILESTONE_BRIEF_REBUILD_DISABLED === '1';
}

/** Supervisor machine-wake note origins (mirrors fleet.service MACHINE_ORIGINS). */
const SUPERVISOR_NOTE_ORIGINS = ['schedule', 'hook', 'machine', 'agent', 'webhook'] as const;
/** Batch size for the check-in read — the newest NON-ENVELOPE note wins
 *  (ticket 68742517); covers a run of consecutive provider-killed wakes. */
const CHECK_IN_NOTE_FETCH = 8;
/** The mandated wake-note markers (supervisor.service owns the prompts). */
const NOOP_MARKER_RE = /^(?:SWEEP|WAKE):\s*no-op\b/i;
const REPORTED_MARKER_RE = /^(?:SWEEP|WAKE):\s*reported\b/i;
// 'ACTIONS TAKEN' plus the receipt-count header shape supervisor.service
// accepts too ('Actions (2, with receipts):').
const ACTIONS_MARKER_RE = /^ACTIONS?\s+TAKEN\b|^Actions?\s*\(\s*\d+/i;

// ── Shapes (SHARED CONTRACT — the frontend renders these) ────────────────────

export interface ProjectStatus {
  projectName: string;
  headline: string;
  workingOn: string[];
  doneSince: string[];
  blocked: string[];
  next: string[];
  goals: { active: number; done: number; blocked: number };
  todos: { inProgress: number; pending: number; blocked: number; doneSince: number };
  /** Distinct lane chats with a status:'running' agent_run (2026-09-24: no longer
   *  counts merely-scheduled lanes). */
  lanesRunning: number;
  /** Distinct lane chats with an enabled schedule and NO running run — idle
   *  until their next wake. Additive (2026-09-24); absent on older rows. */
  lanesScheduled?: number;
  ownerItems: number;
  /** Owner 2026-09-17 ("what is going on / how much longer"): harness-MEASURED
   *  timing — running durations, last activity, next wakes, progress fractions
   *  the lanes reported, rate-based estimates from the previous card, and the
   *  last hour's closures. Additive; EXCLUDED from the no-change hash (it
   *  changes every hour by construction). Never model-authored. */
  timing?: ProjectTiming;
  /** KPI of record (tt-rd audit 2026-09-27, finding 4): the goal's kpi: premise
   *  as the register holds it — never a model-typed note. `ageMin`,
   *  `experimentsSinceMove` and `hoursSinceMove` are clocks/counters and are
   *  EXCLUDED from the no-change hash (key/value/receipt/bar are hashed). */
  kpi?: ProjectKpiStatus;
}

export interface ProjectKpiStatus {
  goalId: string;
  key: string;
  value: number;
  unit?: string;
  bar?: number;
  /** Ticket 9fcd69ca: declared bar direction ('up' floor / 'down' ceiling) — absent ⇒ inferred from the first registered history value. Hashed: the card reads it via kpiBarText. */
  barDirection?: string;
  /** Registered value stamps — the inference input when barDirection is undeclared; the first entry is hashed. */
  history?: PremiseValueStamp[];
  receiptId?: string;
  setAt?: string;
  ageMin?: number;
  /** harness-counted completed work sessions on the goal's lanes since the last receipted KPI move (adoption ladder) */
  experimentsSinceMove?: number;
  hoursSinceMove?: number;
  /** the value this one replaced (finding 2a) */
  prevValue?: number;
}

export interface ProjectStatusMetadata {
  origin: typeof PROJECT_STATUS_ORIGIN;
  kind: typeof PROJECT_STATUS_ORIGIN;
  generatedAt: string;
  since: string;
  status: ProjectStatus;
  /** Stable hash of the UNDERLYING structured status (survives the no-change stub). */
  statusHash?: string;
  /** true when this row is the "no change since …" stub. */
  unchanged?: boolean;
  /** Stub rows only (2026-09-24): ISO time of the last REAL (changed) card —
   *  the quiet streak's start; the headline reads "no change since <HH:MMZ>". */
  quietSince?: string;
  /** Stub rows only: how many hourly checks found no change (1 on insert;
   *  +1 per in-place refresh). */
  quietChecks?: number;
  /** Owner 2026-09-29: the at-a-glance update the card now LEADS with — one
   *  state pill, one summary line, what changed since the last update, the
   *  open owner questions verbatim, the next check (fleet/project-update.ts).
   *  Refreshed on every check, stubs included. Absent on rows older than
   *  2026-09-29. */
  update?: import('./project-update').ProjectUpdate;
  /** Owner 2026-09-22 ("the project status updates but more in depth human
   *  readable"): the plain-language brief — mission / now / changed / blocked /
   *  next + "You asked" (fleet/project-brief.service). Rebuilt on every REAL
   *  card; copied forward verbatim on a quiet stub (its asksFingerprint is,
   *  by construction, the current one); kept from the previous card when a
   *  rebuild fails; absent when no brief has ever built. */
  brief?: import('./project-brief.service').ProjectBrief;
}

export interface RenderedProjectStatus {
  status: ProjectStatus;
  /** Markdown body — headline line + the four short sections. */
  body: string;
  /** Stable hash of `status` (sorted keys; no timestamps live in it). */
  hash: string;
  /** Owner 2026-09-29: the at-a-glance update (state · summary · changes ·
   *  needs you). */
  update?: import('./project-update').ProjectUpdate;
}

export interface ProjectStatusSweepResult {
  scanned: number;
  /** Rows INSERTED (real cards + first-hour stubs). */
  emitted: number;
  /** Quiet hours (first-hour stubs + in-place refreshes). */
  unchanged: number;
  /** Quiet hours that refreshed the existing stub in place instead of inserting (2026-09-24). */
  updatedInPlace: number;
  /** Cards posted INSIDE the hourly gate because a milestone changed (2026-09-29). */
  changePosts: number;
  gated: number;
  failed: number;
  disabled: boolean;
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** True when the kill switch is set. Read per call. */
export function projectStatusUpdatesDisabled(): boolean {
  return process.env[PROJECT_STATUS_DISABLED_ENV] === '1';
}

/**
 * Strip machine identifiers from owner-facing text: uuids, hex runs of 8+,
 * oq_/cf_ tokens, "receipt <id>" tokens, "(msg …)" refs, backticks — then
 * collapse whitespace and tidy the punctuation the removals leave behind.
 * Pure, total, never throws.
 */
export function stripIdentifiers(input: unknown): string {
  let s = String(input ?? '');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ');
  // Harness clocks (owner 2026-09-14: status in the owner's local time). The
  // renderer cannot know the viewer's zone, and the card already carries a
  // local timestamp — so ISO stamps ("2026-09-14T14:41:21Z") and zoned wall
  // clocks ("14:41Z", "14:41:05Z", "14:41 UTC") copied from wake notes go.
  s = s.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})\b/g, ' ');
  s = s.replace(/(?<![\d:.])\d{1,2}:\d{2}(?::\d{2})?\s?(?:Z|UTC)\b/g, ' ');
  // oq_<id> owner-question ids and cf_<id> confirmation ids (the two prefixed
  // id namespaces that leak into blocked reasons and wake notes).
  s = s.replace(/\b(?:oq|cf)_[A-Za-z0-9_-]+/g, ' ');
  // "receipt <id>" / "receipt id: <id>" — the word plus an id-SHAPED token
  // (one containing a digit or underscore); a plain following word survives.
  s = s.replace(/\breceipts?(?:\s+ids?)?\b\s*[:#=-]?\s*(?:[A-Za-z0-9_-]*[\d_][A-Za-z0-9_-]*)?/gi, ' ');
  s = s.replace(/\b[0-9a-f]{8,}\b/gi, ' ');
  s = s.replace(/#[0-9a-f]{6,}\b/gi, ' ');
  s = s.replace(/`/g, '');
  // Refs left hollow by the strips: "(msg )", "[ open]", "(id: )", "(commit )".
  s = s.replace(/[([{]\s*(?:msg|id|run|open|ref|commit|sha|gate)?\s*[:#]?\s*[)\]}]/gi, ' ');
  // A stripped id that LED a parenthesised list leaves "(, answeredBy owner)"
  // (first live cards, 2026-09-14 15:48Z) — drop the orphan separator, and
  // any bracket pair the strips emptied entirely.
  s = s.replace(/([([{])\s*[,;:]\s*/g, '$1');
  s = s.replace(/\s*[,;:]\s*([)\]}])/g, '$1');
  s = s.replace(/[([{]\s*[)\]}]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+([,;:.)\]])/g, '$1');
  s = s.replace(/[\s,;:—–-]+$/g, '').replace(/^[\s,;:—–-]+/g, '');
  return s;
}

/** Collapse whitespace and cap length with an ellipsis (code-point safe). */
export function clipText(input: unknown, max: number = PROJECT_STATUS_ITEM_MAX_CHARS): string {
  const t = String(input ?? '').trim().replace(/\s+/g, ' ');
  const units = Array.from(t);
  return units.length <= max ? t : `${units.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** Owner-facing item text: identifiers stripped, then clipped. Exported since
 *  2026-09-15 for the per-session sibling renderer (coding/session-status.service):
 *  one owner-facing status idiom, never two. */
export function plain(input: unknown, max: number = PROJECT_STATUS_ITEM_MAX_CHARS): string {
  return clipText(stripIdentifiers(input), max);
}

/** Recursively sort object keys so the hash is independent of insertion order. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Stable hash of a structured status — LEDGER STATE ONLY (the no-change
 * gate). Excluded, because they move without anything the owner asked about
 * having changed: the timing block (durations and clocks), lanesRunning /
 * lanesScheduled and the headline that carries them (reviews C3/C4,
 * 2026-09-24: a run finishing or a schedule firing flipped the card to
 * "changed" every hour), and — by the renderer's construction — the
 * synthesized "Running: <lane> (<age>m)" working-on entries: the renderer
 * hashes the BOARD-derived "Working on" captured before that fallback is
 * pushed, so no regex ever has to guess which entries are synthesized. The
 * headline's real content (goal counts, the blocked title, owner items) is
 * already hashed through the fields it is built from.
 */
/** The renderer's WINDOW event lines in `blocked` (this module's own
 *  wording) — they come and go hour to hour; the update's `changes` carries
 *  them into the change signal instead (2026-09-29). */
const WINDOW_EVENT_LINE_RE = /^\d+ (?:work sessions? hit an error|lanes? asked for attention)$/;

export function hashProjectStatus(status: ProjectStatus): string {
  const { timing: _timing, lanesRunning: _running, lanesScheduled: _scheduled, headline: _headline, kpi, ...rest } = status;
  // Owner 2026-09-29 (the benchmarks recording: a full card every hour on a
  // quiet project): with the at-a-glance update on, the hash is BOARD STATE
  // only. "Done in the last hour" (which carried "the supervisor checked in"
  // and "1 work session finished" every hour), the to-do doneSince count and
  // the window's failed-run / attention lines moved it EVERY hour; what moved
  // in the window is now the update's `changes`, which the sweep reads as the
  // other half of "changed".
  const stable = {
    ...rest,
    doneSince: [],
    blocked: (rest.blocked ?? []).filter((l) => !WINDOW_EVENT_LINE_RE.test(l)),
    todos: rest.todos ? { ...rest.todos, doneSince: 0 } : rest.todos,
  };
  // The KPI's identity (key / value / receipt / bar) is ledger state; its age
  // and the experiment counter are clocks (they move every hour by construction).
  // barDirection + the first history value are hashed too: kpiBarText/kpiBarMet
  // read them, so a direction-only re-declaration (the ticket c4ee677f
  // remediation) must re-render the card instead of folding into a quiet stub.
  const hashed = kpi ? {
    ...stable,
    kpiOfRecord: (() => {
      const h0 = kpi.history?.[0]?.value;
      return {
        goalId: kpi.goalId, key: kpi.key, value: kpi.value, unit: kpi.unit ?? null, bar: kpi.bar ?? null,
        barDirection: kpi.barDirection ?? null,
        firstHistoryValue: Number.isFinite(Number(h0)) ? Number(h0) : null,
        receiptId: kpi.receiptId ?? null,
      };
    })(),
  } : stable;
  return createHash('sha256').update(JSON.stringify(canonical(hashed))).digest('hex').slice(0, 32);
}

/** "HH:MMZ" of an ISO stamp ('?' when unparsable). */
function hhmmZ(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z` : '?';
}

// ── Timing (owner 2026-09-17: "what is going on / how much longer") ──────────
//
// Everything here is MEASURED by the harness from rows it already keeps —
// agent_runs (startedAt/heartbeatAt), coding_schedules (nextRunAt), the
// todos' own progress notes ("1668/1687", "5 of 12 steps", "63%") and the
// previous status card. The model never types an estimate: an ETA appears
// ONLY when the same lane reported a countable fraction on two consecutive
// cards and the count moved — then it is the plain rate extrapolation,
// labelled low-confidence. No countable step ⇒ the card says so instead.

export interface LaneProgress {
  done: number;
  total: number;
  /** What the count is of — the todo title the fraction came from (plain). */
  label: string;
  /** True when the same fraction was reported on the previous card ≥ 30 min ago and has not moved. */
  stalled?: boolean;
}
export interface LaneEta {
  minutes: number;
  basis: 'rate';
  confidence: 'low';
}
export interface LaneTiming {
  /** Lane chat id — the ETA rate matches lanes across cards by it (not rendered as text). */
  chatId: string;
  title: string;
  state: 'running' | 'scheduled';
  /** Age of the running run in whole minutes (as of the card). */
  runningForMin?: number;
  /** Minutes since the run's last heartbeat (as of the card). */
  lastActivityMin?: number;
  /** Earliest enabled schedule firing for the lane (ISO). */
  nextWakeAt?: string;
  progress?: LaneProgress;
  eta?: LaneEta;
  /** PRs the lane opened in the last 24 h, split by the receipt's docs-only flag (tt-rd audit 2026-09-27); state-only PRs (.digby/** only) are neither. */
  prs24h?: { docsOnly: number; code: number };
  /**
   * Premises registered in the last 24 h the lane can claim — set by the lane
   * itself (setByChatId) or on a goal whose todo it owns (fixer 2026-09-27,
   * finding docs-churn-log-3). Absent when zero.
   */
  premises24h?: number;
  /**
   * The ledger-keyed redirect signal: ≥ RECORD_KEEPER_MIN_DOCS_ONLY_PRS docs-only
   * PRs, no code PR and no premise registered in the window — the lane's
   * numbers never reached the register. Never a gate; a line the supervisor reads.
   */
  recordKeeper?: true;
}
export interface GoalProgress {
  id: string;
  title: string;
  status: string;
  done: number;
  total: number;
}
export interface ProjectTiming {
  /** Running lanes first (longest-running first), then scheduled lanes by next wake. */
  lanes: LaneTiming[];
  /** Active/blocked goals that have todos: done/total todos (≤ TIMING_MAX_GOALS). */
  goals: GoalProgress[];
  /** ISO stamps of the window's closures (todos done + work sessions finished), oldest first. */
  closures: string[];
  /** The supervisor's own next scheduled check (ISO), when it has one. */
  nextCheckAt?: string;
  /** When the next hourly card is due (ISO). */
  nextStatusAt: string;
  /** Present when no lane carries an estimate — says why, in owner words. */
  noEstimateReason?: string;
}

export const TIMING_MAX_LANES = 6;
export const TIMING_MAX_GOALS = 6;
export const TIMING_MAX_CLOSURES = 24;
/** An ETA needs two cards at least this far apart (rate noise below it). */
export const ETA_MIN_ELAPSED_MS = 10 * 60 * 1000;
/** A fraction that has not moved for this long reads as stalled. */
export const STALL_MIN_ELAPSED_MS = 30 * 60 * 1000;
/** Beyond a week the pace is too slow to call an estimate. */
export const ETA_MAX_MINUTES = 7 * 24 * 60;

const FRACTION_RE = /(?<![\w./:-])(\d{1,3}(?:,\d{3})+|\d+)\s*(\/|\s+of\s+)\s*(\d{1,3}(?:,\d{3})+|\d+)(?![\w/.:]|\s*(?:am|pm)\b)/gi;
const PERCENT_RE = /(?<![\w.<>≤≥~])(\d{1,3})(?:\.\d+)?\s*%(?!\w)/g;
const PROGRESS_WORD_RE = /\b(?:done|complete[d]?|finished|pass(?:ed|ing)?|ok|ready|through|progress|coverage|processed|scraped|indexed|uploaded|migrated|reviewed|graded|judged|labell?ed|annotated|trained|verif(?:ied|y)|steps?|items?|files?|tasks?|todos?|cases?|rows?|docs?|pages?|tests?|sweeps?|shards?|batches|batch|chunks?|records?)\b/i;
/** Comparison / tolerance idioms — "<3%", "loss ≤ 2%", "within 5%" are thresholds, not progress. */
const THRESHOLD_CUE_RE = /(?:<|>|≤|≥|under|below|above|over|within|max|min|threshold|tolerance|loss|drop|error|delta|diff|ci\b|margin)\s*$/i;
/**
 * Availability-probe idioms — "http=200 bytes=30727", "HTTP 200/30727 bytes", or
 * the slash-shorthand serve cell "alias box-side 200/30727" / "ALIAS_API=200/30727"
 * pair an HTTP status with a byte size: an endpoint availability check, never a
 * work counter (feedback 5a8093f0 — such a cell read as "200/30,727 (1%)" drove
 * a false owner escalation). Tested against the pair's OWN CLAUSE (see
 * parseProgressFraction), so the same word beside a real counter in another
 * clause is safe. The vocabulary boundary treats '_' as a separator so
 * underscore-joined names ("ALIAS_API", "CANONICAL_OK") still match.
 */
const PROBE_CONTEXT_RE = /(?:https?\s*=\s*\d|status\s*=\s*\d{3}\b|bytes?\s*=\s*\d|(?<![a-z0-9])(?:https?|status|bytes?|probe[sd]?|healthchecks?|ping|vantage|availability|latency|alias|canon(?:ical)?|box[- ]side|serve[rd]?|serving|endpoint)(?![a-z0-9]))/i;
/**
 * Countable nouns and completion verbs — progress context strong enough to
 * override probe vocabulary inside the pair's own clause ("canonical citator:
 * 294/665 cases verified" is progress; "alias box-side 200/30727 ok" is not —
 * "ok"/"ready" are probe verdicts, not counters).
 */
const STRONG_PROGRESS_WORD_RE = /\b(?:done|complete[d]?|finished|pass(?:ed|ing)?|through|progress|coverage|processed|scraped|indexed|uploaded|migrated|reviewed|graded|judged|labell?ed|annotated|trained|verif(?:ied|y)|steps?|items?|files?|tasks?|todos?|cases?|rows?|docs?|pages?|tests?|sweeps?|shards?|batches|batch|chunks?|records?)\b/i;
/**
 * Cell delimiters: probe vocabulary binds only within the pair's own clause.
 * ", " (comma-space) delimits KV cells ("…, canonical 200/8547 8 models, …");
 * a bare comma never does — thousands separators ("1,424") and the no-space
 * list idiom ("1668/1687,191/219 DONE") stay inside their cell.
 */
const CLAUSE_BREAKS = [';', '|', '•', '·', '\n', '—', ', '];

/**
 * The most informative countable fraction in a lane's own text: "1668/1687"
 * beats "191/219" (larger total); "5 of 12 steps" counts too; "63% through"
 * counts as done/100. Guards (first live cards 2026-09-17; global fraction
 * guard 2026-09-22, feedback 5a8093f0): EVERY fraction needs an explicit
 * progress word within 24 chars — a bare pair is a date ("9/17"), a ratio
 * ("2/4 by volume"), or a probe cell ("200/30727"), never a count. A pair in
 * an availability-probe clause (PROBE_CONTEXT_RE, delimited by ; | • · — or
 * newline) is skipped unless the same clause also carries a strong progress
 * word ("294/665 cases verified" next to a "canonical" label still counts;
 * "alias box-side 200/30727 ok" does not). A percentage needs a progress word
 * within 24 chars AND must not sit in a threshold idiom ("quality loss <3%").
 * Pure; null when nothing counts.
 */
export function parseProgressFraction(text: unknown): { done: number; total: number } | null {
  const s = String(text ?? '');
  if (!s) return null;
  let best: { done: number; total: number } | null = null;
  FRACTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FRACTION_RE.exec(s))) {
    const done = Number(m[1].replace(/,/g, ''));
    const total = Number(m[3].replace(/,/g, ''));
    if (!Number.isFinite(done) || !Number.isFinite(total) || total < 2 || done > total) continue;
    const before = s.slice(Math.max(0, m.index - 24), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 24);
    const around = before + m[0] + after;
    // The pair's own clause — the ±24 window truncated at cell delimiters
    // (", " is a 2-char break — slice past the delimiter, not just one char).
    let cellStart = 0;
    for (const d of CLAUSE_BREAKS) {
      const i = before.lastIndexOf(d);
      if (i !== -1 && i + d.length > cellStart) cellStart = i + d.length;
    }
    const cellBefore = before.slice(cellStart);
    let cellAfterLen = after.length;
    for (const d of CLAUSE_BREAKS) {
      const i = after.indexOf(d);
      if (i !== -1 && i < cellAfterLen) cellAfterLen = i;
    }
    const cell = cellBefore + m[0] + after.slice(0, cellAfterLen);
    // An availability probe's status/byte pair is never a counter (feedback
    // 5a8093f0) — probe vocabulary in the pair's OWN clause disqualifies it
    // unless the clause also carries a strong progress word ("canonical
    // citator: 294/665 cases verified" counts; "alias 200/30727 ok" does not).
    if (PROBE_CONTEXT_RE.test(cell) && !STRONG_PROGRESS_WORD_RE.test(cell)) continue;
    // A fraction counts only beside an explicit progress word — "1668/1687 rows
    // done". A bare pair ("9/17", "2/4 by volume", "200/30727") is a date, a
    // ratio, or a probe cell — not progress.
    if (!PROGRESS_WORD_RE.test(around)) continue;
    if (!best || total > best.total) best = { done, total };
  }
  if (best) return best;
  PERCENT_RE.lastIndex = 0;
  let p: RegExpExecArray | null;
  while ((p = PERCENT_RE.exec(s))) {
    const pct = Number(p[1]);
    if (!(pct >= 0 && pct <= 100)) continue;
    const before = s.slice(Math.max(0, p.index - 24), p.index);
    if (THRESHOLD_CUE_RE.test(before)) continue; // "<3%", "loss ≤ 2%" — a bar, not a count
    const around = s.slice(Math.max(0, p.index - 24), p.index + p[0].length + 24);
    if (!PROGRESS_WORD_RE.test(around)) continue;
    return { done: pct, total: 100 };
  }
  return null;
}

/**
 * Rate-based estimate from two consecutive cards of the same lane. Pure.
 *   - no previous fraction, a different total, or < ETA_MIN_ELAPSED_MS apart → nothing
 *   - the count moved → minutes = remaining / (delta per minute), capped
 *   - the count did not move for ≥ STALL_MIN_ELAPSED_MS → stalled
 */
export function estimateLaneEta(
  cur: { done: number; total: number },
  prev: { done: number; total: number } | null | undefined,
  elapsedMs: number,
): { eta?: LaneEta; stalled?: boolean } {
  if (!prev || prev.total !== cur.total || !(elapsedMs >= ETA_MIN_ELAPSED_MS)) return {};
  const delta = cur.done - prev.done;
  if (delta <= 0) return elapsedMs >= STALL_MIN_ELAPSED_MS ? { stalled: true } : {};
  const remaining = cur.total - cur.done;
  if (remaining <= 0) return { eta: { minutes: 0, basis: 'rate', confidence: 'low' } };
  const perMin = delta / (elapsedMs / 60_000);
  const minutes = Math.ceil(remaining / perMin);
  if (minutes > ETA_MAX_MINUTES) return {};
  return { eta: { minutes, basis: 'rate', confidence: 'low' } };
}

/** Whole minutes between two instants (≥ 0). */
function minutesBetween(from: Date | string | null | undefined, to: Date): number | undefined {
  if (!from) return undefined;
  const ms = to.getTime() - new Date(from).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60_000)) : undefined;
}

export interface TimingInputs {
  now: Date;
  since: Date;
  laneChats: Array<{ id: string; title?: string | null }>;
  runningRuns: Array<{ sessionId: string; startedAt?: Date | null; heartbeatAt?: Date | null; createdAt?: Date | null; updatedAt?: Date | null }>;
  schedules: Array<{ sessionId: string; nextRunAt: Date | string }>;
  supervisorSchedules: Array<{ nextRunAt: Date | string }>;
  /** Goals with their registered premises (premise-register.ts GoalPremise[] — read for setAt / setByChatId only). */
  goals: Array<{ id: string; title: string; status: string; premises?: unknown }>;
  todos: Array<{ id: string; goalId?: string | null; title: string; status: string; progressNote?: string | null; assigneeChatId?: string | null; updatedAt?: Date | null }>;
  runCompletedAt: Array<Date | string>;
  prev?: { generatedAt?: string | null; timing?: ProjectTiming | null } | null;
  /** ok open_pull_request receipts of the lanes in the last 24 h (chatId + the receipt's filesOnlyMd / filesOnlyState flags). */
  prReceipts?: Array<{ sessionId: string; filesOnlyMd: boolean; filesOnlyState?: boolean }>;
}

/** Docs-only PRs in the window before a code-less, premise-less lane reads as a record-keeper. */
export const RECORD_KEEPER_MIN_DOCS_ONLY_PRS = 2;
/** The premise-delta window (matches the PR window). */
const PREMISE_DELTA_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Derive the timing block from ledger rows. Pure (clock = inputs.now). */
export function deriveProjectTiming(inputs: TimingInputs): ProjectTiming {
  const { now } = inputs;
  const nowMs = now.getTime();
  const titleOf = new Map(inputs.laneChats.map((c) => [c.id, plain(c.title ?? '', 40) || 'Untitled lane']));
  const laneSet = new Set(inputs.laneChats.map((c) => c.id));

  // Previous card: fraction per lane, and how long ago it was generated.
  const prevAt = inputs.prev?.generatedAt ? new Date(inputs.prev.generatedAt).getTime() : NaN;
  const elapsedMs = Number.isFinite(prevAt) ? nowMs - prevAt : 0;
  const prevProgress = new Map<string, { done: number; total: number }>();
  for (const l of inputs.prev?.timing?.lanes ?? []) if (l.progress) prevProgress.set(l.chatId, { done: l.progress.done, total: l.progress.total });

  // Countable progress per lane from ITS in-progress todos (note first, then title).
  const progressByLane = new Map<string, LaneProgress>();
  for (const t of inputs.todos) {
    if (t.status !== 'in_progress' || !t.assigneeChatId || !laneSet.has(t.assigneeChatId)) continue;
    // a8d6e514: the fraction is read from the note's LEAD — a 2,000-char ledger tail never feeds the card a stale count.
    const frac = parseProgressFraction(progressNoteLead(t.progressNote)) ?? parseProgressFraction(t.title);
    if (!frac) continue;
    const cur = progressByLane.get(t.assigneeChatId);
    if (!cur || frac.total > cur.total) progressByLane.set(t.assigneeChatId, { ...frac, label: plain(t.title, 48) });
  }

  // Running lanes (oldest run first), then scheduled lanes by next wake.
  const runByLane = new Map<string, TimingInputs['runningRuns'][number]>();
  for (const r of inputs.runningRuns) {
    if (!laneSet.has(r.sessionId)) continue;
    const cur = runByLane.get(r.sessionId);
    const start = (x: typeof r) => new Date(x.startedAt ?? x.createdAt ?? now).getTime();
    if (!cur || start(r) < start(cur)) runByLane.set(r.sessionId, r);
  }
  const nextWakeByLane = new Map<string, number>();
  for (const s of inputs.schedules) {
    if (!laneSet.has(s.sessionId)) continue;
    const at = new Date(s.nextRunAt).getTime();
    if (!Number.isFinite(at)) continue;
    const cur = nextWakeByLane.get(s.sessionId);
    if (cur === undefined || at < cur) nextWakeByLane.set(s.sessionId, at);
  }

  // PRs per lane in the window (docs-only vs code) — from the open_pull_request
  // receipts' filesOnlyMd flag; a lane whose day is all docs-only PRs is a
  // record-keeper, not movement (tt-rd audit 2026-09-27).
  const prsByLane = new Map<string, { docsOnly: number; code: number }>();
  for (const r of inputs.prReceipts ?? []) {
    if (!laneSet.has(r.sessionId)) continue;
    // A state-only PR (.digby/** only) is harness bookkeeping — neither a record nor movement.
    if (r.filesOnlyState === true) continue;
    const cur = prsByLane.get(r.sessionId) ?? { docsOnly: 0, code: 0 };
    if (r.filesOnlyMd) cur.docsOnly += 1; else cur.code += 1;
    prsByLane.set(r.sessionId, cur);
  }

  // Premise deltas per lane in the window (fixer 2026-09-27, finding
  // docs-churn-log-3): movement for a results lane is a NUMBER reaching the
  // register, not a PR — so the redirect signal is keyed on the ledger, never
  // on the PR shape a compliant results lane produces by design. A premise
  // counts for a lane when the lane set it (setByChatId) or when it was set
  // on a goal whose todo the lane owns (a supervisor registering on the lane's
  // behalf). setAt is stamped by normalizePremise on every set.
  const premisesByLane = new Map<string, number>();
  const lanesByGoal = new Map<string, Set<string>>();
  for (const t of inputs.todos) {
    if (!t.goalId || !t.assigneeChatId || !laneSet.has(t.assigneeChatId)) continue;
    const set = lanesByGoal.get(t.goalId) ?? new Set<string>();
    set.add(t.assigneeChatId);
    lanesByGoal.set(t.goalId, set);
  }
  const windowStart = nowMs - PREMISE_DELTA_WINDOW_MS;
  for (const g of inputs.goals) {
    if (!Array.isArray(g.premises)) continue;
    for (const p of g.premises as unknown[]) {
      if (!p || typeof p !== 'object') continue;
      const setAt = new Date(String((p as { setAt?: unknown }).setAt ?? '')).getTime();
      if (!Number.isFinite(setAt) || setAt < windowStart || setAt > nowMs) continue;
      const credited = new Set<string>(lanesByGoal.get(g.id) ?? []);
      const by = (p as { setByChatId?: unknown }).setByChatId;
      if (typeof by === 'string' && laneSet.has(by)) credited.add(by);
      for (const lane of credited) premisesByLane.set(lane, (premisesByLane.get(lane) ?? 0) + 1);
    }
  }

  const lanes: LaneTiming[] = [];
  const decorate = (lane: LaneTiming) => {
    const progress = progressByLane.get(lane.chatId);
    if (progress) {
      const est = estimateLaneEta(progress, prevProgress.get(lane.chatId), elapsedMs);
      lane.progress = est.stalled ? { ...progress, stalled: true } : progress;
      if (est.eta) lane.eta = est.eta;
    }
    const prs = prsByLane.get(lane.chatId);
    if (prs) lane.prs24h = prs;
    const premises = premisesByLane.get(lane.chatId);
    if (premises) lane.premises24h = premises;
    if (prs && prs.code === 0 && prs.docsOnly >= RECORD_KEEPER_MIN_DOCS_ONLY_PRS && !premises) lane.recordKeeper = true;
    const wake = nextWakeByLane.get(lane.chatId);
    if (wake !== undefined && lane.state === 'scheduled') lane.nextWakeAt = new Date(wake).toISOString();
    return lane;
  };
  const running = [...runByLane.entries()]
    .map(([chatId, r]) => ({ chatId, startMs: new Date(r.startedAt ?? r.createdAt ?? now).getTime(), beat: r.heartbeatAt ?? r.updatedAt ?? null }))
    .sort((a, b) => a.startMs - b.startMs);
  for (const r of running) {
    lanes.push(decorate({
      chatId: r.chatId,
      title: titleOf.get(r.chatId) ?? 'Untitled lane',
      state: 'running',
      runningForMin: Math.max(0, Math.floor((nowMs - r.startMs) / 60_000)),
      ...(minutesBetween(r.beat, now) !== undefined ? { lastActivityMin: minutesBetween(r.beat, now) } : {}),
    }));
  }
  const scheduledOnly = [...nextWakeByLane.entries()].filter(([id]) => !runByLane.has(id)).sort((a, b) => a[1] - b[1]);
  for (const [chatId] of scheduledOnly) {
    lanes.push(decorate({ chatId, title: titleOf.get(chatId) ?? 'Untitled lane', state: 'scheduled' }));
  }
  const lanesOut = lanes.slice(0, TIMING_MAX_LANES);

  // Goals: done/total todos for active + blocked goals that have any.
  const goalsOut: GoalProgress[] = [];
  for (const g of inputs.goals) {
    if (g.status !== 'active' && g.status !== 'blocked') continue;
    const mine = inputs.todos.filter((t) => t.goalId === g.id && t.status !== 'dropped' && t.status !== 'archived');
    if (!mine.length) continue;
    goalsOut.push({ id: g.id, title: plain(g.title, 48), status: g.status, done: mine.filter((t) => t.status === 'done').length, total: mine.length });
    if (goalsOut.length >= TIMING_MAX_GOALS) break;
  }

  // Closures in the window: todos finished + work sessions finished.
  const sinceMs = inputs.since.getTime();
  const closures = [
    ...inputs.todos.filter((t) => t.status === 'done' && t.updatedAt && t.updatedAt.getTime() >= sinceMs).map((t) => t.updatedAt!.getTime()),
    ...inputs.runCompletedAt.map((d) => new Date(d).getTime()).filter((ms) => Number.isFinite(ms) && ms >= sinceMs),
  ].sort((a, b) => a - b).slice(-TIMING_MAX_CLOSURES).map((ms) => new Date(ms).toISOString());

  const supNext = inputs.supervisorSchedules.map((s) => new Date(s.nextRunAt).getTime()).filter((ms) => Number.isFinite(ms)).sort((a, b) => a - b)[0];

  const timing: ProjectTiming = {
    lanes: lanesOut,
    goals: goalsOut,
    closures,
    ...(supNext !== undefined ? { nextCheckAt: new Date(supNext).toISOString() } : {}),
    nextStatusAt: new Date(nowMs + PROJECT_STATUS_INTERVAL_MS).toISOString(),
  };
  if (!lanesOut.some((l) => l.eta)) {
    const withProgress = lanesOut.filter((l) => l.progress);
    if (!withProgress.length) {
      // "no lane has reported a countable step" is only true of a lane that
      // is RUNNING (owner 2026-09-24: it read as work in flight while every
      // lane was merely scheduled) — scheduled-only names the next wake.
      const nextWake = lanesOut.filter((l) => l.state === 'scheduled' && l.nextWakeAt).map((l) => l.nextWakeAt!).sort()[0];
      timing.noEstimateReason = lanesOut.some((l) => l.state === 'running')
        ? 'No estimate yet — no lane has reported a countable step.'
        : nextWake
          ? `Nothing is running right now — next wake ${hhmmZ(nextWake)}.`
          : 'No estimate — nothing is running right now.';
    } else if (withProgress.some((l) => l.progress?.stalled)) {
      timing.noEstimateReason = 'No estimate — the reported counts have not moved since the last update.';
    } else {
      timing.noEstimateReason = 'Estimates appear once a lane has reported progress on two consecutive updates.';
    }
  }
  return timing;
}

/**
 * Timing for one project from the live ledger — the same rows the status card
 * uses, for callers outside the card (the supervisor's board digest). Never
 * throws; null on any failure.
 */
export async function computeProjectTiming(projectId: string, now: Date = new Date()): Promise<ProjectTiming | null> {
  try {
    const chats = (await prisma.crossModelChat.findMany({
      where: { projectId },
      select: { id: true, title: true, isProjectSupervisor: true, archivedAt: true },
    })) as Array<{ id: string; title: string | null; isProjectSupervisor: boolean; archivedAt: Date | null }>;
    const supervisor = chats.find((c) => c.isProjectSupervisor === true) ?? null;
    const laneChats = chats.filter((c) => c.isProjectSupervisor !== true && c.archivedAt == null);
    const laneIds = laneChats.map((c) => c.id);
    const scheduleIds = supervisor ? [...laneIds, supervisor.id] : laneIds;
    const [runningRuns, schedules, goals, todos, prevRow, prRows] = await Promise.all([
      laneIds.length ? prisma.agentRun.findMany({ where: { sessionId: { in: laneIds }, status: 'running' }, select: { sessionId: true, startedAt: true, heartbeatAt: true, createdAt: true, updatedAt: true } }) : [],
      scheduleIds.length ? prisma.codingSchedule.findMany({ where: { sessionId: { in: scheduleIds }, enabled: true }, select: { sessionId: true, nextRunAt: true } }) : [],
      // Goals WITH their premises (the premise-delta bit); a pre-migration
      // schema without the column falls back to the plain select (the
      // board-digest pattern). Wrapped so a sync-throwing mock still falls back.
      Promise.resolve()
        .then(() => prisma.projectGoal.findMany({ where: { projectId }, select: { id: true, title: true, status: true, premises: true }, orderBy: { createdAt: 'asc' } }))
        .catch(() => prisma.projectGoal.findMany({ where: { projectId }, select: { id: true, title: true, status: true }, orderBy: { createdAt: 'asc' } })),
      prisma.projectTodo.findMany({ where: { projectId }, select: { id: true, goalId: true, title: true, status: true, progressNote: true, assigneeChatId: true, updatedAt: true } }),
      supervisor ? latestStatusRow(supervisor.id) : Promise.resolve(null),
      // Lane PR receipts, last 24 h (docs-only vs code) — best-effort, [] on any failure.
      (async (): Promise<Array<{ chatId: string; ids: unknown }>> => {
        if (!laneIds.length) return [];
        try {
          return await prisma.runToolReceipt.findMany({
            where: { chatId: { in: laneIds }, tool: 'open_pull_request', ok: true, createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
            select: { chatId: true, ids: true },
            take: 500,
          });
        } catch { return []; }
      })(),
    ]);
    const sched = schedules as Array<{ sessionId: string; nextRunAt: Date }>;
    const since = prevRow ? prevRow.createdAt : new Date(now.getTime() - PROJECT_STATUS_INTERVAL_MS);
    return deriveProjectTiming({
      now,
      since,
      laneChats,
      runningRuns: runningRuns as any,
      schedules: sched.filter((s) => s.sessionId !== supervisor?.id),
      supervisorSchedules: supervisor ? sched.filter((s) => s.sessionId === supervisor.id) : [],
      goals: goals as any,
      todos: todos as any,
      runCompletedAt: [],
      prev: prevRow ? { generatedAt: prevRow.metadata?.generatedAt, timing: prevRow.metadata?.status?.timing ?? null } : null,
      prReceipts: (prRows as Array<{ chatId: string; ids: unknown }>).map((r) => ({
        sessionId: r.chatId,
        filesOnlyMd: !!(r.ids && typeof r.ids === 'object' && (r.ids as any).filesOnlyMd === true),
        filesOnlyState: !!(r.ids && typeof r.ids === 'object' && (r.ids as any).filesOnlyState === true),
      })),
    });
  } catch (err: any) {
    logger.warn(`project-status: timing compute failed for ${String(projectId).slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
    return null;
  }
}

/** Short owner-facing lines for the supervisor's context block (no ids beyond id8). */
export function renderTimingLines(timing: ProjectTiming, now: Date): string[] {
  const hhmmz = hhmmZ;
  const inMin = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - now.getTime()) / 60_000));
  const pct = (p: { done: number; total: number }) => (p.total > 0 ? Math.round((p.done / p.total) * 100) : 0);
  const lines: string[] = [];
  for (const l of timing.lanes) {
    const bits: string[] = [];
    if (l.state === 'running') {
      bits.push(`running ${l.runningForMin ?? 0}m`);
      if (l.lastActivityMin !== undefined) bits.push(`last activity ${l.lastActivityMin}m ago`);
    } else if (l.nextWakeAt) {
      bits.push(`next wake ${hhmmz(l.nextWakeAt)} (in ${inMin(l.nextWakeAt)}m)`);
    } else {
      bits.push('scheduled');
    }
    if (l.progress) bits.push(`progress ${l.progress.done}/${l.progress.total} (${pct(l.progress)}%) on "${l.progress.label}"${l.progress.stalled ? ' — NOT MOVING since the last card' : ''}`);
    if (l.eta) bits.push(l.eta.minutes === 0 ? 'count complete' : `≈${l.eta.minutes} min at this pace (low confidence, harness-measured)`);
    if (l.prs24h) bits.push(`PRs 24h: ${l.prs24h.docsOnly} docs-only / ${l.prs24h.code} code`);
    if (l.premises24h) bits.push(`premises registered 24h: ${l.premises24h}`);
    if (l.recordKeeper) bits.push('RECORD-KEEPER: docs-only PRs only and no premise registered in 24h — its numbers never reached the register (steer to goal_premise_set; FINISHED-test candidate only if this persists across wakes)');
    lines.push(`- lane ${l.chatId.slice(0, 8)} "${l.title}": ${bits.join(' · ')}`);
  }
  for (const g of timing.goals) lines.push(`- goal ${g.id.slice(0, 8)} "${g.title}": ${g.done}/${g.total} todos done`);
  const tail: string[] = [];
  if (timing.nextCheckAt) tail.push(`supervisor next check ${hhmmz(timing.nextCheckAt)} (in ${inMin(timing.nextCheckAt)}m)`);
  tail.push(`next status card ~${hhmmz(timing.nextStatusAt)}`);
  if (timing.closures.length) tail.push(`${timing.closures.length} closure${timing.closures.length === 1 ? '' : 's'} in the window`);
  lines.push(`- ${tail.join(' · ')}`);
  if (timing.noEstimateReason) lines.push(`- ${timing.noEstimateReason}`);
  return lines;
}

export function plural(n: number, noun: string, pluralNoun: string = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : pluralNoun}`;
}

/** sha256/32 of the canonical JSON of ANY status object (the no-change gate). */
export function hashStatusObject(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 32);
}

/**
 * ONE sentence on where the project stands vs its goals.
 *   "CanLaw: 2 of 3 goals active, 1 blocked on the SoR rebuild; 2 lanes working"
 *   "CanLaw: all 8 goals done; 3 lanes scheduled, none running"
 * "working" counts RUNNING lanes only (2026-09-24); scheduled-but-idle lanes
 * are named separately so the owner is never told work is in flight when it
 * is merely booked.
 */
export function buildHeadline(input: {
  projectName: string;
  goals: { active: number; done: number; blocked: number };
  blockedGoalTitle?: string | null;
  lanesRunning: number;
  lanesScheduled?: number;
  ownerItems: number;
}): string {
  const { goals, lanesRunning, ownerItems } = input;
  const lanesScheduled = input.lanesScheduled ?? 0;
  const total = goals.active + goals.done + goals.blocked;
  let goalsPart: string;
  if (total === 0) goalsPart = 'no goals set yet';
  else if (goals.done === total) goalsPart = `all ${plural(total, 'goal')} done`;
  else {
    goalsPart = `${goals.active} of ${plural(total, 'goal')} active`;
    if (goals.blocked === 1 && input.blockedGoalTitle) goalsPart += `, 1 blocked on ${plain(input.blockedGoalTitle, 50)}`;
    else if (goals.blocked > 0) goalsPart += `, ${goals.blocked} blocked`;
    if (goals.done > 0) goalsPart += `, ${goals.done} done`;
  }
  const lanesPart = lanesRunning > 0
    ? `${plural(lanesRunning, 'lane')} working${lanesScheduled > 0 ? `, ${lanesScheduled} scheduled` : ''}`
    : lanesScheduled > 0
      ? `${plural(lanesScheduled, 'lane')} scheduled, none running`
      : 'no lanes working right now';
  const ownerPart = ownerItems > 0 ? `; ${plural(ownerItems, 'item')} waiting on you` : '';
  return `${plain(input.projectName, 60)}: ${goalsPart}; ${lanesPart}${ownerPart}`;
}

/** Section renderer: bullets capped at `max`, then one "+N more" line. */
export function renderSection(title: string, items: string[], max: number): string {
  if (items.length === 0) return '';
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  const lines = shown.map((i) => `- ${i}`);
  if (rest > 0) lines.push(`- …and ${plural(rest, 'more item')}`);
  return `**${title}**\n${lines.join('\n')}`;
}

/**
 * Markdown body: headline line, then the four short sections (empty sections
 * are omitted). Deterministic fit: items per section shrink 4→3→2→1 until the
 * body is within PROJECT_STATUS_BODY_MAX_CHARS; a body that still overflows is
 * hard-clipped. Exported for tests.
 */
/** The card's KPI age clock: setAt + ageMin when the compute stamped one (deterministic for tests), else now. */
function kpiNow(status: ProjectStatus): Date {
  const k = status.kpi;
  if (k?.setAt && Number.isFinite(Number(k.ageMin))) return new Date(new Date(k.setAt).getTime() + Number(k.ageMin) * 60_000);
  return new Date();
}

export function buildStatusBody(status: ProjectStatus): string {
  const sectionsEmpty = status.workingOn.length + status.doneSince.length + status.blocked.length + status.next.length === 0;
  const compose = (max: number): string => {
    const parts = [
      `**${status.headline}**`,
      // KPI of record (finding 4): the harness composes the number the owner
      // reads — key, value, receipt, age, bar, and the experiments-without-
      // adoption counter — so no model-typed rate is ever the card's KPI.
      status.kpi ? renderSection('KPI of record', [renderKpiCardLine({ ...status.kpi, ...(status.kpi.setAt ? { setAt: status.kpi.setAt } : {}) }, kpiNow(status))], 1) : '',
      renderSection('Working on', status.workingOn, max),
      renderSection('Done in the last hour', status.doneSince, max),
      // "needs you" is claimed ONLY when an owner question is actually open —
      // a section of machine blocks under that title told the owner the
      // project was waiting on him (2026-09-15).
      renderSection(status.ownerItems > 0 ? 'Blocked or needs you' : 'Blocked', status.blocked, max),
      renderSection('Next', status.next, max),
    ].filter(Boolean);
    if (sectionsEmpty) parts.push('Nothing is in motion right now.');
    return parts.join('\n\n');
  };
  for (let max = PROJECT_STATUS_MAX_ITEMS; max >= 1; max--) {
    const body = compose(max);
    if (Array.from(body).length <= PROJECT_STATUS_BODY_MAX_CHARS) return body;
  }
  return clipText(compose(1), PROJECT_STATUS_BODY_MAX_CHARS);
}

/** A quiet streak this long is read as a duration ("no change for 22 hours"),
 *  not a clock ("since 08:21Z") — a bare HH:MMZ a day later names the wrong
 *  day (review C5, 2026-09-24). */
export const QUIET_DURATION_MIN_MS = 20 * 60 * 60 * 1000;

/** "22 hours" / "3 days" (whole units; days from 48 h). Pure. Exported for tests. */
export function quietDurationPhrase(ms: number): string {
  const hours = Math.max(0, Math.floor(ms / 3_600_000));
  if (hours >= 48) return plural(Math.floor(hours / 24), 'day');
  return plural(hours, 'hour');
}

/** The hourly "nothing changed" stub: counts kept, sections emptied. With
 *  `quietSince` (ISO of the last real card, 2026-09-24) the headline names the
 *  streak's start — "no change since 08:21Z" — instead of "in the last hour",
 *  which read as fresh news on every one of eight identical overnight cards;
 *  once the streak is ≥ QUIET_DURATION_MIN_MS (needs `now`) it reads as a
 *  duration — "no change for 3 days" (review C5). The owner-question signal
 *  survives the stub: "; N item(s) waiting on you" stays on the headline when
 *  owner questions are open (review C12 — the compact card renders no
 *  sections). The "no change" phrase is load-bearing for downstream
 *  classifiers. */
export function noChangeStatus(status: ProjectStatus, quietSince?: string | null, now?: Date | null): ProjectStatus {
  const sinceMs = quietSince ? new Date(quietSince).getTime() : NaN;
  const nowMs = now ? now.getTime() : NaN;
  let phrase = 'in the last hour';
  if (Number.isFinite(sinceMs)) {
    phrase = Number.isFinite(nowMs) && nowMs - sinceMs >= QUIET_DURATION_MIN_MS
      ? `for ${quietDurationPhrase(nowMs - sinceMs)}`
      : `since ${hhmmZ(quietSince!)}`;
  }
  const ownerPart = status.ownerItems > 0 ? `; ${plural(status.ownerItems, 'item')} waiting on you` : '';
  return {
    ...status,
    headline: `${plain(status.projectName, 60)}: no change ${phrase}${ownerPart}`,
    workingOn: [],
    doneSince: [],
    blocked: [],
    next: [],
  };
}

/**
 * The supervisor's latest wake note, first line only, when it opens with a
 * mandated marker. Returns a plain-language line for the "Done" section or
 * null when the note is markerless (a narration we never paraphrase).
 * Exported for tests.
 */
export function supervisorCheckInLine(content: unknown): string | null {
  const lines = String(content ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const first = lines[0].replace(/^[*_#>\s-]+/, '');
  if (NOOP_MARKER_RE.test(first)) return 'The project supervisor checked in and found nothing that needed a hand.';
  // fixer 2026-09-27 (finding upward-chatter-4): the third close shape —
  // a goal moved and the supervisor reported it up without a lane action.
  if (REPORTED_MARKER_RE.test(first)) return 'The project supervisor checked in and reported progress up to the Fleet Supervisor.';
  // HARNESS-RECEIPTS (review fix 2026-10-20): a note whose model words were only its ACTIONS TAKEN block now
  // OPENS with the harness record — tool names and 8-char ids, plumbing the owner's plain-language card never
  // paraphrases: count the executed calls instead.
  if (first.startsWith(HARNESS_ACTIONS_HEADER)) {
    const n = harnessActionLineCount(lines.join('\n'));
    return n > 0 ? `The project supervisor took ${plural(n, 'action')} on its last check.` : 'The project supervisor took action on its last check.';
  }
  if (ACTIONS_MARKER_RE.test(first)) {
    const actions = lines.slice(1, 3)
      .map((l) => plain(l.replace(/^[-*\d.)\s]+/, ''), 70))
      .filter((l) => l.length > 2);
    return actions.length
      ? `The project supervisor stepped in: ${actions.join('; ')}.`
      : 'The project supervisor took action on its last check.';
  }
  return null;
}

// ── Renderer ─────────────────────────────────────────────────────────────────

interface GoalRow { id: string; title: string; status: string; progressNote: string | null; blockedReason: string | null; blockKind?: string | null; gateQuestionId?: string | null; updatedAt: Date; createdAt?: Date | null; blockedAt?: Date | null; premises?: unknown }
interface TodoRow { id: string; goalId?: string | null; title: string; status: string; progressNote: string | null; blockedReason: string | null; blockKind?: string | null; gateQuestionId?: string | null; assigneeChatId?: string | null; updatedAt: Date; createdAt?: Date | null; blockedAt?: Date | null }

/**
 * Render the status of ONE project over the window [since, now]. Reads the
 * ledger, derives the structured status, and renders the body. Returns null
 * when the project does not exist. Deterministic for a fixed DB state.
 */
export async function renderProjectStatus(
  projectId: string,
  since: Date,
  opts: {
    now?: Date;
    /** The previous card (generatedAt + its timing) — the ETA rate source;
     *  its update's progress is the "Progress: a → b" delta source. */
    prev?: { generatedAt?: string | null; timing?: ProjectTiming | null; update?: { progress?: { done: number; total: number } } | null } | null;
  } = {},
): Promise<RenderedProjectStatus | null> {
  const now = opts.now ?? new Date();
  const project = await prisma.crossModelProject.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, userId: true },
  });
  if (!project) return null;

  const chats: Array<{ id: string; title?: string | null; isProjectSupervisor: boolean; archivedAt: Date | null; createdAt?: Date | null }> =
    (await prisma.crossModelChat.findMany({
      where: { projectId },
      select: { id: true, title: true, isProjectSupervisor: true, archivedAt: true, createdAt: true },
    })) as any;
  const supervisorChat = chats.find((c) => c.isProjectSupervisor === true) ?? null;
  const laneChatIds = chats.filter((c) => c.isProjectSupervisor !== true && c.archivedAt == null).map((c) => c.id);
  const allChatIds = chats.map((c) => c.id);

  const [goals, todos] = await Promise.all([
    prisma.projectGoal.findMany({
      where: { projectId },
      select: { id: true, title: true, status: true, progressNote: true, blockedReason: true, blockKind: true, gateQuestionId: true, updatedAt: true, createdAt: true, blockedAt: true, premises: true },
      orderBy: { createdAt: 'asc' },
    }) as Promise<GoalRow[]>,
    prisma.projectTodo.findMany({
      where: { projectId },
      select: { id: true, goalId: true, title: true, status: true, progressNote: true, blockedReason: true, blockKind: true, gateQuestionId: true, assigneeChatId: true, updatedAt: true, createdAt: true, blockedAt: true },
      orderBy: { createdAt: 'asc' },
    }) as Promise<TodoRow[]>,
  ]);

  // Lanes working (2026-09-24 split): `runningLaneIds` = distinct lane chats
  // with a RUNNING agent run; `scheduledLaneIds` = lane chats with an ENABLED
  // schedule and no running run (idle until their next wake). The supervisor's
  // own sweep schedule is excluded — it is not a worker lane; it is read
  // separately as the "next check" for the timing block.
  const runningLaneIds = new Set<string>();
  const scheduledLaneIds = new Set<string>();
  let runningRuns: TimingInputs['runningRuns'] = [];
  let laneSchedules: TimingInputs['schedules'] = [];
  let supervisorSchedules: TimingInputs['supervisorSchedules'] = [];
  {
    const scheduleIds = supervisorChat ? [...laneChatIds, supervisorChat.id] : laneChatIds;
    const [running, scheduled] = await Promise.all([
      laneChatIds.length
        ? prisma.agentRun.findMany({ where: { sessionId: { in: laneChatIds }, status: 'running' }, select: { sessionId: true, startedAt: true, heartbeatAt: true, createdAt: true, updatedAt: true } })
        : Promise.resolve([]),
      scheduleIds.length
        ? prisma.codingSchedule.findMany({ where: { sessionId: { in: scheduleIds }, enabled: true }, select: { sessionId: true, nextRunAt: true } })
        : Promise.resolve([]),
    ]);
    runningRuns = running as any;
    for (const r of running as Array<{ sessionId: string }>) runningLaneIds.add(r.sessionId);
    for (const s of scheduled as Array<{ sessionId: string; nextRunAt?: Date }>) {
      if (supervisorChat && s.sessionId === supervisorChat.id) {
        if (s.nextRunAt) supervisorSchedules.push({ nextRunAt: s.nextRunAt });
        continue;
      }
      if (!laneChatIds.includes(s.sessionId)) continue; // a partial mock may hand back foreign rows
      if (!runningLaneIds.has(s.sessionId)) scheduledLaneIds.add(s.sessionId);
      if (s.nextRunAt) laneSchedules.push({ sessionId: s.sessionId, nextRunAt: s.nextRunAt });
    }
  }
  const lanesRunning = runningLaneIds.size;
  const lanesScheduled = scheduledLaneIds.size;

  // Window events on the project-scope hook (sourceChatId NULL + projectId).
  const eventCounts: Record<string, number> = {};
  const runCompletedAt: Date[] = [];
  if (supervisorChat) {
    const hook = await prisma.eventHook.findFirst({
      where: { targetChatId: supervisorChat.id, projectId, sourceChatId: null },
      select: { id: true },
    });
    if (hook) {
      const events = await prisma.hookEvent.findMany({
        where: { hookId: hook.id, createdAt: { gte: since, lte: now } },
        select: { eventType: true, createdAt: true },
      });
      for (const e of events as Array<{ eventType: string; createdAt?: Date }>) {
        eventCounts[e.eventType] = (eventCounts[e.eventType] ?? 0) + 1;
        if (e.eventType === 'run_completed' && e.createdAt) runCompletedAt.push(e.createdAt);
      }
    }
  }

  // Open owner items on the project's chats.
  const ownerItems = allChatIds.length
    ? await prisma.ownerQuestion.count({ where: { status: 'open', chatId: { in: allChatIds } } })
    : 0;
  // Owner 2026-09-29: the card quotes the open questions in their own words
  // ("Needs you") instead of a bare count. Additive, fail-open.
  let openQuestions: Array<{ question: string; createdAt?: Date | null }> = [];
  if (ownerItems > 0) {
    try {
      openQuestions = ((await prisma.ownerQuestion.findMany({
        where: { status: 'open', chatId: { in: allChatIds } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { question: true, createdAt: true },
      })) ?? []) as any;
      if (!Array.isArray(openQuestions)) openQuestions = [];
    } catch { openQuestions = []; }
  }

  // Supervisor's latest machine-wake note (window-bounded so a stale check-in
  // never reads as this hour's). Ticket 68742517: the read must SKIP harness
  // provider-error envelopes — a wake that died on a provider 429 persists the
  // harness's terminal fallback ("Sorry — I couldn't get an answer out this
  // time…") UNDER THE WAKE'S MACHINE ORIGIN, so an unfiltered latest-note read
  // can surface the platform's own error text as the supervisor's check-in
  // until the next successful note. Two-lane exclusion mirrors
  // attention-watchdog.service.ts: the deterministic metadata.providerError
  // marker first, then the envelope shapes (isHarnessErrorNote) for rows
  // persisted before the marker existed or persisted unmarked. Fetch a small
  // batch, newest first, and take the first non-envelope row.
  let checkIn: string | null = null;
  if (supervisorChat) {
    const candidates = await prisma.crossModelMessage.findMany({
      where: {
        chatId: supervisorChat.id,
        role: 'assistant',
        createdAt: { gte: since, lte: now },
        OR: SUPERVISOR_NOTE_ORIGINS.map((origin) => ({ metadata: { path: ['origin'], equals: origin } })),
      },
      orderBy: { createdAt: 'desc' },
      take: CHECK_IN_NOTE_FETCH,
      select: { content: true, metadata: true },
    });
    const note = (candidates ?? []).find(
      (row: any) => !row?.metadata?.providerError && !isHarnessErrorNote(row?.content),
    );
    checkIn = note ? supervisorCheckInLine((note as any).content) : null;
  }

  // ── Derive the structured status ──
  const goalCounts = { active: 0, done: 0, blocked: 0 };
  const blockedGoals: GoalRow[] = [];
  for (const g of goals) {
    if (g.status === 'active') goalCounts.active++;
    else if (g.status === 'done') goalCounts.done++;
    else if (g.status === 'blocked') { goalCounts.blocked++; blockedGoals.push(g); }
  }
  const sinceMs = since.getTime();
  const inProgress = todos.filter((t) => t.status === 'in_progress');
  const pending = todos.filter((t) => t.status === 'pending');
  const blockedTodos = todos.filter((t) => t.status === 'blocked');
  const doneSinceTodos = todos.filter((t) => t.status === 'done' && t.updatedAt && t.updatedAt.getTime() >= sinceMs);

  const withNote = (title: string, note: string | null) => (note && note.trim() ? `${plain(title, 60)} — ${plain(note, 60)}` : plain(title));
  type GateState = 'open' | 'answered' | 'none';
  const withReason = (row: { title: string; blockedReason: string | null; gateQuestionId?: string | null; blockKind?: string | null }, gate: GateState) => {
    const title = row.title;
    const r = (row.blockedReason ?? '').trim();
    if (!r) return plain(title);
    // "[deps] Waiting on 3 todos" is dependency boilerplate — say it plainly.
    if (/^\[deps\]/i.test(r)) return `${plain(title, 60)} — waiting on other work to finish first`;
    // Owner confusion 2026-09-15 ("the dashboard shows CanLaw is halted waiting
    // on me … very confused what the truth is") → CanLaw stall 2026-09-15: a
    // lane-written blockedReason that CLAIMS an owner decision ("owner's
    // HALT-band decision MADE — training stays stopped") is rendered by what
    // backs it. An OPEN owner question → the owner really is asked. An
    // ANSWERED one → the owner already spoke and the team must act on it. No
    // question at all (or one the owner answered with a question back) → the
    // team paused itself and the card says so, in words the owner can act on
    // ("why did my machines stop themselves?") — never as "the owner decided"
    // and never hidden. Any other machine block is "blocked:"; only open owner
    // questions are ever "waiting on you".
    if (row.blockKind === 'owner' || OWNER_WAIT_CLAIM_RE.test(r)) {
      if (gate === 'open') return `${plain(title, 60)} — waiting on your answer to an open question`;
      if (gate === 'answered') return `${plain(title, 60)} — you already answered the question it cites; the team has to act on that answer`;
      return `${plain(title, 60)} — paused by the team's own rule (no owner decision is pending)`;
    }
    return `${plain(title, 60)} — blocked: ${plain(r, 60)}`;
  };

  // Timing first — the "Working on" fallback below reads the running lanes from it.
  const timing = deriveProjectTiming({
    now,
    since,
    laneChats: chats.filter((c) => laneChatIds.includes(c.id)).map((c) => ({ id: c.id, title: c.title ?? null })),
    runningRuns,
    schedules: laneSchedules,
    supervisorSchedules,
    goals,
    todos,
    runCompletedAt,
    prev: opts.prev ?? null,
  });

  const workingOn = inProgress.map((t) => withNote(t.title, t.progressNote));
  if (workingOn.length === 0) {
    // No todo in flight — fall back to the active goals so the section still
    // tells the owner what the project is pursuing.
    for (const g of goals) if (g.status === 'active') workingOn.push(withNote(g.title, g.progressNote));
  }
  // The BOARD-derived "Working on" is what the no-change hash sees (reviews
  // C3/C4): the running-lane fallback below is instantaneous run state.
  const boardWorkingOn = [...workingOn];
  if (workingOn.length === 0 && lanesRunning > 0) {
    // No board item at all but lanes ARE running (owner 2026-09-24: "Work
    // sessions running: 3" beside "Working on: (nothing)" had the brief narrate
    // the contradiction) — name each running lane with its measured age, from
    // the UNCAPPED running set (review C18: timing.lanes is capped at
    // TIMING_MAX_LANES, so the list and the counter disagreed past six).
    const titleOf = new Map(chats.map((c) => [c.id, plain(c.title ?? '', 40) || 'Untitled lane']));
    const startByLane = new Map<string, number>();
    for (const r of runningRuns) {
      if (!runningLaneIds.has(r.sessionId)) continue;
      const startMs = new Date(r.startedAt ?? r.createdAt ?? now).getTime();
      const cur = startByLane.get(r.sessionId);
      if (cur === undefined || startMs < cur) startByLane.set(r.sessionId, startMs);
    }
    const running = [...runningLaneIds]
      .map((id) => ({ id, startMs: startByLane.get(id) ?? now.getTime() }))
      .sort((a, b) => a.startMs - b.startMs);
    const shown = running.slice(0, TIMING_MAX_LANES);
    for (const l of shown) {
      const ageMin = Math.max(0, Math.floor((now.getTime() - l.startMs) / 60_000));
      workingOn.push(`Running: ${titleOf.get(l.id) ?? 'Untitled lane'} (${ageMin}m)`);
    }
    if (running.length > shown.length) workingOn.push(`…and ${running.length - shown.length} more running`);
  }

  const doneSince: string[] = doneSinceTodos.map((t) => `Finished: ${plain(t.title)}`);
  const completedRuns = eventCounts.run_completed ?? 0;
  if (completedRuns > 0) doneSince.push(`${plural(completedRuns, 'work session')} finished`);
  if (checkIn) doneSince.push(checkIn);

  // Which blocked rows are backed by an OPEN owner question (their gate id or
  // an inline oq_ id in the reason)? One probe for the card; a probe error
  // fails OPEN (every cited id counts as open) so a DB hiccup never renders a
  // real owner wait as a self-imposed pause.
  const citedOq = new Set<string>();
  const inlineOq = (reason: string | null) => {
    INLINE_OQ_ID_RE.lastIndex = 0;
    return INLINE_OQ_ID_RE.exec(String(reason ?? ''))?.[0] ?? null;
  };
  for (const r of [...blockedGoals, ...blockedTodos]) {
    if (r.gateQuestionId) citedOq.add(String(r.gateQuestionId));
    const inline = inlineOq(r.blockedReason);
    if (inline) citedOq.add(inline);
  }
  // Probe at ANY status: an OPEN card backs a real owner wait; an ANSWERED card
  // (with a decision — not a reply that was itself a question) means the owner
  // already spoke and the team must act on it; anything else (missing,
  // dismissed, answered-with-a-question) leaves the block as the team's own.
  const openCited = new Set<string>();
  const answeredCited = new Set<string>();
  if (citedOq.size) {
    try {
      const rows = await prisma.ownerQuestion.findMany({
        where: { id: { in: [...citedOq] } },
        select: { id: true, status: true, answer: true, chosenOption: true, answeredBy: true },
      });
      for (const r of rows as Array<{ id: string; status?: string | null; answer?: string | null; chosenOption?: string | null; answeredBy?: string | null }>) {
        const st = String(r.status ?? 'open'); // prod rows always carry status; a partial mock reads as open
        if (st === 'open') openCited.add(r.id);
        else if (st === 'answered' && !isCounterQuestionRow(r)) answeredCited.add(r.id);
      }
    } catch (err: any) {
      logger.warn(`project-status: owner-question probe failed (owner-wait lines fail open): ${err?.message ?? err}`);
      for (const id of citedOq) openCited.add(id);
    }
  }
  const gateStateOf = (r: { blockedReason: string | null; gateQuestionId?: string | null }): GateState => {
    const ids = [r.gateQuestionId ? String(r.gateQuestionId) : null, inlineOq(r.blockedReason)].filter(Boolean) as string[];
    if (ids.some((id) => openCited.has(id))) return 'open';
    if (ids.some((id) => answeredCited.has(id))) return 'answered';
    return 'none';
  };

  const blocked: string[] = [];
  for (const g of blockedGoals) blocked.push(`Goal blocked: ${withReason(g, gateStateOf(g))}`);
  for (const t of blockedTodos) blocked.push(`Todo blocked: ${withReason(t, gateStateOf(t))}`);
  // Todo 908f48a7 (monitor lesson 5): "N item(s) waiting on you" counts the
  // needs-you UNION, not open cards alone. A row gated on an OPEN card is
  // subsumed by that card (one ask, never two); a row gated on an ANSWERED
  // card that is STILL blocked is the owner's approved action that never
  // landed (the Tailscale-ACL specimen class: 9 notes said "nothing needs the
  // owner" counted from open cards (0) while the deploy sat blocked on the
  // owner's approved-but-never-landed save) — it needs the owner even though
  // no card is open. Same classification the withReason prose above renders.
  const gatedRows = [...blockedGoals, ...blockedTodos];
  const answeredUnlanded = gatedRows.filter((r) => gateStateOf(r) === 'answered');
  const needsYouUnion = computeNeedsYouUnion({
    openCards: ownerItems,
    ownerBlocked: gatedRows.filter((r) => gateStateOf(r) === 'open').length,
    answeredUnlanded: answeredUnlanded.length,
  });
  const unionOwnerItems = needsYouUnion.total;
  if (ownerItems > 0) blocked.push(`${plural(ownerItems, 'question is', 'questions are')} waiting for your answer`);
  for (const r of answeredUnlanded.slice(0, 3)) blocked.push(`Approved by you, follow-up not landed: ${plain(r.title, 60)} — the action this answer unlocks is still outstanding`);
  const failedRuns = eventCounts.run_failed ?? 0;
  if (failedRuns > 0) blocked.push(`${plural(failedRuns, 'work session')} hit an error`);
  const attention = eventCounts.attention_needed ?? 0;
  if (attention > 0) blocked.push(`${plural(attention, 'lane')} asked for attention`);

  const next: string[] = pending.map((t) => plain(t.title));

  // KPI of record (finding 4): from the register, active goals first; the
  // adoption ladder (finding 3) rides the same row when it can be read.
  let kpi: ProjectKpiStatus | undefined;
  const kpiGoal = [...goals].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))
    .filter((g) => g.status === 'active' || g.status === 'blocked')
    .map((g) => ({ g, p: kpiPremiseOf(readPremisesLoose(g.premises)) }))
    .find((x): x is { g: GoalRow; p: KpiPremiseLike } => !!x.p);
  if (kpiGoal) {
    const p = kpiGoal.p;
    const setMs = p.setAt ? new Date(p.setAt).getTime() : NaN;
    kpi = {
      goalId: kpiGoal.g.id, key: p.key, value: Number(p.value),
      ...(p.unit ? { unit: p.unit } : {}),
      ...(Number.isFinite(Number(p.bar)) ? { bar: Number(p.bar) } : {}),
      // Ticket c4ee677f (review finding 1): kpiBarDirection/kpiBarText READ the
      // declared direction and infer from the first history value when it is
      // absent — without projecting both, a declared ceiling KPI (latency
      // ≤500 ms) rendered the floor symbol ("bar ≥500") on the owner card.
      ...(typeof p.barDirection === 'string' && p.barDirection ? { barDirection: p.barDirection } : {}),
      ...(Array.isArray(p.history) && p.history.length ? { history: p.history } : {}),
      ...(p.receiptId ? { receiptId: String(p.receiptId) } : {}),
      ...(p.setAt ? { setAt: p.setAt } : {}),
      ...(Number.isFinite(setMs) ? { ageMin: Math.max(0, Math.round((now.getTime() - setMs) / 60_000)) } : {}),
      ...(p.prev && Number.isFinite(Number(p.prev.value)) ? { prevValue: Number(p.prev.value) } : {}),
    };
    try {
      // Dynamic: adoption-ladder reads Redis; the card module stays leaf-light.
      const { loadAdoptionLadders } = await import('../platform/adoption-ladder');
      const ladder = (await loadAdoptionLadders(projectId, now)).get(kpiGoal.g.id);
      if (ladder) { kpi.experimentsSinceMove = ladder.experiments; kpi.hoursSinceMove = ladder.hours; }
    } catch { /* the ladder is additive */ }
  }

  const status: ProjectStatus = {
    projectName: plain(project.name, 60),
    headline: '',
    workingOn,
    doneSince,
    blocked,
    next,
    goals: goalCounts,
    todos: { inProgress: inProgress.length, pending: pending.length, blocked: blockedTodos.length, doneSince: doneSinceTodos.length },
    lanesRunning,
    lanesScheduled,
    ownerItems: unionOwnerItems,
    timing,
    ...(kpi ? { kpi } : {}),
  };
  status.headline = buildHeadline({
    projectName: project.name,
    goals: goalCounts,
    blockedGoalTitle: blockedGoals[0]?.title ?? null,
    lanesRunning,
    lanesScheduled,
    ownerItems: unionOwnerItems,
  });

  // Owner 2026-09-29: the at-a-glance update the card leads with.
  const update = buildProjectUpdate({
    status, goals, todos, since, now, openQuestions, failedRuns,
    prev: opts.prev?.update ?? null,
    sessions: await loadSessionChanges({ chats, laneChatIds, runningLaneIds, scheduledLaneIds, since, now }),
  });
  // Hash the board-derived "Working on" (never the synthesized running lanes);
  // hashProjectStatus drops the window's lists itself (2026-09-29).
  const hash = hashProjectStatus({ ...status, workingOn: boardWorkingOn });
  let body = buildStatusBody(status);
  if (update) { const md = renderUpdateMarkdown(update); body = body.replace(/^(\*\*[^\n]*\*\*)/, (h) => `${h}\n\n${md}`); }
  return { status, body, hash, ...(update ? { update } : {}) };
}

/**
 * Work sessions that STARTED in the window (a lane chat — sub-sessions
 * included — created in it) and ones that FINISHED for good (a run completed
 * in the window, nothing running now, no enabled schedule: a scheduled lane's
 * routine firing is not a finish). Each finish carries the first line of the
 * session's last reply in the window as a gist. Fail-open (empty lists).
 */
async function loadSessionChanges(input: {
  chats: Array<{ id: string; title?: string | null; isProjectSupervisor: boolean; archivedAt: Date | null; createdAt?: Date | null }>;
  laneChatIds: string[];
  runningLaneIds: Set<string>;
  scheduledLaneIds: Set<string>;
  since: Date;
  now: Date;
}): Promise<{ started: string[]; finished: Array<{ title: string; gist?: string }> }> {
  const sinceMs = input.since.getTime();
  const nowMs = input.now.getTime();
  const inWin = (d: Date | null | undefined) => {
    const t = d instanceof Date ? d.getTime() : d ? new Date(d as any).getTime() : NaN;
    return Number.isFinite(t) && t >= sinceMs && t <= nowMs;
  };
  const titleOf = new Map(input.chats.map((c) => [c.id, plain(c.title ?? '', 60) || 'Untitled session']));
  const lanes = new Set(input.laneChatIds);
  const started = input.chats
    .filter((c) => lanes.has(c.id) && inWin(c.createdAt ?? null))
    .map((c) => titleOf.get(c.id)!);
  const finished: Array<{ title: string; gist?: string }> = [];
  if (!input.laneChatIds.length) return { started, finished };
  try {
    const runs = ((await prisma.agentRun.findMany({
      where: { sessionId: { in: input.laneChatIds }, status: 'completed', finishedAt: { gte: input.since, lte: input.now } },
      select: { sessionId: true, status: true, finishedAt: true },
    })) ?? []) as Array<{ sessionId: string; status?: string; finishedAt?: Date | null }>;
    const done = [...new Set(runs
      .filter((r) => r.status === 'completed' && inWin(r.finishedAt ?? null))
      .map((r) => r.sessionId))]
      .filter((id) => lanes.has(id) && !input.runningLaneIds.has(id) && !input.scheduledLaneIds.has(id));
    if (!done.length) return { started, finished };
    const gists = new Map<string, string>();
    try {
      const rows = ((await prisma.crossModelMessage.findMany({
        where: { chatId: { in: done }, role: 'assistant', createdAt: { gte: input.since, lte: input.now } },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: { chatId: true, content: true },
      })) ?? []) as Array<{ chatId: string; content: string | null }>;
      for (const r of rows) {
        if (gists.has(r.chatId)) continue;
        const line = String(r.content ?? '').split(/\r?\n/).map((l) => l.replace(/\*\*|__|`/g, '').trim().replace(/^[#>*_\s-]+/, ''))
          .find((l) => l.length > 3 && !l.startsWith('[') && !l.startsWith('```'));
        if (line) gists.set(r.chatId, line.split(/(?<=[.!?])\s/)[0]);
      }
    } catch { /* the gist is additive */ }
    for (const id of done) finished.push({ title: titleOf.get(id) ?? 'Untitled session', ...(gists.get(id) ? { gist: gists.get(id) } : {}) });
  } catch { /* fail-open: no finish lines */ }
  return { started, finished };
}

// ── Sweep ────────────────────────────────────────────────────────────────────

/** Newest status row in a supervisor chat (the 60-min gate + hash source; `id` for the in-place stub refresh). */
async function latestStatusRow(chatId: string): Promise<{ id?: string; createdAt: Date; metadata: any } | null> {
  const row = await prisma.crossModelMessage.findFirst({
    where: { chatId, role: 'assistant', metadata: { path: ['origin'], equals: PROJECT_STATUS_ORIGIN } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, metadata: true },
  });
  return (row as any) ?? null;
}

/** When the previous row last CHECKED the ledger: its generatedAt (refreshed in
 *  place on quiet hours) falling back to createdAt. The gate and the window
 *  read this, not createdAt — an in-place-refreshed stub keeps its original
 *  createdAt. */
function prevCheckedMs(prev: { createdAt: Date; metadata: any } | null): number | null {
  if (!prev) return null;
  const g = typeof prev.metadata?.generatedAt === 'string' ? Date.parse(prev.metadata.generatedAt) : NaN;
  return Number.isFinite(g) ? g : prev.createdAt.getTime();
}

/**
 * The hourly sweep: for every enabled + scaffolded project supervisor, emit a
 * status card when the previous one is ≥ 60 min old (or absent). Never throws.
 */
export async function emitProjectStatusUpdates(
  now: Date = new Date(),
  opts: {
    /** Only these supervisor chats (the event trigger). */
    chatIds?: string[];
    /** Change-only spacing between two posts (default PROJECT_STATUS_CHANGE_MIN_MS). */
    minChangeSpacingMs?: number;
  } = {},
): Promise<ProjectStatusSweepResult> {
  const result: ProjectStatusSweepResult = { scanned: 0, emitted: 0, unchanged: 0, updatedInPlace: 0, changePosts: 0, gated: 0, failed: 0, disabled: false };
  if (projectStatusUpdatesDisabled()) {
    result.disabled = true;
    return result;
  }
  const nowMs = now.getTime();

  let lanes: Array<{ id: string; projectId: string | null; userId: string }> = [];
  try {
    lanes = (await prisma.crossModelChat.findMany({
      where: {
        isProjectSupervisor: true,
        archivedAt: null,
        projectId: { not: null },
        ...(opts.chatIds?.length ? { id: { in: opts.chatIds } } : {}),
        project: { projectSupervisorEnabled: true, archivedAt: null },
      },
      select: { id: true, projectId: true, userId: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_PROJECTS_PER_SWEEP,
    })) as any;
  } catch (err: any) {
    logger.warn(`project-status: lane discovery failed (sweep skipped): ${err?.message ?? err}`);
    return result;
  }

  for (const lane of lanes) {
    if (!lane.projectId) continue;
    result.scanned++;
    try {
      const prev = await latestStatusRow(lane.id);
      const checkedMs = prevCheckedMs(prev);
      // Inside the hourly gate the lane is still CHECKED for a milestone change
      // (2026-09-29) — at most once per PROJECT_STATUS_CHANGE_MIN_MS; nothing
      // is written unless the update names one.
      const hourly = projectStatusHourlyEnabled();
      const spacing = opts.minChangeSpacingMs ?? PROJECT_STATUS_CHANGE_MIN_MS;
      let early = false;
      if (hourly) {
        if (checkedMs !== null && nowMs - checkedMs < PROJECT_STATUS_INTERVAL_MS) {
          if (nowMs - checkedMs < spacing) {
            result.gated++;
            continue;
          }
          early = true;
        }
      } else if (checkedMs !== null) {
        // Change-only (default): every card after the first is a milestone post.
        if (nowMs - checkedMs < spacing) { result.gated++; continue; }
        early = true;
      }
      // This lane's OWN read clock (review C2): captured right before the
      // ledger read, it stamps generatedAt (and so the next window's `since`),
      // the timing block and the chat bump. The sweep's `now` served the gate.
      const checkedAt = new Date();
      const checkedAtMs = checkedAt.getTime();
      const since = checkedMs !== null
        ? new Date(Math.max(checkedMs, checkedAtMs - PROJECT_STATUS_MAX_WINDOW_MS))
        : new Date(checkedAtMs - PROJECT_STATUS_INTERVAL_MS);

      const rendered = await renderProjectStatus(lane.projectId, since, {
        now: checkedAt,
        // The previous card feeds the rate-based estimates (two fractions, one interval).
        prev: prev ? { generatedAt: prev.metadata?.generatedAt ?? prev.createdAt.toISOString(), timing: prev.metadata?.status?.timing ?? null, update: prev.metadata?.update ?? null } : null,
      });
      if (!rendered) continue; // project vanished between discovery and render
      if (early && !rendered.update?.milestone) {
        // Nothing worth a message: no write — the window keeps growing from
        // the last POSTED card (capped at PROJECT_STATUS_MAX_WINDOW_MS).
        result.gated++;
        continue;
      }

      const briefMod = await import('./project-brief.service');
      const prevBriefRaw = prev?.metadata?.brief;
      const prevBrief: import('./project-brief.service').ProjectBrief | undefined =
        prevBriefRaw && typeof prevBriefRaw === 'object' ? prevBriefRaw : undefined;

      // "Unchanged" = status hash unchanged AND asks fingerprint unchanged
      // (2026-09-24 design decision — a changed set of asks is a real change).
      // The fingerprint read returns the loaded ledger/asks context too, so a
      // rebuild below never reads them twice (review C21).
      let asksChanged = false;
      let askContext: import('./project-brief.service').AskContext | undefined;
      // An early (milestone) card reuses the previous brief — no model call;
      // the hourly card rebuilds it (its stale fingerprint reads as changed).
      if (!early) {
        let fp: string | null = null;
        try {
          const r = typeof briefMod.computeAsksFingerprint === 'function' ? await briefMod.computeAsksFingerprint(lane.id, checkedAt) : null;
          if (r) { fp = r.fingerprint; askContext = r.context; }
        } catch (err: any) {
          logger.warn(`project-status: asks fingerprint failed for project ${String(lane.projectId).slice(0, 8)} (asks read as changed): ${err?.message ?? err}`);
        }
        const prevFp = typeof prevBrief?.asksFingerprint === 'string' ? prevBrief.asksFingerprint : null;
        // A null current or missing previous fingerprint cannot prove nothing moved ⇒ changed (once).
        asksChanged = !(fp && prevFp && fp === prevFp);
      }
      const prevHash = typeof prev?.metadata?.statusHash === 'string' ? prev.metadata.statusHash : null;
      const hashUnchanged = !!prevHash && prevHash === rendered.hash;
      // Owner 2026-09-29: anything in the update's "since the last update"
      // list is news — a full card lands; nothing there + the same board is a
      // quiet hour.
      const updateChanged = !!rendered.update && rendered.update.changes.length > 0;
      const unchanged = !early && hashUnchanged && !asksChanged && !updateChanged;
      // Quiet-streak bookkeeping (2026-09-24). A second (third, …) quiet hour
      // refreshes the existing stub IN PLACE; the first quiet hour inserts ONE
      // stub anchored at the last real card's time.
      const prevIsStub = !!prev && prev.metadata?.unchanged === true && typeof prev.id === 'string' && prev.id.length > 0;
      const refreshInPlace = unchanged && prevIsStub;
      const checkedIso = checkedMs !== null ? new Date(checkedMs).toISOString() : checkedAt.toISOString();
      const quietSince: string | undefined = unchanged
        ? (prevIsStub && typeof prev!.metadata?.quietSince === 'string' ? prev!.metadata.quietSince : checkedIso)
        : undefined;
      const quietChecks: number | undefined = unchanged
        ? (prevIsStub ? (Number(prev!.metadata?.quietChecks) || 1) + 1 : 1)
        : undefined;
      const status = unchanged ? noChangeStatus(rendered.status, quietSince, checkedAt) : rendered.status;
      // The plain-language brief (owner 2026-09-22). A quiet stub COPIES the
      // previous brief forward and never rebuilds it (its fingerprint is the
      // current one by construction); a real card rebuilds it — one utility
      // call, deterministic fallback on a model failure; when the INPUTS could
      // not be read the previous brief is kept (review C8: never a brief built
      // from empty ledger inputs). Never blocks the card.
      let brief: import('./project-brief.service').ProjectBrief | undefined;
      // A milestone post reuses a brief younger than an hour (no model call).
      const prevBriefFresh = !!prevBrief && Number.isFinite(Date.parse(String(prevBrief.generatedAt)))
        && checkedAtMs - Date.parse(String(prevBrief.generatedAt)) < PROJECT_STATUS_INTERVAL_MS;
      // audit 2026-10-06 T8-2 (stanne #11): a MILESTONE post never reuses a brief that predates the milestone —
      // "Finished: Build cql-agent" landed under a 12-minute-old brief still saying "the next milestone is
      // building … all tasks still pending". The milestone is a change since the previous card, and that card's
      // brief was written at (or before) its own check, so every previous brief is older than the milestone ⇒
      // rebuild. PROJECT_STATUS_MILESTONE_BRIEF_REBUILD_DISABLED=1 restores the reuse-under-an-hour rule.
      const milestoneRebuild = early && rendered.update?.milestone === true && !milestoneBriefRebuildDisabled();
      if (unchanged || (early && prevBriefFresh && !milestoneRebuild)) {
        if (prevBrief) brief = prevBrief;
      } else {
        try {
          brief = (await briefMod.buildProjectBrief(lane.projectId, rendered.status, { now: checkedAt, supervisorChatId: lane.id, askContext })) ?? undefined;
        } catch (err: any) {
          logger.warn(`project-status: brief build threw for project ${String(lane.projectId).slice(0, 8)}: ${err?.message ?? err}`);
        }
        if (!brief && prevBrief) {
          brief = prevBrief;
          logger.warn(`project-status: brief unavailable for project ${String(lane.projectId).slice(0, 8)} — the previous brief rides this card`);
        }
      }
      // The stub body stays the bare headline (downstream classifiers read its
      // "no change" phrase); the card renders the update from metadata.
      let body = unchanged ? `**${status.headline}**` : rendered.body;
      if (brief && !unchanged) {
        const md = briefMod.renderBriefMarkdown(brief);
        if (md) body = `${body}\n\n${md}`;
      }
      // 2026-09-27: a seat LATCHED off by a deterministic invalid-request
      // rejection (tools over the model's cap, reasoning_effort refused, …) is
      // stated on the card — "seat X unusable: <reason> — running on Y since
      // <t>" — harness text from loop_metrics, never model prose. Fail-open.
      if (!unchanged) {
        try {
          const [{ listActiveSeatLatches }, { seatLatchLine }] = await Promise.all([
            import('../platform/loop-metrics.service'),
            import('../coding/seat-invalid-request'),
          ]);
          const latchLine = seatLatchLine(await listActiveSeatLatches());
          if (latchLine) body = `${body}\n\n⚠︎ ${latchLine}`;
        } catch { /* a telemetry read never breaks the card */ }
      }
      const metadata: ProjectStatusMetadata = {
        origin: PROJECT_STATUS_ORIGIN,
        kind: PROJECT_STATUS_ORIGIN,
        generatedAt: checkedAt.toISOString(),
        since: since.toISOString(),
        status,
        statusHash: rendered.hash,
        unchanged,
        ...(quietSince ? { quietSince, quietChecks } : {}),
        ...(rendered.update ? { update: rendered.update } : {}),
        ...(brief ? { brief } : {}),
      };

      if (refreshInPlace) {
        // Same stub row, fresher timing/quietChecks — no new row, and the chat
        // is NOT bumped (a quiet hour is not news in the sidebar). createdAt
        // moves to the check time too (review C13): the stub stays the chat's
        // tail row, so the (createdAt, id) ordering keeps telling the truth
        // when the owner typed between two refreshes.
        await prisma.crossModelMessage.update({
          where: { id: prev!.id! },
          data: { content: body, metadata: metadata as any, createdAt: checkedAt },
        });
        result.updatedInPlace++;
        result.unchanged++;
      } else {
        // Direct insert — never via sendChatMessage: no run, no hook wake.
        await prisma.crossModelMessage.create({
          data: { chatId: lane.id, role: 'assistant', content: body, metadata: metadata as any },
        });
        await prisma.crossModelChat.update({ where: { id: lane.id }, data: { updatedAt: checkedAt } }).catch(() => {});
        result.emitted++;
        if (unchanged) result.unchanged++;
        if (early) result.changePosts++;
      }
    } catch (err: any) {
      result.failed++;
      logger.warn(`project-status: emit failed for project ${String(lane.projectId).slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
    }
  }
  return result;
}

/** Cron entry (worker.ts 'project-status'): one sweep + a one-line summary. Never throws. */
export async function runProjectStatusOnce(): Promise<void> {
  try {
    const r = await emitProjectStatusUpdates(new Date());
    if (r.disabled) return;
    if (r.scanned > 0) {
      if (r.emitted > 0 || r.updatedInPlace > 0 || r.failed > 0) logger.info(`project-status: swept ${r.scanned} project supervisor(s) — emitted ${r.emitted} (${r.unchanged} no-change, ${r.changePosts} on a change, ${r.updatedInPlace} refreshed in place), gated ${r.gated}, failed ${r.failed}`);
    }
  } catch (err: any) {
    logger.warn(`project-status: sweep failed (non-fatal): ${err?.message ?? err}`);
  }
}

// ── Read side (GET /projects/:id) ────────────────────────────────────────────

/**
 * The newest status card for a project — its metadata (origin/kind/generatedAt/
 * since/status), or null when the project has no supervisor lane or no card
 * yet. Served as `latestProjectStatus` on GET /projects/:id so the project
 * page can render the same card the supervisor chat shows.
 */
export async function getLatestProjectStatus(projectId: string): Promise<ProjectStatusMetadata | null> {
  const row = await prisma.crossModelMessage.findFirst({
    where: {
      role: 'assistant',
      metadata: { path: ['origin'], equals: PROJECT_STATUS_ORIGIN },
      chat: { projectId, isProjectSupervisor: true },
    },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true, createdAt: true },
  });
  const meta: any = (row as any)?.metadata;
  if (!meta || typeof meta !== 'object' || !meta.status) return null;
  return {
    origin: PROJECT_STATUS_ORIGIN,
    kind: PROJECT_STATUS_ORIGIN,
    generatedAt: typeof meta.generatedAt === 'string' ? meta.generatedAt : (row as any).createdAt.toISOString(),
    since: typeof meta.since === 'string' ? meta.since : (row as any).createdAt.toISOString(),
    status: meta.status as ProjectStatus,
    ...(typeof meta.statusHash === 'string' ? { statusHash: meta.statusHash } : {}),
    ...(typeof meta.unchanged === 'boolean' ? { unchanged: meta.unchanged } : {}),
    ...(typeof meta.quietSince === 'string' ? { quietSince: meta.quietSince } : {}),
    ...(typeof meta.quietChecks === 'number' ? { quietChecks: meta.quietChecks } : {}),
    ...(meta.update && typeof meta.update === 'object' ? { update: meta.update } : {}),
  };
}

// ── Event trigger (owner 2026-09-29: "operate off hooks") ───────────────────

/** Event types on a project-scope hook that can carry a milestone. */
export const PROJECT_STATUS_EVENT_TYPES = new Set(['run_completed', 'run_failed', 'todo_done', 'attention_needed', 'owner_question', 'goal_done', 'schedule_disabled']);
/** Coalesce a burst of events (a lane finishing emits several) into one check. */
export const PROJECT_STATUS_EVENT_DEBOUNCE_MS = 45 * 1000;
const pendingEventChecks = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Ask for a status check of ONE project supervisor chat soon (debounced per
 * chat in this process; a Redis NX claim keeps two boxes from posting the
 * same change). The check posts only a milestone (see the sweep). Detached;
 * never throws. Called by hooks.service after a project-scope hook row lands.
 */
export function requestProjectStatusCheck(supervisorChatId: string, eventType?: string): void {
  try {
    if (!supervisorChatId || projectStatusUpdatesDisabled()) return;
    if (eventType && !PROJECT_STATUS_EVENT_TYPES.has(eventType)) return;
    if (pendingEventChecks.has(supervisorChatId)) return;
    const t = setTimeout(() => {
      pendingEventChecks.delete(supervisorChatId);
      void (async () => {
        try {
          const { default: redisClient } = await import('../../../config/redis');
          const claimed = await (redisClient as any).set(`project-status:event:${supervisorChatId}`, '1', { NX: true, PX: PROJECT_STATUS_EVENT_MIN_MS }).catch(() => 'OK');
          if (!claimed) return;
          await emitProjectStatusUpdates(new Date(), { chatIds: [supervisorChatId], minChangeSpacingMs: PROJECT_STATUS_EVENT_MIN_MS });
        } catch (err: any) {
          logger.warn(`project-status: event check failed for ${supervisorChatId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
        }
      })();
    }, PROJECT_STATUS_EVENT_DEBOUNCE_MS);
    (t as any).unref?.();
    pendingEventChecks.set(supervisorChatId, t);
  } catch { /* never throws into the hook path */ }
}

/**
 * Fleet Supervisor — ONE pinned "Fleet Supervisor" chat per OWNER, auto-created
 * LAZILY and pre-granted FULL fleet autonomy, so it watches over ALL of the
 * owner's chats and coding sessions (across every project) and ACTS (nudge /
 * dispatch / schedule) with no manual grant flow.
 *
 * Anatomy of the supervisor:
 *   - a crossmodel_chats row with isSupervisor=true, title 'Fleet Supervisor',
 *     NO project (ungrouped — it spans the whole fleet), and a per-chat
 *     systemPrompt (appended AFTER the project-chain prompt at chat-run
 *     assembly, so it outranks folder instructions);
 *   - a ChatAutonomy row with EVERY grantable consequential tool + the max
 *     schedule cap (1440/day) — its machine-triggered runs (sweep schedule,
 *     hook wakes) can send messages / dispatch coding sessions / manage its
 *     own schedules without a user turn;
 *   - ONE recurring CodingSchedule (2h) — the sweep loop that wakes it to
 *     review the fleet even when no hook fires;
 *   - ONE WILDCARD EventHook (sourceChatId = NULL) → the supervisor, so EVERY
 *     chat the owner has — including chats created later — emits run
 *     completions / failures / attention requests / blocked goals to it with
 *     ZERO per-chat wiring.
 *
 * The exported ensure is a BEST-EFFORT side effect of chat/coding-session
 * creation and sidebar load: it NEVER throws — a supervisor hiccup must not
 * fail the request that triggered it. Everything is idempotent
 * (find-before-create on every row + a partial unique index backing the
 * create race), so a retry or a double-fire converges instead of duplicating.
 *
 * Import discipline (mirrors hooks.service): this module statically imports
 * autonomy.service → crossmodel.service, so it must only ever be loaded via
 * DYNAMIC import from its call sites (crossmodel.service.createChat,
 * coding-data.service.createCodingChat, platform.routes) — a static edge back
 * would close a load-time cycle.
 *
 * Ownership note: the supervisor is owned by the user it watches (ownerId) —
 * its sweeps and sends run with that user's identity, and only that user can
 * revoke its autonomy or delete it (both owner-only). Wildcard-hook delivery
 * re-checks that the hook's userId still owns both the target and every
 * source chat in the group (hooks.service), so chats of OTHER members of a
 * shared project never reach it — each owner has their own supervisor.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AUTONOMY_GRANTABLE_TOOLS, MAX_SCHEDULE_CAP } from './autonomy.service';
import { CONTROL_TOOL_NAMES } from './control-tools';
import { evaluateAccountDormancy, DORMANT_LAST_STATUS } from '../coding/dormancy-gate.service';
import { recordLoopMetric, LOOP_METRIC_KINDS } from './loop-metrics.service';
import { SWEEP_PROMPT_OPENER } from './supervisor-doctrine';
import { harnessLineKind, supervisorHarnessReceiptsDisabled } from './harness-receipts';
// Layered prompts (2026-09-27): the stock prompt is composed from the generic
// core doctrine + the live harness-facts block + the fleet role profile
// (prompt-layers.ts).
import { composePrompt } from './prompt-layers';
import { coreDoctrine } from './core-doctrine';
import { frameworkFactsBlock } from './framework-facts';
import { fleetSupervisorRoleProfile } from './role-profiles';
import { modelToolName } from '../coding/tool-scope';
// Supervisor OFF switch (owner 2026-09-26): while off, ensure returns the
// existing chat untouched (no heal, no arm) and creates nothing.
import { getFleetSupervisorEnabled, recordSupervisorSwitchSkip } from './supervisor-switch';
import { healSupervisorTitle } from './session-titles';

/** The pinned chat's title — the frontend recognizes the supervisor by isSupervisor, this is just the label. */
export const SUPERVISOR_TITLE = 'Fleet Supervisor';

/**
 * Best-effort audit trail (Activity, resource 'platform') — mirrors
 * autonomy.service / hooks.service. The supervisor's wildcard hook is exactly
 * the one whose silent loss motivated feedback be89b75d: its (re)provisioning
 * must be as attributable as its deletion.
 */
async function audit(userId: string, action: string, metadata?: Record<string, any>): Promise<void> {
  try {
    await prisma.activity.create({
      data: { userId, action, resource: 'platform', ...(metadata ? { metadata } : {}) },
    });
  } catch (err: any) {
    logger.warn(`supervisor audit write failed (${action}): ${err.message}`);
  }
}

/**
 * Every stock supervisor prompt (current AND legacy pre-Boundaries versions)
 * opens with this string — a system-written identity marker. The ONE
 * user-facing path that edits a chat's systemPrompt (account-tools
 * set_chat_instructions, 2026-09-08) refuses supervisor chats by WHERE-clause
 * (isSupervisor:false — and, hardening review 2026-09-14, isProjectSupervisor:
 * false), so an opener match still means stock. fleet.service keys its
 * legacy-dupe hiding on it (a user chat merely RENAMED 'Fleet Supervisor'
 * lacks it and must stay visible).
 */
export const SUPERVISOR_PROMPT_OPENER = 'You are the Fleet Supervisor';

/**
 * Non-creating read of the owner's fleet supervisor chat (null when it has
 * never been provisioned — ensureFleetSupervisor creates it lazily on chat /
 * coding-session creation and on the sidebar's POST /supervisor/ensure).
 * Backs the Management UI's read-only discovery endpoint (GET /fleet/supervisor);
 * callers that NEED the supervisor to exist should use ensureFleetSupervisor.
 */
export async function findFleetSupervisorChat(userId: string): Promise<{ id: string; title: string; userId: string } | null> {
  if (!userId) return null;
  return prisma.crossModelChat.findFirst({
    where: { userId, isSupervisor: true },
    select: { id: true, title: true, userId: true },
  });
}

/**
 * wake-cadence-5 (fixer 2026-09-27): the Fleet Supervisor chat a PROJECT
 * supervisor session reports UP to — the target the decision-outcome labels
 * exclude when deciding whether a wake ACTED (a send_chat_message to this id
 * is a report-up, not lane work; fleet/attention-watchdog.service applies the
 * same rule to the loop_metrics kind). null for the fleet chat itself, for any
 * non-project-supervisor chat (a worker lane messaging the fleet is not a
 * report-up), when no fleet chat exists, or on any read error (fail-open: the
 * caller keeps the pre-fix label).
 */
export async function reportUpTargetForSession(sessionId: string): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: sessionId },
      select: { userId: true, isSupervisor: true, isProjectSupervisor: true },
    });
    if (!chat || chat.isSupervisor || !chat.isProjectSupervisor) return null;
    const fleet = await findFleetSupervisorChat(chat.userId);
    return fleet?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Event types the wildcard hook subscribes to. todo_done is deliberately
 * omitted (too chatty for a 2h-pace supervisor — goal_blocked and the run
 * events carry the signal). schedule_disabled (overnight forensics 2026-08-24,
 * fix 2): a stopped cadence must wake the supervisor — the TT-RD session
 * cancelled its own recurring watch and nothing noticed. schedule_near_cap
 * (ticket b4d1096c): the PRE-emptive half — a recurring row at ≥90% of its
 * run cap / lifetime fires once per row BEFORE the gap, so the supervisor
 * re-arms ahead of the death instead of learning from schedule_disabled.
 */
const SUPERVISOR_HOOK_EVENT_TYPES = [
  'run_completed', 'run_failed', 'attention_needed', 'goal_blocked', 'schedule_cap_skipped', 'schedule_disabled', 'schedule_near_cap',
];

/**
 * Wildcard-hook debounce: 3600s, NOT the schema default 60s (owner
 * 2026-09-04 — supervisor wake economy, the CV0904 citation-strike root-cause
 * fix's cost leg). The supervisor is hook-woken on EVERY fleet run_completed;
 * at the old 60s window a single 15-min lane made it author a full
 * evidence-cited wake note every tick — observed wake storm 02:13Z / 02:15Z /
 * 02:23Z / 02:26Z on 2026-09-04: four notes in 13 minutes off quiet
 * run_completed events — maximal fabrication surface at maximal cost (the
 * supervisor cap is 1440/day), while the 2h sweep + hourly digests already
 * cover awareness. Quiet events now coalesce into at most one wake per hour;
 * failure response is NOT delayed — ALARM-class events (attention_needed /
 * run_failed / goal_blocked / schedule_disabled) BYPASS the debounce entirely
 * in hooks.service deliverHookGroup (the same audit-#3 events that already
 * bypass the daily cap).
 */
// Owner 2026-09-14 ("make hooks instant — no idle time"): 0. The 2026-09-04
// hourly window existed for wake economy; that economy now comes from
// busy-coalescing (events arriving mid-wake park and drain as ONE digest the
// moment the wake ends) plus the fleet-feed shed for project-supervised
// projects. An idle fleet chat wakes the moment something happens.
export const SUPERVISOR_HOOK_DEBOUNCE_SEC = 0;
/** The 2026-09-04 → 2026-09-14 stock window — healed to 0 like the 60 s schema default. */
export const PREVIOUS_SUPERVISOR_HOOK_DEBOUNCE_SEC = 3600;
/** The schema default every pre-fix wildcard hook carries — the ONLY value
 *  the debounce heal rewrites. A deliberately customized window is never
 *  touched (the repairAutonomyIfMissing non-clobber rule); a hand-set 60 is
 *  indistinguishable from the default, and the default IS the bug. */
const LEGACY_HOOK_DEBOUNCE_SEC = 60;

/**
 * KNOWN LEGACY stock event sets for the wildcard hook. An existing hook whose
 * eventTypes exactly matches one (order-insensitive) is STOCK — never
 * user-narrowed — and is healed to the CURRENT set on ensure, so a newly
 * added event type (schedule_disabled) actually reaches EXISTING supervisors.
 * Any other set is treated as a deliberate customization and never touched
 * (the repairAutonomyIfMissing non-clobber rule).
 */
const LEGACY_SUPERVISOR_HOOK_EVENT_SETS: string[][] = [
  ['run_completed', 'run_failed', 'attention_needed', 'goal_blocked', 'schedule_cap_skipped'],
  ['run_completed', 'run_failed', 'attention_needed', 'goal_blocked'],
];

/**
 * The universe of event types any STOCK-era hook could contain (current stock
 * + every type that has ever appeared in a stock or user-narrowed set). A hook
 * whose types are a SUBSET of this universe holds no custom types — it is a
 * stock hook, possibly deliberately narrowed by the user.
 */
const KNOWN_STOCK_EVENT_TYPE_UNIVERSE = new Set([
  'run_completed', 'run_failed', 'attention_needed', 'goal_blocked',
  'todo_done', 'schedule_cap_skipped', 'schedule_disabled', 'schedule_near_cap',
]);

/**
 * Types added to the stock set AFTER supervisors already existed in prod.
 * The heal unions ONLY these into stock-universe hooks — it never restores
 * types a user deliberately removed (2026-08-24 lesson: the exact-match heal
 * missed every prod variant — narrowed sets and todo_done-era sets — so
 * schedule_disabled reached no existing supervisor).
 */
const NEWLY_ADDED_STOCK_EVENT_TYPES = ['schedule_disabled', 'schedule_near_cap'];

/** Order-insensitive event-set equality (defensive against non-array rows). */
function sameEventSet(a: unknown, b: string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const sa = [...a].map(String).sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** Sweep cadence + lifetime ceiling, mirroring schedule.service's guardrails (MAX_RUNS / MAX_LIFETIME). */
const SWEEP_INTERVAL_SEC = 120 * 60; // 2 hours
const SWEEP_MAX_RUNS = 500;
const SWEEP_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * The supervisor chat's system prompt (stored on the chat row at creation).
 * Fleet-wide: it names no project — the supervisor surveys with list_chats
 * (every chat carries its projectId) and drills into projects as needed.
 *
 * 2026-09-24: the §Wake economy no-op exemplar dropped its model-filled
 * '<time>' placeholder (now 'since the previous wake') — see the dated note on
 * wakeCloseContract in supervisor-doctrine.ts for the owner incident ("since
 * 6:46 PM" posted at 6:46 PM). The 'WAKE: no-op' prefix the classifier below
 * (SUPERVISOR_NOOP_NOTE_RE) keys on is unchanged.
 *
 * LAYERED (2026-09-27): opener → core doctrine (generic) → harness facts
 * (live) → fleet role profile. The fleet seat carries NO project brief — its
 * roster is live (list_projects + the [BOARD] block every wake). The
 * pre-layering builder and its PROMPT_LAYERING_DISABLED switch were deleted
 * (build 2026-10-08 S-2: the switch was never forwarded to prod).
 */
export function buildFleetSupervisorPrompt(): string {
  return composePrompt({
    role: 'fleet_supervisor',
    opener: `${SUPERVISOR_PROMPT_OPENER} — an autonomous supervisor chat that watches over EVERY chat and coding session the owner has, across all projects, and keeps the work moving.`,
    core: coreDoctrine('fleet'),
    facts: frameworkFactsBlock({ audience: 'supervisor' }),
    roleProfile: fleetSupervisorRoleProfile(),
  }).text;
}

/** Stock marker for the sweep prompt — every stock version opens with this
 *  (the SUPERVISOR_PROMPT_OPENER pattern); ensureSweepSchedule keys its
 *  stale-prompt heal on it, so a user-customized prompt is never touched.
 *  DEFINED in supervisor-doctrine.ts (leaf) since 2026-09-18 so the fire-time
 *  doctrine rebuild can key on it without an import cycle — re-exported here. */
export { SWEEP_PROMPT_OPENER };

/** The recurring sweep schedule's prompt — a STANDALONE instruction (each firing is a fresh turn).
 *
 *  GOAL-LEDGER contract (2026-09-02 supervisor value upgrade — owner report:
 *  sweeps "uselessly loop", re-narrating full-fleet status tables no one asked
 *  for): a sweep is a DIFF against the previous sweep, anchored on the goal
 *  ledger (goal_list), never a bulletin. The prior duties (board reconcile
 *  2026-08-30, schedule health 2026-08-24 fix 3c, deaf-lane re-arm 2026-08-30
 *  Post-CPT) are unchanged — they now feed the diff instead of the narration.
 *
 *  DOCTRINE DEDUP (R&D stream 3 experiment #2, 2026-09-18): the standing
 *  doctrine (STANDING_OWNER_DIRECTIVE_HEADER + FLEET_PRECEDENCE_RULE —
 *  ~4855c/~1150 cl100k tokens) no longer rides the stored sweep body; it
 *  already lives in this lane's SYSTEM prompt (buildFleetSupervisorPrompt —
 *  the cached prefix every wake pays for anyway). The fire-time trigger-keyed
 *  rebuild (platform/sweep-doctrine-rebuild.ts, called from
 *  coding/schedule.service fireScheduleTarget) probes the lane's system
 *  prompt at fire time and rebuilds the doctrine into the firing message
 *  whenever it is absent there — NO wake ever runs doctrine-less, and a
 *  legacy pre-heal stored body (doctrine still inline) is never
 *  double-injected.
 *
 *  LAYERED (2026-09-27): the stored body is GENERIC — the halt rule and the
 *  parked-turn rule are cited by their core rule ids (halt.owner-words,
 *  gate.outcome) instead of being restated with their incident. */
export function buildFleetSweepPrompt(): string {
  return (
    `${SWEEP_PROMPT_OPENER} — a GOAL LEDGER diff, not a status bulletin. Report movement since the previous sweep; never re-narrate unchanged state.\n` +
    `1. PULL the ledger: list_projects (every folder incl. EMPTY new ones — goal_list/list_chats never show those), goal_list (active goals + their todos, account-wide) and list_chats, then get_chat_status on each lane that is running, carries attention state, or owns goal todos — its LAST outcome since the previous sweep.\n` +
    `2. DIFF against your previous sweep note and [SUPERVISOR STATE] (get_supervisor_state for the full doc). Report ONLY DELTAS: (a) what moved TOWARD a goal since the last sweep (cite the artifact — msg/session/PR/ticket id — in your closing Receipts line, never as the headline; a docs-only PR is a record, not movement — cite the NUMBER that moved), (b) what moved AWAY or regressed, (c) what is genuinely STUCK — no progress across 2+ consecutive sweeps, say since when — and (d) what needs an ACTION now. A lane that did not change is NOT re-narrated — 'unchanged since last sweep' in ≤1 line and move on; NEVER post a full-fleet status table when nothing changed.\n` +
    `3. STALE-GATE CHECK: before reporting ANY work as "waiting on the owner", probe the gate fresh with list_owner_questions (clear a stale card or question of YOUR OWN with cancel_confirmation / dismiss_owner_question) (ids from gateQuestionId/blockedReason oq_ references, or the lane's chatId). An ANSWERED or DISMISSED gate is NOT a blocker: relay the owner's verbatim answer to the gated lane THIS sweep (send_chat_message), unblock the todo/goal, and encode the resolution into its standing instructions (schedule prompt / todo) — never restate it as pending. An owner answer given in ANY chat resolves the gate — propagate it the same wake. Apply rule halt.owner-words (your system prompt) to every "owner decision" a lane cites: An owner reply that was itself a QUESTION is not a decision — relay it as a question to answer, never as a ruling. A blocked todo/goal citing an owner decision, halt or rule but with NO owner question behind it (none open, and none the owner answered with a decision) is a LANE-authored gate, not an owner wait — unblock it this sweep (or re-file the exact decision with flag_owner_question if genuinely human-worthy) and never report it, or describe it to the owner, as the owner's halt or rule. A cited question the owner DID answer with a decision is acted on — an answer that says stop closes or drops the work with the oq_ id as evidence; it never stays blocked on the closed card.\n` +
    `4. RECONCILE before escalating or re-dispatching any stalled todo: check whether the work already landed (get_run_receipts on the assignee chat — a claimed push/PR/verify with no receipt did NOT happen; get_session_diff for what actually changed; an id you cannot place → resolve_id; feedback-ticket status, git log/PR state on the relevant repo, the assignee chat's transcript) and close landed items yourself with todo_update — escalate to the owner ONLY what is genuinely ambiguous or needs their decision.\n` +
    `5. check schedule health via get_chat_status's schedules field — a project whose cadence stopped or is overdue needs a nudge or an owner flag; a cadence SHORTER than the lane's typical run is a collision, not diligence (busy-skips or steers on a recurring row → the harness stretches it and tells the lane in [SCHEDULE STATE]; a project supervisor that keeps such a row is the one to nudge); a stock sweep that finds nothing three times in a row is backed off automatically — never re-arm one shorter "to stay on top of things"; maxRuns is a runaway bound, not a lifespan — machine schedules renew themselves at the cap, so a row near its cap is never a hand-off; a chat left with NO enabled schedules is DEAF — if it runs standing work or owns goal todos, re-arm a replacement NOW with schedule_message (a deferred re-arm written anywhere but an armed schedule does not exist). schedule_get reads a cadence's STORED prompt when its firings look wrong. DORMANT-BY-DESIGN: a project with NO active goals, open todos, live runs, or live watched resources is NOT deaf — it must get ZERO wakes; the goal-gate auto-parks its machine recurring schedules ('parked:dormant') and refuses new machine arms, so do NOT re-arm anything there ([FLEET LIVENESS] renders those projects 'dormant-by-design'). Event hooks — not heartbeats — are its wake path when new work appears. A parked, delayed or skipped machine turn is a decision-gate outcome (rule gate.outcome) — never a stopped cadence or a deaf lane; do not re-arm, re-send or ticket it.\n` +
    `6. ACT on the diff — a short specific steer, a dispatch, a re-arm, a todo close — and adjust your own cadence with update_schedule if needed. Every action is cited by the id its tool returned. ROUTING: a stalled lane living in a project with its OWN project supervisor is nudged THROUGH that supervisor first; if it has not acted within ~2h, nudge the lane directly. Direct nudges stay for ungrouped lanes and supervisor-less projects; peer lane-to-lane handoffs never route through supervisors.\n` +
    // HARNESS-RECEIPTS (2026-10-20): the model writes what moved and why; the harness writes the receipts.
    (supervisorHarnessReceiptsDisabled()
      ? `7. CLOSE the note with exactly one of: the single goal-framed line 'SWEEP: no-op — nothing moved on any project since last sweep' — one line, no headline, no tables — when the diff is empty and you took no action; OR 'ACTIONS TAKEN' — 1-3 actions, each ONE line with its receipt id. Deltas above follow your system prompt's Status note format — PER-PROJECT goal progress with ETAs in plain English first, technical ids collected in the closing Receipts line.`
      : `7. CLOSE the note with exactly one of: the single goal-framed line 'SWEEP: no-op — nothing moved on any project since last sweep' — one line, no headline, no tables — when the diff is empty and you took no action; OR, when you acted, what moved and why in plain English — the harness appends 'ACTIONS TAKEN (harness):' with every mutating call and its receipt id (never type that block yourself). Deltas above follow your system prompt's Status note format — PER-PROJECT goal progress with ETAs in plain English first, technical ids collected in the closing Receipts line.`)
  );
}

// ── Harness-side note classification (supervisor value telemetry) ─────────────

/**
 * Deterministic classification of a supervisor wake note, keyed on the exact
 * markers the prompts above mandate ('SWEEP: no-op' / 'WAKE: no-op' /
 * 'ACTIONS TAKEN'). Metrics must be HARNESS-written, never model-claimed:
 * the attention-watchdog sweep (fleet/attention-watchdog.service.ts,
 * scanSupervisorNotes) runs this over each newly persisted machine-wake note
 * and records loop_metrics rows (supervisor_noop / supervisor_action /
 * supervisor_note) — so "is the supervisor useful or looping?" becomes a
 * chartable ratio instead of a hunch.
 *
 * Precedence (deliberate deviation from a naive length-first check): an
 * explicit no-op marker wins outright; an explicit ACTIONS TAKEN receipt
 * marker beats the length heuristic (a one-line action WITH a receipt is an
 * action, not a no-op); only then does trivially-short (≤200 chars, i.e. a
 * one-liner with no markers) count as a no-op. Pure, total, never throws.
 */
export const SUPERVISOR_NOOP_NOTE_RE = /\b(?:SWEEP|WAKE):\s*no-op\b/i;
// Rollout watch 2026-09-14: the spark project supervisor closed its first wake
// with '**Actions (2, with receipts):**' — a paraphrase of the mandated marker
// that the strict regex filed as a plain note, so action:note read 0:1 while
// the audit log showed 4 sends + 1 schedule. Accept the receipt-count header
// shape too; the no-op marker still wins outright (precedence unchanged).
export const SUPERVISOR_ACTION_NOTE_RE = /\bACTIONS?\s+TAKEN\b|\bActions\s*\(\s*\d+/i;
// fixer 2026-09-27 (finding upward-chatter-4): the project supervisor's THIRD
// close shape — 'WAKE: reported — <what moved> sent to the Fleet Supervisor;
// no lane action' (supervisor-doctrine WAKE_REPORTED_MARKER; the sweep prompt's
// 'SWEEP: reported'). A one-line reported close is a plain NOTE: never a no-op
// (a goal moved), never an action (a report-up is not the qualifying action) —
// and never the ≤200-char no-op fall-through below.
export const SUPERVISOR_REPORTED_NOTE_RE = /\b(?:SWEEP|WAKE):\s*reported\b/i;
export const SUPERVISOR_NOOP_MAX_CHARS = 200;

export type SupervisorNoteKind = 'supervisor_noop' | 'supervisor_action' | 'supervisor_note';

export function classifySupervisorNote(content: unknown): SupervisorNoteKind {
  const text = typeof content === 'string' ? content.trim() : String(content ?? '').trim();
  if (!text) return 'supervisor_noop';
  // HARNESS-RECEIPTS-AND-CLAIMS (supervisor SOTA round 3, 2026-10-20): a line
  // the HARNESS appended ('ACTIONS TAKEN (harness):' / 'WAKE: reported
  // (harness: …' / 'WAKE: no-op (harness: …') wins over the model's own
  // markers — the finalize strips every model-typed copy, so a harness line in
  // a persisted note is the harness record (a model 'WAKE: no-op' above an
  // executed send no longer files the wake as a no-op). Kill switch
  // SUPERVISOR_HARNESS_RECEIPTS_DISABLED=1 (markers only, as before).
  const harnessKind = harnessLineKind(text);
  if (harnessKind) return harnessKind;
  if (SUPERVISOR_NOOP_NOTE_RE.test(text)) return 'supervisor_noop';
  if (SUPERVISOR_ACTION_NOTE_RE.test(text)) return 'supervisor_action';
  if (SUPERVISOR_REPORTED_NOTE_RE.test(text)) return 'supervisor_note';
  if (text.length <= SUPERVISOR_NOOP_MAX_CHARS) return 'supervisor_noop';
  return 'supervisor_note';
}

/** Full-autonomy upsert: EVERY grantable consequential tool + the max schedule cap.
 *  scheduleCap is overridable for OTHER supervisor-class lanes (the per-project
 *  supervisor passes 480); the fleet supervisor keeps the default — behavior
 *  unchanged for every existing caller. Exported for project-supervisor.service
 *  (same auto-grant path: no user turn exists at scaffold time). */
export async function grantFullAutonomy(chatId: string, userId: string, scheduleCap: number = MAX_SCHEDULE_CAP): Promise<void> {
  await prisma.chatAutonomy.upsert({
    where: { chatId },
    create: { chatId, userId, allowedTools: [...AUTONOMY_GRANTABLE_TOOLS], scheduleCap },
    update: { userId, allowedTools: [...AUTONOMY_GRANTABLE_TOOLS], scheduleCap },
  });
}

/**
 * Tools added to AUTONOMY_GRANTABLE_TOOLS AFTER supervisors already existed in
 * prod. Same union-heal philosophy as NEWLY_ADDED_STOCK_EVENT_TYPES: a grant
 * narrowed BEFORE a tool existed cannot have deliberately removed it, so
 * unioning only these never restores a deliberate removal. Without the heal,
 * a pre-2026-08-22 supervisor lacks dispatch_platform_task and every dispatch
 * stages a confirmation card instead of executing (ticket 7705fec2 deferred
 * finding — the staged-then-expired cards behind the phantom-dispatch class,
 * ticket f1cb73ff). send_to_instance joined the grantable set in Phase 5
 * (2026-08-30) — same union-heal applies.
 */
const NEWLY_ADDED_GRANTABLE_TOOLS = ['dispatch_platform_task', 'send_to_instance',
  // T3b (2026-09-24): the supervisor seat sets lanes' standing instructions and bootstraps repo-backed projects unattended.
  'set_chat_instructions', 'configure_workspace', 'import_repo',
  // Control tools (capability gap audit P0, 2026-09-24): added to
  // AUTONOMY_GRANTABLE_TOOLS the same day but MISSING here until ticket
  // 62365255 (2026-10-02) — every supervisor whose row predates 2026-09-24
  // (both prod seats) kept a 10-tool grant, so a machine stop_run of a
  // non-child lane staged an owner card 3×/day. Same union-heal philosophy
  // as the T3b entries: an existing row converges to include them.
  //
  // Precision (reviewer finding on this entry): the never-had-it vs
  // removed-later AMBIGUITY is inherent to union-heals and predates this
  // entry (dispatch_platform_task, send_to_instance, the T3b trio all had
  // it), but for THESE FIVE the re-add-on-deliberate-owner-removal is NEW
  // here: a row provisioned 2026-09-24..10-02 with all 15 tools could have
  // stop_run deliberately removed and every earlier heal respected that;
  // and a NON-listed tool's removal stays respected either way.
  ...CONTROL_TOOL_NAMES];

/**
 * Repair path for an EXISTING supervisor: re-grant in full only when the row
 * is MISSING — an owner may have deliberately narrowed the grant via
 * set_chat_autonomy, and ensure must not clobber that. An existing row is
 * only ever UNIONED with NEWLY_ADDED_GRANTABLE_TOOLS (see above).
 * scheduleCap: see grantFullAutonomy — only applied when the row is MISSING
 * (a fresh grant); an existing row's cap is never rewritten here. Exported for
 * project-supervisor.service.
 */
export async function repairAutonomyIfMissing(chatId: string, userId: string, scheduleCap: number = MAX_SCHEDULE_CAP): Promise<void> {
  const row = await prisma.chatAutonomy.findUnique({ where: { chatId }, select: { chatId: true, allowedTools: true } });
  if (!row) { await grantFullAutonomy(chatId, userId, scheduleCap); return; }
  // Defensive: never rewrite a grant we can't read faithfully (a malformed
  // allowedTools must not be replaced by a heal-only list).
  const tools = Array.isArray(row.allowedTools) ? (row.allowedTools as string[]) : null;
  if (!tools) return;
  const missing = NEWLY_ADDED_GRANTABLE_TOOLS.filter((t) => !tools.includes(t));
  if (missing.length) {
    await prisma.chatAutonomy.update({
      where: { chatId },
      data: { allowedTools: [...tools, ...missing] },
    });
    logger.info(`fleet supervisor: healed autonomy grant for ${chatId} — added ${missing.join(', ')}`);
  }
}

/**
 * Server-side STOCK-PROMPT heal for the 15-min attention-watchdog sweep
 * (rollout watch 2026-09-15, tick 12): repairStockPromptIfStale only ran
 * inside ensureFleetSupervisor — i.e. from UI/creation paths — so a doctrine
 * change reached every PROJECT supervisor within 15 min (healProjectSupervisors
 * rides the sweep) but the FLEET supervisor's system prompt stayed stale until
 * someone opened the Management page or created a chat (the 06:29Z probe: 5/5
 * project prompts healed, fleet 0/1). Same non-clobber rule: a customized
 * prompt (no stock opener) is never touched. Returns true when it rewrote.
 */
export async function healSupervisorStockPrompt(chatId: string): Promise<boolean> {
  const row = await prisma.crossModelChat.findUnique({
    where: { id: chatId },
    select: { id: true, isSupervisor: true, systemPrompt: true },
  });
  if (!row?.isSupervisor) return false;
  if (row.systemPrompt && !row.systemPrompt.startsWith(SUPERVISOR_PROMPT_OPENER)) return false;
  if (row.systemPrompt === buildFleetSupervisorPrompt()) return false;
  await repairStockPromptIfStale(row.id, row.systemPrompt);
  return true;
}

/**
 * Repair path for an EXISTING supervisor still carrying an OLD STOCK prompt:
 * the stored prompt starts with the stock opener but predates the CURRENT
 * version (the '[ACTION VERIFIER]' bullet is the 2026-08-22 phantom-verifier
 * marker — the preceding freshness markers were '## Evidence' and, before
 * that, '## Boundaries'), so rewrite it to the current stock prompt. A
 * CUSTOMIZED prompt (non-empty, no stock opener) is NEVER touched — same
 * non-clobber rule as repairAutonomyIfMissing. (The one user-facing edit path,
 * account-tools set_chat_instructions, refuses supervisor chats by WHERE
 * clause, so an opener match means stock.) Hardening review 2026-09-14
 * (parity with repairProjectStockPromptIfStale): a NULL/EMPTY prompt is not
 * a customization — it is a supervisor with no doctrine — so it heals to
 * stock too.
 */
async function repairStockPromptIfStale(chatId: string, systemPrompt: string | null): Promise<void> {
  if (systemPrompt && !systemPrompt.startsWith(SUPERVISOR_PROMPT_OPENER)) return;
  // Generalized full-text heal (feedback 4959bb1c): the old one-shot marker
  // check ('[ACTION VERIFIER]') meant later prompt updates — e.g. the Status
  // note format section — never reached already-provisioned supervisors
  // ("prompt updates don't stick"). An opener match means stock, so replacing
  // any non-current stock prompt is safe; customized prompts (no opener) are
  // NEVER touched.
  if (systemPrompt === buildFleetSupervisorPrompt()) return;
  await prisma.crossModelChat.update({
    where: { id: chatId },
    data: { systemPrompt: buildFleetSupervisorPrompt() },
  });
}

/**
 * Ensure the supervisor's ONE wildcard EventHook exists (sourceChatId NULL =
 * every chat owned by userId emits to it). New chats are covered automatically
 * — no per-chat wiring. Idempotent; the DB backs the ONE-per-target invariant
 * with a partial unique index, so a concurrent ensure converges on P2002.
 */
/**
 * Server-side heal entry (2026-08-24): ensureWildcardHook historically ran only
 * from the UI ensure path, so hook heals never applied until someone opened the
 * Management page. The attention-watchdog worker calls this every sweep —
 * idempotent, one findFirst + at most one update.
 */
export async function healSupervisorWildcardHook(supervisorChatId: string, userId: string): Promise<void> {
  await ensureWildcardHook(supervisorChatId, userId);
}

/**
 * STALE SCHEDULE REFERENCES in the wildcard hook's template (audit 2026-10-06
 * T3-10, fleet F12): the Fleet's hook 83b3cd9d carries a hand-written template
 * ("… full text in your sweep schedule 04e2e041") whose sweep was cancelled on
 * 2026-09-21 and replaced by b8cee3ad — every wake since pointed the model at
 * a dead row. The code never writes a template (stock = empty) and a custom
 * one is never otherwise touched, so the heal is narrow: only an id that
 * follows the word "schedule" AND resolves to one of THIS supervisor chat's
 * schedules that is no longer enabled (or to no schedule of the account at
 * all) is rewritten — to the live sweep's 8-char id (the enabled STOCK sweep,
 * else the chat's only enabled recurring row), else to a pointer at
 * get_chat_status. Everything else in the template is kept verbatim. Runs on
 * every ensure / watchdog heal, so prod heals on the next sweep. Kill switch
 * SUPERVISOR_HOOK_TEMPLATE_HEAL_DISABLED=1.
 */
const TEMPLATE_SCHEDULE_REF_RE = /\b(schedules?)(\s+[`"'(]*)([0-9a-f]{8})((?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?(?![0-9a-z])/gi;

/** 8-hex schedule-id prefixes the template names after "schedule". Pure. */
export function scheduleRefsInTemplate(template: string): string[] {
  const out = new Set<string>();
  for (const m of String(template ?? '').matchAll(TEMPLATE_SCHEDULE_REF_RE)) out.add(m[3].toLowerCase());
  return [...out];
}

/** Rewrite each stale ref (prefix → live 8-char id, or null → a get_chat_status pointer). Pure. */
export function rewriteStaleScheduleRefs(template: string, stale: ReadonlyMap<string, string | null>): string {
  return String(template ?? '').replace(TEMPLATE_SCHEDULE_REF_RE, (m: string, word: string, sep: string, prefix: string) => {
    const key = prefix.toLowerCase();
    if (!stale.has(key)) return m;
    const live = stale.get(key);
    return live ? `${word}${sep}${live}` : `${word} (current id: see get_chat_status → schedules)`;
  });
}

async function healStaleScheduleRefsInHook(existing: { id: string; promptTemplate?: string | null }, supervisorChatId: string, userId: string): Promise<void> {
  if (process.env.SUPERVISOR_HOOK_TEMPLATE_HEAL_DISABLED === '1') return;
  const template = String(existing.promptTemplate ?? '');
  if (!template.trim()) return;
  const refs = scheduleRefsInTemplate(template);
  if (!refs.length) return;
  try {
    const referenced = await prisma.codingSchedule.findMany({
      where: { userId, OR: refs.map((p) => ({ id: { startsWith: p } })) },
      select: { id: true, enabled: true, sessionId: true },
    });
    const stale = refs.filter((p) => {
      const hits = referenced.filter((r) => r.id.toLowerCase().startsWith(p));
      if (!hits.length) return true; // the referenced row is gone entirely
      if (hits.some((r) => r.enabled)) return false; // something it names is live
      return hits.every((r) => r.sessionId === supervisorChatId); // a dead row of THIS chat — never another chat's id
    });
    if (!stale.length) return;
    const live = await prisma.codingSchedule.findMany({
      where: { sessionId: supervisorChatId, kind: 'recurring', enabled: true },
      select: { id: true, prompt: true },
      orderBy: { createdAt: 'asc' },
    });
    const pick = live.find(isStockFleetSweep) ?? (live.length === 1 ? live[0] : null);
    const healed = rewriteStaleScheduleRefs(template, new Map(stale.map((p) => [p, pick ? pick.id.slice(0, 8) : null])));
    if (healed === template) return;
    await prisma.eventHook.update({ where: { id: existing.id }, data: { promptTemplate: healed } });
    await audit(userId, 'hook.update', {
      hookId: existing.id, targetChatId: supervisorChatId,
      reason: `stale schedule reference heal: ${stale.join(', ')} → ${pick ? pick.id.slice(0, 8) : 'get_chat_status pointer'} (audit 2026-10-06 T3-10)`,
    });
    recordLoopMetric({ kind: 'hook_template_healed', sessionId: supervisorChatId, value: stale.length, meta: { hookId: existing.id, stale, live: pick ? pick.id.slice(0, 8) : null } });
  } catch (err: any) {
    logger.warn(`fleet supervisor: wildcard-hook template heal failed for ${existing.id.slice(0, 8)}: ${err?.message}`);
  }
}

async function ensureWildcardHook(supervisorChatId: string, userId: string): Promise<void> {
  const existing = await prisma.eventHook.findFirst({
    where: { sourceChatId: null, targetChatId: supervisorChatId },
    select: { id: true, eventTypes: true, debounceSec: true, promptTemplate: true },
  });
  if (existing) {
    // Wake-economy debounce heal (owner 2026-09-04): every pre-fix supervisor
    // hook carries the schema default 60s — the window behind the
    // 02:13/02:15/02:23/02:26Z wake storm. Rewrite ONLY that exact legacy
    // value to SUPERVISOR_HOOK_DEBOUNCE_SEC; any other value is a deliberate
    // customization and is never touched. Runs on every ensure (chat/session
    // creation, sidebar load, watchdog sweep via healSupervisorWildcardHook),
    // so existing supervisors converge without a migration.
    if (existing.debounceSec === LEGACY_HOOK_DEBOUNCE_SEC || existing.debounceSec === PREVIOUS_SUPERVISOR_HOOK_DEBOUNCE_SEC) {
      try {
        await prisma.eventHook.update({
          where: { id: existing.id },
          data: { debounceSec: SUPERVISOR_HOOK_DEBOUNCE_SEC },
        });
        await audit(userId, 'hook.update', {
          hookId: existing.id, targetChatId: supervisorChatId,
          reason: `instant hooks (owner 2026-09-14): wildcard debounce ${existing.debounceSec}s → ${SUPERVISOR_HOOK_DEBOUNCE_SEC} (events coalesce only while the chat is busy)`,
          debounceSec: SUPERVISOR_HOOK_DEBOUNCE_SEC,
        });
      } catch (err: any) {
        logger.warn(`fleet supervisor: wildcard-hook debounce heal failed for ${existing.id.slice(0, 8)}: ${err?.message}`);
      }
    }
    // Stock event-set heal (forensics fix 2): an existing hook created under an
    // OLDER stock set silently misses newly added event types — emission
    // filters on eventTypes, so without this heal schedule_disabled would never
    // reach a pre-existing supervisor. Customized sets are never touched.
    const types = Array.isArray(existing.eventTypes) ? existing.eventTypes.map(String) : [];
    const isStockUniverse = types.length > 0 && types.every((t) => KNOWN_STOCK_EVENT_TYPE_UNIVERSE.has(t));
    const isExactLegacy = LEGACY_SUPERVISOR_HOOK_EVENT_SETS.some((set) => sameEventSet(types, set));
    // Exact legacy stock set → full rewrite to current stock. Otherwise, a
    // stock-universe set (possibly user-narrowed) gets ONLY the newly-added
    // safety types unioned in — never a restore of removed ones. A set with
    // any custom type is never touched.
    const healed = isExactLegacy
      ? [...SUPERVISOR_HOOK_EVENT_TYPES]
      : isStockUniverse
        ? [...new Set([...types, ...NEWLY_ADDED_STOCK_EVENT_TYPES])]
        : null;
    if (healed && !sameEventSet(types, healed)) {
      try {
        await prisma.eventHook.update({
          where: { id: existing.id },
          data: { eventTypes: healed },
        });
        await audit(userId, 'hook.update', {
          hookId: existing.id, targetChatId: supervisorChatId,
          reason: isExactLegacy ? 'supervisor stock event-set heal' : 'supervisor stock event-set union heal (newly added types)',
          eventTypes: healed,
        });
      } catch (err: any) {
        logger.warn(`fleet supervisor: wildcard-hook event-set heal failed for ${existing.id.slice(0, 8)}: ${err?.message}`);
      }
    }
    await healStaleScheduleRefsInHook(existing, supervisorChatId, userId);
    return;
  }
  try {
    const row = await prisma.eventHook.create({
      data: {
        userId,
        sourceChatId: null,
        targetChatId: supervisorChatId,
        eventTypes: [...SUPERVISOR_HOOK_EVENT_TYPES],
        // Wake economy (owner 2026-09-04): quiet events coalesce hourly;
        // alarm-class events bypass the debounce at delivery — see
        // SUPERVISOR_HOOK_DEBOUNCE_SEC's docblock for the wake-storm evidence.
        debounceSec: SUPERVISOR_HOOK_DEBOUNCE_SEC,
        createdVia: 'system:fleet-supervisor', // provenance (ticket dd3a19fa)
      },
    });
    await audit(userId, 'hook.auto_provision', {
      hookId: row.id, targetChatId: supervisorChatId, eventTypes: [...SUPERVISOR_HOOK_EVENT_TYPES],
      debounceSec: SUPERVISOR_HOOK_DEBOUNCE_SEC,
    });
  } catch (err: any) {
    // Lost the race with a concurrent ensure — the winner's row is identical
    // (same source set: "all chats"), so this is convergence, not failure.
    if (err?.code !== 'P2002') throw err;
  }
}

/**
 * Orphan wildcard-hook garbage collector (ticket a507e650) — deliberately
 * TIGHT predicate, because wildcard→any-target is a SHIPPED FEATURE, not
 * supervisor machinery: subscribeHook documents "when sourceChatId is
 * omitted/empty/null, [subscribe] to EVERY chat the user owns", its target
 * validation is only write-access (never supervisor-ness), and the supervisor
 * agent itself can hook_subscribe a wildcard onto any chat it can write. The
 * DB allows ONE wildcard PER TARGET (partial unique index), so a user may
 * legally hold several wildcards aimed at different plain chats — every one
 * of them deliberate, and none of them may ever be touched here.
 *
 * A hook is GC-eligible ONLY when it is PROVABLY system-provisioned AND
 * orphaned — ALL FOUR conditions must hold:
 *   1. sourceChatId NULL (wildcard) and enabled (the DB query filter);
 *   2. targetChatId ∉ the user's CURRENT isSupervisor chats;
 *   3. the HOOK looks stock-provisioned: promptTemplate trims to empty AND
 *      every eventType ∈ KNOWN_STOCK_EVENT_TYPE_UNIVERSE (a custom template
 *      or any type outside the stock universe = user-authored → skip);
 *   4. the TARGET CHAT was once a supervisor: its systemPrompt starts with
 *      SUPERVISOR_PROMPT_OPENER — a system-written identity marker (no
 *      user-facing endpoint edits a chat's systemPrompt). A MISSING target
 *      row is skipped defensively → never an orphan.
 * healSupervisorWildcardHook only ever touches the hook targeting the CURRENT
 * supervisor, so a stock wildcard left pointing at a FORMER supervisor
 * (isSupervisor since flipped off) never heals and keeps firing every chat's
 * events into a non-supervisor target forever — that single drift class is
 * what this GC reaps. Everything failing condition 3 or 4 is user-deliberate.
 *
 * The tightness is load-bearing: a custom hook must be UNABLE to round-trip
 * through here. If a user-deliberate hook were disabled, the owner re-enabling
 * it via hook_update would match the enabled:true filter again on the next
 * 15-min sweep and be re-disabled forever — an unwinnable fight loop plus
 * hook.orphan_gc audit spam. With this predicate the GC is structurally blind
 * to custom hooks, so enable/disable round-trips are impossible for them.
 *
 * DISABLES, never deletes (hard-delete lesson bd954d27) — the row stays for
 * the owner to inspect, and every disable writes a 'hook.orphan_gc' Activity
 * audit row. Idempotent by construction (a disabled stock orphan fails the
 * enabled:true filter on the next sweep). Returns the count disabled THIS call.
 */
export async function disableOrphanWildcardHooks(userId: string): Promise<number> {
  if (!userId) return 0;
  const supervisors = await prisma.crossModelChat.findMany({
    where: { userId, isSupervisor: true },
    select: { id: true },
  });
  const supervisorIds = new Set(supervisors.map((s) => s.id));
  const wildcards = await prisma.eventHook.findMany({
    where: { userId, sourceChatId: null, enabled: true },
    select: { id: true, targetChatId: true, promptTemplate: true, eventTypes: true },
  });
  // Orphan CANDIDATES: the target drifted out of the current supervisor set
  // AND the hook itself looks stock-provisioned (empty template + every event
  // type inside the stock universe). Any custom content → deliberate → skip.
  const candidates = wildcards.filter(
    (h) =>
      !supervisorIds.has(h.targetChatId) &&
      String(h.promptTemplate ?? '').trim() === '' &&
      Array.isArray(h.eventTypes) &&
      h.eventTypes.every((t) => KNOWN_STOCK_EVENT_TYPE_UNIVERSE.has(String(t))),
  );
  if (candidates.length === 0) return 0;
  // A candidate is only provably system-provisioned when its TARGET was once
  // a supervisor — i.e. the chat carries the system-written prompt opener.
  // One batch fetch, filtered in JS; a missing target row → NOT an orphan.
  const targets = await prisma.crossModelChat.findMany({
    where: { id: { in: candidates.map((h) => h.targetChatId) } },
    select: { id: true, systemPrompt: true },
  });
  const formerSupervisorIds = new Set(
    targets
      .filter((c) => typeof c.systemPrompt === 'string' && c.systemPrompt.startsWith(SUPERVISOR_PROMPT_OPENER))
      .map((c) => c.id),
  );
  const orphans = candidates.filter((h) => formerSupervisorIds.has(h.targetChatId));
  let disabled = 0;
  for (const hook of orphans) {
    // Per-hook isolation: one failing row must not block the rest of the GC.
    try {
      await prisma.eventHook.update({ where: { id: hook.id }, data: { enabled: false } });
      disabled += 1;
      await audit(userId, 'hook.orphan_gc', {
        hookId: hook.id,
        targetChatId: hook.targetChatId,
        reason: 'stock wildcard hook targets a former supervisor chat (no longer isSupervisor)',
      });
      logger.info(
        `fleet supervisor: orphan wildcard hook ${hook.id.slice(0, 8)} disabled ` +
        `(stock hook targets former supervisor ${hook.targetChatId.slice(0, 8)})`,
      );
    } catch (err: any) {
      logger.warn(`fleet supervisor: orphan wildcard-hook GC failed for ${hook.id.slice(0, 8)}: ${err?.message}`);
    }
  }
  return disabled;
}

/** A row is the STOCK sweep iff its prompt carries the stock opener — the only
 *  discriminator (promptSetBy 'system' is stamped on every renewOnExhaustion
 *  successor, including successors of the supervisor's own machine rows). */
function isStockFleetSweep(s: { prompt?: unknown }): boolean {
  return typeof s.prompt === 'string' && s.prompt.startsWith(SWEEP_PROMPT_OPENER);
}

/**
 * Ensure the supervisor's recurring sweep schedule exists. Only an ENABLED
 * recurring row is respected — the sweeper disables rows at maxRuns/expiry, so
 * a dead sweep must be recreated here or supervision silently stops ~41 days in.
 * A concurrent first-ensure can duplicate the sweep (find-then-create, no
 * unique constraint possible — users may stack recurring schedules on their own
 * chats), so dedupe on read: keep the earliest enabled STOCK row, delete the
 * other STOCK rows.
 *
 * Hardening review 2026-09-14 (mirrors project-supervisor.service
 * ensureProjectSweepSchedule): the dedupe used to treat ANY enabled recurring
 * row as a duplicate sweep and hard-deleted the supervisor's own machine-armed
 * re-arms on every ensure (prod: row b96b381e, 5 runs, killed 'obsolete' on
 * 2026-09-03 — the bd954d27 class again). Rows are now partitioned by the
 * stock opener: only stock rows dedupe/heal; non-stock rows are never deleted
 * or rewritten. The stock sweep is created iff no stock row is enabled AND no
 * OWNER-authored (promptSetBy 'user' / legacy NULL) recurring row stands in
 * for it — the owner's live fleet chat c0e22e36 runs a customized sweep with
 * no opener and 383 runs; arming a stock sweep beside it would double the
 * cadence. Machine/system-authored monitors never mask a dead stock sweep.
 */
async function ensureSweepSchedule(supervisorChatId: string, userId: string): Promise<void> {
  const sweeps = await prisma.codingSchedule.findMany({
    where: { sessionId: supervisorChatId, kind: 'recurring', enabled: true },
    select: { id: true, prompt: true, kind: true, runsCount: true, promptSetBy: true },
    orderBy: { createdAt: 'asc' },
  });
  const stock = sweeps.filter(isStockFleetSweep);
  // ACCOUNT DORMANCY (autonomy loop #18, 2026-09-21): four foreign-account
  // Fleet Supervisors swept accounts with no coding run in 8–11 days — 17
  // no-op wakes/day. A dormant account (dormancy-gate evaluateAccountDormancy)
  // PARKS its stock sweep (enabled:false, 'parked:dormant'); the fire-time
  // gate in schedule.service does the same on the next tick. The wildcard
  // hook stays armed (zero-token wake path); the resume below re-arms the
  // parked row on the account's next project/chat/session creation.
  let dormancy: { dormant: boolean; reason: string } | null = null;
  try { dormancy = await evaluateAccountDormancy(userId, { excludeChatId: supervisorChatId }); } catch { dormancy = null; }
  if (dormancy?.dormant) {
    let parkedLanded = 0;
    for (const row of stock) {
      // 37fa747d (same fix as the project lane's park): emit
      // schedule_disabled(parked_dormant) ONLY when the park write landed —
      // the event is ALARM-class and its "It stays parked" text must never
      // announce a row that never parked.
      let parkedOk = false;
      try {
        await prisma.codingSchedule.update({
          where: { id: row.id },
          data: { enabled: false, lastStatus: DORMANT_LAST_STATUS, cancelledBy: 'machine', disabledAt: new Date() },
        });
        parkedOk = true;
      } catch (err: any) {
        logger.warn(`fleet supervisor: dormancy park failed for ${row.id.slice(0, 8)}: ${err?.message}`);
      }
      if (parkedOk) {
        parkedLanded += 1;
        try {
          const { emitScheduleDisabled } = await import('../coding/schedule.service');
          await emitScheduleDisabled({ id: row.id, sessionId: supervisorChatId, kind: row.kind }, 'parked_dormant', row.runsCount ?? 0, { detail: dormancy.reason }).catch(() => {});
        } catch { /* best-effort — the park write above is the durable record */ }
      }
      recordLoopMetric({ kind: LOOP_METRIC_KINDS.FLEET_SWEEP_DORMANCY, sessionId: supervisorChatId, meta: { action: parkedOk ? 'parked' : 'park_write_failed', scheduleId: row.id } });
    }
    if (stock.length) logger.info(`fleet supervisor: parked ${parkedLanded}/${stock.length} stock sweep(s) on ${supervisorChatId.slice(0, 8)} — ${dormancy.reason}`);
    return;
  }
  if (stock.length > 0) {
    if (stock.length > 1) {
      const doomed = stock.slice(1);
      // Ticket bd954d27: this deleteMany is the ONLY app path that hard-deletes
      // ENABLED recurring schedules — and it used to leave nothing but a log
      // line, the exact "silent killer" of the 18h monitor outage. Every
      // doomed row emits ONE schedule_disabled event ('obsolete') BEFORE the
      // delete, so the owner/supervisor can see what removed it. Best-effort
      // via the dynamic-import seam — never blocks the dedupe itself.
      try {
        const { emitScheduleDisabled } = await import('../coding/schedule.service');
        for (const s of doomed) {
          await emitScheduleDisabled({ id: s.id, sessionId: supervisorChatId, kind: s.kind }, 'obsolete', s.runsCount ?? 0).catch(() => {});
          // Review Finding 2 (commit 5d327419): the hook event's source IS the
          // supervisor chat, so self-loop suppression drops it — no durable
          // consumer. The Activity row is the owner-visible audit trail the
          // ticket asks for (never hard-delete without an attributable row).
          await audit(userId, 'schedule_hard_deleted', {
            scheduleId: s.id, sessionId: supervisorChatId, kind: s.kind,
            runsCount: s.runsCount ?? 0, reason: 'obsolete', source: 'sweep-dedupe',
          });
        }
      } catch (err: any) {
        logger.warn(`fleet supervisor: schedule_disabled emission failed before dedupe (non-fatal): ${err?.message}`);
      }
      await prisma.codingSchedule.deleteMany({
        where: { id: { in: doomed.map((s: any) => s.id) } },
      });
      logger.warn(`fleet supervisor: deduped ${doomed.length} duplicate STOCK sweep schedule(s) on ${supervisorChatId.slice(0, 8)} (${sweeps.length - stock.length} non-stock recurring row(s) untouched)`);
    }
    // Stock sweep-prompt heal (forensics fix 3c — the repairStockPromptIfStale
    // pattern): an existing sweep row baked an OLDER stock prompt in at
    // creation, so a new duty line (schedule health) never reaches existing
    // supervisors without this. Only the stock keeper is ever rewritten.
    const keeper = stock[0];
    const current = buildFleetSweepPrompt();
    if (keeper.prompt !== current) {
      await prisma.codingSchedule.update({ where: { id: keeper.id }, data: { prompt: current, promptSetBy: 'system' } })
        .catch((err: any) => logger.warn(`fleet supervisor: sweep-prompt heal failed for ${keeper.id.slice(0, 8)}: ${err?.message}`));
    }
    return;
  }
  // No enabled stock sweep. An OWNER-authored customized recurring row IS the
  // supervisor's cadence (c0e22e36) — never arm a stock sweep beside it.
  // Machine/system-authored rows are the supervisor's own monitors and do not
  // count, so a dead stock sweep behind one is still recreated.
  if (sweeps.some((s) => !isStockFleetSweep(s) && (s.promptSetBy === 'user' || s.promptSetBy == null))) return;
  const now = Date.now();
  // RESUME a dormancy-parked stock sweep (loop #18) instead of creating a
  // second row: the account has live work again (this ensure runs on its
  // project / chat / session creation).
  let parked: { id: string; runsCount: number | null } | null = null;
  try {
    parked = await prisma.codingSchedule.findFirst({
      where: { sessionId: supervisorChatId, kind: 'recurring', enabled: false, lastStatus: DORMANT_LAST_STATUS },
      orderBy: { createdAt: 'desc' },
      select: { id: true, runsCount: true },
    });
  } catch { parked = null; } // partial mocks / a read hiccup → create as before
  if (parked) {
    await prisma.codingSchedule.update({
      where: { id: parked.id },
      data: {
        enabled: true, lastStatus: 'resumed', cancelledBy: null, disabledAt: null,
        nextRunAt: new Date(now + SWEEP_INTERVAL_SEC * 1000),
        expiresAt: new Date(now + SWEEP_LIFETIME_MS),
        prompt: buildFleetSweepPrompt(), promptSetBy: 'system',
      },
    }).catch((err: any) => logger.warn(`fleet supervisor: dormancy resume failed for ${parked.id.slice(0, 8)}: ${err?.message}`));
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.FLEET_SWEEP_DORMANCY, sessionId: supervisorChatId, meta: { action: 'resumed', scheduleId: parked.id } });
    logger.info(`fleet supervisor: resumed the dormancy-parked stock sweep ${parked.id.slice(0, 8)} on ${supervisorChatId.slice(0, 8)} — the account has live work again`);
    return;
  }
  await prisma.codingSchedule.create({
    data: {
      sessionId: supervisorChatId,
      userId,
      prompt: buildFleetSweepPrompt(),
      kind: 'recurring',
      intervalSec: SWEEP_INTERVAL_SEC,
      nextRunAt: new Date(now + SWEEP_INTERVAL_SEC * 1000),
      maxRuns: SWEEP_MAX_RUNS,
      expiresAt: new Date(now + SWEEP_LIFETIME_MS),
      enabled: true,
      promptSetBy: 'system', // framework-authored — never counts as autonomous drift
    },
  });
}

/**
 * Ensure the owner's pinned Fleet Supervisor chat exists (idempotent). Creates
 * the chat + full-autonomy grant + sweep schedule + wildcard hook on first
 * call, and self-heals a missing autonomy row / hook / sweep on later calls.
 * Returns the supervisor chat, or null when it was skipped (child account) or
 * failed (logged — NEVER throws into a chat/session creation path).
 */
export async function ensureFleetSupervisor(userId: string): Promise<any | null> {
  try {
    if (!userId) return null;

    // Kid guard: child accounts are confined to the locked-down kid pipeline —
    // no autonomous fleet agents for them.
    const user = await prisma.user
      .findUnique({ where: { id: userId }, select: { isChild: true } })
      .catch(() => null);
    if (user?.isChild) {
      logger.info(`fleet supervisor: skipped for child account ${userId.slice(0, 8)}`);
      return null;
    }

    // 1. Already there? Self-heal the pieces that can drift and return it.
    const existing = await prisma.crossModelChat.findFirst({
      where: { userId, isSupervisor: true },
      select: { id: true, userId: true, title: true, titlePinned: true, projectId: true, systemPrompt: true },
    });

    // SUPERVISOR OFF SWITCH (owner 2026-09-26; platform/supervisor-switch.ts):
    // while the Fleet Supervisor is switched off, ensure is READ-ONLY — the
    // existing chat is returned untouched (no autonomy/prompt/hook/sweep heal,
    // so a dead sweep is not re-armed) and NO chat is created for an owner
    // who has none (one rate-limited skip row, source 'ensure'). Turning the
    // switch back on lets the next ensure heal and arm as before. Fail-open:
    // a read error inside the switch reads as ON.
    if (!(await getFleetSupervisorEnabled().catch(() => true))) {
      if (existing) return existing;
      recordSupervisorSwitchSkip({ target: 'fleet', source: 'ensure' });
      logger.info(`fleet supervisor: switch is OFF — not provisioning a supervisor for owner ${userId.slice(0, 8)}`);
      return null;
    }

    if (existing) {
      // Heal title/project drift: the supervisor is a pinned system row with a
      // fixed label and must stay UNGROUPED (it spans the fleet). Writes are
      // guarded elsewhere (updateChat + auto-title), but rows that drifted
      // before those guards land get repaired here on the next ensure.
      // Session titles (fixer 2026-09-27): the heal compares the GOAL half to
      // the label — the harness's step half ('· sweep', '· idle since …') is
      // kept, a human-pinned title is never overwritten, and a drifted title
      // heals to the bare label (healSupervisorTitle).
      const healedTitle = healSupervisorTitle(existing, SUPERVISOR_TITLE);
      if (healedTitle || existing.projectId) {
        await prisma.crossModelChat.update({
          where: { id: existing.id },
          data: { ...(healedTitle ? { title: healedTitle } : {}), ...(existing.projectId ? { project: { disconnect: true } } : {}) },
        }).catch(err => logger.warn(`fleet supervisor: title/project heal failed for ${existing.id.slice(0, 8)}: ${err?.message}`));
      }
      await repairAutonomyIfMissing(existing.id, existing.userId);
      await repairStockPromptIfStale(existing.id, existing.systemPrompt);
      await ensureWildcardHook(existing.id, existing.userId);
      await ensureSweepSchedule(existing.id, existing.userId);
      return existing;
    }

    // 2. Create the pinned chat (ungrouped — it spans the whole fleet). A
    //    partial unique index (one supervisor per OWNER) backs this: a
    //    concurrent ensure loses the race with a P2002 and converges on the
    //    winner's row.
    let chat;
    try {
      chat = await prisma.crossModelChat.create({
        data: {
          title: SUPERVISOR_TITLE,
          // Owner 2026-09-26: supervisors default to Auto too — their wakes run
          // through the compute policy with the L2 preset as the fail-open
          // fallback (chat-agent.service machinePresetPlan), not a pinned level.
          mode: 'auto',
          isSupervisor: true,
          systemPrompt: buildFleetSupervisorPrompt(),
          user: { connect: { id: userId } },
        },
      });
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err; // outer wrapper logs + returns null
      const winner = await prisma.crossModelChat.findFirst({
        where: { userId, isSupervisor: true },
      });
      if (!winner) throw err; // index fired on something else — surface it
      await repairAutonomyIfMissing(winner.id, winner.userId);
      await repairStockPromptIfStale(winner.id, winner.systemPrompt);
      await ensureWildcardHook(winner.id, winner.userId);
      await ensureSweepSchedule(winner.id, winner.userId);
      return winner;
    }

    // 3. Full fleet autonomy (every grantable consequential tool, max cap).
    await grantFullAutonomy(chat.id, userId);

    // 4. ONE recurring sweep schedule (2h).
    await ensureSweepSchedule(chat.id, userId);

    // 5. ONE wildcard hook — every chat the owner has (present and future)
    //    emits to the supervisor with zero per-chat wiring.
    await ensureWildcardHook(chat.id, userId);

    logger.info(
      `fleet supervisor: ensured chat ${chat.id.slice(0, 8)} for owner ${userId.slice(0, 8)} (wildcard hook armed)`,
    );
    return chat;
  } catch (err: any) {
    logger.warn(`fleet supervisor: ensure failed for owner ${String(userId).slice(0, 8)}: ${err?.message}`);
    return null;
  }
}

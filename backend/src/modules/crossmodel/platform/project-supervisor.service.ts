/**
 * Per-Project Supervisor agents (owner directives 2026-09-13 23:15Z + 23:34Z —
 * OPT-IN, pause-never-delete).
 *
 * A project supervisor = ONE crossmodel_chats row per (owner, project) with
 * isProjectSupervisor=true + projectId set, a stock systemPrompt, FULL
 * ChatAutonomy (scheduleCap 480 via supervisor.service's exports), ONE 60-min
 * sweep schedule, and ONE PROJECT-SCOPE EventHook (sourceChatId NULL +
 * projectId set — only chats IN this project emit to it; see hooks.service).
 * It scaffolds ONLY when the project's projectSupervisorEnabled flag is true.
 * Toggling the flag OFF = pause (hooks + schedules disabled), NEVER delete —
 * the chat, transcript, autonomy grant, and state doc are all kept.
 *
 * The fleet `supervised` flag is untouched by all of this: project-scope hooks
 * are deliberate plumbing and are NOT filtered by project.supervised === false
 * (their lifecycle is the enabled flag + this toggle).
 *
 * Import discipline (mirrors supervisor.service): this module statically
 * imports supervisor.service → autonomy.service → crossmodel.service, so it
 * must only ever be loaded via DYNAMIC import from its call sites
 * (platform.service update/archive, the attention watchdog) — a static edge
 * back would close a load-time cycle.
 *
 * Failure posture: EVERY export catches + logs and NEVER throws — a project
 * supervisor hiccup must not fail the update/archive/sweep that triggered it.
 * Everything is idempotent (find-before-create on every row + the partial
 * unique index crossmodel_chats_one_project_supervisor_per_project backing the
 * create race), so a retry or a double-fire converges instead of duplicating.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import {
  findFleetSupervisorChat,
  grantFullAutonomy,
  repairAutonomyIfMissing,
} from './supervisor.service';
import { DORMANT_LAST_STATUS, evaluateProjectDormancy } from '../coding/dormancy-gate.service';
import { PROJECT_SWEEP_INTERVAL_SEC, PROJECT_SWEEP_MAX_INTERVAL_SEC, projectSweepFloorHealOwnerRowsEnabled, latestIntervalAttribution } from '../coding/schedule-cadence';

/** Every stock project-supervisor prompt opens with this string — the
 *  system-written identity marker the stock-prompt heal keys on (the
 *  supervisor.service SUPERVISOR_PROMPT_OPENER pattern). Hardening review
 *  2026-09-14: the ONE user-facing path that edits a chat's systemPrompt
 *  (account-tools set_chat_instructions, 2026-09-08) refuses supervisor chats
 *  by WHERE-clause (isSupervisor:false + isProjectSupervisor:false), so an
 *  opener match still means stock; a NULL/empty prompt on a lane can only be
 *  damage (never a customization) and heals back to stock. */
export const PROJECT_SUPERVISOR_PROMPT_OPENER = 'You are the Project Supervisor';

/**
 * Project-supervisor preflight 2026-09-14: the STANDING OWNER DIRECTIVE header
 * every supervisor prompt body carries (system prompt AND sweep prompt — each
 * sweep firing is a fresh turn and must not lose the doctrine). The fleet
 * prompt (supervisor.service buildFleetSupervisorPrompt) states the same
 * directives inline in its Gate-policy + Owner-question-triage sections; this
 * constant is the single shareable form of them. It lives HERE (not in
 * supervisor.service) only because this module already imports
 * supervisor.service statically and a static edge back would close a
 * load-time cycle — the durable home is a leaf `supervisor-doctrine.ts` both
 * services import (see docsNotes CROSS-FILE). Every phrase below is quoted
 * from an owner directive; the test pins the phrases the fleet body also
 * carries, so doctrine drifts in one place cannot go unnoticed in the other.
 *
 * Observe/route/coalesce only: this header adds NO refusal, gate, or owner
 * card — it REMOVES the latent cost-card class and tells the lane to answer.
 */

/**
 * Project-supervisor preflight 2026-09-14: the PRECEDENCE rule among the three
 * dispatch authorities (owner > project supervisor inside its project > fleet
 * supervisor across projects). Shared by the system prompt and the sweep
 * prompt so a fresh sweep turn can never re-derive a narrower version. Peer
 * lanes keep messaging each other DIRECTLY — no code restricts
 * send_chat_message and no prompt text may either.
 */

import { PROJECT_SWEEP_PROMPT_OPENER } from './supervisor-doctrine';
import { supervisorHarnessReceiptsDisabled } from './harness-receipts';
// Layered prompts (2026-09-27): opener → generic core doctrine → live harness
// facts → THIS project's brief (project-brief.loader.ts) → the project role
// profile.
import { composePrompt, isLayeredPrompt } from './prompt-layers';
import { coreDoctrine } from './core-doctrine';
import { frameworkFactsBlock } from './framework-facts';
import { projectSupervisorRoleProfile } from './role-profiles';
import { minimalProjectBrief, type ProjectBrief } from './project-brief.model';
import { loadProjectBrief } from './project-brief.loader';
import { modelToolName } from '../coding/tool-scope';
// Supervisor OFF switch (owner 2026-09-26): while the project-supervisors
// switch is off, ensure returns the existing lane untouched and scaffolds none.
import { getProjectSupervisorsEnabled, recordSupervisorSwitchSkip } from './supervisor-switch';
// Session titles (2026-09-27): the title heal keeps the harness step half.
import { healSupervisorTitle } from './session-titles';

/** The pinned chat's title is '<project name> Supervisor', truncated ~80. */
export function projectSupervisorTitle(projectName: string): string {
  const name = String(projectName ?? '').trim() || 'Project';
  return `${name} Supervisor`.slice(0, 80);
}

/**
 * Project-scope hook debounce: 600s. The project lane is chattier than the
 * fleet wildcard (every in-project run completes into ONE chat), but cheaper
 * than the fleet's 3600s window allows — a project supervisor is the
 * project's first responder; the 60-min sweep is the backstop. ALARM-class
 * events (attention_needed / run_failed / goal_blocked / schedule_disabled)
 * bypass the debounce at delivery either way (hooks.service deliverHookGroup).
 */
// Owner 2026-09-14 ("make hooks instant — no idle time"): 0. Wake economy no
// longer needs a window — events arriving while the supervisor is mid-run
// coalesce into ONE digest wake at run end (busy park + run-end drain), and an
// idle supervisor should wake the moment something happens.
export const PROJECT_SUPERVISOR_HOOK_DEBOUNCE_SEC = 0;
/** The pre-2026-09-14 stock value — healed to 0 on ensure; any other value is a customization and never touched. */
export const LEGACY_PROJECT_SUPERVISOR_HOOK_DEBOUNCE_SEC = 600;

/**
 * Schedule cap for the project supervisor's machine runs (owner directive:
 * generous caps). Below the fleet's 1440 but far above the 48 default — an
 * hourly sweep + hook wakes + follow-ups fit with headroom.
 */
export const PROJECT_SUPERVISOR_SCHEDULE_CAP = 480;

/**
 * Event types the project-scope hook subscribes to: the fleet supervisor's
 * stock set PLUS todo_done (the project lane owns the project's todo ledger —
 * a worker finishing an assigned todo is exactly its signal; the fleet omits
 * it as too chatty at fleet scale). schedule_near_cap (ticket b4d1096c): a
 * lane's recurring schedule at ≥90% of its run cap / lifetime is THIS lane's
 * re-arm cue — the project supervisor owns its lanes' cadences.
 */
export const PROJECT_SUPERVISOR_HOOK_EVENT_TYPES = [
  'run_completed', 'run_failed', 'attention_needed', 'goal_blocked',
  'schedule_cap_skipped', 'schedule_disabled', 'todo_done', 'schedule_near_cap',
  // CI-WATCH (2026-10-20, coding/ci-watch.service.ts): a lane's pushed commit
  // stayed RED after the lane's own wake. hooks.service writes this row only
  // when the lane is not live (or the ci-watch escalation says the lane-first
  // leg already ran) — lane first, then the project supervisor.
  'ci_failed',
];

/** CI-WATCH kill switch (coding/ci-watch.service.ts ciWatchDisabled — read here without importing the cron). */
const ciWatchOff = (): boolean => process.env.CI_WATCH_DISABLED === '1';

/**
 * The stock set a NEW project hook is created with: every type above, minus
 * ci_failed while CI_WATCH_DISABLED=1 (the next ensure after the switch is
 * cleared unions it back in through the heal below).
 */
export function stockProjectHookEventTypes(): string[] {
  return ciWatchOff() ? PROJECT_SUPERVISOR_HOOK_EVENT_TYPES.filter((t) => t !== 'ci_failed') : [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES];
}

/**
 * Types added to the stock set AFTER project supervisors already existed in
 * prod. The ensure unions ONLY these into stock-universe hooks (fleet heal
 * parity — a type the lane deliberately REMOVED stays removed unless it is
 * this safety class; a hook carrying any custom type is never touched).
 * ci_failed (CI-WATCH 2026-10-20) joins only while CI_WATCH_DISABLED is unset.
 */
function projectNewlyAddedEventTypes(): string[] {
  return ciWatchOff() ? ['schedule_near_cap'] : ['schedule_near_cap', 'ci_failed'];
}

/**
 * The universe of event types a STOCK-era project hook could contain. Equal
 * to the current stock set today (the lane is new — no legacy sets yet); kept
 * as a separate constant so a future stock addition gets the fleet's
 * universe/union-heal shape for free.
 */
const PROJECT_STOCK_EVENT_TYPE_UNIVERSE = new Set(PROJECT_SUPERVISOR_HOOK_EVENT_TYPES);

/**
 * A STOCK-universe event set (every type stock — no custom type): the hooks
 * the ensure heals, and (CI-WATCH review fix 2026-10-20) the only project
 * hooks hooks.service's lane-first ci_failed gate covers — a hand-customized
 * hook keeps its pre-ci-watch delivery. Pure.
 */
export function isStockProjectHookEventSet(types: readonly string[]): boolean {
  return types.length > 0 && types.every((t) => PROJECT_STOCK_EVENT_TYPE_UNIVERSE.has(t));
}

/** Sweep cadence + lifetime ceiling, mirroring the fleet sweep's guardrails.
 *  wake-cadence-3 (2026-09-27 tt-rd audit): the cadence constant moved to the
 *  dependency-free coding/schedule-cadence.ts leaf (2 h — was 60 min since
 *  #741) so schedule.service can floor machine update_schedule calls on stock
 *  sweeps and back a no-op sweep off without importing this module (cycle). */
export { PROJECT_SWEEP_INTERVAL_SEC, PROJECT_SWEEP_MAX_INTERVAL_SEC };
const PROJECT_SWEEP_MAX_RUNS = 500;
const PROJECT_SWEEP_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Stock marker for the sweep prompt — every stock version opens with this
 *  (the supervisor.service SWEEP_PROMPT_OPENER pattern); the schedule ensure
 *  keys its stale-prompt heal on it, so a user-customized prompt is never
 *  touched. DEFINED in supervisor-doctrine.ts (leaf) since 2026-09-18 so the
 *  fire-time doctrine rebuild can key on it without an import cycle —
 *  re-exported here. */
export { PROJECT_SWEEP_PROMPT_OPENER };

/** Best-effort audit trail (Activity, resource 'platform') — mirrors
 *  supervisor.service / hooks.service. Pause-never-delete makes the pause /
 *  GC writes the lifecycle: they must be as attributable as a deletion. */
async function audit(userId: string, action: string, metadata?: Record<string, any>): Promise<void> {
  try {
    await prisma.activity.create({
      data: { userId, action, resource: 'platform', ...(metadata ? { metadata } : {}) },
    });
  } catch (err: any) {
    logger.warn(`project supervisor audit write failed (${action}): ${err.message}`);
  }
}

/**
 * wake-cadence-3 (fixer 2026-09-27): who set this schedule's interval last —
 * true when the newest ATTRIBUTED interval write was the owner's (Activity
 * `schedule.update` with metadata.source 'owner-interval', written by
 * schedule.service updateScheduleForUser for the Schedules-tab REST edit and
 * for a real user turn), false when a machine turn / the harness set it or
 * nothing is attributed (legacy rows heal as before), null on a read error —
 * the caller then SKIPS the heal this pass rather than override blindly; the
 * next 15-min pass retries.
 */
async function stockSweepIntervalOwnerSet(userId: string, scheduleId: string): Promise<boolean | null> {
  try {
    const rows = await prisma.activity.findMany({
      where: { userId, resource: 'platform', action: 'schedule.update', metadata: { path: ['scheduleId'], equals: scheduleId } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { metadata: true },
    });
    return latestIntervalAttribution((rows ?? []).map((r: any) => (r?.metadata ?? null) as Record<string, unknown> | null)) === 'owner';
  } catch {
    return null;
  }
}

/** Order-insensitive event-set equality (defensive against non-array rows). */
function sameEventSet(a: unknown, b: string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const sa = [...a].map(String).sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * The project supervisor chat's system prompt (stored on the chat row at
 * creation). Project-scoped: it names its ONE project and reports UP to the
 * Fleet Supervisor rather than to the owner.
 */
export function buildProjectSupervisorPrompt(opts: {
  projectName: string;
  projectId: string;
  fleetSupervisorChatId: string | null;
  /** THIS project's brief (project-brief.loader.ts). Omitted → name + id only
   *  (renders byte-identically to the old name+id scaffold for an empty project). */
  brief?: ProjectBrief | null;
}): string {
  const { projectName, projectId, fleetSupervisorChatId } = opts;
  const brief = opts.brief && opts.brief.id === projectId ? opts.brief : minimalProjectBrief(projectName, projectId);
  return composePrompt({
    role: 'project_supervisor',
    opener: `${PROJECT_SUPERVISOR_PROMPT_OPENER} for the project "${projectName}" (projectId ${projectId}) — an autonomous supervisor chat that watches over THIS ONE project's chats and coding sessions and keeps its work moving.`,
    core: coreDoctrine('project'),
    facts: frameworkFactsBlock({ audience: 'supervisor' }),
    project: brief,
    roleProfile: projectSupervisorRoleProfile({ projectName, projectId, fleetSupervisorChatId, hookEventTypes: stockProjectHookEventTypes() }),
  }).text;
}

/** The recurring sweep schedule's prompt — a STANDALONE instruction (each
 *  firing is a fresh turn). GOAL-LEDGER diff contract modeled on the fleet
 *  sweep (supervisor.service buildFleetSweepPrompt): a sweep is a DIFF
 *  against the previous sweep, anchored on the goal ledger, never a bulletin. */
export function buildProjectSupervisorSweepPrompt(opts: {
  projectName: string;
  projectId: string;
  fleetSupervisorChatId: string | null;
}): string {
  const { projectName, projectId, fleetSupervisorChatId } = opts;
  const fleetRef = fleetSupervisorChatId
    ? `send_chat_message to chat id ${fleetSupervisorChatId} (the chat titled 'Fleet Supervisor')`
    : `send_chat_message to the Fleet Supervisor — resolve its chat id with list_chats (title 'Fleet Supervisor')`;
  // LAYERED (2026-09-27): the stored body is GENERIC — the halt rule and the
  // (sup/integration 2026-09-27: steps 2 / 5 / 6 / 6b / 7 carry the tt-rd wave —
  // docs-only PRs are records, AUDIT CHURN, cadence collisions, lanes are the
  // audience, the third SWEEP: reported close — with the incidents left to the
  // legacy body below.)
  // parked-turn rule are cited by their core rule ids (halt.owner-words,
  // gate.outcome) instead of being restated with their incident.
  return (
    `${PROJECT_SWEEP_PROMPT_OPENER} for "${projectName}" (projectId ${projectId}) — a GOAL LEDGER diff, not a status bulletin. Report movement since the previous sweep; never re-narrate unchanged state.\n\n` +
    `1. PULL the ledger: goal_list + todo_list for THIS project and list_chats (this project), then get_chat_status on each lane that is running, carries attention state, or owns goal todos — its LAST outcome since the previous sweep.\n` +
    `2. DIFF against your previous sweep note and [SUPERVISOR STATE] (get_supervisor_state for the full doc). Report ONLY DELTAS: (a) what moved TOWARD a goal since the last sweep (cite the artifact — msg/session/PR/ticket id; a docs-only PR is a record, not movement — cite the NUMBER that moved), (b) what moved AWAY or regressed, (c) what is genuinely STUCK — no progress across 2+ consecutive sweeps, say since when — and (d) what needs an ACTION now. A lane that did not change is NOT re-narrated — 'unchanged since last sweep' in ≤1 line and move on. AUDIT CHURN: an audit-only firing with no changed artifact is a NO-OP, never movement; a lane with >1 audit pass per firing or audit-only consecutive ticks is steered THIS sweep (cite receipts, drop its self-audit step, lengthen a MACHINE-armed cadence; an owner-armed cadence is reported UP, never edited) — not escalated.\n` +
    `3. STALE-GATE CHECK: before reporting ANY work as "waiting on the owner", probe the gate fresh with list_owner_questions (clear a stale card or question of YOUR OWN with cancel_confirmation / dismiss_owner_question). An ANSWERED or DISMISSED gate is NOT a blocker: relay the owner's verbatim answer to the gated lane THIS sweep (send_chat_message), unblock the todo/goal, and never restate it as pending. Apply rule halt.owner-words (your system prompt) to every "owner decision" a lane cites: An owner reply that was itself a QUESTION is not a decision — relay it as a question to answer, never as a ruling. A blocked todo/goal whose reason cites an owner decision, halt or rule but has NO owner question behind it (none open, and none the owner answered with a decision) is a LANE-authored gate, not an owner wait — unblock it this sweep (or, only if the decision is genuinely human-worthy, re-file the exact question with flag_owner_question and pair the block with its oq_ id) and never report it as "waiting on the owner". A cited question the owner DID answer with a decision is acted on — an answer that says stop closes or drops the work with the oq_ id as evidence; it never stays blocked on the closed card.\n` +
    `4. RECONCILE before escalating or re-dispatching any stalled todo: check whether the work already landed (get_run_receipts on the assignee chat — a claimed push/PR/verify with no receipt did NOT happen; get_session_diff for what actually changed; an id you cannot place → resolve_id; feedback-ticket status, git log/PR state, the assignee chat's transcript) and close landed items yourself with todo_update — escalate to the Fleet Supervisor ONLY what is genuinely ambiguous or needs a cross-project decision.\n` +
    `5. check schedule health via get_chat_status's schedules field — a lane whose cadence stopped or is overdue needs a nudge; a cadence SHORTER than the lane's typical run is a collision, not diligence: busy-skips or steers on a recurring row → update_schedule it to ≥ 2× the median run length and say so (the harness stretches it automatically and tells the lane in [SCHEDULE STATE]); a row near its maxRuns is NOT a hand-off (machine schedules renew themselves at the cap); a chat left with NO enabled schedules that runs standing work or owns goal todos is DEAF — re-arm a replacement NOW with schedule_message (a deferred re-arm written anywhere but an armed schedule does not exist). schedule_get reads a cadence's STORED prompt when its firings look wrong. DORMANT-BY-DESIGN: a project with NO active goals, open todos, live runs, or live watched resources must get ZERO wakes — the goal-gate auto-parks its machine recurring schedules ('parked:dormant') and refuses new machine arms, so do NOT re-arm anything while dormant; the project event hook (kept enabled) is its wake path, and the sweep ensure re-arms the parked sweep once live work exists. YOUR OWN stock sweep is scaffolding-owned: an explicit cancel_schedule of it is DURABLE — the ensure never re-arms a cancelled stock sweep (it only resumes a 'paused' one, stamping lastStatus 'resumed:project_sweep_ensure') — so under an owner stop order, cancel it once and report the receipt; deliberate re-arm = resume it from the Schedules tab or schedule_message a replacement. A parked, delayed or skipped machine turn is a decision-gate outcome (rule gate.outcome) — never a stopped cadence or a deaf lane; do not re-arm, re-send or ticket it.\n` +
    `6. ACT on the diff — a short specific steer to the LANE that can act on it (send_chat_message to the lane id), a dispatch (start_coding_session with projectId '${projectId}'), a re-arm, a todo close. Lanes are your default audience. Every action is cited by the id its tool returned. A spawn refusal or any budget/spend/cost consideration is NEVER an owner card — budgets inside the project's grant are pre-approved (rule money.grant — your system prompt).\n` +
    `6b. ONLY IF a goal STATE CHANGE or an ASK exists, ONE message to the Fleet Supervisor (${fleetRef}) carrying ONLY THE DELTAS the Fleet Supervisor must know: what moved (with artifact id), what is stuck and since when, and what needs the fleet (cross-project dependency, owner communication, framework issue). Never restate the ledger or unchanged lanes; an empty diff sends NO report-up, at most one report-up per 4 h unless the fleet can act on it now, and a report-up is not an action for step 7.\n` +
    // HARNESS-RECEIPTS (2026-10-20): the model writes what moved and why; the harness writes the receipts.
    (supervisorHarnessReceiptsDisabled()
      ? `7. CLOSE the note with exactly one of: the single line 'SWEEP: no-op — nothing moved in ${projectName} since last sweep' when the diff is empty and you took no action; the single line 'SWEEP: reported — <what moved, artifact id> sent to the Fleet Supervisor; no lane action' when a goal moved and 6b was your only send; OR 'ACTIONS TAKEN' — 1-3 LANE-FACING actions (a steer to a lane, a dispatch, a todo/goal/schedule change), each ONE line with its receipt id; a report-up to the Fleet Supervisor never earns the marker.`
      : `7. CLOSE the note with exactly one of: the single line 'SWEEP: no-op — nothing moved in ${projectName} since last sweep' when the diff is empty and you took no action; the single line 'SWEEP: reported — <what moved, artifact id> sent to the Fleet Supervisor; no lane action' when a goal moved and 6b was your only send; OR, after LANE-FACING actions (a steer to a lane, a dispatch, a todo/goal/schedule change), what moved and why in plain English — the harness appends 'ACTIONS TAKEN (harness):' with each mutating call and its receipt id (never type that block yourself); a report-up to the Fleet Supervisor never earns the marker.`)
  );
}

/**
 * Repair path for an EXISTING project supervisor still carrying an OLD STOCK
 * prompt: the stored prompt starts with the stock opener but predates the
 * CURRENT version (which interpolates the CURRENT project name + fleet
 * supervisor chat id — a rename or a late-provisioned fleet chat heals here),
 * so rewrite it. A CUSTOMIZED prompt (non-empty, no stock opener) is NEVER
 * touched — the supervisor.service repairStockPromptIfStale non-clobber
 * doctrine. Hardening review 2026-09-14: a NULL/EMPTY prompt is NOT a
 * customization — it is a lane stripped of its identity, duties, receipt
 * discipline and boundaries (every hook wake would run full autonomy with no
 * doctrine at all) — so it counts as stock-missing and heals back to stock.
 */
async function repairProjectStockPromptIfStale(
  chatId: string,
  userId: string,
  systemPrompt: string | null,
  projectName: string,
  projectId: string,
  fleetSupervisorChatId: string | null,
  brief?: ProjectBrief | null,
): Promise<boolean> {
  if (systemPrompt && !systemPrompt.startsWith(PROJECT_SUPERVISOR_PROMPT_OPENER)) return false;
  // Layered (2026-09-27): a v1 (pre-layering) stock prompt never equals the
  // composed v2 text, so the byte compare below re-scaffolds it on the next
  // ensure; a v2 prompt heals only when its composed text moved (a brief
  // field, a facts flip, a doctrine edit). isLayeredPrompt is the explicit
  // key for the migrate helper (prompt-migrate.ts).
  // Churn (review fix, same day): the brief this compares is the STABLE view
  // (project-brief.loader.ts — goals in creation order without blockedReason,
  // no model-extracted contextState, owner-origin decisions only), so an
  // active project's ledger churn no longer rewrites the row on every
  // 15-minute reconcile; a rewrite means an owner-set field, a real ledger
  // event, a facts flip or a doctrine edit moved the composed text.
  const current = buildProjectSupervisorPrompt({ projectName, projectId, fleetSupervisorChatId, brief });
  if (systemPrompt === current) return false;
  await prisma.crossModelChat.update({
    where: { id: chatId },
    data: { systemPrompt: current },
  });
  // A write to a stored prompt is audited like the admin re-scaffold
  // (rescaffoldProjectSupervisorPrompt) so every rewrite is attributable and
  // the heal's cadence is observable from the Activity rows.
  await audit(userId, 'chat.update', {
    chatId, projectId, reason: 'project supervisor stock prompt healed (composed text moved)',
    wasLayered: isLayeredPrompt(systemPrompt), fromChars: systemPrompt?.length ?? 0, chars: current.length,
  });
  logger.info(`project supervisor: stock prompt healed for lane ${chatId.slice(0, 8)} (${systemPrompt?.length ?? 0} → ${current.length} chars)`);
  return true;
}

/**
 * RE-SCAFFOLD one project supervisor's stock prompt from ITS project's brief
 * (layered prompts, 2026-09-27) — the helper the next wake (ensure), the
 * watchdog heal and the admin action (prompt-migrate.ts /
 * POST /admin/prompts/rescaffold) call. Unlike ensureProjectSupervisor it
 * does NOT return early on a PAUSED project (projectSupervisorEnabled=false)
 * or an OFF supervisor switch: a paused lane's stored prompt is rebuilt too,
 * so the toggle-ON path wakes it on a project-specific prompt. It never arms
 * a hook or a schedule and never creates a chat. A CUSTOMIZED prompt (no
 * stock opener) is never touched. Returns what it did; never throws.
 */
export async function rescaffoldProjectSupervisorPrompt(
  chatId: string,
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<{ chatId: string; outcome: 'rewritten' | 'current' | 'customized' | 'not_found' | 'dry_run' | 'error'; wasLayered?: boolean; detail?: string }> {
  try {
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: chatId },
      select: { id: true, userId: true, projectId: true, isProjectSupervisor: true, systemPrompt: true, project: { select: { id: true, name: true, description: true, repoUrl: true, repoProvider: true, defaultBranch: true, githubLabel: true } } },
    });
    if (!chat || !chat.isProjectSupervisor || !chat.projectId || !chat.project) return { chatId, outcome: 'not_found' };
    if (chat.systemPrompt && !chat.systemPrompt.startsWith(PROJECT_SUPERVISOR_PROMPT_OPENER)) return { chatId, outcome: 'customized' };
    const wasLayered = isLayeredPrompt(chat.systemPrompt);
    const fleetChat = await findFleetSupervisorChat(chat.userId).catch(() => null);
    const brief = await loadProjectBrief(chat.projectId, chat.userId, { project: chat.project, supervisorChatId: chat.id, bypassCache: true });
    const current = buildProjectSupervisorPrompt({ projectName: chat.project.name, projectId: chat.projectId, fleetSupervisorChatId: fleetChat?.id ?? null, brief });
    if (chat.systemPrompt === current) return { chatId, outcome: 'current', wasLayered };
    if (opts.dryRun) return { chatId, outcome: 'dry_run', wasLayered, detail: `${chat.systemPrompt?.length ?? 0} → ${current.length} chars` };
    await prisma.crossModelChat.update({ where: { id: chatId }, data: { systemPrompt: current } });
    await audit(chat.userId, 'chat.update', { chatId, projectId: chat.projectId, reason: 'project supervisor prompt re-scaffolded from the project brief (layered prompts)', wasLayered, chars: current.length });
    return { chatId, outcome: 'rewritten', wasLayered };
  } catch (err: any) {
    logger.warn(`project supervisor: re-scaffold failed for ${String(chatId).slice(0, 8)}: ${err?.message}`);
    return { chatId, outcome: 'error', detail: err?.message };
  }
}

/**
 * Ensure the lane's ONE project-scope EventHook exists (sourceChatId NULL +
 * projectId SET → only chats in this project emit to it). Idempotent.
 * Toggle-ON restore (hardening review 2026-09-14): the PRIMARY restore is
 * resumeWhatPauseDisabled — it re-enables EXACTLY the hook ids the pause
 * audit recorded, stock or customized, and runs before this. What remains
 * here is the legacy FALLBACK for a pause that predates id recording: a STOCK
 * hook (empty promptTemplate, event types inside the stock universe) left
 * DISABLED is re-enabled; a CUSTOMIZED hook that is disabled with no pause
 * audit naming it was disabled by the lane itself (hook_update enabled:false
 * is a supported self-pause) and is left alone — this ensure runs every 15
 * min from the watchdog heal, so an unconditional re-enable would fight a
 * deliberate self-pause forever. Non-clobber protects template/eventTypes
 * in every branch; nothing here ever writes them.
 */
async function ensureProjectHook(chatId: string, userId: string, projectId: string): Promise<void> {
  const existing = await prisma.eventHook.findFirst({
    where: { sourceChatId: null, targetChatId: chatId, projectId },
    select: { id: true, eventTypes: true, enabled: true, promptTemplate: true, debounceSec: true },
  });
  if (existing) {
    const types = Array.isArray(existing.eventTypes) ? existing.eventTypes.map(String) : [];
    const isStock =
      String(existing.promptTemplate ?? '').trim() === '' &&
      types.length > 0 &&
      types.every((t) => PROJECT_STOCK_EVENT_TYPE_UNIVERSE.has(t));
    // Event-set union heal (fleet heal parity, ticket b4d1096c): a stock-
    // universe hook created before schedule_near_cap existed otherwise never
    // hears the near-cap warning — emission filters on eventTypes. Union ONLY
    // the newly-added safety types in (template not consulted — a customized
    // prompt is no reason to deafen an alert class; a hook with any custom
    // type is never touched).
    const isStockUniverse = isStockProjectHookEventSet(types);
    if (isStockUniverse) {
      const healed = [...new Set([...types, ...projectNewlyAddedEventTypes()])];
      const changed = healed.length !== types.length || healed.some((t, i) => t !== types[i]);
      if (changed) {
        const added = healed.filter((t) => !types.includes(t));
        try {
          await prisma.eventHook.update({ where: { id: existing.id }, data: { eventTypes: healed } });
          await audit(userId, 'hook.update', {
            hookId: existing.id, targetChatId: chatId, projectId,
            reason: `project supervisor stock event-set union heal (${added.join(', ') || 'dedupe'} — schedule_near_cap ticket b4d1096c; ci_failed CI-WATCH 2026-10-20)`,
            eventTypes: healed,
          });
        } catch (err: any) {
          logger.warn(`project supervisor: hook event-set heal failed for ${existing.id.slice(0, 8)}: ${err?.message}`);
        }
      }
    }
    if (isStock && existing.enabled === false) {
      try {
        await prisma.eventHook.update({ where: { id: existing.id }, data: { enabled: true } });
        await audit(userId, 'hook.update', {
          hookId: existing.id, targetChatId: chatId, projectId,
          reason: 'project supervisor toggle-on re-enable (stock project-scope hook; legacy fallback — no pause audit named this hook)',
        });
      } catch (err: any) {
        logger.warn(`project supervisor: hook re-enable failed for ${existing.id.slice(0, 8)}: ${err?.message}`);
      }
    }
    // Instant-hooks heal (owner 2026-09-14): the pre-fix stock window (600 s)
    // converges to 0 on every ensure/heal. Customized values are never touched.
    if ((existing as any).debounceSec === LEGACY_PROJECT_SUPERVISOR_HOOK_DEBOUNCE_SEC) {
      try {
        await prisma.eventHook.update({ where: { id: existing.id }, data: { debounceSec: PROJECT_SUPERVISOR_HOOK_DEBOUNCE_SEC } });
        await audit(userId, 'hook.update', {
          hookId: existing.id, targetChatId: chatId, projectId,
          reason: 'instant hooks (owner 2026-09-14): project-scope debounce 600s → 0 (events coalesce only while the lane is busy)',
          debounceSec: PROJECT_SUPERVISOR_HOOK_DEBOUNCE_SEC,
        });
      } catch (err: any) {
        logger.warn(`project supervisor: hook debounce heal failed for ${existing.id.slice(0, 8)}: ${err?.message}`);
      }
    }
    return;
  }
  try {
    const row = await prisma.eventHook.create({
      data: {
        userId,
        sourceChatId: null,
        targetChatId: chatId,
        projectId,
        eventTypes: stockProjectHookEventTypes(),
        debounceSec: PROJECT_SUPERVISOR_HOOK_DEBOUNCE_SEC,
      },
    });
    await audit(userId, 'hook.auto_provision', {
      hookId: row.id, targetChatId: chatId, projectId,
      eventTypes: stockProjectHookEventTypes(),
      debounceSec: PROJECT_SUPERVISOR_HOOK_DEBOUNCE_SEC,
    });
  } catch (err: any) {
    // Lost the race with a concurrent ensure — backed by the partial unique
    // index event_hooks_one_project_hook_per_target (20260914000000): the
    // winner's row is identical, converge on it (reviewer P1-1).
    if (err?.code !== 'P2002') throw err;
  }
}

/** A row is the STOCK sweep iff its prompt carries the stock opener. The
 *  opener is the ONLY discriminator on purpose — promptSetBy 'system' is NOT
 *  one: schedule.service maybeRenewOnExhaustion stamps EVERY successor
 *  'system' (including successors of the lane's own machine-armed rows) and
 *  armOwnerAnswerRetry stamps 'system' too, so a promptSetBy test would still
 *  doom renewed self-schedules. */
function isStockProjectSweep(s: { prompt?: unknown }): boolean {
  return typeof s.prompt === 'string' && s.prompt.startsWith(PROJECT_SWEEP_PROMPT_OPENER);
}

/**
 * Ensure the lane's recurring sweep schedule exists. Only an ENABLED
 * recurring row is respected — a dead sweep (maxRuns/expiry) is recreated.
 *
 * Hardening review 2026-09-14 — the predicate used to be "ANY enabled
 * recurring row on the lane": the lane's prompt tells it to arm cadences on
 * ITSELF (schedule_message defaults chatId → self and kind → recurring), so
 * every 15-min heal hard-deleted the supervisor's own re-arms as "duplicate
 * sweeps" (prod precedent: fleet row b96b381e, 5 runs, killed 'obsolete' on
 * 09-03) and, once the stock sweep exhausted, kept a self-schedule as the
 * "keeper" so the hourly sweep was never recreated. Now the rows are
 * PARTITIONED: only STOCK rows (opener match) dedupe (keep the earliest,
 * delete the rest — each doomed row emits ONE schedule_disabled event + an
 * audit row BEFORE the delete; never hard-delete without an attributable
 * row) and heal (an opener-matched old stock prompt is rewritten to the
 * current one). Non-stock rows are NEVER deleted or rewritten. The stock
 * sweep is (re)armed iff no stock row is enabled AND no OWNER-authored
 * (promptSetBy 'user', or legacy NULL) recurring row stands in for it — an
 * owner-customized sweep IS the lane's cadence (the fleet's live c0e22e36
 * shape; arming a stock sweep beside it doubles the cadence and breaks the
 * non-clobber doctrine), whereas a machine/system-authored monitor is not
 * and must never mask a dead stock sweep.
 *
 * Toggle-ON (pause → resume): before creating, a DISABLED stock row that is
 * not exhausted is RESUMED (schedule.service setScheduleEnabledForChat's
 * resume shape) instead of leaving one dead row per OFF→ON cycle. Exactly
 * ONE row is resumed — resuming several accumulated rows would recreate the
 * duplicates the dedupe then hard-deletes.
 */
async function ensureProjectSweepSchedule(
  chatId: string,
  userId: string,
  projectName: string,
  projectId: string,
  fleetSupervisorChatId: string | null,
): Promise<void> {
  const sweeps = await prisma.chatSchedule.findMany({
    where: { sessionId: chatId, kind: 'recurring', enabled: true },
    // intervalSec (wake-cadence-3): the keeper heal restores a stock row below the floor.
    select: { id: true, prompt: true, kind: true, runsCount: true, promptSetBy: true, intervalSec: true },
    orderBy: { createdAt: 'asc' },
  });
  const stock = sweeps.filter(isStockProjectSweep);
  const current = buildProjectSupervisorSweepPrompt({ projectName, projectId, fleetSupervisorChatId });

  // Goal-gate (ticket b1d435fd, owner directive 2026-09-18): a DORMANT project
  // — no active/blocked goals, no open todos, no live/queued runs, no live
  // watched-resource registrations — gets ZERO wakes: the hourly sweep must
  // not run, resume, or be (re)armed there. This is the policy layer the
  // ff0f6ad9/c43f4328 mechanism fixes lacked: an enabled STOCK sweep on a
  // dormant project is PARKED (lastStatus 'parked:dormant', the fire-time
  // sweeper gate auto-parks non-stock machine rows; owner-authored rows are
  // never gated), and nothing below dedupes, heals, resumes, or creates.
  // Idempotent + quiet: once every stock row is parked there is nothing
  // enabled to touch, so later heals write nothing. The wake path for new
  // work is the project event hook (kept enabled) — and this same ensure
  // re-arms the newest parked row ('parked:dormant' resumes like 'paused'
  // below) on the first heal after live work reappears.
  const dormancy = await evaluateProjectDormancy(projectId);
  if (dormancy.dormant) {
    let parkedLanded = 0;
    for (const row of stock) {
      // 37fa747d: a park whose WRITE fails must not emit schedule_disabled —
      // the event is ALARM-class (wakes the supervisor, bypassing debounce)
      // and announces "It stays parked" over a row that never parked. Emit
      // only on a landed write; a failed write keeps the row enabled so the
      // next heal (or the fire-time gate) retries the park.
      let parkedOk = false;
      try {
        await prisma.chatSchedule.update({
          where: { id: row.id },
          data: { enabled: false, lastStatus: DORMANT_LAST_STATUS, cancelledBy: 'machine', disabledAt: new Date() },
        });
        parkedOk = true;
      } catch (err: any) {
        logger.warn(`project supervisor: dormancy park failed for ${row.id.slice(0, 8)}: ${err?.message}`);
      }
      if (parkedOk) {
        parkedLanded += 1;
        try {
          const { emitScheduleDisabled } = await import('../coding/schedule.service');
          await emitScheduleDisabled({ id: row.id, sessionId: chatId, kind: row.kind }, 'parked_dormant', row.runsCount ?? 0, { detail: dormancy.reason }).catch(() => {});
        } catch { /* best-effort — the park write above is the durable record */ }
      }
    }
    if (stock.length) {
      logger.info(`project supervisor: parked ${parkedLanded}/${stock.length} stock sweep(s) on lane ${chatId.slice(0, 8)} — ${dormancy.reason}`);
    }
    return;
  }

  if (stock.length > 0) {
    if (stock.length > 1) {
      const doomed = stock.slice(1);
      try {
        const { emitScheduleDisabled } = await import('../coding/schedule.service');
        for (const s of doomed) {
          await emitScheduleDisabled({ id: s.id, sessionId: chatId, kind: s.kind }, 'obsolete', s.runsCount ?? 0).catch(() => {});
          await audit(userId, 'schedule_hard_deleted', {
            scheduleId: s.id, sessionId: chatId, kind: s.kind,
            runsCount: s.runsCount ?? 0, reason: 'obsolete', source: 'project-sweep-dedupe',
          });
        }
      } catch (err: any) {
        logger.warn(`project supervisor: schedule_disabled emission failed before dedupe (non-fatal): ${err?.message}`);
      }
      await prisma.chatSchedule.deleteMany({
        where: { id: { in: doomed.map((s: any) => s.id) } },
      });
      logger.warn(`project supervisor: deduped ${doomed.length} duplicate STOCK sweep schedule(s) on ${chatId.slice(0, 8)} (${sweeps.length - stock.length} lane-authored recurring row(s) untouched)`);
    }
    const keeper = stock[0];
    if (keeper.prompt !== current) {
      await prisma.chatSchedule.update({ where: { id: keeper.id }, data: { prompt: current, promptSetBy: 'system' } })
        .catch((err: any) => logger.warn(`project supervisor: sweep-prompt heal failed for ${keeper.id.slice(0, 8)}: ${err?.message}`));
    }
    // wake-cadence-3 (2026-09-27 tt-rd audit): CADENCE FLOOR heal. The heal
    // above touched prompt/nextRunAt/expiresAt but never intervalSec, so a
    // stock sweep a lane had cut to 30 min stayed there for days (the only
    // project sweep in the fleet below default). A stock row BELOW the default
    // is restored to it; rows at/above it (incl. backed-off ones) are left
    // alone. Attributable: one Activity row, source 'project-sweep-cadence-floor'.
    const keeperInterval = typeof (keeper as any).intervalSec === 'number' ? ((keeper as any).intervalSec as number) : null;
    if (keeperInterval != null && keeperInterval < PROJECT_SWEEP_INTERVAL_SEC) {
      // fixer 2026-09-27: an OWNER-lowered stock sweep is the owner's choice —
      // the floor refusal promises "An owner turn may still set it lower", and
      // this heal used to undo that on the next 15-min watchdog pass (silently
      // from the owner's side; audited under 'project-sweep-cadence-floor').
      // The newest attributed `schedule.update` Activity row decides
      // (stockSweepIntervalOwnerSet); PROJECT_SWEEP_FLOOR_HEAL_OWNER_ROWS=1
      // heals owner rows too. Only below-floor keepers pay the read (rare).
      const ownerSet = projectSweepFloorHealOwnerRowsEnabled() ? false : await stockSweepIntervalOwnerSet(userId, keeper.id);
      if (ownerSet === true) {
        logger.debug(`project supervisor: stock sweep ${keeper.id.slice(0, 8)} on lane ${chatId.slice(0, 8)} sits at ${Math.round(keeperInterval / 60)} min by the OWNER's edit — cadence-floor heal skipped (wake-cadence-3 owner guard)`);
        return;
      }
      if (ownerSet === null) {
        logger.warn(`project supervisor: interval attribution read failed for stock sweep ${keeper.id.slice(0, 8)} — cadence-floor heal skipped this pass (never a silent override on a read error)`);
        return;
      }
      try {
        await prisma.chatSchedule.update({ where: { id: keeper.id }, data: { intervalSec: PROJECT_SWEEP_INTERVAL_SEC } });
        await audit(userId, 'schedule.update', {
          scheduleId: keeper.id, chatId, projectId, fields: ['intervalSec'], source: 'project-sweep-cadence-floor',
          from: keeperInterval, to: PROJECT_SWEEP_INTERVAL_SEC,
        });
        logger.info(`project supervisor: stock sweep ${keeper.id.slice(0, 8)} on lane ${chatId.slice(0, 8)} restored ${Math.round(keeperInterval / 60)}→${Math.round(PROJECT_SWEEP_INTERVAL_SEC / 60)} min (cadence floor, wake-cadence-3)`);
      } catch (err: any) {
        logger.warn(`project supervisor: cadence-floor heal failed for ${keeper.id.slice(0, 8)}: ${err?.message}`);
      }
    }
    return;
  }
  // No enabled stock sweep. An OWNER-authored customized recurring row is the
  // lane's cadence — never arm a stock sweep beside it. (Machine/system rows
  // are the lane's own monitors and do not count.)
  const ownerCustomizedSweep = sweeps.find((s) => !isStockProjectSweep(s) && (s.promptSetBy === 'user' || s.promptSetBy == null));
  if (ownerCustomizedSweep) return;

  const now = Date.now();
  // Toggle-ON: resume the newest DISABLED stock row instead of piling up a new
  // one per OFF→ON cycle. Exhausted rows (maxRuns spent) fall through to create.
  const paused = await prisma.chatSchedule.findFirst({
    where: { sessionId: chatId, kind: 'recurring', enabled: false, prompt: { startsWith: PROJECT_SWEEP_PROMPT_OPENER } },
    select: { id: true, runsCount: true, maxRuns: true, expiresAt: true, lastStatus: true, cancelledBy: true },
    orderBy: { createdAt: 'desc' },
  });
  // Ticket ff0f6ad9: an EXPLICITLY CANCELLED stock sweep (lastStatus 'cancelled'
  // — every deliberate cancel path stamps it: cancel_schedule tool, REST DELETE,
  // fleet dashboard) is a DELIBERATE STOP, not a pause. The 15-min watchdog heal
  // used to treat it as toggle-OFF damage and silently resume it within minutes
  // (cancelledBy wiped, an unattributed 'resumed' left behind) — a stop-order
  // stand-down could never durably quiet an enabled project's sweep, and a lane
  // re-cancelling would have fought the scaffolding forever. Now the stop is
  // DURABLE: never resumed here, and no fresh stock row armed beside it below.
  // The way back is equally explicit — resume the row (Schedules tab /
  // setScheduleEnabledForChat) or arm a replacement with schedule_message.
  // Quiet on purpose: no audit row per heal (the pause path's no-writes-no-audit
  // doctrine) — the cancelled row itself, with cancelledBy + disabledAt now
  // surfaced in list_schedules, IS the attribution record.
  if (paused?.lastStatus === 'cancelled') {
    logger.info(
      `project supervisor: stock sweep ${paused.id.slice(0, 8)} on lane ${chatId.slice(0, 8)} is explicitly cancelled ` +
      `(by ${paused.cancelledBy ?? 'unknown'}) — respecting the deliberate stop; no resume, no re-arm (ff0f6ad9)`,
    );
    return;
  }
  if (paused && !(paused.maxRuns != null && paused.runsCount >= paused.maxRuns)) {
    const expAt = paused.expiresAt ? new Date(paused.expiresAt as any).getTime() : null;
    try {
      await prisma.chatSchedule.update({
        where: { id: paused.id },
        data: {
          // ff0f6ad9: the stamp names the ACTOR — list_schedules renders
          // "last resumed:project_sweep_ensure", so the owning lane can tell a
          // scaffolding auto-resume apart from an owner/UI resume ('resumed').
          enabled: true, lastStatus: 'resumed:project_sweep_ensure', cancelledBy: null, disabledAt: null, busySkips: 0,
          nextRunAt: new Date(now + PROJECT_SWEEP_INTERVAL_SEC * 1000),
          ...(expAt !== null && expAt <= now ? { expiresAt: new Date(now + PROJECT_SWEEP_LIFETIME_MS) } : {}),
          prompt: current, promptSetBy: 'system',
        },
      });
      await audit(userId, 'schedule.resume', {
        scheduleId: paused.id, chatId, projectId, source: 'project-sweep-ensure',
        reason: 'project supervisor toggle-on: the paused stock sweep row is resumed instead of a new row being created',
      });
      logger.info(`project supervisor: resumed paused stock sweep ${paused.id.slice(0, 8)} on lane ${chatId.slice(0, 8)} (source project-sweep-ensure)`);
      return;
    } catch (err: any) {
      logger.warn(`project supervisor: paused-sweep resume failed for ${paused.id.slice(0, 8)} — creating a fresh sweep: ${err?.message}`);
    }
  }
  await prisma.chatSchedule.create({
    data: {
      sessionId: chatId,
      userId,
      prompt: buildProjectSupervisorSweepPrompt({ projectName, projectId, fleetSupervisorChatId }),
      kind: 'recurring',
      intervalSec: PROJECT_SWEEP_INTERVAL_SEC,
      nextRunAt: new Date(now + PROJECT_SWEEP_INTERVAL_SEC * 1000),
      maxRuns: PROJECT_SWEEP_MAX_RUNS,
      expiresAt: new Date(now + PROJECT_SWEEP_LIFETIME_MS),
      enabled: true,
      promptSetBy: 'system', // framework-authored — never counts as autonomous drift
    },
  });
}

/**
 * Ensure the project's dedicated supervisor lane exists (idempotent,
 * self-healing, NEVER throws). Scaffolds ONLY when the project exists, is
 * owned by userId, is not the hidden user-space folder, is not archived, and
 * carries projectSupervisorEnabled === true. Creates the chat + full-autonomy
 * grant (scheduleCap 480) + sweep schedule + project-scope hook on first
 * call; heals title drift / stock prompt / missing pieces on later calls.
 * Returns the supervisor chat, or null when skipped or failed (logged).
 */
export async function ensureProjectSupervisor(userId: string, projectId: string): Promise<any | null> {
  try {
    if (!userId || !projectId) return null;
    const project = await prisma.crossModelProject
      .findUnique({
        where: { id: projectId },
        select: { id: true, userId: true, name: true, isUserSpace: true, archivedAt: true, projectSupervisorEnabled: true, description: true, repoUrl: true, repoProvider: true, defaultBranch: true, githubLabel: true },
      })
      .catch(() => null);
    if (!project || project.userId !== userId) return null;
    if (project.isUserSpace || project.archivedAt || project.projectSupervisorEnabled !== true) return null;

    // Kid guard (mirrors ensureFleetSupervisor): child accounts are confined
    // to the locked-down kid pipeline — no autonomous agents for them.
    const user = await prisma.user
      .findUnique({ where: { id: userId }, select: { isChild: true } })
      .catch(() => null);
    if (user?.isChild) {
      logger.info(`project supervisor: skipped for child account ${userId.slice(0, 8)}`);
      return null;
    }

    const fleetChat = await findFleetSupervisorChat(userId).catch(() => null);
    const fleetSupervisorChatId = fleetChat?.id ?? null;
    const title = projectSupervisorTitle(project.name);

    // 1. Already there? Heal the pieces that can drift and return it.
    const existing = await prisma.crossModelChat.findFirst({
      where: { userId, projectId, isProjectSupervisor: true },
      select: { id: true, userId: true, title: true, titlePinned: true, systemPrompt: true },
    });

    // SUPERVISOR OFF SWITCH (owner 2026-09-26; platform/supervisor-switch.ts —
    // mirrors ensureFleetSupervisor): while project supervisors are switched
    // off, ensure is READ-ONLY — an existing lane is returned untouched (no
    // heal, no pause-resume, no hook/sweep arm) and no lane is scaffolded
    // (one rate-limited skip row, source 'ensure'). The per-project
    // projectSupervisorEnabled flag is left as the owner set it; the next
    // ensure after the switch is back on scaffolds/heals as before.
    if (!(await getProjectSupervisorsEnabled().catch(() => true))) {
      if (existing) return existing;
      recordSupervisorSwitchSkip({ target: 'project', source: 'ensure' });
      logger.info(`project supervisor: switch is OFF — not scaffolding a lane for project ${projectId.slice(0, 8)}`);
      return null;
    }

    // Layered prompts (2026-09-27): the stock prompt carries THIS project's
    // brief (mission, instructions, goals, repos, environments, budget,
    // standing decisions). Loaded once per ensure; fail-open to name + id.
    const brief = await loadProjectBrief(projectId, userId, { project, supervisorChatId: existing?.id ?? null });

    if (existing) {
      // Session titles (2026-09-27; fixer 2026-09-27 → healSupervisorTitle):
      // the heal compares the GOAL half only — the step half ("· sweep",
      // "· idle since 14:02Z") is the harness's and is kept when the goal
      // half already is the label; a human-pinned title is never overwritten;
      // the label is never word-clipped; HARNESS_TITLE_SUPERVISOR_STEP_DISABLED=1
      // heals the whole title to the bare label as before.
      const healedTitle = healSupervisorTitle(existing, title);
      if (healedTitle) {
        await prisma.crossModelChat.update({
          where: { id: existing.id },
          data: { title: healedTitle },
        }).catch((err) => logger.warn(`project supervisor: title heal failed for ${existing.id.slice(0, 8)}: ${err?.message}`));
      }
      await repairAutonomyIfMissing(existing.id, userId, PROJECT_SUPERVISOR_SCHEDULE_CAP);
      await repairProjectStockPromptIfStale(existing.id, userId, existing.systemPrompt, project.name, projectId, fleetSupervisorChatId, brief);
      // Toggle-ON: restore EXACTLY what the last pause disabled (hook + schedule
      // ids from its audit) BEFORE the hook/sweep ensures, so they see the
      // resumed rows instead of re-enabling stock-only / creating a new sweep.
      await resumeWhatPauseDisabled(existing.id, userId, projectId);
      await ensureProjectHook(existing.id, userId, projectId);
      await ensureProjectSweepSchedule(existing.id, userId, project.name, projectId, fleetSupervisorChatId);
      return existing;
    }

    // 2. Create the lane chat INSIDE its project. The partial unique index
    //    (one project supervisor per PROJECT) backs the race: a concurrent
    //    ensure loses with a P2002 and converges on the winner's row.
    let chat;
    try {
      chat = await prisma.crossModelChat.create({
        data: {
          title,
          // Owner 2026-09-26: Auto by default (see supervisor.service) — the
          // compute policy decides per wake, the L2 preset is the fallback.
          mode: 'auto',
          isProjectSupervisor: true,
          systemPrompt: buildProjectSupervisorPrompt({ projectName: project.name, projectId, fleetSupervisorChatId, brief }),
          user: { connect: { id: userId } },
          project: { connect: { id: projectId } },
        },
      });
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err; // outer wrapper logs + returns null
      const winner = await prisma.crossModelChat.findFirst({
        where: { projectId, isProjectSupervisor: true },
      });
      if (!winner) throw err; // index fired on something else — surface it
      await repairAutonomyIfMissing(winner.id, userId, PROJECT_SUPERVISOR_SCHEDULE_CAP);
      await ensureProjectHook(winner.id, userId, projectId);
      await ensureProjectSweepSchedule(winner.id, userId, project.name, projectId, fleetSupervisorChatId);
      return winner;
    }

    // 3. Full project autonomy (every grantable consequential tool, cap 480).
    await grantFullAutonomy(chat.id, userId, PROJECT_SUPERVISOR_SCHEDULE_CAP);

    // 4. ONE recurring sweep schedule (60 min).
    await ensureProjectSweepSchedule(chat.id, userId, project.name, projectId, fleetSupervisorChatId);

    // 5. ONE project-scope hook — every chat IN this project (present and
    //    future) emits to the supervisor with zero per-chat wiring.
    await ensureProjectHook(chat.id, userId, projectId);

    await audit(userId, 'project_supervisor.ensure', { projectId, chatId: chat.id, created: true });
    logger.info(
      `project supervisor: ensured chat ${chat.id.slice(0, 8)} for project ${projectId.slice(0, 8)} (owner ${userId.slice(0, 8)}, project-scope hook armed)`,
    );
    return chat;
  } catch (err: any) {
    logger.warn(`project supervisor: ensure failed for project ${String(projectId).slice(0, 8)}: ${err?.message}`);
    return null;
  }
}

/**
 * PAUSE the project's supervisor lane (toggle OFF / archive / heal of a
 * no-longer-eligible project). Disables EVERY enabled hook that wakes the
 * lane (targetChatId = lane — the project-scope hook AND any direct hooks the
 * lane or a peer subscribed onto it; a "paused" lane that still holds full
 * autonomy must not be woken by a directly-subscribed run_failed) and ALL of
 * the lane's enabled schedules, and audits the pause WITH THE EXACT IDS it
 * disabled (hookIds / scheduleIds) so toggle-ON can resume precisely those —
 * the chat, transcript, autonomy grant, hook rows, schedule rows, and state
 * doc are NEVER deleted (pause-never-delete doctrine).
 *
 * Idempotent AND quiet (hardening review 2026-09-14): the watchdog heal
 * re-pauses every ineligible lane every 15 min; when nothing is enabled there
 * is nothing to pause — no writes, no audit row, no log line (the old
 * unconditional updateMany + audit wrote ~96 phantom "pause" rows per day per
 * paused lane, forever).
 *
 * audit 2026-10-08 W1-1 (supervisors F2 / lanes F1 / goals F1 — a REGRESSION of
 * the 10-06 T5-1 fix): the hooks a SPAWN wired (`system:child-result-hook`, the
 * paused supervisor's direct result hook per child) and the chat's own
 * `system:direct-wake` self-hook are framework plumbing, not subscriptions the
 * pause silences — the 15-min heal re-paused them 3–14 min after every paused
 * spawn, so 10 One Piece lane completions woke nobody. They are never disabled
 * here, which also makes the heal idempotent for them (a lane whose only
 * enabled hooks are spawn-wired is "already paused" — no writes, no audit).
 * Kill switch PAUSE_KEEPS_SPAWN_HOOKS_DISABLED=1 restores the disable-every-hook
 * pause.
 */
export const PAUSE_EXEMPT_HOOK_ORIGINS: ReadonlySet<string> = new Set(['system:child-result-hook', 'system:direct-wake']);
export function pauseKeepsSpawnHooksDisabled(): boolean {
  return process.env.PAUSE_KEEPS_SPAWN_HOOKS_DISABLED === '1';
}
export async function pauseProjectSupervisor(userId: string, projectId: string): Promise<void> {
  try {
    if (!userId || !projectId) return;
    const lane = await prisma.crossModelChat.findFirst({
      where: { userId, projectId, isProjectSupervisor: true },
      select: { id: true },
    });
    if (!lane) return;
    const enabledHooks = (await prisma.eventHook.findMany({
      where: { targetChatId: lane.id, enabled: true },
      select: { id: true, sourceChatId: true, projectId: true, createdVia: true },
    })) ?? [];
    const keepSpawnHooks = !pauseKeepsSpawnHooksDisabled();
    const hookRows = keepSpawnHooks
      ? enabledHooks.filter((h: any) => !PAUSE_EXEMPT_HOOK_ORIGINS.has(String(h?.createdVia ?? '')))
      : enabledHooks;
    const keptSpawnHookIds = keepSpawnHooks
      ? enabledHooks.filter((h: any) => PAUSE_EXEMPT_HOOK_ORIGINS.has(String(h?.createdVia ?? ''))).map((h) => h.id)
      : [];
    const scheduleRows = await prisma.chatSchedule.findMany({
      where: { sessionId: lane.id, enabled: true },
      select: { id: true, kind: true },
    });
    const hookIds = hookRows.map((h) => h.id);
    const scheduleIds = scheduleRows.map((s) => s.id);
    if (hookIds.length === 0 && scheduleIds.length === 0) return; // already paused — nothing to do, nothing to say
    const hooks = hookIds.length
      ? await prisma.eventHook.updateMany({
          where: { id: { in: hookIds }, enabled: true },
          data: { enabled: false },
        })
      : { count: 0 };
    const schedules = scheduleIds.length
      ? await prisma.chatSchedule.updateMany({
          where: { id: { in: scheduleIds }, enabled: true },
          // Stamped like every other disable path (schedule.service pause shape)
          // so a paused row reads as paused, not as a silent flag flip.
          data: { enabled: false, lastStatus: 'paused', cancelledBy: 'owner', disabledAt: new Date() },
        })
      : { count: 0 };
    if ((hooks?.count ?? 0) + (schedules?.count ?? 0) === 0) return; // raced with another pause — it already audited
    await audit(userId, 'project_supervisor.pause', {
      projectId, chatId: lane.id,
      hooksDisabled: hooks?.count ?? 0, schedulesDisabled: schedules?.count ?? 0,
      hookIds, scheduleIds,
      directHookIds: hookRows.filter((h) => h.sourceChatId !== null).map((h) => h.id),
      // audit 2026-10-08 W1-1: spawn-wired hooks this pause deliberately LEFT enabled.
      ...(keptSpawnHookIds.length ? { keptSpawnHookIds } : {}),
    });
    if (keptSpawnHookIds.length) {
      try {
        const { recordLoopMetric } = await import('./loop-metrics.service');
        recordLoopMetric({ kind: 'supervisor_pause_kept_spawn_hooks', sessionId: lane.id, value: keptSpawnHookIds.length, meta: { projectId, keptSpawnHookIds: keptSpawnHookIds.slice(0, 20), hooksDisabled: hooks?.count ?? 0 } });
      } catch { /* telemetry never blocks */ }
    }
    logger.info(
      `project supervisor: paused lane ${lane.id.slice(0, 8)} for project ${projectId.slice(0, 8)} ` +
      `(${hooks?.count ?? 0} hook(s), ${schedules?.count ?? 0} schedule(s) disabled — nothing deleted)`,
    );
  } catch (err: any) {
    logger.warn(`project supervisor: pause failed for project ${String(projectId).slice(0, 8)}: ${err?.message}`);
  }
}

/**
 * Toggle-ON restore (hardening review 2026-09-14): resume EXACTLY the hook +
 * schedule ids the most recent pause disabled, read from its
 * `project_supervisor.pause` audit row, then write a `project_supervisor.resume`
 * audit so later heals are no-ops. Migration-free — the Activity row is the
 * store. Runs in the existing-lane branch of ensureProjectSupervisor (flag ON,
 * project eligible), BEFORE ensureProjectHook / ensureProjectSweepSchedule.
 *
 * Cheap gate: a pause ALWAYS disables the project-scope hook (a healthy lane
 * has it enabled), so an enabled project-scope hook means nothing is pending —
 * the common 15-min heal never touches the Activity table.
 *
 * Hooks: every listed id still targeting the lane and disabled is re-enabled
 * regardless of stock/customized (non-clobber protects template/eventTypes,
 * not the lifecycle flag; ids whose chats were deleted are cascade-gone and
 * simply do not match). Schedules: recurring rows resume with the
 * schedule.service resume shape (fresh nextRunAt when stale, lapsed expiry
 * slid); exhausted rows are skipped (the sweep ensure recreates the stock
 * sweep); a `once` row whose fire time has passed is NOT resumed — a stale
 * deferred check would fire immediately on stale premises — and is named in
 * the audit instead. Never throws.
 */
async function resumeWhatPauseDisabled(chatId: string, userId: string, projectId: string): Promise<void> {
  try {
    const projectHook = await prisma.eventHook.findFirst({
      where: { sourceChatId: null, targetChatId: chatId, projectId },
      select: { id: true, enabled: true },
    });
    if (!projectHook || projectHook.enabled !== false) return;

    const pause = await prisma.activity.findFirst({
      where: { userId, resource: 'platform', action: 'project_supervisor.pause', metadata: { path: ['chatId'], equals: chatId } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, metadata: true },
    });
    if (!pause) return;
    const alreadyResumed = await prisma.activity.findFirst({
      where: {
        userId, resource: 'platform', action: 'project_supervisor.resume',
        metadata: { path: ['chatId'], equals: chatId },
        createdAt: { gt: pause.createdAt },
      },
      select: { id: true },
    });
    if (alreadyResumed) return;

    const meta: any = pause.metadata ?? {};
    const hookIds: string[] = Array.isArray(meta.hookIds) ? meta.hookIds.map(String) : [];
    const scheduleIds: string[] = Array.isArray(meta.scheduleIds) ? meta.scheduleIds.map(String) : [];

    let hooksResumed = 0;
    if (hookIds.length) {
      const r = await prisma.eventHook.updateMany({
        where: { id: { in: hookIds }, targetChatId: chatId, enabled: false },
        data: { enabled: true },
      });
      hooksResumed = r?.count ?? 0;
    }
    // audit 2026-10-06 T5-1: while supervision was paused, start_coding_session
    // wired a direct child-result hook per in-project child (the project-scope
    // hook could not wake this chat). With the project hook live again those
    // would deliver every completion TWICE — disable them (never delete).
    // Kill switch PAUSED_SUPERVISOR_CHILD_HOOK_DISABLED=1; best-effort.
    let pausedChildHooksDisabled = 0;
    if (hooksResumed > 0 && process.env.PAUSED_SUPERVISOR_CHILD_HOOK_DISABLED !== '1') {
      try {
        const childHooks: any[] = (await prisma.eventHook.findMany({
          where: { targetChatId: chatId, userId, createdVia: 'system:child-result-hook', enabled: true },
          select: { id: true, sourceChatId: true },
        })) ?? [];
        const srcIds = [...new Set(childHooks.map((h: any) => h.sourceChatId).filter(Boolean))] as string[];
        const inProject = srcIds.length
          ? await prisma.crossModelChat.findMany({ where: { id: { in: srcIds }, projectId }, select: { id: true } })
          : [];
        const inIds = new Set((inProject ?? []).map((c: any) => c.id));
        const dupIds = childHooks.filter((h: any) => inIds.has(h.sourceChatId)).map((h: any) => h.id);
        if (dupIds.length) {
          const d = await prisma.eventHook.updateMany({ where: { id: { in: dupIds }, enabled: true }, data: { enabled: false } });
          pausedChildHooksDisabled = d?.count ?? 0;
        }
      } catch (err: any) {
        logger.warn(`project supervisor: paused-era child hook cleanup failed for lane ${chatId.slice(0, 8)}: ${err?.message}`);
      }
    }

    let schedulesResumed = 0;
    const skippedStaleOnce: string[] = [];
    const skippedExhausted: string[] = [];
    const skippedCancelled: string[] = [];
    const skippedDormant: string[] = [];
    // Goal-gate (ticket b1d435fd): on a DORMANT project the pause's schedule
    // ids STAY parked — toggle-ON restores the hooks above (the zero-token
    // wake path for new work) but must not re-arm zero-work heartbeats.
    // Evaluated once here and again in ensureProjectSweepSchedule right after
    // (each function gates independently — no cross-call state to drift).
    const dormancy = scheduleIds.length ? await evaluateProjectDormancy(projectId) : null;
    if (scheduleIds.length && dormancy?.dormant) {
      skippedDormant.push(...scheduleIds);
      logger.info(`project supervisor: ${scheduleIds.length} paused schedule(s) on lane ${chatId.slice(0, 8)} left parked — ${dormancy.reason}`);
    } else if (scheduleIds.length) {
      const rows = await prisma.chatSchedule.findMany({
        where: { id: { in: scheduleIds }, sessionId: chatId, enabled: false },
        select: { id: true, kind: true, nextRunAt: true, intervalSec: true, maxRuns: true, runsCount: true, expiresAt: true, lastStatus: true },
      });
      const now = Date.now();
      for (const row of rows) {
        // ff0f6ad9: a row EXPLICITLY CANCELLED after the pause was recorded is a
        // deliberate stop — toggle-ON must not silently revert it either.
        if ((row as any).lastStatus === 'cancelled') { skippedCancelled.push(row.id); continue; }
        const exhausted = (row.maxRuns != null && row.runsCount >= row.maxRuns) || (row.kind === 'once' && row.runsCount >= 1);
        if (exhausted) { skippedExhausted.push(row.id); continue; }
        const nextAt = new Date(row.nextRunAt as any).getTime();
        const stale = !Number.isFinite(nextAt) || nextAt <= now;
        if (row.kind === 'once' && stale) { skippedStaleOnce.push(row.id); continue; }
        const expAt = row.expiresAt ? new Date(row.expiresAt as any).getTime() : null;
        const data: Record<string, any> = { enabled: true, lastStatus: 'resumed', cancelledBy: null, disabledAt: null, busySkips: 0 };
        if (stale) data.nextRunAt = new Date(now + (row.intervalSec ?? PROJECT_SWEEP_INTERVAL_SEC) * 1000);
        if (expAt !== null && expAt <= now) data.expiresAt = new Date(now + PROJECT_SWEEP_LIFETIME_MS);
        try {
          await prisma.chatSchedule.update({ where: { id: row.id }, data });
          schedulesResumed += 1;
        } catch (err: any) {
          logger.warn(`project supervisor: schedule resume failed for ${row.id.slice(0, 8)}: ${err?.message}`);
        }
      }
    }

    await audit(userId, 'project_supervisor.resume', {
      projectId, chatId, pauseActivityId: pause.id,
      hookIds, scheduleIds, hooksResumed, schedulesResumed, skippedStaleOnce, skippedExhausted, skippedCancelled, skippedDormant,
      ...(pausedChildHooksDisabled ? { pausedChildHooksDisabled } : {}),
      ...(hookIds.length === 0 && scheduleIds.length === 0 ? { note: 'pause audit predates id recording — nothing to resume by id; stock fallbacks apply' } : {}),
    });
    logger.info(
      `project supervisor: resumed lane ${chatId.slice(0, 8)} for project ${projectId.slice(0, 8)} ` +
      `(${hooksResumed}/${hookIds.length} hook(s), ${schedulesResumed}/${scheduleIds.length} schedule(s) re-enabled` +
      `${skippedStaleOnce.length ? `, ${skippedStaleOnce.length} stale once-row(s) left paused` : ''}` +
      `${skippedDormant.length ? `, ${skippedDormant.length} row(s) left parked on the dormant project (b1d435fd)` : ''}` +
      `${skippedCancelled.length ? `, ${skippedCancelled.length} explicitly-cancelled row(s) left stopped (ff0f6ad9)` : ''})`,
    );
  } catch (err: any) {
    logger.warn(`project supervisor: resume failed for lane ${String(chatId).slice(0, 8)}: ${err?.message}`);
  }
}

/**
 * Watchdog reconcile (attention-watchdog sweep, per user):
 *   1. ensure a lane for every OWNED project carrying the flag;
 *   2. pause every isProjectSupervisor lane whose project is missing /
 *      archived / flag=false (or no longer owned — defensive);
 *   3. disable STALE project-scope hooks whose target lane's projectId no
 *      longer matches the hook's projectId (the chat moved projects) —
 *      disabled, never deleted.
 * Never throws.
 */
export async function healProjectSupervisors(userId: string): Promise<void> {
  try {
    if (!userId) return;

    // 1. Scaffold missing lanes (flag ON).
    const eligible = await prisma.crossModelProject.findMany({
      where: { userId, projectSupervisorEnabled: true, isUserSpace: false, archivedAt: null },
      select: { id: true },
    });
    for (const p of eligible) {
      await ensureProjectSupervisor(userId, p.id); // never throws
    }

    // 2. Pause lanes whose project left eligibility.
    const lanes = await prisma.crossModelChat.findMany({
      where: { userId, isProjectSupervisor: true },
      select: { id: true, projectId: true },
    });
    const laneProjectIds = [...new Set(lanes.map((l) => l.projectId).filter((x): x is string => !!x))];
    const laneProjects = laneProjectIds.length
      ? await prisma.crossModelProject.findMany({
          where: { id: { in: laneProjectIds } },
          select: { id: true, userId: true, isUserSpace: true, archivedAt: true, projectSupervisorEnabled: true },
        })
      : [];
    const projectById = new Map(laneProjects.map((p) => [p.id, p]));
    for (const lane of lanes) {
      await stripStrayCodingState(userId, lane.id); // plain chat by design — never a coding satellite
      if (!lane.projectId) continue; // detached — the GC's job
      const proj = projectById.get(lane.projectId);
      const stale = !proj || proj.userId !== userId || proj.isUserSpace || !!proj.archivedAt || proj.projectSupervisorEnabled !== true;
      if (stale) await pauseProjectSupervisor(userId, lane.projectId); // never throws
    }

    // 3. Chat-moved hooks: disable project-scope hooks whose lane drifted to
    //    a different project (or vanished).
    const projectHooks = await prisma.eventHook.findMany({
      where: { userId, sourceChatId: null, projectId: { not: null }, enabled: true },
      select: { id: true, targetChatId: true, projectId: true },
    });
    if (projectHooks.length) {
      const targetIds = [...new Set(projectHooks.map((h) => h.targetChatId))];
      const targets = await prisma.crossModelChat.findMany({
        where: { id: { in: targetIds } },
        select: { id: true, projectId: true },
      });
      const targetById = new Map(targets.map((t) => [t.id, t]));
      for (const hook of projectHooks) {
        const target = targetById.get(hook.targetChatId);
        if (target && target.projectId === hook.projectId) continue; // still matched
        try {
          await prisma.eventHook.update({ where: { id: hook.id }, data: { enabled: false } });
          await audit(userId, 'hook.update', {
            hookId: hook.id, targetChatId: hook.targetChatId, projectId: hook.projectId,
            reason: 'project supervisor heal: lane chat moved out of the hook project (stale project-scope hook)',
          });
        } catch (err: any) {
          logger.warn(`project supervisor: stale-hook disable failed for ${hook.id.slice(0, 8)}: ${err?.message}`);
        }
      }
    }
  } catch (err: any) {
    logger.warn(`project supervisor: heal failed for owner ${String(userId).slice(0, 8)}: ${err?.message}`);
  }
}

/**
 * Rollout watch 2026-09-14: a supervisor lane that acquired a ChatCodingState
 * satellite (the Fleet Supervisor's agent send tripped the code-intent router
 * before the isProjectSupervisor guard existed) woke as a CODING run — a
 * worktree on box C, a worker slot per wake, CodeSessionView in the UI. Strip
 * the satellite when the lane is idle (an in-flight coding run finalizes
 * against the row; deleting it mid-run would break that finalize). The
 * worktree directory is reaped by the on-disk census once the row is gone.
 * Idempotent, never throws. Returns true when a row was removed.
 */
export async function stripStrayCodingState(
  userId: string,
  chatId: string,
  opts: { cancelQueued?: boolean } = {},
): Promise<boolean> {
  try {
    const state = await prisma.chatCodingState.findUnique({ where: { id: chatId }, select: { id: true, worktreePath: true, branch: true } });
    if (!state) return false;
    const running = await prisma.agentRun.count({ where: { sessionId: chatId, status: 'running' } });
    if (running > 0) {
      logger.info(`project supervisor: lane ${chatId.slice(0, 8)} has a stray coding satellite but ${running} run(s) in flight — strip deferred`);
      return false;
    }
    // Queued (not yet started) coding wakes for the lane: with cancelQueued
    // (the run-finalize path — the lane is provably idle THIS instant) they are
    // cancelled so the worker never claims a run whose session row is gone;
    // the lane's hook/schedule re-fires as a PLAIN chat wake from here on.
    // Without it (the 15-min heal), a queued run defers the strip like a
    // running one did before.
    const queued = await prisma.agentRun.count({ where: { sessionId: chatId, status: 'queued' } });
    if (queued > 0) {
      if (!opts.cancelQueued) {
        logger.info(`project supervisor: lane ${chatId.slice(0, 8)} has ${queued} queued coding wake(s) — strip deferred to the run-finalize path`);
        return false;
      }
      await prisma.agentRun.updateMany({
        where: { sessionId: chatId, status: 'queued' },
        data: { status: 'cancelled', error: 'supervisor lane restored to a plain chat — this queued coding wake is superseded by the lane\'s next hook/schedule wake', finishedAt: new Date() },
      });
    }
    await prisma.chatCodingState.delete({ where: { id: chatId } });
    await audit(userId, 'project_supervisor.strip_coding_state', {
      chatId, branch: state.branch, worktreePath: state.worktreePath, cancelledQueuedRuns: opts.cancelQueued ? queued : 0,
      reason: 'supervisor lanes are plain chats by design — a lazily attached workspace satellite was removed (rollout watch 2026-09-14)',
    });
    logger.warn(`project supervisor: stripped stray coding satellite from lane ${chatId.slice(0, 8)} (branch ${state.branch}${queued ? `, ${queued} queued wake(s) cancelled` : ''})`);
    return true;
  } catch (err: any) {
    logger.warn(`project supervisor: strip coding state failed for ${chatId.slice(0, 8)}: ${err?.message}`);
    return false;
  }
}

/**
 * GC detached lanes: isProjectSupervisor chats whose projectId is NULL (the
 * project was deleted — the FK SetNull detached the chat). Disable their
 * hooks + schedules and flip isProjectSupervisor=false so they drop out of
 * the supervisor attach/state paths; the chat itself is NEVER deleted (it is
 * the owner's transcript). Returns the count detached THIS call. Never throws.
 */
export async function gcDetachedProjectSupervisors(userId: string): Promise<number> {
  try {
    if (!userId) return 0;
    const detached = await prisma.crossModelChat.findMany({
      where: { userId, isProjectSupervisor: true, projectId: null },
      select: { id: true },
    });
    let count = 0;
    for (const lane of detached) {
      try {
        // Every hook that wakes the lane (project-scope AND direct) — same
        // widening as pauseProjectSupervisor: a detached lane must not be woken.
        await prisma.eventHook.updateMany({
          where: { targetChatId: lane.id },
          data: { enabled: false },
        });
        await prisma.chatSchedule.updateMany({
          where: { sessionId: lane.id },
          data: { enabled: false },
        });
        await prisma.crossModelChat.update({
          where: { id: lane.id },
          data: { isProjectSupervisor: false },
        });
        await audit(userId, 'project_supervisor.gc_detach', {
          chatId: lane.id,
          reason: 'isProjectSupervisor chat with projectId null (project deleted) — hooks/schedules disabled, flag cleared; chat kept',
        });
        count += 1;
      } catch (err: any) {
        logger.warn(`project supervisor: GC failed for lane ${lane.id.slice(0, 8)}: ${err?.message}`);
      }
    }
    return count;
  } catch (err: any) {
    logger.warn(`project supervisor: GC failed for owner ${String(userId).slice(0, 8)}: ${err?.message}`);
    return 0;
  }
}

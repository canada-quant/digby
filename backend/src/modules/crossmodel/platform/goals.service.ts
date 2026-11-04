/**
 * Fleet supervisor (slice C) — GOALS + TODOS with cross-project dependencies.
 * Spec: docs/FLEET_SUPERVISOR_DESIGN.md §4.
 *
 * A ProjectGoal lives in one project; a ProjectTodo lives under one goal (its
 * projectId is denormalized from the goal for fleet-wide queries). Goals may
 * depend on goals in OTHER projects of the SAME OWNER (GoalDependency;
 * cross-USER deps are rejected), todos likewise (TodoDependency). All writes
 * are cycle-checked via DFS over the dependency edges.
 *
 * Status model:
 *   - goal: active | blocked | done | archived. ARCHIVED COUNTS AS DONE for
 *     dependency purposes (an archived goal no longer blocks its dependents).
 *   - todo: pending | in_progress | blocked | done | dropped (P7 N5: TERMINAL
 *     owner-superseded cancellation — satisfies dependencies like done,
 *     excluded from digest pace/ETA; machine drops require evidence citing
 *     the superseding directive).
 *   - 'done' is GATED: all dep goals must be done-ish (done|archived) / all
 *     dep todos done-ish (done|dropped), else 409 — unless the caller passes
 *     force: true, which overrides and writes a goal.force_done /
 *     todo.force_done audit row.
 *   - 'blocked' requires a blockedReason (default 'Blocked manually').
 *
 * Blocked propagation (recomputeDependents):
 *   - A row whose blockedReason starts with '[deps]' was blocked BY THE
 *     PROPAGATOR and auto-restores (goal → active, todo → pending) once every
 *     dependency is done; a MANUALLY blocked row (no prefix) is never
 *     auto-unblocked.
 *   - recomputeDependents(id, kind) BFS-walks the DEPENDENT closure (reverse
 *     edges) with a visited-set cycle guard, recomputing each dependent's
 *     shouldBeBlocked = any dep not done. Newly dep-blocked goals emit a
 *     goal_blocked hook event (source chat: createdByChatId, skipped when
 *     null); restores audit AND wake the assignee chat (resume propagation,
 *     2026-08-30 — a silent unblock left lanes idle after their blocker
 *     cleared). Done/archived rows are never re-blocked.
 *   - A todo reaching 'done' emits todo_done on its assigneeChatId (skipped
 *     when unset — emission needs a source chat), then unblocks dependent
 *     todos, then checks the parent goal: ALL todos done AND all goal-deps
 *     done-ish ⇒ the goal auto-marks done (audit + its own dependents
 *     recompute).
 *   - A todo becoming ACTIONABLE for an assignee (assigned while unblocked,
 *     manually unblocked, dep-auto-unblocked) wakes the assignee chat via the
 *     fireScheduleTarget machine-run path, debounced 5 min/chat and budgeted
 *     against the chat's daily machine-run cap (wakeTodoAssignee).
 *
 * Access: mirrors platform.service's read/write split — READ needs owner OR
 * any project member (viewer included); WRITE needs owner/editor/admin
 * (viewers → 403). Non-members get 404 so existence isn't leaked.
 *
 * Account-wide listing (owner decision 2026-08-13, 'All projects, tagged'):
 * listGoals/listTodos with NO project filter list across every project the
 * user OWNS — directly OR via an owned ancestor folder (the same ownership
 * notion as platform.service.getProjectAccess, which grants an ancestor owner
 * role 'owner') — each row tagged with projectName. Cross-user isolation:
 * projects merely shared WITH the user never join the global list (they stay
 * readable only via their explicit projectId, under the membership rules
 * above).
 *
 * Hook emissions go through a DYNAMIC import of hooks.service
 * (emitHookEventSafe) and never throw — the outbox must never block a write.
 */

import { randomUUID } from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import { foldersInheritanceOn, getAncestorChain } from './folder-inheritance';
// Gate flip 2026-09-11: evidence-less machine todo closes are telemetered
// (loop-metrics.service imports only prisma + logger — both already static here).
import { recordLoopMetric, LOOP_METRIC_KINDS } from './loop-metrics.service';
// Ticket fadc3563 (2026-10-04): pure hold-classifier leaf — same convention as
// goal-done-suspect (no prisma, no model, statically importable).
import { isHoldAnswer } from './owner-hold-answer';
import { ownerProvenanceStrictDisabled } from './owner-authority-switches';
import { PROGRESS_NOTE_MAX, progressNoteMax, clipProgressNote } from './progress-note';
import { isFullChatIdShape, nearMatchChatId, NEAR_MATCH_MAX_DISTANCE, NEAR_MATCH_PREFIX_CHARS } from './chat-id-near-match';
import { healIdRef } from './id-ref';
import { normalizePremises, premiseEvictionNotice, readPremises, type KpiRefusalReason } from './premise-register';
import { isKpiPremise } from './kpi-of-record';
// GOAL-PRIORITY-SPEND (2026-10-20): the pure ranking rules (P1..P4, owner-set wins).
import {
  parseGoalPriorityInput, parseGoalDueAtInput, decidePriorityWrite, priorityRefusalNote, ownerTextBacksRanking,
  validGoalPriority, goalPriorityLabel, type GoalPrioritySource,
} from './goal-priority';

/**
 * The KPI contract is the ONE gate on the kpi-honesty branch that can refuse a
 * lane, and until the fixer follow-up (2026-09-27) it emitted no telemetry —
 * only the success path recorded kpi_premise_set, so the refusal rate (the
 * number the 2026-09-11 gate-flip review needs for every gate) was
 * unmeasurable. One row per refusal, before the throw; never throws itself.
 */
function recordKpiPremiseRefusal(input: { reason: KpiRefusalReason; goalId: string; projectId: string; key: string; receiptId?: string | null; sessionId?: string | null }): void {
  recordLoopMetric({
    kind: LOOP_METRIC_KINDS.KPI_PREMISE_REFUSED, sessionId: input.sessionId ?? undefined,
    meta: { gate: 'kpi_contract', reason: input.reason, goalId: input.goalId, projectId: input.projectId, key: input.key, receiptId: input.receiptId ? String(input.receiptId).slice(0, 8) : null, sessionId: input.sessionId ?? null },
  });
}
// sup3 audit C2 (2026-09-27): observe-only done-suspect assessment at both
// close seams (pure leaf — no prisma, no model).
import {
  assessGoalDoneSuspect, GOAL_DONE_SUSPECT_DIRECTIVE_WINDOW_MS,
  directiveNamesGoal, isOriginatingDirective,
  type GoalDoneSuspectDirective, type GoalDoneSuspectVerdict,
} from './goal-done-suspect';
// GOAL-OUTCOME-UNMET (architecture review #3, 2026-10-20): pure outcome
// assessment + the close record (its store access is a dynamic import inside).
import {
  goalOutcomeOf, goalOutcomeCheckDisabled, goalOutcomeGateEnforce, goalOutcomeFingerprint, goalOutcomeWakeDedupeKey,
  renderGoalOutcomeUnmetWake, outcomeUnmetProgressNote, recordGoalOutcomeClose, acceptGoalOutcomeClose,
  ownerTextNamesGoalClose, goalOutcomeCloseNote, outcomeCloseStillLive, readGoalOutcomeClose,
  GOAL_OUTCOME_WAKE_DEDUPE_SEC, type GoalOutcome, type GoalActorKind,
} from './goal-outcome';

export const GOAL_STATUSES = ['active', 'blocked', 'done', 'archived'] as const;
// 'dropped' (remediation P7 N5): TERMINAL owner-superseded cancellation — the
// honest status for work an owner directive cancelled (previously left rotting
// as 'blocked'). Excluded from digest pace/ETA and blocked counts; satisfies
// dependencies like 'done' (a dependent must not wait on cancelled work).
// Machine runs may set it ONLY with evidence citing the superseding directive
// (the P4 machine-close gate).
export const TODO_STATUSES = ['pending', 'in_progress', 'blocked', 'done', 'dropped'] as const;
export type GoalStatus = typeof GOAL_STATUSES[number];
export type TodoStatus = typeof TODO_STATUSES[number];

/** Todo statuses that satisfy a dependency (dropped counts as done — a
 *  dependent must not wait forever on owner-cancelled work). */
export const TODO_DONE_ISH = new Set<string>(['done', 'dropped']);

/**
 * blockedReason prefix marking a row blocked BY DEPENDENCY PROPAGATION — only
 * these rows are auto-unblocked by recomputeDependents. Manual blocks (any
 * other reason) are never auto-unblocked.
 */
export const DEPS_BLOCK_PREFIX = '[deps]';

/** Goal statuses that satisfy a dependency (archived counts as done). */
const GOAL_DONE_ISH = new Set<string>(['done', 'archived']);

function isDepBlocked(blockedReason: string | null | undefined): boolean {
  return String(blockedReason ?? '').startsWith(DEPS_BLOCK_PREFIX);
}

function depsReason(n: number, kind: 'goal' | 'todo'): string {
  return `${DEPS_BLOCK_PREFIX} Waiting on ${n} ${kind}${n === 1 ? '' : 's'}`;
}

function iso(v: any): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export interface GoalView {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  blockedReason: string | null;
  createdByChatId: string | null;
  /** Authorship of the latest row write (ticket c286ba91) — null = user/REST/framework. */
  updatedByChatId: string | null;
  updatedByRunId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  [key: string]: any;
}

export interface TodoView {
  id: string;
  goalId: string;
  projectId: string;
  title: string;
  status: string;
  blockedReason: string | null;
  assigneeChatId: string | null;
  /** Evidence the closing update carried (P4 v1#10) — null until done-with-evidence. */
  evidence: string | null;
  /** The agent run whose update closed this todo (machine closes) — null otherwise. */
  doneRunId: string | null;
  /** Authorship of the latest row write (ticket c286ba91) — null = user/REST/framework. */
  updatedByChatId: string | null;
  updatedByRunId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  [key: string]: any;
}

function goalView(g: any, extra: Record<string, any> = {}): GoalView {
  return {
    id: g.id,
    projectId: g.projectId,
    title: g.title,
    description: g.description ?? '',
    status: g.status,
    blockedReason: g.blockedReason ?? null,
    blockKind: g.blockKind ?? null,
    gateQuestionId: g.gateQuestionId ?? null,
    // When the current block began (review fix 2026-09-27) — tolerant of pre-migration rows.
    blockedAt: iso(g.blockedAt),
    // Progress-aware pulse (P7 v1#20).
    progressNote: g.progressNote ?? null,
    // Premise register (owner 2026-09-16, item 2) — tolerant of pre-migration rows.
    premises: Array.isArray(g.premises) ? g.premises : [],
    // GOAL-PRIORITY-SPEND (2026-10-20): stored priority (null = unset), the label it RANKS at (unset = P2),
    // who set the ranking ('owner' | 'machine' | null) and the optional due date — tolerant of pre-migration rows.
    priority: validGoalPriority(g.priority),
    priorityLabel: goalPriorityLabel(g.priority),
    prioritySource: g.prioritySource ?? null,
    dueAt: iso(g.dueAt),
    createdByChatId: g.createdByChatId ?? null,
    // Gate-write authorship (ticket c286ba91) — tolerant of pre-migration rows.
    updatedByChatId: g.updatedByChatId ?? null,
    updatedByRunId: g.updatedByRunId ?? null,
    createdAt: iso(g.createdAt),
    updatedAt: iso(g.updatedAt),
    ...extra,
  };
}

function todoView(t: any, extra: Record<string, any> = {}): TodoView {
  return {
    id: t.id,
    goalId: t.goalId,
    projectId: t.projectId,
    title: t.title,
    status: t.status,
    blockedReason: t.blockedReason ?? null,
    blockKind: t.blockKind ?? null,
    gateQuestionId: t.gateQuestionId ?? null,
    // When the current block began (review fix 2026-09-27) — tolerant of pre-migration rows.
    blockedAt: iso(t.blockedAt),
    // Progress-aware pulse (P7 v1#20).
    progressNote: t.progressNote ?? null,
    startedAt: iso(t.startedAt),
    assigneeChatId: t.assigneeChatId ?? null,
    evidence: t.evidence ?? null,
    doneRunId: t.doneRunId ?? null,
    // Gate-write authorship (ticket c286ba91) — tolerant of pre-migration rows.
    updatedByChatId: t.updatedByChatId ?? null,
    updatedByRunId: t.updatedByRunId ?? null,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
    ...extra,
  };
}

/** Progress-note storage cap (P7 v1#20; raised 200 → 2,000 by ticket a8d6e514 —
 *  standing loops keep their continuation ledger in the note, and the 200 clamp
 *  amputated it mid-word). Displays stay bounded via progress-note.ts
 *  progressNoteForDisplay; PROGRESS_NOTE_LONG_DISABLED=1 stores 200 again
 *  (writes call progressNoteMax(), never the constant). */
export { PROGRESS_NOTE_MAX };

/** Remediation P2 S2a — typed block provenance. */
export const BLOCK_KINDS = ['deps', 'owner', 'agent', 'external'] as const;

/**
 * Fold the optional blockKind/gateQuestionId updates into a write's data
 * object (validated apply-or-throw; null/'' clears). Runs AFTER the status
 * handling so an explicit value this call wins over the unblock auto-clear.
 */
function applyBlockProvenance(
  data: Record<string, any>,
  opts: { blockKind?: string | null; gateQuestionId?: string | null },
): void {
  if (opts.blockKind !== undefined) {
    if (opts.blockKind === null || String(opts.blockKind).trim() === '') {
      data.blockKind = null;
    } else {
      const kind = String(opts.blockKind).trim();
      if (!(BLOCK_KINDS as readonly string[]).includes(kind)) {
        throw new AppError(400, `blockKind must be one of: ${BLOCK_KINDS.join(', ')} (or null to clear)`);
      }
      data.blockKind = kind;
    }
  }
  if (opts.gateQuestionId !== undefined) {
    const id = opts.gateQuestionId === null ? '' : String(opts.gateQuestionId).trim();
    data.gateQuestionId = id ? id.slice(0, 60) : null;
  }
}

/**
 * Store-side phantom-gate guard (ticket d76750f5, 2026-09-18): a gateQuestionId
 * write must reference an EXISTING owner_questions row owned by the SAME owner
 * as the goal/todo — OR (ticket be94fa64, 2026-09-19) by the ACTING account.
 * Before this guard any ≤60-char string landed verbatim — a lane could re-point
 * a todo's gate at a HALLUCINATED oq_ id (the New Hampshire incident: gate
 * flipped to oq_4694abca…, which matched no row, orphaning the real open card
 * oq_1fc19541; the SECOND contradictory flip on the same todo in 2 days, writer
 * unidentified). The read probe's shapes are accepted — a full oq_ id, or a
 * unique ≥8-char prefix (a bare hex prefix is normalized with the oq_ prefix,
 * mirroring action-verifier) — and a resolved prefix is stored as the FULL row
 * id. Existence-only, any status: pointing at an answered/dismissed row is the
 * stale-gate class the attention-watchdog already flags, not a phantom. 400s on
 * no-match / ambiguous prefix so a phantom gate can never silently land.
 *
 * Acting-account scope (be94fa64): owner_questions rows carry the userId of the
 * account whose lane FLAGGED them (flag_owner_question), but goals/todos carry
 * the PROJECT owner's userId. In a shared project a member lane (editor/admin)
 * therefore could never wire its own flagged question as a gate — flag accepted
 * the linkage, list_owner_questions (acting-scoped) showed the row, yet this
 * resolver (owner-scoped) refused it, stranding the phantom it was deployed to
 * repair (the live New Hampshire repro: todo 4501c4b0, oq_1fc19541 flagged by
 * the member fleet-supervisor account). The guard now probes rows owned by the
 * goal/todo owner OR the acting user — matching exactly the ids the acting lane
 * can see (its own) plus the ones the row's owner can see — while a THIRD
 * party's rows still 400 (cross-tenant isolation preserved). Every read
 * surface (attention-watchdog, owner-gate-sweeper) already probes gate rows by
 * bare id with no userId scope, so a member-owned gate id renders/sweeps
 * unchanged.
 */
export async function resolveGateQuestionId(ownerUserId: string, raw: string, actingUserId?: string): Promise<string> {
  const input = String(raw ?? '').trim();
  const probe = input.startsWith('oq_') ? input : `oq_${input}`;
  const userIds = actingUserId && actingUserId !== ownerUserId ? [ownerUserId, actingUserId] : [ownerUserId];
  const scope = userIds.length === 1 ? { userId: userIds[0] } : { userId: { in: userIds } };
  const exact = await prisma.ownerQuestion.findFirst({
    where: { id: probe, ...scope },
    select: { id: true },
  });
  if (exact) return exact.id;
  if (probe.length >= 8) {
    const matches = await prisma.ownerQuestion.findMany({
      where: { ...scope, id: { startsWith: probe } },
      select: { id: true },
      take: 2,
    });
    if (matches.length === 1) return matches[0].id;
  }
  throw new AppError(
    400,
    `gateQuestionId "${input}" matches no owner_questions row for this owner or your account — a gate cannot point at a question that does not exist. ` +
    `Flag it first with flag_owner_question, or probe list_owner_questions for the real oq_ id.`,
  );
}

/**
 * Pass-through for the undefined/null/empty shapes (clear is always allowed —
 * clearing a phantom gate is the REPAIR, never refused); resolves a real id
 * through resolveGateQuestionId. Keeps the updateGoal/updateTodo call sites to
 * one line. `actingUserId` (ticket be94fa64) widens the existence probe to the
 * caller's own flagged questions — member-lane rows in shared projects.
 */
async function maybeResolveGate(
  gateQuestionId: string | null | undefined,
  ownerUserId: string,
  actingUserId?: string,
): Promise<string | null | undefined> {
  if (gateQuestionId === undefined || gateQuestionId === null) return gateQuestionId;
  if (String(gateQuestionId).trim() === '') return gateQuestionId; // '' clears downstream
  return resolveGateQuestionId(ownerUserId, gateQuestionId, actingUserId);
}

/**
 * Gate visibility annotation (ticket 973d7f80, 2026-09-19) — the READ-side
 * half of the cross-tenant tug-of-war fix. In a SHARED project the gate on a
 * todo/goal may point at an owner_questions row owned by a DIFFERENT account
 * (the project owner's card, or another member lane's — flag_owner_question
 * stamps the FLAGGING account's userId, and be94fa64 lets either side wire its
 * own rows). Before this annotation, todo_get/goal_get rendered the bare
 * gateQuestionId with no ownership signal: each side's lane probed the OTHER
 * side's card with the caller-scoped list_owner_questions, got "unmatched",
 * diagnosed a phantom, and "repaired" the gate to its own card — the verified
 * New Hampshire flip-flop (flips 9/18 14:21Z, 20:31Z, 9/19 02:28Z + 08:12Z).
 *
 * The probe is by BARE ID with NO userId scope — exactly how every gate read
 * surface (attention-watchdog, owner-gate-sweeper) already resolves gates —
 * and discloses only EXISTENCE + STATUS + ownership-divergence, never the
 * question/answer text. The caller already passed requireProjectRead on the
 * row's project, so the gate id itself was already visible to them; the label
 * adds nothing a determined reader could not derive, and kills the phantom
 * misdiagnosis:
 *
 *   - 'resolvable'        — the row exists AND belongs to the caller's own
 *                           account: probe/answer it via list_owner_questions.
 *   - 'other-member-owned'— the row exists but belongs to a DIFFERENT account
 *                           (typically another member of this shared project).
 *                           It is REAL — NEVER re-point the gate just because
 *                           YOUR list_owner_questions cannot see it. Only that
 *                           account's surfaces can answer it; the gate clears
 *                           for everyone when answered.
 *   - 'unmatched'         — no row anywhere: the genuine d76750f5 phantom
 *                           class (a stale/hallucinated id). Clearing the gate
 *                           (null) remains the repair.
 *
 * gateQuestionStatus rides along when a row exists (open|answered|dismissed)
 * so a lane can see an ANSWERED cross-member gate is cleared without a second
 * probe. null gate → both fields null. Pre-guard legacy rows may store a bare
 * ≥8-char prefix (the guard now stores full ids) — the startsWith fallback
 * mirrors listOwnerQuestionsForUser's resolution semantics, INCLUDING its
 * ambiguity guard (ticket 56284f30 F1): a prefix matching ≠1 row resolves to
 * 'unmatched' rather than labelling ownership/status off an arbitrary row.
 */
export async function gateQuestionVisibilityFor(
  gateQuestionId: string | null | undefined,
  actingUserId: string,
): Promise<{ gateQuestionVisibility: 'resolvable' | 'other-member-owned' | 'unmatched' | null; gateQuestionStatus: string | null }> {
  const id = String(gateQuestionId ?? '').trim();
  if (!id) return { gateQuestionVisibility: null, gateQuestionStatus: null };
  const select = { id: true, userId: true, status: true } as const;
  let row: any = await prisma.ownerQuestion.findUnique({ where: { id }, select });
  if (!row && id.length >= 8) {
    // Ticket 56284f30 (F1): take: 2 + resolve ONLY on exactly one candidate —
    // a legacy prefix-stored gate colliding with a cross-tenant id prefix must
    // not mislabel ownership/status off an arbitrary findFirst row (0 = true
    // phantom, >1 = ambiguous; both stay unmatched, mirroring the probe path's
    // candidates.length !== 1 guard).
    const candidates: any[] = await prisma.ownerQuestion.findMany({
      where: { id: { startsWith: id } },
      select,
      take: 2,
    });
    if (Array.isArray(candidates) && candidates.length === 1) row = candidates[0];
  }
  if (!row) return { gateQuestionVisibility: 'unmatched', gateQuestionStatus: null };
  return {
    gateQuestionVisibility: row.userId === actingUserId ? 'resolvable' : 'other-member-owned',
    gateQuestionStatus: row.status ?? null,
  };
}

/** Best-effort audit trail (Activity, resource 'platform') — mirrors platform.service. */
async function audit(userId: string, action: string, metadata?: Record<string, any>): Promise<void> {
  try {
    await prisma.activity.create({
      data: { userId, action, resource: 'platform', ...(metadata ? { metadata } : {}) },
    });
  } catch (err: any) {
    logger.warn(`platform audit write failed (${action}): ${err.message}`);
  }
}

// ── GOAL-PRIORITY-SPEND (2026-10-20): the ranking-field write (priority / dueAt) ──

/** Is the acting chat supervisor-class (Fleet or project supervisor)? false on no chat / a read error. */
async function actingChatIsSupervisor(chatId: string | undefined): Promise<boolean> {
  if (!chatId) return false;
  try {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { isSupervisor: true, isProjectSupervisor: true } }) as { isSupervisor?: boolean; isProjectSupervisor?: boolean } | null;
    return !!(chat?.isSupervisor || chat?.isProjectSupervisor);
  } catch {
    return false;
  }
}

export interface RankingWrite {
  /** Columns to merge into the row write (empty when nothing applies). */
  data: Record<string, any>;
  outcome: 'none' | 'set' | 'cleared' | 'refused_owner_set' | 'refused_not_supervisor';
  source?: GoalPrioritySource;
  /** Who wrote (owner / member / machine) — set whenever ranking fields were supplied. */
  writer?: GoalPrioritySource;
  /** The write was allowed at read time but an owner ranking landed first (the conditional write found it). */
  raced?: boolean;
  /** The tool-result note for a refused write (the rest of the call still applied). */
  note?: string;
  from: number | null;
  to: number | null;
}

/**
 * Resolve a write's ranking fields against the owner rules (goal-priority.ts):
 * invalid input 400s BEFORE anything writes; the OWNER always writes (source
 * 'owner'); a MEMBER (another human with write access) writes unless the
 * ranking is owner-set (source 'member' — not a lock); a MACHINE writes only
 * from a supervisor-class chat on a goal whose ranking is not owner-set
 * (source 'machine') — otherwise the fields are left untouched and the caller
 * gets a note (apply-or-explain, never silent). Clearing both fields clears
 * the source. Exported for tests.
 *
 * Who writes (review fix 2026-10-20): `writer` when the caller knows (JWT REST
 * = 'owner', a dgt_ token / machine run = 'machine'); else `ownerTurnText` —
 * a human tool turn — ranks as 'owner' only when that text BACKS this write
 * (goal-priority.ts ownerTextBacksRanking: names the level / due date it sets,
 * or points at this goal), otherwise 'machine'. An 'owner' writer who is not
 * the PROJECT owner (`actorIsProjectOwner` false — a shared project's editor)
 * writes as 'member'.
 */
export async function resolveRankingWrite(input: {
  priority: unknown;
  dueAt: unknown;
  current: { priority?: number | null; prioritySource?: string | null; dueAt?: Date | string | null } | null;
  writer?: GoalPrioritySource;
  /** A human tool turn's own text (used only when `writer` is absent). */
  ownerTurnText?: string;
  /** The goal the text must point at ({id, title}; a create passes the new title). */
  goalRef?: { id?: string | null; title?: string | null } | null;
  /** False when the acting user is not the project owner (default true — tests / legacy callers). */
  actorIsProjectOwner?: boolean;
  actingChatId?: string;
}): Promise<RankingWrite> {
  const p = parseGoalPriorityInput(input.priority);
  const d = parseGoalDueAtInput(input.dueAt);
  if (p.kind === 'invalid') throw new AppError(400, p.error);
  if (d.kind === 'invalid') throw new AppError(400, d.error);
  const from = validGoalPriority(input.current?.priority ?? null);
  if (p.kind === 'absent' && d.kind === 'absent') return { data: {}, outcome: 'none', from, to: from };
  const currentSource = input.current?.prioritySource ?? null;
  let writer: GoalPrioritySource = input.writer
    ?? (ownerTextBacksRanking(input.ownerTurnText, { priority: input.priority, dueAt: input.dueAt }, input.goalRef ?? null) ? 'owner' : 'machine');
  if (writer === 'owner' && input.actorIsProjectOwner === false) writer = 'member';
  const verdict = decidePriorityWrite({
    currentSource,
    writer,
    // Only read the acting chat when it can matter (a machine write on a non-owner ranking).
    actingIsSupervisor: writer === 'machine' && currentSource !== 'owner' ? await actingChatIsSupervisor(input.actingChatId) : false,
  });
  if (!verdict.allowed) {
    return { data: {}, outcome: verdict.reason, writer, note: priorityRefusalNote(verdict.reason, { priority: input.current?.priority, prioritySource: currentSource }, writer), from, to: from };
  }
  const nextPriority = p.kind === 'set' ? p.value : p.kind === 'clear' ? null : from;
  const currentDue = input.current?.dueAt ? new Date(input.current.dueAt as any) : null;
  const nextDue = d.kind === 'set' ? d.value : d.kind === 'clear' ? null : currentDue;
  const data: Record<string, any> = {};
  if (p.kind !== 'absent') data.priority = nextPriority;
  if (d.kind !== 'absent') data.dueAt = nextDue;
  const cleared = nextPriority === null && nextDue === null;
  data.prioritySource = cleared ? null : verdict.source;
  return { data, outcome: cleared ? 'cleared' : 'set', source: verdict.source, writer, from, to: nextPriority };
}

/**
 * The ranking writer a create / update call names: an explicit `rankingWriter`; else 'machine' on a machine
 * run; else undefined when a human tool turn's text is supplied (resolveRankingWrite reads it); else 'owner'
 * (an internal / REST caller that did not say). Pure.
 */
function rankingWriterOf(o: { rankingWriter?: GoalPrioritySource; rankingOwnerText?: string; machineTriggered?: boolean }): GoalPrioritySource | undefined {
  if (o.rankingWriter) return o.rankingWriter;
  if (o.machineTriggered === true) return 'machine';
  if (typeof o.rankingOwnerText === 'string') return undefined;
  return 'owner';
}

/** One `goal_priority` loop_metrics row + (on a change) a `goal.priority_set` audit row. Never throws. */
async function recordRankingWrite(userId: string, goal: { id: string; projectId: string }, rw: RankingWrite, o: { seam: 'create' | 'update'; actingChatId?: string; actingRunId?: string }): Promise<void> {
  if (rw.outcome === 'none') return;
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.GOAL_PRIORITY,
      sessionId: o.actingChatId,
      ...(o.actingRunId ? { runId: o.actingRunId } : {}),
      meta: {
        goalId: goal.id, projectId: goal.projectId, outcome: rw.outcome, seam: o.seam,
        ...(rw.source ? { source: rw.source } : {}),
        ...(rw.writer ? { writer: rw.writer } : {}),
        ...(rw.raced ? { raced: true } : {}),
        from: rw.from, to: rw.to,
        ...(rw.data.dueAt !== undefined ? { dueAt: rw.data.dueAt ? new Date(rw.data.dueAt).toISOString() : null } : {}),
      },
    });
  } catch { /* telemetry never blocks a write */ }
  if (rw.outcome === 'set' || rw.outcome === 'cleared') {
    await audit(userId, 'goal.priority_set', {
      goalId: goal.id, from: rw.from, to: rw.to, source: rw.data.prioritySource ?? null,
      ...(rw.data.dueAt !== undefined ? { dueAt: rw.data.dueAt ? new Date(rw.data.dueAt).toISOString() : null } : {}),
      seam: o.seam, actingChatId: o.actingChatId, actingRunId: o.actingRunId,
    });
  }
}

/**
 * sup3 audit C2 (2026-09-27): assess a 'done' close AFTER it landed and, when
 * suspect, record ONE observe-only `goal_done_suspect` loop_metrics row + a
 * `goal.done_suspect` audit row. The close is never refused or reverted (gate
 * flip 2026-09-11) — the tool result, the board badge and the metric are the
 * contradiction. Open owner directives ride in via a DYNAMIC import of
 * supervisor-state.service (import-graph discipline: that module pulls the
 * dormancy gate + schedule helpers); any failure there means "no directive
 * evidence", never a throw. Returns the verdict (empty when nothing is
 * suspect) so callers can surface the note.
 */
async function recordGoalDoneSuspect(
  goal: { id: string; userId: string; projectId: string; title?: string | null; progressNote?: string | null; blockedReason?: string | null; premises?: unknown; createdAt?: Date | string | null },
  seam: 'update' | 'auto',
  meta: { force?: boolean; actingChatId?: string; actingRunId?: string } = {},
): Promise<GoalDoneSuspectVerdict | null> {
  try {
    const now = Date.now();
    let directives: GoalDoneSuspectDirective[] = [];
    try {
      const { listOpenDirectivesForUser } = await import('./supervisor-state.service');
      directives = await listOpenDirectivesForUser(goal.userId, now - GOAL_DONE_SUSPECT_DIRECTIVE_WINDOW_MS);
    } catch { /* no directive evidence — the other reasons still apply */ }
    // Review fix (sup3 fixer pass, 2026-09-27 — finding 3): directives are
    // scoped to THIS goal's project (directive.scope is the project NAME or
    // 'fleet'); the leaf also drops this wake's own order (grace window) and
    // a directive that itself orders the close. No name ⇒ no scope filter.
    let projectName: string | null = null;
    try {
      const project = await prisma.crossModelProject.findUnique({ where: { id: goal.projectId }, select: { name: true } });
      projectName = (project as any)?.name ?? null;
    } catch { /* fail-open: never drop a directive on a missing fact */ }
    // audit 2026-10-08 W5-5: the goal's lanes (charter + todo assignees) — a directive whose evidence cites one of
    // them is the goal's own origin, never an open contradiction of its close.
    let laneIds: string[] = [];
    try {
      const [chats, todos] = await Promise.all([
        prisma.crossModelChat.findMany({ where: { charterGoalId: goal.id }, select: { id: true }, take: 20 }),
        prisma.projectTodo.findMany({ where: { goalId: goal.id, assigneeChatId: { not: null } }, select: { assigneeChatId: true }, take: 50 }),
      ]);
      laneIds = Array.from(new Set([...(chats ?? []).map((c: any) => String(c.id)), ...(todos ?? []).map((t: any) => String(t.assigneeChatId))]));
    } catch { /* fail-open: the createdAt rule still applies */ }
    const verdict = assessGoalDoneSuspect(goal, directives, { now, projectName, laneIds });
    const originSkipped = directives.filter((d) => directiveNamesGoal(d.text, goal.title) && isOriginatingDirective(goal, d, { laneIds })).length;
    if (originSkipped > 0) {
      try {
        recordLoopMetric({ kind: 'goal_done_suspect_origin_skip', sessionId: meta.actingChatId, meta: { goalId: goal.id.slice(0, 8), seam, skipped: originSkipped, suspect: verdict.reasons.length > 0 } });
      } catch { /* telemetry never blocks */ }
    }
    if (!verdict.reasons.length) return verdict;
    const detail = {
      goalId: goal.id.slice(0, 8), projectId: String(goal.projectId ?? '').slice(0, 8), seam,
      reasons: verdict.reasons,
      // Finding 1: only boardReasons badge; `unobserved` (a target with no measured value) is telemetry.
      boardReasons: verdict.boardReasons,
      unmet: verdict.unmetPremises.slice(0, 4).map((u) => ({ key: u.key, value: u.value, observed: u.observed, bound: u.bound })),
      unobserved: verdict.unobservedPremises.slice(0, 4).map((u) => u.key),
      holdToken: verdict.holdToken, directiveIds: verdict.directiveIds.slice(0, 4),
      force: !!meta.force, actingChatId: meta.actingChatId ?? null,
    };
    await audit(goal.userId, 'goal.done_suspect', { ...detail, goalId: goal.id, actingRunId: meta.actingRunId });
    try {
      recordLoopMetric({ kind: LOOP_METRIC_KINDS.GOAL_DONE_SUSPECT, sessionId: meta.actingChatId, meta: detail });
    } catch { /* telemetry never blocks */ }
    return verdict;
  } catch (err: any) {
    logger.warn(`goal done-suspect assessment failed (${goal.id.slice(0, 8)}): ${err?.message ?? err}`);
    return null;
  }
}

// ── Status-transition telemetry (architecture review #6 part 4, 2026-10-20) ───
//
// The goal/todo ledger had no transition stream: "how long do goals sit
// active with nothing open", "who closes todos — lanes or the harness" and
// "how often does the cascade close a goal" were unanswerable without walking
// the Activity audit. ONE loop_metrics row per status write in this module —
// goal_transition / todo_transition {from (null on create), to, actorKind,
// projectId, goalId, todoId?, ageH} — actorKind 'user' (REST / a user-anchored
// turn), 'machine' (a tool call no user turn anchors) or 'harness' (the
// dependency propagation / auto-complete / auto-reopen cascades). Kill switch
// GOAL_TRANSITION_METRICS_DISABLED=1 (read per call). Never throws.

export const goalTransitionMetricsDisabled = (): boolean => process.env.GOAL_TRANSITION_METRICS_DISABLED === '1';

/** actorKind from the callers' existing discriminator (machineTriggered: no real user turn anchors the write). */
export const actorKindOf = (machineTriggered: boolean | undefined): GoalActorKind => (machineTriggered === true ? 'machine' : 'user');

/** Row age in hours (1 decimal), null when the row carries no readable createdAt. Pure. */
export function rowAgeHours(createdAt: unknown, now: number = Date.now()): number | null {
  const ms = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt ?? ''));
  return Number.isFinite(ms) ? Math.round(Math.max(0, now - ms) / 360_000) / 10 : null;
}

function recordStatusTransition(
  entity: 'goal' | 'todo',
  row: { id: string; projectId?: string | null; goalId?: string | null; createdAt?: unknown },
  from: string | null | undefined,
  to: string | null | undefined,
  actorKind: GoalActorKind,
  sessionId?: string | null,
): void {
  try {
    if (goalTransitionMetricsDisabled() || !to || from === to) return;
    recordLoopMetric({
      kind: entity === 'goal' ? LOOP_METRIC_KINDS.GOAL_TRANSITION : LOOP_METRIC_KINDS.TODO_TRANSITION,
      ...(sessionId ? { sessionId } : {}),
      meta: {
        from: from ?? null, to, actorKind,
        projectId: row.projectId ?? null,
        goalId: entity === 'goal' ? row.id : (row.goalId ?? null),
        ...(entity === 'todo' ? { todoId: row.id } : {}),
        ageH: rowAgeHours(row.createdAt),
      },
    });
  } catch { /* telemetry never blocks a ledger write */ }
}

// ── GOAL-OUTCOME-UNMET part 3 (architecture review #3, 2026-10-20) ───────────
//
// At BOTH close seams (goal_update status:'done' and the todo-driven
// auto-complete cascade): when the goal's own outcome bar is unmet
// (kpi_bar_unmet / premise_target_unmet — goal-outcome.ts goalOutcomeOf), the
// close record is written (part 2 reads it) and the PROJECT SUPERVISOR gets
// ONE '[GOAL OUTCOME UNMET — RE-PLAN]' direct wake (Redis NX 24 h keyed by goal
// + KPI value + receipt id). Skipped — and labelled on the metric row — when
// the OWNER closed it explicitly (meta.ownerAccepted — a JWT REST write, or a
// human turn whose own message names the close; never a model's own call on a
// user-anchored run, review fix 2026-10-20), when the closer IS the supervisor
// (its tool result carries the doneSuspect + outcome notes), when the project
// has no live / enabled supervisor, or without Redis (no dedupe ⇒ no wake, the
// noteUnbackedOwnerWaitClaim posture; a thrown SET is labelled 'redis_error',
// never 'deduped'). One goal_outcome_unmet row + a goal.outcome_unmet audit
// row per assessment. Never throws.

/** Sentinel for a Redis SET that threw (labelled 'redis_error', never 'deduped'). */
const REDIS_SET_FAILED = Symbol('redis-set-failed');

async function handleGoalOutcomeUnmet(
  goal: { id: string; userId: string; projectId: string; title?: string | null; premises?: unknown },
  seam: 'update' | 'auto',
  outcome: GoalOutcome,
  meta: { actorKind: GoalActorKind; ownerAccepted?: boolean; actingChatId?: string; actingRunId?: string; enforced?: boolean; todos?: Array<{ status?: string | null }> },
): Promise<string | null> {
  if (goalOutcomeCheckDisabled() || !outcome.reasons.length) return null;
  let result = 'unknown';
  let supervisorChatId: string | null = null;
  try {
    const now = new Date();
    const ownerClose = seam === 'update' && meta.ownerAccepted === true;
    await recordGoalOutcomeClose(goal.id, {
      fingerprint: goalOutcomeFingerprint(goal.premises), reasons: outcome.reasons, seam, actorKind: meta.actorKind,
      at: now.toISOString(), ownerAccepted: ownerClose, ...(meta.enforced ? { enforced: true } : {}),
    });
    if (ownerClose) {
      result = 'owner_close';
    } else {
      const sup = await prisma.crossModelChat.findFirst({
        where: { userId: goal.userId, projectId: goal.projectId, isProjectSupervisor: true, archivedAt: null },
        select: { id: true },
      }).catch(() => null);
      supervisorChatId = sup?.id ? String(sup.id) : null;
      const project = supervisorChatId
        ? await prisma.crossModelProject.findUnique({ where: { id: goal.projectId }, select: { projectSupervisorEnabled: true, archivedAt: true } as any }).catch(() => null)
        : null;
      let switchOn = true;
      if (supervisorChatId) {
        try {
          const { getProjectSupervisorsEnabled } = await import('./supervisor-switch');
          switchOn = await getProjectSupervisorsEnabled();
        } catch { switchOn = true; }
      }
      if (!supervisorChatId) result = 'no_supervisor';
      else if ((project as any)?.projectSupervisorEnabled === false || (project as any)?.archivedAt || !switchOn) result = 'supervisor_off';
      else if (meta.actingChatId && meta.actingChatId === supervisorChatId) result = 'self';
      else {
        const redis = (await import('../../../config/redis').catch(() => null))?.default ?? null;
        const key = goalOutcomeWakeDedupeKey(goal.id, outcome);
        const claimed = redis ? await redis.set(key, now.toISOString(), { NX: true, EX: GOAL_OUTCOME_WAKE_DEDUPE_SEC }).catch(() => REDIS_SET_FAILED) : null;
        if (!redis) result = 'no_redis';
        else if (claimed === REDIS_SET_FAILED) result = 'redis_error'; // an outage, not a dedupe — the wake was lost
        else if (claimed !== 'OK') result = 'deduped';
        else {
          const todos = meta.todos ?? (await prisma.projectTodo.findMany({ where: { goalId: goal.id }, select: { status: true } }).catch(() => []));
          const { enqueueDirectWake } = await import('./hooks.service');
          const res = await enqueueDirectWake({
            targetChatId: supervisorChatId,
            prompt: renderGoalOutcomeUnmetWake({ goalId: goal.id, title: goal.title, todos, outcome, enforced: meta.enforced === true, now }),
            meta: { goalId: goal.id, projectId: goal.projectId, trigger: 'goal_outcome_unmet', seam, reasons: outcome.reasons },
          });
          if (res?.ok) result = 'woken';
          else {
            result = 'enqueue_failed';
            await redis.del(key).catch(() => {}); // nothing enqueued — the window must not be spent
          }
        }
      }
    }
    const detail = {
      goalId: goal.id.slice(0, 8), projectId: String(goal.projectId ?? '').slice(0, 8), seam,
      reason: outcome.reasons[0], reasons: outcome.reasons, outcome: result, enforced: meta.enforced === true, actorKind: meta.actorKind, ownerAccepted: ownerClose,
      kpiKey: outcome.kpi?.key ?? null, kpiValue: outcome.kpi?.value ?? null, bar: outcome.kpi?.bar ?? null,
      supervisorChatId: supervisorChatId ? supervisorChatId.slice(0, 8) : null,
    };
    try {
      recordLoopMetric({ kind: LOOP_METRIC_KINDS.GOAL_OUTCOME_UNMET, sessionId: supervisorChatId ?? meta.actingChatId, meta: detail });
    } catch { /* telemetry never blocks */ }
    await audit(goal.userId, 'goal.outcome_unmet', { ...detail, goalId: goal.id, actingChatId: meta.actingChatId, actingRunId: meta.actingRunId });
    return result;
  } catch (err: any) {
    logger.warn(`goal outcome-unmet handling failed (${goal.id.slice(0, 8)}): ${err?.message ?? err}`);
    return null;
  }
}

/** A reopen this long after the close still labels the close (mirrors the board's suspect window). */
export const GOAL_REOPEN_LABEL_WINDOW_MS = 7 * 24 * 3600_000;

/**
 * Goals-lifecycle deferred piece (2026-09-28): the `actual` label for a
 * 'done' close — was the goal REOPENED (done → active/blocked) later? ONE
 * observe-only loop_metrics row of the SAME kind as the suspect close
 * (`goal_done_suspect`, `meta.phase:'outcome'`, `actual:'reopened'`,
 * `sinceCloseMs`, `withinWindow`) at both reopen seams: goal_update leaving
 * 'done' (seam 'update') and the todo-driven auto-reopen (seam 'auto'). The
 * close time is the row's updatedAt as read before the reopen (the last write
 * — the close itself unless something touched the row since). Joined to the
 * suspect row by goalId it is the calibration signal a decision-gate purpose
 * would learn from; the NEGATIVE label (a close that stayed closed 7 d) is a
 * cron's job and is not written here. Never throws, never reverts anything.
 */
async function recordGoalReopenLabel(
  goal: { id: string; projectId: string; updatedAt?: Date | string | null },
  seam: 'update' | 'auto',
  meta: { actingChatId?: string } = {},
): Promise<void> {
  try {
    const closedAt = goal.updatedAt ? new Date(goal.updatedAt).getTime() : NaN;
    const sinceCloseMs = Number.isFinite(closedAt) ? Math.max(0, Date.now() - closedAt) : null;
    const withinWindow = sinceCloseMs === null ? null : sinceCloseMs <= GOAL_REOPEN_LABEL_WINDOW_MS;
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.GOAL_DONE_SUSPECT,
      sessionId: meta.actingChatId,
      meta: {
        phase: 'outcome', actual: 'reopened', seam,
        goalId: goal.id.slice(0, 8), projectId: String(goal.projectId ?? '').slice(0, 8),
        sinceCloseMs, withinWindow, actingChatId: meta.actingChatId ?? null,
      },
    });
  } catch { /* telemetry never blocks */ }
}

/** audit 2026-10-08 W5-5: TODO_SELF_ASSIGN_WAKE_SKIP_DISABLED=1 — the acting chat is woken for its own assignment again. */
function todoSelfWakeSkipDisabled(): boolean {
  return /^(1|true|on|yes)$/i.test(String(process.env.TODO_SELF_ASSIGN_WAKE_SKIP_DISABLED ?? '').trim());
}

/** One loop_metrics row per skipped self-wake (the decision the W5-5 fix makes). */
function recordSelfWakeSkip(todoId: string, chatId: string, transition: 'assigned' | 'unblocked'): void {
  try {
    recordLoopMetric({ kind: 'todo_wake_self_skipped', sessionId: chatId, meta: { todoId, transition } });
  } catch { /* telemetry never blocks */ }
}

/**
 * Emit a fleet hook event — DYNAMIC import of hooks.service (a static edge
 * into it could cycle back through its own imports) and never throws: a hook
 * hiccup must never fail the goal/todo write that triggered it.
 *
 * `extra.actorChatId` (hardening 2026-09-14): the chat that PERFORMED the
 * write when it differs from the source — hooks.service skips a hook whose
 * target is the actor (actor-echo suppression) so a supervisor is not woken by
 * its own todo close. Forwarded as a 4th argument ONLY when set: the REST /
 * user-present path (no acting chat) stays byte-identical.
 */
async function emitHook(
  sourceChatId: string | null | undefined,
  eventType: 'goal_blocked' | 'todo_done',
  summary: string,
  extra?: { actorChatId?: string },
): Promise<void> {
  if (!sourceChatId) return; // emission needs a source chat
  try {
    const { emitHookEventSafe } = await import('./hooks.service');
    if (extra?.actorChatId) await emitHookEventSafe(sourceChatId, eventType, summary, { actorChatId: extra.actorChatId });
    else await emitHookEventSafe(sourceChatId, eventType, summary);
  } catch (err: any) {
    logger.warn(`goals: hook emission failed (${eventType}): ${err?.message}`);
  }
}

// ── Resume propagation (2026-08-30 fleet audit) ──────────────────────────────
// Root cause of "dispatched but nobody is working": todo assignment and
// unblock used to write INERT rows — the assignee chat never learned work was
// ready for it, so a cleared blocker (owner restores an SSH key, a dep todo
// completes) left the lane idle until its next unrelated firing. Now a todo
// becoming ACTIONABLE for an assignee (assigned while unblocked, manually
// unblocked, or dep-auto-unblocked) WAKES that chat through the same
// fireScheduleTarget machine-run path hook deliveries use.
//
// Bounds (mirrors the hook layer's doctrine):
//   - DEBOUNCE: one wake per assignee chat per 5 min (Redis NX, cross-instance)
//     — a supervisor batch-planning 6 todos onto one chat produces ONE wake;
//     the woken run re-lists its full assignment set anyway. Redis hiccup
//     fails OPEN (the busy-gate/queue makes a duplicate wake harmless).
//   - DAILY CAP: the wake consumes the assignee's shared machine-run budget
//     (dailyCapExceeded), refunded when no run starts — same as hook wakes.
//   - NEVER THROWS: a wake failure must not fail the goal/todo write.

const TODO_WAKE_DEBOUNCE_SEC = 300;
const todoWakeDebounceKey = (chatId: string) => `fleet:todowake:${chatId}`;

async function wakeTodoAssignee(
  /** ownerHoldBy (OWNER-PROVENANCE-STRICT 2026-10-20): WHO answered the gate with the hold —
   *  the 'owner_hold' header names that actor; absent = the owner (the pre-fix header). */
  todo: { id: string; title: string; goalId: string; assigneeChatId?: string | null; ownerHoldNote?: string | null; ownerHoldBy?: 'owner' | 'supervisor' | 'default' },
  trigger: 'assigned' | 'unblocked' | 'owner_asked_back' | 'owner_hold',
  userId: string,
): Promise<void> {
  const chatId = todo.assigneeChatId;
  if (!chatId) return;
  const redis = (await import('../../../config/redis').catch(() => null))?.default;
  let debounceClaimed = false;
  // v1#7: the debounce key is still taken FIRST (cross-instance NX), but it is
  // RELEASED whenever the wake did not actually enqueue — before, a failed/
  // dropped wake ate the whole 5-min window and every follow-up unblock in it.
  const releaseDebounce = async (): Promise<void> => {
    if (debounceClaimed && redis) await redis.del(todoWakeDebounceKey(chatId)).catch(() => {});
  };
  try {
    if (redis) {
      const claimed = await redis.set(todoWakeDebounceKey(chatId), '1', { NX: true, EX: TODO_WAKE_DEBOUNCE_SEC }).catch(() => null);
      if (claimed !== 'OK') return; // a wake already went out in this window
      debounceClaimed = true;
    }
    const goal = await prisma.projectGoal.findUnique({ where: { id: todo.goalId }, select: { title: true } }).catch(() => null);
    // Feedback 7d7268fb (2026-09-11): a durable wake can deliver LATE (busy-
    // park) and even a fresh one races state changes between delivery and the
    // woken run's first tool call — the 2026-09-11 phantom urged "START now"
    // on a todo re-blocked (owner gate) 35 min before delivery. The header
    // names the enqueue-time trigger; deliverHookGroup revalidates at
    // delivery and suppresses stale rows, but the run starts AFTER delivery —
    // so the prompt itself must make the board the source of truth: re-read
    // with todo_get and act only on CURRENT state; never execute a blocked /
    // owner-gated todo off a wake.
    // CanLaw stall 2026-09-15: the owner replied to this todo's gate WITH A
    // QUESTION — the row stays blocked as the team's own gate; the lane must
    // answer first and decide, never "START now" off a non-decision.
    const prompt = trigger === 'owner_asked_back'
      ? `[Fleet goal board — the owner replied to this todo's gate WITH A QUESTION, not a decision]\n` +
        `Todo: "${todo.title}"\nGoal: "${goal?.title ?? todo.goalId}"\n` +
        `(Transition: owner-gated → blocked as the team's own gate (blockKind 'agent', the closed card unlinked); wake sent ${new Date().toISOString()}.)\n\n` +
        'Re-read this todo with todo_get FIRST — its blockedReason quotes the owner\'s question. Then, in order: ' +
        '(1) answer the owner\'s question plainly and with evidence, in the chat that filed the card; ' +
        '(2) if the work never needed the owner (anything under the standing full-autonomy directives), unblock it with todo_update and proceed; ' +
        '(3) only if it is genuinely human-worthy (irreversible/destructive, credentials, external sends, a real strategy fork), re-file the exact ' +
        'question with flag_owner_question — carrying your answer — and pair the block with the new oq_ id (blockKind \'owner\'). ' +
        'Never record the owner\'s question as a decision either way, and never describe this block to the owner as their halt.'
      : trigger === 'owner_hold' && (todo.ownerHoldBy === 'supervisor' || todo.ownerHoldBy === 'default')
        // OWNER-PROVENANCE-STRICT (2026-10-20): a HOLD a SUPERVISOR (standing
        // directives) or a PRESET DEFAULT answered is a revisable ruling — the
        // row is the team's own gate (blockKind 'agent'), and the header never
        // says "the OWNER just HELD" for words the owner never wrote.
        ? `[Fleet goal board — ${todo.ownerHoldBy === 'supervisor' ? 'the FLEET SUPERVISOR just HELD this todo under the owner\'s standing directives' : 'this todo\'s gate resolved to a HOLD by its PRESET DEFAULT (no owner answer)'}: a hold, not a go-ahead — and not the owner's own words]\n` +
          `Todo: "${todo.title}"\nGoal: "${goal?.title ?? todo.goalId}"\n` +
          `The ${todo.ownerHoldBy === 'supervisor' ? 'supervisor\'s' : 'preset default'} answer: "${String(todo.ownerHoldNote ?? '').slice(0, 160)}"\n` +
          `(Transition: owner-gated → still blocked as a revisable ${todo.ownerHoldBy === 'supervisor' ? 'supervisor' : 'preset-default'} hold (blockKind 'agent', the closed card unlinked); wake sent ${new Date().toISOString()}.)\n\n` +
          'Read this todo with todo_get FIRST. Do NOT execute, schedule or dispatch the gated work off this wake. ' +
          'This hold is revisable: if the current facts say it is wrong, tell the supervisor why (send_chat_message), or re-file the exact question to the owner with flag_owner_question and pair the block with the new oq_ id (blockKind \'owner\'). ' +
          'Never describe this hold to the owner as their own decision. Work that never needed the owner keeps moving as normal; if the gated work becomes MOOT, close or drop the todo citing the hold.'
      : trigger === 'owner_hold'
        // Ticket fadc3563 (2026-10-04): the owner answered the gate with a HOLD
        // or negative ("Not yet — hold the store wave") — a decision, the opposite
        // one. The todo stays blocked as the OWNER's hold: never a go-ahead, never
        // the team's own rule (a lane must not lift it without newer owner words).
        ? `[Fleet goal board — the OWNER just HELD this todo: their answer to its gate was a hold, not a go-ahead]\n` +
          `Todo: "${todo.title}"\nGoal: "${goal?.title ?? todo.goalId}"\n` +
          `The owner's answer: "${String(todo.ownerHoldNote ?? '').slice(0, 160)}"\n` +
          `(Transition: owner-gated → still blocked as the owner's explicit hold (blockKind 'owner', the closed card unlinked, the reason quoting their words); wake sent ${new Date().toISOString()}.)\n\n` +
          'The owner\'s own words are in this todo\'s blockedReason/progressNote — read them with todo_get FIRST. This is a HOLD on the gated work, not a refusal to decide and not the team\'s own rule: ' +
          'do NOT execute, schedule or dispatch the gated work, and do NOT unblock this todo yourself. Work that never needed the owner (anything under the standing full-autonomy directives) keeps moving as normal. ' +
          'The hold lifts only on the owner\'s newer words — when they lift it in the chat or a new flagged question is answered affirmatively, pair the release with that evidence. ' +
          'If the gated work becomes MOOT under the hold, close or drop the todo citing the owner\'s hold words instead of leaving it blocked forever.'
        : `[Fleet goal board — a todo was just ${trigger === 'unblocked' ? 'UNBLOCKED' : 'ASSIGNED'} to this chat]\n` +
        `Todo: "${todo.title}"\nGoal: "${goal?.title ?? todo.goalId}"\n` +
        // Ticket 85856e4f: name the transition + stamp the send-time so a
        // late-delivered lane can judge staleness against the todo's own
        // updatedAt (the 16:27Z phantom wake was a 94-min-old enqueue).
        `(Transition: ${trigger === 'unblocked' ? 'blocked → actionable' : 'assigned while actionable'}; wake sent ${new Date().toISOString()}.)\n\n` +
        'Re-read this todo with todo_get FIRST and act only on its CURRENT state: if it still reads ' +
        'actionable (pending/in_progress, assigned to this chat, not blocked), START it now — execution, ' +
        'not a status audit. If it now reads blocked/done/dropped or assigned elsewhere, this wake raced ' +
        'a later state change — do NOT start it (a blocked todo stays blocked; never execute owner-gated ' +
        'work off a stale wake). If a real blocker remains, set the todo back to blocked with an ' +
        'up-to-date blockedReason naming exactly what you need; do not sit idle on an actionable todo.';

    // DURABLE lane (v1#7): route through the hook outbox as an alarm-class
    // direct wake — a busy assignee PARKS the wake (drains post-finalize), a
    // spent daily cap does not silence it, delivery survives process death,
    // and the 24h horizon dead-letters it visibly instead of silently. The
    // old fire-and-forget lane simply DROPPED the wake on busy ("the chat's
    // own cadence will pick it up" — a deaf lane has no cadence).
    const { enqueueDirectWake } = await import('./hooks.service');
    const res = await enqueueDirectWake({
      targetChatId: chatId,
      prompt,
      meta: { todoId: todo.id, goalId: todo.goalId, trigger },
    });
    if (!res.ok) {
      await releaseDebounce(); // nothing enqueued — the window must not be spent
      logger.warn(`goals: durable todo wake enqueue failed for ${chatId.slice(0, 8)} (${res.error ?? 'unknown'})`);
      return;
    }
    await audit(userId, 'todo.wake_sent', { todoId: todo.id, assigneeChatId: chatId, trigger, durable: true, hookEventId: res.hookEventId });
  } catch (err: any) {
    await releaseDebounce();
    logger.warn(`goals: todo wake failed (${trigger}, chat ${chatId.slice(0, 8)}): ${err?.message}`);
  }
}

// ── Lane-authored gates that claim to be the owner's (CanLaw stall 2026-09-15) ─
//
// The incident: the CanLaw coordinator lane pre-set its own "Sept-1 band table"
// and auto-halted training; every card it filed asserted HALT as in force and
// asked "which path?"; the owner's four replies were questions back ("didn't we
// change the benchmark a ton?", "shouldn't you start that now?"); the lane wrote
// "owner's HALT-band decision MADE" into the todo, the new project supervisor
// copied it into its ledger as an open owner directive, and for a day it told
// the owner "it's your gate — one word from you lifts it" while the owner asked
// why nothing was training. The framework SAW the phantom claim 95 times
// (owner_wait_line_dropped: a block citing an owner decision with no open owner
// question) and only ever hid the line from the owner's surfaces. Now the claim
// is told to the lane that made it — once per row per 24h, durable wake, to the
// assignee/creator lane and the project's supervisor — and the surfaces render
// it truthfully ("paused by the team's own rule") instead of dropping it.

/** The note a coerced phantom-deps block carries back to the caller (todo/goal_update result). */
export function phantomDepsBlockNote(entity: 'goal' | 'todo'): string {
  const depTool = entity === 'goal' ? 'dependsOnGoalIds' : 'dependsOnTodoIds';
  return (
    `blockKind 'deps' was recorded as 'agent': no open dependency EDGE is recorded on this ${entity}. ` +
    `If another ${entity} really gates it, add the edge with ${depTool} (or use blockKind 'external' for a wait outside the board); ` +
    `if a real owner decision is needed, flag it with flag_owner_question and pair the block with its oq_ id (blockKind 'owner'); ` +
    `otherwise the block is the team's own rule and is yours to lift.`
  );
}

const OWNER_CLAIM_WAKE_TTL_SEC = 24 * 60 * 60;
const ownerClaimWakeKey = (entity: string, id: string) => `fleet:ownerclaim:${entity}:${id}`;
/** The project supervisor hears about phantom owner claims at most once an hour. */
export const OWNER_CLAIM_SUPERVISOR_TTL_SEC = 60 * 60;
const ownerClaimSupervisorKey = (chatId: string) => `fleet:ownerclaim:sup:${chatId}`;

/** The corrective wake text — one place, pinned by tests. */
export function buildUnbackedOwnerClaimPrompt(input: {
  entity: 'goal' | 'todo'; id: string; title: string; blockedReason: string | null; surface: string; now?: Date;
}): string {
  const Entity = input.entity === 'goal' ? 'Goal' : 'Todo';
  const reason = String(input.blockedReason ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return (
    `[Fleet goal board — this ${input.entity} claims an OWNER decision that does not exist]\n` +
    `${Entity} "${input.title}" (${input.id.slice(0, 8)}) is blocked with the reason: "${reason}".\n` +
    `That reason cites an owner decision, halt or rule, but NO OPEN owner question backs it — a cited card, if any, is closed without a decision ` +
    `(an owner reply that asked a question back is not a ruling; a dismissed card is not a decision). Read the owner's actual words with ` +
    `list_owner_questions before acting. Under the owner's standing directives — full autonomy, budgets pre-approved, "clear gates always on my behalf" — ` +
    `a rule a lane set itself (a band table, a default threshold, a pre-registered rule), or a lane's reading of an owner counter-question, is a ` +
    `LANE-authored gate: it is yours to lift, and it is never described to the owner as "your halt" or "your rule". An owner answer that says stop is ` +
    `honoured by dropping or closing the work with the oq_ id as evidence — never by leaving it blocked on the closed card.\n` +
    `Re-read the ${input.entity} with ${input.entity}_get and act on its CURRENT state: EITHER unblock it (status pending/in_progress, blockedReason cleared) ` +
    `and proceed, OR — only if the decision is genuinely human-worthy (irreversible/destructive, credentials, external sends, a real strategy fork that ` +
    `changes the GOAL) — re-file the exact question with flag_owner_question and pair the block with its oq_ id (blockKind 'owner'). ` +
    `A block that stays 'deps'/'agent'/'external' with an owner-decision reason is a contradiction this board keeps flagging.\n` +
    `(wake sent ${(input.now ?? new Date()).toISOString()}; surface ${input.surface})`
  );
}

/**
 * Tell the lane(s) behind a blocked goal/todo that its owner-decision claim
 * has no owner question behind it. Deduped per row per 24h in Redis (NX/EX;
 * without Redis the wake is skipped — the hourly surfaces would otherwise
 * re-wake every pass). Targets: the row's lane (todo assignee / goal creator)
 * and the project's supervisor chat when the project has one. Durable delivery
 * through the hook outbox (enqueueDirectWake — busy lanes park it, caps do not
 * silence it). NEVER throws; a surface calling this must never fail on it.
 */
export async function noteUnbackedOwnerWaitClaim(input: {
  userId: string;
  entity: 'goal' | 'todo';
  id: string;
  title: string;
  blockedReason: string | null;
  /** The todo's assignee or the goal's creator chat — the lane that wrote the claim. */
  laneChatId?: string | null;
  projectId?: string | null;
  /** Which surface saw the claim ('project_digest' | 'attention_watchdog' | …). */
  surface: string;
}): Promise<{ woken: string[] }> {
  const out = { woken: [] as string[] };
  const id = String(input.id ?? '').trim();
  if (!id) return out;
  const rowKey = ownerClaimWakeKey(input.entity, id);
  let redis: any = null;
  let rowKeyClaimed = false;
  const releaseRowKey = async (): Promise<void> => {
    if (rowKeyClaimed && redis) await redis.del(rowKey).catch(() => {});
    rowKeyClaimed = false;
  };
  try {
    redis = (await import('../../../config/redis').catch(() => null))?.default ?? null;
    if (!redis) return out;
    const claimed = await redis.set(rowKey, '1', { NX: true, EX: OWNER_CLAIM_WAKE_TTL_SEC }).catch((err: any) => {
      logger.warn(`goals: unbacked owner-claim dedupe key failed (${input.entity} ${id.slice(0, 8)}): ${err?.message ?? err}`);
      return 'ERR';
    });
    if (claimed !== 'OK') return out; // told within the last 24h (or Redis unreachable — try again next pass)
    rowKeyClaimed = true;
    const targets = new Set<string>();
    if (input.laneChatId) targets.add(String(input.laneChatId));
    if (input.projectId) {
      // The project supervisor's leg is COALESCED per supervisor per hour: a
      // project with many phantom rows tells its supervisor once, not once per
      // row (each of these is an alarm-class wake that bypasses caps).
      const sup = await prisma.crossModelChat.findFirst({
        where: { userId: input.userId, projectId: String(input.projectId), isProjectSupervisor: true, archivedAt: null },
        select: { id: true },
      }).catch(() => null);
      if (sup?.id && !targets.has(sup.id)) {
        const supClaimed = await redis.set(ownerClaimSupervisorKey(sup.id), '1', { NX: true, EX: OWNER_CLAIM_SUPERVISOR_TTL_SEC }).catch(() => null);
        if (supClaimed === 'OK') targets.add(sup.id);
      }
    }
    if (!targets.size) {
      await releaseRowKey(); // nobody to tell — a later target must not be shadowed for 24h
      return out;
    }
    const prompt = buildUnbackedOwnerClaimPrompt(input);
    const { enqueueDirectWake } = await import('./hooks.service');
    for (const chatId of targets) {
      const res = await enqueueDirectWake({
        targetChatId: chatId,
        prompt,
        meta: { [`${input.entity}Id`]: id, trigger: 'owner_claim_unbacked', surface: input.surface },
      });
      if (res.ok) out.woken.push(chatId);
    }
    if (!out.woken.length) {
      await releaseRowKey();
      return out;
    }
    await audit(input.userId, `${input.entity}.owner_claim_wake`, { id, targets: out.woken, surface: input.surface });
  } catch (err: any) {
    // A transient failure must not suppress the wake for 24h.
    if (!out.woken.length) await releaseRowKey();
    logger.warn(`goals: unbacked owner-claim wake failed (${input.entity} ${id.slice(0, 8)}): ${err?.message ?? err}`);
  }
  return out;
}

// ── Project access (mirrors platform.service.getProjectAccess) ───────────────

type ProjectRole = 'owner' | 'viewer' | 'editor' | 'admin';

const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
/** rank (1-4) → role (index 0 unused). */
const RANK_ROLE: ProjectRole[] = ['viewer', 'viewer', 'editor', 'admin', 'owner'];

interface ProjectAccess {
  project: any;
  role: ProjectRole;
}

/**
 * Copy of platform.service's getProjectAccess: owner → 'owner'; member → their
 * role; P2 ancestor inheritance (owner of any ancestor → 'owner', nearest
 * ancestor member row raises the rank); otherwise null (treated as 404 so
 * existence isn't leaked).
 *
 * Exported (ticket 973d7f80) so owner-questions.ts can reuse the EXACT access
 * semantics (direct owner/member + ancestor inheritance) for its shared-project
 * second-chance resolution — via a DYNAMIC import, keeping the module graph
 * acyclic.
 */
export async function getProjectAccess(projectId: string, userId: string): Promise<ProjectAccess | null> {
  const project = await prisma.crossModelProject.findUnique({
    where: { id: projectId },
    include: { members: true },
  });
  if (!project) return null;
  if (project.userId === userId) return { project, role: 'owner' };
  const member = (project.members as Array<{ userId: string; role: string }>).find((m) => m.userId === userId);
  let rank = member ? (ROLE_RANK[member.role as ProjectRole] ?? 0) : 0;
  if (foldersInheritanceOn()) {
    const chain = await getAncestorChain(projectId);
    const ancestors = chain.slice(0, -1); // root…parent (leaf = project itself)
    if (ancestors.some((f) => f.userId === userId)) return { project, role: 'owner' };
    if (ancestors.length) {
      const rows = await prisma.projectMember.findMany({
        where: { userId, projectId: { in: ancestors.map((f) => f.id) } },
        select: { role: true },
      });
      for (const r of rows) rank = Math.max(rank, ROLE_RANK[r.role as ProjectRole] ?? 0);
    }
  }
  if (!rank) return null;
  return { project, role: RANK_ROLE[rank] };
}

/** READ = owner OR any project member (viewer included). Missing/non-member → 404. */
async function requireProjectRead(projectId: string, userId: string): Promise<ProjectAccess> {
  const access = await getProjectAccess(projectId, userId);
  if (!access) throw new AppError(404, 'Project not found');
  return access;
}

/** WRITE = owner/editor/admin. Viewers → 403; missing/non-member → 404. */
async function requireProjectWrite(projectId: string, userId: string): Promise<ProjectAccess> {
  const access = await requireProjectRead(projectId, userId);
  if (access.role === 'viewer') throw new AppError(403, 'Viewers cannot modify goals or todos in this project');
  return access;
}

// ── Fetch + dependency validation helpers ────────────────────────────────────

/**
 * Prefix-suggestion (feedback 5373796a): fleet actors reconstruct full UUIDs
 * from the 8-char idiom and invent the suffix — a bare 'X not found' then
 * reads like data loss when a same-prefix record EXISTS (the 2026-08-30
 * supervisor "by-id endpoints broken / stale replica" false alarm: every
 * real id resolved instantly, only the recalled ids 404'd). On the error
 * path only, offer visible same-prefix records so the caller self-corrects
 * in one call. Same access gate as the cross-hint: non-members get the bare
 * legacy message (no existence leak).
 */
async function goalPrefixHint(id: string, userId: string): Promise<string | null> {
  if (id.length < 8) return null;
  const candidates = await prisma.projectGoal.findMany({
    where: { id: { startsWith: id.slice(0, 8) } },
    select: { id: true, title: true, projectId: true },
    take: 3,
  });
  const visible: string[] = [];
  for (const c of candidates) {
    if (await getProjectAccess(c.projectId, userId)) visible.push(`${c.id} ("${c.title}")`);
  }
  return visible.length ? visible.join(', ') : null;
}

async function todoPrefixHint(id: string, userId: string): Promise<string | null> {
  if (id.length < 8) return null;
  const candidates = await prisma.projectTodo.findMany({
    where: { id: { startsWith: id.slice(0, 8) } },
    select: { id: true, title: true, projectId: true },
    take: 3,
  });
  const visible: string[] = [];
  for (const c of candidates) {
    if (await getProjectAccess(c.projectId, userId)) visible.push(`${c.id} ("${c.title}")`);
  }
  return visible.length ? visible.join(', ') : null;
}

/**
 * Full-shape (36-char) goal/todo id resolution on the MISS path — two tiers.
 *
 * Tier 1 — TYPO (tickets 14c64064 + 263859eb, 2026-09-25): a lane re-typed a
 * real goal id with a SINGLE wrong hex character (0c08e0e2-7c25-… for
 * 0c08e0e2-0c25-…), the framework's own "Did you mean" named the exact
 * correct id, and the model re-passed the same wrong id TWICE MORE. The owner
 * already drew this exact line for chat ids (chat-id-near-match, 2026-09-18):
 * a full 36-char shape that misses exactly resolves to the ONE caller-visible
 * candidate sharing the 8-char time prefix within hamming distance ≤2.
 *
 * Tier 2 — INVENTED SUFFIX (tickets 99ad288e + 636b622b, 2026-09-28): two 3×
 * todo_update breaker streaks the same morning (sessions cbce1e78 and
 * 615723ba). Each lane held the fleet-standard 8-char ref — the [BOARD]
 * digest renders todos as `todo e6574531 [done] "…"` (board-digest id8) —
 * expanded it back to 36 chars by HALLUCINATING the suffix (hamming distance
 * 21–23, no typo), and the 36-char length cap on resolveUnique*Prefix refused
 * prefix resolution while the hint machinery already named the unique row;
 * the model re-passed the same fabricated id twice more and tripped the
 * breaker. The 2026-08-30 "invented suffix must never silently resolve"
 * doctrine drew its line when boards rendered FULL ids — a same-prefix row
 * was no evidence of intent. Since 8579d419 the 8-char prefix IS the fleet's
 * addressing idiom (boards render 8 chars; every read path and (31db672f)
 * every write path resolves it), so a full-shape id carrying a unique
 * caller-visible row's 8-char prefix is that row addressed in the long form
 * with a corrupted tail — resolve it. Guards: EXACTLY ONE caller-visible
 * candidate (ambiguity keeps the hint error, never a guess); the SAME
 * getProjectAccess gate as every other resolver (nothing new disclosed, a
 * cross-account heal is impossible by construction); a real id never enters
 * the candidate scan (the exact findUnique short-circuits — hot-path pin).
 */
async function nearMatchFullShapeId(
  kind: 'goal' | 'todo',
  id: string,
  userId: string,
): Promise<string | null> {
  if (!isFullChatIdShape(id)) return null;
  // Hot path (firing-24 pin): an exact full id canonicalizes to ITSELF with
  // zero prefix scans — the near-match runs only on the MISS path (a typo),
  // exactly like chat-id-near-match resolves only after exact resolution
  // fails. The duplicate PK lookup is cheap and the caller does one anyway.
  const exact =
    kind === 'goal'
      ? await prisma.projectGoal.findUnique({ where: { id: id.trim().toLowerCase() } })
      : await prisma.projectTodo.findUnique({ where: { id: id.trim().toLowerCase() } });
  if (exact) return null; // the id is real — callers' own exact lookup handles it
  const typed = id.trim().toLowerCase();
  const prefix = typed.slice(0, NEAR_MATCH_PREFIX_CHARS);
  const candidates =
    kind === 'goal'
      ? await prisma.projectGoal.findMany({
          where: { id: { startsWith: prefix } },
          select: { id: true, projectId: true },
          take: 3,
        })
      : await prisma.projectTodo.findMany({
          where: { id: { startsWith: prefix } },
          select: { id: true, projectId: true },
          take: 3,
        });
  const visible: { id: string }[] = [];
  for (const c of candidates) {
    if (await getProjectAccess(c.projectId, userId)) visible.push({ id: c.id });
  }
  const match = nearMatchChatId(visible, typed, NEAR_MATCH_MAX_DISTANCE);
  if (match) {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.GOAL_TODO_NEAR_MATCH_RESOLVED,
      meta: { entity: kind, typed: prefix, resolved: match.id.slice(0, 8) },
    });
    return match.id;
  }
  // Tier 2 (99ad288e + 636b622b): the suffix was invented, but the 8-char
  // prefix is the fleet's addressing idiom and names EXACTLY ONE visible row
  // — the hint machinery's own candidate set. Resolve to it; ambiguity or
  // invisibility falls through to the hint error unchanged.
  if (visible.length === 1) {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.GOAL_TODO_SUFFIX_HEALED,
      meta: { entity: kind, typed: prefix, resolved: visible[0].id.slice(0, 8), userId },
    });
    return visible[0].id;
  }
  return null;
}

/**
 * Unique-prefix resolution (ticket 8579d419): every other id-taking fleet tool
 * (schedule_get, get_feedback, hook_update, cancel_schedule, …) accepts a
 * unique ≥8-char prefix and fleet doctrine teaches the 8-char idiom
 * everywhere — goal/todo were the lone exact-id outliers, and lanes burned
 * breaker-streak failures on them (todo_get "eaad801c" 404'd while the hint
 * machinery already knew the unique match). Resolve ONLY when the input is
 * 8–35 chars here: a full-length (36-char) miss is the domain of
 * nearMatchFullShapeId (typo tier + invented-suffix heal, tickets 263859eb /
 * 99ad288e + 636b622b) — the two resolvers partition by length. Exactly ONE
 * caller-visible candidate resolves — same access gate as the hint, so
 * nothing new is disclosed; ambiguity falls through to the hint error.
 */
async function resolveUniqueGoalPrefix(id: string, userId: string): Promise<any | null> {
  if (id.length < 8 || id.length >= 36) return null;
  const candidates = await prisma.projectGoal.findMany({
    where: { id: { startsWith: id } },
    select: { id: true, projectId: true },
    take: 3,
  });
  const visible: string[] = [];
  for (const c of candidates) {
    if (await getProjectAccess(c.projectId, userId)) visible.push(c.id);
  }
  if (visible.length !== 1) return null;
  return prisma.projectGoal.findUnique({ where: { id: visible[0] } });
}

async function resolveUniqueTodoPrefix(id: string, userId: string): Promise<any | null> {
  if (id.length < 8 || id.length >= 36) return null;
  const candidates = await prisma.projectTodo.findMany({
    where: { id: { startsWith: id } },
    select: { id: true, projectId: true },
    take: 3,
  });
  const visible: string[] = [];
  for (const c of candidates) {
    if (await getProjectAccess(c.projectId, userId)) visible.push(c.id);
  }
  if (visible.length !== 1) return null;
  return prisma.projectTodo.findUnique({ where: { id: visible[0] } });
}

/**
 * Unique-TITLE resolution on READ paths (operator iteration 12, 2026-09-25):
 * lanes call todo_get / goal_get with the row's TITLE copied from a board
 * digest or a peer's message ("Mobile M1 — push: Expo Push + …", "Phase 1 —
 * researched plan doc: …") — 6 todo_get failures in 48 h, each a real row the
 * caller could name but not id. An exact, case-insensitive, trimmed title
 * match that is UNIQUE among the caller's visible rows resolves; ambiguity or
 * invisibility falls through to the exact-id 404 unchanged (no new
 * disclosure — the same getProjectAccess gate as the prefix resolvers). Read
 * paths ONLY, like the prefix rule (write/list callers keep exact ids).
 */
const UUID_SHAPE_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}[0-9a-f]{0,12}$/i;
async function resolveUniqueGoalTitle(raw: string, userId: string): Promise<any | null> {
  const title = String(raw ?? '').trim();
  if (title.length < 4 || UUID_SHAPE_RE.test(title)) return null;
  const candidates = await prisma.projectGoal.findMany({
    where: { title: { equals: title, mode: 'insensitive' } },
    select: { id: true, projectId: true },
    take: 3,
  });
  const visible: string[] = [];
  for (const c of candidates) {
    if (await getProjectAccess(c.projectId, userId)) visible.push(c.id);
  }
  if (visible.length !== 1) return null;
  return prisma.projectGoal.findUnique({ where: { id: visible[0] } });
}
async function resolveUniqueTodoTitle(raw: string, userId: string): Promise<any | null> {
  const title = String(raw ?? '').trim();
  if (title.length < 4 || UUID_SHAPE_RE.test(title)) return null;
  const candidates = await prisma.projectTodo.findMany({
    where: { title: { equals: title, mode: 'insensitive' } },
    select: { id: true, projectId: true },
    take: 3,
  });
  const visible: string[] = [];
  for (const c of candidates) {
    if (await getProjectAccess(c.projectId, userId)) visible.push(c.id);
  }
  if (visible.length !== 1) return null;
  return prisma.projectTodo.findUnique({ where: { id: visible[0] } });
}

/**
 * Write-path canonical-id resolution (ticket 31db672f): goal_update/todo_update
 * were the fleet's last exact-id-only id-taking mutation tools — every read
 * tool (ticket 8579d419) and every schedule/hook/feedback tool resolves a
 * unique ≥8-char prefix, fleet doctrine teaches the 8-char idiom everywhere,
 * and a lane burned a 3× breaker streak on todo_update 404s whose own 'Did
 * you mean' hint already named the unique match. Resolve the input id to its
 * canonical full form BEFORE the row fetch so EVERY downstream use (dep
 * self-checks, cycle walks, prisma updates, audits, loop metrics, hook
 * payloads) carries the full id — resolving inside getGoalRow/getTodoRow
 * instead is the B1 trap (adversarial review of PR #656): write callers must
 * never fetch by a resolved id while mutating by the raw input. Same guards
 * as the read path (8–35 chars, exactly one caller-visible candidate, same
 * access gate as the hint — nothing new is disclosed); anything else returns
 * the input unchanged so the exact-lookup error paths (cross-hint /
 * Did-you-mean / self-describing 404) handle it verbatim. A full-length id
 * short-circuits with zero extra queries.
 */
async function canonicalGoalId(id: string, userId: string): Promise<string> {
  const row = await resolveUniqueGoalPrefix(id, userId);
  if (row) return row.id;
  // Full-shape near-miss (263859eb) + invented-suffix heal (99ad288e +
  // 636b622b): a 36-char id with 1–2 wrong characters, or an invented suffix
  // on a unique visible 8-char prefix, resolves to the unique visible
  // candidate instead of 404ing through a "Did you mean" the model ignores.
  const near = await nearMatchFullShapeId('goal', id, userId);
  return near ?? (await healGoalTodoRef('goal', id, userId)) ?? id;
}

/**
 * audit 2026-10-08 W3-3: the shared heal tier (platform/id-ref.ts) for goal /
 * todo ids — a ≥8-char SUFFIX ("…ec52d820"), a prefix+suffix splice, an
 * over-long id. Visibility is the SAME getProjectAccess gate as every other
 * resolver here, so nothing new is disclosed. A real id never reaches it (the
 * callers' exact lookups run first). Null when unresolved / ambiguous (the
 * hint error then speaks). ID_RESOLVER_HEAL_DISABLED=1.
 */
async function healGoalTodoRef(kind: 'goal' | 'todo', id: string, userId: string): Promise<string | null> {
  const visibleIds = async (rows: Array<{ id: string; projectId: string }>, take: number): Promise<string[]> => {
    const out: string[] = [];
    for (const r of rows) {
      if (out.length >= take) break;
      if (await getProjectAccess(r.projectId, userId)) out.push(r.id);
    }
    return out;
  };
  const find = (where: any, take: number) => (kind === 'goal'
    ? prisma.projectGoal.findMany({ where, select: { id: true, projectId: true }, take: take * 3 })
    : prisma.projectTodo.findMany({ where, select: { id: true, projectId: true }, take: take * 3 })) as Promise<Array<{ id: string; projectId: string }>>;
  try {
    // Hot path (firing-24 pin): a REAL id never pays a candidate scan — the callers' exact lookup owns it.
    const typed = String(id ?? '').trim();
    const exact = kind === 'goal'
      ? await prisma.projectGoal.findUnique({ where: { id: typed } })
      : await prisma.projectTodo.findUnique({ where: { id: typed } });
    if (exact) return null;
    const r = await healIdRef(id, {
      byPrefix: async (prefix, take) => visibleIds((await find({ id: { startsWith: prefix } }, take)) ?? [], take),
      bySuffix: async (suffix, take) => visibleIds((await find({ id: { endsWith: suffix } }, take)) ?? [], take),
    }, kind);
    return r.ok ? r.id : null;
  } catch {
    return null;
  }
}

/**
 * Tool-boundary canonicalization (FO firing 24): platform-tools' todo_create
 * case needs the SAME unique-prefix resolution before its 03587322 cross-
 * project guard probe (an exact findUnique on a raw prefix would return null
 * and silently SKIP the scoping refusal). Exported so the tool seam and the
 * service share ONE resolver — never a second prefix-matching implementation.
 */
export async function canonicalGoalIdForTool(id: string, userId: string): Promise<string> {
  return canonicalGoalId(id, userId);
}

async function canonicalTodoId(id: string, userId: string): Promise<string> {
  const row = await resolveUniqueTodoPrefix(id, userId);
  if (row) return row.id;
  const near = await nearMatchFullShapeId('todo', id, userId);
  return near ?? (await healGoalTodoRef('todo', id, userId)) ?? id;
}

/**
 * Tool-boundary canonicalization for todo ids (the todo twin of
 * canonicalGoalIdForTool above): todo_update / todo_get / todo_get's
 * dependency checks canonicalize through ONE resolver. Exported so the tool
 * seam and the service share it — never a second implementation.
 */
export async function canonicalTodoIdForTool(id: string, userId: string): Promise<string> {
  return canonicalTodoId(id, userId);
}

/**
 * Unique-prefix resolution for PROJECT ids on the scoped fleet list reads
 * (ticket fb3ea311): the Fleet Supervisor burned a 3× todo_list breaker streak
 * on 'Project not found' after scoping by the fleet-standard 8-char project
 * idiom ('0560b7b8' — the exact shape its own board digests display) while the
 * full id succeeded. goalId/todoId/schedule/hook/feedback ids all resolve that
 * idiom (8579d419, 31db672f, and this file's own goalId branch since
 * 225b878f4); the projectId branch was the lone exact-id outlier left. Same
 * guards as the goal/todo resolvers: resolve ONLY at 8–35 chars (a full-length
 * miss keeps the exact-id 404 — an invented suffix must never silently
 * resolve, the 2026-08-30 false-alarm doctrine), exactly ONE caller-visible
 * candidate resolves, and visibility uses the SAME getProjectAccess gate as
 * the hint machinery, so nothing new is disclosed; ambiguity or invisibility
 * falls through to the exact-id 404 unchanged.
 */
async function resolveUniqueProjectPrefix(id: string, userId: string): Promise<any | null> {
  if (id.length < 8 || id.length >= 36) return null;
  const candidates = await prisma.crossModelProject.findMany({
    where: { id: { startsWith: id } },
    select: { id: true },
    take: 3,
  });
  const visible: string[] = [];
  for (const c of candidates) {
    if (await getProjectAccess(c.id, userId)) visible.push(c.id);
  }
  if (visible.length !== 1) return null;
  return { id: visible[0] };
}

/**
 * audit 2026-10-06 T5-3 (fleet F7): the Fleet Supervisor burned 6 'Project not
 * found' calls in 52 h on goal_list / todo_list with the RIGHT 8-char project
 * prefix and a hallucinated suffix (f4f34898-c614-… for f4f34898-afb7-…) — the
 * goal/todo resolvers heal exactly that (nearMatchFullShapeId tiers 1 + 2), the
 * project resolver only took exact 8–35-char prefixes and its 404 named no
 * candidate. Now a full-shape (36-char) project id that misses resolves to the
 * ONE caller-visible project sharing its 8-char prefix (a ≤2-char typo first,
 * else the invented-suffix heal), and a scoped-list miss answers with a
 * "Did you mean" naming the visible same-prefix projects. Same getProjectAccess
 * gate as every other resolver (nothing new is disclosed). Kill switch
 * PROJECT_ID_SUFFIX_HEAL_DISABLED=1 restores the exact-prefix-only resolver and
 * the bare 404.
 */
export function projectIdHealDisabled(): boolean {
  return process.env.PROJECT_ID_SUFFIX_HEAL_DISABLED === '1';
}

async function nearMatchFullShapeProjectId(id: string, userId: string): Promise<{ id: string; tier: 'typo' | 'suffix' } | null> {
  if (projectIdHealDisabled() || !isFullChatIdShape(id)) return null;
  const typed = id.trim().toLowerCase();
  const exact = await prisma.crossModelProject.findUnique({ where: { id: typed }, select: { id: true } });
  if (exact) return null; // a real id — the caller's own exact read handles it
  const candidates = await prisma.crossModelProject.findMany({
    where: { id: { startsWith: typed.slice(0, NEAR_MATCH_PREFIX_CHARS) } },
    select: { id: true },
    take: 3,
  });
  const visible: { id: string }[] = [];
  for (const c of candidates) {
    if (await getProjectAccess(c.id, userId)) visible.push({ id: c.id });
  }
  const typo = nearMatchChatId(visible, typed, NEAR_MATCH_MAX_DISTANCE);
  const hit = typo ? { id: typo.id, tier: 'typo' as const } : visible.length === 1 ? { id: visible[0].id, tier: 'suffix' as const } : null;
  if (hit) {
    recordLoopMetric({
      kind: hit.tier === 'typo' ? LOOP_METRIC_KINDS.GOAL_TODO_NEAR_MATCH_RESOLVED : LOOP_METRIC_KINDS.GOAL_TODO_SUFFIX_HEALED,
      meta: { entity: 'project', typed: typed.slice(0, NEAR_MATCH_PREFIX_CHARS), resolved: hit.id.slice(0, 8), userId },
    });
  }
  return hit;
}

async function canonicalProjectId(id: string, userId: string): Promise<string> {
  const row = await resolveUniqueProjectPrefix(id, userId);
  if (row) return row.id;
  // Fail-open: a heal-probe hiccup keeps the exact-id 404 path.
  const near = await nearMatchFullShapeProjectId(id, userId).catch(() => null);
  return near ? near.id : id;
}

/**
 * Tool-boundary twin of canonicalProjectId (audit 2026-10-06 T5-3): the tool
 * seam needs to KNOW a heal happened so the result can carry a correction
 * note (the model keeps the corrected id instead of re-carrying the invented
 * one into its notes). `correctedFrom` is set only for a full-shape heal — a
 * plain prefix is the fleet idiom, not a correction. Fail-open: returns the
 * raw id on any error.
 */
export async function resolveProjectIdForTool(id: string, userId: string): Promise<{ id: string; correctedFrom?: string; tier?: 'typo' | 'suffix' }> {
  try {
    const row = await resolveUniqueProjectPrefix(id, userId);
    if (row) return { id: row.id };
    const near = await nearMatchFullShapeProjectId(id, userId);
    return near ? { id: near.id, correctedFrom: id, tier: near.tier } : { id };
  } catch {
    return { id };
  }
}

/** Visible same-8-char-prefix projects for the scoped-list 404 (audit 2026-10-06 T5-3). */
async function projectPrefixHint(id: string, userId: string): Promise<string | null> {
  const raw = String(id ?? '').trim().toLowerCase();
  if (raw.length < 8) return null;
  const candidates = await prisma.crossModelProject.findMany({
    where: { id: { startsWith: raw.slice(0, 8) } },
    select: { id: true, name: true },
    take: 3,
  });
  const visible: string[] = [];
  for (const c of candidates) {
    if (await getProjectAccess(c.id, userId)) visible.push(`${c.id} ("${c.name}")`);
  }
  return visible.length ? visible.join(', ') : null;
}

/** requireProjectRead for a SCOPED list whose id came from the caller: a 404 names the visible same-prefix projects. */
async function requireScopedProjectRead(scopeId: string, rawId: string, userId: string): Promise<ProjectAccess> {
  try {
    return await requireProjectRead(scopeId, userId);
  } catch (err: any) {
    if (projectIdHealDisabled() || err?.statusCode !== 404) throw err;
    const hint = await projectPrefixHint(rawId, userId).catch(() => null);
    if (!hint) throw err;
    throw new AppError(404, `Project not found: "${rawId}". Did you mean: ${hint}? Re-call with the EXACT id copied verbatim from list_projects (never reconstruct or abbreviate an id)`);
  }
}

async function getGoalRow(goalId: string, userId: string, resolvePrefix = false): Promise<any> {
  const goal = await prisma.projectGoal.findUnique({ where: { id: goalId } });
  if (goal) return goal;
  // Cross-hint (feedback fecf85c5): fleet actors routinely hold a bare id with
  // no idea whether it names a goal or a todo — a bare 'Goal not found' on a
  // TODO id reads like data loss and was reported as unverifiable work. One
  // extra lookup, on the error path only. The hint is gated on READ access to
  // the todo's project: non-members get the bare legacy message (no existence
  // or linkage leak — same contract as the two-stage 404).
  const asTodo = await prisma.projectTodo.findUnique({ where: { id: goalId }, select: { id: true, goalId: true, projectId: true } });
  if (asTodo && (await getProjectAccess(asTodo.projectId, userId))) {
    throw new AppError(404,
      `Goal not found: "${goalId}" is a TODO id (parent goal "${asTodo.goalId}") — use todo_get / todo_update / todo_list for it, not the goal tools`);
  }
  // Unique-prefix resolve (ticket 8579d419) — READ PATHS ONLY (review B1):
  // write/list callers keep using their RAW input id downstream (updates, dep
  // deleteMany/createMany, recompute, list filters), so a resolved prefix
  // there would silently mis-write or return empty lists — only getGoal /
  // getTodo pass resolvePrefix:true (they switch to the resolved row's id).
  if (resolvePrefix) {
    const byPrefix = await resolveUniqueGoalPrefix(goalId, userId);
    if (byPrefix) return byPrefix;
    // Full-shape tiers (263859eb typo + 99ad288e/636b622b invented-suffix
    // heal): the SAME ladder as the write paths' canonicalGoalId — a read
    // probe is usually the FIRST call of a streak, so read and write must
    // resolve a garbled full id identically or the streak just moves.
    const byFullShape = await nearMatchFullShapeId('goal', goalId, userId);
    if (byFullShape) return prisma.projectGoal.findUnique({ where: { id: byFullShape } });
    const byTitle = await resolveUniqueGoalTitle(goalId, userId); // iteration 12: unique exact title
    if (byTitle) return byTitle;
    const byRef = await healGoalTodoRef('goal', goalId, userId); // audit 2026-10-08 W3-3: suffix / splice
    if (byRef) return prisma.projectGoal.findUnique({ where: { id: byRef } });
  }
  const goalHint = await goalPrefixHint(goalId, userId);
  throw new AppError(404, goalHint
    ? `Goal not found: "${goalId}". Did you mean: ${goalHint}? Re-call with the EXACT id copied verbatim from goal_list (never reconstruct or abbreviate an id)`
    // Self-describing no-hint branch (ticket 7ae1f4c4): the bare legacy text
    // dropped the received id, so a run probing several nonexistent ids (e.g.
    // adjudicating another lane's fabricated id claims) produced byte-identical
    // failure texts and the auto-filed breaker ticket could not show WHICH ids
    // were probed. Echoing the caller's own input id leaks nothing; the message
    // still carries no existence/classification/linkage hint for non-members.
    : `Goal not found: "${goalId}" — no goal with that id is visible to you. Re-call with the EXACT id copied verbatim from goal_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh goal_list first`);
}

async function getTodoRow(todoId: string, userId: string, resolvePrefix = false): Promise<any> {
  const todo = await prisma.projectTodo.findUnique({ where: { id: todoId } });
  if (todo) return todo;
  // Cross-hint (feedback fecf85c5) — mirror of getGoalRow, same access gate.
  const asGoal = await prisma.projectGoal.findUnique({ where: { id: todoId }, select: { id: true, projectId: true } });
  if (asGoal && (await getProjectAccess(asGoal.projectId, userId))) {
    throw new AppError(404,
      `Todo not found: "${todoId}" is a GOAL id — use goal_get / goal_update / goal_list for it, not the todo tools`);
  }
  // Unique-prefix resolve (ticket 8579d419) — READ PATHS ONLY (review B1):
  // see getGoalRow for why write/list callers must keep exact-id semantics.
  if (resolvePrefix) {
    const byPrefix = await resolveUniqueTodoPrefix(todoId, userId);
    if (byPrefix) return byPrefix;
    // Full-shape tiers (263859eb typo + 99ad288e/636b622b invented-suffix
    // heal) — mirror of getGoalRow: the read ladder must match canonicalTodoId
    // or a streak just moves from todo_update to todo_get.
    const byFullShape = await nearMatchFullShapeId('todo', todoId, userId);
    if (byFullShape) return prisma.projectTodo.findUnique({ where: { id: byFullShape } });
    const byTitle = await resolveUniqueTodoTitle(todoId, userId); // iteration 12: unique exact title
    if (byTitle) return byTitle;
    const byRef = await healGoalTodoRef('todo', todoId, userId); // audit 2026-10-08 W3-3: suffix / splice
    if (byRef) return prisma.projectTodo.findUnique({ where: { id: byRef } });
  }
  const todoHint = await todoPrefixHint(todoId, userId);
  throw new AppError(404, todoHint
    ? `Todo not found: "${todoId}". Did you mean: ${todoHint}? Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id)`
    // Self-describing no-hint branch (ticket 7ae1f4c4) — mirror of getGoalRow;
    // see the comment there for why the received id is echoed (diagnosable
    // breaker tickets) and why this leaks nothing for non-members.
    : `Todo not found: "${todoId}" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first`);
}

/** Dedupe a dep id list and reject self-reference. */
function normalizeDepIds(ids: string[] | undefined, selfId: string | null, label: 'goal' | 'todo'): string[] {
  const out: string[] = [];
  for (const raw of ids ?? []) {
    const id = String(raw ?? '');
    if (!id) continue;
    if (selfId && id === selfId) throw new AppError(400, `A ${label} cannot depend on itself`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Load dep goals, enforcing the fleet boundary: every target must EXIST and
 * belong to the SAME OWNER (cross-PROJECT deps are fine — a user's goals span
 * projects; cross-USER is never allowed).
 */
async function loadSameOwnerDepGoals(depIds: string[], userId: string): Promise<any[]> {
  if (!depIds.length) return [];
  const rows = await prisma.projectGoal.findMany({ where: { id: { in: depIds } } });
  const found = new Set(rows.map((r: any) => r.id));
  const missing = depIds.filter((id) => !found.has(id));
  if (missing.length) throw new AppError(404, `Dependency goal not found: ${missing.join(', ')}`);
  if (rows.some((r: any) => r.userId !== userId)) {
    throw new AppError(403, 'Dependency goals must belong to the same owner');
  }
  return rows;
}

/** Same-owner dep todo loading (todo analogue of loadSameOwnerDepGoals). */
async function loadSameOwnerDepTodos(depIds: string[], userId: string): Promise<any[]> {
  if (!depIds.length) return [];
  const rows = await prisma.projectTodo.findMany({ where: { id: { in: depIds } } });
  const found = new Set(rows.map((r: any) => r.id));
  const missing = depIds.filter((id) => !found.has(id));
  if (missing.length) throw new AppError(404, `Dependency todo not found: ${missing.join(', ')}`);
  if (rows.some((r: any) => r.userId !== userId)) {
    throw new AppError(403, 'Dependency todos must belong to the same owner');
  }
  return rows;
}

/**
 * Canonicalize a dependency id list BEFORE the dep loaders validate it
 * (ticket 8f62542c): lanes pass the fleet's 8-char prefix idiom in
 * dependsOnTodoIds / dependsOnGoalIds (every OTHER id-taking fleet tool
 * accepts it), but the loaders do raw-exact `in` lookups — a valid prefix of
 * a REAL row 404'd as "Dependency todo not found: <prefix>" (3× breaker
 * streak, session cbce1e78). Each id flows through the SAME resolver as every
 * other id-taking site (canonicalGoalId / canonicalTodoId: unique
 * caller-visible prefix, same getProjectAccess gate as the hint machinery —
 * nothing new is disclosed, a full-length id short-circuits with zero extra
 * queries). An id that resolves to NOTHING is returned UNCHANGED so the
 * loader's 404 still echoes the RAW input — same error class, message and
 * status as before. After resolution the list is re-deduped (two prefixes of
 * one full id collapse to a single edge) and the self-reference check re-runs:
 * a prefix that resolves to the row ITSELF must keep the 400
 * self-dependency class, not surface later as a cycle 409.
 */
async function canonicalizeDepIds(
  ids: string[],
  selfId: string | null,
  label: 'goal' | 'todo',
  userId: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const raw of ids) {
    const full =
      label === 'goal' ? await canonicalGoalId(raw, userId) : await canonicalTodoId(raw, userId);
    if (selfId && full === selfId) throw new AppError(400, `A ${label} cannot depend on itself`);
    if (!out.includes(full)) out.push(full);
  }
  return out;
}

/**
 * Would adding edges `fromId` → each of `depIds` create a dependency cycle?
 * DFS from `fromId` over same-direction edges (X → what X depends on),
 * including the proposed ones: a cycle exists iff `fromId` is reachable from
 * itself. The graph is kept acyclic by this check, so a NEW cycle must use a
 * proposed edge. (At CREATE time fromId is a fresh id with no dependents, so
 * the check is trivially false — still run for uniformity.)
 */
export async function wouldCreateGoalCycle(fromId: string, depIds: string[], userId: string): Promise<boolean> {
  if (!depIds.length) return false;
  const rows = await prisma.goalDependency.findMany({ where: { goal: { userId } } });
  return reachesItself(fromId, depIds, rows.map((r: any) => [r.goalId, r.dependsOnGoalId] as [string, string]));
}

/** Todo analogue of wouldCreateGoalCycle. */
export async function wouldCreateTodoCycle(fromId: string, depIds: string[], userId: string): Promise<boolean> {
  if (!depIds.length) return false;
  const rows = await prisma.todoDependency.findMany({ where: { todo: { userId } } });
  return reachesItself(fromId, depIds, rows.map((r: any) => [r.todoId, r.dependsOnTodoId] as [string, string]));
}

function reachesItself(fromId: string, proposedDepIds: string[], edges: [string, string][]): boolean {
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    const list = adj.get(a) ?? [];
    list.push(b);
    adj.set(a, list);
  };
  for (const [a, b] of edges) add(a, b);
  for (const b of proposedDepIds) add(fromId, b);

  const visited = new Set<string>();
  const stack = [...(adj.get(fromId) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === fromId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
  }
  return false;
}

const openGoalDeps = (depGoals: any[]): any[] => depGoals.filter((g) => !GOAL_DONE_ISH.has(g.status));
const openTodoDeps = (depTodos: any[]): any[] => depTodos.filter((t) => !TODO_DONE_ISH.has(t.status));

// ── Blocked propagation (the core) ───────────────────────────────────────────

/**
 * Recompute one goal's OWN blocked state from its current deps (called after
 * its dependency list changes). Dep-blocked rows auto-restore to 'active';
 * manually blocked / done / archived rows are left alone.
 */
async function recomputeGoalBlockedState(goalId: string, userId: string): Promise<void> {
  const goal = await prisma.projectGoal.findUnique({ where: { id: goalId } });
  if (!goal || goal.status === 'done' || goal.status === 'archived') return;
  const depRows = await prisma.goalDependency.findMany({ where: { goalId } });
  const deps = depRows.length
    ? await prisma.projectGoal.findMany({ where: { id: { in: depRows.map((d: any) => d.dependsOnGoalId) } } })
    : [];
  const open = openGoalDeps(deps);
  if (open.length > 0) {
    if (goal.status !== 'blocked') {
      const priorStatus = String(goal.status);
      await prisma.projectGoal.update({
        where: { id: goalId },
        // blockedAt (review fix 2026-09-27): the block START — the reason
        // refresh below deliberately leaves it alone.
        data: { status: 'blocked', blockedReason: depsReason(open.length, 'goal'), blockedAt: new Date() },
      });
      await audit(userId, 'goal.auto_block', { goalId, openDeps: open.map((g: any) => g.id) });
      recordStatusTransition('goal', goal, priorStatus, 'blocked', 'harness');
      await emitHook(goal.createdByChatId, 'goal_blocked', `Goal blocked: ${goal.title} (waiting on ${open.length} goals)`);
    } else if (isDepBlocked(goal.blockedReason)) {
      await prisma.projectGoal.update({ where: { id: goalId }, data: { blockedReason: depsReason(open.length, 'goal') } });
    }
  } else if (goal.status === 'blocked' && isDepBlocked(goal.blockedReason)) {
    await prisma.projectGoal.update({ where: { id: goalId }, data: { status: 'active', blockedReason: null, blockedAt: null } });
    await audit(userId, 'goal.auto_unblock', { goalId });
    recordStatusTransition('goal', goal, 'blocked', 'active', 'harness');
  }
}

/** Todo analogue of recomputeGoalBlockedState (no hook event for todos). */
async function recomputeTodoBlockedState(todoId: string, userId: string): Promise<void> {
  const todo = await prisma.projectTodo.findUnique({ where: { id: todoId } });
  if (!todo || TODO_DONE_ISH.has(todo.status)) return; // done/dropped are terminal — never auto-(un)block
  const depRows = await prisma.todoDependency.findMany({ where: { todoId } });
  const deps = depRows.length
    ? await prisma.projectTodo.findMany({ where: { id: { in: depRows.map((d: any) => d.dependsOnTodoId) } } })
    : [];
  const open = openTodoDeps(deps);
  if (open.length > 0) {
    if (todo.status !== 'blocked') {
      const priorStatus = String(todo.status);
      await prisma.projectTodo.update({
        where: { id: todoId },
        // blockedAt (review fix 2026-09-27): the block START — the reason
        // refresh below deliberately leaves it alone.
        data: { status: 'blocked', blockedReason: depsReason(open.length, 'todo'), blockedAt: new Date() },
      });
      await audit(userId, 'todo.auto_block', { todoId, openDeps: open.map((t: any) => t.id) });
      recordStatusTransition('todo', todo, priorStatus, 'blocked', 'harness');
    } else if (isDepBlocked(todo.blockedReason)) {
      await prisma.projectTodo.update({ where: { id: todoId }, data: { blockedReason: depsReason(open.length, 'todo') } });
    }
  } else if (todo.status === 'blocked' && isDepBlocked(todo.blockedReason)) {
    await prisma.projectTodo.update({ where: { id: todoId }, data: { status: 'pending', blockedReason: null, blockedAt: null } });
    await audit(userId, 'todo.auto_unblock', { todoId });
    recordStatusTransition('todo', todo, 'blocked', 'pending', 'harness');
    // Resume propagation (2026-08-30): the unblock used to be silent (audit
    // only) — the assignee never learned its work was ready.
    await wakeTodoAssignee(todo, 'unblocked', userId);
  }
}

/** BFS over goal DEPENDENTS (reverse edges), recomputing each. Cycle-guarded. */
async function recomputeGoalDependents(rootGoalId: string, userId: string): Promise<void> {
  const visited = new Set<string>([rootGoalId]);
  const queue: string[] = [rootGoalId];
  while (queue.length) {
    const current = queue.shift()!;
    const dependents = await prisma.goalDependency.findMany({ where: { dependsOnGoalId: current } });
    for (const edge of dependents) {
      if (visited.has(edge.goalId)) continue;
      visited.add(edge.goalId);
      await recomputeGoalBlockedState(edge.goalId, userId);
      queue.push(edge.goalId);
    }
  }
}

/** BFS over todo DEPENDENTS (reverse edges), recomputing each. Cycle-guarded. */
async function recomputeTodoDependents(rootTodoId: string, userId: string): Promise<void> {
  const visited = new Set<string>([rootTodoId]);
  const queue: string[] = [rootTodoId];
  while (queue.length) {
    const current = queue.shift()!;
    const dependents = await prisma.todoDependency.findMany({ where: { dependsOnTodoId: current } });
    for (const edge of dependents) {
      if (visited.has(edge.todoId)) continue;
      visited.add(edge.todoId);
      await recomputeTodoBlockedState(edge.todoId, userId);
      queue.push(edge.todoId);
    }
  }
}

/**
 * The public propagation entry point: after any status change on a goal/todo,
 * recompute the blocked state of everything that (transitively) depends on it.
 */
export async function recomputeDependents(id: string, kind: 'goal' | 'todo', userId = 'system'): Promise<void> {
  if (kind === 'goal') await recomputeGoalDependents(id, userId);
  else await recomputeTodoDependents(id, userId);
}

/* ── Owner-gate unblock (ticket 356d21bb) ─────────────────────────────────────
 * An owner answer to a flagged ownerQuestion (oq_ id) must resolve ALL derived
 * gates: every todo/goal parked 'blocked' with gateQuestionId = that id. This
 * is the ONE choke point — owner-questions.ts calls it from every resolution
 * path (Inbox answer, cross-chat duplicate auto-resolve, in-chat card answer,
 * and the owner-gate sweeper backstop); no caller re-implements the unblock.
 *
 * Semantics (mirrors the updateGoal/updateTodo unblock idiom at the status
 * transition): todo → 'pending', goal → 'active'; blockedReason + blockKind +
 * gateQuestionId clear TOGETHER; a progressNote cites the answering decision
 * so the lane sees WHY it moved. Each flip is a CONDITIONAL updateMany (still
 * blocked on THIS question) so a concurrent re-block is never clobbered. An
 * unblocked todo's assignee is woken through wakeTodoAssignee('unblocked') —
 * the same resume-propagation wake the dep auto-unblock path uses.
 *
 * NEVER THROWS: per-item try/catch + logger.warn — a gate-unblock hiccup must
 * not fail the owner-answer path that called it.
 *
 * Ticket fadc3563 (2026-10-04): the owner's answer may itself be a HOLD or
 * negative ("Not yet — hold the store wave" — the live incident: the sweeper
 * cleared goal e1e96be5 + todo 3bf505f8 at 06:56:55Z and the store wave was
 * falsely executable for ~2 minutes). A hold IS a decision, the opposite one:
 * the row stays 'blocked' as the OWNER's hold — blockKind 'owner' (never
 * 'agent': a lane must not lift it without newer owner words), the closed
 * card unlinked (so no surface re-lists it as a stale gate), the reason
 * quoting the owner's words, the assignee woken 'owner_hold', audit
 * todo/goal.owner_gate_hold, loop_metrics 'owner_gate_hold'. Classifier:
 * owner-hold-answer.ts isHoldAnswer (hold-DETECTION, not an affirmative-
 * requirement — noun-phrase decisions like "ca-central-1" keep the classic
 * release; a reply that is entirely question-form takes the asked-back arm
 * counterQuestion wins over hold. (The kill switch was retired 2026-10-30;
 * hold classification is unconditional.)
 */
export async function unblockOwnerGatedItems(input: {
  userId: string;
  /** The answered owner_questions row id (oq_…). */
  questionId: string;
  /** The owner's answer — cited (clipped) in the progress note. */
  answer: string;
  /** The question text, when known — improves the progress note. */
  question?: string;
  /** Provenance label for audit + note (e.g. 'owner inbox answer', 'card answer', 'sweeper'). */
  source: string;
  /** Who answered — a supervisor/default hold must not read as the owner's own words (fadc3563). */
  answeredBy?: 'owner' | 'supervisor' | 'default';
  /** CanLaw stall 2026-09-15: the owner replied WITH A QUESTION — no decision.
   *  The card is closed, so the row cannot stay parked on it, but it is NOT
   *  released as "owner answered — START now" either (owner gates on
   *  human-worthy actions are one of the few gates kept after the 2026-09-11
   *  flip). The row stays blocked as the TEAM'S OWN gate — blockKind 'agent',
   *  the closed card unlinked, the reason saying the owner asked back — and
   *  the assignee is woken to answer the owner first, then decide. */
  counterQuestion?: boolean;
  /** Chats the caller already woke with this answer — never woken again here. */
  skipWakeChatIds?: string[];
}): Promise<{ todos: number; goals: number; heldTodos: number; heldGoals: number }> {
  const out = { todos: 0, goals: 0, heldTodos: 0, heldGoals: 0 };
  const questionId = String(input.questionId ?? '').trim();
  if (!questionId) return out;
  const userId = String(input.userId ?? '').trim() || 'system';
  const askedBack = input.counterQuestion === true;
  // Ticket fadc3563: hold classification (counterQuestion wins — a question-form
  // reply is the owner ASKING, not stating). A supervisor/default hold is noted
  // as such and never dressed as the owner's own words.
  const bySupervisor = input.answeredBy === 'supervisor';
  const byDefault = input.answeredBy === 'default';
  const hold = !askedBack
    && isHoldAnswer(String(input.answer ?? ''));
  // OWNER-PROVENANCE-STRICT (2026-10-20): a HOLD a supervisor or a preset
  // default answered re-blocks as the TEAM's gate (blockKind 'agent') — the
  // 'owner' kind is reserved for the owner's own words (a lane may not lift
  // it without newer owner words; a supervisor ruling is revisable). Kill
  // switch OWNER_PROVENANCE_STRICT_DISABLED=1 restores blockKind 'owner'.
  const nonOwnerHold = hold && (bySupervisor || byDefault) && !ownerProvenanceStrictDisabled();
  const holdBlockKind = nonOwnerHold ? 'agent' : 'owner';
  const skipWake = new Set((input.skipWakeChatIds ?? []).filter(Boolean));
  // Transition telemetry (2026-10-20): the owner's own answer is a 'user' move; a supervisor / preset default is 'machine'.
  const gateAnswerActor: GoalActorKind = bySupervisor || byDefault ? 'machine' : 'user';
  // The asked-back note deliberately carries none of the OWNER_WAIT_CLAIM_RE
  // shapes ("owner decision", "awaiting owner", "owner's … call"): the row is
  // the team's own gate now and must not read as an owner wait anywhere. The
  // HOLD note cites the owner's answer as their ruling — "owner HOLD" —
  // WITHOUT any OWNER_WAIT_CLAIM_RE alternative (no "awaiting/needs owner",
  // no possessive "owner's … hold", no "held per/by the owner"): the unbacked-
  // owner-claim watchdog would otherwise wake the lane to "re-file" a hold
  // that is exactly what the owner just said (the asked-back doctrine, kept).
  const note = (askedBack
    ? `Owner asked back on this gate${input.question ? ` ("${String(input.question).slice(0, 80)}")` : ''}: ` +
      `"${String(input.answer ?? '').slice(0, 100)}" — no decision; the gate is yours: answer the owner, then unblock and proceed ` +
      `if the work never needed the owner, or re-file the exact question with flag_owner_question if it is human-worthy (${input.source}).`
    : hold
      ? `${bySupervisor ? 'HOLD (supervisor ruling)' : byDefault ? 'HOLD (preset default)' : 'HOLD'} — ` +
        `"${String(input.answer ?? '').slice(0, 80)}" — work is HELD; lifts ${byDefault ? 'if the owner overrules it' : nonOwnerHold ? 'when the supervisor revises it or the owner overrules it' : 'only on newer owner words'} (${input.source}, fadc3563).`
      : `Owner answered the gate${input.question ? ` ("${String(input.question).slice(0, 80)}")` : ''}: ` +
        `"${String(input.answer ?? '').slice(0, 100)}" — unblocked (${input.source}, ticket 356d21bb).`
  ).slice(0, progressNoteMax());
  if (hold) {
    try {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.OWNER_GATE_HOLD,
        sessionId: undefined,
        meta: { questionId: questionId.slice(0, 11), source: input.source, answeredBy: input.answeredBy ?? 'owner', answer: String(input.answer ?? '').slice(0, 120), blockKind: holdBlockKind },
      });
    } catch { /* telemetry never breaks the gate path */ }
  }
  // Todos gated on this question (batch-capped — a pathological fleet never
  // pins the answer path; the sweeper reaps any residue on its next pass).
  let gatedTodos: any[] = [];
  try {
    gatedTodos = await prisma.projectTodo.findMany({
      where: { status: 'blocked', gateQuestionId: questionId }, take: 50,
    });
  } catch (err: any) {
    logger.warn(`goals: owner-gate unblock todo scan failed (${questionId}): ${err?.message}`);
  }
  for (const todo of gatedTodos) {
    try {
      const flip = await prisma.projectTodo.updateMany({
        where: { id: todo.id, status: 'blocked', gateQuestionId: questionId },
        data: askedBack
          ? { blockKind: 'agent', gateQuestionId: null, blockedReason: note, progressNote: note }
          : hold
            // fadc3563: a HOLD keeps the row blocked as the OWNER's hold — blockKind
            // 'owner' (a lane must not lift it without newer owner words; the
            // unbacked-claim wake correctly targets only agent/deps/external kinds),
            // the closed card unlinked so no surface re-lists it as a stale gate.
            ? { blockKind: holdBlockKind, gateQuestionId: null, blockedReason: note, progressNote: note }
            : { status: 'pending', blockedReason: null, blockKind: null, gateQuestionId: null, blockedAt: null, progressNote: note },
      });
      if (!flip?.count) continue; // re-blocked/re-gated in the race — leave it
      if (hold) out.heldTodos += 1; else out.todos += 1;
      if (!askedBack && !hold) recordStatusTransition('todo', todo, 'blocked', 'pending', gateAnswerActor);
      await audit(userId, askedBack ? 'todo.owner_gate_asked_back' : hold ? 'todo.owner_gate_hold' : 'todo.owner_gate_unblock', { todoId: todo.id, questionId, source: input.source });
      if (todo.assigneeChatId && skipWake.has(String(todo.assigneeChatId))) continue; // already woken by the answer itself
      await wakeTodoAssignee(
        { id: todo.id, title: todo.title, goalId: todo.goalId, assigneeChatId: todo.assigneeChatId, ...(hold ? { ownerHoldNote: note, ...(nonOwnerHold ? { ownerHoldBy: bySupervisor ? 'supervisor' as const : 'default' as const } : {}) } : {}) },
        askedBack ? 'owner_asked_back' : hold ? 'owner_hold' : 'unblocked',
        userId,
      );
    } catch (err: any) {
      logger.warn(`goals: owner-gate todo unblock failed (${todo.id}, ${questionId}): ${err?.message}`);
    }
  }
  let gatedGoals: any[] = [];
  try {
    gatedGoals = await prisma.projectGoal.findMany({
      where: { status: 'blocked', gateQuestionId: questionId }, take: 50,
    });
  } catch (err: any) {
    logger.warn(`goals: owner-gate unblock goal scan failed (${questionId}): ${err?.message}`);
  }
  for (const goal of gatedGoals) {
    try {
      const flip = await prisma.projectGoal.updateMany({
        where: { id: goal.id, status: 'blocked', gateQuestionId: questionId },
        data: askedBack
          ? { blockKind: 'agent', gateQuestionId: null, blockedReason: note, progressNote: note }
          : hold
            // fadc3563: a HOLD keeps the goal blocked as the OWNER's hold (see the
            // todo arm above — blockKind 'owner', closed card unlinked, reason
            // quoting the owner's words). No wake: goals have no assignee (the
            // hold is visible on the goal row + the digest/state surfaces).
            ? { blockKind: holdBlockKind, gateQuestionId: null, blockedReason: note, progressNote: note }
            : { status: 'active', blockedReason: null, blockKind: null, gateQuestionId: null, blockedAt: null, progressNote: note },
      });
      if (!flip?.count) continue;
      if (hold) out.heldGoals += 1; else out.goals += 1;
      if (!askedBack && !hold) recordStatusTransition('goal', goal, 'blocked', 'active', gateAnswerActor);
      await audit(userId, askedBack ? 'goal.owner_gate_asked_back' : hold ? 'goal.owner_gate_hold' : 'goal.owner_gate_unblock', { goalId: goal.id, questionId, source: input.source });
    } catch (err: any) {
      logger.warn(`goals: owner-gate goal unblock failed (${goal.id}, ${questionId}): ${err?.message}`);
    }
  }
  return out;
}

// ── Goals ────────────────────────────────────────────────────────────────────

/**
 * Create a goal in a project (write access). The goal is owned by the
 * PROJECT OWNER (goal.userId = project.userId — the fleet the goal joins),
 * not necessarily the caller. Deps (optional) must all exist and belong to
 * that same owner; if any dep goal is not done-ish the new goal starts
 * 'blocked' with a '[deps]' reason (so it auto-unblocks later).
 */
export async function createGoal(opts: {
  userId: string;
  projectId: string;
  title: string;
  description?: string;
  createdByChatId?: string;
  dependsOnGoalIds?: string[];
  /** No real user turn anchors the create (2026-10-20 transition telemetry's actorKind only). */
  machineTriggered?: boolean;
  /** GOAL-PRIORITY-SPEND (2026-10-20): 1..4 / 'P1'..'P4' (null/absent = unset = P2). */
  priority?: unknown;
  /** GOAL-PRIORITY-SPEND: optional ISO due date. */
  dueAt?: unknown;
  /** Who is ranking: 'owner' (a JWT REST write) or 'machine' (a dgt_ token / machine run). Omitted =
   *  `rankingOwnerText` decides when given, else 'machine' when machineTriggered, else 'owner'. An 'owner'
   *  writer who is not the PROJECT owner writes as 'member' (review fix 2026-10-20). */
  rankingWriter?: GoalPrioritySource;
  /** A human tool turn's own text: the ranking is the OWNER's only when it backs this write
   *  (goal-priority.ts ownerTextBacksRanking), else a machine write. */
  rankingOwnerText?: string;
}): Promise<GoalView> {
  const { userId, projectId } = opts;
  const title = String(opts.title ?? '').trim();
  if (!title) throw new AppError(400, 'title is required');
  const { project } = await requireProjectWrite(projectId, userId);
  const ownerId = project.userId; // goals are owned by their project owner
  // GOAL-PRIORITY-SPEND: validated (400) before anything writes; a refused machine ranking still creates the goal.
  const ranking = await resolveRankingWrite({
    priority: opts.priority, dueAt: opts.dueAt, current: null,
    writer: rankingWriterOf(opts),
    ownerTurnText: opts.rankingOwnerText,
    goalRef: { title },
    actorIsProjectOwner: userId === ownerId,
    actingChatId: opts.createdByChatId,
  });

  // Ticket 8f62542c: canonicalize dep prefixes through the shared resolver
  // BEFORE the raw-exact loader lookup (unresolved ids pass through verbatim).
  const depIds = await canonicalizeDepIds(
    normalizeDepIds(opts.dependsOnGoalIds, null, 'goal'),
    null,
    'goal',
    userId,
  );
  const depGoals = await loadSameOwnerDepGoals(depIds, ownerId);
  const id = randomUUID();
  if (await wouldCreateGoalCycle(id, depIds, ownerId)) {
    throw new AppError(409, 'Dependency cycle detected: a goal cannot (transitively) depend on itself');
  }

  const open = openGoalDeps(depGoals);
  const goal = await prisma.$transaction(async (tx: any) => {
    const g = await tx.projectGoal.create({
      data: {
        id,
        userId: ownerId,
        projectId,
        title,
        description: String(opts.description ?? ''),
        ...(opts.createdByChatId ? { createdByChatId: opts.createdByChatId } : {}),
        ...(open.length ? { status: 'blocked', blockedReason: depsReason(open.length, 'goal'), blockedAt: new Date() } : {}),
        ...ranking.data,
      },
    });
    if (depIds.length) {
      await tx.goalDependency.createMany({
        data: depIds.map((dependsOnGoalId) => ({ goalId: id, dependsOnGoalId })),
      });
    }
    return g;
  });

  await audit(userId, 'goal.create', { goalId: id, projectId, title, dependsOnGoalIds: depIds, status: goal.status });
  recordStatusTransition('goal', { id, projectId, createdAt: (goal as any).createdAt ?? new Date() }, null, goal.status ?? 'active', actorKindOf(opts.machineTriggered), opts.createdByChatId);
  logger.info(`goal ${id.slice(0, 8)} created in project ${projectId.slice(0, 8)} by user ${userId.slice(0, 8)} (status ${goal.status})`);
  await recordRankingWrite(userId, { id, projectId }, ranking, { seam: 'create', actingChatId: opts.createdByChatId });
  return goalView(goal, { dependsOnGoalIds: depIds, ...(ranking.note ? { priorityNote: ranking.note } : {}) });
}

/**
 * Update a goal (write access on its project). Status rules: 'done' requires
 * all dep goals done-ish (else 409; force: true overrides + audit);
 * 'blocked' needs a blockedReason (default 'Blocked manually') and emits
 * goal_blocked; 'archived' is always allowed (and counts as done for
 * dependents). Replacing dependsOnGoalIds re-validates (same owner, no self,
 * no cycle) and recomputes THIS goal's blocked state. Any status change
 * recomputes the goal's DEPENDENTS.
 */
export async function updateGoal(opts: {
  userId: string;
  goalId: string;
  title?: string;
  description?: string;
  status?: GoalStatus;
  blockedReason?: string;
  /** Remediation P2 S2a: WHY it is blocked ('deps'|'owner'|'agent'|'external'); null clears. */
  blockKind?: string | null;
  /** The open owner-question (oq_…) gating a blockKind='owner' row; null clears. */
  gateQuestionId?: string | null;
  /** Progress-aware pulse (P7 v1#20): free-text progress note (≤2,000 chars stored since a8d6e514; displays show the first ~200); null/'' clears. */
  progressNote?: string | null;
  force?: boolean;
  dependsOnGoalIds?: string[];
  /** The chat performing this update (v1#8): goal_blocked emits FROM here so
   *  the event exists even for goals whose creator chat is gone/null, and a
   *  supervisor blocking its own goal no longer routes the event through the
   *  self-suppressed creator. Falls back to goal.createdByChatId. */
  actingChatId?: string;
  /** The agent_runs row performing this update (ticket c286ba91): stamped on
   *  the row (updatedByRunId) and ride audit metadata so a gate flip is never
   *  "unattributed" again. Unset for REST / user-present writes. */
  actingRunId?: string;
  /** True when NO real user turn anchors this update (2026-10-20; tool writes
   *  compute it with goal-outcome.ts ledgerToolMachineTriggered — origin-aware,
   *  owner-dispatch counts as machine): the transition metric's actorKind.
   *  Unset = user (REST / user-present). */
  machineTriggered?: boolean;
  /** GOAL-OUTCOME-UNMET review fix (2026-10-20): the OWNER made this write
   *  directly — a JWT REST call (never a dgt_ agent token). A 'done' close
   *  with the outcome bar unmet then ACCEPTS the outcome (no re-plan wake, the
   *  dormancy gate stops counting it); on an already-done goal only a
   *  STATUS-ONLY call accepts. Unset = not the owner. */
  ownerExplicit?: boolean;
  /** The owner's OWN message text on a genuine human turn (tool writes only:
   *  ToolContext.userTurnText, never set on a machine / owner-dispatch run).
   *  The outcome is accepted only when it names this goal's close
   *  (goal-outcome.ts ownerTextNamesGoalClose) — a model's own close on a
   *  user-anchored run never accepts it. */
  ownerTurnText?: string;
  /** GOAL-PRIORITY-SPEND (2026-10-20): 1..4 / 'P1'..'P4'; null clears (back to the P2 default). */
  priority?: unknown;
  /** GOAL-PRIORITY-SPEND: ISO due date; null clears. */
  dueAt?: unknown;
  /** Who is ranking ('owner' | 'machine') — see createGoal (`rankingOwnerText` decides when this is omitted). */
  rankingWriter?: GoalPrioritySource;
  /** A human tool turn's own text — see createGoal. */
  rankingOwnerText?: string;
}): Promise<GoalView> {
  const { userId } = opts;
  // Canonicalize up front (ticket 31db672f) — every downstream use of goalId
  // below (dep self-check, cycle walk, updates, audits) carries the full id.
  const goalId = await canonicalGoalId(opts.goalId, userId);
  const goal = await getGoalRow(goalId, userId);
  await requireProjectWrite(goal.projectId, userId);

  // Dependency replacement (validated up front so nothing writes on failure).
  // Same-owner = the GOAL's owner (the fleet), which may differ from the
  // calling project member.
  let newDepIds: string[] | undefined;
  if (opts.dependsOnGoalIds !== undefined) {
    // Ticket 8f62542c: canonicalize prefixes, then re-check self-reference
    // (a prefix of THIS goal now resolves to goalId → keep the 400 class).
    newDepIds = await canonicalizeDepIds(
      normalizeDepIds(opts.dependsOnGoalIds, goalId, 'goal'),
      goalId,
      'goal',
      userId,
    );
    await loadSameOwnerDepGoals(newDepIds, goal.userId);
    if (await wouldCreateGoalCycle(goalId, newDepIds, goal.userId)) {
      throw new AppError(409, 'Dependency cycle detected: a goal cannot (transitively) depend on itself');
    }
  }

  const data: Record<string, any> = {};
  if (opts.title !== undefined) {
    const title = String(opts.title).trim();
    if (!title) throw new AppError(400, 'title must be non-empty');
    data.title = title;
  }
  if (opts.description !== undefined) data.description = String(opts.description);
  // Progress note (P7 v1#20): apply-or-clear, capped — never a silent drop.
  // f3e56567 follow-up: cap on CODE POINTS (never a split surrogate pair) so the
  // stored row and progressNoteClipNotice's count measure the same unit.
  if (opts.progressNote !== undefined) {
    const note = clipProgressNote(opts.progressNote);
    data.progressNote = note || null;
  }
  // GOAL-PRIORITY-SPEND (2026-10-20): the ranking fields — invalid input 400s here (before any write); a machine
  // write on an OWNER-set ranking, or from a non-supervisor chat, leaves them untouched and says so.
  let ranking = await resolveRankingWrite({
    priority: opts.priority, dueAt: opts.dueAt,
    current: { priority: (goal as any).priority ?? null, prioritySource: (goal as any).prioritySource ?? null, dueAt: (goal as any).dueAt ?? null },
    writer: rankingWriterOf(opts),
    ownerTurnText: opts.rankingOwnerText,
    goalRef: { id: goal.id, title: goal.title },
    actorIsProjectOwner: userId === goal.userId,
    actingChatId: opts.actingChatId,
  });
  // Review fix (2026-10-20): the owner lock was checked against the row read ABOVE, and several awaits sit
  // between that read and the write — a concurrent owner write could land in between and be overwritten
  // (restamped 'machine'). A NON-owner ranking write is therefore CONDITIONAL (written inside the transaction
  // below only while the ranking is still not owner-set); the owner's own write stays unconditional.
  const guardedRanking = (ranking.outcome === 'set' || ranking.outcome === 'cleared') && ranking.source !== 'owner'
    ? { ...ranking.data }
    : null;
  if (!guardedRanking) Object.assign(data, ranking.data);

  let statusChanged = false;
  let manualBlock = false;
  // Captured BEFORE the write: the reopen label (below) needs the status and
  // updatedAt the row had when this call read it, not what the update left.
  const priorStatus = String(goal.status);
  const priorUpdatedAt: Date | string | null = (goal as any).updatedAt ?? null;
  if (opts.status !== undefined) {
    const status = String(opts.status) as GoalStatus;
    if (!(GOAL_STATUSES as readonly string[]).includes(status)) {
      throw new AppError(400, `status must be one of: ${GOAL_STATUSES.join(', ')}`);
    }
    if (status !== goal.status) {
      if (status === 'done') {
        // Gate on the EFFECTIVE dep set (the replacement, when one is supplied).
        const effDepIds = newDepIds
          ?? (await prisma.goalDependency.findMany({ where: { goalId } })).map((d: any) => d.dependsOnGoalId);
        const deps = effDepIds.length
          ? await prisma.projectGoal.findMany({ where: { id: { in: effDepIds } } })
          : [];
        const open = openGoalDeps(deps);
        if (open.length && !opts.force) {
          throw new AppError(
            409,
            `Goal cannot be marked done: waiting on ${open.length} goal(s) not done: ` +
            `${open.map((g: any) => `"${g.title}" (${g.status})`).join(', ')}. Pass force: true to override.`,
          );
        }
        if (open.length && opts.force) {
          await audit(userId, 'goal.force_done', { goalId, openDeps: open.map((g: any) => g.id) });
        }
      }
      if (status === 'blocked') {
        data.blockedReason = String(opts.blockedReason ?? '').trim() || 'Blocked manually';
        // blockedAt (review fix 2026-09-27): stamped ONLY on the transition
        // into 'blocked' — a standalone blockedReason refresh (below) or a
        // blockKind / gate / progressNote rewrite never touches it, so the
        // digest's 72 h stale-deps gate ages from the real block start.
        data.blockedAt = new Date();
        manualBlock = true;
      } else {
        data.blockedReason = null; // active/done/archived clear the block reason
        data.blockKind = null; // …and the typed provenance (S2a) with it
        data.gateQuestionId = null;
        data.blockedAt = null;
      }
      data.status = status;
      statusChanged = true;
    }
  }

  // blockedReason standalone: a status transition above already claimed the
  // reason (set on 'blocked', cleared otherwise). With NO transition, the
  // reason must still apply-or-reject — never silently drop an accepted
  // parameter (same silent no-op class as the todo_update fix): refresh it
  // on an already-blocked goal; 400 on a non-blocked one. No goal_blocked
  // re-fire and no statusChanged audit — this is a data refresh only.
  if (opts.blockedReason !== undefined && data.blockedReason === undefined) {
    if (goal.status === 'blocked') {
      data.blockedReason = String(opts.blockedReason).trim() || 'Blocked manually';
    } else {
      throw new AppError(
        400,
        `blockedReason can only be set on a blocked goal (current status: '${goal.status}'). Pass status:'blocked' to block it first.`,
      );
    }
  }

  // Phantom-gate guard (ticket d76750f5): a supplied gate must resolve to an
  // existing owner_questions row of the GOAL's owner — or of the ACTING account
  // (ticket be94fa64: member-lane-flagged questions in shared projects) —
  // BEFORE anything writes.
  const gateResolved = await maybeResolveGate(opts.gateQuestionId, goal.userId, userId);

  // Typed block provenance (S2a) — AFTER status handling so an explicit value
  // this call wins over the unblock auto-clear above.
  applyBlockProvenance(data, { blockKind: opts.blockKind, gateQuestionId: gateResolved });
  // Phantom deps block (CanLaw stall 2026-09-15 — see updateTodo): 'deps' with
  // zero open goal dependencies is recorded as 'agent' and told to the caller.
  let blockKindNote: string | undefined;
  let coercedDeps: number | null = null; // audit + metric land AFTER the write below
  if ((data.status ?? goal.status) === 'blocked' && data.blockKind === 'deps') {
    const effDepIds = newDepIds
      ?? (await prisma.goalDependency.findMany({ where: { goalId } })).map((d: any) => d.dependsOnGoalId);
    const deps = effDepIds.length ? await prisma.projectGoal.findMany({ where: { id: { in: effDepIds } } }) : [];
    if (openGoalDeps(deps).length === 0) {
      data.blockKind = 'agent';
      blockKindNote = phantomDepsBlockNote('goal');
      coercedDeps = effDepIds.length;
    }
  }

  // Interaction fix (2026-10-20): did this call write anything BESIDES the ranking fields (which ride
  // `guardedRanking` or are absent from `data` on a refusal)? Read before the transaction stamps authorship.
  const wroteOtherFields = Object.keys(data).length > 0;
  let rankingRaced = false;
  let updated: any = await prisma.$transaction(async (tx: any) => {
    let g = goal;
    if (Object.keys(data).length) {
      // Gate-write authorship (ticket c286ba91): stamp WHO wrote on EVERY row
      // write — callers passing neither id leave null = the user/REST/
      // framework discriminator (a machine write arrives via the tools, which
      // always pass actingChatId/actingRunId).
      data.updatedByChatId = opts.actingChatId ?? null;
      data.updatedByRunId = opts.actingRunId ?? null;
      g = await tx.projectGoal.update({ where: { id: goalId }, data });
    }
    if (guardedRanking) {
      // GOAL-PRIORITY-SPEND review fix: lands only while the ranking is not owner-set (PG re-checks the WHERE on
      // the latest row version, so an owner write committed after our read wins); count 0 ⇒ refused below.
      const stamp = { updatedByChatId: opts.actingChatId ?? null, updatedByRunId: opts.actingRunId ?? null };
      const res = await tx.projectGoal.updateMany({
        where: { id: goalId, OR: [{ prioritySource: null }, { prioritySource: { not: 'owner' } }] },
        data: { ...guardedRanking, ...stamp },
      });
      if (Number(res?.count ?? 0) > 0) g = { ...g, ...guardedRanking, ...stamp };
      else rankingRaced = true;
    }
    if (newDepIds) {
      await tx.goalDependency.deleteMany({ where: { goalId } });
      if (newDepIds.length) {
        await tx.goalDependency.createMany({
          data: newDepIds.map((dependsOnGoalId) => ({ goalId, dependsOnGoalId })),
        });
      }
    }
    return g;
  });
  if (updated === goal && (newDepIds || statusChanged)) updated = { ...goal, ...data };
  if (rankingRaced) {
    // The owner ranked this goal between our read and our write: theirs stands; say so (apply-or-explain).
    const live = await prisma.projectGoal.findUnique({ where: { id: goalId }, select: { priority: true, prioritySource: true, dueAt: true } as any }).catch(() => null) as any;
    if (live) updated = { ...updated, priority: live.priority ?? null, prioritySource: live.prioritySource ?? null, dueAt: live.dueAt ?? null };
    ranking = {
      data: {}, outcome: 'refused_owner_set', writer: ranking.writer, raced: true, from: ranking.from, to: ranking.from,
      note: priorityRefusalNote('refused_owner_set', { priority: live?.priority ?? null, prioritySource: 'owner' }, ranking.writer ?? 'machine'),
    };
  }
  if (coercedDeps !== null) {
    await audit(userId, 'goal.block_kind_coerced', { goalId, from: 'deps', to: 'agent', deps: coercedDeps });
  }

  if (newDepIds) {
    // The dep SET changed: recompute this goal's own blocked state.
    await recomputeGoalBlockedState(goalId, userId);
  }
  // sup3 audit C2 (2026-09-27): a close that lands with the goal's OWN target
  // premise unmet, a HOLD progress note, or an open owner directive naming it
  // is recorded as suspect (metric + audit + tool-result note) — never refused.
  // Assessed on the row AS WRITTEN (a progressNote supplied in the same call
  // counts; the blockedReason the transition just cleared does not).
  let doneSuspect: GoalDoneSuspectVerdict | null = null;
  const actorKind = actorKindOf(opts.machineTriggered);
  // GOAL-OUTCOME-UNMET review fix (2026-10-20): only the OWNER accepts an
  // unmet outcome — a JWT REST write (ownerExplicit) or a human turn whose own
  // message names this goal's close. A model's own goal_update on a
  // user-anchored run (an agent-origin / owner-dispatch lane run inherits the
  // owner turn's userTurnAt) is NOT the owner: it wakes the supervisor (or is
  // the supervisor's own close) and the close stays live work.
  const ownerNamedClose = opts.machineTriggered !== true && ownerTextNamesGoalClose(opts.ownerTurnText, { id: goal.id, title: goal.title });
  const ownerDirectWrite = opts.machineTriggered !== true && opts.ownerExplicit === true;
  let outcomeNote: string | null = null;
  let outcomeAccepted = false;
  if (statusChanged && data.status === 'done') {
    doneSuspect = await recordGoalDoneSuspect(
      { ...goal, ...data, blockedReason: null },
      'update',
      { force: !!opts.force, actingChatId: opts.actingChatId, actingRunId: opts.actingRunId },
    );
    // GOAL-OUTCOME-UNMET (2026-10-20): the explicit close seam. The close
    // stands (part 4's enforcement holds only the cascade — an explicit
    // goal_update still closes, audited); the record + the supervisor wake
    // (non-owner closes) / the accepted outcome (the owner's close) land here.
    const outcome = goalOutcomeOf((goal as any).premises);
    if (outcome.reasons.length) {
      if (goalOutcomeGateEnforce()) {
        await audit(userId, 'goal.outcome_gate_explicit_close', { goalId, reasons: outcome.reasons, actorKind, actingChatId: opts.actingChatId, actingRunId: opts.actingRunId });
      }
      const handled = await handleGoalOutcomeUnmet(
        { id: goal.id, userId: goal.userId, projectId: goal.projectId, title: data.title ?? goal.title, premises: (goal as any).premises },
        'update', outcome, { actorKind, ownerAccepted: ownerDirectWrite || ownerNamedClose, actingChatId: opts.actingChatId, actingRunId: opts.actingRunId },
      );
      outcomeNote = goalOutcomeCloseNote(handled, outcome);
    }
  } else if (opts.status === 'done' && !statusChanged && goal.status === 'done' && !goalOutcomeCheckDisabled()) {
    // A re-confirmation of an already-done goal accepts an unmet outcome only
    // from the OWNER: their own message naming the close, or a STATUS-ONLY JWT
    // REST write (a REST edit that merely re-sends status:'done' beside other
    // fields is not a close). No-op when the outcome is met. Anyone else's
    // re-send changes nothing — the tool result says so.
    const statusOnlyCall = [opts.title, opts.description, opts.blockedReason, opts.blockKind, opts.gateQuestionId, opts.progressNote, opts.dependsOnGoalIds, opts.priority, opts.dueAt]
      .every((v) => v === undefined);
    if (ownerNamedClose || (ownerDirectWrite && statusOnlyCall)) {
      if (await acceptGoalOutcomeClose(goal.id, (goal as any).premises)) {
        outcomeAccepted = true;
        await audit(userId, 'goal.outcome_accepted', { goalId, via: ownerNamedClose ? 'owner_message' : 'rest', actingChatId: opts.actingChatId, actingRunId: opts.actingRunId });
      }
    } else {
      const outcome = goalOutcomeOf((goal as any).premises);
      if (outcome.reasons.length && outcomeCloseStillLive(await readGoalOutcomeClose(goal.id), goalOutcomeFingerprint((goal as any).premises))) {
        outcomeNote = goalOutcomeCloseNote('reconfirm', outcome);
      }
    }
  }
  if (statusChanged) {
    recordStatusTransition('goal', goal as any, priorStatus, data.status, actorKind, opts.actingChatId);
  }
  // The reopen half of the label (2026-09-28): a goal LEAVING 'done' labels its close.
  if (statusChanged && priorStatus === 'done' && data.status !== 'done') {
    await recordGoalReopenLabel({ id: goal.id, projectId: goal.projectId, updatedAt: priorUpdatedAt }, 'update', { actingChatId: opts.actingChatId });
  }
  if (statusChanged) {
    await audit(userId, 'goal.update', {
      goalId, fromStatus: goal.status, toStatus: data.status,
      ...(manualBlock ? { blockedReason: data.blockedReason } : {}),
      // Authorship (ticket c286ba91) rides every audit row too.
      actingChatId: opts.actingChatId, actingRunId: opts.actingRunId,
    });
    if (manualBlock) {
      // v1#8: emit from the ACTING chat (the one whose tool call blocked the
      // goal) — createdByChatId is only the fallback. REST-created goals
      // (createdByChatId null) blocked from a chat run now emit; blocked from
      // bare REST (no chat anywhere) still cannot (emission needs a source).
      await emitHook(opts.actingChatId ?? goal.createdByChatId, 'goal_blocked', `Goal blocked: ${goal.title} (${data.blockedReason})`);
    }
    // Dependents care about this goal's done-ness / blocked-ness.
    await recomputeGoalDependents(goalId, userId);
  } else if (
    data.gateQuestionId !== undefined || data.blockKind !== undefined
    || data.blockedReason !== undefined || data.progressNote !== undefined
  ) {
    // Audit-gap close (ticket c286ba91): a gate/blockKind/blockedReason/
    // progressNote rewrite with NO status change used to leave ZERO audit
    // rows — the 02:28:04Z incident shape, where a gate flip on a shared
    // project's todo was "unattributed" and took three tickets to identify.
    await audit(userId, 'goal.gate_update', {
      goalId,
      gateQuestionId: data.gateQuestionId ?? undefined,
      blockKind: data.blockKind ?? undefined,
      blockedReason: data.blockedReason == null ? undefined : String(data.blockedReason).slice(0, 160),
      actingChatId: opts.actingChatId, actingRunId: opts.actingRunId,
    });
  }
  // GOAL-PRIORITY-SPEND: the ranking write's metric (+ its own audit row on a change).
  await recordRankingWrite(userId, { id: goalId, projectId: goal.projectId }, ranking, { seam: 'update', actingChatId: opts.actingChatId, actingRunId: opts.actingRunId });
  // Interaction fix (2026-10-20): a REFUSED ranking write (owner-set / not a supervisor / raced) in a call that
  // wrote nothing else changed nothing — the view says so (rankingApplied:false + changed:false), the
  // goal_update receipt is then ok:false and the harness record files it under "Not executed", never as an
  // executed supervisor action; the note says plainly that the current ranking stands.
  const rankingRefused = ranking.outcome === 'refused_owner_set' || ranking.outcome === 'refused_not_supervisor';
  const rankingOnlyNoop = rankingRefused && !wroteOtherFields && !newDepIds && !statusChanged && !outcomeAccepted;
  if (rankingOnlyNoop) {
    ranking.note = priorityRefusalNote(ranking.outcome as 'refused_owner_set' | 'refused_not_supervisor', { priority: updated?.priority ?? null, prioritySource: updated?.prioritySource ?? null }, ranking.writer ?? 'machine', { nothingElse: true });
  }

  return goalView({ ...updated, ...(statusChanged ? data : {}) }, {
    dependsOnGoalIds: newDepIds
      ?? (await prisma.goalDependency.findMany({ where: { goalId } })).map((d: any) => d.dependsOnGoalId),
    ...(blockKindNote ? { blockKindNote } : {}),
    // Observe-only (C2): the caller sees WHY the close is suspect; the status is still 'done'.
    ...(doneSuspect?.reasons.length ? { doneSuspect: doneSuspect.reasons, doneSuspectNote: doneSuspect.note } : {}),
    // GOAL-OUTCOME-UNMET review fix: a close that left the outcome LIVE says so (and what ends it).
    ...(outcomeNote ? { outcomeUnmetNote: outcomeNote } : {}),
    // GOAL-PRIORITY-SPEND: a refused ranking write says why (the rest of the call applied).
    ...(ranking.note ? { priorityNote: ranking.note } : {}),
    ...(rankingRefused ? { rankingApplied: false } : {}),
    ...(rankingOnlyNoop ? { changed: false } : {}),
  });
}

/**
 * Account-wide OWNED-project briefs (id + name) for the global goal/todo
 * listings. Ownership mirrors platform.service.getProjectAccess: DIRECT
 * (project.userId = caller) plus — when folder inheritance is on — projects
 * nested under a folder the caller owns (an ancestor owner holds role
 * 'owner' there, so the global list must count them too; the edff5ac6 gap
 * was counting direct ownership only). Member-shared projects with NO owned
 * ancestor stay excluded (owner decision 2026-08-13 cross-user isolation).
 * The descendant expansion resolves a root's subtree by the root's ID as a
 * materialized-path SEGMENT — the same ownership notion getProjectAccess /
 * getAncestorChain resolve (ancestors found by the ids encoded in the LEAF's
 * path). It used to key on the root's OWN path string
 * (`startsWith: ${root.path}/`): an owned root carrying a blank/legacy path
 * contributed ZERO descendants while getProjectAccess still granted the
 * caller 'owner' on projects beneath it — goal_get worked, the account-wide
 * listing went blind (ticket b1e59df6, 2026-09-15). Ids are uuids, so
 * '/<id>/' is segment-exact: no sibling-prefix matches and no cross-user
 * leak (a blank-path LEAF stays unreachable — getAncestorChain degrades to
 * leaf-only there too, so enumeration and access stay in parity).
 */
async function listOwnedProjectBriefs(userId: string): Promise<Array<{ id: string; name: string }>> {
  const ownedAll = await prisma.crossModelProject.findMany({
    where: { userId },
    select: { id: true, name: true, path: true, archivedAt: true },
  });
  // Archived folders — and everything under one — leave the account-wide
  // goal/todo lists (archive = de-clutter; their goals stay reachable via the
  // scoped projectId form, which is a direct-id read).
  const archivedPaths = ownedAll.filter((p: any) => p.archivedAt).map((p: any) => p.path || `/${p.id}`);
  const owned = ownedAll.filter((p: any) => {
    const path = p.path || `/${p.id}`;
    return !archivedPaths.some((a: string) => path === a || path.startsWith(`${a}/`));
  });
  if (!owned.length) return [];
  const nameById = new Map<string, string>();
  for (const p of owned) nameById.set(p.id, p.name);
  if (foldersInheritanceOn()) {
    // See the docblock above: expand by root-ID path segment, never by the
    // root's own path string (blank-path roots still own their subtree).
    const roots = owned;
    if (roots.length) {
      const descendants = await prisma.crossModelProject.findMany({
        // Same archive rule for inherited descendants (self-stamped rows).
        where: { archivedAt: null, OR: roots.map((p: any) => ({ path: { contains: `/${p.id}/` } })) },
        select: { id: true, name: true },
      });
      for (const d of descendants) nameById.set(d.id, d.name);
    }
  }
  return [...nameById].map(([id, name]) => ({ id, name }));
}

/**
 * List goals. Account-wide by DEFAULT (owner decision 2026-08-13, 'All
 * projects, tagged'): with NO projectId, lists across EVERY project the user
 * OWNS — directly or via an owned ancestor folder (listOwnedProjectBriefs);
 * member-shared projects with no owned ancestor stay reachable only via the
 * scoped form. With projectId, scopes to that project (read access:
 * owner or any member) and includeDescendants widens to the whole folder
 * subtree via the materialized path prefix. Every row is tagged with its
 * projectName; each goal carries its todos (id/title/status) and both
 * dependency directions.
 */
/**
 * Premise register (owner 2026-09-16, framework item 2): register or refresh
 * the quantitative premises a goal rests on. WRITE access on the goal's
 * project; validation in premise-register.ts (≤12 per goal, one kpi: key, https-only sources,
 * jsonPath|pattern readers). mode 'merge' (default) upserts by key and keeps
 * the check stamps of an unchanged premise; 'replace' rewrites the set (an
 * empty array clears it). Audited as goal.premises_set.
 */
export async function setGoalPremises(opts: {
  userId: string;
  goalId: string;
  premises: unknown;
  mode?: 'merge' | 'replace';
  actingChatId?: string;
  /** No user turn behind this run (schedule firing / hook wake) — recorded on the audit row when `observed` lands without an observedNote (observe-only). */
  machineTriggered?: boolean;
}): Promise<GoalView> {
  const { userId } = opts;
  const goalId = await canonicalGoalId(opts.goalId, userId);
  const goal = await getGoalRow(goalId, userId, true);
  await requireProjectWrite(goal.projectId, userId);
  const existing = readPremises(goal.premises);
  const normalized = normalizePremises(opts.premises, existing, { mode: opts.mode, setByChatId: opts.actingChatId ?? null });
  if (!normalized.ok) {
    if (normalized.kpiRefusal) recordKpiPremiseRefusal({ reason: normalized.kpiRefusal.reason, goalId: goal.id, projectId: goal.projectId, key: normalized.kpiRefusal.key, sessionId: opts.actingChatId ?? null });
    throw new AppError(400, `goal_premise_set: ${normalized.error}`);
  }
  // Mission KPI contract (tt-rd audit 2026-09-27, finding 1): a kpi: premise
  // whose value or receipt is NEW must cite a receipt row that EXISTS, ran
  // ok:true, and belongs to a chat in this goal's project. Deterministic and
  // cheap (two indexed reads), so it may refuse; a DB error fails OPEN (the
  // premise lands, the miss is logged) — the register must never be blocked
  // by an infra hiccup.
  const existingByKey = new Map(existing.map((p) => [p.key.toLowerCase(), p]));
  const refuse = (reason: KpiRefusalReason, p: { key: string; receiptId?: string }, message: string): never => {
    recordKpiPremiseRefusal({ reason, goalId: goal.id, projectId: goal.projectId, key: p.key, receiptId: p.receiptId ?? null, sessionId: opts.actingChatId ?? null });
    throw new AppError(400, message);
  };
  const RECEIPT_SELECT = { id: true, chatId: true, ok: true, tool: true, createdAt: true } as const;
  for (const p of normalized.premises) {
    if (!isKpiPremise(p) || !p.receiptId) continue;
    const before = existingByKey.get(p.key.toLowerCase());
    if (before && before.receiptId === p.receiptId && Number(before.value) === Number(p.value)) continue; // unchanged reading
    try {
      let resolvedVia: 'receiptId' | 'runId' = 'receiptId';
      let receipt = await (prisma as any).runToolReceipt.findFirst({
        where: { id: { startsWith: p.receiptId } },
        select: RECEIPT_SELECT,
      });
      if (!receipt) {
        // Fixer follow-up 1 (2026-09-27): a RUN id (runs[].id in get_run_receipts) is
        // accepted as the reference too and resolves — via the [runId] index — to that
        // run's latest ok run_command receipt. Deterministic, one indexed read.
        receipt = await (prisma as any).runToolReceipt.findFirst({
          where: { runId: { startsWith: p.receiptId }, tool: 'run_command', ok: true },
          orderBy: { createdAt: 'desc' },
          select: RECEIPT_SELECT,
        });
        if (receipt) resolvedVia = 'runId';
      }
      if (!receipt) refuse('receipt_missing', p, `goal_premise_set: premise "${p.key}": receipt ${p.receiptId.slice(0, 8)} does not exist — cite the \`id\` on a run_command receipt row (or that run's id) from get_run_receipts on the lane that ran the probe (a remembered or derived figure is not the KPI).`);
      if (receipt.ok !== true) refuse('receipt_not_ok', p, `goal_premise_set: premise "${p.key}": receipt ${String(receipt.id).slice(0, 8)} is ok:false (${receipt.tool}: staged or failed) — the KPI moves only on a probe that actually ran.`);
      const chat = await prisma.crossModelChat.findUnique({ where: { id: String(receipt.chatId) }, select: { projectId: true } });
      if (chat && chat.projectId && chat.projectId !== goal.projectId) {
        refuse('other_project', p, `goal_premise_set: premise "${p.key}": receipt ${String(receipt.id).slice(0, 8)} belongs to a chat outside this goal's project — cite the probe run in THIS project.`);
      }
      p.receiptId = String(receipt.id);
      (p as any).receiptTool = String(receipt.tool ?? '');
      if (receipt.createdAt) (p as any).receiptAt = new Date(receipt.createdAt).toISOString();
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.KPI_PREMISE_SET, sessionId: opts.actingChatId ?? undefined,
        meta: { goalId: goal.id, projectId: goal.projectId, key: p.key, value: p.value, prev: before?.value ?? null, receiptId: String(receipt.id).slice(0, 8), tool: receipt.tool ?? null, bar: p.bar ?? null, resolvedVia },
      });
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      logger.warn(`goal_premise_set: KPI receipt check failed open for ${goal.id.slice(0, 8)}/${p.key}: ${err?.message ?? err}`);
    }
  }
  const updated = await (prisma.projectGoal as any).update({ where: { id: goal.id }, data: { premises: normalized.premises } });
  // Review fix (sup3 fixer pass, 2026-09-27 — finding 1): a lane recording a
  // MEASURED value (observed + observedNote) is the remedy for a suspect
  // close; the audit names which keys were observed in THIS call and which
  // landed without evidence text (telemetry only — never refused).
  const rawRows = Array.isArray(opts.premises) ? (opts.premises as any[]).filter((p) => p && typeof p === 'object') : [];
  const observedKeys = rawRows.filter((p) => p.observed !== undefined && p.observed !== null && String(p.observed).trim() !== '').map((p) => String(p.key ?? ''));
  const observedWithoutNote = rawRows.filter((p) => observedKeys.includes(String(p.key ?? '')) && !String(p.observedNote ?? '').trim()).map((p) => String(p.key ?? ''));
  // Finding C3 (2026-09-27): a beyond-tolerance re-registration is a REVISION —
  // one premise_revised row per key (old/new/pct + manifests), named in the
  // audit row and echoed on the answer as premiseRevisions[].line so the lane
  // sees "premise X revised 30.88→18.6 (-40%)" in the same turn. Observe-only:
  // the write already landed; nothing is refused. PREMISE_REVISION_DISABLED=1
  // restores the silent merge (normalizePremises then returns no revisions).
  const revisions = normalized.revisions ?? [];
  for (const r of revisions) {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.PREMISE_REVISED,
      ...(r.pct !== null ? { value: Math.round(r.pct * 100) / 100, unit: 'pct' } : {}),
      meta: {
        goalId: goal.id, projectId: goal.projectId, key: r.key, old: r.old, new: r.new, pct: r.pct,
        unit: r.unit ?? null, oldManifest: r.oldManifest ?? null, newManifest: r.newManifest ?? null, manifestMatch: r.manifestMatch,
        mode: opts.mode ?? 'merge', actingChatId: opts.actingChatId ?? null,
      },
    });
  }
  // Ticket 7862cb2a: a replace that retires registered keys says WHICH — the
  // cap used to evict silently, leaving a live measured premise behind only as
  // prose in the goal note. Nothing dropped (the common path) leaves the answer
  // byte-identical to before.
  const dropped = normalized.dropped ?? [];
  await audit(userId, 'goal.premises_set', {
    goalId: goal.id, projectId: goal.projectId, mode: opts.mode ?? 'merge', actingChatId: opts.actingChatId ?? null,
    keys: normalized.premises.map((p) => p.key), sourced: normalized.premises.filter((p) => p.source).length,
    ...(dropped.length ? { evicted: dropped } : {}),
    // Finding 2a: the audit row names every value that moved (old → new) — the register is no longer a silent overwrite.
    changed: normalized.premises
      .filter((p) => { const b = existingByKey.get(p.key.toLowerCase()); return !b || Number(b.value) !== Number(p.value); })
      .map((p) => ({ key: p.key, from: existingByKey.get(p.key.toLowerCase())?.value ?? null, to: p.value, ...(p.receiptId ? { receiptId: p.receiptId.slice(0, 8) } : {}) })),
    kpi: normalized.premises.filter((p) => isKpiPremise(p)).map((p) => p.key),
    ...(observedKeys.length ? { observedKeys, observedWithoutNote, machineTriggered: opts.machineTriggered === true } : {}),
    ...(revisions.length ? { revised: revisions.map((r) => ({ key: r.key, old: r.old, new: r.new, pct: r.pct })) } : {}),
  });
  // Nothing dropped (the common path) ⇒ no extra fields: the answer is
  // byte-identical to before this ticket.
  const evictionNotice = premiseEvictionNotice(dropped, opts.mode === 'replace' ? 'replace' : 'merge', normalized.premises.length);
  return goalView(updated, {
    ...(revisions.length ? { premiseRevisions: revisions } : {}),
    ...(dropped.length ? { premiseEvictions: dropped, premiseEvictionNotice: evictionNotice } : {}),
  });
}

/**
 * audit 2026-10-06 T5-5 (stanne #14): ONE unscoped goal_list from a project
 * chat returned 100 FULL goal rows (premises, descriptions, inline todos) —
 * 46k → 420k chars of context in one result, compaction at the next step. The
 * ACCOUNT-WIDE listing is now COMPACT (id / project / title / status / clipped
 * block + progress / todo counts / premise count), open goals first, under a
 * hard char cap with a "narrow by projectId" hint; the scoped form keeps full
 * rows. Kill switch GOAL_LIST_COMPACT_DISABLED=1; cap env
 * GOAL_LIST_ACCOUNT_WIDE_MAX_CHARS (default 40,000).
 */
export function goalListCompactDisabled(): boolean {
  return process.env.GOAL_LIST_COMPACT_DISABLED === '1';
}
export const GOAL_LIST_ACCOUNT_WIDE_MAX_CHARS_DEFAULT = 40_000;
export function goalListAccountWideMaxChars(): number {
  const n = Number(process.env.GOAL_LIST_ACCOUNT_WIDE_MAX_CHARS);
  return Number.isFinite(n) && n >= 2_000 ? Math.floor(n) : GOAL_LIST_ACCOUNT_WIDE_MAX_CHARS_DEFAULT;
}
export const GOAL_LIST_COMPACT_HINT =
  'ACCOUNT-WIDE rows are COMPACT (no description / premises / todo list). Narrow by projectId — goal_list({projectId}) — for one project\'s full rows, or goal_get(goalId) for one goal in full.';

const clipText = (v: unknown, n: number): string | null => {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One compact account-wide goal row. Pure; exported for tests. */
export function compactGoalRow(g: GoalView): Record<string, unknown> {
  const todos: Array<{ status?: string }> = Array.isArray(g.todos) ? g.todos : [];
  const open = todos.filter((t) => t?.status === 'pending' || t?.status === 'in_progress' || t?.status === 'blocked').length;
  const done = todos.filter((t) => t?.status === 'done').length;
  const blockedReason = clipText(g.blockedReason, 140);
  const progressNote = clipText(g.progressNote, 140);
  const premises = Array.isArray(g.premises) ? g.premises.length : 0;
  const deps = Array.isArray(g.dependsOnGoalIds) ? g.dependsOnGoalIds.length : 0;
  return {
    id: g.id,
    projectId: g.projectId,
    projectName: g.projectName ?? null,
    title: g.title,
    status: g.status,
    ...(blockedReason ? { blockedReason } : {}),
    ...(progressNote ? { progressNote } : {}),
    todos: { total: todos.length, open, done },
    ...(premises ? { premises } : {}),
    ...(deps ? { dependsOn: deps } : {}),
    updatedAt: g.updatedAt ?? null,
  };
}

/**
 * The compact account-wide listing: open goals (active / blocked) first, then
 * the rest, each group in creation order; at most `maxRows` rows and
 * `maxChars` of JSON. Pure; exported for tests.
 */
export function compactAccountWideGoals(rows: GoalView[], opts: { maxRows: number; maxChars?: number }): { goals: Record<string, unknown>[]; total: number; truncated: boolean } {
  const maxChars = opts.maxChars ?? goalListAccountWideMaxChars();
  const isOpen = (g: GoalView) => g.status === 'active' || g.status === 'blocked';
  const ordered = [...rows.filter(isOpen), ...rows.filter((g) => !isOpen(g))];
  const goals: Record<string, unknown>[] = [];
  let size = 2;
  for (const g of ordered) {
    if (goals.length >= opts.maxRows) break;
    const row = compactGoalRow(g);
    const len = JSON.stringify(row).length + 2;
    if (goals.length && size + len > maxChars) break;
    goals.push(row);
    size += len;
  }
  return { goals, total: rows.length, truncated: goals.length < rows.length };
}

export async function listGoals(opts: {
  userId: string;
  projectId?: string;
  includeDescendants?: boolean;
  status?: GoalStatus;
}): Promise<GoalView[]> {
  const { userId, projectId } = opts;
  if (opts.status !== undefined && !(GOAL_STATUSES as readonly string[]).includes(String(opts.status))) {
    throw new AppError(400, `status must be one of: ${GOAL_STATUSES.join(', ')}`);
  }

  let projectIds: string[];
  const projectNameById = new Map<string, string>();
  if (projectId) {
    // Canonicalize the fleet's 8-char project idiom BEFORE the access read
    // (ticket fb3ea311) and use the RESOLVED full id everywhere downstream —
    // the descendants path-segment expansion below keyed on the raw input
    // would silently match nothing for a prefix (the review-B1 "fetch by
    // resolved id, query by raw input" trap).
    const scopeId = await canonicalProjectId(projectId, userId);
    const { project } = await requireScopedProjectRead(scopeId, projectId, userId);
    projectNameById.set(project.id, project.name);
    projectIds = [project.id];
    if (opts.includeDescendants) {
      // Same id-segment semantics as the account-wide fix (ticket b1e59df6,
      // PR #785): expand the subtree by the scoped project's ID as a
      // materialized-path SEGMENT — the same notion getProjectAccess /
      // getAncestorChain resolve (ancestors found by the ids encoded in the
      // LEAF's path). It used to key on the scoped project's OWN path string
      // (`startsWith: ${project.path}/`) and skip the expansion entirely on a
      // blank/legacy path: the caller could read the project (access half)
      // yet includeDescendants silently omitted its accessible descendants
      // (enumeration half) — ticket fa2e44dd. Ids are uuids, so '/<id>/' is
      // segment-exact: no sibling-prefix matches, no cross-user leak, and a
      // blank-path LEAF stays unreachable exactly as getAncestorChain
      // degrades there (parity preserved).
      const descendants = await prisma.crossModelProject.findMany({
        where: { OR: [{ id: project.id }, { path: { contains: `/${project.id}/` } }] },
        select: { id: true, name: true },
      });
      projectIds = descendants.map((d: any) => d.id);
      for (const d of descendants) projectNameById.set(d.id, d.name);
      if (!projectIds.includes(project.id)) projectIds.push(project.id);
    }
  } else {
    // Account-wide: OWNED projects only (direct + inherited-folder ownership —
    // see listOwnedProjectBriefs). Cross-user isolation lives in this filter —
    // goals in projects merely shared WITH the user never join the global
    // listing (they remain readable via the scoped projectId form).
    const owned = await listOwnedProjectBriefs(userId);
    if (!owned.length) return [];
    projectIds = owned.map((p) => p.id);
    for (const p of owned) projectNameById.set(p.id, p.name);
  }

  const goals = await prisma.projectGoal.findMany({
    where: {
      projectId: { in: projectIds },
      ...(opts.status ? { status: String(opts.status) } : {}),
    },
    orderBy: { createdAt: 'asc' },
    include: {
      todos: { select: { id: true, title: true, status: true } },
      depsThis: { select: { dependsOnGoalId: true } },
      depsOn: { select: { goalId: true } },
    },
  });
  return goals.map((g: any) => goalView(g, {
    projectName: projectNameById.get(g.projectId) ?? null,
    todos: (g.todos ?? []).map((t: any) => ({ id: t.id, title: t.title, status: t.status })),
    dependsOnGoalIds: (g.depsThis ?? []).map((d: any) => d.dependsOnGoalId),
    dependentGoalIds: (g.depsOn ?? []).map((d: any) => d.goalId),
  }));
}

/** Full goal detail (read access): deps + dependents with status, and todos. */
export async function getGoal(opts: { userId: string; goalId: string }): Promise<GoalView> {
  // Read path: a unique ≥8-char prefix resolves (ticket 8579d419) — every
  // downstream use keys on goal.id, never the raw input.
  const goal = await getGoalRow(opts.goalId, opts.userId, true);
  await requireProjectRead(goal.projectId, opts.userId);

  const [depRows, dependentRows, todos] = await Promise.all([
    prisma.goalDependency.findMany({ where: { goalId: goal.id } }),
    prisma.goalDependency.findMany({ where: { dependsOnGoalId: goal.id } }),
    prisma.projectTodo.findMany({ where: { goalId: goal.id }, orderBy: { createdAt: 'asc' } }),
  ]);
  const relatedIds = [
    ...depRows.map((d: any) => d.dependsOnGoalId),
    ...dependentRows.map((d: any) => d.goalId),
  ];
  const related = relatedIds.length
    ? await prisma.projectGoal.findMany({ where: { id: { in: relatedIds } } })
    : [];
  const byId = new Map(related.map((g: any) => [g.id, g]));
  const brief = (id: string) => {
    const g: any = byId.get(id);
    return g ? { id: g.id, title: g.title, status: g.status, projectId: g.projectId } : { id, missing: true };
  };

  return goalView(goal, {
    dependsOn: depRows.map((d: any) => brief(d.dependsOnGoalId)),
    dependents: dependentRows.map((d: any) => brief(d.goalId)),
    todos: todos.map((t: any) => ({ id: t.id, title: t.title, status: t.status })),
    // Ticket 973d7f80: tell the lane WHOSE gate this is before it "repairs" it.
    ...(await gateQuestionVisibilityFor(goal.gateQuestionId, opts.userId)),
  });
}

// ── Todos ────────────────────────────────────────────────────────────────────

/**
 * Create a todo under a goal (write access on the goal's project). projectId
 * is denormalized from the goal. Dep todos must exist and belong to the same
 * owner; unmet deps start the todo 'blocked' with a '[deps]' reason.
 */
export async function createTodo(opts: {
  userId: string;
  goalId: string;
  title: string;
  assigneeChatId?: string;
  dependsOnTodoIds?: string[];
  /** The chat creating the todo (audit 2026-10-08 W5-5): rides the audit row, and a chat assigning a NEW todo to itself is not woken. */
  actingChatId?: string;
  /** No real user turn anchors the create (2026-10-20 transition telemetry's actorKind only). */
  machineTriggered?: boolean;
}): Promise<TodoView> {
  const { userId } = opts;
  const title = String(opts.title ?? '').trim();
  if (!title) throw new AppError(400, 'title is required');
  // Canonicalize up front (FO firing 24, 2026-09-25): a unique ≥8-char goal
  // prefix now resolves exactly like every other id-taking goal/todo path
  // (reads 8579d419, writes 31db672f, listTodos fb3ea311) — the incident this
  // closes is the live 'Goal not found: "09a1ec04"' ×2 (05:35Z) whose own
  // Did-you-mean hint already named the unique match. The goalId is a PARENT
  // POINTER (not a row to mutate), so the B1 review concern (fetch resolved /
  // mutate raw) cannot arise: EVERY downstream use below (getGoalRow, dep
  // self-checks, cycle walk, tx create data.goalId, audit, todo_done payload)
  // carries the resolved full id. Ambiguous / invisible / full-length misses
  // keep the exact-id 404+hint contract via getGoalRow.
  const goalId = await canonicalGoalId(opts.goalId, userId);
  if (goalId !== opts.goalId) {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.TODO_CREATE_PREFIX_RESOLVED,
      meta: { from: opts.goalId.slice(0, 8), to: goalId.slice(0, 8), userId },
    });
  }
  const goal = await getGoalRow(goalId, userId);
  await requireProjectWrite(goal.projectId, userId);

  // Ticket 8f62542c: canonicalize dep prefixes through the shared resolver
  // BEFORE the raw-exact loader lookup (unresolved ids pass through verbatim).
  const depIds = await canonicalizeDepIds(
    normalizeDepIds(opts.dependsOnTodoIds, null, 'todo'),
    null,
    'todo',
    userId,
  );
  const depTodos = await loadSameOwnerDepTodos(depIds, goal.userId);
  const id = randomUUID();
  if (await wouldCreateTodoCycle(id, depIds, goal.userId)) {
    throw new AppError(409, 'Dependency cycle detected: a todo cannot (transitively) depend on itself');
  }

  const open = openTodoDeps(depTodos);
  // Ticket 4057952b: the assignee id resolves to its canonical full form —
  // the SAME single-chat validation now carries the fleet 8-char prefix
  // idiom every sibling id path already resolves. What is written is what
  // was validated (the B1 trap).
  let assignable: { assigneeChatId: string } | null = null;
  if (opts.assigneeChatId) {
    assignable = { assigneeChatId: await resolveAssignableChat(String(opts.assigneeChatId), goal.userId) };
  }
  const todo = await prisma.$transaction(async (tx: any) => {
    const t = await tx.projectTodo.create({
      data: {
        id,
        userId: goal.userId, // todos are owned by their project owner
        goalId,
        projectId: goal.projectId, // denormalized
        title,
        ...(assignable ? { assigneeChatId: assignable.assigneeChatId } : {}),
        ...(open.length ? { status: 'blocked', blockedReason: depsReason(open.length, 'todo'), blockedAt: new Date() } : {}),
      },
    });
    if (depIds.length) {
      await tx.todoDependency.createMany({
        data: depIds.map((dependsOnTodoId) => ({ todoId: id, dependsOnTodoId })),
      });
    }
    return t;
  });

  await audit(userId, 'todo.create', { todoId: id, goalId, projectId: goal.projectId, title, dependsOnTodoIds: depIds, status: todo.status, ...(opts.actingChatId ? { actingChatId: opts.actingChatId } : {}) });
  recordStatusTransition('todo', { id, projectId: goal.projectId, goalId, createdAt: (todo as any).createdAt ?? new Date() }, null, todo.status ?? 'pending', actorKindOf(opts.machineTriggered), opts.actingChatId);
  // Ticket 2a6e3238: NEW work under a DONE goal is the same contradictory
  // board state the reopen seam (P4 v1#9) already fixes for REOPENED work —
  // a pending todo sitting under a 'done' goal is what made the supervisor's
  // board note assert 'active' while the ledger said 'done' (the lane added
  // work at 06:14Z; the goal only followed via a manual reopen at 06:34Z).
  // Reuse the SAME seam so there is exactly one implementation of reopen
  // semantics (audit, reopen-label telemetry, dependent recompute); the guard
  // reads the row already in hand so the common path (live goal) pays no
  // extra lookup. Runs AFTER the create so a failed create never reopens a
  // goal that gained nothing. Archived is a retirement decision, not a
  // completion claim — untouched (same contract as the sibling seam).
  if (goal.status === 'done') {
    await maybeReopenGoalOnTodoReopen(goalId, userId, 'todo_create');
  }
  // Resume propagation: an actionable assignment wakes the assignee (a blocked
  // one wakes when it auto-unblocks — recomputeTodoBlockedState).
  if (todo.assigneeChatId && todo.status !== 'blocked') {
    // audit 2026-10-08 W5-5: never wake the chat that assigned the todo to itself.
    if (opts.actingChatId && opts.actingChatId === todo.assigneeChatId && !todoSelfWakeSkipDisabled()) recordSelfWakeSkip(id, todo.assigneeChatId, 'assigned');
    else await wakeTodoAssignee(todo, 'assigned', userId);
  }
  return todoView(todo, { dependsOnTodoIds: depIds });
}

/**
 * Resolve + validate an assigneeChatId: the chat must exist AND belong to the
 * fleet owner — todo_done hook events fire FROM the assignee chat, so a foreign
 * assignee would let one user's goals inject wake events into another user's
 * fleet (cross-user wake injection).
 *
 * Ticket 4057952b (2026-10-09): this was the LAST exact-id-only WRITE path left
 * in the goal/todo graph. The live incident (session 41bd202a): a supervisor
 * assigned three todos to lane b94e3fad-…-f668c486fea6 by the fleet-standard
 * 8-char prefix its own board and prior-wake ledgers print ("session
 * b94e3fad"), goalId a0114487 (also an 8-char prefix) resolved in the SAME
 * call via canonicalGoalId, and every one of the 3 calls 400'd
 * "assigneeChatId: chat not found" — the raw exact findUnique on the prefix.
 * Every sibling id path resolves that idiom (goalId reads/writes 8579d419 /
 * 31db672f / firing-24, todoId, projectId fb3ea311, dependsOnTodoIds 8f62542c,
 * and every chat-id READ tool via resolveOwnedChatIdPrefix) — the assignee
 * seam was the outlier.
 *
 * Returns the CANONICAL full id (the caller writes THAT — the B1 trap: never
 * validate a resolved id but persist the raw one; bindCharter, the
 * wakeTodoAssignee resume propagation and the stored row must all carry the
 * resolved id). Resolution tiers, same contract as the chat-id read tools:
 * exact id → itself; a UNIQUE ≥8-char prefix of an OWNER chat → the full id
 * (owner-scoped: a prefix never widens to a member-shared or foreign chat —
 * cross-user injection stays impossible); anything else → the id unchanged,
 * so the 400/403 error paths below speak verbatim. A resolver hiccup
 * (thin prisma mock, transient lookup error) falls back to the exact-lookup
 * contract — fail-open to the ORIGINAL validation, never a silent create.
 * Kill switch TODO_ASSIGNEE_PREFIX_DISABLED=1 restores the exact-only lookup.
 */
async function resolveAssignableChat(assigneeChatId: string, ownerId: string): Promise<string> {
  const typed = String(assigneeChatId ?? '').trim();
  if (!typed) return typed;
  const chat = await prisma.crossModelChat.findUnique({ where: { id: typed }, select: { id: true, userId: true } });
  if (chat) {
    if (chat.userId !== ownerId) {
      throw new AppError(403, 'assigneeChatId must belong to the same owner as the goal (todo_done events fire from that chat)');
    }
    return chat.id;
  }
  // Ticket 4057952b: exact miss → the ONE owner-scoped chat resolver (the
  // same implementation every chat-id READ tool uses — chat-id-resolver.ts).
  // An unresolved / ambiguous / foreign candidate falls through to the
  // original 400 so the error contract is unchanged.
  if (process.env.TODO_ASSIGNEE_PREFIX_DISABLED !== '1') {
    try {
      const { resolveOwnedChatIdPrefix } = await import('./chat-id-resolver');
      const resolved = await resolveOwnedChatIdPrefix(ownerId, typed);
      if (resolved && resolved !== typed) {
        const row = await prisma.crossModelChat.findUnique({ where: { id: resolved }, select: { id: true, userId: true } });
        // The resolver is owner-scoped, but re-verify ownership here — the
        // 403 wake-injection guard must hold on the resolved row too.
        if (row && row.userId === ownerId) {
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.TODO_ASSIGNEE_PREFIX_RESOLVED,
            meta: { from: typed.slice(0, 8), to: resolved.slice(0, 8), userId: ownerId },
          });
          return resolved;
        }
      }
    } catch { /* fail-open: the 400 below speaks */ }
  }
  throw new AppError(400, 'assigneeChatId: chat not found');
}

/**
 * Update a todo (write access on its project). Same status rules as goals:
 * 'done' is gated on dep todos (force overrides + audit); 'blocked' needs a
 * reason. On a transition INTO done: emit todo_done on the todo's
 * assigneeChatId (skipped when unset), recompute dependent todos, then
 * auto-complete the parent goal when ALL its todos are done AND all its
 * goal-deps are done-ish (that transition itself recomputes goal dependents).
 */
export async function updateTodo(opts: {
  userId: string;
  todoId: string;
  title?: string;
  status?: TodoStatus;
  blockedReason?: string;
  /** Remediation P2 S2a: WHY it is blocked ('deps'|'owner'|'agent'|'external'); null clears. */
  blockKind?: string | null;
  /** The open owner-question (oq_…) gating a blockKind='owner' row; null clears. */
  gateQuestionId?: string | null;
  assigneeChatId?: string | null;
  force?: boolean;
  dependsOnTodoIds?: string[];
  /**
   * Evidence for a DONE transition (P4 v1#10): the tool-result artifact
   * citation backing the completion. REQUIRED for machine-triggered closes
   * (see machineTriggered); stored on the row either way when provided.
   *
   * AMENDMENT (ticket ac87ab80): on a row ALREADY done/dropped this field
   * AMENDS the stored citation (audited `todo.evidence_amended`) — a citation
   * later disproven by events must be correctable, and the pre-fix behaviour
   * (silently echo the stale text back as a success) left falsified claims
   * standing in the shared board. On a NON-terminal row with no closing status
   * it 400s loudly; it is never silently dropped.
   */
  evidence?: string;
  /** The agent_runs row whose update closes this todo (machine closes). */
  doneRunId?: string | null;
  /**
   * Progress-aware pulse (P7 v1#20): a short free-text progress note
   * ("3/5 shards trained, loss 2.1") — ≤2,000 chars stored (a8d6e514; the
   * Pulse / cards show the first ~200), replaces the previous one; null/''
   * clears. Cheap: no status transition required.
   */
  progressNote?: string | null;
  /**
   * True when NO real user turn anchors this update (schedule firings, hook
   * wakes, dispatched briefs — the same discriminator the consequential-tool
   * gate uses). Gate flip 2026-09-11 (owner: full steam): a machine close
   * WITHOUT evidence now LANDS (evidence is stored when given) and
   * force:true is honoured (still audited as todo.force_done). Accepted for
   * the callers' shape; updateTodo no longer reads it (build 2026-10-08 S-2).
   */
  machineTriggered?: boolean;
  /**
   * The chat performing this update (hardening 2026-09-14; mirrors
   * updateGoal's v1#8 option). todo_done still emits FROM the assignee (the
   * worker-finished signal direct per-worker hooks subscribe to) — the actor
   * rides alongside so hooks.service can skip a hook whose TARGET is this chat:
   * a project supervisor closing a worker's todo ("mark done what has landed")
   * must not be woken 10 minutes later to re-audit its own close. Unset for
   * REST / user-present closes — those wake exactly as before.
   */
  actingChatId?: string;
  /** The agent_runs row performing this update (ticket c286ba91): stamped on
   *  the row (updatedByRunId) and rides audit metadata so a gate flip is never
   *  "unattributed" again. Unset for REST / user-present writes. */
  actingRunId?: string;
}): Promise<TodoView> {
  const { userId } = opts;
  // Canonicalize up front (ticket 31db672f) — every downstream use of todoId
  // below (metrics, dep self-check, cycle walk, tx update, dep rewrites,
  // recompute, audit) carries the full id.
  const todoId = await canonicalTodoId(opts.todoId, userId);
  const todo = await getTodoRow(todoId, userId);
  await requireProjectWrite(todo.projectId, userId);
  // Gate flip 2026-09-11 (owner: full steam): the machine-close evidence gate
  // is OBSERVE-ONLY by default (0 strikes since 09-08; every machine close
  // cited evidence voluntarily because the tool schema asks for it).
  const evidenceText = typeof opts.evidence === 'string' ? opts.evidence.trim() : '';

  let newDepIds: string[] | undefined;
  if (opts.dependsOnTodoIds !== undefined) {
    // Ticket 8f62542c: canonicalize prefixes, then re-check self-reference
    // (a prefix of THIS todo now resolves to todoId → keep the 400 class).
    newDepIds = await canonicalizeDepIds(
      normalizeDepIds(opts.dependsOnTodoIds, todoId, 'todo'),
      todoId,
      'todo',
      userId,
    );
    await loadSameOwnerDepTodos(newDepIds, todo.userId);
    if (await wouldCreateTodoCycle(todoId, newDepIds, todo.userId)) {
      throw new AppError(409, 'Dependency cycle detected: a todo cannot (transitively) depend on itself');
    }
  }

  const data: Record<string, any> = {};
  if (opts.title !== undefined) {
    const title = String(opts.title).trim();
    if (!title) throw new AppError(400, 'title must be non-empty');
    data.title = title;
  }
  if (opts.assigneeChatId !== undefined) {
    // Ticket 4057952b: the assignee id resolves to its canonical full form —
    // what is written is what was validated (the B1 trap). null unassigns.
    data.assigneeChatId = opts.assigneeChatId
      ? await resolveAssignableChat(String(opts.assigneeChatId), todo.userId)
      : null;
  }
  // Progress note (P7 v1#20): apply-or-clear, capped — never a silent drop.
  // f3e56567 follow-up: cap on CODE POINTS (never a split surrogate pair) so the
  // stored row and progressNoteClipNotice's count measure the same unit.
  if (opts.progressNote !== undefined) {
    const note = clipProgressNote(opts.progressNote);
    data.progressNote = note || null;
  }

  // Snapshot the PRE-update state for the wake decision below: the real client
  // returns fresh objects, but a stateful fake (tests) can mutate `todo` under
  // us inside the transaction — never decide a wake off post-mutation reads.
  const prevStatus = todo.status;
  const prevAssignee: string | null = todo.assigneeChatId ?? null;

  let statusChanged = false;
  let becameDone = false;
  let becameUndone = false;
  let becameDropped = false;
  if (opts.status !== undefined) {
    const status = String(opts.status) as TodoStatus;
    if (!(TODO_STATUSES as readonly string[]).includes(status)) {
      throw new AppError(400, `status must be one of: ${TODO_STATUSES.join(', ')}`);
    }
    if (status !== todo.status) {
      if (status === 'done') {
        const effDepIds = newDepIds
          ?? (await prisma.todoDependency.findMany({ where: { todoId } })).map((d: any) => d.dependsOnTodoId);
        const deps = effDepIds.length
          ? await prisma.projectTodo.findMany({ where: { id: { in: effDepIds } } })
          : [];
        const open = openTodoDeps(deps);
        if (open.length && !opts.force) {
          throw new AppError(
            409,
            `Todo cannot be marked done: waiting on ${open.length} todo(s) not done: ` +
            `${open.map((t: any) => `"${t.title}" (${t.status})`).join(', ')}. Pass force: true to override.`,
          );
        }
        if (open.length && opts.force) {
          await audit(userId, 'todo.force_done', { todoId, openDeps: open.map((t: any) => t.id) });
        }
        // Store the closing evidence (any actor) + the closing run (machine).
        if (evidenceText) data.evidence = evidenceText;
        if (opts.doneRunId !== undefined) data.doneRunId = opts.doneRunId;
        becameDone = true;
      }
      if (status === 'dropped') {
        // P7 N5: TERMINAL owner-superseded cancellation — the honest close for
        // work an owner directive cancelled (instead of rotting as 'blocked').
        // An evidence-less machine drop is never refused; no
        // dependency gate — dropping cancels the work rather than claiming it
        // happened, and dependents are satisfied via TODO_DONE_ISH.
        if (evidenceText) data.evidence = evidenceText;
        if (opts.doneRunId !== undefined) data.doneRunId = opts.doneRunId;
        becameDropped = true;
      }
      if (status === 'in_progress' && !todo.startedAt) {
        // startedAt (P7 v1#20): stamped ONCE, on the first entry into
        // in_progress — the honest "work actually began" clock the digest and
        // stall scans can use instead of the updatedAt proxy.
        data.startedAt = new Date();
      }
      if (todo.status === 'done' || todo.status === 'dropped') {
        // REOPEN (P4 v1#9): leaving a terminal state clears the stored closing
        // evidence — it vouched for a close that no longer stands.
        //
        // A RE-CLOSE is NOT a reopen (ticket ac87ab80, independent review
        // finding 3): on done→dropped / dropped→done the close arms above have
        // just stored THIS call's evidence + doneRunId, and clearing them here
        // (keyed on the OLD status alone) silently discarded both — a dropped
        // todo re-closed as done landed status:'done' with evidence:null. Gate
        // on the NEW status too, and skip the reopen cascade for a re-close,
        // which is a fresh close rather than an undo of one.
        if (!TODO_DONE_ISH.has(status)) {
          becameUndone = true;
          data.evidence = null;
          data.doneRunId = null;
        }
      }
      if (status === 'blocked') {
        data.blockedReason = String(opts.blockedReason ?? '').trim() || 'Blocked manually';
        // blockedAt (review fix 2026-09-27): stamped ONLY on the transition
        // into 'blocked' — a standalone blockedReason refresh (below) or a
        // blockKind / gate / progressNote rewrite never touches it, so the
        // digest's 72 h stale-deps gate ages from the real block start.
        data.blockedAt = new Date();
      } else {
        data.blockedReason = null;
        data.blockKind = null; // typed provenance (S2a) clears with the block
        data.gateQuestionId = null;
        data.blockedAt = null;
      }
      data.status = status;
      statusChanged = true;
    }
  }

  // EVIDENCE AMENDMENT / LOUD REFUSAL (ticket ac87ab80).
  //
  // The ONLY writer of `data.evidence` used to be the status-transition block
  // above. So on a row that was ALREADY done/dropped — the exact case of
  // "correct the citation I wrote, it has been disproven" — `evidence` (sent
  // with `status:'done'` repeated, or alone) put NOTHING in `data`; the
  // `Object.keys(data).length` guard then skipped the write entirely and the
  // handler returned the CURRENT row. To the caller that is a successful update
  // that happens to echo the OLD text: a silent partial success that leaves the
  // shared board holding a disproven claim which later reads as fact. Observed
  // live: a lane retried the correction three times, got the stale text back
  // each time, and had to retract in progressNote instead.
  //
  // Both halves of the ticket's ask land here — never a silent drop:
  //   • a TERMINAL row (done/dropped) AMENDS its stored citation, audited
  //     (`todo.evidence_amended`) and authorship-stamped by the row write below;
  //   • a NON-terminal row 400s and names the real rule (pass a closing status)
  //     instead of accepting a parameter it cannot store.
  // An explicit `status` always WINS: the REOPEN arm above already cleared the
  // citation and this never resurrects it. Empty/whitespace `evidence` stays
  // "nothing supplied" (the pre-existing `if (evidenceText)` semantics), so an
  // evidence-less close is unchanged.
  let evidenceAmended: { from: string | null; to: string } | null = null;
  if (evidenceText && data.evidence === undefined) {
    if (!TODO_DONE_ISH.has(todo.status)) {
      throw new AppError(
        400,
        `evidence can only be written on a CLOSED todo: this one is '${todo.status}'. `
        + `Pass status:'done' (or 'dropped') together with the evidence to close it — evidence alone `
        + `stores nothing, so refusing it is the only honest answer.`,
      );
    }
    // Re-sending the CITATION THAT IS ALREADY STORED is not an amendment —
    // nothing is corrected, so it must not mint an audit row (a retry loop that
    // re-sends the same text would otherwise bury the real correction).
    const stored = typeof todo.evidence === 'string' ? todo.evidence : null;
    if (stored !== evidenceText) {
      data.evidence = evidenceText;
      evidenceAmended = { from: stored, to: evidenceText };
    }
  }

  // blockedReason standalone: a status transition above already claimed the
  // reason (set on 'blocked', cleared otherwise). With NO transition, the
  // reason must still apply-or-reject — never silently drop an accepted
  // parameter (fleet supervisors refreshing a blocker hit this silent no-op):
  // refresh it on an already-blocked todo; 400 on a non-blocked one.
  if (opts.blockedReason !== undefined && data.blockedReason === undefined) {
    if (todo.status === 'blocked') {
      data.blockedReason = String(opts.blockedReason).trim() || 'Blocked manually';
    } else {
      throw new AppError(
        400,
        `blockedReason can only be set on a blocked todo (current status: '${todo.status}'). Pass status:'blocked' to block it first.`,
      );
    }
  }

  // Phantom-gate guard (ticket d76750f5): a supplied gate must resolve to an
  // existing owner_questions row of the TODO's owner — or of the ACTING account
  // (ticket be94fa64: member-lane-flagged questions in shared projects) —
  // BEFORE anything writes.
  const gateResolved = await maybeResolveGate(opts.gateQuestionId, todo.userId, userId);

  // Typed block provenance (S2a) — AFTER status handling so an explicit value
  // this call wins over the unblock auto-clear above.
  applyBlockProvenance(data, { blockKind: opts.blockKind, gateQuestionId: gateResolved });
  // CanLaw stall 2026-09-15 — phantom deps block: a lane asked for blockKind
  // 'deps' on a row with ZERO open dependencies (both CanLaw HALT todos sat
  // "blocked: deps" for a day with every dependency done — nothing could ever
  // auto-clear them, the status card said "waiting on other work to finish
  // first", and the digest counted them as benign dependency waits). The
  // framework's own dependency model is the truth: with no open dependency the
  // block is the team's own → recorded as 'agent', told to the caller in the
  // result, observed in telemetry — never refused (gate flip 2026-09-11).
  let blockKindNote: string | undefined;
  let coercedDeps: number | null = null; // audit + metric land AFTER the write below
  if ((data.status ?? todo.status) === 'blocked' && data.blockKind === 'deps') {
    const effDepIds = newDepIds
      ?? (await prisma.todoDependency.findMany({ where: { todoId } })).map((d: any) => d.dependsOnTodoId);
    const deps = effDepIds.length ? await prisma.projectTodo.findMany({ where: { id: { in: effDepIds } } }) : [];
    if (openTodoDeps(deps).length === 0) {
      data.blockKind = 'agent';
      blockKindNote = phantomDepsBlockNote('todo');
      coercedDeps = effDepIds.length;
    }
  }

  let updated: any = await prisma.$transaction(async (tx: any) => {
    let t = todo;
    if (Object.keys(data).length) {
      // Gate-write authorship (ticket c286ba91): stamp WHO wrote on EVERY row
      // write — callers passing neither id leave null = the user/REST/
      // framework discriminator (a machine write arrives via the tools, which
      // always pass actingChatId/actingRunId).
      data.updatedByChatId = opts.actingChatId ?? null;
      data.updatedByRunId = opts.actingRunId ?? null;
      t = await tx.projectTodo.update({ where: { id: todoId }, data });
    }
    if (newDepIds) {
      await tx.todoDependency.deleteMany({ where: { todoId } });
      if (newDepIds.length) {
        await tx.todoDependency.createMany({
          data: newDepIds.map((dependsOnTodoId) => ({ todoId, dependsOnTodoId })),
        });
      }
    }
    return t;
  });
  if (updated === todo && (newDepIds || statusChanged)) updated = { ...todo, ...data };
  if (coercedDeps !== null) {
    await audit(userId, 'todo.block_kind_coerced', { todoId, from: 'deps', to: 'agent', deps: coercedDeps });
  }

  if (newDepIds) {
    await recomputeTodoBlockedState(todoId, userId);
  }
  if (statusChanged) {
    recordStatusTransition('todo', todo, prevStatus, data.status, actorKindOf(opts.machineTriggered), opts.actingChatId);
    await audit(userId, 'todo.update', {
      todoId, fromStatus: todo.status, toStatus: data.status,
      // Authorship (ticket c286ba91) rides every audit row too.
      actingChatId: opts.actingChatId, actingRunId: opts.actingRunId,
    });
  } else if (
    data.gateQuestionId !== undefined || data.blockKind !== undefined
    || data.blockedReason !== undefined || data.progressNote !== undefined
  ) {
    // Audit-gap close (ticket c286ba91): a gate/blockKind/blockedReason/
    // progressNote rewrite with NO status change used to leave ZERO audit
    // rows — the 02:28:04Z incident shape, where a gate flip on a shared
    // project's todo was "unattributed" and took three tickets to identify.
    await audit(userId, 'todo.gate_update', {
      todoId,
      gateQuestionId: data.gateQuestionId ?? undefined,
      blockKind: data.blockKind ?? undefined,
      blockedReason: data.blockedReason == null ? undefined : String(data.blockedReason).slice(0, 160),
      actingChatId: opts.actingChatId, actingRunId: opts.actingRunId,
    });
  }
  if (evidenceAmended) {
    // Ticket ac87ab80: an AMENDMENT of a closed row's citation is a ledger
    // event in its own right — it is how a disproven claim gets corrected
    // instead of standing forever. Recorded with the prior text so the
    // correction trail is readable, exactly like the gate-write audit gap
    // c286ba91 closed for blocks.
    await audit(userId, 'todo.evidence_amended', {
      todoId,
      from: evidenceAmended.from == null ? null : String(evidenceAmended.from).slice(0, 500),
      to: String(evidenceAmended.to).slice(0, 500),
      actingChatId: opts.actingChatId, actingRunId: opts.actingRunId,
    });
  }
  if (becameDone) {
    // Source chat = assignee; without one there is nothing to emit FROM. The
    // acting chat (when known) rides as the hook actor so it is never woken by
    // its own close — passed ONLY when set (user-present closes stay 3-arg).
    await emitHook(
      todo.assigneeChatId, 'todo_done', `Todo done: ${todo.title}`,
      opts.actingChatId ? { actorChatId: opts.actingChatId } : undefined,
    );
    await recomputeTodoDependents(todoId, userId);
    // Cascade (P4 v1#10 → gate flip 2026-09-11, owner: full steam): the goal
    // auto-done cascade is UNCONDITIONAL — withholding it for an evidence-less
    // machine close silently left goals open behind done todos (parity with
    // user-present closes; the evidence-less close itself is telemetered above).
    await maybeAutoCompleteGoal(todo.goalId, userId);
  }
  if (becameDropped) {
    // P7 N5: a dropped todo SATISFIES dependents (TODO_DONE_ISH) and may clear
    // the goal's remaining bar — the done cascades minus the todo_done hook
    // (nothing was accomplished; the drop is recorded, not celebrated).
    await recomputeTodoDependents(todoId, userId);
    await maybeAutoCompleteGoal(todo.goalId, userId); // gate flip 2026-09-11: unconditional (see the done branch)
  }
  if (becameUndone) {
    // REOPEN cascade (P4 v1#9 — the done-path cascade mirrored in reverse):
    // dependents that auto-unblocked on this todo's done now re-block
    // (recomputeTodoBlockedState reads the CURRENT dep statuses), and a goal
    // that auto-completed on it reopens.
    await recomputeTodoDependents(todoId, userId);
    await maybeReopenGoalOnTodoReopen(todo.goalId, userId);
  }

  // Resume propagation (2026-08-30): leaving 'blocked' — or receiving a NEW
  // assignee while already actionable — wakes that chat. (Done/blocked end
  // states never wake; the auto-unblock path lives in recomputeTodoBlockedState.)
  const effStatus = (statusChanged ? data.status : prevStatus) as string;
  const effAssignee: string | null = data.assigneeChatId !== undefined ? data.assigneeChatId : prevAssignee;
  // audit 2026-10-08 W5-5: a chat that assigns (or unblocks) a todo for ITSELF is already working it — the wake
  // ("a todo was just ASSIGNED to this chat — START it now") would land in its own run as a durable steer (6 of 16
  // 'assigned' wakes in the audit window were self-assignments). TODO_SELF_ASSIGN_WAKE_SKIP_DISABLED=1 restores it.
  // 4057952b review finding 2: compare the CANONICAL stored value (data.assigneeChatId carries
  // the resolved full id), never the raw caller input — a same-lane reassignment by its 8-char
  // prefix is NOT a new assignment and must not enqueue a redundant wake.
  const assigneeChanged = data.assigneeChatId !== undefined && data.assigneeChatId !== prevAssignee;
  if (effAssignee && opts.actingChatId && opts.actingChatId === effAssignee && !todoSelfWakeSkipDisabled()
    && effStatus !== 'blocked' && effStatus !== 'done' && effStatus !== 'dropped'
    && ((statusChanged && prevStatus === 'blocked') || assigneeChanged)) {
    recordSelfWakeSkip(todoId, effAssignee, statusChanged && prevStatus === 'blocked' ? 'unblocked' : 'assigned');
  } else if (effAssignee && effStatus !== 'blocked' && effStatus !== 'done' && effStatus !== 'dropped') {
    if (statusChanged && prevStatus === 'blocked') {
      await wakeTodoAssignee({ id: todoId, title: data.title ?? todo.title, goalId: todo.goalId, assigneeChatId: effAssignee }, 'unblocked', userId);
    } else if (assigneeChanged) {
      await wakeTodoAssignee({ id: todoId, title: data.title ?? todo.title, goalId: todo.goalId, assigneeChatId: effAssignee }, 'assigned', userId);
    }
  }

  return todoView({ ...updated, ...(statusChanged ? data : {}) }, {
    dependsOnTodoIds: newDepIds
      ?? (await prisma.todoDependency.findMany({ where: { todoId } })).map((d: any) => d.dependsOnTodoId),
    ...(blockKindNote ? { blockKindNote } : {}),
  });
}

/**
 * REVERSE of maybeAutoCompleteGoal (P4 v1#9): a todo under a DONE goal was
 * reopened — the goal's done-ness no longer holds, so it reopens to 'active'
 * (audited 'goal.auto_reopen') and its dependents recompute (they may
 * re-block on it). Archived goals are untouched (archive is a retirement
 * decision, not a completion claim). Deliberately symmetric with the auto-done
 * path: any DONE goal reopens, including an owner-closed one — a done goal
 * with live reopened work is stale state whichever way it was closed.
 */
async function maybeReopenGoalOnTodoReopen(
  goalId: string,
  userId: string,
  seam: 'todo_reopen' | 'todo_create' = 'todo_reopen',
): Promise<void> {
  const goal = await prisma.projectGoal.findUnique({ where: { id: goalId } });
  if (!goal || goal.status !== 'done') return;
  await prisma.projectGoal.update({ where: { id: goalId }, data: { status: 'active', blockedReason: null } });
  await audit(userId, 'goal.auto_reopen', { goalId, seam });
  recordStatusTransition('goal', goal, 'done', 'active', 'harness');
  await recordGoalReopenLabel(goal, 'auto');
  logger.info(`goal ${goalId.slice(0, 8)} auto-reopened (a todo under it left 'done'${seam === 'todo_create' ? " via a NEW todo — ticket 2a6e3238" : ''})`);
  await recomputeGoalDependents(goalId, userId);
}

/**
 * Auto-complete a goal after one of its todos finished: ALL todos done-ish
 * (done | dropped — P7 N5: owner-cancelled work must not hold a goal open
 * forever) with AT LEAST ONE actually done, AND all goal-deps done-ish ⇒
 * status 'done' (audit + goal dependents recompute). An all-dropped board
 * never auto-completes — nothing was accomplished. Already done/archived
 * goals are untouched.
 */
async function maybeAutoCompleteGoal(goalId: string, userId: string): Promise<void> {
  const goal = await prisma.projectGoal.findUnique({ where: { id: goalId } });
  if (!goal || goal.status === 'done' || goal.status === 'archived') return;

  const todos = await prisma.projectTodo.findMany({ where: { goalId } });
  if (!todos.length || todos.some((t: any) => !TODO_DONE_ISH.has(t.status))) return;
  if (!todos.some((t: any) => t.status === 'done')) return; // all-dropped ≠ completed

  const depRows = await prisma.goalDependency.findMany({ where: { goalId } });
  if (depRows.length) {
    const deps = await prisma.projectGoal.findMany({ where: { id: { in: depRows.map((d: any) => d.dependsOnGoalId) } } });
    if (openGoalDeps(deps).length) return;
  }

  // GOAL-OUTCOME-UNMET (architecture review #3, 2026-10-20): every todo landed,
  // but does the goal's OWN outcome bar (kpi: premise of record / observed
  // target) stand? Before this the cascade never read the premises.
  const outcome = goalOutcomeOf(goal.premises);
  if (outcome.reasons.length && goalOutcomeGateEnforce()) {
    // Part 4 (OPT-IN GOAL_OUTCOME_GATE_ENFORCE=1): HOLD the auto-close — the goal
    // stays open with an '[outcome unmet] …' note leading its progress note; the
    // supervisor is woken to plan the next lever. An explicit goal_update
    // status:'done' still closes it (audited at that seam).
    const note = outcomeUnmetProgressNote(goal.progressNote, outcome, todos, progressNoteMax());
    await prisma.projectGoal.update({ where: { id: goalId }, data: { progressNote: note } });
    await audit(userId, 'goal.auto_done_held', { goalId, reasons: outcome.reasons });
    logger.info(`goal ${goalId.slice(0, 8)} auto-complete HELD (all todos done, outcome unmet: ${outcome.reasons.join(', ')})`);
    await handleGoalOutcomeUnmet(goal, 'auto', outcome, { actorKind: 'harness', enforced: true, todos });
    return;
  }

  const priorStatus = String(goal.status); // read BEFORE the write (a stateful fake mutates the row in place)
  await prisma.projectGoal.update({ where: { id: goalId }, data: { status: 'done', blockedReason: null } });
  await audit(userId, 'goal.auto_done', { goalId });
  logger.info(`goal ${goalId.slice(0, 8)} auto-completed (all todos done)`);
  recordStatusTransition('goal', goal, priorStatus, 'done', 'harness');
  // sup3 audit C2 (2026-09-27): the todo-driven cascade is the SECOND close
  // seam — same observe-only assessment (the cascade itself stays unconditional).
  await recordGoalDoneSuspect({ ...goal, blockedReason: null }, 'auto');
  // GOAL-OUTCOME-UNMET part 3: the close stands (observe-only by default); the
  // record + the supervisor's re-plan wake land here.
  if (outcome.reasons.length) await handleGoalOutcomeUnmet(goal, 'auto', outcome, { actorKind: 'harness', todos });
  await recomputeGoalDependents(goalId, userId);
}

/**
 * List todos. Filters: goalId (one goal's breakdown) OR projectId (every todo
 * in that project) — never both — OR NEITHER, which lists account-wide across
 * every project the user OWNS (owner decision 2026-08-13, 'All projects,
 * tagged'; the same isolation rule as listGoals: member-shared projects stay
 * reachable only via the scoped filters). Every row is tagged with its
 * projectName.
 */
export async function listTodos(opts: {
  userId: string;
  goalId?: string;
  projectId?: string;
  status?: TodoStatus;
}): Promise<TodoView[]> {
  const { userId } = opts;
  if (opts.goalId && opts.projectId) throw new AppError(400, 'Pass goalId OR projectId, not both');
  if (opts.status !== undefined && !(TODO_STATUSES as readonly string[]).includes(String(opts.status))) {
    throw new AppError(400, `status must be one of: ${TODO_STATUSES.join(', ')}`);
  }

  const where: Record<string, any> = {};
  const projectNameById = new Map<string, string>();
  if (opts.goalId) {
    // Rollout watch 2026-09-14 (tick 8): canlegal-bench's supervisor called
    // todo_list with the fleet-standard 8-char goal idiom ("cd5fa541") and
    // 404'd twice in 3h — the hint already named the unique match, and every
    // other id-taking goal/todo tool (reads since 8579d419, writes since
    // 31db672f) resolves that prefix. Same up-front canonicalization as the
    // write path: the FILTER below uses the resolved full id, so the review-B1
    // "data-loss-shaped empty list" trap (raw prefix as the where clause) is
    // structurally impossible; ambiguous / invisible / full-length misses keep
    // the exact-id 404+hint contract via getGoalRow.
    const goalId = await canonicalGoalId(opts.goalId, opts.userId);
    const goal = await getGoalRow(goalId, opts.userId);
    const { project } = await requireProjectRead(goal.projectId, userId);
    projectNameById.set(project.id, project.name);
    where.goalId = goal.id;
  } else if (opts.projectId) {
    // Canonicalize the fleet's 8-char project idiom BEFORE the access read
    // (ticket fb3ea311 — the Fleet Supervisor's 3× 'Project not found'
    // breaker streak came from this exact branch on a prefix) and filter by
    // the RESOLVED full id — a raw prefix in the where clause would return a
    // data-loss-shaped empty list instead of the project's todos.
    const scopeId = await canonicalProjectId(opts.projectId, userId);
    const { project } = await requireScopedProjectRead(scopeId, opts.projectId, userId);
    projectNameById.set(project.id, project.name);
    where.projectId = project.id;
  } else {
    // Account-wide: OWNED projects only (cross-user isolation — see listGoals).
    const owned = await listOwnedProjectBriefs(userId);
    if (!owned.length) return [];
    for (const p of owned) projectNameById.set(p.id, p.name);
    where.projectId = { in: owned.map((p) => p.id) };
  }
  if (opts.status) where.status = String(opts.status);

  const todos = await prisma.projectTodo.findMany({ where, orderBy: { createdAt: 'asc' } });
  const depRows = todos.length
    ? await prisma.todoDependency.findMany({ where: { todoId: { in: todos.map((t: any) => t.id) } } })
    : [];
  const depsByTodo = new Map<string, string[]>();
  for (const d of depRows) {
    const list = depsByTodo.get(d.todoId) ?? [];
    list.push(d.dependsOnTodoId);
    depsByTodo.set(d.todoId, list);
  }
  return todos.map((t: any) => todoView(t, {
    projectName: projectNameById.get(t.projectId) ?? null,
    dependsOnTodoIds: depsByTodo.get(t.id) ?? [],
  }));
}

/**
 * Empty-state diagnostic for the ACCOUNT-WIDE todo listing (feedback 94b8e3a2).
 * The unscoped todo_list covers OWNED, non-archived projects only — member-shared
 * projects (owner decision 2026-08-13 cross-user isolation) and archived folders
 * (de-clutter rule, see listOwnedProjectBriefs) are deliberately EXCLUDED while
 * remaining readable via the scoped projectId form. A bare "no todos" then reads
 * exactly like data loss when the caller's todos live in an excluded project (the
 * 2026-09-09 supervisor sweep: unscoped zero rows, scoped 11 rows — reported as a
 * listing bug). Returns a one-sentence explanation naming what the listing
 * excluded (counts + example projects), or null when the account genuinely holds
 * no todos the caller can read. Called ONLY on the empty path — never in the hot
 * loop — so its extra reads cost nothing on non-empty listings.
 */
export async function explainEmptyAccountWideTodoList(userId: string): Promise<string | null> {
  const live = await listOwnedProjectBriefs(userId);
  const liveIds = new Set(live.map((p) => p.id));

  // Directly-owned projects the account-wide list EXCLUDED (self-archived, or
  // nested under an archived folder — the same rule listOwnedProjectBriefs
  // applies; such rows stay scoped-readable via requireProjectRead).
  const ownedAll = await prisma.crossModelProject.findMany({
    where: { userId },
    select: { id: true, name: true },
  });
  const archivedOwned = ownedAll.filter((p: any) => !liveIds.has(p.id));

  // Projects shared WITH the caller (any member role) that are not already in
  // the live owned set — never in the account-wide list by design.
  const memberRows = await prisma.projectMember.findMany({
    where: { userId },
    select: { projectId: true },
  });
  const archivedIds = new Set(archivedOwned.map((p: any) => p.id as string));
  const sharedIds = [...new Set(memberRows.map((m: any) => m.projectId as string))]
    .filter((id) => !liveIds.has(id) && !archivedIds.has(id));

  const parts: string[] = [];
  const nameExamples = (rows: Array<{ id: string; name: string }>) => {
    const shown = rows.slice(0, 3).map((p) => `"${p.name}" (${p.id})`).join(', ');
    return rows.length > 3 ? `${shown}, +${rows.length - 3} more` : shown;
  };

  if (archivedOwned.length) {
    const todos = await prisma.projectTodo.findMany({
      where: { projectId: { in: archivedOwned.map((p: any) => p.id) } },
      select: { id: true },
    });
    if (todos.length) {
      parts.push(
        `${archivedOwned.length} OWNED project(s) are archived (or under an archived folder) and still hold ${todos.length} todo(s) — archived folders leave the account-wide list but stay readable via todo_list(projectId): ${nameExamples(archivedOwned)}.`,
      );
    }
  }
  if (sharedIds.length) {
    const sharedTodos = await prisma.projectTodo.findMany({
      where: { projectId: { in: sharedIds } },
      select: { id: true, projectId: true },
    });
    if (sharedTodos.length) {
      const withTodos = new Set(sharedTodos.map((t: any) => t.projectId as string));
      const sharedProjects = await prisma.crossModelProject.findMany({
        where: { id: { in: [...withTodos] } },
        select: { id: true, name: true },
      });
      parts.push(
        `${sharedProjects.length} project(s) shared WITH you as a member hold ${sharedTodos.length} todo(s) — member-shared projects are deliberately EXCLUDED from the account-wide list (owner decision 2026-08-13); audit them one by one via todo_list(projectId) (list_projects enumerates your projects): ${nameExamples(sharedProjects)}.`,
      );
    }
  }
  return parts.length ? parts.join(' ') : null;
}

/**
 * Read ONE todo back by id (read access on its project) — the read-side parity
 * of todo_update, which already resolves by id alone. Fleet actors routinely
 * hold a bare todo id (from a hook summary, a supervisor nudge, another chat's
 * plan) with no idea which project owns it; without this their only read path
 * is guessing projectIds into todo_list (the 2026-08-07 "goal-board drift"
 * false alarm: three actors concluded data was lost because they listed the
 * WRONG sibling project). Returns the todo with its parent goal brief and
 * BOTH dependency directions, mirroring getGoal.
 */
export async function getTodo(opts: { userId: string; todoId: string }): Promise<TodoView> {
  // Read path: a unique ≥8-char prefix resolves (ticket 8579d419) — every
  // downstream use keys on todo.id, never the raw input.
  const todo = await getTodoRow(opts.todoId, opts.userId, true);
  await requireProjectRead(todo.projectId, opts.userId);

  const [goal, depRows, dependentRows] = await Promise.all([
    prisma.projectGoal.findUnique({ where: { id: todo.goalId } }),
    prisma.todoDependency.findMany({ where: { todoId: todo.id } }),
    prisma.todoDependency.findMany({ where: { dependsOnTodoId: todo.id } }),
  ]);
  const relatedIds = [
    ...depRows.map((d: any) => d.dependsOnTodoId),
    ...dependentRows.map((d: any) => d.todoId),
  ];
  const related = relatedIds.length
    ? await prisma.projectTodo.findMany({ where: { id: { in: relatedIds } } })
    : [];
  const byId = new Map(related.map((t: any) => [t.id, t]));
  const brief = (id: string) => {
    const t: any = byId.get(id);
    return t ? { id: t.id, title: t.title, status: t.status, goalId: t.goalId } : { id, missing: true };
  };

  return todoView(todo, {
    goal: goal ? { id: goal.id, title: goal.title, status: goal.status, projectId: goal.projectId } : { id: todo.goalId, missing: true },
    dependsOn: depRows.map((d: any) => brief(d.dependsOnTodoId)),
    dependents: dependentRows.map((d: any) => brief(d.todoId)),
    // Ticket 973d7f80: tell the lane WHOSE gate this is before it "repairs" it.
    ...(await gateQuestionVisibilityFor(todo.gateQuestionId, opts.userId)),
  });
}
